import { rm } from 'node:fs/promises';
import type { Context } from './context.ts';
import { ServiceError } from './context.ts';
import type { ReadView, Tx } from '../db/store.ts';
import {
  type Branding, type Invitation, type Preregistration, type Repo, type User, type UserPrefs,
  contactEmailOf, DEFAULT_BRANDING, USER_THEMES,
} from '../db/models.ts';
import { randomId, randomSecret, sha256hex } from '../util/crypto.ts';
import { isSupportedLanguage, translator } from '../i18n/index.ts';
import { limitsForNewUser } from './limits.ts';

// Handles that would collide with top-level web routes.
const RESERVED_HANDLES = new Set([
  'admin', 'api', 'auth', 'login', 'logout', 'settings', 'new', 'explore',
  'static', 'invite', 'tokens', 'help', 'about', 'branding', 'favicon.ico',
  'robots.txt', 'draftbox', 'root', 'system', 'git', 'user', 'users', 'repos',
  'preview', 'lang', 'theme', 'verify-email',
]);

const SESSION_ID_RE = /^[0-9a-f]{32}$/;
// A handle given up by renaming or deleting an account cannot be taken
// by another account for this long, so that links and clone URLs do not
// silently lead to someone else's repositories.
export const HANDLE_RETENTION_DAYS = 180;

interface RetiredHandle {
  userId: string;
  until: string;
}

// Whether another account than userId holds a recent claim on the handle.
async function handleRetiredFor(view: ReadView, handle: string, userId: string | null): Promise<boolean> {
  const r = await view.get<RetiredHandle>(`retired-handles/${handle}.json`);
  return r !== null && r.userId !== userId && Date.parse(r.until) > Date.now();
}

function retireHandle(tx: Tx, handle: string, userId: string): void {
  const until = new Date(Date.now() + HANDLE_RETENTION_DAYS * 86400_000).toISOString();
  tx.put(`retired-handles/${handle}.json`, { userId, until } satisfies RetiredHandle);
}

export const HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;

export interface LoginRequest {
  provider: string;
  subject: string;
  email: string;
  name: string;
  isAdmin: boolean;
  inviteCode?: string;
  language?: string;
}

export const MAX_DESCRIPTION = 1000;
export const MAX_HOMEPAGE = 300;
const VERIFY_HOURS = 48;
const RESEND_SECONDS = 60;

// Deliberately loose: the address is proven by the verification email.
const EMAIL_RE = /^[^\s@<>()",;:\\]+@[^\s@<>()",;:\\]+\.[^\s@<>()",;:\\]+$/;

export function isValidEmail(email: string): boolean {
  return email.length <= 254 && EMAIL_RE.test(email);
}

// Returns the normalized homepage URL ('' clears it). A missing scheme
// is completed with https:// since users often type just the domain.
export function normalizeHomepage(input: string): string {
  let v = input.trim();
  if (!v) return '';
  if (!/^[a-z][a-z0-9+.-]*:/i.test(v)) v = 'https://' + v;
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    throw new ServiceError('invalid_homepage');
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || !url.hostname.includes('.') || url.username || url.password) {
    throw new ServiceError('invalid_homepage');
  }
  const out = url.href;
  if (out.length > MAX_HOMEPAGE) throw new ServiceError('invalid_homepage');
  return out;
}

export function normalizeDescription(input: string): string {
  const v = input.replace(/\r\n?/g, '\n').trim();
  if (v.length > MAX_DESCRIPTION) throw new ServiceError('description_too_long');
  if (/<[a-zA-Z\/!?]/.test(v)) throw new ServiceError('description_html');
  return v;
}

export type ContactEmailResult = 'unchanged' | 'updated' | 'verification_sent';

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function emailKey(email: string): string {
  return sha256hex(normalizeEmail(email));
}

export class UserService {
  private ctx: Context;

  constructor(ctx: Context) {
    this.ctx = ctx;
  }

  private get store() {
    return this.ctx.store;
  }

  async getById(id: string, view: ReadView = this.store.view()): Promise<User | null> {
    if (!/^[0-9a-f]{16}$/.test(id)) return null;
    return view.get<User>(`users/${id}.json`);
  }

  async getByEmail(email: string, view: ReadView = this.store.view()): Promise<User | null> {
    const id = await view.getText(`index/email/${emailKey(email)}`);
    return id ? this.getById(id, view) : null;
  }

  async getByHandle(handle: string, view: ReadView = this.store.view()): Promise<User | null> {
    const h = handle.toLowerCase();
    if (!HANDLE_RE.test(h)) return null;
    const id = await view.getText(`index/handle/${h}`);
    return id ? this.getById(id, view) : null;
  }

