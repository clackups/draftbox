import type { Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import { type AppEnv, type Page, type Services, formFields, isSecure, requireUser, setFlash } from './app.ts';
import { LANG_COOKIE } from '../auth/session.ts';
import { LANGUAGES, languageName } from '../i18n/index.ts';
import { VALIDITY_MONTHS, OTP_LIFETIME_DAYS, isExpired, type IssuedToken } from '../services/tokens.ts';
import { type AccessToken, type Repo, type User, type UserTheme, contactEmailOf, USER_THEMES } from '../db/models.ts';
import { MAX_DESCRIPTION, isValidEmail } from '../services/users.ts';
import { html, type Html } from '../views/html.ts';
import { csrfField, formDayOrNever, formatDate, layout } from '../views/layout.ts';
import { ServiceError } from '../services/context.ts';

function settingsNav(page: Page, active: string): Html {
  const { t } = page;
  const item = (href: string, key: string) =>
    html`<a href="${href}" class="${active === href ? 'active' : ''}">${t(key)}</a>`;
  return html`<nav class="tabs">${item('/settings', 'settings.profile')}${item('/settings/tokens', 'nav.tokens')}</nav>`;
}

// `form` holds the submitted values when the page is shown again after a
// validation error, so that the user can correct them instead of
// retyping everything.
function profilePage(page: Page, user: User, error?: string, form?: Record<string, string>): string {
  const { t } = page;
  const pending = user.pendingContactEmail;
  const value = (key: string, saved: string) => form?.[key] ?? saved;
  const language = value('language', user.prefs.language);
  const theme = value('theme', user.prefs.theme);
  const advanced = form ? form.advancedMode === '1' : user.prefs.advancedMode;
  return layout(page, t('nav.settings'), html`<h1>${t('nav.settings')}</h1>
${settingsNav(page, '/settings')}
${error ? html`<p class="flash flash-error">${t('error.' + error)}</p>` : ''}
${pending ? html`<div class="warning stack">
  <span>${t('settings.contact_pending', { email: pending.email, current: contactEmailOf(user) })}</span>
  <div class="row">
    <form method="post" action="/settings/contact-email/resend" class="inline">${csrfField(page)}<button class="btn btn-small btn-secondary">${t('settings.contact_resend')}</button></form>
    <form method="post" action="/settings/contact-email/cancel" class="inline">${csrfField(page)}<button class="btn btn-small btn-secondary">${t('settings.contact_cancel')}</button></form>
  </div>
</div>` : ''}
<form method="post" action="/settings" class="card stack">
  ${csrfField(page)}
  <label>${t('field.email')}<input type="email" value="${user.email}" disabled>
    <small class="muted">${t('settings.primary_email_help')}</small></label>
  <label>${t('settings.contact_email')}<input type="email" name="contactEmail" value="${value('contactEmail', pending ? pending.email : contactEmailOf(user))}" required maxlength="254">
    <small class="muted">${t('settings.contact_email_help')}</small></label>
  <label>${t('field.name')}<input type="text" name="name" value="${value('name', user.name)}" maxlength="100"></label>
  <label>${t('field.handle')}<input type="text" name="handle" value="${value('handle', user.handle)}" pattern="[a-z0-9][a-z0-9\\-]{0,37}[a-z0-9]?" required>
    <small class="muted">${t('settings.handle_help')}</small></label>
  <label>${t('settings.description')}<textarea name="description" rows="4" maxlength="${MAX_DESCRIPTION}" class="short">${value('description', user.description ?? '')}</textarea>
    <small class="muted">${t('settings.description_help')}</small></label>
  <label>${t('settings.homepage')}<input type="text" name="homepage" value="${value('homepage', user.homepage ?? '')}" maxlength="300" inputmode="url" placeholder="https://">
    <small class="muted">${t('settings.homepage_help')}</small></label>
  <label>${t('field.language')}<select name="language">
    ${LANGUAGES.map((l) => html`<option value="${l}" ${l === language ? 'selected' : ''}>${languageName(l)}</option>`)}
  </select></label>
  <label>${t('field.theme')}<select name="theme">
    ${USER_THEMES.map((th) => html`<option value="${th}" ${th === theme ? 'selected' : ''}>${th === 'site'
      ? t('theme.site', { theme: t('theme.' + page.branding.defaultTheme) }) : t('theme.' + th)}</option>`)}
  </select></label>
  <label class="check"><input type="checkbox" name="advancedMode" value="1" ${advanced ? 'checked' : ''}>
    <span><strong>${t('settings.advanced_mode')}</strong><br><small class="muted">${t('settings.advanced_mode_help')}</small></span></label>
  <div><button class="btn">${t('action.save')}</button></div>
</form>`);
}

function verifyPage(page: Page, user: User, email: string, code: string): string {
  const { t } = page;
  return layout(page, t('verify.title'), html`<section class="card narrow stack">
  <h1>${t('verify.title')}</h1>
  <p>${t('verify.text', { email, handle: user.handle })}</p>
  <form method="post" action="/verify-email/${code}">${csrfField(page)}<button class="btn">${t('verify.confirm')}</button></form>
</section>`);
}

function tokenScope(page: Page, token: AccessToken, repos: Map<string, Repo>): string {
  if (!token.repoId) return page.t('tokens.scope_all');
  return repos.get(token.repoId)?.name ?? page.t('tokens.scope_deleted');
}

// The scope selector defaults to `selectedRepoId` (the most recently
// updated repository): a token limited to one repository is the safer
// choice for most users.
function tokensPage(page: Page, user: User, tokens: AccessToken[], repos: Repo[], selectedRepoId: string | null): string {
  const { t } = page;
  const repoMap = new Map(repos.map((r) => [r.id, r]));
  const now = Date.now();
  return layout(page, t('nav.tokens'), html`<h1>${t('nav.tokens')}</h1>
${settingsNav(page, '/settings/tokens')}
<p class="muted">${t('tokens.intro')}</p>
<section class="card">
<h2>${t('tokens.existing')}</h2>
${tokens.length === 0 ? html`<p class="muted">${t('tokens.none')}</p>` : html`<div class="table-wrap"><table>
  <thead><tr><th>${t('field.name')}</th><th>${t('tokens.scope')}</th><th>${t('tokens.access')}</th><th>${t('tokens.created')}</th><th>${t('tokens.expires')}</th><th></th></tr></thead>
  <tbody>${tokens.map((tok) => html`<tr class="${isExpired(tok, now) ? 'expired' : ''}">
    <td><strong>${tok.name}</strong>
      ${tok.otp && Date.parse(tok.otp.expiresAt) > now ? html`<br><span class="badge">${t('tokens.otp_pending', { date: formatDate(page, tok.otp.expiresAt) })}</span>` : ''}</td>
    <td>${tokenScope(page, tok, repoMap)}</td>
    <td>${tok.access === 'write' ? t('tokens.read_write') : t('tokens.read_only')}</td>
    <td>${formatDate(page, tok.createdAt)}</td>
    <td>${isExpired(tok, now) ? html`<span class="badge badge-warn">${t('tokens.expired')}</span>` : formDayOrNever(page, tok.expiresAt)}</td>
    <td class="actions">
      ${isExpired(tok, now) ? '' : html`<form method="post" action="/settings/tokens/${tok.id}/otp" class="inline"${otpConfirm(page, tok, now)}>${csrfField(page)}<button class="btn btn-small btn-secondary">${t('tokens.new_otp')}</button></form>`}
      <form method="post" action="/settings/tokens/${tok.id}/revoke" class="inline" data-confirm="${t('tokens.revoke_confirm')}">${csrfField(page)}<button class="btn btn-small btn-danger">${t('tokens.revoke')}</button></form>
    </td></tr>`)}</tbody></table></div>`}
</section>
<section class="card">
<h2>${t('tokens.create')}</h2>
<form method="post" action="/settings/tokens" class="stack">
  ${csrfField(page)}
  <label>${t('field.name')}<input type="text" name="name" required maxlength="100" placeholder="${t('tokens.name_placeholder')}"></label>
  <label>${t('tokens.scope')}<select name="repoId">
    <option value="">${t('tokens.scope_all')}</option>
    ${repos.map((r) => html`<option value="${r.id}"${r.id === selectedRepoId ? ' selected' : ''}>${t('tokens.scope_repo', { name: r.name })}</option>`)}
  </select></label>
  <fieldset><legend>${t('tokens.access')}</legend>
    <label class="check"><input type="radio" name="access" value="write" checked> ${t('tokens.read_write')}</label>
    <label class="check"><input type="radio" name="access" value="read"> ${t('tokens.read_only')}</label>
  </fieldset>
  <label>${t('tokens.validity')}<select name="validity">
    <option value="">${t('tokens.never_expires')}</option>
    ${VALIDITY_MONTHS.map((m) => html`<option value="${m}">${t('tokens.months', { n: m })}</option>`)}
  </select></label>
  <label class="check"><input type="checkbox" name="otp" value="1">
    <span><strong>${t('tokens.with_otp')}</strong><br><small class="muted">${t('tokens.otp_help', { days: OTP_LIFETIME_DAYS })}</small></span></label>
  <div><button class="btn">${t('tokens.create')}</button></div>
</form>
</section>`);
}

// Asking for a one-time password is harmless unless it replaces the
// token value (old tokens) or a pending password.
function otpConfirm(page: Page, tok: AccessToken, now: number): Html {
  const { t } = page;
  if (!tok.encryptedValue) return html` data-confirm="${t('tokens.otp_confirm')}"`;
  if (tok.otp && Date.parse(tok.otp.expiresAt) > now) return html` data-confirm="${t('tokens.otp_replace_confirm')}"`;
  return html``;
}

function issuedPage(page: Page, svc: Services, user: User, issued: IssuedToken, repo: Repo | null): string {
  const { t } = page;
  const base = svc.ctx.config.baseUrl;
  const advanced = user.prefs.advancedMode;
  const cloneUrl = repo ? `${base}/${user.handle}/${repo.name}.git` : `${base}/${user.handle}/REPOSITORY.git`;
  const title = issued.value ? t('tokens.issued_title') : t('tokens.otp_title', { name: issued.token.name });
  return layout(page, title, html`<h1>${title}</h1>
<section class="card">
  ${issued.value ? html`<p class="warning">${t('tokens.copy_now')}</p>
  <label>${t('tokens.token_value')}
    <div class="copyrow"><input type="text" readonly value="${issued.value}" class="mono" id="token-value"><button type="button" class="btn btn-small" data-copy="token-value">${t('action.copy')}</button></div></label>` : ''}
  ${issued.otp ? html`<div class="otp-box">
    <p>${t('tokens.otp_is')}</p>
    <p class="otp">${issued.otp.slice(0, 4)} ${issued.otp.slice(4)}</p>
    <p class="muted">${t('tokens.otp_explain', { date: formatDate(page, issued.token.otp?.expiresAt) })}</p>
    ${advanced ? html`<pre class="mono">curl -X POST -H 'Content-Type: application/json' \\
  -d '{"password":"${issued.otp}"}' ${base}/api/v1/token-exchange</pre>` : ''}
  </div>` : ''}
  ${issued.value ? html`<h2>${t('tokens.how_to_use')}</h2>
  ${advanced ? html`<p>${t('tokens.usage_git')}</p>
  <pre class="mono">git clone ${cloneUrl.replace('://', `://${user.handle}:TOKEN@`)}</pre>
  <p class="muted">${t('tokens.usage_password')}</p>` : html`<p>${t('tokens.usage_simple')}</p>`}` : ''}
  <p><a class="btn" href="/settings/tokens">${t('action.done')}</a></p>
</section>`);
}

export function registerSettingsRoutes(app: Hono<AppEnv>, svc: Services): void {
  app.get('/settings', (c) => {
    const user = requireUser(c);
    return c.html(profilePage(c.var.page, user));
  });

  app.post('/settings', async (c) => {
    const user = requireUser(c);
    const f = await formFields(c);
    let contact: Awaited<ReturnType<typeof svc.users.requestContactEmail>> = 'unchanged';
    try {
      // Fields missing from the form are left unchanged.
      const contactEmail = f.contactEmail === undefined ? undefined : f.contactEmail.trim();
      if (contactEmail === '') throw new ServiceError('contact_email_required');
      if (contactEmail !== undefined && !isValidEmail(contactEmail)) throw new ServiceError('invalid_email');
      const updated = await svc.users.updateProfile(user.id, {
        name: f.name,
        handle: f.handle,
        description: f.description,
        homepage: f.homepage,
        prefs: { language: f.language, theme: f.theme as UserTheme, advancedMode: f.advancedMode === '1' },
      });
      setCookie(c, LANG_COOKIE, updated.prefs.language, { path: '/', sameSite: 'Lax', secure: isSecure(svc), maxAge: 365 * 86400 });
      if (contactEmail !== undefined) contact = await svc.users.requestContactEmail(user.id, contactEmail);
    } catch (err) {
      if (err instanceof ServiceError && (err.status === 400 || err.code === 'mail_failed')) {
        const fresh = (await svc.users.getById(user.id)) ?? user;
        return c.html(profilePage(c.var.page, fresh, err.code, f), err.status as 400);
      }
      throw err;
    }
    setFlash(c, 'ok', contact === 'verification_sent' ? 'verification_sent' : 'settings_saved');
    return c.redirect('/settings');
  });

  app.post('/settings/contact-email/resend', async (c) => {
    const user = requireUser(c);
    try {
      await svc.users.resendContactVerification(user.id);
    } catch (err) {
      if (err instanceof ServiceError && (err.status === 400 || err.code === 'mail_failed')) {
        setFlash(c, 'error', 'error.' + err.code);
        return c.redirect('/settings');
      }
      throw err;
    }
    setFlash(c, 'ok', 'verification_sent');
    return c.redirect('/settings');
  });

  app.post('/settings/contact-email/cancel', async (c) => {
    const user = requireUser(c);
    await svc.users.cancelContactEmail(user.id);
    setFlash(c, 'ok', 'contact_change_cancelled');
    return c.redirect('/settings');
  });

  // The emailed link opens a confirmation page; the change is applied by
  // its POST so that mail scanners prefetching links do not verify it.
  app.get('/verify-email/:code', async (c) => {
    const found = await svc.users.findContactVerification(c.req.param('code'));
    if (!found) throw new ServiceError('verification_invalid');
    return c.html(verifyPage(c.var.page, found.user, found.email, c.req.param('code')));
  });

  app.post('/verify-email/:code', async (c) => {
    await svc.users.confirmContactEmail(c.req.param('code'));
    setFlash(c, 'ok', 'contact_verified');
    return c.redirect(c.var.page.user ? '/settings' : '/');
  });

  app.get('/settings/tokens', async (c) => {
    const user = requireUser(c);
    const [tokens, repos] = await Promise.all([svc.tokens.listForUser(user.id), svc.repos.listByOwner(user.id)]);
    const updated = await Promise.all(repos.map((r) => svc.repos.lastUpdated(r)));
    let newest = -1;
    for (let i = 0; i < repos.length; i++) if (newest < 0 || updated[i] > updated[newest]) newest = i;
    return c.html(tokensPage(c.var.page, user, tokens, repos, newest < 0 ? null : repos[newest].id));
  });

  app.post('/settings/tokens', async (c) => {
    const user = requireUser(c);
    const f = await formFields(c);
    const repoId = f.repoId ? f.repoId : null;
    const repo = repoId ? await svc.repos.getById(repoId) : null;
    const issued = await svc.tokens.create(user, {
      name: f.name ?? '',
      repoId,
      access: f.access === 'read' ? 'read' : 'write',
      validityMonths: f.validity ? Number(f.validity) : null,
      withOtp: f.otp === '1',
    }, repo);
    c.header('Cache-Control', 'no-store');
    return c.html(issuedPage(c.var.page, svc, user, issued, repo));
  });

  app.post('/settings/tokens/:id/revoke', async (c) => {
    const user = requireUser(c);
    await svc.tokens.revoke(user, c.req.param('id'));
    setFlash(c, 'ok', 'token_revoked');
    return c.redirect('/settings/tokens');
  });

  app.post('/settings/tokens/:id/otp', async (c) => {
    const user = requireUser(c);
    const issued = await svc.tokens.issueOtp(user, c.req.param('id'));
    const repo = issued.token.repoId ? await svc.repos.getById(issued.token.repoId) : null;
    c.header('Cache-Control', 'no-store');
    return c.html(issuedPage(c.var.page, svc, user, issued, repo));
  });
}
