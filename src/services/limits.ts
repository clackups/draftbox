// Storage quotas and time limits. An account that exceeds either becomes
// read-only: no new commits through the web editor or Git pushes, while
// reading and cloning keep working.

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context } from './context.ts';
import { ServiceError } from './context.ts';
import type { LimitGrant, User } from '../db/models.ts';

const MB = 1024 * 1024;
// Largest accepted quota and time limit; keeps values sane.
const MAX_QUOTA_MB = 10 * 1024 * 1024;
const MAX_DAYS = 100 * 365;

export interface UserLimits {
  // null means unlimited.
  storageQuotaMb: number | null;
  writableUntil: string | null;
  // Administrator accounts are never limited.
  admin: boolean;
}

export interface LimitStatus extends UserLimits {
  usedBytes: number;
  // Why the account is read-only, as an error code; null if writable.
  blockedBy: 'quota_exceeded' | 'time_limit_expired' | null;
}

// Validates a quota or time limit from a form or the API: undefined or
// '' is the configured default, null or 0 is unlimited.
export function parseLimit(value: unknown, max: number): number | null | undefined {
  if (value === undefined || value === '') return undefined;
  if (value === null) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > max) throw new ServiceError('invalid_limit');
  return n === 0 ? null : n;
}

export function parseLimitGrant(storageQuotaMb: unknown, timeLimitDays: unknown): LimitGrant {
  const grant: LimitGrant = {};
  const quota = parseLimit(storageQuotaMb, MAX_QUOTA_MB);
  const days = parseLimit(timeLimitDays, MAX_DAYS);
  if (quota !== undefined) grant.storageQuotaMb = quota;
  if (days !== undefined) grant.timeLimitDays = days;
  return grant;
}

// A change of an existing account's limits. An absent field is left
// unchanged, 'default' returns to the configured default, null means
// unlimited.
export interface LimitUpdate {
  storageQuotaMb?: number | null | 'default';
  writableUntil?: string | null | 'default';
}

// Parses a quota change: '' or 'default' is the default, null or 0 is
// unlimited.
export function parseQuotaUpdate(value: unknown): LimitUpdate['storageQuotaMb'] {
  if (value === undefined) return undefined;
  if (value === '' || value === 'default') return 'default';
  return parseLimit(value, MAX_QUOTA_MB) ?? null;
}

