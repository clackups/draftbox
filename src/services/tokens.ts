import type { Context } from './context.ts';
import { ServiceError } from './context.ts';
import { TOKEN_PERMISSIONS, type AccessToken, type Repo, type TokenAccess, type TokenPermission, type User } from '../db/models.ts';
import { decrypt, encrypt, hmacHex, randomDigits, randomId, randomSecret, safeEqual, sha256hex } from '../util/crypto.ts';

export const VALIDITY_MONTHS = [1, 3, 6, 12] as const;
// How long a one-time password can be redeemed.
export const OTP_LIFETIME_DAYS = 7;

const TOKEN_RE = /^dbx_([0-9a-f]{16})_([A-Za-z0-9_-]{43})$/;

export interface CreateTokenOptions {
  name: string;
  repoId: string | null;
  access: TokenAccess;
  // Dangerous permissions; ignored for read-only tokens.
  allow?: TokenPermission[];
  validityMonths: number | null;
  withOtp: boolean;
}

export interface IssuedToken {
  token: AccessToken;
  // Set when a new token value was generated; it is shown to the user
  // once. Absent when only a one-time password was added.
  value?: string;
  otp?: string;
}

export interface TokenAuth {
  token: AccessToken;
  user: User;
}

function addMonths(from: Date, months: number): Date {
  const d = new Date(from.getTime());
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

export function isExpired(token: AccessToken, now = Date.now()): boolean {
  return token.expiresAt !== null && Date.parse(token.expiresAt) <= now;
}

export class TokenService {
  private ctx: Context;

  constructor(ctx: Context) {
    this.ctx = ctx;
  }

  private get store() {
    return this.ctx.store;
  }

  private otpKey(password: string): string {
    return hmacHex(this.ctx.config.encryptionKey, 'otp:' + password);
  }

  async listForUser(userId: string): Promise<AccessToken[]> {
    const view = this.store.view();
    const out: AccessToken[] = [];
    for (const name of await view.list('tokens')) {
      const t = await view.get<AccessToken>(`tokens/${name}`);
      if (t && t.userId === userId) out.push(t);
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async create(user: User, opts: CreateTokenOptions, repo: Repo | null): Promise<IssuedToken> {
    const name = opts.name.trim().slice(0, 100);
    if (!name) throw new ServiceError('token_name_required');
    if (opts.repoId !== null && (!repo || repo.id !== opts.repoId || repo.ownerId !== user.id)) {
      throw new ServiceError('not_found', 404);
    }
    if (opts.validityMonths !== null && !(VALIDITY_MONTHS as readonly number[]).includes(opts.validityMonths)) {
      throw new ServiceError('invalid_validity');
    }
    const access: TokenAccess = opts.access === 'read' ? 'read' : 'write';
    const allow = access === 'write' ? TOKEN_PERMISSIONS.filter((p) => opts.allow?.includes(p)) : [];
    const id = randomId();
    const secret = randomSecret();
    const value = `dbx_${id}_${secret}`;
    const now = new Date();
    const token: AccessToken = {
      id,
      userId: user.id,
      name,
      repoId: opts.repoId,
      access,
      ...(allow.length ? { allow } : {}),
      secretHash: sha256hex(secret),
      encryptedValue: encrypt(this.ctx.config.encryptionKey, value),
      createdAt: now.toISOString(),
      expiresAt: opts.validityMonths ? addMonths(now, opts.validityMonths).toISOString() : null,
    };
    let otp: string | undefined;
    await this.store.transact(`Create token ${id} for ${user.id}`, async (tx) => {
      if (opts.withOtp) otp = await this.attachOtp(tx, token, value);
      tx.put(`tokens/${id}.json`, token);
    });
    return { token, value, otp };
  }

  private async attachOtp(tx: import('../db/store.ts').Tx, token: AccessToken, value: string): Promise<string> {
    if (token.otp) tx.delete(`index/otp/${token.otp.key}`);
    for (;;) {
      const password = randomDigits(8);
      const key = this.otpKey(password);
      if (await tx.getText(`index/otp/${key}`)) continue;
      const now = new Date();
      token.otp = {
        key,
        encryptedToken: encrypt(this.ctx.config.encryptionKey, value),
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + OTP_LIFETIME_DAYS * 86400_000).toISOString(),
      };
      tx.putText(`index/otp/${key}`, token.id);
      return password;
    }
  }

  // Assigns a new one-time password to an existing token, replacing a
  // pending one. The token value stays the same. Tokens created before
  // values were kept encrypted cannot be recovered, so those are re-issued
  // with a new secret and the previous value stops working.
  async issueOtp(user: User, tokenId: string): Promise<IssuedToken> {
    let result: IssuedToken | null = null;
    await this.store.transact(`Issue one-time password for token ${tokenId}`, async (tx) => {
      const token = await tx.get<AccessToken>(`tokens/${tokenId}.json`);
      if (!token || token.userId !== user.id) throw new ServiceError('not_found', 404);
      if (isExpired(token)) throw new ServiceError('token_expired');
      let value: string | undefined;
      let current: string;
      if (token.encryptedValue) {
        current = decrypt(this.ctx.config.encryptionKey, token.encryptedValue);
      } else {
        const secret = randomSecret();
        value = current = `dbx_${token.id}_${secret}`;
        token.secretHash = sha256hex(secret);
        token.encryptedValue = encrypt(this.ctx.config.encryptionKey, value);
      }
      const otp = await this.attachOtp(tx, token, current);
      tx.put(`tokens/${token.id}.json`, token);
      result = { token, value, otp };
    });
    return result!;
  }

  async revoke(user: User, tokenId: string): Promise<void> {
    await this.store.transact(`Revoke token ${tokenId}`, async (tx) => {
      const token = await tx.get<AccessToken>(`tokens/${tokenId}.json`);
      if (!token || token.userId !== user.id) throw new ServiceError('not_found', 404);
      if (token.otp) tx.delete(`index/otp/${token.otp.key}`);
      tx.delete(`tokens/${tokenId}.json`);
    });
  }

  // Exchanges a one-time password for the token value. The password is
  // invalidated on success.
  async redeemOtp(password: string): Promise<{ value: string; token: AccessToken } | null> {
    if (!/^\d{8}$/.test(password)) return null;
    const key = this.otpKey(password);
    const view = this.store.view();
    if (!(await view.getText(`index/otp/${key}`))) return null;
    return this.store.transact('Redeem one-time password', async (tx) => {
      const tokenId = await tx.getText(`index/otp/${key}`);
      if (!tokenId) return null;
      tx.delete(`index/otp/${key}`);
      const token = await tx.get<AccessToken>(`tokens/${tokenId}.json`);
      if (!token || !token.otp || token.otp.key !== key) return null;
      const pending = token.otp;
      delete token.otp;
      tx.put(`tokens/${token.id}.json`, token);
      if (Date.parse(pending.expiresAt) < Date.now() || isExpired(token)) return null;
      const user = await tx.get<User>(`users/${token.userId}.json`);
      if (!user || user.blocked) return null;
      return { value: decrypt(this.ctx.config.encryptionKey, pending.encryptedToken), token };
    });
  }

  async authenticate(value: string): Promise<TokenAuth | null> {
    const m = TOKEN_RE.exec(value.trim());
    if (!m) return null;
    const view = this.store.view();
    const token = await view.get<AccessToken>(`tokens/${m[1]}.json`);
    if (!token || !safeEqual(token.secretHash, sha256hex(m[2])) || isExpired(token)) return null;
    const user = await view.get<User>(`users/${token.userId}.json`);
    if (!user || user.blocked) return null;
    return { token, user };
  }
}

// The dangerous permissions a token holds.
export function tokenPermissions(token: AccessToken): TokenPermission[] {
  if (token.access !== 'write') return [];
  return TOKEN_PERMISSIONS.filter((p) => token.allow?.includes(p));
}

// Whether a token grants the requested access to a repository.
export function tokenAllows(auth: TokenAuth, repo: Repo, write: boolean): boolean {
  if (auth.token.repoId !== null && auth.token.repoId !== repo.id) return false;
  if (write && auth.token.access !== 'write') return false;
  if (repo.ownerId === auth.user.id) return true;
  // Tokens of other users only grant read access to public repositories.
  return !write && repo.visibility === 'public' && auth.token.repoId === null;
}
