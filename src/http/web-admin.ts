import type { Hono } from 'hono';
import { type AppEnv, type Page, type Services, formFields, requireAdmin, setFlash } from './app.ts';
import type { Branding, Invitation, LimitGrant, Preregistration, Theme, User } from '../db/models.ts';
import { html, type Html } from '../views/html.ts';
import { csrfField, formDayOrNever, layout, localTime, storageUsage } from '../views/layout.ts';
import { MAX_FOOTER, MAX_LANDING_TEXT, MAX_LOGO_BYTES, landingText } from '../services/admin.ts';
import { LANGUAGES, languageName } from '../i18n/index.ts';
import { parseLimitGrant, parseQuotaUpdate, parseUntilUpdate, type LimitStatus } from '../services/limits.ts';
import { ServiceError } from '../services/context.ts';

function adminNav(page: Page, active: string): Html {
  const { t } = page;
  const item = (href: string, key: string) =>
    html`<a href="${href}" class="${active === href ? 'active' : ''}">${t(key)}</a>`;
  return html`<h1>${t('nav.admin')}</h1><nav class="tabs">
    ${item('/admin/users', 'admin.users')}
    ${item('/admin/invitations', 'admin.invitations')}
    ${item('/admin/preregistrations', 'admin.preregistrations')}
    ${item('/admin/branding', 'admin.branding')}
  </nav>`;
}

// Quota and time limit inputs for invitations and pre-registrations.
function limitFields(page: Page, svc: Services): Html {
  const { t } = page;
  const d = svc.ctx.config.limits;
  return html`<label>${t('admin.storage_quota')}<input type="number" name="storageQuotaMb" min="0" step="1" placeholder="${d.storageQuotaMb ?? t('admin.unlimited')}"></label>
  <label>${t('admin.time_limit')}<input type="number" name="timeLimitDays" min="0" step="1" placeholder="${d.timeLimitDays ?? t('admin.unlimited')}"></label>`;
}

function limitsHelp(page: Page, svc: Services): Html {
  const { t } = page;
  const d = svc.ctx.config.limits;
  return html`<small class="muted">${t('admin.limits_help', {
    quota: d.storageQuotaMb === null ? t('admin.unlimited') : t('admin.mb', { n: d.storageQuotaMb }),
    days: d.timeLimitDays === null ? t('admin.unlimited') : t('admin.days', { n: d.timeLimitDays }),
  })}</small>`;
}

function grantText(page: Page, g: LimitGrant | undefined): string {
  const { t } = page;
  const quota = g?.storageQuotaMb === undefined ? t('admin.default') : g.storageQuotaMb === null ? t('admin.unlimited') : t('admin.mb', { n: g.storageQuotaMb });
  const days = g?.timeLimitDays === undefined ? t('admin.default') : g.timeLimitDays === null ? t('admin.unlimited') : t('admin.days', { n: g.timeLimitDays });
  return `${quota} / ${days}`;
}

