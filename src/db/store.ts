// Transactional key/value store on top of a bare Git repository.
//
// Every record is a file in the tree of refs/heads/main. A transaction
// stages changes in memory, then writes one commit and moves the branch
// with a compare-and-swap. Writes are serialized within the process; a
// concurrent external writer causes a retry on the fresh state.

import type { GitRepo } from '../git/types.ts';
import { RefConflictError } from '../git/types.ts';

const BRANCH = 'refs/heads/main';
const COMMITTER = { name: 'Draftbox', email: 'draftbox@localhost' };
const MAX_RETRIES = 3;

const enc = new TextEncoder();
const dec = new TextDecoder();

export interface ReadView {
  getRaw(path: string): Promise<Uint8Array | null>;
  get<T>(path: string): Promise<T | null>;
  getText(path: string): Promise<string | null>;
  // Names of entries directly below dir (files and subdirectories).
  list(dir: string): Promise<string[]>;
}

export interface Tx extends ReadView {
  put(path: string, value: unknown): void;
  putText(path: string, value: string): void;
  putRaw(path: string, value: Uint8Array): void;
  delete(path: string): void;
  // Deletes every file below dir.
  deleteTree(dir: string): Promise<void>;
}

class Snapshot implements ReadView {
  private store: MetaStore;
  readonly treeOid: string | null;

  constructor(store: MetaStore, treeOid: string | null) {
    this.store = store;
    this.treeOid = treeOid;
  }

  async getRaw(path: string): Promise<Uint8Array | null> {
    if (!this.treeOid) return null;
    const entry = await this.store.repo.lookupPath(this.treeOid, path);
    if (!entry || entry.type !== 'blob') return null;
    return this.store.readBlobCached(entry.oid);
  }

  async get<T>(path: string): Promise<T | null> {
    if (!this.treeOid) return null;
    const entry = await this.store.repo.lookupPath(this.treeOid, path);
    if (!entry || entry.type !== 'blob') return null;
    return this.store.readJsonCached(entry.oid) as Promise<T>;
  }

  async getText(path: string): Promise<string | null> {
    const raw = await this.getRaw(path);
    return raw === null ? null : dec.decode(raw);
  }

  async list(dir: string): Promise<string[]> {
    if (!this.treeOid) return [];
    const entry = await this.store.repo.lookupPath(this.treeOid, dir);
    if (!entry || entry.type !== 'tree') return [];
    return (await this.store.repo.readTree(entry.oid)).map((e) => e.name);
  }
}

class Transaction implements Tx {
  readonly changes = new Map<string, Uint8Array | null>();

  private base: Snapshot;

  constructor(base: Snapshot) {
    this.base = base;
  }

  private norm(path: string): string {
    return path.replace(/^\/+|\/+$/g, '');
  }

  async getRaw(path: string): Promise<Uint8Array | null> {
    const p = this.norm(path);
    if (this.changes.has(p)) return this.changes.get(p) ?? null;
    return this.base.getRaw(p);
  }

  async get<T>(path: string): Promise<T | null> {
    const p = this.norm(path);
    if (this.changes.has(p)) {
      const raw = this.changes.get(p);
      return raw ? (JSON.parse(dec.decode(raw)) as T) : null;
    }
    return this.base.get<T>(p);
  }

  async getText(path: string): Promise<string | null> {
    const raw = await this.getRaw(path);
    return raw === null ? null : dec.decode(raw);
  }

  async list(dir: string): Promise<string[]> {
    const d = this.norm(dir);
    const names = new Set(await this.base.list(d));
    const prefix = d === '' ? '' : d + '/';
    for (const [p, v] of this.changes) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const name = rest.split('/')[0];
      if (v !== null) names.add(name);
      else if (!rest.includes('/')) names.delete(name);
    }
    // A directory whose files were all deleted may still be listed; callers
    // read the records and skip missing ones.
    return [...names].sort();
  }

  put(path: string, value: unknown): void {
    this.changes.set(this.norm(path), enc.encode(JSON.stringify(value, null, 2) + '\n'));
  }

  putText(path: string, value: string): void {
    this.changes.set(this.norm(path), enc.encode(value));
  }

  putRaw(path: string, value: Uint8Array): void {
    this.changes.set(this.norm(path), value);
  }

  delete(path: string): void {
    this.changes.set(this.norm(path), null);
  }

  async deleteTree(dir: string): Promise<void> {
    const d = this.norm(dir);
    for (const name of await this.list(d)) {
      const p = d + '/' + name;
      if ((await this.getRaw(p)) !== null) this.delete(p);
      else await this.deleteTree(p);
    }
  }
}

export class MetaStore {
  private headOid: string | null = null;
  private treeOid: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private blobCache = new Map<string, Uint8Array>();
  private jsonCache = new Map<string, unknown>();

  readonly repo: GitRepo;

  constructor(repo: GitRepo) {
    this.repo = repo;
  }

  async load(): Promise<void> {
    this.headOid = await this.repo.resolveRef(BRANCH);
    if (this.headOid) {
      const c = await this.repo.getCommit(this.headOid);
      this.treeOid = c ? c.treeOid : null;
    } else {
      this.treeOid = null;
    }
  }

  get head(): string | null {
    return this.headOid;
  }

  async readBlobCached(oid: string): Promise<Uint8Array> {
    let b = this.blobCache.get(oid);
    if (!b) {
      b = await this.repo.readBlob(oid);
      this.cacheBlob(oid, b);
    }
    return b;
  }

  async readJsonCached(oid: string): Promise<unknown> {
    if (this.jsonCache.has(oid)) return structuredClone(this.jsonCache.get(oid));
    const raw = await this.repo.readBlob(oid);
    const value = JSON.parse(dec.decode(raw));
    if (this.jsonCache.size > 20000) this.jsonCache.clear();
    this.jsonCache.set(oid, value);
    return structuredClone(value);
  }

  private cacheBlob(oid: string, b: Uint8Array): void {
    if (this.blobCache.size > 2000) this.blobCache.clear();
    this.blobCache.set(oid, b);
  }

  // A consistent read-only view of the current state.
  view(): ReadView {
    return new Snapshot(this, this.treeOid);
  }

  async transact<T>(message: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      for (let attempt = 0; ; attempt++) {
        const tx = new Transaction(new Snapshot(this, this.treeOid));
        const result = await fn(tx);
        if (tx.changes.size === 0) return result;
        const treeOid = await this.repo.writeTree(this.treeOid, tx.changes);
        if (treeOid === this.treeOid) return result;
        const commitOid = await this.repo.createCommit({
          treeOid,
          parents: this.headOid ? [this.headOid] : [],
          message,
          author: COMMITTER,
        });
        try {
          await this.repo.updateRef(BRANCH, commitOid, this.headOid);
        } catch (err) {
          if (err instanceof RefConflictError && attempt < MAX_RETRIES) {
            await this.load();
            continue;
          }
          throw err;
        }
        this.headOid = commitOid;
        this.treeOid = treeOid;
        return result;
      }
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }
}
