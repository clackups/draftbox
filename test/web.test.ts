import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN_EMAIL, Browser, adminApi, setup, type TestEnv } from './helpers.ts';
import { DEFAULT_BRANDING } from '../src/db/models.ts';

let env: TestEnv;

before(async () => {
  env = await setup();
});

after(() => env.cleanup());

test('registration is closed without invitation or pre-registration', async () => {
  const b = new Browser(env);
  const res = await b.login('stranger@example.com');
  assert.equal(res.status, 403);
  assert.equal(await env.svc.users.getByEmail('stranger@example.com'), null);
});

test('administrator can always register', async () => {
  const b = new Browser(env);
  const res = await b.login(ADMIN_EMAIL, 'Admin');
  assert.equal(res.status, 302);
  const { text } = await b.get('/admin/users');
  assert.match(text, /admin@example\.com/);
});

test('pre-registration through the admin API', async () => {
  assert.equal((await env.app.request('/api/v1/admin/preregistrations')).status, 401);
  const r = await adminApi(env, 'POST', '/api/v1/admin/preregistrations', { email: 'Alice@Example.com', note: 'paid' });
  assert.equal(r.status, 201);
  const list = await (await adminApi(env, 'GET', '/api/v1/admin/preregistrations')).json() as { preregistrations: Array<{ email: string }> };
  assert.deepEqual(list.preregistrations.map((p) => p.email), ['alice@example.com']);

  const b = new Browser(env);
  assert.equal((await b.login('alice@example.com', 'Alice')).status, 302);
  const user = await env.svc.users.getByEmail('alice@example.com');
  assert.equal(user?.handle, 'alice');
  // The pre-registration is consumed.
  const after = await (await adminApi(env, 'GET', '/api/v1/admin/preregistrations/alice@example.com')).json() as { preregistration: unknown; registered: boolean };
  assert.equal(after.preregistration, null);
  assert.equal(after.registered, true);
});

test('invitation link registers exactly one account', async () => {
  const r = await adminApi(env, 'POST', '/api/v1/admin/invitations', { note: 'bob', expiresDays: 7 });
  const { link } = await r.json() as { link: string };
  const path = new URL(link).pathname;

  const bob = new Browser(env);
  await bob.get(path);
  assert.equal((await bob.login('bob@example.com', 'Bob')).status, 302);

  const carol = new Browser(env);
  const { text } = await carol.get(path);
  assert.match(text, /invalid, has expired or has already been used/);
  assert.equal((await carol.login('carol@example.com')).status, 403);
});

test('invitations and pre-registrations set the quota and time limit', async () => {
  // Through the API: pre-registration with explicit limits.
  assert.equal((await adminApi(env, 'POST', '/api/v1/admin/preregistrations', { email: 'lim1@example.com', storageQuotaMb: -1 })).status, 400);
  let r = await adminApi(env, 'POST', '/api/v1/admin/preregistrations', { email: 'lim1@example.com', storageQuotaMb: 500, timeLimitDays: 30 });
  assert.equal(r.status, 201);
  const lim1 = new Browser(env);
  await lim1.login('lim1@example.com');
  let user = (await env.svc.users.getByEmail('lim1@example.com'))!;
  assert.equal(user.storageQuotaMb, 500);
  const until = Date.parse(user.writableUntil!) - Date.parse(user.createdAt);
  assert.equal(until, 30 * 86400_000);
  assert.deepEqual(env.svc.limits.effective(user), { storageQuotaMb: 500, writableUntil: user.writableUntil, admin: false });

  // Through the API: invitation with an unlimited quota (null) and the default time limit.
  r = await adminApi(env, 'POST', '/api/v1/admin/invitations', { note: 'lim2', storageQuotaMb: null });
  const { link, limits } = await r.json() as { link: string; limits: unknown };
  assert.deepEqual(limits, { storageQuotaMb: null });
  const lim2 = new Browser(env);
  await lim2.get(new URL(link).pathname);
  await lim2.login('lim2@example.com');
  user = (await env.svc.users.getByEmail('lim2@example.com'))!;
  assert.equal(user.storageQuotaMb, null);
  assert.equal(user.writableUntil, undefined);
  assert.deepEqual(env.svc.limits.effective(user), { storageQuotaMb: null, writableUntil: null, admin: false });

  // Through the admin pages; 0 means unlimited, empty means the default.
  const admin = new Browser(env);
  await admin.login(ADMIN_EMAIL);
  await admin.get('/admin/preregistrations');
  await admin.post('/admin/preregistrations', { email: 'lim3@example.com', note: '', storageQuotaMb: '', timeLimitDays: '0' });
  const list = await admin.get('/admin/preregistrations');
  assert.match(list.text, /default \/ unlimited/);
  await admin.get('/admin/invitations');
  const created = await admin.post('/admin/invitations', { note: 'lim4', days: '7', storageQuotaMb: '20', timeLimitDays: '90' });
  assert.match(created.text, /20 MB \/ 90 days/);
  const lim4Link = /value="([^"]+)" class="mono" id="invite-link"/.exec(created.text)![1];
  const lim4 = new Browser(env);
  await lim4.get(new URL(lim4Link).pathname);
  await lim4.login('lim4@example.com');
  user = (await env.svc.users.getByEmail('lim4@example.com'))!;
  assert.equal(user.storageQuotaMb, 20);
  assert.ok(user.writableUntil);

  const lim3 = new Browser(env);
  await lim3.login('lim3@example.com');
  user = (await env.svc.users.getByEmail('lim3@example.com'))!;
  assert.equal(user.storageQuotaMb, undefined);
  assert.equal(user.writableUntil, null);
  assert.deepEqual(env.svc.limits.effective(user), { storageQuotaMb: 100, writableUntil: null, admin: false });
});

