import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finalizeConfig, type Config } from '../src/config.ts';
import { Context } from '../src/services/context.ts';
import { NodegitBackend } from '../src/git/nodegit.ts';
import { createApp, createServices, type Services } from '../src/http/app.ts';

export const ADMIN_EMAIL = 'admin@example.com';
export const ADMIN_API_KEY = 'test-admin-api-key-0123456789';

export interface TestEnv {
  dir: string;
  svc: Services;
  app: ReturnType<typeof createApp>;
  config: Config;
  cleanup(): void;
}

export async function setup(overrides: Partial<Config> = {}): Promise<TestEnv> {
  const dir = mkdtempSync(join(process.env.DRAFTBOX_TEST_TMP ?? tmpdir(), 'draftbox-test-'));
  const config = finalizeConfig({
    baseUrl: 'http://localhost:8080',
    dataDir: dir,
    sessionSecret: 'x'.repeat(40),
    encryptionKey: 'y'.repeat(40),
    oauth: { dev: { enabled: true } },
    admins: { emails: [ADMIN_EMAIL], trustedProviders: ['dev'] },
    adminApiKeys: [ADMIN_API_KEY],
    registration: { open: false, invitations: true, preregistration: true },
    ...overrides,
  });
  const ctx = await Context.create(config, new NodegitBackend());
  const svc = createServices(ctx);
  const app = createApp(svc);
  return { dir, svc, app, config, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// Minimal browser: keeps cookies and the CSRF token of the last page.
export class Browser {
  cookies = new Map<string, string>();
  csrf = '';
  env: TestEnv;

  constructor(env: TestEnv) {
    this.env = env;
  }

  private cookieHeader(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  private store(res: Response): void {
    for (const sc of res.headers.getSetCookie()) {
      const [pair, ...attrs] = sc.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const expired = attrs.some((a) => /max-age=0\b/i.test(a.trim()) || /expires=thu, 01 jan 1970/i.test(a.trim()));
      if (expired || value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  async get(path: string, headers: Record<string, string> = {}): Promise<{ res: Response; text: string }> {
    const res = await this.env.app.request(path, { headers: { Cookie: this.cookieHeader(), ...headers } });
    this.store(res);
    const text = await res.text();
    const m = /name="_csrf" value="([^"]+)"/.exec(text);
    if (m) this.csrf = m[1];
    return { res, text };
  }

  async post(path: string, fields: Record<string, string> | FormData, opts: { csrf?: boolean } = {}): Promise<{ res: Response; text: string }> {
    if (!this.csrf) await this.get('/');
    let body: FormData | URLSearchParams;
    if (fields instanceof FormData) {
      body = fields;
      if (opts.csrf !== false) body.set('_csrf', this.csrf);
    } else {
      body = new URLSearchParams(fields);
      if (opts.csrf !== false) body.set('_csrf', this.csrf);
    }
    const res = await this.env.app.request(path, { method: 'POST', body, headers: { Cookie: this.cookieHeader() } });
    this.store(res);
    return { res, text: await res.text() };
  }

  async login(email: string, name = ''): Promise<Response> {
    await this.get('/auth/dev');
    const { res } = await this.post('/auth/dev', { email, name, next: '/' });
    return res;
  }
}

export async function adminApi(env: TestEnv, method: string, path: string, body?: unknown): Promise<Response> {
  return env.app.request(path, {
    method,
    headers: { Authorization: `Bearer ${ADMIN_API_KEY}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
