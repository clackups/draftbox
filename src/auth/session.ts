// Stateless signed cookies. Sessions are revoked by bumping the user's
// sessionEpoch (done when a user is blocked) or by expiry.

import { hmacB64, safeEqual } from '../util/crypto.ts';

export const SESSION_COOKIE = 'dbx_session';
export const OAUTH_COOKIE = 'dbx_oauth';
export const LANG_COOKIE = 'dbx_lang';
export const INVITE_COOKIE = 'dbx_invite';

export interface SessionData {
  uid: string;
  epoch: number;
  admin: boolean;
  provider: string;
  iat: number;
}

export function sign(secret: string, purpose: string, payload: unknown): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return body + '.' + hmacB64(secret, purpose + ':' + body);
}

export function unsign<T>(secret: string, purpose: string, value: string | undefined): T | null {
  if (!value) return null;
  const dot = value.lastIndexOf('.');
  if (dot < 0) return null;
  const body = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  if (!safeEqual(sig, hmacB64(secret, purpose + ':' + body))) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T;
  } catch {
    return null;
  }
}

export function csrfToken(secret: string, sessionCookie: string): string {
  return hmacB64(secret, 'csrf:' + sessionCookie).slice(0, 32);
}