test('repositories: create, edit, history, tags and visibility', async () => {
  const alice = new Browser(env);
  await alice.login('alice@example.com');

  let r = await alice.post('/new', { name: 'notes', description: 'My notes', visibility: 'private' });
  assert.equal(r.res.status, 302);
  assert.equal(r.res.headers.get('Location'), '/alice/notes');

  // New repositories start empty.
  let page = await alice.get('/alice/notes');
  assert.match(page.text, /My notes/);
  assert.doesNotMatch(page.text, /README\.md/);
  r = await alice.post('/alice/notes/new', { ref: 'main', base: '', dir: '', name: 'README.md', content: '# Notes\n', message: '' });
  assert.equal(r.res.status, 302);
  page = await alice.get('/alice/notes');
  assert.match(page.text, /README\.md/);

  // Create a file in a sub-folder.
  page = await alice.get('/alice/notes/new?dir=drafts');
  const base = /name="base" value="([0-9a-f]{40})"/.exec(page.text)![1];
  r = await alice.post('/alice/notes/new', { ref: 'main', base, dir: 'drafts', name: 'one.md', content: '# One\r\n\r\nHello <b>world</b>\r\n', message: '' });
  assert.equal(r.res.status, 302);
  page = await alice.get('/alice/notes/blob/drafts/one.md');
  assert.match(page.text, /<h1>One<\/h1>/);
  assert.match(page.text, /&lt;b&gt;world&lt;\/b&gt;/);

  // Stale base commit is reported as a conflict, keeping the text.
  r = await alice.post('/alice/notes/edit/drafts/one.md', { ref: 'main', base, dir: 'drafts', name: 'one.md', content: 'stale edit', message: '' });
  assert.equal(r.res.status, 409);
  assert.match(r.text, /stale edit/);

  // Rename while editing.
  page = await alice.get('/alice/notes/edit/drafts/one.md');
  const base2 = /name="base" value="([0-9a-f]{40})"/.exec(page.text)![1];
  r = await alice.post('/alice/notes/edit/drafts/one.md', { ref: 'main', base: base2, dir: 'drafts', name: 'first.md', content: '# First\n', message: 'Rename draft' });
  assert.equal(r.res.status, 302);
  assert.equal((await alice.get('/alice/notes/blob/drafts/one.md')).res.status, 404);

  const raw = await alice.get('/alice/notes/raw/drafts/first.md');
  assert.equal(raw.text, '# First\n');
  assert.match(raw.res.headers.get('Content-Security-Policy') ?? '', /sandbox/);

  page = await alice.get('/alice/notes/commits');
  assert.match(page.text, /Rename draft/);
  assert.match(page.text, /Create drafts\/one\.md/);
  const commit = /\/alice\/notes\/commit\/([0-9a-f]{40})/.exec(page.text)![1];
  page = await alice.get(`/alice/notes/commit/${commit}`);
  assert.match(page.text, /drafts\/first\.md/);

  r = await alice.post('/alice/notes/tags', { name: 'v1', message: 'First version', target: 'main' });
  assert.equal(r.res.status, 302);
  page = await alice.get('/alice/notes/tags');
  assert.match(page.text, /v1/);
  page = await alice.get('/alice/notes/tree?ref=v1');
  assert.match(page.text, /drafts/);

  // Private repositories are invisible to others.
  const anon = new Browser(env);
  assert.equal((await anon.get('/alice/notes')).res.status, 404);
  const bob = new Browser(env);
  await bob.login('bob@example.com');
  assert.equal((await bob.get('/alice/notes')).res.status, 404);
  assert.equal((await bob.post('/alice/notes/tags', { name: 'evil', target: 'main' })).res.status, 404);

  r = await alice.post('/alice/notes/settings', { name: 'notes', description: 'Shared', visibility: 'public' });
  assert.equal(r.res.status, 302);
  assert.equal((await anon.get('/alice/notes')).res.status, 200);
  assert.match((await anon.get('/explore')).text, /alice \/ notes/);
  // Visitors cannot edit public repositories.
  assert.equal((await bob.get('/alice/notes/edit/README.md')).res.status, 403);
});

