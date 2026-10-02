import { join, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { Config } from '../config.ts';
import type { GitBackend } from '../git/types.ts';
import { MetaStore } from '../db/store.ts';
import { SCHEMA_VERSION } from '../db/models.ts';

export class ServiceError extends Error {
  // Machine-readable code; also used as an i18n key suffix (error.<code>).
  readonly code: string;
  readonly status: number;
  constructor(code: string, status = 400) {
    super(code);
    this.name = 'ServiceError';
    this.code = code;
    this.status = status;
  }
}

export class Context {
  readonly config: Config;
  readonly git: GitBackend;
  readonly store: MetaStore;
  readonly dataDir: string;

  private constructor(config: Config, git: GitBackend, store: MetaStore, dataDir: string) {
    this.config = config;
    this.git = git;
    this.store = store;
    this.dataDir = dataDir;
  }

  static async create(config: Config, git: GitBackend): Promise<Context> {
    const dataDir = resolve(config.dataDir);
    mkdirSync(join(dataDir, 'repos'), { recursive: true });
    const metaRepo = await git.openOrInit(join(dataDir, 'meta.git'));
    const store = new MetaStore(metaRepo);
    await store.load();
    if (!store.head) {
      await store.transact('Initialize Draftbox database', async (tx) => {
        tx.put('schema.json', { version: SCHEMA_VERSION });
      });
    }
    return new Context(config, git, store, dataDir);
  }

  repoPath(repoId: string): string {
    if (!/^[0-9a-f]{16}$/.test(repoId)) throw new ServiceError('invalid_repo_id');
    return join(this.dataDir, 'repos', repoId + '.git');
  }

  now(): string {
    return new Date().toISOString();
  }
}