function usersPage(page: Page, svc: Services, users: Array<{ user: User; repos: number; limits: LimitStatus }>): string {
  const { t } = page;
  const reg = svc.ctx.config.registration;
  const modes = [reg.open && t('admin.reg_open'), reg.invitations && t('admin.reg_invitations'), reg.preregistration && t('admin.reg_preregistration')]
    .filter(Boolean).join(', ') || t('admin.reg_closed');
  return layout(page, t('admin.users'), html`${adminNav(page, '/admin/users')}
<p class="muted">${t('admin.registration_modes', { modes })}</p>
<section class="card"><div class="table-wrap"><table class="users">
<thead><tr><th>${t('field.email')}</th><th>${t('field.handle')}</th><th>${t('field.name')}</th><th>${t('admin.registered')}</th><th>${t('admin.repos')}</th><th>${t('admin.storage')}</th><th>${t('admin.writable_until')}</th><th>${t('admin.status')}</th><th></th></tr></thead>
<tbody>${users.map(({ user: u, repos, limits }) => html`<tr class="${u.blocked ? 'blocked' : ''}">
  <td>${u.email}</td><td><a href="/${u.handle}">${u.handle}</a></td><td>${u.name}</td>
  <td>${localTime(page, u.createdAt, 'date')}</td><td>${repos}</td>
  <td class="${limits.blockedBy === 'quota_exceeded' ? 'text-danger' : ''}">${storageUsage(page, limits)}</td>
  <td class="${limits.blockedBy === 'time_limit_expired' ? 'text-danger' : ''}">${limits.writableUntil ? localTime(page, limits.writableUntil, 'date') : t('admin.unlimited')}</td>
  <td>${u.blocked ? html`<span class="badge badge-warn">${t('admin.blocked')}</span>` : html`<span class="badge">${t('admin.active')}</span>`}</td>
  <td class="actions"><a href="/admin/users/${u.id}/limits" class="btn btn-small btn-secondary">${t('admin.edit_limits')}</a>
    ${u.id === page.user?.id ? html`<span class="muted">${t('admin.you')}</span>` : html`
    <form method="post" action="/admin/users/${u.id}/${u.blocked ? 'unblock' : 'block'}" class="inline">${csrfField(page)}
      <button class="btn btn-small btn-secondary">${u.blocked ? t('admin.unblock') : t('admin.block')}</button></form>
    <form method="post" action="/admin/users/${u.id}/delete" class="inline" data-confirm="${t('admin.delete_confirm', { email: u.email })}">${csrfField(page)}
      <button class="btn btn-small btn-danger">${t('action.delete')}</button></form>`}</td>
</tr>`)}</tbody></table></div></section>`, { wide: true });
}

function userLimitsPage(page: Page, svc: Services, user: User, status: LimitStatus, error?: string): string {
  const { t } = page;
  const d = svc.ctx.config.limits;
  const quota = user.storageQuotaMb === undefined ? '' : user.storageQuotaMb === null ? '0' : String(user.storageQuotaMb);
  const until = typeof user.writableUntil === 'string' ? user.writableUntil.slice(0, 10) : '';
  return layout(page, t('admin.limits_title', { email: user.email }), html`${adminNav(page, '/admin/users')}
<h2>${t('admin.limits_title', { email: user.email })}</h2>
${error ? html`<p class="flash flash-error">${t('error.' + error)}</p>` : ''}
${status.admin ? html`<p class="warning">${t('admin.admin_unlimited')}</p>` : ''}
<section class="card stack">
  <p>${t('settings.storage_used')} <strong>${storageUsage(page, status)}</strong></p>
  <p>${t('admin.writable_until')}: <strong>${status.writableUntil ? localTime(page, status.writableUntil, 'date') : t('admin.unlimited')}</strong></p>
  ${status.blockedBy ? html`<p class="text-danger">${t('error.' + status.blockedBy)}</p>` : ''}
</section>
<section class="card"><form method="post" action="/admin/users/${user.id}/limits" class="stack">${csrfField(page)}
  <div class="row">
    <label>${t('admin.storage_quota')}<input type="number" name="storageQuotaMb" min="0" step="1" value="${quota}"
      placeholder="${d.storageQuotaMb ?? t('admin.unlimited')}"></label>
    <label>${t('admin.writable_until')}<input type="date" name="writableUntil" value="${until}"></label>
  </div>
  <label class="check"><input type="checkbox" name="noTimeLimit" value="1" ${user.writableUntil === null ? 'checked' : ''}> ${t('admin.no_time_limit')}</label>
  <small class="muted">${t('admin.user_limits_help', {
    quota: d.storageQuotaMb === null ? t('admin.unlimited') : t('admin.mb', { n: d.storageQuotaMb }),
    days: d.timeLimitDays === null ? t('admin.unlimited') : t('admin.days', { n: d.timeLimitDays }),
  })}</small>
  <div><button class="btn">${t('action.save')}</button> <a href="/admin/users" class="btn btn-secondary">${t('action.cancel')}</a></div>
</form></section>`);
}

