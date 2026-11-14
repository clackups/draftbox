// static/pdf.js, run outside the browser: plain text mode needs no DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

interface Piece { text: string; font?: string }
interface Node { text?: Piece[] | string; stack?: Node[]; alignment?: string; margin?: number[] }
interface Pdf {
  build(opts: Record<string, unknown>): { content: Node[]; header?: () => Node };
  scriptsIn(source: string): string[];
  isScriptFont(family: string): boolean;
}

const sandbox: { window: { DraftboxPdf?: Pdf } } = { window: {} };
runInNewContext(readFileSync(new URL('../static/pdf.js', import.meta.url), 'utf8'), sandbox);
const pdf = sandbox.window.DraftboxPdf!;

// Hebrew written with escapes: the code is ASCII only.
const SHALOM = '\u05e9\u05dc\u05d5\u05dd';
const OLAM = '\u05e2\u05d5\u05dc\u05dd';
const YAFE = '\u05d9\u05e4\u05d4';

// Every character 6 points wide.
const measure = (text: string, _f: string, _b: boolean, _i: boolean, size: number) => text.length * size * 0.6;
const build = (text: string, extra: Record<string, unknown> = {}) =>
  pdf.build({ mode: 'text', text, paper: 'A4', fontSize: 10, header: false, filename: 'x.txt', measure, ...extra }).content[0];
const line = (node: Node) => (node.text as Piece[]).map((p) => p.text).join('');

test('a right-to-left line is set right-aligned in display order', () => {
  const node = build(`${SHALOM} ${OLAM} Draftbox PDF 2026.`);
  const row = node.stack![0];
  assert.equal(row.alignment, 'right');
  // From the left: the period, the Latin words and the number after them
  // (one left-to-right run), then the Hebrew words from last to first.
  assert.equal(line(row), `.Draftbox PDF 2026 ${OLAM} ${SHALOM}`);
  // A number right after Hebrew is its own run.
  assert.equal(line(build(`${SHALOM} 2026 ${OLAM}`).stack![0]), `${OLAM} 2026 ${SHALOM}`);
  for (const p of row.text as Piece[]) {
    if (/[\u05d0-\u05ea]/.test(p.text)) assert.equal(p.font, 'Hebrew');
  }
});

test('a Hebrew phrase in a left-to-right line is reversed in place', () => {
  const node = build(`Quote: ${SHALOM} ${OLAM} ${YAFE}, done.`);
  assert.equal(line(node), `Quote: ${YAFE} ${OLAM} ${SHALOM}, done.`);
});

test('brackets around Hebrew are mirrored, and long lines wrap in order', () => {
  assert.equal(line(build(`(${SHALOM})`).stack![0]), `(${SHALOM})`);
  const words = Array.from({ length: 200 }, (_, i) => `${SHALOM}${i}`);
  const rows = build(words.join(' ')).stack!;
  assert.ok(rows.length > 1);
  // The first row holds the first words, the last of them on the left.
  const first = line(rows[0]).split(' ');
  assert.equal(first[first.length - 1], `0${SHALOM}`);
});

test('documents without Hebrew are left as they are', () => {
  const plain = 'Just text\n\tindented\n';
  assert.deepEqual(JSON.parse(JSON.stringify(build(plain))), JSON.parse(JSON.stringify(build(plain, { measure: undefined }))));
});

// Devanagari, Bengali and Tamil, written with escapes.
const NAMASTE = '\u0928\u092e\u0938\u094d\u0924\u0947';
const BANGLA = '\u09ac\u09be\u0982\u09b2\u09be';
const TAMIL = '\u0ba4\u0bae\u0bbf\u0bb4\u0bcd';
const DANDA = '\u0964';
const ZWJ = '\u200d';
const runs = (node: Node) => JSON.parse(JSON.stringify((node.text as (Piece | string)[]).map((p) => typeof p === 'string' ? [p, ''] : [p.text, p.font ?? ''])));

test('runs of Indic letters get the font of their script', () => {
  const node = build(`Hello ${NAMASTE}, ${BANGLA}${DANDA} ${TAMIL}.`, { measure: undefined });
  assert.deepEqual(runs(node), [
    ['Hello ', ''], [NAMASTE, 'Devanagari'], [', ', ''],
    // The danda (a Devanagari character) stays with the Bengali it ends.
    [BANGLA + DANDA, 'Bengali'], [' ', ''], [TAMIL, 'Tamil'], ['.', ''],
  ]);
  // A joiner stays in its run; the text node keeps its own properties.
  const joined = build(`a\u0915\u094d${ZWJ}\u0937b`, { measure: undefined });
  assert.deepEqual(runs(joined), [['a', ''], [`\u0915\u094d${ZWJ}\u0937`, 'Devanagari'], ['b', '']]);
  assert.equal(joined.font, 'Mono');
});

test('the header gets script fonts too, and the fonts needed are named', () => {
  const doc = pdf.build({ mode: 'text', text: 'x', paper: 'A4', fontSize: 10, header: true, headerText: NAMASTE, filename: 'x.txt' });
  assert.deepEqual(runs(doc.header!()), [[NAMASTE, 'Devanagari']]);
  assert.deepEqual([...pdf.scriptsIn(`${SHALOM} ${TAMIL} ${NAMASTE}`)], ['Hebrew', 'Devanagari', 'Tamil']);
  assert.deepEqual([...pdf.scriptsIn('plain')], []);
  assert.ok(pdf.isScriptFont('Bengali') && pdf.isScriptFont('Hebrew') && !pdf.isScriptFont('Roboto'));
});

test('Indic words in right-to-left lines are measured in their font', () => {
  const families: string[] = [];
  const spy = (text: string, f: string, b: boolean, i: boolean, size: number) => {
    if (text.includes(NAMASTE)) families.push(f);
    return measure(text, f, b, i, size);
  };
  const row = build(`${SHALOM} ${NAMASTE} ${OLAM}`, { measure: spy }).stack![0];
  assert.deepEqual(families, ['Devanagari']);
  assert.ok(JSON.stringify(row).includes(JSON.stringify({ text: NAMASTE, font: 'Devanagari' })));
});
