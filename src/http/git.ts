// Git smart HTTP protocol (v0 and v2). libgit2 implements only the client
// side of the pack protocol, so the server side is delegated to
// `git upload-pack` / `git receive-pack` in stateless RPC mode.
// Authentication: HTTP Basic with an access token as password (the user
// name is ignored), or a Bearer token. Public repositories can be read
// without credentials.

import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import type { Hono } from 'hono';
import type { AppEnv, Ctx, Services } from './app.ts';
import type { Repo, User } from '../db/models.ts';
import { tokenAllows, type TokenAuth } from '../services/tokens.ts';

const GIT_PATH_RE = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/;
const SERVICES = new Set(['git-upload-pack', 'git-receive-pack']);
const MB = 1024 * 1024;
// Fetch requests carry only ref negotiation.
const MAX_FETCH_REQUEST_BYTES = 64 * MB;
// Push requests carry ref updates besides the pack.
const PUSH_COMMAND_ALLOWANCE = MB;

export function isGitRequestPath(path: string): boolean {
  return GIT_PATH_RE.test(path);
}

function credentials(c: Ctx): string | null {
  const h = c.req.header('Authorization');
  if (!h) return null;
  const [scheme, value] = h.split(/\s+/, 2);
  if (!value) return null;
  if (/^bearer$/i.test(scheme)) return value;
  if (/^basic$/i.test(scheme)) {
    const decoded = Buffer.from(value, 'base64').toString('utf8');
    const i = decoded.indexOf(':');
    const user = i >= 0 ? decoded.slice(0, i) : decoded;
    const pass = i >= 0 ? decoded.slice(i + 1) : '';
    return pass || user;
  }
  return null;
}

function challenge(c: Ctx, realm: string): Response {
  return c.text('Authentication required\n', 401, { 'WWW-Authenticate': `Basic realm="${realm.replace(/"/g, '')}"` });
}

function pktLine(s: string): string {
  return (s.length + 4).toString(16).padStart(4, '0') + s;
}

function gitEnv(c: Ctx): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', HOME: '/nonexistent' };
  const proto = c.req.header('Git-Protocol');
  if (proto && /^[A-Za-z0-9=:.\-]+$/.test(proto)) env.GIT_PROTOCOL = proto;
  return env;
}

// maxPackBytes limits the pack a push may send (null: unlimited).
function gitArgs(service: string, repoPath: string, advertise: boolean, maxPackBytes: number | null): string[] {
  const args = ['-c', 'core.hooksPath=/dev/null'];
  if (service === 'git-receive-pack') {
    args.push('-c', 'receive.fsckObjects=true', '-c', 'receive.denyDeleteCurrent=true');
    if (maxPackBytes !== null) args.push('-c', `receive.maxInputSize=${maxPackBytes}`);
  }
  args.push(service.slice(4), '--stateless-rpc');
  if (advertise) args.push('--advertise-refs');
  args.push(repoPath);
  return args;
}