function invitationsPage(page: Page, svc: Services, invites: Invitation[], users: Map<string, User>, newLink?: string): string {
  const { t } = page;
  const now = Date.now();
  const status = (inv: Invitation): Html => {
    if (inv.usedBy) return html`<span class="badge">${t('admin.invite_used', { who: users.get(inv.usedBy)?.email ?? '?' })}</span>`;
    if (inv.expiresAt && Date.parse(inv.expiresAt) < now) return html`<span class="badge badge-warn">${t('tokens.expired')}</span>`;
    return html`<span class="badge badge-ok">${t('admin.invite_open')}</span>`;
  };
  return layout(page, t('admin.invitations'), html`${adminNav(page, '/admin/invitations')}
${svc.ctx.config.registration.invitations ? '' : html`<p class="warning">${t('admin.invitations_disabled')}</p>`}
${newLink ? html`<section class="card highlight"><p>${t('admin.invite_created')}</p>
  <div class="copyrow"><input type="text" readonly value="${newLink}" class="mono" id="invite-link"><button type="button" class="btn btn-small" data-copy="invite-link">${t('action.copy')}</button></div></section>` : ''}
<section class="card"><h2>${t('admin.invite_create')}</h2>
<form method="post" action="/admin/invitations" class="stack">${csrfField(page)}
  <label>${t('admin.note')}<input type="text" name="note" maxlength="200" placeholder="${t('admin.note_placeholder')}"></label>
  <label>${t('admin.valid_for')}<select name="days">
    <option value="7">${t('admin.days', { n: 7 })}</option><option value="30" selected>${t('admin.days', { n: 30 })}</option>
    <option value="90">${t('admin.days', { n: 90 })}</option><option value="">${t('tokens.never_expires')}</option></select></label>
  <div class="row">${limitFields(page, svc)}</div>
  ${limitsHelp(page, svc)}
  <div><button class="btn">${t('admin.invite_create')}</button></div>
</form></section>
<section class="card"><div class="table-wrap"><table>
<thead><tr><th>${t('admin.note')}</th><th>${t('admin.limits')}</th><th>${t('tokens.created')}</th><th>${t('tokens.expires')}</th><th>${t('admin.status')}</th><th></th></tr></thead>
<tbody>${invites.map((inv) => html`<tr><td>${inv.note}</td><td>${grantText(page, inv.limits)}</td><td>${localTime(page, inv.createdAt)}</td>
  <td>${formDayOrNever(page, inv.expiresAt)}</td><td>${status(inv)}</td>
  <td class="actions"><form method="post" action="/admin/invitations/${inv.id}/revoke" class="inline">${csrfField(page)}
    <button class="btn btn-small btn-danger">${t('action.delete')}</button></form></td></tr>`)}</tbody></table></div></section>`);
}

function preregPage(page: Page, svc: Services, list: Preregistration[]): string {
  const { t } = page;
  return layout(page, t('admin.preregistrations'), html`${adminNav(page, '/admin/preregistrations')}
${svc.ctx.config.registration.preregistration ? '' : html`<p class="warning">${t('admin.prereg_disabled')}</p>`}
<p class="muted">${t('admin.prereg_intro')}</p>
<section class="card"><form method="post" action="/admin/preregistrations" class="stack">${csrfField(page)}
  <div class="row">
    <label>${t('field.email')}<input type="email" name="email" required></label>
    <label>${t('admin.note')}<input type="text" name="note" maxlength="200"></label>
  </div>
  <div class="row">${limitFields(page, svc)}</div>
  ${limitsHelp(page, svc)}
  <div><button class="btn">${t('action.add')}</button></div></form></section>
<section class="card"><div class="table-wrap"><table>
<thead><tr><th>${t('field.email')}</th><th>${t('admin.note')}</th><th>${t('admin.limits')}</th><th>${t('tokens.created')}</th><th></th></tr></thead>
<tbody>${list.map((p) => html`<tr><td>${p.email}</td><td>${p.note}</td><td>${grantText(page, p.limits)}</td><td>${localTime(page, p.createdAt)}</td>
  <td class="actions"><form method="post" action="/admin/preregistrations/remove" class="inline">${csrfField(page)}
    <input type="hidden" name="email" value="${p.email}"><button class="btn btn-small btn-danger">${t('action.delete')}</button></form></td></tr>`)}</tbody>
</table></div></section>`);
}

