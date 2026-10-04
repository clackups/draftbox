import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { diffLines, hunks } from '../src/util/diff.ts';
import { renderMarkdown, resolveRelative } from '../src/util/markdown.ts';
import { html, raw } from '../src/views/html.ts';
import { decrypt, encrypt } from '../src/util/crypto.ts';
import { validFilePath, validRefName, validRepoName } from '../src/services/repos.ts';
import { negotiateLanguage, translator } from '../src/i18n/index.ts';
import { sign, unsign } from '../src/auth/session.ts';
import { isValidEmail, normalizeDescription, normalizeHomepage } from '../src/services/users.ts';
import { idTokenClaims } from '../src/auth/oauth.ts';
import { sanitizeHtml } from '../src/util/sanitize.ts';
import { safeNext } from '../src/http/app.ts';

test('diffLines finds insertions and deletions', () => {
  const ops = diffLines('a\nb\nc\n', 'a\nB\nc\nd\n')!;
  assert.deepEqual(ops.map((o) => o.op + o.text), [' a', '-b', '+B', ' c', '+d']);
  const h = hunks(ops, 1);
  assert.equal(h.length, 1);
  assert.equal(h[0].oldStart, 1);
});

test('hunks splits distant changes', () => {
  const a = Array.from({ length: 30 }, (_, i) => `l${i}`).join('\n');
  const b = a.replace('l2\n', 'X\n').replace('l25\n', 'Y\n');
  const h = hunks(diffLines(a, b)!, 3);
  assert.equal(h.length, 2);
  assert.equal(h[1].newStart, 23);
});

test('markdown escapes raw HTML and unsafe links', () => {
  const out = renderMarkdown('<script>alert(1)</script>\n\n[x](javascript:alert(1)) [y](https://e.com) ![i](data:x)');
  assert.ok(!out.includes('<script>'));
  assert.ok(out.includes('&lt;script&gt;'));
  assert.ok(!out.includes('javascript:'));
  assert.ok(out.includes('href="https://e.com"'));
  assert.ok(!out.includes('src="data:'));
});

test('markdown resolves relative links', () => {
  const out = renderMarkdown('[a](b.md) ![p](../img/p.png)', {
    dir: 'docs/sub', link: (p) => `/L/${p}`, image: (p) => `/I/${p}`,
  });
  assert.ok(out.includes('href="/L/docs/sub/b.md"'));
  assert.ok(out.includes('src="/I/docs/img/p.png"'));
  assert.equal(resolveRelative('', '../x'), null);
});

test('html template escapes values', () => {
  assert.equal(html`<p>${'<b>&'}</p>`.value, '<p>&lt;b&gt;&amp;</p>');
  assert.equal(html`<p>${raw('<b>')}</p>`.value, '<p><b></p>');
  assert.equal(html`${['<', raw('>')]}`.value, '&lt;>');
});

test('encryption round trip', () => {
  const c = encrypt('k'.repeat(32), 'secret value');
  assert.equal(decrypt('k'.repeat(32), c), 'secret value');
  assert.throws(() => decrypt('z'.repeat(32), c));
});

test('signed cookies reject tampering', () => {
  const v = sign('s'.repeat(32), 'p', { a: 1 });
  assert.deepEqual(unsign('s'.repeat(32), 'p', v), { a: 1 });
  assert.equal(unsign('s'.repeat(32), 'other', v), null);
  assert.equal(unsign('s'.repeat(32), 'p', v.replace(/^./, 'x')), null);
});

test('name validation', () => {
  assert.ok(validRepoName('my-notes_2.0'));
  assert.ok(!validRepoName('x.git'));
  assert.ok(!validRepoName('../x'));
  assert.ok(!validRepoName('.hidden'));
  assert.ok(validRefName('feature/one'));
  assert.ok(!validRefName('a..b'));
  assert.ok(!validRefName('x.lock'));
  assert.ok(validFilePath('docs/a.md'));
  assert.ok(!validFilePath('docs/../a.md'));
  assert.ok(!validFilePath('.git/config'));
});

test('translations', () => {
  assert.equal(translator('de')('nav.login'), 'Anmelden');
  assert.equal(translator('uk')('tokens.months', { n: 3 }), '3 \u043c\u0456\u0441.');
  assert.equal(translator('xx')('nav.login'), 'Log in');
  assert.equal(negotiateLanguage('fr-FR,de;q=0.8,en;q=0.5'), 'de');
  assert.equal(negotiateLanguage('fr'), null);
});

test('all locales have the same keys', () => {
  const load = (l: string) => Object.keys(JSON.parse(readFileSync(new URL(`../locales/${l}.json`, import.meta.url), 'utf8'))).sort();
  const en = load('en');
  assert.deepEqual(load('uk'), en);
  assert.deepEqual(load('de'), en);
});

