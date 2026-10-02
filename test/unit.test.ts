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
