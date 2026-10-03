import type { Page } from '../http/app.ts';
import { LANGUAGES, languageName } from '../i18n/index.ts';
import { html, raw, type Html } from './html.ts';
import { staticUrl } from '../http/static.ts';

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
export function localTime(page: Page, unix: number): Html {
  const iso = new Date(unix * 1000).toISOString();
  return html`<time datetime="${iso}" data-localtime>${formatDate(page, unix)}</time>`;
}

export function formatDay(page: Page, iso: string | null | undefined): string {
  if (!iso) return '';
  const locale = page.lang === 'uk' ? 'uk-UA' : page.lang === 'de' ? 'de-DE' : 'en-GB';
  return new Date(iso).toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formDayOrNever(page: Page, iso: string | null): string {
  return iso ? formatDay(page, iso) : page.t('tokens.never');
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

function footer(page: Page): Html {
  const next = encodeURIComponent(page.path);
  return html`<footer class="footer">
  <div>${page.branding.footerText}</div>
  <div class="langs">${LANGUAGES.map((l) => l === page.lang
    ? html`<strong>${languageName(l)}</strong>`
    : html`<a href="/lang/${l}?next=${next}" hreflang="${l}">${languageName(l)}</a>`)}</div>
</footer>`;
}

export function layout(page: Page, title: string, body: Html): string {
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
<main class="container">
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
