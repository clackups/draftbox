// Fountain screenplay rendering (https://fountain.io/syntax). All text is
// escaped, so the output can be embedded as is. Elements are block
// elements with "fn-" classes; app.css lays them out like a screenplay
// page.

import { escapeHtml } from '../views/html.ts';

export function isFountainPath(path: string): boolean {
  return /\.fountain$/i.test(path);
}

const TITLE_KEY_RE = /^([A-Za-z][A-Za-z ]*?):[ \t]*(.*)$/;
const SCENE_RE = /^(int|ext|est|int\.?\/ext|i\/e)[. ]/i;
const SCENE_NUMBER_RE = /\s*#([A-Za-z0-9.\-]+)#\s*$/;
const PARENTHETICAL_RE = /^\s*\(.*\)\s*$/;

// Inline emphasis: ***bold italic***, **bold**, *italic*, _underline_ and
// [[notes]]. Emphasis does not span lines; backslash escapes * and _.
function inline(text: string): string {
  const escapes: string[] = [];
  let s = text.replace(/\\([*_\\])/g, (_, ch: string) => `\u0000${escapes.push(ch) - 1}\u0000`);
  s = escapeHtml(s);
  s = s.replace(/\[\[([\s\S]*?)\]\]/g, '<span class="fn-note">$1</span>');
  s = s.replace(/\*\*\*(?=\S)([^\n]*?\S)\*\*\*/g, '<strong><em>$1</em></strong>');
  s = s.replace(/\*\*(?=\S)([^\n]*?\S)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*(?=\S)([^\n*]*?\S)\*/g, '<em>$1</em>');
  s = s.replace(/_(?=\S)([^\n_]*?\S)_/g, '<u>$1</u>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => escapeHtml(escapes[Number(i)]));
}

function block(cls: string, text: string): string {
  return `<div class="${cls}">${inline(text)}</div>`;
}

const isBlank = (line: string | undefined): boolean => line === undefined || line.trim() === '';

// Lines that are an element of their own even without blank lines around
// them: lyrics, page breaks, sections and synopses.
const isStandalone = (line: string): boolean => /^\s*(~|={3,}\s*$|#|=(?!=))/.test(line);

// A character cue: upper case (in any script), optionally with an
// extension such as (V.O.) and the ^ of dual dialogue.
function isCharacterCue(line: string): boolean {
  const name = line.trim().replace(/\^$/, '').replace(/\(.*\)\s*$/, '').trim();
  return /\p{L}/u.test(name) && name === name.toUpperCase() && !/^[!.>~=#]/.test(name);
}

interface TitleEntry {
  key: string;
  value: string;
}

// The title page: "Key: value" lines at the very start, up to the first
// blank line. Values may continue on indented lines.
function parseTitlePage(lines: string[]): { entries: TitleEntry[]; rest: number } {
  const entries: TitleEntry[] = [];
  if (!TITLE_KEY_RE.test(lines[0] ?? '')) return { entries, rest: 0 };
  let i = 0;
  for (; i < lines.length && !isBlank(lines[i]); i++) {
    const m = TITLE_KEY_RE.exec(lines[i]);
    if (m && !/^\s/.test(lines[i])) {
      entries.push({ key: m[1].trim().toLowerCase(), value: m[2].trim() });
    } else if (entries.length > 0) {
      const last = entries[entries.length - 1];
      last.value += (last.value ? '\n' : '') + lines[i].trim();
    }
  }
  return { entries, rest: i };
}

function renderTitlePage(entries: TitleEntry[]): string {
  if (entries.length === 0) return '';
  const get = (...keys: string[]) => entries.filter((e) => keys.includes(e.key)).map((e) => e.value);
  const center = [
    ...get('title').map((v) => block('fn-title', v)),
    ...get('credit').map((v) => block('fn-credit', v)),
    ...get('author', 'authors').map((v) => block('fn-author', v)),
    ...get('source').map((v) => block('fn-source', v)),
  ];
  const known = new Set(['title', 'credit', 'author', 'authors', 'source']);
  const corner = entries.filter((e) => !known.has(e.key)).map((e) => block('fn-meta', e.value));
  return `<div class="fn-title-page"><div class="fn-title-center">${center.join('')}</div>`
    + (corner.length ? `<div class="fn-title-meta">${corner.join('')}</div>` : '') + '</div>';
}

export function renderFountain(source: string): string {
  // Boneyard (/* ... */) is omitted from the output. NUL marks escaped
  // characters in inline().
  const text = source.replace(/\u0000/g, '').replace(/\r\n?/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');
  const lines = text.split('\n');
  const { entries, rest } = parseTitlePage(lines);
  const out: string[] = [];
  let lastDialogue = -1;

  for (let i = rest; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const before = isBlank(lines[i - 1]);
    const after = isBlank(lines[i + 1]);
    let m: RegExpExecArray | null;

    if (/^={3,}$/.test(trimmed)) {
      out.push('<hr class="fn-page-break">');
    } else if ((m = /^(#{1,6})\s*(.*)$/.exec(trimmed))) {
      out.push(block(`fn-section fn-section-${m[1].length}`, m[2]));
    } else if ((m = /^=(?!=)\s*(.*)$/.exec(trimmed))) {
      out.push(block('fn-synopsis', m[1]));
    } else if ((m = /^>\s*(.*?)\s*<$/.exec(trimmed))) {
      out.push(block('fn-centered', m[1]));
    } else if ((m = /^>\s*(.*)$/.exec(trimmed))) {
      out.push(block('fn-transition', m[1]));
    } else if (/^\.[^.]/.test(trimmed) || (before && SCENE_RE.test(trimmed))) {
      const heading = trimmed.replace(/^\./, '');
      const num = SCENE_NUMBER_RE.exec(heading);
      const label = num ? heading.slice(0, num.index) : heading;
      const number = num ? `<span class="fn-scene-number">${escapeHtml(num[1])}</span>` : '';
      out.push(`<div class="fn-scene">${number}${inline(label)}</div>`);
    } else if (before && after && /TO:$/.test(trimmed) && trimmed === trimmed.toUpperCase()) {
      out.push(block('fn-transition', trimmed));
    } else if (trimmed.startsWith('~')) {
      out.push(block('fn-lyrics', trimmed.slice(1).trim()));
    } else if (before && !after && !trimmed.startsWith('!') && (trimmed.startsWith('@') || isCharacterCue(trimmed))) {
      // Dialogue runs to the next blank line; a line of two spaces keeps
      // it going.
      const dual = trimmed.endsWith('^');
      const cue = trimmed.replace(/^@/, '').replace(/\s*\^$/, '');
      const parts = [block('fn-character', cue)];
      let speech: string[] = [];
      const flush = () => {
        if (speech.length) parts.push(block('fn-dialogue', speech.join('\n')));
        speech = [];
      };
      while (i + 1 < lines.length && (lines[i + 1].trim() !== '' || lines[i + 1] === '  ')) {
        const l = lines[++i];
        if (PARENTHETICAL_RE.test(l)) {
          flush();
          parts.push(block('fn-parenthetical', l.trim()));
        } else {
          speech.push(l.trim());
        }
      }
      flush();
      const html = `<div class="fn-speech">${parts.join('')}</div>`;
      if (dual && lastDialogue === out.length - 1 && lastDialogue >= 0) {
        out[lastDialogue] = `<div class="fn-dual">${out[lastDialogue]}${html}</div>`;
        lastDialogue = -1;
      } else {
        out.push(html);
        lastDialogue = out.length - 1;
      }
      continue;
    } else {
      // Action: consecutive lines form one paragraph; indentation is kept,
      // and a line of two spaces is an empty line inside it.
      const para = [line.replace(/^!/, '')];
      while (i + 1 < lines.length && (!isBlank(lines[i + 1]) || lines[i + 1] === '  ') && !isStandalone(lines[i + 1])) {
        para.push(lines[++i]);
      }
      out.push(block('fn-action', para.join('\n')));
    }
    lastDialogue = -1;
  }
  return `<div class="screenplay">${renderTitlePage(entries)}${out.join('')}</div>`;
}