  async list(): Promise<User[]> {
    const view = this.store.view();
    const out: User[] = [];
    for (const name of await view.list('users')) {
      const u = await view.get<User>(`users/${name}`);
      if (u) out.push(u);
    }
    return out.sort((a, b) => a.email.localeCompare(b.email));
  }

  // Authenticates an OAuth login, registering a new account when the
  // configured registration policy allows it.
  async login(req: LoginRequest): Promise<User> {
    const email = normalizeEmail(req.email);
    if (!email.includes('@')) throw new ServiceError('invalid_email');
    const identityPath = `index/identity/${req.provider}/${sha256hex(req.subject)}`;

    return this.store.transact(`Login ${email} via ${req.provider}`, async (tx) => {
      let userId = await tx.getText(identityPath);
      if (!userId) userId = await tx.getText(`index/email/${emailKey(email)}`);
      let user = userId ? await tx.get<User>(`users/${userId}.json`) : null;

      if (user) {
        if (user.blocked) throw new ServiceError('account_blocked', 403);
        if (!user.identities.some((i) => i.provider === req.provider && i.subject === req.subject)) {
          user.identities.push({ provider: req.provider, subject: req.subject });
          tx.put(`users/${user.id}.json`, user);
          tx.putText(identityPath, user.id);
        }
        return user;
      }

      const reg = this.ctx.config.registration;
      // A pre-registration or an invitation also sets the limits of the
      // new account, even when registration is open to everyone.
      let invitation: Invitation | null = null;
      const prereg = reg.preregistration ? await tx.get<Preregistration>(`preregistrations/${emailKey(email)}.json`) : null;
      if (!prereg && reg.invitations && req.inviteCode) invitation = await findUsableInvitation(tx, req.inviteCode);
      if (!(req.isAdmin || reg.open || prereg || invitation)) throw new ServiceError('registration_not_allowed', 403);

      const id = randomId();
      const handle = await this.uniqueHandle(tx, email);
      const createdAt = this.ctx.now();
      user = {
        id,
        email,
        handle,
        name: req.name.trim() || email.split('@')[0],
        createdAt,
        blocked: false,
        identities: [{ provider: req.provider, subject: req.subject }],
        prefs: {
          language: req.language && isSupportedLanguage(req.language) ? req.language : this.ctx.config.defaultLanguage,
          advancedMode: false,
          theme: 'site',
        },
        sshKeys: [],
        sessionEpoch: 0,
        ...limitsForNewUser((prereg ?? invitation)?.limits, createdAt),
      };
      tx.put(`users/${id}.json`, user);
      tx.putText(`index/email/${emailKey(email)}`, id);
      tx.putText(`index/handle/${handle}`, id);
      tx.putText(identityPath, id);
      tx.delete(`preregistrations/${emailKey(email)}.json`);
      if (invitation) {
        invitation.usedBy = id;
        invitation.usedAt = this.ctx.now();
        tx.put(`invitations/${invitation.id}.json`, invitation);
      }
      return user;
    });
  }

  private async uniqueHandle(tx: Tx, email: string): Promise<string> {
    let base = email.split('@')[0].toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
    if (base.length < 2) base = 'user';
    if (RESERVED_HANDLES.has(base)) base = base + '-user';
    for (let i = 0; ; i++) {
      const candidate = i === 0 ? base : `${base}-${i + 1}`;
      if (!(await tx.getText(`index/handle/${candidate}`)) && !(await handleRetiredFor(tx, candidate, null))) return candidate;
    }
  }

  async updateProfile(userId: string, patch: {
    handle?: string; name?: string; description?: string; homepage?: string; prefs?: Partial<UserPrefs>;
  }): Promise<User> {
    const description = patch.description === undefined ? undefined : normalizeDescription(patch.description);
    const homepage = patch.homepage === undefined ? undefined : normalizeHomepage(patch.homepage);
    return this.store.transact(`Update profile of ${userId}`, async (tx) => {
      const user = await tx.get<User>(`users/${userId}.json`);
      if (!user) throw new ServiceError('not_found', 404);
      if (patch.handle !== undefined && patch.handle !== user.handle) {
        const h = patch.handle.trim().toLowerCase();
        if (!HANDLE_RE.test(h) || RESERVED_HANDLES.has(h)) throw new ServiceError('invalid_handle');
        if (await tx.getText(`index/handle/${h}`) || await handleRetiredFor(tx, h, user.id)) throw new ServiceError('handle_taken');
        tx.delete(`index/handle/${user.handle}`);
        retireHandle(tx, user.handle, user.id);
        tx.delete(`retired-handles/${h}.json`);
        tx.putText(`index/handle/${h}`, user.id);
        user.handle = h;
      }
      if (patch.name !== undefined) user.name = patch.name.trim().slice(0, 100) || user.name;
      if (description !== undefined) user.description = description;
      if (homepage !== undefined) user.homepage = homepage;
      if (patch.prefs) {
        const p = patch.prefs;
        if (p.language !== undefined && isSupportedLanguage(p.language)) user.prefs.language = p.language;
        if (p.advancedMode !== undefined) user.prefs.advancedMode = p.advancedMode;
        if (p.theme !== undefined && USER_THEMES.includes(p.theme)) user.prefs.theme = p.theme;
      }
      tx.put(`users/${user.id}.json`, user);
      return user;
    });
  }

