import type { Page } from '../http/app.ts';
import { LANGUAGES, languageName } from '../i18n/index.ts';
import { escapeHtml, html, raw, type Html } from './html.ts';
import { staticUrl } from '../http/static.ts';
import type { LimitStatus } from '../services/limits.ts';
import { sanitizeHtml } from '../util/sanitize.ts';

export function csrfField(page: Page): Html {
  return html`<input type="hidden" name="_csrf" value="${page.csrf}">`;
}

export function formatDate(page: Page, iso: string | number | null | undefined): string {
  if (iso === null || iso === undefined) return '';
  const d = typeof iso === 'number' ? new Date(iso * 1000) : new Date(iso);
  const locale = page.lang === 'uk' ? 'uk-UA' : page.lang === 'de' ? 'de-DE' : 'en-GB';
  return d.toLocaleString(locale, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// A timestamp that app.js re-renders in the browser's local timezone;
// the server-formatted text remains as the no-JavaScript fallback.
// 'full' adds seconds and the zone name, 'date' shows the day only.
export type TimeStyle = 'datetime' | 'full' | 'date';

export function localTime(page: Page, value: string | number | null | undefined, style: TimeStyle = 'datetime'): Html | string {
  if (value === null || value === undefined || value === '') return '';
  const d = typeof value === 'number' ? new Date(value * 1000) : new Date(value);
  if (isNaN(d.getTime())) return '';
  const text = style === 'date' ? formatDay(page, d.toISOString()) : formatDate(page, d.toISOString());
  return html`<time datetime="${d.toISOString()}" data-localtime="${style}">${text}</time>`;
}

export function formatDay(page: Page, iso: string | null | undefined): string {
  if (!iso) return '';
  const locale = page.lang === 'uk' ? 'uk-UA' : page.lang === 'de' ? 'de-DE' : 'en-GB';
  return new Date(iso).toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formDayOrNever(page: Page, iso: string | null): Html | string {
  return iso ? localTime(page, iso, 'date') : page.t('tokens.never');
}

// Storage used by an account, compared with its quota.
export function storageUsage(page: Page, s: LimitStatus): string {
  const used = page.t('admin.mb', { n: (s.usedBytes / (1024 * 1024)).toFixed(1) });
  return s.storageQuotaMb === null
    ? `${used} / ${page.t('admin.unlimited')}`
    : `${used} / ${page.t('admin.mb', { n: s.storageQuotaMb })}`;
}

// Translates a message whose parameters are HTML fragments (such as
// localTime); the message text itself is escaped.
export function tHtml(page: Page, key: string, params: Record<string, Html | string>): Html {
  const parts = page.t(key).split(/\{(\w+)\}/);
  return raw(parts.map((p, i) => (i % 2 === 0 ? escapeHtml(p) : p in params ? html`${params[p]}`.value : escapeHtml(`{${p}}`))).join(''));
}

function header(page: Page): Html {
  const { t, user, branding } = page;
  const logo = branding.hasLogo
    ? html`<img src="/branding/logo" alt="" class="logo">`
    : html`<img src="${staticUrl('favicon.svg')}" alt="" class="logo">`;
  return html`<header class="topbar">
  <a class="brand" href="/">${logo}<span>${branding.siteName}</span></a>
  <nav class="mainnav">
    <a href="/explore">${t('nav.explore')}</a>
    ${user
      ? html`<a href="/new" class="btn btn-small">${t('nav.new_repo')}</a>
        <a href="/settings/tokens">${t('nav.tokens')}</a>
        <a href="/settings">${t('nav.settings')}</a>
        ${page.admin ? html`<a href="/admin">${t('nav.admin')}</a>` : ''}
        <form method="post" action="/logout" class="inline">${csrfField(page)}<button class="linkbtn">${t('nav.logout')}</button></form>`
      : html`<a href="/login" class="btn btn-small">${t('nav.login')}</a>`}
  </nav>
</header>`;
}

const GITHUB_URL = 'https://github.com/clackups/draftbox';

// GitHub mark (octicon mark-github), inline so it follows the text color.
const GITHUB_ICON = '<svg viewBox="0 0 16 16" width="20" height="20" aria-hidden="true" fill="currentColor">'
  + '<path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49'
  + '-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82'
  + '.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15'
  + '-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82'
  + ' 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48'
  + ' 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>';

function footer(page: Page): Html {
  const next = encodeURIComponent(page.path);
  return html`<footer class="footer">
  <div class="footer-text">${raw(sanitizeHtml(page.branding.footerText))}</div>
  <div class="footer-end">
    <div class="langs">${LANGUAGES.map((l) => l === page.lang
      ? html`<strong>${languageName(l)}</strong>`
      : html`<a href="/lang/${l}?next=${next}" hreflang="${l}">${languageName(l)}</a>`)}</div>
    <a class="github" href="${GITHUB_URL}" title="GitHub" aria-label="GitHub" rel="noopener">${raw(GITHUB_ICON)}</a>
  </div>
</footer>`;
}

// `wide` lets the content use more of large screens, for wide tables.
export function layout(page: Page, title: string, body: Html, opts: { wide?: boolean } = {}): string {
  const theme = page.theme === 'auto' ? '' : page.theme;
  const flash = page.flash
    ? html`<div class="flash flash-${page.flash.kind}" role="status">${page.t(page.flash.key.startsWith('error.') ? page.flash.key : 'flash.' + page.flash.key)}</div>`
    : '';
  return html`<!doctype html>
<html lang="${page.lang}"${theme ? raw(` data-theme="${theme}"`) : ''}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title ? `${title} - ${page.branding.siteName}` : page.branding.siteName}</title>
<link rel="icon" href="${page.branding.hasLogo ? '/branding/logo' : staticUrl('favicon.svg')}">
<link rel="stylesheet" href="${staticUrl('app.css')}">
<link rel="stylesheet" href="/branding/theme.css">
<script src="${staticUrl('app.js')}" defer></script>
</head>
<body>
${header(page)}
<main class="container${opts.wide ? ' wide' : ''}">
${flash}
${body}
</main>
${footer(page)}
</body>
</html>`.value;
}

export function errorPage(page: Page, status: number, key: string): string {
  const { t } = page;
  let msg = t(key);
  if (msg === key) msg = t('error.generic');
  return layout(page, t('error.title'), html`<section class="card narrow center">
  <h1>${status}</h1>
  <p>${msg}</p>
  ${status === 401 && !page.user
    ? html`<p><a class="btn" href="/login?next=${encodeURIComponent(page.path)}">${t('nav.login')}</a></p>`
    : html`<p><a href="/">${t('error.back_home')}</a></p>`}
</section>`);
}
