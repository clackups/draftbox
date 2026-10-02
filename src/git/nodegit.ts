// libgit2 backend implemented with the nodegit binding.

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import {
  type CommitInfo, type EntryType, type GitBackend, type GitRepo, type Person,
  type RefInfo, type TreeChanges, type TreeEntry,
  PathConflictError, RefConflictError,
} from './types.ts';

// nodegit ships incomplete typings; the binding is used through a narrow,
// untyped facade confined to this file.
type Any = any;

let ngCache: Any = null;
function ng(): Any {
  if (!ngCache) {
    const require = createRequire(import.meta.url);
    ngCache = require('nodegit');
  }
  return ngCache;
}

const MODE_TREE = 0o040000;
const MODE_BLOB = 0o100644;
const MODE_EXEC = 0o100755;
const MODE_LINK = 0o120000;
const MODE_COMMIT = 0o160000;

function entryType(mode: number): EntryType {
  if (mode === MODE_TREE) return 'tree';
  if (mode === MODE_COMMIT) return 'commit';
  return 'blob';
}

function person(sig: Any): Person {
  return { name: sig.name(), email: sig.email(), time: sig.when().time() };
}

function commitInfo(c: Any): CommitInfo {
  const parents: string[] = [];
  const n = c.parentcount();
  for (let i = 0; i < n; i++) parents.push(c.parentId(i).tostrS());
  return {
    oid: c.id().tostrS(),
    treeOid: c.treeId().tostrS(),
    parents,
    message: c.message(),
    author: person(c.author()),
    committer: person(c.committer()),
  };
}

function isNotFound(err: unknown): boolean {
  const e = err as { errno?: number; message?: string };
  // GIT_ENOTFOUND == -3
  return e?.errno === -3 || /not found|does not exist|no reference/i.test(String(e?.message));
}

interface PendingChange {
  segments: string[];
  content: Uint8Array | null;
}

class NodegitRepo implements GitRepo {
  readonly path: string;
  private repo: Any;

  constructor(path: string, repo: Any) {
    this.path = path;
    this.repo = repo;
  }