  // Changes the contact address. The primary address is accepted at once;
  // any other address takes effect only after the user opens the link
  // emailed to it.
  async requestContactEmail(userId: string, input: string): Promise<ContactEmailResult> {
    const email = input.trim();
    if (!email) throw new ServiceError('contact_email_required');
    if (!isValidEmail(email)) throw new ServiceError('invalid_email');
    let code = '';
    const result = await this.store.transact(`Change contact email of ${userId}`, async (tx): Promise<ContactEmailResult> => {
      code = '';
      const user = await tx.get<User>(`users/${userId}.json`);
      if (!user) throw new ServiceError('not_found', 404);
      const same = (a: string, b: string) => normalizeEmail(a) === normalizeEmail(b);
      if (same(email, contactEmailOf(user)) && !user.pendingContactEmail) return 'unchanged';
      if (user.pendingContactEmail && same(email, user.pendingContactEmail.email)) return 'unchanged';
      if (same(email, user.email) || same(email, contactEmailOf(user))) {
        this.dropPending(tx, user);
        user.contactEmail = same(email, user.email) ? user.email : contactEmailOf(user);
        tx.put(`users/${user.id}.json`, user);
        return 'updated';
      }
      code = this.startVerification(tx, user, email);
      return 'verification_sent';
    });
    if (code) await this.sendVerification(userId, code);
    return result;
  }

  async resendContactVerification(userId: string): Promise<void> {
    const code = await this.store.transact(`Resend contact email verification for ${userId}`, async (tx) => {
      const user = await tx.get<User>(`users/${userId}.json`);
      if (!user) throw new ServiceError('not_found', 404);
      if (!user.pendingContactEmail) throw new ServiceError('no_pending_email');
      return this.startVerification(tx, user, user.pendingContactEmail.email);
    });
    await this.sendVerification(userId, code);
  }

  async cancelContactEmail(userId: string): Promise<void> {
    await this.store.transact(`Cancel contact email change of ${userId}`, async (tx) => {
      const user = await tx.get<User>(`users/${userId}.json`);
      if (!user) throw new ServiceError('not_found', 404);
      this.dropPending(tx, user);
      tx.put(`users/${user.id}.json`, user);
    });
  }

  // The user and the address a verification code confirms, or null when
  // the code is unknown, already used or expired.
  async findContactVerification(code: string, view: ReadView = this.store.view()): Promise<{ user: User; email: string } | null> {
    const id = await view.getText(`index/email-verify/${sha256hex(code)}`);
    const user = id ? await this.getById(id, view) : null;
    const p = user?.pendingContactEmail;
    if (!user || !p || p.codeHash !== sha256hex(code) || Date.parse(p.expiresAt) < Date.now()) return null;
    return { user, email: p.email };
  }

  async confirmContactEmail(code: string): Promise<User> {
    return this.store.transact('Verify contact email', async (tx) => {
      const found = await this.findContactVerification(code, tx);
      if (!found) throw new ServiceError('verification_invalid');
      const { user, email } = found;
      this.dropPending(tx, user);
      user.contactEmail = email;
      tx.put(`users/${user.id}.json`, user);
      return user;
    });
  }

  private startVerification(tx: Tx, user: User, email: string): string {
    const prev = user.pendingContactEmail;
    if (prev && Date.now() - Date.parse(prev.sentAt) < RESEND_SECONDS * 1000) throw new ServiceError('verification_too_soon');
    this.dropPending(tx, user);
    const code = randomSecret();
    const now = Date.now();
    user.pendingContactEmail = {
      email,
      codeHash: sha256hex(code),
      sentAt: new Date(now).toISOString(),
      expiresAt: new Date(now + VERIFY_HOURS * 3600 * 1000).toISOString(),
    };
    tx.putText(`index/email-verify/${user.pendingContactEmail.codeHash}`, user.id);
    tx.put(`users/${user.id}.json`, user);
    return code;
  }