export function registerGitRoutes(app: Hono<AppEnv>, svc: Services): void {
  app.use('*', async (c, next) => {
    const m = GIT_PATH_RE.exec(c.req.path);
    if (!m) return next();
    const [, ownerName, repoName, action] = m;

    let service: string;
    if (action === 'info/refs') {
      if (c.req.method !== 'GET') return c.text('Method not allowed\n', 405);
      service = c.req.query('service') ?? '';
      // Dumb HTTP protocol is not supported.
      if (!SERVICES.has(service)) return c.text('Smart HTTP protocol required\n', 403);
    } else {
      if (c.req.method !== 'POST') return c.text('Method not allowed\n', 405);
      service = action;
    }
    const write = service === 'git-receive-pack';

    const owner: User | null = await svc.users.getByHandle(ownerName);
    const repo: Repo | null = owner && !owner.blocked ? await svc.repos.getByName(owner, repoName) : null;
    const realm = svc.ctx.config.baseUrl;

    const cred = credentials(c);
    let auth: TokenAuth | null = null;
    if (cred) {
      auth = await svc.tokens.authenticate(cred);
      if (!auth) return challenge(c, realm);
    }
    if (!repo || !owner) {
      return cred ? c.text('Repository not found\n', 404) : challenge(c, realm);
    }
    const allowed = auth ? tokenAllows(auth, repo, write) : !write && repo.visibility === 'public';
    if (!allowed) {
      if (!auth) return challenge(c, realm);
      return repo.visibility === 'public' || repo.ownerId === auth.user.id
        ? c.text('Access denied\n', 403)
        : c.text('Repository not found\n', 404);
    }

    // A push may not add more than the remaining storage quota.
    let maxPackBytes: number | null = null;
    if (write) {
      const { blockedBy, storageQuotaMb, usedBytes } = await svc.limits.status(owner);
      if (blockedBy === 'quota_exceeded') return c.text('Storage quota exceeded: the repository is read-only\n', 403);
      if (blockedBy === 'time_limit_expired') return c.text('Account time limit expired: the repository is read-only\n', 403);
      if (storageQuotaMb !== null) maxPackBytes = Math.max(1, Math.floor(storageQuotaMb * MB - usedBytes));
    }
    const maxBody = write
      ? (maxPackBytes === null ? null : maxPackBytes + PUSH_COMMAND_ALLOWANCE)
      : MAX_FETCH_REQUEST_BYTES;
    const length = Number(c.req.header('Content-Length'));
    if (maxBody !== null && Number.isFinite(length) && length > maxBody) {
      return c.text(write ? 'Storage quota exceeded: the push is too large\n' : 'Request too large\n', 413);
    }

    const repoPath = svc.ctx.repoPath(repo.id);
    const env = gitEnv(c);
    const advertise = action === 'info/refs';
    const child = spawn(svc.ctx.config.gitBinary, gitArgs(service, repoPath, advertise, maxPackBytes), { env, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stderr.on('data', (d: Buffer) => console.error(`[git ${service}] ${d.toString().trim()}`));
    child.on('error', (err) => console.error(`[git ${service}] ${err.message}`));

    const headers: Record<string, string> = {
      'Cache-Control': 'no-cache, max-age=0, must-revalidate',
      Pragma: 'no-cache',
    };

    if (advertise) {
      child.stdin.end();
      headers['Content-Type'] = `application/x-${service}-advertisement`;
      const prefix = env.GIT_PROTOCOL?.includes('version=2') ? '' : pktLine(`# service=${service}\n`) + '0000';
      const out = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
      const body = prefix ? prependStream(new TextEncoder().encode(prefix), out) : out;
      return new Response(body, { status: 200, headers });
    }

    // Both the transferred and the decompressed size are limited.
    let input: ReadableStream<Uint8Array> | null = c.req.raw.body;
    if (input && maxBody !== null) input = input.pipeThrough(sizeLimit(maxBody));
    if (input && (c.req.header('Content-Encoding') ?? '').toLowerCase() === 'gzip') {
      input = input.pipeThrough(new DecompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
      if (maxBody !== null) input = input.pipeThrough(sizeLimit(maxBody));
    }
    if (input) {
      const src = Readable.fromWeb(input as import('node:stream/web').ReadableStream);
      src.on('error', () => child.kill());
      src.pipe(child.stdin);
    } else {
      child.stdin.end();
    }
    child.stdin.on('error', () => undefined);
    headers['Content-Type'] = `application/x-${service}-result`;
    return new Response(Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>, { status: 200, headers });
  });
}

// Passes a stream through, failing once it exceeds max bytes.
function sizeLimit(max: number): TransformStream<Uint8Array, Uint8Array> {
  let total = 0;
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > max) controller.error(new Error('request body too large'));
      else controller.enqueue(chunk);
    },
  });
}

function prependStream(head: Uint8Array, rest: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = rest.getReader();
  let sentHead = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!sentHead) {
        sentHead = true;
        controller.enqueue(head);
        return;
      }
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}
