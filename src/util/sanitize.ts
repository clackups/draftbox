// Allowlist HTML sanitizer for small administrator-provided fragments
// such as the footer. Tags and attributes not listed are dropped (their
// text content is kept), text is escaped, unclosed tags are closed.

const VOID_TAGS = new Set(['br', 'img', 'hr']);

const COMMON_ATTRS = ['class', 'title', 'style'];
const ALLOWED: Record<string, string[]> = {
  a: ['href', 'target', 'rel'],
  img: ['src', 'alt', 'width', 'height'],
  b: [], strong: [], i: [], em: [], u: [], s: [], small: [], span: [], code: [],
  sub: [], sup: [], p: [], div: [], br: [], hr: [], ul: [], ol: [], li: [],
};

// Elements whose content is dropped together with them.
const DROP_CONTENT = new Set(['script', 'style', 'iframe', 'object', 'embed', 'template', 'noscript', 'textarea', 'title']);

const TAG_RE = /<!--[\s\S]*?(?:-->|$)|<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^\s=>\/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*\/?>/g;
const ATTR_RE = /([^\s=>\/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

function escapeText(s: string): string {
  // Keep character references such as &copy; or &#169;.
  return s.replace(/&(?!(?:[a-zA-Z][a-zA-Z0-9]{1,31}|#\d{1,7}|#x[0-9a-fA-F]{1,6});)/g, '&amp;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function decodeEntities(s: string): string {
  return s.replace(/&#x([0-9a-f]+);?/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);?/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&colon;/gi, ':').replace(/&tab;/gi, '\t').replace(/&newline;/gi, '\n')
    .replace(/&quot;/gi, '"').replace(/&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&');
}

// http(s), mailto and relative URLs only.
function safeUrl(value: string): boolean {
  const v = decodeEntities(value).replace(/[\x00-\x20\x7f]+/g, '').toLowerCase();
  const scheme = /^([a-z][a-z0-9+.-]*):/.exec(v);
  return !scheme || ['http', 'https', 'mailto'].includes(scheme[1]);
}

function safeStyle(value: string): boolean {
  const v = decodeEntities(value).toLowerCase().replace(/\s+/g, '');
  return !/url\(|expression\(|@import|\\|javascript:|behavior:/.test(v);
}

function attributes(tag: string, src: string): string {
  const allowed = ALLOWED[tag];
  let out = '';
  let blankTarget = false;
  const seen = new Set<string>();
  for (const m of src.matchAll(ATTR_RE)) {
    const name = m[1].toLowerCase();
    if (seen.has(name) || (!allowed.includes(name) && !COMMON_ATTRS.includes(name))) continue;
    const value = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
    if ((name === 'href' || name === 'src') && !safeUrl(value)) continue;
    if (name === 'style' && !safeStyle(value)) continue;
    if (name === 'target') {
      if (value !== '_blank') continue;
      blankTarget = true;
    }
    if (name === 'rel') continue;
    seen.add(name);
    out += ` ${name}="${escapeAttr(value)}"`;
  }
  if (blankTarget) out += ' rel="noopener noreferrer"';
  return out;
}

export function sanitizeHtml(input: string): string {
  let out = '';
  const open: string[] = [];
  let dropping: string | null = null;
  let last = 0;
  for (const m of input.matchAll(TAG_RE)) {
    const text = input.slice(last, m.index);
    last = m.index + m[0].length;
    if (!dropping) out += escapeText(text);
    if (!m[2]) continue; // comment
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    if (dropping) {
      if (closing && tag === dropping) dropping = null;
      continue;
    }
    if (DROP_CONTENT.has(tag)) {
      if (!closing && !/\/\s*>$/.test(m[0])) dropping = tag;
      continue;
    }
    if (!(tag in ALLOWED)) continue;
    if (closing) {
      const i = open.lastIndexOf(tag);
      if (i < 0) continue;
      // Close everything opened after it as well.
      while (open.length > i) out += `</${open.pop()}>`;
    } else {
      out += `<${tag}${attributes(tag, m[3] ?? '')}>`;
      if (!VOID_TAGS.has(tag)) open.push(tag);
    }
  }
  if (!dropping) out += escapeText(input.slice(last));
  while (open.length) out += `</${open.pop()}>`;
  return out;
}
