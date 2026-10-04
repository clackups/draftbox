// Records stored as JSON files in the metadata repository.
//
// Layout of the metadata repository (branch refs/heads/main):
//
//   users/<userId>.json                  User
//   repos/<repoId>.json                  Repo
//   tokens/<tokenId>.json                AccessToken
//   invitations/<inviteId>.json          Invitation
//   preregistrations/<sha256(email)>.json Preregistration
//   settings/branding.json               Branding
//   settings/logo                        logo image (raw bytes)
//   revoked-sessions/<sessionId>         expiry of a logged-out session
//   retired-handles/<handle>.json        previous owner of a released handle
//   index/email/<sha256(email)>          userId
//   index/handle/<handle>                userId
//   index/identity/<provider>/<sha256(subject)>  userId
//   index/repo/<ownerId>/<repoName>      repoId
//   index/invite/<sha256(code)>          inviteId
//   index/otp/<hmac(password)>           tokenId
//   index/email-verify/<sha256(code)>    userId (pending contact email)

export const SCHEMA_VERSION = 1;

export type Language = string;
export type Theme = 'auto' | 'light' | 'dark';
// A user's appearance choice: 'site' follows the administrator's
// default theme, 'auto' follows the browser/system setting.
export type UserTheme = Theme | 'site';
export const USER_THEMES: readonly UserTheme[] = ['site', 'auto', 'light', 'dark'];

export interface Identity {
  provider: string;
  subject: string;
}

// Reserved for future Git SSH access.
export interface SshKey {
  id: string;
  title: string;
  publicKey: string;
  fingerprint: string;
  createdAt: string;
}

export interface UserPrefs {
  language: Language;
  advancedMode: boolean;
  theme: UserTheme;
}

// A contact address change waiting for the user to open the
// verification link sent to it.
export interface PendingContactEmail {
  email: string;
  codeHash: string;
  sentAt: string;
  expiresAt: string;
}

// Storage quota and time limit granted by an invitation or a
// pre-registration. An absent field means the configured default,
// null means unlimited.
export interface LimitGrant {
  storageQuotaMb?: number | null;
  timeLimitDays?: number | null;
}

export interface User {
  id: string;
  // Primary address from the OAuth login; identifies the account.
  email: string;
  // Verified address shown in the public profile and used as the author
  // of commits made in the web editor. Absent in records created before
  // it was introduced; see contactEmailOf().
  contactEmail?: string;
  pendingContactEmail?: PendingContactEmail;
  // Plain text shown in the public profile.
  description?: string;
  homepage?: string;
  handle: string;
  name: string;
  createdAt: string;
  blocked: boolean;
  blockedAt?: string;
  identities: Identity[];
  prefs: UserPrefs;
  sshKeys: SshKey[];
  // Incremented to invalidate all existing web sessions of the user.
  sessionEpoch: number;
  // Exceeding the quota or the time limit makes the account read-only.
  // Absent: the configured default (time limit counted from createdAt);
  // null: unlimited.
  storageQuotaMb?: number | null;
  writableUntil?: string | null;
}

export function contactEmailOf(user: User): string {
  return user.contactEmail ?? user.email;
}

export type Visibility = 'public' | 'private';

export interface Repo {
  id: string;
  ownerId: string;
  name: string;
  description: string;
  visibility: Visibility;
  createdAt: string;
}

export type TokenAccess = 'read' | 'write';

export interface PendingOtp {
  // HMAC of the 8-digit password, also used as the index key.
  key: string;
  // Token value encrypted with the server key; erased when redeemed.
  encryptedToken: string;
  createdAt: string;
  expiresAt: string;
}

export interface AccessToken {
  id: string;
  userId: string;
  name: string;
  // null means the token is valid for all repositories of the user.
  repoId: string | null;
  access: TokenAccess;
  secretHash: string;
  // Token value encrypted with the server key, so that one-time passwords
  // can be issued later without changing the value. Absent in tokens
  // created before it was introduced.
  encryptedValue?: string;
  createdAt: string;
  // null means the token never expires.
  expiresAt: string | null;
  otp?: PendingOtp;
}

export interface Invitation {
  id: string;
  codeHash: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string | null;
  note: string;
  usedBy?: string;
  usedAt?: string;
  limits?: LimitGrant;
}

export interface Preregistration {
  email: string;
  createdAt: string;
  note: string;
  limits?: LimitGrant;
}

export interface Branding {
  siteName: string;
  primaryColor: string;
  accentColor: string;
  // Page background of the light and dark appearance.
  lightBackground: string;
  darkBackground: string;
  // Background of panels (cards, top bar, form fields).
  lightPanel: string;
  darkPanel: string;
  defaultTheme: Theme;
  customCss: string;
  hasLogo: boolean;
  logoType?: string;
  // HTML, restricted by util/sanitize.ts.
  footerText: string;
  // Markdown shown on the landing page, by language. A missing or empty
  // entry means the built-in text of that language (`landing.text`).
  landingText: Record<Language, string>;
}

export const DEFAULT_BRANDING: Branding = {
  siteName: 'Draftbox',
  primaryColor: '#2f6f4f',
  accentColor: '#c9822b',
  lightBackground: '#f7f6f2',
  darkBackground: '#161a18',
  lightPanel: '#ffffff',
  darkPanel: '#1f2421',
  defaultTheme: 'auto',
  customCss: '',
  hasLogo: false,
  footerText: '',
  landingText: {},
};
