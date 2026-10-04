import { Hono, type Context as HonoContext } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { bodyLimit } from 'hono/body-limit';
import type { Context } from '../services/context.ts';
import { ServiceError } from '../services/context.ts';
import { UserService } from '../services/users.ts';
import { RepoService } from '../services/repos.ts';
import { TokenService } from '../services/tokens.ts';
import { LimitService } from '../services/limits.ts';
import { BrandingService, InvitationService, PreregistrationService } from '../services/admin.ts';
import { buildProviders, type OAuthProvider } from '../auth/oauth.ts';
import { csrfToken, LANG_COOKIE, SESSION_COOKIE, type SessionData, unsign } from '../auth/session.ts';
import { DEFAULT_LANGUAGE, isSupportedLanguage, negotiateLanguage, translator, type Translator } from '../i18n/index.ts';
import type { Branding, Theme, User } from '../db/models.ts';
import { randomSecret } from '../util/crypto.ts';
import { errorPage } from '../views/layout.ts';
import { registerAuthRoutes } from './web-auth.ts';
import { registerSettingsRoutes } from './web-settings.ts';
import { registerAdminRoutes } from './web-admin.ts';
import { registerRepoRoutes } from './web-repo.ts';
import { registerApiRoutes } from './api.ts';
import { registerGitRoutes, isGitRequestPath } from './git.ts';
import { registerStaticRoutes } from './static.ts';

export interface Services {
  ctx: Context;
  users: UserService;
  repos: RepoService;
  tokens: TokenService;
  invites: InvitationService;
  prereg: PreregistrationService;
  branding: BrandingService;
  limits: LimitService;
  providers: Map<string, OAuthProvider>;
}

export interface Flash {
  kind: 'ok' | 'error';
  key: string;
}

export interface Page {
  t: Translator;
  lang: string;
  user: User | null;
  admin: boolean;
  csrf: string;
  branding: Branding;
  theme: Theme;
  path: string;
  flash: Flash | null;
  devLogin: boolean;
}

export type AppEnv = { Variables: { page: Page; svc: Services; session: SessionData | null } };
export type Ctx = HonoContext<AppEnv>;

const CSRF_COOKIE = 'dbx_csrf';
const FLASH_COOKIE = 'dbx_flash';
const MAX_FORM_BYTES = 20 * 1024 * 1024;

export function createServices(ctx: Context): Services {
  return {
    ctx,
    users: new UserService(ctx),
    repos: new RepoService(ctx),
    tokens: new TokenService(ctx),
    invites: new InvitationService(ctx),
    prereg: new PreregistrationService(ctx),
    branding: new BrandingService(ctx),
    limits: new LimitService(ctx),
    providers: buildProviders(ctx.config),
  };
}

export function isSecure(svc: Services): boolean {
  return svc.ctx.config.baseUrl.startsWith('https:');
}

export function setFlash(c: Ctx, kind: Flash['kind'], key: string): void {
  setCookie(c, FLASH_COOKIE, Buffer.from(JSON.stringify({ kind, key })).toString('base64url'), {
    path: '/', httpOnly: true, sameSite: 'Lax', secure: isSecure(c.var.svc), maxAge: 60,
  });
}

function readFlash(c: Ctx): Flash | null {
  const v = getCookie(c, FLASH_COOKIE);
  if (!v) return null;
  deleteCookie(c, FLASH_COOKIE, { path: '/' });
  try {
    const f = JSON.parse(Buffer.from(v, 'base64url').toString('utf8')) as Flash;
    if ((f.kind === 'ok' || f.kind === 'error') && /^[a-z0-9_.]+$/.test(f.key)) return f;
  } catch {
    // ignore malformed cookie
  }
  return null;
}

// Reads a submitted form as a map of string fields (first value wins).
// The body is always parsed with {all: true}: Hono caches the first parse,
// and multi-file uploads need every value.
export async function formFields(c: Ctx): Promise<Record<string, string>> {
  const body = await c.req.parseBody({ all: true });
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(body)) {
    const first = Array.isArray(v) ? v[0] : v;
    if (typeof first === 'string') out[k] = first;
  }
  return out;
}

