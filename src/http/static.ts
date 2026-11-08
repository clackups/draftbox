import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Hono } from 'hono';
import type { AppEnv, Services } from './app.ts';
import type { Branding } from '../db/models.ts';

const JS = 'text/javascript; charset=utf-8';
const TTF = 'font/ttf';
const PDFMAKE = 'node_modules/pdfmake/build/';
const DEJAVU = 'node_modules/dejavu-fonts-ttf/ttf/';

// Files served under /static/, relative to the project root. The PDF
// libraries and fonts come straight from their npm packages.
const STATIC_FILES: Record<string, { type: string; file: string }> = {
  'app.css': { type: 'text/css; charset=utf-8', file: 'static/app.css' },
  'app.js': { type: JS, file: 'static/app.js' },
  'pdf.js': { type: JS, file: 'static/pdf.js' },
  'favicon.svg': { type: 'image/svg+xml', file: 'static/favicon.svg' },
  'pdfmake.min.js': { type: JS, file: PDFMAKE + 'pdfmake.min.js' },
  'html-to-pdfmake.js': { type: JS, file: 'node_modules/html-to-pdfmake/browser.js' },
  'Roboto-Regular.ttf': { type: TTF, file: PDFMAKE + 'fonts/Roboto/Roboto-Regular.ttf' },
  'Roboto-Medium.ttf': { type: TTF, file: PDFMAKE + 'fonts/Roboto/Roboto-Medium.ttf' },
  'Roboto-Italic.ttf': { type: TTF, file: PDFMAKE + 'fonts/Roboto/Roboto-Italic.ttf' },
  'Roboto-MediumItalic.ttf': { type: TTF, file: PDFMAKE + 'fonts/Roboto/Roboto-MediumItalic.ttf' },
  'DejaVuSansMono.ttf': { type: TTF, file: DEJAVU + 'DejaVuSansMono.ttf' },
  'DejaVuSansMono-Bold.ttf': { type: TTF, file: DEJAVU + 'DejaVuSansMono-Bold.ttf' },
  'DejaVuSansMono-Oblique.ttf': { type: TTF, file: DEJAVU + 'DejaVuSansMono-Oblique.ttf' },
  'DejaVuSansMono-BoldOblique.ttf': { type: TTF, file: DEJAVU + 'DejaVuSansMono-BoldOblique.ttf' },
};

// Scripts and fonts that app.js loads when the user creates a PDF.
export function pdfAssets(): { scripts: string[]; fonts: Record<string, Record<string, string>> } {
  return {
    scripts: ['pdfmake.min.js', 'html-to-pdfmake.js', 'pdf.js'].map(staticUrl),
    fonts: {
      Roboto: {
        normal: staticUrl('Roboto-Regular.ttf'), bold: staticUrl('Roboto-Medium.ttf'),
        italics: staticUrl('Roboto-Italic.ttf'), bolditalics: staticUrl('Roboto-MediumItalic.ttf'),
      },
      Mono: {
        normal: staticUrl('DejaVuSansMono.ttf'), bold: staticUrl('DejaVuSansMono-Bold.ttf'),
        italics: staticUrl('DejaVuSansMono-Oblique.ttf'), bolditalics: staticUrl('DejaVuSansMono-BoldOblique.ttf'),
      },
    },
  };
}

const cache = new Map<string, Uint8Array>();

function staticFile(name: string): Uint8Array {
  let data = cache.get(name);
  if (!data) {
    data = readFileSync(new URL(`../../${STATIC_FILES[name].file}`, import.meta.url));
    cache.set(name, data);
  }
  return data;
}

const versions = new Map<string, string>();

// URL of a static file with a content hash, so that browsers fetch the
// new file right after a deployment instead of using a cached copy.
export function staticUrl(name: string): string {
  let v = versions.get(name);
  if (!v) {
    v = createHash('sha256').update(staticFile(name)).digest('hex').slice(0, 12);
    versions.set(name, v);
  }
  return `/static/${name}?v=${v}`;
}

// CSS variables derived from the branding settings, followed by the
// administrator's custom CSS. The dark background selectors mirror the
// dark theme rules in app.css, which this file overrides.
export function themeCss(b: Branding): string {
  const dark = `--bg:${b.darkBackground};--surface:${b.darkPanel};`;
  return `:root{--brand:${b.primaryColor};--accent:${b.accentColor};--bg:${b.lightBackground};--surface:${b.lightPanel};}\n`
    + `@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){${dark}}}\n`
    + `:root[data-theme="dark"]{${dark}}\n`
    + `${b.customCss}\n`;
}

export function registerStaticRoutes(app: Hono<AppEnv>, svc: Services): void {
  app.get('/static/:name', (c) => {
    const name = c.req.param('name');
    const entry = Object.hasOwn(STATIC_FILES, name) ? STATIC_FILES[name] : undefined;
    if (!entry) return c.notFound();
    const maxAge = svc.ctx.config.staticCacheSeconds;
    return c.body(staticFile(name) as Uint8Array<ArrayBuffer>, 200, { 'Content-Type': entry.type, 'Cache-Control': `public, max-age=${maxAge}` });
  });

  app.get('/branding/theme.css', async (c) => {
    const b = await svc.branding.get();
    return c.body(themeCss(b), 200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-cache' });
  });

  app.get('/branding/logo', async (c) => {
    const logo = await svc.branding.logo();
    if (!logo) return c.notFound();
    return c.body(logo.data as Uint8Array<ArrayBuffer>, 200, {
      'Content-Type': logo.type,
      'Cache-Control': 'no-cache',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
    });
  });

  app.get('/favicon.ico', (c) => c.redirect('/static/favicon.svg', 301));
}