// Parses a time limit change: '' or 'default' is the default, null is
// unlimited, a date (YYYY-MM-DD, the account stays writable through that
// day, UTC) or a full ISO timestamp sets the end.
export function parseUntilUpdate(value: unknown): LimitUpdate['writableUntil'] {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (value === '' || value === 'default') return 'default';
  if (typeof value !== 'string') throw new ServiceError('invalid_limit');
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T23:59:59.999Z` : value;
  const ms = Date.parse(iso);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(iso) || isNaN(ms)) throw new ServiceError('invalid_limit');
  return new Date(ms).toISOString();
}

async function dirSize(path: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = join(path, e.name);
    if (e.isDirectory()) total += await dirSize(p);
    else if (e.isFile()) total += (await stat(p).catch(() => null))?.size ?? 0;
  }
  return total;
}

// Limits stored in a new account: those of the grant; fields the grant
// does not set stay absent, so the configured defaults apply.
export function limitsForNewUser(grant: LimitGrant | undefined, createdAt: string): Pick<User, 'storageQuotaMb' | 'writableUntil'> {
  const out: Pick<User, 'storageQuotaMb' | 'writableUntil'> = {};
  if (grant?.storageQuotaMb !== undefined) out.storageQuotaMb = grant.storageQuotaMb;
  if (grant?.timeLimitDays !== undefined) {
    out.writableUntil = grant.timeLimitDays === null
      ? null
      : new Date(Date.parse(createdAt) + grant.timeLimitDays * 86400_000).toISOString();
  }
  return out;
}

const USAGE_MAX_AGE_MS = 60_000;

export class LimitService {
  private ctx: Context;
  // Tail of the queue of writes (pushes, web commits) of each account.
  private writeQueues = new Map<string, Promise<void>>();
  // Storage used by each account, measured at `at`. Every write clears
  // the entry when it ends (see lockWrites); the age limit covers
  // changes made outside the service.
  private usage = new Map<string, { bytes: number; at: number }>();

  constructor(ctx: Context) {
    this.ctx = ctx;
  }

  // An account whose email is a configured administrator address and
  // that has signed in through a trusted provider. Unlike the session's
  // admin flag this also applies to Git access with tokens.
  isAdminAccount(user: User): boolean {
    return this.ctx.config.admins.emails.includes(user.email);
  }

  effective(user: User): UserLimits {
    if (this.isAdminAccount(user)) return { storageQuotaMb: null, writableUntil: null, admin: true };
    const defaults = this.ctx.config.limits;
    let writableUntil: string | null;
    if (user.writableUntil !== undefined) {
      writableUntil = user.writableUntil;
    } else {
      writableUntil = defaults.timeLimitDays === null
        ? null
        : new Date(Date.parse(user.createdAt) + defaults.timeLimitDays * 86400_000).toISOString();
    }
    return {
      storageQuotaMb: user.storageQuotaMb !== undefined ? user.storageQuotaMb : defaults.storageQuotaMb,
      writableUntil,
      admin: false,
    };
  }

  // Disk space taken by all repositories of the user. Measuring walks
  // every file, so the result is kept until the next write.
  async usedBytes(userId: string): Promise<number> {
    const cached = this.usage.get(userId);
    if (cached && Date.now() - cached.at < USAGE_MAX_AGE_MS) return cached.bytes;
    const at = Date.now();
    const view = this.ctx.store.view();
    let total = 0;
    for (const name of await view.list(`index/repo/${userId}`)) {
      const id = await view.getText(`index/repo/${userId}/${name}`);
      if (id) total += await dirSize(this.ctx.repoPath(id));
    }
    this.usage.set(userId, { bytes: total, at });
    return total;
  }

  async status(user: User): Promise<LimitStatus> {
    const limits = this.effective(user);
    const usedBytes = await this.usedBytes(user.id);
    let blockedBy: LimitStatus['blockedBy'] = null;
    if (limits.writableUntil && Date.parse(limits.writableUntil) <= Date.now()) blockedBy = 'time_limit_expired';
    else if (limits.storageQuotaMb !== null && usedBytes >= limits.storageQuotaMb * MB) blockedBy = 'quota_exceeded';
    return { ...limits, usedBytes, blockedBy };
  }

  async update(userId: string, patch: LimitUpdate, actor: string): Promise<User> {
    return this.ctx.store.transact(`Update limits of ${userId} by ${actor}`, async (tx) => {
      const user = await tx.get<User>(`users/${userId}.json`);
      if (!user) throw new ServiceError('not_found', 404);
      if (patch.storageQuotaMb === 'default') delete user.storageQuotaMb;
      else if (patch.storageQuotaMb !== undefined) user.storageQuotaMb = patch.storageQuotaMb;
      if (patch.writableUntil === 'default') delete user.writableUntil;
      else if (patch.writableUntil !== undefined) user.writableUntil = patch.writableUntil;
      tx.put(`users/${userId}.json`, user);
      return user;
    });
  }

  // Waits for the account's earlier writes, so that each write sees the
  // storage used by the ones before it. Returns the function that lets
  // the next write go ahead; it must be called exactly when the write
  // is finished (calling it again does nothing).
  async lockWrites(userId: string): Promise<() => void> {
    const before = this.writeQueues.get(userId) ?? Promise.resolve();
    let open: () => void = () => undefined;
    const mine = new Promise<void>((resolve) => { open = resolve; });
    const tail = before.then(() => mine);
    this.writeQueues.set(userId, tail);
    await before;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.usage.delete(userId);
      open();
      if (this.writeQueues.get(userId) === tail) this.writeQueues.delete(userId);
    };
  }

  // Runs a write of the account's repositories that adds little data
  // (tags, branches, deletions) in the account's queue of writes.
  async withWrite<T>(userId: string, write: () => Promise<T>): Promise<T> {
    const release = await this.lockWrites(userId);
    try {
      return await write();
    } finally {
      release();
    }
  }

  // Runs a write that adds up to `bytes` of data: after the account's
  // earlier writes, and only if the account is writable and the data
  // fits into the remaining quota.
  async withRoom<T>(user: User, bytes: number, write: () => Promise<T>): Promise<T> {
    const release = await this.lockWrites(user.id);
    try {
      const s = await this.status(user);
      if (s.blockedBy) throw new ServiceError(s.blockedBy, 403);
      if (s.storageQuotaMb !== null && s.usedBytes + bytes > s.storageQuotaMb * MB) throw new ServiceError('not_enough_space', 413);
      return await write();
    } finally {
      release();
    }
  }

  // Throws when the account may not create new commits.
  async assertWritable(user: User): Promise<void> {
    const s = await this.status(user);
    if (s.blockedBy) throw new ServiceError(s.blockedBy, 403);
  }
}