test('simple mode hides branches; advanced mode manages them', async () => {
  const alice = new Browser(env);
  await alice.login('alice@example.com');
  await alice.post('/new', { name: 'branchy', description: '', visibility: 'private' });
  await alice.post('/alice/branchy/new', { ref: 'main', base: '', dir: '', name: 'README.md', content: '# Branchy\n', message: '' });

  assert.equal((await alice.post('/alice/branchy/branches', { name: 'draft', from: 'main' })).res.status, 403);
  await alice.post('/settings', { name: 'Alice', handle: 'alice', language: 'en', theme: 'site', advancedMode: '1' });
  let r = await alice.post('/alice/branchy/branches', { name: 'draft', from: 'main' });
  assert.equal(r.res.status, 302);

  let page = await alice.get('/alice/branchy/edit/README.md?ref=draft');
  const base = /name="base" value="([0-9a-f]{40})"/.exec(page.text)![1];
  r = await alice.post('/alice/branchy/edit/README.md', { ref: 'draft', base, dir: '', name: 'README.md', content: 'draft text\n', message: '' });
  assert.equal(r.res.status, 302);
  assert.equal((await alice.get('/alice/branchy/raw/README.md?ref=draft')).text, 'draft text\n');
  assert.notEqual((await alice.get('/alice/branchy/raw/README.md')).text, 'draft text\n');

  // Back in simple mode the ref parameter is ignored for branches.
  await alice.post('/settings', { name: 'Alice', handle: 'alice', language: 'en', theme: 'site' });
  page = await alice.get('/alice/branchy/raw/README.md?ref=draft');
  assert.notEqual(page.text, 'draft text\n');
});

test('access tokens and one-time passwords', async () => {
  const alice = new Browser(env);
  await alice.login('alice@example.com');
  // Simple mode suggests a one-time password and hides the token value,
  // which is retrieved through the token-exchange API instead.
  assert.match((await alice.get('/settings/tokens')).text, /name="otp" value="1" checked/);
  const r = await alice.post('/settings/tokens', { name: 'laptop', repoId: '', access: 'read', validity: '3', otp: '1' });
  assert.equal(r.res.status, 200);
  assert.doesNotMatch(r.text, /dbx_/);
  const otp = /<p class="otp">(\d{4}) (\d{4})<\/p>/.exec(r.text)!;
  const password = otp[1] + otp[2];

  const exchange = (pw: string) => env.app.request('/api/v1/token-exchange', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw }),
  });
  let res = await exchange(password);
  assert.equal(res.status, 200);
  const body = await res.json() as { token: string; access: string; branch: string | null };
  const value = body.token;
  const auth = await env.svc.tokens.authenticate(value);
  assert.equal(auth?.token.access, 'read');
  assert.ok(auth?.token.expiresAt);
  assert.equal(body.access, 'read');
  assert.equal(body.branch, null);
  // Only once.
  assert.equal((await exchange(password)).status, 404);

  // Simple mode hides the command-line examples.
  assert.doesNotMatch(r.text, /curl|git clone/);
  const plain = await alice.post('/settings/tokens', { name: 'plain', repoId: '', access: 'read', validity: '' });
  assert.match(plain.text, /dbx_/);
  assert.match(plain.text, /Enter the token as the password/);

  // A one-time password for an existing token keeps the token value.
  const tokenId = value.split('_')[1];
  const otpFor = async () => {
    await alice.get('/settings/tokens');
    const page = await alice.post(`/settings/tokens/${tokenId}/otp`, {});
    assert.equal(page.res.status, 200);
    assert.doesNotMatch(page.text, /dbx_/);
    const m = /<p class="otp">(\d{4}) (\d{4})<\/p>/.exec(page.text)!;
    return { page, password: m[1] + m[2] };
  };
  const first = await otpFor();
  assert.match(first.page.text, /One-time password for laptop/);
  const second = await otpFor();
  // The new password replaces the pending one.
  assert.equal((await exchange(first.password)).status, 404);
  res = await exchange(second.password);
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { token: string }).token, value);
  assert.ok(await env.svc.tokens.authenticate(value));

  // A repository token also returns the clone URL and default branch.
  await alice.post('/new', { name: 'otp-repo', description: '', visibility: 'private' });
  const owner = await env.svc.users.getByEmail('alice@example.com');
  const repo = (await env.svc.repos.getByName(owner!, 'otp-repo'))!;
  const scoped = await alice.post('/settings/tokens', { name: 'scoped', repoId: repo.id, access: 'write', validity: '', otp: '1' });
  const scopedOtp = /<p class="otp">(\d{4}) (\d{4})<\/p>/.exec(scoped.text)!;
  res = await exchange(scopedOtp[1] + scopedOtp[2]);
  assert.equal(res.status, 200);
  const scopedBody = await res.json() as { repository: string; cloneUrl: string; branch: string };
  assert.equal(scopedBody.repository, 'alice/otp-repo');
  assert.match(scopedBody.cloneUrl, /\/alice\/otp-repo\.git$/);
  assert.equal(scopedBody.branch, 'main');

  // Advanced mode shows the API call and the clone command, and the
  // token value even when a one-time password is added.
  await alice.post('/settings', { advancedMode: '1' });
  assert.match((await alice.get('/settings/tokens')).text, /name="otp" value="1">/);
  const advanced = await otpFor();
  assert.match(advanced.page.text, /curl -X POST/);
  const created = await alice.post('/settings/tokens', { name: 'adv', repoId: '', access: 'write', validity: '' });
  assert.match(created.text, /git clone http:\/\/alice:TOKEN@/);
  const advOtp = await alice.post('/settings/tokens', { name: 'adv-otp', repoId: '', access: 'write', validity: '', otp: '1' });
  assert.match(advOtp.text, /dbx_/);
  assert.match(advOtp.text, /<p class="otp">/);

  // Tokens created before values were stored encrypted get a new value.
  const legacy = await alice.post('/settings/tokens', { name: 'old', repoId: '', access: 'write', validity: '' });
  const legacyValue = /value="(dbx_[0-9a-f]{16}_[A-Za-z0-9_-]{43})"/.exec(legacy.text)![1];
  const legacyId = legacyValue.split('_')[1];
  await env.svc.ctx.store.transact('Simulate legacy token', async (tx) => {
    const tok = (await tx.get<Record<string, unknown>>(`tokens/${legacyId}.json`))!;
    delete tok.encryptedValue;
    tx.put(`tokens/${legacyId}.json`, tok);
  });
  assert.match((await alice.get('/settings/tokens')).text, /The current token value will stop working/);
  const reissued = await alice.post(`/settings/tokens/${legacyId}/otp`, {});
  const newValue = /value="(dbx_[0-9a-f]{16}_[A-Za-z0-9_-]{43})"/.exec(reissued.text)![1];
  assert.notEqual(newValue, legacyValue);
  assert.equal(await env.svc.tokens.authenticate(legacyValue), null);
  assert.ok(await env.svc.tokens.authenticate(newValue));
  await alice.post('/settings', {});

  // Revoking invalidates the token.
  await alice.get('/settings/tokens');
  await alice.post(`/settings/tokens/${tokenId}/revoke`, {});
  assert.equal(await env.svc.tokens.authenticate(value), null);

  // Rate limiting of guesses.
  let limited = false;
  for (let i = 0; i < 12; i++) {
    res = await exchange('00000000');
    if (res.status === 429) limited = true;
  }
  assert.ok(limited);
});

