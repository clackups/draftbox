// Backend configuration. Loaded from a JSON file (path in DRAFTBOX_CONFIG,
// default ./draftbox.config.json); secrets may be overridden by environment
// variables so that they do not need to be stored in the file.

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

export interface OAuthClientConfig {
  clientId: string;
  clientSecret: string;
}

export interface OidcProviderConfig extends OAuthClientConfig {
  // Display name on the login page.
  label: string;
  // Issuer base URL; /.well-known/openid-configuration is fetched from it.
  issuer: string;
}

export interface MailConfig {
  // 'log' writes messages to the server log instead of sending them.
  transport: 'smtp' | 'sendmail' | 'log';
  // Sender address, e.g. "Draftbox <noreply@example.com>".
  from: string;
  smtp?: { host: string; port?: number; secure?: boolean; user?: string; password?: string };
  sendmailPath?: string;
}

export interface Config {
  // Public URL of the service, without trailing slash. Used for OAuth
  // redirect URIs and links shown to users.
  baseUrl: string;
  host: string;
  port: number;
  // Directory holding the metadata repository and user repositories.
  dataDir: string;
  // Secret used to sign session cookies and CSRF tokens.
  sessionSecret: string;
  // Secret used to encrypt token values pending one-time password exchange.
  encryptionKey: string;
  // Path to the git executable, used for the Git smart HTTP protocol.
  gitBinary: string;

  registration: {
    // Anyone who authenticates via OAuth gets an account.
    open: boolean;
    // Invitation links created by administrators allow registration.
    invitations: boolean;
    // Email addresses registered through the admin API may register.
    preregistration: boolean;
  };

  oauth: {
    google?: OAuthClientConfig;
    github?: OAuthClientConfig;
    oidc?: Record<string, OidcProviderConfig>;
    // Development-only provider that trusts any typed email address.
    // Never enable in production.
    dev?: { enabled: boolean };
  };

  // Administrator accounts. Every configured OAuth provider is trusted to
  // assert the email address, so an address here is enough.
  admins: {
    emails: string[];
  };

  // Bearer keys accepted by the administrative API (/api/admin/...).
  adminApiKeys: string[];

  // Outgoing email (contact address verification).
  mail: MailConfig;

  defaultLanguage: string;
  sessionMaxAgeDays: number;
  // Take client addresses from X-Forwarded-For (set behind one reverse
  // proxy, which must append the address it sees to that header).
  trustProxy: boolean;
  // Browser cache lifetime of static files (app.js, app.css, ...), seconds.
  staticCacheSeconds: number;

  // Defaults for user accounts; invitations and pre-registrations may
  // set other values. null means unlimited.
  limits: {
    // Total size of the user's repositories on disk.
    storageQuotaMb: number | null;
    // Days after registration during which the account may write.
    timeLimitDays: number | null;
  };
}

const DEFAULTS: Config = {
  baseUrl: 'http://localhost:8080',
  host: '127.0.0.1',
  port: 8080,
  dataDir: './data',
  sessionSecret: '',
  encryptionKey: '',
  gitBinary: 'git',
  registration: { open: false, invitations: true, preregistration: true },
  oauth: {},
  admins: { emails: [] },
  adminApiKeys: [],
  mail: { transport: 'log', from: 'Draftbox <noreply@localhost>' },
  defaultLanguage: 'en',
  sessionMaxAgeDays: 30,
  trustProxy: false,
  staticCacheSeconds: 60,
  limits: { storageQuotaMb: 100, timeLimitDays: null },
};

export function loadConfig(path?: string): Config {
  const file = resolve(path ?? process.env.DRAFTBOX_CONFIG ?? 'draftbox.config.json');
  let fromFile: Partial<Config> = {};
  if (existsSync(file)) {
    fromFile = JSON.parse(readFileSync(file, 'utf8')) as Partial<Config>;
  }
  return finalizeConfig(fromFile, process.env);
}

export function finalizeConfig(partial: Partial<Config>, env: Record<string, string | undefined> = {}): Config {
  const cfg: Config = {
    ...DEFAULTS,
    ...partial,
    registration: { ...DEFAULTS.registration, ...partial.registration },
    oauth: { ...partial.oauth },
    admins: { ...DEFAULTS.admins, ...partial.admins },
    mail: { ...DEFAULTS.mail, ...partial.mail },
    limits: { ...DEFAULTS.limits, ...partial.limits },
  };
  if (env.DRAFTBOX_SESSION_SECRET) cfg.sessionSecret = env.DRAFTBOX_SESSION_SECRET;
  if (env.DRAFTBOX_ENCRYPTION_KEY) cfg.encryptionKey = env.DRAFTBOX_ENCRYPTION_KEY;
  if (env.DRAFTBOX_ADMIN_API_KEYS) cfg.adminApiKeys = env.DRAFTBOX_ADMIN_API_KEYS.split(',').map((s) => s.trim()).filter(Boolean);
  if (env.DRAFTBOX_PORT) cfg.port = Number(env.DRAFTBOX_PORT);
  if (env.DRAFTBOX_DATA_DIR) cfg.dataDir = env.DRAFTBOX_DATA_DIR;
  if (env.DRAFTBOX_BASE_URL) cfg.baseUrl = env.DRAFTBOX_BASE_URL;
  if (env.DRAFTBOX_SMTP_PASSWORD && cfg.mail.smtp) cfg.mail.smtp = { ...cfg.mail.smtp, password: env.DRAFTBOX_SMTP_PASSWORD };

  if (!Number.isFinite(cfg.staticCacheSeconds) || cfg.staticCacheSeconds < 0) {
    throw new Error('staticCacheSeconds must be a non-negative number');
  }
  cfg.staticCacheSeconds = Math.floor(cfg.staticCacheSeconds);
  for (const key of ['storageQuotaMb', 'timeLimitDays'] as const) {
    const v = cfg.limits[key];
    if (v !== null && !(Number.isFinite(v) && v > 0)) throw new Error(`limits.${key} must be a positive number or null`);
  }

  cfg.baseUrl = cfg.baseUrl.replace(/\/+$/, '');
  cfg.admins.emails = cfg.admins.emails.map((e) => e.trim().toLowerCase());
  if ('trustedProviders' in cfg.admins) {
    console.warn('admins.trustedProviders is no longer supported and is ignored: every OAuth provider is trusted');
    delete (cfg.admins as { trustedProviders?: unknown }).trustedProviders;
  }

  if (cfg.sessionSecret.length < 32) {
    throw new Error('sessionSecret must be at least 32 characters (set DRAFTBOX_SESSION_SECRET)');
  }
  if (cfg.encryptionKey.length < 32) {
    throw new Error('encryptionKey must be at least 32 characters (set DRAFTBOX_ENCRYPTION_KEY)');
  }
  return cfg;
}
