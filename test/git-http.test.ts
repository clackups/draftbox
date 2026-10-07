import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { serve, type ServerType } from '@hono/node-server';
import { Browser, adminApi, setup, type TestEnv } from './helpers.ts';
import type { TokenPermission, User } from '../src/db/models.ts';

let env: TestEnv;
let server: ServerType;
let base: string;
let owner: User;
let rwToken: string;
let roToken: string;
let scopedToken: string;

const execFileAsync = promisify(execFile);

// Asynchronous on purpose: the server runs in this process.
async function git(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      PATH: process.env.PATH,
      HOME: env.dir,
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com',
    },
  });
  return stdout;
}

async function gitFails(args: string[], cwd?: string): Promise<string> {
  try {
    await git(args, cwd);
  } catch (err) {
    return String((err as { stderr?: string }).stderr);
  }
  assert.fail(`git ${args.join(' ')} unexpectedly succeeded`);
}

function url(repo: string, token?: string): string {
  const u = new URL(`${base}/dana/${repo}.git`);
  if (token) {
    u.username = 'dana';
    u.password = token;
  }
  return u.toString();
}

before(async () => {
  env = await setup();
  server = serve({ fetch: env.app.fetch, port: 0, hostname: '127.0.0.1' });
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  await adminApi(env, 'POST', '/api/v1/admin/preregistrations', { email: 'dana@example.com' });
  const b = new Browser(env);
  await b.login('dana@example.com', 'Dana');
  owner = (await env.svc.users.getByEmail('dana@example.com'))!;
  await env.svc.repos.create(owner, { name: 'public-doc', description: '', visibility: 'public', initReadme: true });
  const secret = await env.svc.repos.create(owner, { name: 'secret', description: '', visibility: 'private', initReadme: true });
  const other = await env.svc.repos.create(owner, { name: 'other', description: '', visibility: 'private', initReadme: false });
  rwToken = (await env.svc.tokens.create(owner, { name: 'rw', repoId: null, access: 'write', validityMonths: null, withOtp: false }, null)).value;
  roToken = (await env.svc.tokens.create(owner, { name: 'ro', repoId: null, access: 'read', validityMonths: 1, withOtp: false }, null)).value;
  scopedToken = (await env.svc.tokens.create(owner, { name: 'scoped', repoId: other.id, access: 'write', validityMonths: null, withOtp: false }, other)).value;
  void secret;
});

after(async () => {
  await new Promise((r) => server.close(r));
  env.cleanup();
});