// A plain hex text field; app.js adds a swatch button that opens the
// modal color dialog. The browser's native color picker is avoided
// because it is a separate window that stays open while the user
// navigates away.
function colorField(name: string, value: string): Html {
  return html`<span class="color-field"><input type="text" name="${name}" value="${value}" required maxlength="7"
    pattern="#[0-9a-fA-F]{6}" class="mono" data-color-picker spellcheck="false" autocomplete="off"></span>`;
}

const COLOR_PRESETS = [
  '#2f6f4f', '#3a7d44', '#1f6f8b', '#2b5797', '#3f51b5', '#6a3d9a', '#8e44ad', '#b03a7a',
  '#b3372f', '#c0392b', '#c9822b', '#d35400', '#b7950b', '#7f8c3a', '#5d6d7e', '#34495e',
];

function colorDialog(page: Page): Html {
  const { t } = page;
  const slider = (part: string, max: number) =>
    html`<label>${t('admin.color_' + part)}<input type="range" min="0" max="${max}" data-part="${part}"></label>`;
  return html`<dialog class="color-dialog" aria-labelledby="color-dialog-title">
  <form method="dialog" class="stack">
    <h2 id="color-dialog-title">${t('admin.color_choose')}</h2>
    <div class="color-preview" data-part="preview"></div>
    <div class="color-presets">${COLOR_PRESETS.map((c) =>
      html`<button type="button" class="color-swatch" data-color="${c}" style="background:${c}" title="${c}" aria-label="${c}"></button>`)}</div>
    ${slider('hue', 360)}
    ${slider('saturation', 100)}
    ${slider('lightness', 100)}
    <label>${t('admin.color_hex')}<input type="text" maxlength="7" class="mono" data-part="hex" spellcheck="false" autocomplete="off"></label>
    <div class="row">
      <button type="submit" value="ok" class="btn">${t('action.done')}</button>
      <button type="submit" value="cancel" class="btn btn-secondary" formnovalidate>${t('action.cancel')}</button>
    </div>
  </form>
</dialog>`;
}