test('token form defaults to the most recently updated repository', async () => {
  const alice = new Browser(env);
  await alice.login('alice@example.com');
  await alice.post('/new', { name: 'scope-old', description: '', visibility: 'private' });
  // Commit times have one-second resolution.
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await alice.post('/alice/scope-old/new', { ref: 'main', base: '', dir: '', name: 'a.md', content: 'a\n', message: '' });
  const owner = await env.svc.users.getByEmail('alice@example.com');
  const old = (await env.svc.repos.getByName(owner!, 'scope-old'))!;
  const page = await alice.get('/settings/tokens');
  const selected = /<option value="([^"]*)" selected>/.exec(page.text);
  assert.equal(selected?.[1], old.id);
});

test('forms without CSRF token are rejected', async () => {
  const alice = new Browser(env);
  await alice.login('alice@example.com');
  const r = await alice.post('/new', { name: 'csrf-test', description: '', visibility: 'private' }, { csrf: false });
  assert.equal(r.res.status, 403);
  const user = await env.svc.users.getByEmail('alice@example.com');
  assert.equal(await env.svc.repos.getByName(user!, 'csrf-test'), null);
});

test('blocking hides the user and ends sessions', async () => {
  const admin = new Browser(env);
  await admin.login(ADMIN_EMAIL);
  const bob = new Browser(env);
  await bob.login('bob@example.com');
  await bob.post('/new', { name: 'pub', description: '', visibility: 'public' });
  const anon = new Browser(env);
  assert.equal((await anon.get('/bob/pub')).res.status, 200);

  const bobUser = await env.svc.users.getByEmail('bob@example.com');
  await admin.get('/admin/users');
  let r = await admin.post(`/admin/users/${bobUser!.id}/block`, {});
  assert.equal(r.res.status, 302);

  assert.equal((await anon.get('/bob/pub')).res.status, 404);
  assert.doesNotMatch((await anon.get('/explore')).text, /bob \/ pub/);
  const home = await bob.get('/settings');
  assert.equal(home.res.status, 302);
  assert.equal((await bob.login('bob@example.com')).status, 403);

  await admin.get('/admin/users');
  r = await admin.post(`/admin/users/${bobUser!.id}/unblock`, {});
  assert.equal((await anon.get('/bob/pub')).res.status, 200);

  await admin.get('/admin/users');
  r = await admin.post(`/admin/users/${bobUser!.id}/delete`, {});
  assert.equal(r.res.status, 302);
  assert.equal((await anon.get('/bob/pub')).res.status, 404);
  assert.equal(await env.svc.users.getByEmail('bob@example.com'), null);
});

