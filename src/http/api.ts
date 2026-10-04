// JSON API.
//
//   POST /api/v1/token-exchange          {"password": "12345678"}
//        Exchanges a one-time password for the access token it was
//        assigned to. Each password works once. For a repository
//        token the response includes the repository, its clone URL
//        and its default branch; these are null for global tokens.
//
//   Administrative API, authenticated with "Authorization: Bearer <key>"
//   where <key> is one of the configured adminApiKeys:
//
//   GET    /api/v1/admin/preregistrations
//   POST   /api/v1/admin/preregistrations          {"email": "...", "note": "...",
//                                                    "storageQuotaMb": 500, "timeLimitDays": 365}
//   GET    /api/v1/admin/preregistrations/:email
//   DELETE /api/v1/admin/preregistrations/:email
//   POST   /api/v1/admin/invitations               {"note": "...", "expiresDays": 14,
//                                                    "storageQuotaMb": 500, "timeLimitDays": 365}
//
//   storageQuotaMb and timeLimitDays (counted from registration) are
//   optional: when absent, the configured defaults apply; null or 0
//   means unlimited.
//
//   GET    /api/v1/admin/users/:email                account and its limits
//   PATCH  /api/v1/admin/users/:email/limits         {"storageQuotaMb": 500,
//                                                    "writableUntil": "2027-06-30"}
//
//   In a limits change, an absent field stays unchanged, "default" returns
//   to the configured default and null (or 0 for the quota) means
//   unlimited. writableUntil is a date (writable through that day, UTC)
//   or an ISO timestamp.

import { isIPv4, isIPv6 } from 'node:net';
import type { Hono } from 'hono';
import type { AppEnv, Ctx, Services } from './app.ts';
import { ServiceError } from '../services/context.ts';
import { safeEqual } from '../util/crypto.ts';
import { parseLimitGrant, parseQuotaUpdate, parseUntilUpdate } from '../services/limits.ts';
import type { User } from '../db/models.ts';

// Fixed-window limiter for the one-time password endpoint: 8-digit
// passwords must not be guessable by brute force. Only failed attempts
// are counted.
class RateLimiter {
  private hits = new Map<string, { count: number; reset: number }>();

  private limit: number;
  private windowMs: number;

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  blocked(key: string): boolean {
    const cur = this.hits.get(key);
    return cur !== undefined && cur.reset > Date.now() && cur.count >= this.limit;
  }

  fail(key: string): void {
    const now = Date.now();
    if (this.hits.size > 10000) {
      for (const [k, v] of this.hits) if (v.reset <= now) this.hits.delete(k);
    }
    const cur = this.hits.get(key);
    if (!cur || cur.reset <= now) this.hits.set(key, { count: 1, reset: now + this.windowMs });
    else cur.count += 1;
  }
}

// The client address. Behind a proxy, the last X-Forwarded-For entry is
// the one the proxy appended; earlier entries come from the client and
// can be forged.
export function clientIp(c: Ctx): string {
  const svc = c.var.svc;
  if (svc.ctx.config.trustProxy) {
    const last = (c.req.header('X-Forwarded-For') ?? '').split(',').pop()?.trim();
    if (last) return last;
  }
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return env?.incoming?.socket?.remoteAddress ?? 'unknown';
}

// Rate limiting key of an address. One IPv6 subscriber usually holds a
// whole /64, so its addresses share a key.
export function rateKey(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return mapped[1];
  if (isIPv4(ip) || !isIPv6(ip)) return ip;
  const [head, tail = ''] = ip.toLowerCase().split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  return groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':') + '::/64';
}

async function jsonBody(c: Ctx): Promise<Record<string, unknown>> {
  const type = c.req.header('Content-Type') ?? '';
  if (type.includes('application/json')) {
    const v = await c.req.json().catch(() => null);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  }
  const form = await c.req.parseBody().catch(() => ({}));
  return form as Record<string, unknown>;
}