function brandingPage(page: Page, b: Branding): string {
  const { t } = page;
  const themes: Theme[] = ['auto', 'light', 'dark'];
  return layout(page, t('admin.branding'), html`${adminNav(page, '/admin/branding')}
<section class="card"><form method="post" action="/admin/branding" class="stack">${csrfField(page)}
  <label>${t('admin.site_name')}<input type="text" name="siteName" value="${b.siteName}" maxlength="60" required></label>
  <div class="row">
    <label>${t('admin.primary_color')}${colorField('primaryColor', b.primaryColor)}</label>
    <label>${t('admin.accent_color')}${colorField('accentColor', b.accentColor)}</label>
    <label>${t('admin.light_background')}${colorField('lightBackground', b.lightBackground)}</label>
    <label>${t('admin.dark_background')}${colorField('darkBackground', b.darkBackground)}</label>
    <label>${t('admin.light_panel')}${colorField('lightPanel', b.lightPanel)}</label>
    <label>${t('admin.dark_panel')}${colorField('darkPanel', b.darkPanel)}</label>
    <label>${t('admin.default_theme')}<select name="defaultTheme">
      ${themes.map((th) => html`<option value="${th}" ${th === b.defaultTheme ? 'selected' : ''}>${t('theme.' + th)}</option>`)}</select></label>
  </div>
  <label>${t('admin.footer_text')}<textarea name="footerText" rows="3" class="mono" maxlength="${MAX_FOOTER}">${b.footerText}</textarea>
    <small class="muted">${t('admin.footer_text_help')}</small></label>
  <fieldset><legend>${t('admin.landing_text')}</legend>
    <small class="muted">${t('admin.landing_text_help')}</small>
    ${LANGUAGES.map((l) => html`<label>${languageName(l)}<textarea name="landingText_${l}" rows="8" class="mono" lang="${l}" maxlength="${MAX_LANDING_TEXT}">${landingText(b, l)}</textarea></label>`)}
  </fieldset>
  <label>${t('admin.custom_css')}<textarea name="customCss" rows="8" class="mono">${b.customCss}</textarea>
    <small class="muted">${t('admin.custom_css_help')}</small></label>
  <div><button class="btn">${t('action.save')}</button></div>
</form></section>
${colorDialog(page)}
<section class="card"><h2>${t('admin.logo')}</h2>
  ${b.hasLogo ? html`<p><img src="/branding/logo" alt="" class="logo-preview"></p>` : html`<p class="muted">${t('admin.no_logo')}</p>`}
  <form method="post" action="/admin/branding/logo" enctype="multipart/form-data" class="row">${csrfField(page)}
    <input type="file" name="logo" accept="image/png,image/jpeg,image/svg+xml,image/webp,image/gif" required>
    <button class="btn">${t('action.upload')}</button></form>
  <p class="muted">${t('admin.logo_help', { kb: MAX_LOGO_BYTES / 1024 })}</p>
  ${b.hasLogo ? html`<form method="post" action="/admin/branding/logo/remove">${csrfField(page)}<button class="btn btn-small btn-danger">${t('action.remove')}</button></form>` : ''}
</section>
<section class="card danger stack"><h2>${t('admin.branding_reset')}</h2>
  <p class="muted">${t('admin.branding_reset_help')}</p>
  <form method="post" action="/admin/branding/reset" data-confirm="${t('admin.branding_reset_confirm')}">${csrfField(page)}
    <button class="btn btn-danger">${t('admin.branding_reset')}</button></form>
</section>`);
}