test('anonymous clone of a public repository', async () => {
  const dir = mkdtempSync(join(env.dir, 'w-'));
  await git(['clone', '-q', url('public-doc'), 'pub'], dir);
  assert.match(readFileSync(join(dir, 'pub', 'README.md'), 'utf8'), /# public-doc/);
});

test('anonymous push is refused', async () => {
  const dir = mkdtempSync(join(env.dir, 'w-'));
  await git(['clone', '-q', url('public-doc'), 'pub'], dir);
  writeFileSync(join(dir, 'pub', 'x.txt'), 'x');
  await git(['add', 'x.txt'], join(dir, 'pub'));
  await git(['commit', '-qm', 'x'], join(dir, 'pub'));
  const err = await gitFails(['push', '-q', 'origin', 'main'], join(dir, 'pub'));
  assert.match(err, /Authentication failed|could not read Username|401/);
});

test('private repository requires a token', async () => {
  const dir = mkdtempSync(join(env.dir, 'w-'));
  await gitFails(['clone', '-q', url('secret'), 's1'], dir);
  await gitFails(['clone', '-q', url('secret', 'dbx_0000000000000000_' + 'a'.repeat(43)), 's2'], dir);
  await git(['clone', '-q', url('secret', roToken), 's3'], dir);
  assert.ok(readFileSync(join(dir, 's3', 'README.md'), 'utf8').length > 0);
});

test('read-only token cannot push; read-write token can', async () => {
  const dir = mkdtempSync(join(env.dir, 'w-'));
  await git(['clone', '-q', url('secret', roToken), 'repo'], dir);
  const work = join(dir, 'repo');
  writeFileSync(join(work, 'chapter.md'), '# Chapter\n');
  await git(['add', 'chapter.md'], work);
  await git(['commit', '-qm', 'Add chapter'], work);
  const err = await gitFails(['push', '-q', 'origin', 'main'], work);
  assert.match(err, /403|denied/i);

  await git(['remote', 'set-url', 'origin', url('secret', rwToken)], work);
  await git(['push', '-q', 'origin', 'main'], work);
  await git(['tag', 'v1'], work);
  await git(['push', '-q', 'origin', 'v1'], work);

  const repo = await env.svc.repos.getByName(owner, 'secret');
  const g = await env.svc.repos.open(repo!);
  const head = await g.resolveRef('refs/heads/main');
  const commit = await g.getCommit(head!);
  assert.equal(commit?.message.trim(), 'Add chapter');
  assert.ok(await g.resolveRef('refs/tags/v1'));

  // The pushed file is visible in the web interface.
  const b = new Browser(env);
  await b.login('dana@example.com');
  const page = await b.get('/dana/secret/blob/chapter.md');
  assert.match(page.text, /<h1>Chapter<\/h1>/);
});

test('repository-scoped token is limited to its repository', async () => {
  const dir = mkdtempSync(join(env.dir, 'w-'));
  await gitFails(['clone', '-q', url('secret', scopedToken), 'a'], dir);
  // Empty repository: clone works and push initializes main.
  await git(['clone', '-q', url('other', scopedToken), 'b'], dir);
  const work = join(dir, 'b');
  await git(['checkout', '-qb', 'main'], work);
  writeFileSync(join(work, 'a.txt'), 'a\n');
  await git(['add', 'a.txt'], work);
  await git(['commit', '-qm', 'first'], work);
  await git(['push', '-q', 'origin', 'main'], work);
  assert.match(await git(['ls-remote', url('other', scopedToken)]), /refs\/heads\/main/);
});

test('protocol v0 fetch also works', async () => {
  const dir = mkdtempSync(join(env.dir, 'w-'));
  await git(['-c', 'protocol.version=0', 'clone', '-q', url('public-doc'), 'v0'], dir);
  assert.ok(readFileSync(join(dir, 'v0', 'README.md'), 'utf8').length > 0);
});

test('push is refused when the quota or time limit is exceeded; clone still works', async () => {
  const setLimits = (patch: Partial<User>) => env.svc.ctx.store.transact('Set limits', async (tx) => {
    const u = (await tx.get<User>(`users/${owner.id}.json`))!;
    tx.put(`users/${owner.id}.json`, { ...u, ...patch });
  });
  const dir = mkdtempSync(join(env.dir, 'w-'));
  await git(['clone', '-q', url('secret', rwToken), 'repo'], dir);
  const work = join(dir, 'repo');
  writeFileSync(join(work, 'limit.md'), 'limit\n');
  await git(['add', 'limit.md'], work);
  await git(['commit', '-qm', 'Limit'], work);

  // A tiny quota (about 100 bytes) is already used up.
  await setLimits({ storageQuotaMb: 0.0001 });
  let err = await gitFails(['push', '-q', 'origin', 'main'], work);
  assert.match(err, /Storage quota exceeded/);
  await git(['clone', '-q', url('secret', rwToken), 'again'], dir);

  await setLimits({ storageQuotaMb: null, writableUntil: new Date(Date.now() - 1000).toISOString() });
  err = await gitFails(['push', '-q', 'origin', 'main'], work);
  assert.match(err, /time limit expired/);

  await setLimits({ writableUntil: null });
  await git(['push', '-q', 'origin', 'main'], work);
});

test('a push cannot add more than the remaining storage quota', async () => {
  const setQuota = (bytes: number | null) => env.svc.ctx.store.transact('Set quota', async (tx) => {
    const u = (await tx.get<User>(`users/${owner.id}.json`))!;
    tx.put(`users/${owner.id}.json`, { ...u, storageQuotaMb: bytes === null ? null : bytes / (1024 * 1024) });
  });
  const dir = mkdtempSync(join(env.dir, 'w-'));
  await git(['clone', '-q', url('secret', rwToken), 'repo'], dir);
  const work = join(dir, 'repo');
  // Random data does not compress: the pack is about as large as the file.
  writeFileSync(join(work, 'big.bin'), randomBytes(2 * 1024 * 1024));
  await git(['add', 'big.bin'], work);
  await git(['commit', '-qm', 'Big file'], work);

  const before = await env.svc.limits.usedBytes(owner.id);
  await setQuota(before + 256 * 1024);
  const err = await gitFails(['push', '-q', 'origin', 'main'], work);
  assert.match(err, /maximum allowed size|too large|quota/i);
  const repo = await env.svc.repos.getByName(owner, 'secret');
  const g = await env.svc.repos.open(repo!);
  assert.equal(await g.resolveRef('refs/heads/main'), (await git(['rev-parse', 'origin/main'], work)).trim());
  assert.ok((await env.svc.limits.usedBytes(owner.id)) < before + 256 * 1024);

  await setQuota(null);
  await git(['push', '-q', 'origin', 'main'], work);
});

test('tokens cannot lose data unless granted the permission', async () => {
  const repo = (await env.svc.repos.create(owner, { name: 'safe', description: '', visibility: 'private', initReadme: true }))!;
  const grant = async (allow: TokenPermission[]) =>
    (await env.svc.tokens.create(owner, { name: 'grant', repoId: repo.id, access: 'write', allow, validityMonths: null, withOtp: false }, repo)).value!;
  const dir = mkdtempSync(join(env.dir, 'w-'));
  await git(['clone', '-q', url('safe', rwToken), 'safe'], dir);
  const work = join(dir, 'safe');
  const commit = async (name: string) => {
    writeFileSync(join(work, name), name + '\n');
    await git(['add', name], work);
    await git(['commit', '-qm', name], work);
  };
  const remote = async () => git(['ls-remote', url('safe', rwToken)]);

  // Adding commits, branches and tags is allowed.
  await commit('one.md');
  await git(['push', '-q', 'origin', 'main'], work);
  await git(['tag', 'v1'], work);
  await git(['push', '-q', 'origin', 'v1', 'main:side', 'main:gone'], work);
  const pushed = (await git(['rev-parse', 'HEAD'], work)).trim();

  // Rewriting main is refused.
  await git(['commit', '-q', '--amend', '-m', 'rewritten'], work);
  let err = await gitFails(['push', '-q', '--force', 'origin', 'main'], work);
  assert.match(err, /rejected/);
  // Deleting a branch or a tag and moving a tag are refused.
  err = await gitFails(['push', '-q', 'origin', '--delete', 'side'], work);
  assert.match(err, /Deleting branches is not allowed|deletion prohibited/);
  err = await gitFails(['push', '-q', 'origin', '--delete', 'v1'], work);
  assert.match(err, /Deleting tags is not allowed|deletion prohibited/);
  await git(['tag', '-f', 'v1'], work);
  err = await gitFails(['push', '-q', '--force', 'origin', 'v1'], work);
  assert.match(err, /Moving tags is not allowed/);
  // A forced push to a branch that only adds commits is fine.
  await git(['push', '-q', '--force', 'origin', 'HEAD:refs/heads/fresh'], work);
  let refs = await remote();
  assert.match(refs, new RegExp(`${pushed}\\s+refs/heads/main`));
  assert.match(refs, new RegExp(`${pushed}\\s+refs/tags/v1`));
  assert.match(refs, /refs\/heads\/side/);

  // Each permission allows exactly its change.
  await git(['remote', 'set-url', 'origin', url('safe', await grant(['delete_branches']))], work);
  await git(['push', '-q', 'origin', '--delete', 'side'], work);
  err = await gitFails(['push', '-q', 'origin', '--delete', 'v1'], work);
  assert.match(err, /Deleting tags is not allowed/);
  err = await gitFails(['push', '-q', '--force', 'origin', 'main'], work);
  assert.match(err, /rejected/);

  await git(['remote', 'set-url', 'origin', url('safe', await grant(['force_push']))], work);
  await git(['push', '-q', '--force', 'origin', 'main'], work);
  err = await gitFails(['push', '-q', 'origin', '--delete', 'gone'], work);
  assert.match(err, /deletion prohibited|Deleting branches is not allowed/);

  await git(['remote', 'set-url', 'origin', url('safe', await grant(['move_tags']))], work);
  await git(['push', '-q', '--force', 'origin', 'v1'], work);

  await git(['remote', 'set-url', 'origin', url('safe', await grant(['delete_tags']))], work);
  await git(['push', '-q', 'origin', '--delete', 'v1'], work);

  refs = await remote();
  const head = (await git(['rev-parse', 'HEAD'], work)).trim();
  assert.match(refs, new RegExp(`${head}\\s+refs/heads/main`));
  assert.doesNotMatch(refs, /refs\/heads\/side|refs\/tags\/v1/);
  assert.match(refs, /refs\/heads\/gone/);
});
