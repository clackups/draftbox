// Invitations, pre-registrations and branding.

import type { Context } from './context.ts';
import { ServiceError } from './context.ts';
import type { Branding, Invitation, Preregistration, Theme } from '../db/models.ts';
import { DEFAULT_BRANDING } from '../db/models.ts';
import { randomId, randomSecret, sha256hex } from '../util/crypto.ts';
import { emailKey, findUsableInvitation, normalizeEmail } from './users.ts';

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const LOGO_TYPES = new Set(['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp', 'image/gif']);
export const MAX_LOGO_BYTES = 512 * 1024;

export class InvitationService {
  private ctx: Context;

  constructor(ctx: Context) {
    this.ctx = ctx;
  }

  async create(createdBy: string, note: string, expiresDays: number | null): Promise<{ invitation: Invitation; code: string }> {
    const code = randomSecret(24);
    const now = Date.now();
    const invitation: Invitation = {
      id: randomId(),
      codeHash: sha256hex(code),
      createdBy,
      createdAt: new Date(now).toISOString(),
      expiresAt: expiresDays ? new Date(now + expiresDays * 86400_000).toISOString() : null,
      note: note.trim().slice(0, 200),
    };
    await this.ctx.store.transact(`Create invitation ${invitation.id}`, async (tx) => {
      tx.put(`invitations/${invitation.id}.json`, invitation);
      tx.putText(`index/invite/${invitation.codeHash}`, invitation.id);
    });
    return { invitation, code };
  }

  async list(): Promise<Invitation[]> {
    const view = this.ctx.store.view();
    const out: Invitation[] = [];
    for (const name of await view.list('invitations')) {
      const inv = await view.get<Invitation>(`invitations/${name}`);
      if (inv) out.push(inv);
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async revoke(id: string): Promise<void> {
    await this.ctx.store.transact(`Revoke invitation ${id}`, async (tx) => {
      const inv = await tx.get<Invitation>(`invitations/${id}.json`);
      if (!inv) throw new ServiceError('not_found', 404);
      tx.delete(`invitations/${id}.json`);
      tx.delete(`index/invite/${inv.codeHash}`);
    });
  }

  async isUsable(code: string): Promise<boolean> {
    return (await findUsableInvitation(this.ctx.store.view(), code)) !== null;
  }

  link(code: string): string {
    return `${this.ctx.config.baseUrl}/invite/${code}`;
  }
}

export class PreregistrationService {
  private ctx: Context;

  constructor(ctx: Context) {
    this.ctx = ctx;
  }

  async add(email: string, note: string): Promise<Preregistration> {
    const e = normalizeEmail(email);
    if (!/^[^\s@]+@[^\s@]+$/.test(e)) throw new ServiceError('invalid_email');
    const rec: Preregistration = { email: e, createdAt: this.ctx.now(), note: note.trim().slice(0, 200) };
    await this.ctx.store.transact(`Pre-register ${e}`, async (tx) => {
      tx.put(`preregistrations/${emailKey(e)}.json`, rec);
    });
    return rec;
  }

  async remove(email: string): Promise<boolean> {
    return this.ctx.store.transact(`Remove pre-registration ${normalizeEmail(email)}`, async (tx) => {
      const path = `preregistrations/${emailKey(email)}.json`;
      if (!(await tx.get(path))) return false;
      tx.delete(path);
      return true;
    });
  }

  async get(email: string): Promise<Preregistration | null> {
    return this.ctx.store.view().get<Preregistration>(`preregistrations/${emailKey(email)}.json`);
  }

  async list(): Promise<Preregistration[]> {
    const view = this.ctx.store.view();
    const out: Preregistration[] = [];
    for (const name of await view.list('preregistrations')) {
      const p = await view.get<Preregistration>(`preregistrations/${name}`);
      if (p) out.push(p);
    }
    return out.sort((a, b) => a.email.localeCompare(b.email));
  }
}

export class BrandingService {
  private cache: { head: string | null; value: Branding } | null = null;

  private ctx: Context;

  constructor(ctx: Context) {
    this.ctx = ctx;
  }

  async get(): Promise<Branding> {
    const head = this.ctx.store.head;
    if (this.cache && this.cache.head === head) return this.cache.value;
    const stored = await this.ctx.store.view().get<Partial<Branding>>('settings/branding.json');
    const value = { ...DEFAULT_BRANDING, ...stored };
    this.cache = { head, value };
    return value;
  }

  async update(patch: Partial<Pick<Branding, 'siteName' | 'primaryColor' | 'accentColor' | 'defaultTheme' | 'customCss' | 'footerText'>>, actor: string): Promise<Branding> {
    return this.ctx.store.transact(`Update branding by ${actor}`, async (tx) => {
      const cur = { ...DEFAULT_BRANDING, ...(await tx.get<Partial<Branding>>('settings/branding.json')) };
      if (patch.siteName !== undefined) cur.siteName = patch.siteName.trim().slice(0, 60) || DEFAULT_BRANDING.siteName;
      if (patch.primaryColor !== undefined) {
        if (!COLOR_RE.test(patch.primaryColor)) throw new ServiceError('invalid_color');
        cur.primaryColor = patch.primaryColor;
      }
      if (patch.accentColor !== undefined) {
        if (!COLOR_RE.test(patch.accentColor)) throw new ServiceError('invalid_color');
        cur.accentColor = patch.accentColor;
      }
      if (patch.defaultTheme !== undefined && (['auto', 'light', 'dark'] as Theme[]).includes(patch.defaultTheme)) {
        cur.defaultTheme = patch.defaultTheme;
      }
      if (patch.customCss !== undefined) cur.customCss = sanitizeCss(patch.customCss.slice(0, 20000));
      if (patch.footerText !== undefined) cur.footerText = patch.footerText.trim().slice(0, 300);
      tx.put('settings/branding.json', cur);
      return cur;
    });
  }

  async setLogo(data: Uint8Array | null, type: string | null, actor: string): Promise<void> {
    if (data) {
      if (!type || !LOGO_TYPES.has(type)) throw new ServiceError('invalid_logo');
      if (data.length > MAX_LOGO_BYTES) throw new ServiceError('logo_too_large');
    }
    await this.ctx.store.transact(`Update logo by ${actor}`, async (tx) => {
      const cur = { ...DEFAULT_BRANDING, ...(await tx.get<Partial<Branding>>('settings/branding.json')) };
      if (data && type) {
        tx.putRaw('settings/logo', data);
        cur.hasLogo = true;
        cur.logoType = type;
      } else {
        tx.delete('settings/logo');
        cur.hasLogo = false;
        delete cur.logoType;
      }
      tx.put('settings/branding.json', cur);
    });
  }

  async logo(): Promise<{ data: Uint8Array; type: string } | null> {
    const b = await this.get();
    if (!b.hasLogo || !b.logoType) return null;
    const data = await this.ctx.store.view().getRaw('settings/logo');
    return data ? { data, type: b.logoType } : null;
  }
}

// Custom CSS is inserted into a <style> element; prevent it from closing
// the element or pulling in remote resources.
export function sanitizeCss(css: string): string {
  return css.replace(/<\/?style/gi, '').replace(/<!--|-->/g, '').replace(/@import[^;]*;?/gi, '');
}