  async resolveRef(name: string): Promise<string | null> {
    const NG = ng();
    try {
      const ref = await NG.Reference.lookup(this.repo, name);
      const resolved = ref.isSymbolic() ? await ref.resolve() : ref;
      const obj = await resolved.peel(NG.Object.TYPE.COMMIT);
      return obj.id().tostrS();
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async listRefs(prefix: string): Promise<RefInfo[]> {
    const NG = ng();
    const names: string[] = await NG.Reference.list(this.repo);
    const out: RefInfo[] = [];
    for (const name of names.filter((n) => n.startsWith(prefix)).sort()) {
      const ref = await NG.Reference.lookup(this.repo, name);
      if (ref.isSymbolic()) continue;
      let commitOid: string | null = null;
      try {
        commitOid = (await ref.peel(NG.Object.TYPE.COMMIT)).id().tostrS();
      } catch {
        commitOid = null;
      }
      out.push({ name, oid: ref.target().tostrS(), commitOid });
    }
    return out;
  }

  async getCommit(oid: string): Promise<CommitInfo | null> {
    try {
      return commitInfo(await this.repo.getCommit(oid));
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async log(startOid: string, limit: number, skip = 0): Promise<CommitInfo[]> {
    const NG = ng();
    const walk = NG.Revwalk.create(this.repo);
    walk.sorting(NG.Revwalk.SORT.TOPOLOGICAL | NG.Revwalk.SORT.TIME);
    walk.push(NG.Oid.fromString(startOid));
    const commits: Any[] = await walk.getCommits(skip + limit);
    return commits.slice(skip).map(commitInfo);
  }

  async readTree(treeOid: string): Promise<TreeEntry[]> {
    const tree = await this.repo.getTree(treeOid);
    return tree.entries().map((e: Any) => {
      const mode = e.filemode();
      return { name: e.name(), oid: e.sha(), type: entryType(mode), mode };
    });
  }

  async lookupPath(treeOid: string, path: string): Promise<TreeEntry | null> {
    const clean = path.replace(/^\/+|\/+$/g, '');
    if (clean === '') return { name: '', oid: treeOid, type: 'tree', mode: MODE_TREE };
    const tree = await this.repo.getTree(treeOid);
    try {
      const e = await tree.entryByPath(clean);
      const mode = e.filemode();
      return { name: e.name(), oid: e.sha(), type: entryType(mode), mode };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async readBlob(oid: string): Promise<Uint8Array> {
    const blob = await this.repo.getBlob(oid);
    return new Uint8Array(blob.content());
  }

  async writeTree(baseTreeOid: string | null, changes: TreeChanges): Promise<string> {
    const pending: PendingChange[] = [];
    for (const [path, content] of changes) {
      const segments = path.split('/').filter((s) => s.length > 0);
      if (segments.length === 0 || segments.some((s) => s === '.' || s === '..' || s === '.git')) {
        throw new PathConflictError(path);
      }
      pending.push({ segments, content });
    }
    const oid = await this.buildTree(baseTreeOid, pending, '');
    if (oid) return oid;
    // Everything was deleted: write an empty tree.
    const NG = ng();
    const tb = await NG.Treebuilder.create(this.repo, null);
    return (await tb.write()).tostrS();
  }

  // Returns the new tree oid, or null if the resulting tree is empty.
  private async buildTree(baseOid: string | null, changes: PendingChange[], prefix: string): Promise<string | null> {
    const NG = ng();
    const base = baseOid ? await this.repo.getTree(baseOid) : null;
    const tb = await NG.Treebuilder.create(this.repo, base);
    const groups = new Map<string, PendingChange[]>();
    for (const ch of changes) {
      const [head, ...rest] = ch.segments;
      if (rest.length === 0) {
        const existing = tb.get(head);
        if (ch.content === null) {
          if (existing) tb.remove(head);
          continue;
        }
        let mode = MODE_BLOB;
        if (existing) {
          const m = existing.filemode();
          if (m === MODE_TREE || m === MODE_COMMIT) throw new PathConflictError(prefix + head);
          if (m === MODE_EXEC || m === MODE_LINK) mode = m;
        }
        const buf = Buffer.from(ch.content);
        const oid = await NG.Blob.createFromBuffer(this.repo, buf, buf.length);
        tb.insert(head, oid, mode);
      } else {
        const list = groups.get(head) ?? [];
        list.push({ segments: rest, content: ch.content });
        groups.set(head, list);
      }
    }
    for (const [dir, sub] of groups) {
      const existing = tb.get(dir);
      let subBase: string | null = null;
      if (existing) {
        if (existing.filemode() !== MODE_TREE) throw new PathConflictError(prefix + dir);
        subBase = existing.sha();
      }
      const subOid = await this.buildTree(subBase, sub, prefix + dir + '/');
      if (subOid === null) {
        if (existing) tb.remove(dir);
      } else {
        tb.insert(dir, NG.Oid.fromString(subOid), MODE_TREE);
      }
    }
    if (tb.entrycount() === 0) return null;
    return (await tb.write()).tostrS();
  }

  async createCommit(opts: { treeOid: string; parents: string[]; message: string; author: { name: string; email: string } }): Promise<string> {
    const NG = ng();
    const sig = NG.Signature.now(opts.author.name || opts.author.email, opts.author.email);
    const oid = await this.repo.createCommit(null, sig, sig, opts.message, NG.Oid.fromString(opts.treeOid),
      opts.parents.map((p) => NG.Oid.fromString(p)));
    return oid.tostrS();
  }

  async updateRef(name: string, newOid: string, expectedOld: string | null): Promise<void> {
    const NG = ng();
    const oid = NG.Oid.fromString(newOid);
    try {
      if (expectedOld === null) {
        await NG.Reference.create(this.repo, name, oid, 0, 'draftbox');
      } else {
        await NG.Reference.createMatching(this.repo, name, oid, 1, NG.Oid.fromString(expectedOld), 'draftbox');
      }
    } catch (err) {
      const e = err as { errno?: number };
      // GIT_EEXISTS == -4, GIT_EMODIFIED == -15, GIT_ENOTFOUND == -3
      if (e?.errno === -4 || e?.errno === -15 || e?.errno === -3) throw new RefConflictError(name);
      throw err;
    }
  }

  async deleteRef(name: string, expectedOld?: string): Promise<void> {
    const NG = ng();
    if (expectedOld !== undefined) {
      const current = await this.readRefTarget(name);
      if (current !== expectedOld) throw new RefConflictError(name);
    }
    const rc = NG.Reference.remove(this.repo, name);
    if (typeof rc === 'number' && rc < 0) throw new RefConflictError(name);
  }

  private async readRefTarget(name: string): Promise<string | null> {
    const NG = ng();
    try {
      const ref = await NG.Reference.lookup(this.repo, name);
      return ref.target().tostrS();
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async createAnnotatedTag(name: string, targetOid: string, message: string, tagger: { name: string; email: string }): Promise<string> {
    const NG = ng();
    const target = await NG.Object.lookup(this.repo, NG.Oid.fromString(targetOid), NG.Object.TYPE.COMMIT);
    const sig = NG.Signature.now(tagger.name || tagger.email, tagger.email);
    try {
      const oid = await NG.Tag.create(this.repo, name, target, sig, message, 0);
      return oid.tostrS();
    } catch (err) {
      const e = err as { errno?: number };
      if (e?.errno === -4) throw new RefConflictError('refs/tags/' + name);
      throw err;
    }
  }

  async getHeadTarget(): Promise<string> {
    const NG = ng();
    const ref = await NG.Reference.lookup(this.repo, 'HEAD');
    return ref.symbolicTarget();
  }

  async setHead(refName: string): Promise<void> {
    await this.repo.setHead(refName);
  }
}

export class NodegitBackend implements GitBackend {
  readonly name = 'libgit2 (nodegit)';

  async open(path: string): Promise<GitRepo> {
    const repo = await ng().Repository.openBare(path);
    return new NodegitRepo(path, repo);
  }

  async openOrInit(path: string): Promise<GitRepo> {
    if (existsSync(path)) return this.open(path);
    const repo = await ng().Repository.init(path, 1);
    const wrapped = new NodegitRepo(path, repo);
    await wrapped.setHead('refs/heads/main');
    return wrapped;
  }
}
