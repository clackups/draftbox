import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Hono } from 'hono';
import type { AppEnv, Services } from './app.ts';
import type { Branding } from '../db/models.ts';

const STATIC_FILES: Record<string, string> = {
  'app.css': 'text/css; charset=utf-8',
  'app.js': 'text/javascript; charset=utf-8',
  'favicon.svg': 'image/svg+xml',
};

const cache = new Map<string, Uint8Array>();

function staticFile(name: string): Uint8Array {
  let data = cache.get(name);
  if (!data) {
    data = readFileSync(new URL(`../../static/${name}`, import.meta.url));
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
// administrator's custom CSS.
export function themeCss(b: Branding): string {
  return `:root{--brand:${b.primaryColor};--accent:${b.accentColor};}\n${b.customCss}\n`;
}

export function registerStaticRoutes(app: Hono<AppEnv>, svc: Services): void {
  app.get('/static/:name', (c) => {
    const name = c.req.param('name');
    const type = STATIC_FILES[name];
    if (!type) return c.notFound();
    const maxAge = svc.ctx.config.staticCacheSeconds;
    return c.body(staticFile(name) as Uint8Array<ArrayBuffer>, 200, { 'Content-Type': type, 'Cache-Control': `public, max-age=${maxAge}` });
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
