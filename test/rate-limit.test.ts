import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { Browser, adminApi, setup } from './helpers.ts';
import { rateKey } from '../src/http/api.ts';

const env = await setup({ trustProxy: true });
after(() => env.cleanup());

const exchange = (forwardedFor: string) => env.app.request('/api/v1/token-exchange', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': forwardedFor },
  body: JSON.stringify({ password: '00000000' }),
});

test('forged X-Forwarded-For entries do not escape the per-address limit', async () => {
  const statuses: number[] = [];
  for (let i = 0; i < 12; i++) statuses.push((await exchange(`10.0.${i}.1, 203.0.113.9`)).status);
  assert.deepEqual(statuses.slice(0, 10), Array(10).fill(404));
  assert.deepEqual(statuses.slice(10), [429, 429]);
  // Another client is not affected.
  assert.equal((await exchange('203.0.113.10')).status, 404);
});

test('IPv6 addresses of one /64 share a rate limiting key', () => {
  assert.equal(rateKey('2001:db8:1:2::1'), '2001:db8:1:2::/64');
  assert.equal(rateKey('2001:0db8:0001:0002:ffff:1:2:3'), '2001:db8:1:2::/64');
  assert.equal(rateKey('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(rateKey('::ffff:192.0.2.1'), '192.0.2.1');
  assert.equal(rateKey('192.0.2.1'), '192.0.2.1');
});

test('API request bodies are limited in size', async () => {
  const res = await env.app.request('/api/v1/token-exchange', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.50' },
    body: JSON.stringify({ password: '0'.repeat(200 * 1024) }),
  });
  assert.equal(res.status, 413);
  assert.deepEqual(await res.json(), { error: 'payload_too_large' });
});

test('a failed token exchange leaves the one-time password valid', async () => {
  await adminApi(env, 'POST', '/api/v1/admin/preregistrations', { email: 'otto@example.com' });
  const otto = new Browser(env);
  await otto.login('otto@example.com');
  await otto.post('/new', { name: 'proj', description: '', visibility: 'private' });
  const user = (await env.svc.users.getByEmail('otto@example.com'))!;
  const repo = (await env.svc.repos.getByName(user, 'proj'))!;
  const r = await otto.post('/settings/tokens', { name: 'ci', repoId: repo.id, access: 'write', validity: '', otp: '1' });
  const m = /<p class="otp">(\d{4}) (\d{4})<\/p>/.exec(r.text)!;
  const exchange = () => env.app.request('/api/v1/token-exchange', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.77' }, body: JSON.stringify({ password: m[1] + m[2] }),
  });
  const original = env.svc.repos.defaultBranch;
  env.svc.repos.defaultBranch = async () => { throw new Error('broken repository'); };
  try {
    assert.equal((await exchange()).status, 500);
  } finally {
    env.svc.repos.defaultBranch = original;
  }
  const res = await exchange();
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { repository: string }).repository, `${user.handle}/proj`);
});