  private dropPending(tx: Tx, user: User): void {
    if (user.pendingContactEmail) tx.delete(`index/email-verify/${user.pendingContactEmail.codeHash}`);
    delete user.pendingContactEmail;
  }

  private async sendVerification(userId: string, code: string): Promise<void> {
    const view = this.store.view();
    const user = await this.getById(userId, view);
    if (!user?.pendingContactEmail) return;
    const branding = { ...DEFAULT_BRANDING, ...(await view.get<Partial<Branding>>('settings/branding.json')) };
    const t = translator(user.prefs.language);
    const params = { site: branding.siteName, name: user.name, hours: VERIFY_HOURS, link: `${this.ctx.config.baseUrl}/verify-email/${code}` };
    try {
      await this.ctx.mailer.send({ to: user.pendingContactEmail.email, subject: t('email.verify_subject', params), text: t('email.verify_body', params) });
    } catch (err) {
      console.error('Sending verification email failed:', err);
      throw new ServiceError('mail_failed', 502);
    }
  }

  // Ends a web session before it expires. Records of sessions that have
  // expired meanwhile are dropped.
  async revokeSession(sid: string, expiresAt: number): Promise<void> {
    if (!SESSION_ID_RE.test(sid)) return;
    await this.store.transact('Revoke session', async (tx) => {
      const now = Date.now();
      for (const name of await tx.list('revoked-sessions')) {
        const until = await tx.getText(`revoked-sessions/${name}`);
        if (until !== null && Date.parse(until) <= now) tx.delete(`revoked-sessions/${name}`);
      }
      if (expiresAt > now) tx.putText(`revoked-sessions/${sid}`, new Date(expiresAt).toISOString());
    });
  }

  async isSessionRevoked(sid: string): Promise<boolean> {
    if (!SESSION_ID_RE.test(sid)) return true;
    return (await this.store.view().getText(`revoked-sessions/${sid}`)) !== null;
  }

  async setBlocked(userId: string, blocked: boolean, actor: string): Promise<User> {
    return this.store.transact(`${blocked ? 'Block' : 'Unblock'} user ${userId} by ${actor}`, async (tx) => {
      const user = await tx.get<User>(`users/${userId}.json`);
      if (!user) throw new ServiceError('not_found', 404);
      user.blocked = blocked;
      if (blocked) {
        user.blockedAt = this.ctx.now();
        user.sessionEpoch += 1;
      } else {
        delete user.blockedAt;
      }
      tx.put(`users/${user.id}.json`, user);
      return user;
    });
  }

  // Removes the account with all its repositories and tokens.
  async delete(userId: string, actor: string): Promise<void> {
    const repoIds: string[] = [];
    await this.store.transact(`Delete user ${userId} by ${actor}`, async (tx) => {
      repoIds.length = 0;
      const user = await tx.get<User>(`users/${userId}.json`);
      if (!user) throw new ServiceError('not_found', 404);
      for (const name of await tx.list(`index/repo/${userId}`)) {
        const repoId = await tx.getText(`index/repo/${userId}/${name}`);
        if (repoId) {
          repoIds.push(repoId);
          tx.delete(`repos/${repoId}.json`);
        }
      }
      await tx.deleteTree(`index/repo/${userId}`);
      for (const name of await tx.list('tokens')) {
        const tok = await tx.get<{ userId: string; otp?: { key: string } }>(`tokens/${name}`);
        if (tok && tok.userId === userId) {
          tx.delete(`tokens/${name}`);
          if (tok.otp) tx.delete(`index/otp/${tok.otp.key}`);
        }
      }
      for (const ident of user.identities) {
        tx.delete(`index/identity/${ident.provider}/${sha256hex(ident.subject)}`);
      }
      tx.delete(`index/email/${emailKey(user.email)}`);
      if (user.pendingContactEmail) tx.delete(`index/email-verify/${user.pendingContactEmail.codeHash}`);
      tx.delete(`index/handle/${user.handle}`);
      retireHandle(tx, user.handle, user.id);
      tx.delete(`users/${userId}.json`);
    });
    for (const id of repoIds) {
      await rm(this.ctx.repoPath(id), { recursive: true, force: true });
    }
  }

  async countRepos(userId: string): Promise<number> {
    return (await this.store.view().list(`index/repo/${userId}`)).length;
  }
}

export async function findUsableInvitation(view: ReadView, code: string): Promise<Invitation | null> {
  const id = await view.getText(`index/invite/${sha256hex(code)}`);
  if (!id) return null;
  const inv = await view.get<Invitation>(`invitations/${id}.json`);
  if (!inv || inv.usedBy) return null;
  if (inv.expiresAt && Date.parse(inv.expiresAt) < Date.now()) return null;
  return inv;
}

export type { Repo };
