// The pdfmake bundle as served (with the fontkit fixes of
// src/http/static.ts), run outside the browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { patchPdfmake } from '../src/http/static.ts';

const BUNDLE = readFileSync(new URL('../node_modules/pdfmake/build/pdfmake.min.js', import.meta.url), 'utf8');
const BENGALI = readFileSync(new URL('../node_modules/@expo-google-fonts/hind-siliguri/400Regular/HindSiliguri_400Regular.ttf', import.meta.url));

// The glyph codes of each piece of text in a one-line PDF of `text`. The
// sandbox shares the typed arrays, so that the font buffer is one.
async function glyphRuns(code: string, text: string): Promise<string[]> {
  const sb: Record<string, unknown> = { queueMicrotask, setTimeout, clearTimeout, TextEncoder, TextDecoder, URL, atob, btoa, Uint8Array, ArrayBuffer, DataView, navigator: { userAgent: 'node' }, document: { createElement: () => ({}) } };
  sb.window = sb;
  runInNewContext(code, sb);
  const pm = sb.pdfMake as {
    virtualfs: { writeFileSync(name: string, data: Uint8Array): void };
    setFonts(fonts: Record<string, Record<string, string>>): void;
    createPdf(doc: unknown): { getBuffer(): Promise<Uint8Array> };
  };
  pm.virtualfs.writeFileSync('b.ttf', BENGALI);
  pm.setFonts({ B: { normal: 'b.ttf', bold: 'b.ttf', italics: 'b.ttf', bolditalics: 'b.ttf' } });
  const pdf = Buffer.from(await pm.createPdf({ content: [text], defaultStyle: { font: 'B' }, compress: false }).getBuffer()).toString('latin1');
  return [...pdf.matchAll(/\[<([0-9a-f]+)>[^\]]*\] TJ/g)].map((m) => m[1]);
}

test('each fix applies exactly once to the bundle', () => {
  assert.notEqual(patchPdfmake(BUNDLE), BUNDLE);
  assert.throws(() => patchPdfmake(patchPdfmake(BUNDLE)), /expected one/);
});

test('a Bengali reph over a pre-base matra is drawn once', async () => {
  // Ra + virama + ka, then the same with the vowel sign i. Subset glyph
  // codes are given in order of first use: ka 0001, reph 0002, space 0003.
  const text = '\u09b0\u09cd\u0995 \u09b0\u09cd\u0995\u09bf';
  // fontkit unfixed: the i-matra with its reph, ka, and the reph again.
  assert.deepEqual(await glyphRuns(BUNDLE, text), ['0001', '0002', '0003', '00040001', '0002']);
  // Fixed (as HarfBuzz): the reph left behind becomes an empty glyph.
  assert.deepEqual(await glyphRuns(patchPdfmake(BUNDLE), text), ['0001', '0002', '0003', '000400010005']);
});