test('an account over its limits is read-only in the web interface', async () => {
  await adminApi(env, 'POST', '/api/v1/admin/preregistrations', { email: 'quinn@example.com' });
  const quinn = new Browser(env);
  await quinn.login('quinn@example.com');
  await quinn.post('/new', { name: 'notes', description: '', visibility: 'private' });
  await quinn.post('/quinn/notes/new', { ref: 'main', base: '', dir: '', name: 'a.md', content: 'a\n', message: '' });
  const user = (await env.svc.users.getByEmail('quinn@example.com'))!;
  assert.equal((await env.svc.limits.status(user)).blockedBy, null);
  assert.ok((await env.svc.limits.status(user)).usedBytes > 0);
  const setLimits = (patch: Record<string, unknown>) => env.svc.ctx.store.transact('Set limits', async (tx) => {
    const u = (await tx.get<Record<string, unknown>>(`users/${user.id}.json`))!;
    tx.put(`users/${user.id}.json`, { ...u, ...patch });
  });

  assert.match((await quinn.get('/settings')).text, /MB \/ 100 MB[\s\S]*no time limit/);
  await setLimits({ storageQuotaMb: 0.0001 });
  let page = await quinn.get('/quinn/notes');
  assert.match(page.text, /storage quota of this account is used up/);
  assert.doesNotMatch(page.text, /\/quinn\/notes\/new/);
  const base = (await env.svc.repos.resolveBranch(await env.svc.repos.open((await env.svc.repos.getByName(user, 'notes'))!), 'main'))!;
  let r = await quinn.post('/quinn/notes/edit/a.md', { ref: 'main', base, dir: '', name: 'a.md', content: 'kept text\n', message: '' });
  assert.equal(r.res.status, 403);
  assert.match(r.text, /kept text/);
  assert.equal((await quinn.post('/quinn/notes/tags', { name: 'v1', message: '' })).res.status, 403);
  assert.equal((await quinn.post('/new', { name: 'more', description: '', visibility: 'private' })).res.status, 403);
  // Reading continues to work.
  assert.equal((await quinn.get('/quinn/notes/raw/a.md')).text, 'a\n');
  assert.match((await quinn.get('/settings')).text, /storage quota of this account is used up/);
  const admin = new Browser(env);
  await admin.login(ADMIN_EMAIL);
  assert.match((await admin.get('/admin/users')).text, /<td class="text-danger">[\d.]+ MB \/ 0.0001 MB<\/td>/);

  await setLimits({ storageQuotaMb: null, writableUntil: new Date(Date.now() - 1000).toISOString() });
  page = await quinn.get('/quinn/notes');
  assert.match(page.text, /time limit of this account has expired/);
  r = await quinn.post('/quinn/notes/new', { ref: 'main', base, dir: '', name: 'b.md', content: 'b\n', message: '' });
  assert.equal(r.res.status, 403);

  await setLimits({ writableUntil: new Date(Date.now() + 86400_000).toISOString() });
  r = await quinn.post('/quinn/notes/new', { ref: 'main', base, dir: '', name: 'b.md', content: 'b\n', message: '' });
  assert.equal(r.res.status, 302);
});

test('administrator accounts have no quota or time limit', async () => {
  const admin = new Browser(env);
  await admin.login(ADMIN_EMAIL);
  const id = (await env.svc.users.getByEmail(ADMIN_EMAIL))!.id;
  await env.svc.ctx.store.transact('Set limits', async (tx) => {
    const u = (await tx.get<Record<string, unknown>>(`users/${id}.json`))!;
    tx.put(`users/${id}.json`, { ...u, storageQuotaMb: 0.0001, writableUntil: new Date(Date.now() - 1000).toISOString() });
  });
  let user = (await env.svc.users.getByEmail(ADMIN_EMAIL))!;
  assert.equal(env.svc.limits.isAdminAccount(user), true);
  const status = await env.svc.limits.status(user);
  assert.deepEqual([status.storageQuotaMb, status.writableUntil, status.blockedBy], [null, null, null]);
  await admin.post('/new', { name: 'admin-notes', description: '', visibility: 'private' });
  const r = await admin.post(`/${user.handle}/admin-notes/new`, { ref: 'main', base: '', dir: '', name: 'a.md', content: 'a\n', message: '' });
  assert.equal(r.res.status, 302);

  // The address alone is not enough: the identity must come from a trusted provider.
  user = { ...user, identities: [{ provider: 'github', subject: 'x' }] };
  assert.equal(env.svc.limits.isAdminAccount(user), false);
  assert.equal(env.svc.limits.effective(user).storageQuotaMb, 0.0001);
});

