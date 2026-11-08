// Title of a text document, used for the page header of printed
// documents: the Fountain title page, or the first Markdown heading.

import { isMarkdownPath } from './markdown.ts';
import { fountainTitle, isFountainPath } from './fountain.ts';

// Inline Markdown reduced to its text: links and images keep their
// label, emphasis and code markers are dropped.
function plainInline(s: string): string {
  return s
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/(\*\*|__|\*|_|~~|`)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/\\([\\`*_{}[\]()#+\-.!~|<>])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

export function markdownTitle(source: string): string | null {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (fence === null) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const atx = /^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (atx) {
      const text = plainInline(atx[1]);
      if (text) return text;
      continue;
    }
    // Setext heading: a text line underlined with = or -.
    const next = lines[i + 1] ?? '';
    if (line.trim() && !/^ {4}/.test(line) && /^ {0,3}(=+|-+)[ \t]*$/.test(next)) {
      const text = plainInline(line);
      if (text) return text;
    }
  }
  return null;
}

export function documentTitle(path: string, text: string): string | null {
  if (isMarkdownPath(path)) return markdownTitle(text);
  if (isFountainPath(path)) return fountainTitle(text);
  return null;
}
