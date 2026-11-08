import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { Browser, adminApi, setup } from './helpers.ts';
import { networkKey, rateKey } from '../src/http/api.ts';

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

test('many networks guessing cannot lock out a user with the right password', async () => {
  const post = (ip: string, password: string) => env.app.request('/api/v1/token-exchange', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
    body: JSON.stringify({ password }),
  });
  // One network: 50 failures from different addresses block all of it.
  for (let i = 1; i <= 50; i++) assert.equal((await post(`198.51.100.${i}`, '00000000')).status, 404);
  assert.equal((await post('198.51.100.200', '00000000')).status, 429);

  // 1000 failures spread over 100 networks trip the global limit.
  for (let n = 0; n < 100; n++) {
    for (let i = 1; i <= 10; i++) await post(`10.${n}.0.${i}`, '00000000');
  }
  // Addresses that failed are refused; a new one with a valid password works.
  assert.equal((await post('10.0.0.1', '00000000')).status, 429);
  await adminApi(env, 'POST', '/api/v1/admin/preregistrations', { email: 'rita@example.com' });
  await new Browser(env).login('rita@example.com');
  const user = (await env.svc.users.getByEmail('rita@example.com'))!;
  const issued = await env.svc.tokens.create(user, { name: 'x', repoId: null, access: 'read', validityMonths: null, withOtp: true }, null);
  assert.equal((await post('192.0.2.44', issued.otp!)).status, 200);
  // A new address that guesses wrong once is refused from then on.
  assert.equal((await post('192.0.2.45', '00000000')).status, 404);
  assert.equal((await post('192.0.2.45', '00000000')).status, 429);
});

test('network keys group /24 and /48 networks', () => {
  assert.equal(networkKey('192.0.2.77'), '192.0.2.0/24');
  assert.equal(networkKey('::ffff:192.0.2.77'), '192.0.2.0/24');
  assert.equal(networkKey('2001:db8:1:2::1'), '2001:db8:1::/48');
});