test('administrators change the limits of existing accounts', async () => {
  await adminApi(env, 'POST', '/api/v1/admin/preregistrations', { email: 'pat@example.com' });
  const pat = new Browser(env);
  await pat.login('pat@example.com');
  const id = (await env.svc.users.getByEmail('pat@example.com'))!.id;
  const get = async () => (await env.svc.users.getById(id))!;

  // Web interface.
  const admin = new Browser(env);
  await admin.login(ADMIN_EMAIL);
  assert.match((await admin.get('/admin/users')).text, new RegExp(`href="/admin/users/${id}/limits"`));
  let page = await admin.get(`/admin/users/${id}/limits`);
  assert.match(page.text, /Limits of pat@example\.com/);
  let r = await admin.post(`/admin/users/${id}/limits`, { storageQuotaMb: '250', writableUntil: '2030-01-31' });
  assert.equal(r.res.status, 302);
  let user = await get();
  assert.equal(user.storageQuotaMb, 250);
  assert.equal(user.writableUntil, '2030-01-31T23:59:59.999Z');
  page = await admin.get(`/admin/users/${id}/limits`);
  assert.match(page.text, /name="storageQuotaMb"[^>]*value="250"/);
  assert.match(page.text, /value="2030-01-31"/);
  r = await admin.post(`/admin/users/${id}/limits`, { storageQuotaMb: '0', writableUntil: '2030-01-31', noTimeLimit: '1' });
  user = await get();
  assert.equal(user.storageQuotaMb, null);
  assert.equal(user.writableUntil, null);
  r = await admin.post(`/admin/users/${id}/limits`, { storageQuotaMb: '', writableUntil: '' });
  user = await get();
  assert.equal('storageQuotaMb' in user, false);
  assert.equal('writableUntil' in user, false);
  r = await admin.post(`/admin/users/${id}/limits`, { storageQuotaMb: '-3', writableUntil: '' });
  assert.equal(r.res.status, 400);
  assert.match(r.text, /Enter a whole number/);
  // Only administrators.
  assert.equal((await pat.get(`/admin/users/${id}/limits`)).res.status, 403);

  // API.
  assert.equal((await adminApi(env, 'GET', '/api/v1/admin/users/nobody@example.com')).status, 404);
  let res = await adminApi(env, 'PATCH', '/api/v1/admin/users/pat@example.com/limits', { storageQuotaMb: 42, writableUntil: '2031-05-01T12:00:00Z' });
  assert.equal(res.status, 200);
  let body = await res.json() as { limits: { storageQuotaMb: number | null; writableUntil: string | null; admin: boolean; readOnly: string | null; custom: object } };
  assert.equal(body.limits.storageQuotaMb, 42);
  assert.equal(body.limits.writableUntil, '2031-05-01T12:00:00.000Z');
  assert.equal(body.limits.admin, false);
  // Absent fields stay unchanged; an expired date makes the account read-only.
  res = await adminApi(env, 'PATCH', '/api/v1/admin/users/pat@example.com/limits', { writableUntil: '2020-01-01' });
  body = await res.json() as typeof body;
  assert.equal(body.limits.storageQuotaMb, 42);
  assert.equal(body.limits.readOnly, 'time_limit_expired');
  res = await adminApi(env, 'PATCH', '/api/v1/admin/users/pat@example.com/limits', { storageQuotaMb: 'default', writableUntil: null });
  body = await res.json() as typeof body;
  assert.equal(body.limits.storageQuotaMb, 100);
  assert.deepEqual(body.limits.custom, { writableUntil: null });
  assert.equal((await adminApi(env, 'PATCH', '/api/v1/admin/users/pat@example.com/limits', { writableUntil: 'soon' })).status, 400);
  res = await adminApi(env, 'GET', '/api/v1/admin/users/pat@example.com');
  body = await res.json() as typeof body;
  assert.equal(body.limits.readOnly, null);
});

