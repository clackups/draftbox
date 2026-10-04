// Markdown rendering for user content. Raw HTML in the source is escaped
// and only safe URL schemes are kept, so the output can be embedded as is.

import { Marked, type Tokens } from 'marked';
import { escapeHtml } from '../views/html.ts';

const SAFE_URL = /^(https?:|mailto:|#|\/|\.\/|\.\.\/|[^:]*$)/i;
// Absolute and protocol-relative URLs (browsers read "/\\" as "//").
const EXTERNAL_URL = /^([a-z][a-z0-9+.-]*:|\/[\/\\])/i;

function safeUrl(href: string): string | null {
  const trimmed = href.trim();
  return SAFE_URL.test(trimmed) ? trimmed : null;
}

export interface LinkResolver {
  // Maps a relative link target (resolved against the document) to a URL.
  link(path: string): string;
  image(path: string): string;
  // Directory of the document inside the repository ('' for the root).
  dir: string;
}

let currentResolver: LinkResolver | null = null;

function isRelative(href: string): boolean {
  return !/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(href);
}

// Resolves a relative path against a directory; null if it escapes the root.
export function resolveRelative(dir: string, href: string): string | null {
  const parts = dir ? dir.split('/') : [];
  for (const seg of href.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(seg);
    }
  }
  return parts.join('/');
}

function rewrite(href: string, kind: 'link' | 'image'): string {
  if (!currentResolver || !isRelative(href)) return href;
  const hashAt = href.indexOf('#');
  const pathPart = hashAt >= 0 ? href.slice(0, hashAt) : href;
  const hash = hashAt >= 0 ? href.slice(hashAt) : '';
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathPart.split('?')[0]);
  } catch {
    return href;
  }
  const resolved = resolveRelative(currentResolver.dir, decoded);
  if (resolved === null) return href;
  return (kind === 'link' ? currentResolver.link(resolved) : currentResolver.image(resolved)) + hash;
}

const marked = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    html(token: Tokens.HTML | Tokens.Tag): string {
      return escapeHtml(token.text);
    },
    link(this: { parser: { parseInline(tokens: Tokens.Generic[]): string } }, token: Tokens.Link): string {
      const text = this.parser.parseInline(token.tokens);
      const safe = safeUrl(token.href);
      if (!safe) return text;
      const href = rewrite(safe, 'link');
      const title = token.title ? ` title="${escapeHtml(token.title)}"` : '';
      return `<a href="${escapeHtml(href)}"${title} rel="nofollow noopener">${text}</a>`;
    },
    image(token: Tokens.Image): string {
      const safe = safeUrl(token.href);
      if (!safe) return escapeHtml(token.text);
      const src = rewrite(safe, 'image');
      // Loading images from other sites would tell them who reads the
      // document (and the page CSP blocks them): link to them instead.
      if (EXTERNAL_URL.test(src)) {
        return `<a href="${escapeHtml(src)}" rel="nofollow noopener">${escapeHtml(token.text || src)}</a>`;
      }
      const title = token.title ? ` title="${escapeHtml(token.title)}"` : '';
      return `<img src="${escapeHtml(src)}" alt="${escapeHtml(token.text)}"${title} loading="lazy">`;
    },
  },
});

export function renderMarkdown(source: string, resolver?: LinkResolver): string {
  currentResolver = resolver ?? null;
  try {
    return marked.parse(source, { async: false }) as string;
  } finally {
    currentResolver = null;
  }
}

export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown|mdown|mkd)$/i.test(path);
}
