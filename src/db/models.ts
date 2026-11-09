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
//   revoked-sessions/<day>/<sessionId>   '' for a logged-out session, grouped
//                                        by the day (UTC) it was issued
//   retired-handles/<handle>.json        previous owner of a released handle
//   index/email/<sha256(email)>          userId
//   index/handle/<handle>                userId
//   index/identity/<provider>/<sha256(subject)>  userId
//   index/repo/<ownerId>/<repoName>      repoId
//   index/invite/<sha256(code)>          inviteId
//   index/otp/<hmac(password)>           tokenId
//   index/user-tokens/<userId>/<tokenId> tokenId
//   index/public/<repoId>                ownerId (public repositories)
//   index/email-verify/<sha256(code)>    userId (pending contact email)

export const SCHEMA_VERSION = 4;

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
  // Defaults of the "Save as PDF" dialog. Absent in records created
  // before it was introduced; see pdfPrefsOf().
  pdf?: PdfPrefs;
}

export const PDF_PAPERS = ['A4', 'A3', 'A5', 'letter', 'legal'] as const;
export type PdfPaper = (typeof PDF_PAPERS)[number];
// iso: 2026-11-08, dmy: 08.11.2026, mdy: 11/08/2026, long: the date
// written out in the UI language, iso_time: 2026-11-08 14:30.
export const PDF_DATE_FORMATS = ['iso', 'dmy', 'mdy', 'long', 'iso_time'] as const;
export type PdfDateFormat = (typeof PDF_DATE_FORMATS)[number];
export const PDF_FONT_SIZES: readonly number[] = [8, 9, 10, 11, 12, 13, 14, 16, 18];

// Page setup for documents printed to PDF in the browser.
export interface PdfPrefs {
  paper: PdfPaper;
  landscape: boolean;
  // Base font size in points.
  fontSize: number;
  // Page header with the document title (its title or first heading).
  header: boolean;
  footerFilename: boolean;
  footerDate: boolean;
  dateFormat: PdfDateFormat;
  footerPageNumbers: boolean;
}

export const DEFAULT_PDF_PREFS: PdfPrefs = {
  paper: 'A4',
  landscape: false,
  fontSize: 11,
  header: true,
  footerFilename: true,
  footerDate: true,
  dateFormat: 'iso',
  footerPageNumbers: true,
};

// Validated PDF settings: unknown or missing values take the default.
export function normalizePdfPrefs(input: unknown, base: PdfPrefs = DEFAULT_PDF_PREFS): PdfPrefs {
  const p = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
  const size = Number(p.fontSize);
  return {
    paper: (PDF_PAPERS as readonly unknown[]).includes(p.paper) ? (p.paper as PdfPaper) : base.paper,
    landscape: bool(p.landscape, base.landscape),
    fontSize: PDF_FONT_SIZES.includes(size) ? size : base.fontSize,
    header: bool(p.header, base.header),
    footerFilename: bool(p.footerFilename, base.footerFilename),
    footerDate: bool(p.footerDate, base.footerDate),
    dateFormat: (PDF_DATE_FORMATS as readonly unknown[]).includes(p.dateFormat) ? (p.dateFormat as PdfDateFormat) : base.dateFormat,
    footerPageNumbers: bool(p.footerPageNumbers, base.footerPageNumbers),
  };
}

export function pdfPrefsOf(user: User | null): PdfPrefs {
  return normalizePdfPrefs(user?.prefs.pdf);
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

// Folder of revoked-sessions/ for a session issued at `ms` (the day,
// UTC). The issue time is in the session cookie and never changes.
export function revokedSessionDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// Keeps index/public in step with the visibility of a repository.
export function indexVisibility(tx: { putText(path: string, value: string): void; delete(path: string): void }, repo: Repo): void {
  if (repo.visibility === 'public') tx.putText(`index/public/${repo.id}`, repo.ownerId);
  else tx.delete(`index/public/${repo.id}`);
}

export interface Repo {
  id: string;
  ownerId: string;
  name: string;
  description: string;
  visibility: Visibility;
  createdAt: string;
}

export type TokenAccess = 'read' | 'write';

// Ref changes that can lose data. A read-write token may only add
// commits, branches and tags unless it is granted some of these.
export type TokenPermission = 'force_push' | 'delete_branches' | 'delete_tags' | 'move_tags';
export const TOKEN_PERMISSIONS: readonly TokenPermission[] = ['force_push', 'delete_branches', 'delete_tags', 'move_tags'];

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
  // Dangerous permissions of a read-write token. Absent means none.
  allow?: TokenPermission[];
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

// The stored branding settings completed with the defaults. `reader` is
// a read view or a transaction of the metadata store.
export async function readBranding(reader: { get<T>(path: string): Promise<T | null> }): Promise<Branding> {
  return { ...DEFAULT_BRANDING, ...(await reader.get<Partial<Branding>>('settings/branding.json')) };
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
