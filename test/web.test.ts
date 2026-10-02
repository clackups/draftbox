import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN_EMAIL, Browser, adminApi, setup, type TestEnv } from './helpers.ts';

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

test('repositories: create, edit, history, tags and visibility', async () => {
  const alice = new Browser(env);
  await alice.login('alice@example.com');

  let r = await alice.post('/new', { name: 'notes', description: 'My notes', visibility: 'private', readme: '1' });
  assert.equal(r.res.status, 302);
  assert.equal(r.res.headers.get('Location'), '/alice/notes');

  let page = await alice.get('/alice/notes');
  assert.match(page.text, /My notes/);
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
  await alice.post('/new', { name: 'branchy', description: '', visibility: 'private', readme: '1' });

  assert.equal((await alice.post('/alice/branchy/branches', { name: 'draft', from: 'main' })).res.status, 403);
  await alice.post('/settings', { name: 'Alice', handle: 'alice', language: 'en', theme: 'auto', advancedMode: '1' });
  let r = await alice.post('/alice/branchy/branches', { name: 'draft', from: 'main' });
  assert.equal(r.res.status, 302);

  let page = await alice.get('/alice/branchy/edit/README.md?ref=draft');
  const base = /name="base" value="([0-9a-f]{40})"/.exec(page.text)![1];
  r = await alice.post('/alice/branchy/edit/README.md', { ref: 'draft', base, dir: '', name: 'README.md', content: 'draft text\n', message: '' });
  assert.equal(r.res.status, 302);
  assert.equal((await alice.get('/alice/branchy/raw/README.md?ref=draft')).text, 'draft text\n');
  assert.notEqual((await alice.get('/alice/branchy/raw/README.md')).text, 'draft text\n');

  // Back in simple mode the ref parameter is ignored for branches.
  await alice.post('/settings', { name: 'Alice', handle: 'alice', language: 'en', theme: 'auto' });
  page = await alice.get('/alice/branchy/raw/README.md?ref=draft');
  assert.notEqual(page.text, 'draft text\n');
});

test('access tokens and one-time passwords', async () => {
  const alice = new Browser(env);
  await alice.login('alice@example.com');
  const r = await alice.post('/settings/tokens', { name: 'laptop', repoId: '', access: 'read', validity: '3', otp: '1' });
  assert.equal(r.res.status, 200);
  const value = /value="(dbx_[0-9a-f]{16}_[A-Za-z0-9_-]{43})"/.exec(r.text)![1];
  const otp = /<p class="otp">(\d{4}) (\d{4})<\/p>/.exec(r.text)!;
  const password = otp[1] + otp[2];

  const auth = await env.svc.tokens.authenticate(value);
  assert.equal(auth?.token.access, 'read');
  assert.ok(auth?.token.expiresAt);

  const exchange = (pw: string) => env.app.request('/api/v1/token-exchange', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw }),
  });
  let res = await exchange(password);
  assert.equal(res.status, 200);
  const body = await res.json() as { token: string; access: string };
  assert.equal(body.token, value);
  assert.equal(body.access, 'read');
  // Only once.
  assert.equal((await exchange(password)).status, 404);

  // Revoking invalidates the token.
  const tokenId = value.split('_')[1];
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
  await bob.post('/new', { name: 'pub', description: '', visibility: 'public', readme: '1' });
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
    siteName: 'Writers Hub', primaryColor: '#112233', accentColor: '#445566', defaultTheme: 'dark', footerText: 'Hello', customCss: 'body{x:y}</style><script>',
  });
  const anon = new Browser(env);
  const page = await anon.get('/');
  assert.match(page.text, /Writers Hub/);
  assert.match(page.text, /data-theme="dark"/);
  const css = await anon.get('/branding/theme.css');
  assert.match(css.text, /--brand:#112233/);
  assert.doesNotMatch(css.text, /<\/style/);

  await anon.get('/lang/de?next=/');
  assert.match((await anon.get('/')).text, /Anmelden/);
  const uk = new Browser(env);
  assert.match((await uk.get('/', { 'Accept-Language': 'uk-UA,uk;q=0.9' })).text, /lang="uk"/);
});
