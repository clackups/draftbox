import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodegitBackend } from '../src/git/nodegit.ts';
import { MetaStore } from '../src/db/store.ts';
import { migrate } from '../src/db/migrations.ts';
import { SCHEMA_VERSION } from '../src/db/models.ts';

let dir: string;
let store: MetaStore;

before(async () => {
  dir = mkdtempSync(join(process.env.DRAFTBOX_TEST_TMP ?? tmpdir(), 'draftbox-store-'));
  const repo = await new NodegitBackend().openOrInit(join(dir, 'meta.git'));
  store = new MetaStore(repo);
  await store.load();
});

after(() => rmSync(dir, { recursive: true, force: true }));

test('concurrent transactions are serialized', async () => {
  await store.transact('init', async (tx) => tx.put('counter.json', { n: 0 }));
  await Promise.all(Array.from({ length: 20 }, () => store.transact('inc', async (tx) => {
    const cur = (await tx.get<{ n: number }>('counter.json'))!;
    tx.put('counter.json', { n: cur.n + 1 });
  })));
  assert.deepEqual(await store.view().get('counter.json'), { n: 20 });
});

test('transactions see their own writes and support listing', async () => {
  await store.transact('t', async (tx) => {
    tx.put('dir/a.json', { a: 1 });
    tx.putText('dir/b', 'B');
    assert.deepEqual(await tx.list('dir'), ['a.json', 'b']);
    tx.delete('dir/a.json');
    assert.deepEqual(await tx.list('dir'), ['b']);
  });
  assert.deepEqual(await store.view().list('dir'), ['b']);
  assert.equal(await store.view().getText('dir/b'), 'B');
});

test('a failed transaction writes nothing', async () => {
  const head = store.head;
  await assert.rejects(store.transact('boom', async (tx) => {
    tx.put('x.json', {});
    throw new Error('boom');
  }));
  assert.equal(store.head, head);
  assert.equal(await store.view().get('x.json'), null);
});

test('external ref updates are detected and retried', async () => {
  // Simulate another process committing to the same branch.
  const other = new MetaStore(store.repo);
  await other.load();
  await other.transact('external', async (tx) => tx.put('ext.json', { ok: true }));
  await store.transact('local', async (tx) => tx.put('local.json', { ok: true }));
  const view = store.view();
  assert.deepEqual(await view.get('ext.json'), { ok: true });
  assert.deepEqual(await view.get('local.json'), { ok: true });
});

test('migrations bring a version 1 database up to date', async () => {
  const repo = await new NodegitBackend().openOrInit(join(dir, 'old.git'));
  const old = new MetaStore(repo);
  await old.load();
  await old.transact('version 1 data', async (tx) => {
    tx.put('schema.json', { version: 1 });
    tx.put('tokens/t1.json', { id: 't1', userId: 'u1', repoId: null });
    tx.put('tokens/t2.json', { id: 't2', userId: 'u2', repoId: 'r1' });
    tx.put('repos/r1.json', { id: 'r1', ownerId: 'u2', name: 'a', visibility: 'public' });
    tx.put('repos/r2.json', { id: 'r2', ownerId: 'u2', name: 'b', visibility: 'private' });
    // A session revoked 10 days into its 30, and one already expired.
    tx.putText(`revoked-sessions/${'a'.repeat(32)}`, new Date(Date.now() + 20 * 86400_000).toISOString());
    tx.putText(`revoked-sessions/${'b'.repeat(32)}`, new Date(Date.now() - 86400_000).toISOString());
  });
  await migrate(old, { sessionMaxAgeDays: 30 });
  const view = old.view();
  assert.deepEqual(await view.get('schema.json'), { version: SCHEMA_VERSION });
  assert.deepEqual(await view.list('index/user-tokens/u1'), ['t1']);
  assert.deepEqual(await view.list('index/user-tokens/u2'), ['t2']);
  assert.deepEqual(await view.list('index/public'), ['r1']);
  const issued = new Date(Date.now() - 10 * 86400_000).toISOString().slice(0, 10);
  assert.deepEqual(await view.list('revoked-sessions'), [issued]);
  assert.deepEqual(await view.list(`revoked-sessions/${issued}`), ['a'.repeat(32)]);
  // Running again changes nothing.
  const head = old.head;
  await migrate(old, { sessionMaxAgeDays: 30 });
  assert.equal(old.head, head);
});
