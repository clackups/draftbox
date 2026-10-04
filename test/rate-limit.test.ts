import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.ts';
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
