import { rm } from 'node:fs/promises';
import type { Context } from './context.ts';
import { ServiceError } from './context.ts';
import type { ReadView, Tx } from '../db/store.ts';
import { type Invitation, type Preregistration, type Repo, type User, type UserPrefs, USER_THEMES } from '../db/models.ts';
import { randomId, sha256hex } from '../util/crypto.ts';
import { isSupportedLanguage } from '../i18n/index.ts';

// Handles that would collide with top-level web routes.
const RESERVED_HANDLES = new Set([
  'admin', 'api', 'auth', 'login', 'logout', 'settings', 'new', 'explore',
  'static', 'invite', 'tokens', 'help', 'about', 'branding', 'favicon.ico',
  'robots.txt', 'draftbox', 'root', 'system', 'git', 'user', 'users', 'repos',
  'preview', 'lang', 'theme',
]);

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
      let invitation: Invitation | null = null;
      let allowed = req.isAdmin || reg.open;
      if (!allowed && reg.preregistration) {
        allowed = (await tx.get<Preregistration>(`preregistrations/${emailKey(email)}.json`)) !== null;
      }
      if (!allowed && reg.invitations && req.inviteCode) {
        invitation = await findUsableInvitation(tx, req.inviteCode);
        allowed = invitation !== null;
      }
      if (!allowed) throw new ServiceError('registration_not_allowed', 403);

      const id = randomId();
      const handle = await this.uniqueHandle(tx, email);
      user = {
        id,
        email,
        handle,
        name: req.name.trim() || email.split('@')[0],
        createdAt: this.ctx.now(),
        blocked: false,
        identities: [{ provider: req.provider, subject: req.subject }],
        prefs: {
          language: req.language && isSupportedLanguage(req.language) ? req.language : this.ctx.config.defaultLanguage,
          advancedMode: false,
          theme: 'site',
        },
        sshKeys: [],
        sessionEpoch: 0,
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
      if (!(await tx.getText(`index/handle/${candidate}`))) return candidate;
    }
  }

  async updateProfile(userId: string, patch: { handle?: string; name?: string; prefs?: Partial<UserPrefs> }): Promise<User> {
    return this.store.transact(`Update profile of ${userId}`, async (tx) => {
      const user = await tx.get<User>(`users/${userId}.json`);
      if (!user) throw new ServiceError('not_found', 404);
      if (patch.handle !== undefined && patch.handle !== user.handle) {
        const h = patch.handle.trim().toLowerCase();
        if (!HANDLE_RE.test(h) || RESERVED_HANDLES.has(h)) throw new ServiceError('invalid_handle');
        if (await tx.getText(`index/handle/${h}`)) throw new ServiceError('handle_taken');
        tx.delete(`index/handle/${user.handle}`);
        tx.putText(`index/handle/${h}`, user.id);
        user.handle = h;
      }
      if (patch.name !== undefined) user.name = patch.name.trim().slice(0, 100) || user.name;
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
      tx.delete(`index/handle/${user.handle}`);
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