export function registerAdminRoutes(app: Hono<AppEnv>, svc: Services): void {
  app.use('/admin/*', async (c, next) => {
    requireAdmin(c);
    await next();
  });
  app.get('/admin', (c) => {
    requireAdmin(c);
    return c.redirect('/admin/users');
  });

  app.get('/admin/users', async (c) => {
    const users = await svc.users.list();
    const rows = await Promise.all(users.map(async (user) => ({
      user, repos: await svc.users.countRepos(user.id), limits: await svc.limits.status(user),
    })));
    return c.html(usersPage(c.var.page, svc, rows));
  });

  const userOr404 = async (id: string): Promise<User> => {
    const user = await svc.users.getById(id);
    if (!user) throw new ServiceError('not_found', 404);
    return user;
  };

  app.get('/admin/users/:id/limits', async (c) => {
    const user = await userOr404(c.req.param('id'));
    return c.html(userLimitsPage(c.var.page, svc, user, await svc.limits.status(user)));
  });

  // Registered before the generic action route below.
  app.post('/admin/users/:id/limits', async (c) => {
    const admin = requireAdmin(c);
    const user = await userOr404(c.req.param('id'));
    const f = await formFields(c);
    try {
      await svc.limits.update(user.id, {
        storageQuotaMb: parseQuotaUpdate(f.storageQuotaMb ?? ''),
        writableUntil: f.noTimeLimit === '1' ? null : parseUntilUpdate(f.writableUntil ?? ''),
      }, admin.email);
    } catch (err) {
      if (err instanceof ServiceError && err.status === 400) {
        return c.html(userLimitsPage(c.var.page, svc, user, await svc.limits.status(user), err.code), 400);
      }
      throw err;
    }
    setFlash(c, 'ok', 'limits_saved');
    return c.redirect('/admin/users');
  });

  app.post('/admin/users/:id/:action', async (c) => {
    const admin = requireAdmin(c);
    const id = c.req.param('id');
    if (id === admin.id) throw new ServiceError('forbidden', 403);
    const action = c.req.param('action');
    if (action === 'block' || action === 'unblock') {
      await svc.users.setBlocked(id, action === 'block', admin.email);
      setFlash(c, 'ok', action === 'block' ? 'user_blocked' : 'user_unblocked');
    } else if (action === 'delete') {
      await svc.users.delete(id, admin.email);
      setFlash(c, 'ok', 'user_deleted');
    } else {
      return c.notFound();
    }
    return c.redirect('/admin/users');
  });

  const renderInvites = async (page: Page, newLink?: string) => {
    const [invites, users] = await Promise.all([svc.invites.list(), svc.users.list()]);
    return invitationsPage(page, svc, invites, new Map(users.map((u) => [u.id, u])), newLink);
  };

  app.get('/admin/invitations', async (c) => c.html(await renderInvites(c.var.page)));

  app.post('/admin/invitations', async (c) => {
    const admin = requireAdmin(c);
    const f = await formFields(c);
    const days = Number(f.days);
    const limits = parseLimitGrant(f.storageQuotaMb, f.timeLimitDays);
    const { code } = await svc.invites.create(admin.id, f.note ?? '', days > 0 ? days : null, limits);
    c.header('Cache-Control', 'no-store');
    return c.html(await renderInvites(c.var.page, svc.invites.link(code)));
  });

  app.post('/admin/invitations/:id/revoke', async (c) => {
    await svc.invites.revoke(c.req.param('id'));
    setFlash(c, 'ok', 'invitation_deleted');
    return c.redirect('/admin/invitations');
  });

  app.get('/admin/preregistrations', async (c) => c.html(preregPage(c.var.page, svc, await svc.prereg.list())));

  app.post('/admin/preregistrations', async (c) => {
    const f = await formFields(c);
    await svc.prereg.add(f.email ?? '', f.note ?? '', parseLimitGrant(f.storageQuotaMb, f.timeLimitDays));
    setFlash(c, 'ok', 'preregistration_added');
    return c.redirect('/admin/preregistrations');
  });

  app.post('/admin/preregistrations/remove', async (c) => {
    const f = await formFields(c);
    await svc.prereg.remove(f.email ?? '');
    setFlash(c, 'ok', 'preregistration_removed');
    return c.redirect('/admin/preregistrations');
  });

  app.get('/admin/branding', async (c) => c.html(brandingPage(c.var.page, await svc.branding.get())));

  app.post('/admin/branding', async (c) => {
    const admin = requireAdmin(c);
    const f = await formFields(c);
    await svc.branding.update({
      siteName: f.siteName,
      primaryColor: f.primaryColor,
      accentColor: f.accentColor,
      lightBackground: f.lightBackground,
      darkBackground: f.darkBackground,
      lightPanel: f.lightPanel,
      darkPanel: f.darkPanel,
      defaultTheme: f.defaultTheme as Theme,
      footerText: f.footerText,
      landingText: Object.fromEntries(LANGUAGES.flatMap((l) => {
        const text = f['landingText_' + l];
        return text === undefined ? [] : [[l, text]];
      })),
      customCss: f.customCss,
    }, admin.email);
    setFlash(c, 'ok', 'branding_saved');
    return c.redirect('/admin/branding');
  });

  app.post('/admin/branding/logo', async (c) => {
    const admin = requireAdmin(c);
    const body = await c.req.parseBody({ all: true });
    const file = Array.isArray(body.logo) ? body.logo[0] : body.logo;
    if (!(file instanceof File)) throw new ServiceError('invalid_logo');
    await svc.branding.setLogo(new Uint8Array(await file.arrayBuffer()), file.type, admin.email);
    setFlash(c, 'ok', 'branding_saved');
    return c.redirect('/admin/branding');
  });

  app.post('/admin/branding/reset', async (c) => {
    const admin = requireAdmin(c);
    await svc.branding.reset(admin.email);
    setFlash(c, 'ok', 'branding_reset');
    return c.redirect('/admin/branding');
  });

  app.post('/admin/branding/logo/remove', async (c) => {
    const admin = requireAdmin(c);
    await svc.branding.setLogo(null, null, admin.email);
    setFlash(c, 'ok', 'branding_saved');
    return c.redirect('/admin/branding');
  });
}
