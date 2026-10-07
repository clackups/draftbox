import type { Page } from '../http/app.ts';
import type { AccessToken, Repo } from '../db/models.ts';
import { isExpired, tokenPermissions } from '../services/tokens.ts';
import { html, type Html } from './html.ts';
import { csrfField, formDayOrNever, localTime, tHtml } from './layout.ts';

function tokenScope(page: Page, token: AccessToken, repos: Map<string, Repo>): string {
  if (!token.repoId) return page.t('tokens.scope_all');
  return repos.get(token.repoId)?.name ?? page.t('tokens.scope_deleted');
}

// Asking for a one-time password is harmless unless it replaces the
// token value (old tokens) or a pending password.
function otpConfirm(page: Page, tok: AccessToken, now: number): Html {
  const { t } = page;
  if (!tok.encryptedValue) return html` data-confirm="${t('tokens.otp_confirm')}"`;
  if (tok.otp && Date.parse(tok.otp.expiresAt) > now) return html` data-confirm="${t('tokens.otp_replace_confirm')}"`;
  return html``;
}

// Hidden field telling the token routes to lead back to the settings of
// this repository instead of the token page.
export function returnRepoField(returnRepo: string | null): Html {
  return returnRepo ? html`<input type="hidden" name="returnRepo" value="${returnRepo}">` : html``;
}

export function tokenTable(page: Page, tokens: AccessToken[], repos: Map<string, Repo>, returnRepo: string | null = null): Html {
  const { t } = page;
  const now = Date.now();
  const back = returnRepoField(returnRepo);
  return html`<div class="table-wrap"><table>
  <thead><tr><th>${t('field.name')}</th><th>${t('tokens.scope')}</th><th>${t('tokens.access')}</th><th>${t('tokens.created')}</th><th>${t('tokens.expires')}</th><th></th></tr></thead>
  <tbody>${tokens.map((tok) => html`<tr class="${isExpired(tok, now) ? 'expired' : ''}">
    <td><strong>${tok.name}</strong>
      ${tok.otp && Date.parse(tok.otp.expiresAt) > now ? html`<br><span class="badge">${tHtml(page, 'tokens.otp_pending', { date: localTime(page, tok.otp.expiresAt) })}</span>` : ''}</td>
    <td>${tokenScope(page, tok, repos)}</td>
    <td>${tok.access === 'write' ? t('tokens.read_write') : t('tokens.read_only')}
      ${tokenPermissions(tok).map((p) => html`<br><span class="badge badge-warn">${t('tokens.perm_' + p)}</span>`)}</td>
    <td>${localTime(page, tok.createdAt)}</td>
    <td>${isExpired(tok, now) ? html`<span class="badge badge-warn">${t('tokens.expired')}</span>` : formDayOrNever(page, tok.expiresAt)}</td>
    <td class="actions">
      ${isExpired(tok, now) ? '' : html`<form method="post" action="/settings/tokens/${tok.id}/otp" class="inline"${otpConfirm(page, tok, now)}>${csrfField(page)}${back}<button class="btn btn-small btn-secondary">${t('tokens.new_otp')}</button></form>`}
      <form method="post" action="/settings/tokens/${tok.id}/revoke" class="inline" data-confirm="${t('tokens.revoke_confirm')}">${csrfField(page)}${back}<button class="btn btn-small btn-danger">${t('tokens.revoke')}</button></form>
    </td></tr>`)}</tbody></table></div>`;
}