export function registerApiRoutes(app: Hono<AppEnv>, svc: Services): void {
  const perIp = new RateLimiter(10, 15 * 60_000);
  const global = new RateLimiter(1000, 60 * 60_000);

  app.post('/api/v1/token-exchange', async (c) => {
    const key = rateKey(clientIp(c));
    if (perIp.blocked(key) || global.blocked('all')) {
      return c.json({ error: 'rate_limited' }, 429, { 'Retry-After': '900' });
    }
    const body = await jsonBody(c);
    const password = String(body.password ?? '').replace(/\s+/g, '');
    const result = await svc.tokens.redeemOtp(password);
    if (!result) {
      perIp.fail(key);
      global.fail('all');
      return c.json({ error: 'invalid_password' }, 404);
    }
    const repo = result.token.repoId ? await svc.repos.getById(result.token.repoId) : null;
    const owner = await svc.users.getById(result.token.userId);
    const branch = repo ? await svc.repos.defaultBranch(await svc.repos.open(repo)) : null;
    return c.json({
      token: result.value,
      name: result.token.name,
      access: result.token.access,
      user: owner?.handle ?? null,
      repository: repo && owner ? `${owner.handle}/${repo.name}` : null,
      cloneUrl: repo && owner ? `${svc.ctx.config.baseUrl}/${owner.handle}/${repo.name}.git` : null,
      branch,
      expiresAt: result.token.expiresAt,
    });
  });

  app.use('/api/v1/admin/*', async (c, next) => {
    const h = c.req.header('Authorization') ?? '';
    const m = /^Bearer\s+(\S+)$/i.exec(h);
    const keys = svc.ctx.config.adminApiKeys;
    if (!m || !keys.some((k) => k.length >= 16 && safeEqual(k, m[1]))) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    await next();
  });

  app.get('/api/v1/admin/preregistrations', async (c) => c.json({ preregistrations: await svc.prereg.list() }));

  app.post('/api/v1/admin/preregistrations', async (c) => {
    const body = await jsonBody(c);
    try {
      const limits = parseLimitGrant(body.storageQuotaMb, body.timeLimitDays);
      const rec = await svc.prereg.add(String(body.email ?? ''), String(body.note ?? ''), limits);
      const existing = await svc.users.getByEmail(rec.email);
      return c.json({ preregistration: rec, registered: existing !== null }, 201);
    } catch (err) {
      if (err instanceof ServiceError) return c.json({ error: err.code }, 400);
      throw err;
    }
  });

  app.get('/api/v1/admin/preregistrations/:email', async (c) => {
    const rec = await svc.prereg.get(c.req.param('email'));
    const user = await svc.users.getByEmail(c.req.param('email'));
    if (!rec && !user) return c.json({ error: 'not_found' }, 404);
    return c.json({ preregistration: rec, registered: user !== null });
  });

  app.delete('/api/v1/admin/preregistrations/:email', async (c) => {
    const removed = await svc.prereg.remove(c.req.param('email'));
    return removed ? c.json({ ok: true }) : c.json({ error: 'not_found' }, 404);
  });

  app.post('/api/v1/admin/invitations', async (c) => {
    const body = await jsonBody(c);
    const days = Number(body.expiresDays ?? 0);
    let limits;
    try {
      limits = parseLimitGrant(body.storageQuotaMb, body.timeLimitDays);
    } catch (err) {
      if (err instanceof ServiceError) return c.json({ error: err.code }, 400);
      throw err;
    }
    const { invitation, code } = await svc.invites.create('api', String(body.note ?? ''), days > 0 ? Math.min(days, 365) : null, limits);
    return c.json({ id: invitation.id, link: svc.invites.link(code), expiresAt: invitation.expiresAt, limits: invitation.limits ?? {} }, 201);
  });

  const userJson = async (user: User) => {
    const status = await svc.limits.status(user);
    return {
      user: { email: user.email, handle: user.handle, name: user.name, createdAt: user.createdAt, blocked: user.blocked },
      limits: {
        storageQuotaMb: status.storageQuotaMb,
        writableUntil: status.writableUntil,
        admin: status.admin,
        usedBytes: status.usedBytes,
        readOnly: status.blockedBy,
        // Values stored for the account; absent fields use the defaults.
        custom: {
          ...(user.storageQuotaMb !== undefined ? { storageQuotaMb: user.storageQuotaMb } : {}),
          ...(user.writableUntil !== undefined ? { writableUntil: user.writableUntil } : {}),
        },
      },
    };
  };

  app.get('/api/v1/admin/users/:email', async (c) => {
    const user = await svc.users.getByEmail(c.req.param('email'));
    if (!user) return c.json({ error: 'not_found' }, 404);
    return c.json(await userJson(user));
  });

  app.patch('/api/v1/admin/users/:email/limits', async (c) => {
    const user = await svc.users.getByEmail(c.req.param('email'));
    if (!user) return c.json({ error: 'not_found' }, 404);
    const body = await jsonBody(c);
    try {
      const updated = await svc.limits.update(user.id, {
        storageQuotaMb: parseQuotaUpdate(body.storageQuotaMb),
        writableUntil: parseUntilUpdate(body.writableUntil),
      }, 'api');
      return c.json(await userJson(updated));
    } catch (err) {
      if (err instanceof ServiceError && err.status === 400) return c.json({ error: err.code }, 400);
      throw err;
    }
  });

  app.all('/api/*', (c) => c.json({ error: 'not_found' }, 404));
}
