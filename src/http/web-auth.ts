import type { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { type AppEnv, type Ctx, type Services, formFields, isSecure, safeNext, setFlash } from './app.ts';
import { INVITE_COOKIE, LANG_COOKIE, OAUTH_COOKIE, SESSION_COOKIE, type SessionData, sign, unsign } from '../auth/session.ts';
import { newVerifier, type ProviderProfile } from '../auth/oauth.ts';
import { ServiceError } from '../services/context.ts';
import { isSupportedLanguage } from '../i18n/index.ts';
import { randomSecret } from '../util/crypto.ts';
import { html } from '../views/html.ts';
import { csrfField, errorPage, layout } from '../views/layout.ts';
import type { Page } from './app.ts';

interface OAuthState {
  p: string;
  s: string;
  v: string;
  n: string;
  iat: number;
}

const OAUTH_STATE_TTL_MS = 10 * 60_000;

function providerButtons(page: Page, svc: Services, next: string): ReturnType<typeof html> {
  const { t } = page;
  const q = next !== '/' ? `?next=${encodeURIComponent(next)}` : '';
  return html`<div class="providers">
    ${[...svc.providers.values()].map((p) => html`<a class="btn btn-provider" href="/auth/${p.id}/start${q}">${t('login.with', { provider: p.label })}</a>`)}
    ${page.devLogin ? html`<a class="btn btn-secondary" href="/auth/dev${q}">${t('login.dev')}</a>` : ''}
  </div>`;
}

function loginPage(page: Page, svc: Services, next: string, inviteValid: boolean | null): string {
  const { t } = page;
  const reg = svc.ctx.config.registration;
  let note = '';
  if (inviteValid === true) note = t('login.invite_ok');
  else if (inviteValid === false) note = t('login.invite_invalid');
  else if (!reg.open) note = t('login.registration_restricted');
  return layout(page, t('login.title'), html`<section class="card narrow">
  <h1>${t('login.title')}</h1>
  <p>${t('login.intro')}</p>
  ${note ? html`<p class="${inviteValid === false ? 'error' : 'muted'}">${note}</p>` : ''}
  ${svc.providers.size === 0 && !page.devLogin ? html`<p class="error">${t('login.no_providers')}</p>` : providerButtons(page, svc, next)}
</section>`);
}

function sessionCookie(svc: Services, data: SessionData): string {
  return sign(svc.ctx.config.sessionSecret, 'session', data);
}

async function completeLogin(c: Ctx, svc: Services, provider: string, profile: ProviderProfile, next: string): Promise<Response> {
  const cfg = svc.ctx.config;
  const email = profile.email.trim().toLowerCase();
  const isAdmin = cfg.admins.emails.includes(email);
  const inviteCode = getCookie(c, INVITE_COOKIE);
  let user;
  try {
    user = await svc.users.login({
      provider, subject: profile.subject, email, name: profile.name, isAdmin, inviteCode, language: c.var.page.lang,
    });
  } catch (err) {
    if (err instanceof ServiceError && (err.code === 'registration_not_allowed' || err.code === 'account_blocked')) {
      return c.html(errorPage(c.var.page, 403, 'error.' + err.code), 403);
    }
    throw err;
  }
  deleteCookie(c, INVITE_COOKIE, { path: '/' });
  const data: SessionData = { uid: user.id, epoch: user.sessionEpoch, provider, iat: Date.now() };
  setCookie(c, SESSION_COOKIE, sessionCookie(svc, data), {
    path: '/', httpOnly: true, sameSite: 'Lax', secure: isSecure(svc), maxAge: cfg.sessionMaxAgeDays * 86400,
  });
  setCookie(c, LANG_COOKIE, user.prefs.language, { path: '/', sameSite: 'Lax', secure: isSecure(svc), maxAge: 365 * 86400 });
  return c.redirect(safeNext(next));
}

export function registerAuthRoutes(app: Hono<AppEnv>, svc: Services): void {
  const cfg = svc.ctx.config;

  app.get('/login', async (c) => {
    if (c.var.page.user) return c.redirect('/');
    const code = getCookie(c, INVITE_COOKIE);
    const inviteValid = code ? await svc.invites.isUsable(code) : null;
    return c.html(loginPage(c.var.page, svc, safeNext(c.req.query('next')), inviteValid));
  });

  app.get('/invite/:code', async (c) => {
    const code = c.req.param('code');
    const valid = cfg.registration.invitations && (await svc.invites.isUsable(code));
    if (valid) {
      setCookie(c, INVITE_COOKIE, code, { path: '/', httpOnly: true, sameSite: 'Lax', secure: isSecure(svc), maxAge: 3600 });
    }
    if (c.var.page.user) return c.redirect('/');
    return c.html(loginPage(c.var.page, svc, '/', valid));
  });

  app.get('/auth/dev', (c) => {
    if (!c.var.page.devLogin) return c.notFound();
    const { t } = c.var.page;
    const next = safeNext(c.req.query('next'));
    return c.html(layout(c.var.page, t('login.dev'), html`<section class="card narrow">
  <h1>${t('login.dev')}</h1>
  <p class="warning">${t('login.dev_warning')}</p>
  <form method="post" action="/auth/dev" class="stack">
    ${csrfField(c.var.page)}
    <input type="hidden" name="next" value="${next}">
    <label>${t('field.email')}<input type="email" name="email" required autofocus></label>
    <label>${t('field.name')}<input type="text" name="name"></label>
    <button class="btn">${t('nav.login')}</button>
  </form>
</section>`));
  });

  app.post('/auth/dev', async (c) => {
    if (!c.var.page.devLogin) return c.notFound();
    const f = await formFields(c);
    const email = (f.email ?? '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new ServiceError('invalid_email');
    return completeLogin(c, svc, 'dev', { subject: email, email, name: f.name ?? '' }, f.next ?? '/');
  });

  app.get('/auth/:provider/start', async (c) => {
    const provider = svc.providers.get(c.req.param('provider'));
    if (!provider) return c.notFound();
    const state: OAuthState = {
      p: provider.id, s: randomSecret(16), v: newVerifier(), n: safeNext(c.req.query('next')), iat: Date.now(),
    };
    setCookie(c, OAUTH_COOKIE, sign(cfg.sessionSecret, 'oauth', state), {
      path: '/auth', httpOnly: true, sameSite: 'Lax', secure: isSecure(svc), maxAge: OAUTH_STATE_TTL_MS / 1000,
    });
    const redirectUri = `${cfg.baseUrl}/auth/${provider.id}/callback`;
    return c.redirect(await provider.authorizeUrl(redirectUri, state.s, state.v));
  });

  app.get('/auth/:provider/callback', async (c) => {
    const provider = svc.providers.get(c.req.param('provider'));
    if (!provider) return c.notFound();
    const state = unsign<OAuthState>(cfg.sessionSecret, 'oauth', getCookie(c, OAUTH_COOKIE));
    deleteCookie(c, OAUTH_COOKIE, { path: '/auth' });
    const code = c.req.query('code');
    if (!state || state.p !== provider.id || state.s !== c.req.query('state') || !code
      || Date.now() - state.iat > OAUTH_STATE_TTL_MS) {
      return c.html(errorPage(c.var.page, 400, 'error.oauth_failed'), 400);
    }
    let profile: ProviderProfile;
    try {
      profile = await provider.exchange(code, `${cfg.baseUrl}/auth/${provider.id}/callback`, state.v);
    } catch (err) {
      console.error(`OAuth login via ${provider.id} failed:`, (err as Error).message);
      return c.html(errorPage(c.var.page, 400, 'error.oauth_failed'), 400);
    }
    return completeLogin(c, svc, provider.id, profile, state.n);
  });

  app.post('/logout', (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.redirect('/');
  });

  app.get('/lang/:code', async (c) => {
    const lang = c.req.param('code');
    const next = safeNext(c.req.query('next'));
    if (!isSupportedLanguage(lang)) return c.redirect(next);
    setCookie(c, LANG_COOKIE, lang, { path: '/', sameSite: 'Lax', secure: isSecure(svc), maxAge: 365 * 86400 });
    const user = c.var.page.user;
    if (user && user.prefs.language !== lang) {
      await svc.users.updateProfile(user.id, { prefs: { language: lang } });
    }
    setFlash(c, 'ok', 'language_changed');
    return c.redirect(next);
  });
}