export function createApp(svc: Services): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const cfg = svc.ctx.config;

  app.use('*', async (c, next) => {
    c.set('svc', svc);
    c.set('session', null);
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'same-origin');
    if ((c.res.headers.get('Content-Type') ?? '').startsWith('text/html')) {
      c.header('X-Frame-Options', 'DENY');
      c.header('Content-Security-Policy',
        "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    }
  });

  // Git smart HTTP and the JSON API carry their own authentication and
  // never rely on cookies.
  registerGitRoutes(app, svc);
  registerApiRoutes(app, svc);
  registerStaticRoutes(app, svc);

  app.use('*', bodyLimit({ maxSize: MAX_FORM_BYTES, onError: (c) => c.text('Payload too large', 413) }));

  app.use('*', async (c, next) => {
    let user: User | null = null;
    let admin = false;
    const raw = getCookie(c, SESSION_COOKIE);
    const session = unsign<SessionData>(cfg.sessionSecret, 'session', raw);
    // Sessions without an id predate logout revocation and are refused.
    if (session && typeof session.sid === 'string' && Date.now() - session.iat < cfg.sessionMaxAgeDays * 86400_000
      && !(await svc.users.isSessionRevoked(session.sid))) {
      const u = await svc.users.getById(session.uid);
      if (u && !u.blocked && u.sessionEpoch === session.epoch) {
        user = u;
        // Checked on every request, so that removing an address from
        // the configuration takes effect at once.
        admin = svc.limits.isAdminAccount(u);
        c.set('session', session);
      }
    }
    if (raw && !user) deleteCookie(c, SESSION_COOKIE, { path: '/' });

    let csrfSeed = getCookie(c, CSRF_COOKIE);
    if (!csrfSeed || csrfSeed.length < 20) {
      csrfSeed = randomSecret(18);
      setCookie(c, CSRF_COOKIE, csrfSeed, { path: '/', httpOnly: true, sameSite: 'Lax', secure: isSecure(svc) });
    }
    const csrf = csrfToken(cfg.sessionSecret, csrfSeed);

    const cookieLang = getCookie(c, LANG_COOKIE);
    const lang = user?.prefs.language
      ?? (cookieLang && isSupportedLanguage(cookieLang) ? cookieLang : null)
      ?? negotiateLanguage(c.req.header('Accept-Language'))
      ?? (isSupportedLanguage(cfg.defaultLanguage) ? cfg.defaultLanguage : DEFAULT_LANGUAGE);
    const branding = await svc.branding.get();

    c.set('page', {
      t: translator(lang),
      lang,
      user,
      admin,
      csrf,
      branding,
      theme: user && user.prefs.theme !== 'site' ? user.prefs.theme : branding.defaultTheme,
      path: c.req.path,
      flash: readFlash(c),
      devLogin: cfg.oauth.dev?.enabled === true,
    });

    if (c.req.method === 'POST' && !isGitRequestPath(c.req.path)) {
      const fields = await formFields(c).catch(() => ({} as Record<string, string>));
      const sent = fields._csrf ?? c.req.header('X-CSRF-Token');
      if (sent !== csrf) return c.html(errorPage(c.var.page, 403, 'error.csrf'), 403);
    }
    await next();
  });

  registerAuthRoutes(app, svc);
  registerSettingsRoutes(app, svc);
  registerAdminRoutes(app, svc);
  registerRepoRoutes(app, svc);

  app.notFound((c) => {
    const page = c.var.page;
    if (!page) return c.text('Not found', 404);
    return c.html(errorPage(page, 404, 'error.not_found'), 404);
  });

  app.onError((err, c) => {
    const page = c.var.page;
    if (err instanceof ServiceError) {
      if (!page) return c.json({ error: err.code }, err.status as 400);
      if (err.status === 401 && c.req.method === 'GET') {
        return c.redirect('/login?next=' + encodeURIComponent(c.req.path + (c.req.url.includes('?') ? '?' + c.req.url.split('?')[1] : '')));
      }
      return c.html(errorPage(page, err.status, 'error.' + err.code), err.status as 400);
    }
    console.error(err);
    if (!page) return c.text('Internal server error', 500);
    return c.html(errorPage(page, 500, 'error.internal'), 500);
  });

  return app;
}

export function requireUser(c: Ctx): User {
  const user = c.var.page.user;
  if (!user) throw new ServiceError('login_required', 401);
  return user;
}

export function requireAdmin(c: Ctx): User {
  const user = requireUser(c);
  if (!c.var.page.admin) throw new ServiceError('forbidden', 403);
  return user;
}

// Only local paths are accepted as post-login redirect targets. Browsers
// drop tabs and newlines from URLs and treat backslashes as slashes, so
// "/\t/evil.example" would lead to another site: control characters and
// backslashes are refused, and the normalized result must be a path on
// the same origin (dot segments can turn "/..//x" into "//x").
export function safeNext(next: string | undefined): string {
  if (!next || !next.startsWith('/') || /[\x00-\x1f\x7f\\]/.test(next)) return '/';
  let url: URL;
  try {
    url = new URL(next, 'http://draftbox.invalid');
  } catch {
    return '/';
  }
  const out = url.pathname + url.search + url.hash;
  if (url.origin !== 'http://draftbox.invalid' || out.startsWith('//')) return '/';
  return out;
}