test('download all returns a ZIP archive of the repository', async () => {
  await adminApi(env, 'POST', '/api/v1/admin/preregistrations', { email: 'zed@example.com' });
  const zed = new Browser(env);
  await zed.login('zed@example.com');
  await zed.post('/new', { name: 'book', description: '', visibility: 'private' });
  // Nothing to download from an empty repository.
  assert.equal((await zed.get('/zed/book/archive.zip')).res.status, 404);
  await zed.post('/zed/book/new', { ref: 'main', base: '', dir: '', name: 'ch1.md', content: '# One\n', message: '' });
  const page = await zed.get('/zed/book');
  assert.match(page.text, /href="\/zed\/book\/archive\.zip" download>Download all</);

  const res = await zed.env.app.request('/zed/book/archive.zip', { headers: { Cookie: [...zed.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Content-Type'), 'application/zip');
  assert.equal(res.headers.get('Content-Disposition'), 'attachment; filename="book.zip"');
  const data = Buffer.from(await res.arrayBuffer());
  assert.equal(data.subarray(0, 4).toString('latin1'), 'PK\x03\x04');
  assert.ok(data.includes('book/ch1.md'));

  // Private repositories are not downloadable by others.
  assert.equal((await env.app.request('/zed/book/archive.zip')).status, 404);
});

test('static files use the configured cache lifetime', async () => {
  const res = await env.app.request('/static/app.js');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cache-Control'), 'public, max-age=60');
  const other = await setup({ staticCacheSeconds: 300 });
  try {
    const r = await other.app.request('/static/app.css');
    assert.equal(r.headers.get('Cache-Control'), 'public, max-age=300');
  } finally {
    other.cleanup();
  }
});

test('non-admins cannot reach administration', async () => {
  const alice = new Browser(env);
  await alice.login('alice@example.com');
  assert.equal((await alice.get('/admin/users')).res.status, 403);
});

test('branding and language selection', async () => {
  const admin = new Browser(env);
  await admin.login(ADMIN_EMAIL);
  await admin.get('/admin/branding');
  await admin.post('/admin/branding', {
    siteName: 'Writers Hub', primaryColor: '#112233', accentColor: '#445566', lightBackground: '#fafafa', darkBackground: '#101010', lightPanel: '#fefefe', darkPanel: '#202020',
    defaultTheme: 'dark', footerText: 'Hello <a href="https://example.org/" onclick="x()">site</a><script>bad()</script>', customCss: 'body{x:y}</style><script>',
  });
  const anon = new Browser(env);
  const page = await anon.get('/');
  assert.match(page.text, /Writers Hub/);
  assert.match(page.text, /data-theme="dark"/);
  assert.match(page.text, /<div class="footer-text">Hello <a href="https:\/\/example\.org\/">site<\/a><\/div>/);
  assert.doesNotMatch(page.text, /bad\(\)/);
  const css = await anon.get('/branding/theme.css');
  assert.match(css.text, /--brand:#112233/);
  assert.match(css.text, /:root\{[^}]*--bg:#fafafa/);
  assert.match(css.text, /:root\{[^}]*--surface:#fefefe/);
  assert.match(css.text, /:root\[data-theme="dark"\]\{--bg:#101010;--surface:#202020;\}/);
  assert.match(css.text, /prefers-color-scheme: dark\)\{:root:not\(\[data-theme="light"\]\)\{--bg:#101010;--surface:#202020;/);
  assert.doesNotMatch(css.text, /<\/style/);

  await anon.get('/lang/de?next=/');
  assert.match((await anon.get('/')).text, /Anmelden/);
  const uk = new Browser(env);
  assert.match((await uk.get('/', { 'Accept-Language': 'uk-UA,uk;q=0.9' })).text, /lang="uk"/);
});

test('branding can be reset to the defaults', async () => {
  const admin = new Browser(env);
  await admin.login(ADMIN_EMAIL);
  await admin.get('/admin/branding');
  await admin.post('/admin/branding', {
    siteName: 'Custom', primaryColor: '#123456', accentColor: '#654321', lightBackground: '#eeeeee', darkBackground: '#111111',
    lightPanel: '#dddddd', darkPanel: '#222222', defaultTheme: 'dark', footerText: 'Foot', customCss: 'p{}',
  });
  const logo = new FormData();
  logo.set('logo', new File(['<svg xmlns="http://www.w3.org/2000/svg"/>'], 'logo.svg', { type: 'image/svg+xml' }));
  await admin.post('/admin/branding/logo', logo);
  assert.equal((await env.svc.branding.get()).hasLogo, true);

  assert.match((await admin.get('/admin/branding')).text, /action="\/admin\/branding\/reset" data-confirm=/);
  const r = await admin.post('/admin/branding/reset', {});
  assert.equal(r.res.status, 302);
  assert.deepEqual(await env.svc.branding.get(), DEFAULT_BRANDING);
  assert.equal(await env.svc.branding.logo(), null);
  assert.equal((await env.app.request('/branding/logo')).status, 404);

  const alice = new Browser(env);
  await alice.login('alice@example.com');
  assert.equal((await alice.post('/admin/branding/reset', {})).res.status, 403);
});

test('user appearance preference overrides the site default theme', async () => {
  const admin = new Browser(env);
  await admin.login(ADMIN_EMAIL);
  await admin.get('/admin/branding');
  await admin.post('/admin/branding', {
    siteName: 'Draftbox', primaryColor: '#2f6f4f', accentColor: '#c9822b', defaultTheme: 'dark', footerText: '', customCss: '',
  });
  await adminApi(env, 'POST', '/api/v1/admin/preregistrations', { email: 'carol-theme@example.com' });
  const carol = new Browser(env);
  assert.equal((await carol.login('carol-theme@example.com')).status, 302);
  const settings = await carol.get('/settings');
  assert.match(settings.text, /<option value="site" selected>/);
  assert.match((await carol.get('/')).text, /data-theme="dark"/);
  await carol.post('/settings', { name: 'Carol', handle: 'carol-theme', language: 'en', theme: 'auto' });
  assert.doesNotMatch((await carol.get('/')).text, /data-theme=/);
  await carol.post('/settings', { name: 'Carol', handle: 'carol-theme', language: 'en', theme: 'light' });
  assert.match((await carol.get('/')).text, /data-theme="light"/);
  await admin.post('/admin/branding', {
    siteName: 'Draftbox', primaryColor: '#2f6f4f', accentColor: '#c9822b', defaultTheme: 'auto', footerText: '', customCss: '',
  });
});

test('contact email is verified by link; description and homepage appear in the profile', async () => {
  await adminApi(env, 'POST', '/api/v1/admin/preregistrations', { email: 'dana@example.com' });
  const dana = new Browser(env);
  assert.equal((await dana.login('dana@example.com', 'Dana')).status, 302);
  assert.match((await dana.get('/settings')).text, /name="contactEmail" value="dana@example.com"/);

  const before = env.mailer.sent.length;
  let r = await dana.post('/settings', {
    name: 'Dana', handle: 'dana', language: 'en', theme: 'site',
    contactEmail: 'Dana.Work@example.org', description: 'Writer.\nI <3 tea & cake', homepage: 'example.com/dana',
  });
  assert.equal(r.res.status, 302);
  assert.equal(env.mailer.sent.length, before + 1);
  const mail = env.mailer.sent[before];
  assert.equal(mail.to, 'Dana.Work@example.org');
  const link = /http:\/\/localhost:8080(\/verify-email\/[A-Za-z0-9_-]+)/.exec(mail.text)![1];

  // Not changed until verified.
  let profile = await new Browser(env).get('/dana');
  assert.match(profile.text, /mailto:dana@example.com/);
  assert.doesNotMatch(profile.text, /Dana\.Work/);
  assert.match(profile.text, /I &lt;3 tea &amp; cake/);
  assert.match(profile.text, /href="https:\/\/example.com\/dana"/);
  assert.match((await dana.get('/settings')).text, /We sent a confirmation link to Dana.Work@example.org/);

  r = await dana.post('/settings/contact-email/resend', {});
  assert.equal(r.res.status, 302);
  assert.match((await dana.get('/settings')).text, /less than a minute ago/);
  assert.equal(env.mailer.sent.length, before + 1);

  // The link works without a session and needs an explicit confirmation.
  const anon = new Browser(env);
  const confirm = await anon.get(link);
  assert.equal(confirm.res.status, 200);
  assert.match(confirm.text, /Dana.Work@example.org/);
  assert.equal((await anon.post(link, {})).res.status, 302);
  assert.equal((await anon.get(link)).res.status, 400);

  profile = await new Browser(env).get('/dana');
  assert.match(profile.text, /mailto:Dana.Work@example.org/);

  // Commits from the web editor use the contact address.
  await dana.post('/new', { name: 'notes', description: '', visibility: 'private' });
  await dana.post('/dana/notes/new', { ref: 'main', base: '', dir: '', name: 'a.md', content: 'x\n', message: '' });
  const oid = /\/commit\/([0-9a-f]{40})/.exec((await dana.get('/dana/notes/commits')).text)![1];
  assert.match((await dana.get(`/dana/notes/commit/${oid}`)).text, /&lt;Dana.Work@example.org&gt;/);

  // Switching back to the primary address needs no verification.
  r = await dana.post('/settings', { name: 'Dana', handle: 'dana', language: 'en', theme: 'site', contactEmail: 'DANA@example.com' });
  assert.equal(r.res.status, 302);
  assert.equal(env.mailer.sent.length, before + 1);
  assert.match((await new Browser(env).get('/dana')).text, /mailto:dana@example.com/);

  const base = { name: 'Dana', handle: 'dana', language: 'en', theme: 'site' };
  r = await dana.post('/settings', { ...base, contactEmail: '' });
  assert.equal(r.res.status, 400);
  assert.match(r.text, /Please enter a contact email/);
  r = await dana.post('/settings', { ...base, description: 'Hi <b>there</b>', homepage: 'example.net' });
  assert.equal(r.res.status, 400);
  assert.match(r.text, /must not contain HTML tags/);
  // The submitted values are kept for correction.
  assert.match(r.text, /<textarea name="description"[^>]*>Hi &lt;b&gt;there&lt;\/b&gt;<\/textarea>/);
  assert.match(r.text, /name="homepage" value="example.net"/);
  r = await dana.post('/settings', { ...base, homepage: 'javascript:alert(1)' });
  assert.equal(r.res.status, 400);
  assert.match(r.text, /Invalid homepage/);
});
