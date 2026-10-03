// OAuth 2.0 / OpenID Connect login providers. Every provider yields a
// stable subject identifier and a verified email address.

import { createHash } from 'node:crypto';
import type { Config, OAuthClientConfig, OidcProviderConfig } from '../config.ts';
import { randomSecret } from '../util/crypto.ts';

export interface ProviderProfile {
  subject: string;
  email: string;
  name: string;
}

export interface OAuthProvider {
  id: string;
  label: string;
  // Builds the authorization URL; state and verifier are kept in a cookie.
  authorizeUrl(redirectUri: string, state: string, verifier: string): Promise<string>;
  exchange(code: string, redirectUri: string, verifier: string): Promise<ProviderProfile>;
}

export class OAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OAuthError';
  }
}

export function newVerifier(): string {
  return randomSecret(32);
}

function challenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

async function postForm(url: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(params).toString(),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || json.error) throw new OAuthError(`token exchange failed: ${String(json.error ?? res.status)}`);
  return json;
}

async function getJson(url: string, accessToken: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', 'User-Agent': 'Draftbox' },
  });
  if (!res.ok) throw new OAuthError(`profile request failed: ${res.status}`);
  return res.json();
}

// Decodes the claims of an ID token received directly from the token
// endpoint over TLS; per OIDC Core 3.1.3.7 the TLS server validation may
// be used instead of checking the signature, but issuer and audience are
// still verified.
export function idTokenClaims(idToken: string, clientId: string, issuer?: string): Record<string, unknown> {
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new OAuthError('malformed ID token');
  }
  if (typeof claims !== 'object' || claims === null) throw new OAuthError('malformed ID token');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(clientId)) throw new OAuthError('ID token audience mismatch');
  const strip = (u: unknown): string => String(u).replace(/\/+$/, '');
  if (issuer !== undefined && strip(claims.iss) !== strip(issuer)) throw new OAuthError('ID token issuer mismatch');
  if (typeof claims.exp === 'number' && claims.exp * 1000 < Date.now()) throw new OAuthError('ID token expired');
  return claims;
}

interface OidcEndpoints {
  issuer?: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
}

class OidcProvider implements OAuthProvider {
  private endpoints: Promise<OidcEndpoints> | null = null;

  readonly id: string;
  readonly label: string;
  private client: OAuthClientConfig;
  private issuerOrEndpoints: string | OidcEndpoints;
  private scope: string;

  constructor(id: string, label: string, client: OAuthClientConfig, issuerOrEndpoints: string | OidcEndpoints,
    scope = 'openid email profile') {
    this.id = id;
    this.label = label;
    this.client = client;
    this.issuerOrEndpoints = issuerOrEndpoints;
    this.scope = scope;
  }

  private discover(): Promise<OidcEndpoints> {
    if (!this.endpoints) {
      const src = this.issuerOrEndpoints;
      this.endpoints = typeof src === 'string'
        ? fetch(src.replace(/\/+$/, '') + '/.well-known/openid-configuration').then((r) => {
          if (!r.ok) throw new OAuthError('OIDC discovery failed');
          return r.json() as Promise<OidcEndpoints>;
        })
        : Promise.resolve(src);
      this.endpoints.catch(() => { this.endpoints = null; });
    }
    return this.endpoints;
  }

  async authorizeUrl(redirectUri: string, state: string, verifier: string): Promise<string> {
    const ep = await this.discover();
    const u = new URL(ep.authorization_endpoint);
    u.search = new URLSearchParams({
      response_type: 'code',
      client_id: this.client.clientId,
      redirect_uri: redirectUri,
      scope: this.scope,
      state,
      code_challenge: challenge(verifier),
      code_challenge_method: 'S256',
      prompt: 'select_account',
    }).toString();
    return u.toString();
  }

  async exchange(code: string, redirectUri: string, verifier: string): Promise<ProviderProfile> {
    const ep = await this.discover();
    const tok = await postForm(ep.token_endpoint, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: this.client.clientId,
      client_secret: this.client.clientSecret,
      code_verifier: verifier,
    });
    const info = (await getJson(ep.userinfo_endpoint, String(tok.access_token))) as Record<string, unknown>;
    if (typeof info.sub !== 'string' || typeof info.email !== 'string') throw new OAuthError('incomplete profile');
    // Some providers (Gitea, Forgejo, e.g. Codeberg) put email_verified only
    // into the ID token, not into the userinfo response.
    let verified = info.email_verified;
    if (verified === undefined && typeof tok.id_token === 'string') {
      const claims = idTokenClaims(tok.id_token, this.client.clientId, ep.issuer);
      if (claims.sub === info.sub && claims.email === info.email) verified = claims.email_verified;
    }
    if (verified !== true && verified !== 'true') throw new OAuthError('email not verified');
    return { subject: info.sub, email: info.email, name: typeof info.name === 'string' ? info.name : '' };
  }
}

class GithubProvider implements OAuthProvider {
  readonly id = 'github';
  readonly label = 'GitHub';

  private client: OAuthClientConfig;

  constructor(client: OAuthClientConfig) {
    this.client = client;
  }

  async authorizeUrl(redirectUri: string, state: string, verifier: string): Promise<string> {
    const u = new URL('https://github.com/login/oauth/authorize');
    u.search = new URLSearchParams({
      client_id: this.client.clientId,
      redirect_uri: redirectUri,
      scope: 'read:user user:email',
      state,
      code_challenge: challenge(verifier),
      code_challenge_method: 'S256',
      allow_signup: 'true',
    }).toString();
    return u.toString();
  }

  async exchange(code: string, redirectUri: string, verifier: string): Promise<ProviderProfile> {
    const tok = await postForm('https://github.com/login/oauth/access_token', {
      code,
      redirect_uri: redirectUri,
      client_id: this.client.clientId,
      client_secret: this.client.clientSecret,
      code_verifier: verifier,
    });
    const access = String(tok.access_token);
    const user = (await getJson('https://api.github.com/user', access)) as { id: number; name?: string; login: string };
    const emails = (await getJson('https://api.github.com/user/emails', access)) as Array<{ email: string; primary: boolean; verified: boolean }>;
    const primary = emails.find((e) => e.primary && e.verified);
    if (!primary) throw new OAuthError('no verified primary email');
    return { subject: String(user.id), email: primary.email, name: user.name || user.login };
  }
}

export function buildProviders(cfg: Config): Map<string, OAuthProvider> {
  const out = new Map<string, OAuthProvider>();
  const o = cfg.oauth;
  if (o.google) {
    out.set('google', new OidcProvider('google', 'Google', o.google, {
      authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      token_endpoint: 'https://oauth2.googleapis.com/token',
      userinfo_endpoint: 'https://openidconnect.googleapis.com/v1/userinfo',
    }));
  }
  if (o.github) out.set('github', new GithubProvider(o.github));
  for (const [id, p] of Object.entries(o.oidc ?? {}) as Array<[string, OidcProviderConfig]>) {
    if (!/^[a-z0-9-]{1,30}$/.test(id) || id === 'dev' || out.has(id)) {
      throw new Error(`invalid OIDC provider id: ${id}`);
    }
    out.set(id, new OidcProvider(id, p.label, p, p.issuer));
  }
  return out;
}