test('profile field validation', () => {
  assert.equal(normalizeHomepage(''), '');
  assert.equal(normalizeHomepage(' example.com '), 'https://example.com/');
  assert.equal(normalizeHomepage('http://example.com/a?b=1'), 'http://example.com/a?b=1');
  for (const bad of ['javascript:alert(1)', 'ftp://example.com', 'https://localhost', 'https://u:p@example.com', 'not a url']) {
    assert.throws(() => normalizeHomepage(bad), /invalid_homepage/, bad);
  }
  assert.equal(normalizeDescription(' a\r\nb '), 'a\nb');
  assert.equal(normalizeDescription('1 < 2 and I <3 it'), '1 < 2 and I <3 it');
  assert.throws(() => normalizeDescription('<script>x</script>'), /description_html/);
  assert.throws(() => normalizeDescription('x'.repeat(1001)), /description_too_long/);
  assert.ok(isValidEmail('first.last+tag@example.co.uk'));
  assert.ok(!isValidEmail('no-at-sign'));
  assert.ok(!isValidEmail('a@b'));
  assert.ok(!isValidEmail('a b@example.com'));
});

test('ID token claims are checked for audience and issuer', () => {
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const tok = (c: object) => `${enc({ alg: 'RS256' })}.${enc(c)}.sig`;
  const good = { iss: 'https://codeberg.org', aud: 'cid', sub: '42', email: 'a@b.c', email_verified: true };
  assert.equal(idTokenClaims(tok(good), 'cid', 'https://codeberg.org/').email_verified, true);
  assert.throws(() => idTokenClaims(tok({ ...good, aud: 'other' }), 'cid', 'https://codeberg.org'));
  assert.throws(() => idTokenClaims(tok({ ...good, iss: 'https://evil' }), 'cid', 'https://codeberg.org'));
  assert.throws(() => idTokenClaims(tok({ ...good, exp: 1 }), 'cid'));
  assert.throws(() => idTokenClaims('garbage', 'cid'));
});

test('footer HTML sanitizer keeps safe markup only', () => {
  assert.equal(sanitizeHtml('&copy; 2026 <b>Acme</b> & co<br>'), '&copy; 2026 <b>Acme</b> &amp; co<br>');
  assert.equal(sanitizeHtml('<a href="https://x.example/" target="_blank" onclick="evil()">x</a>'),
    '<a href="https://x.example/" target="_blank" rel="noopener noreferrer">x</a>');
  assert.equal(sanitizeHtml('<a href="javascript:alert(1)">x</a>'), '<a>x</a>');
  assert.equal(sanitizeHtml('<a href="/a?x=1&amp;y=2">x</a>'), '<a href="/a?x=1&amp;y=2">x</a>');
  assert.equal(sanitizeHtml('<a href="jav&#x61;script:alert(1)">x</a>'), '<a>x</a>');
  assert.equal(sanitizeHtml('<img src="/branding/logo" alt="l" onerror="x()">'), '<img src="/branding/logo" alt="l">');
  assert.equal(sanitizeHtml('a<script>alert(1)</script>b<style>p{}</style>c'), 'abc');
  assert.equal(sanitizeHtml('<iframe src="https://x"></iframe><form><input>ok</form>'), 'ok');
  assert.equal(sanitizeHtml('<span style="color:red">r</span><span style="background:url(x)">u</span>'),
    '<span style="color:red">r</span><span>u</span>');
  // Unbalanced markup cannot break the page.
  assert.equal(sanitizeHtml('<b><i>x</b> y</i> </div>'), '<b><i>x</i></b> y ');
  assert.equal(sanitizeHtml('<span>open'), '<span>open</span>');
  assert.equal(sanitizeHtml('1 < 2 <!-- c --> "q"'), '1 &lt; 2  "q"');
  assert.equal(sanitizeHtml('<a title="a&quot;b" href=\'/p?x=1&y=2\'>t</a>'), '<a title="a&quot;b" href="/p?x=1&amp;y=2">t</a>');
});

test('safeNext accepts only paths on the same site', () => {
  assert.equal(safeNext('/alice/notes?ref=main#top'), '/alice/notes?ref=main#top');
  assert.equal(safeNext('/'), '/');
  assert.equal(safeNext('/alice/notes/blob/my notes.md'), '/alice/notes/blob/my%20notes.md');
  for (const bad of [undefined, '', 'https://evil.example', '//evil.example', '/\\evil.example',
    '/\t/evil.example', '/\n/evil.example', '/..//evil.example', '/./\t/evil.example', '\\\\evil.example',
    'javascript:alert(1)']) {
    assert.equal(safeNext(bad), '/', String(bad));
  }
});
