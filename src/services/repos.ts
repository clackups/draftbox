import { spawn } from 'node:child_process';
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { processOutput } from '../util/process.ts';
import type { Context } from './context.ts';
import { ServiceError } from './context.ts';
import { indexVisibility, type Repo, type User, type Visibility } from '../db/models.ts';
import type { CommitInfo, GitRepo, RefInfo, TreeChanges, TreeEntry } from '../git/types.ts';
import { PathConflictError, RefConflictError, isGitDirName } from '../git/types.ts';
import { randomId } from '../util/crypto.ts';
import { deleteUserTokens } from './tokens.ts';

export const REPO_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;
export const DEFAULT_BRANCH = 'main';

export function validRepoName(name: string): boolean {
  return REPO_NAME_RE.test(name) && !name.toLowerCase().endsWith('.git') && !name.includes('..');
}

// Branch and tag names: conservative subset of git check-ref-format.
export function validRefName(name: string): boolean {
  if (!/^[A-Za-z0-9._\/-]{1,200}$/.test(name)) return false;
  if (name.startsWith('/') || name.endsWith('/') || name.endsWith('.') || name.startsWith('-')) return false;
  if (name.includes('..') || name.includes('//') || name.includes('@{')) return false;
  return !name.split('/').some((p) => p.startsWith('.') || p.endsWith('.lock'));
}

export function validFilePath(path: string): boolean {
  if (path.length === 0 || path.length > 1000) return false;
  const parts = path.split('/');
  return parts.every((p) => p.length > 0 && p !== '.' && p !== '..' && !isGitDirName(p) && !/[\x00-\x1f]/.test(p));
}

export interface Author {
  name: string;
  email: string;
}

export class RepoService {
  private ctx: Context;

  constructor(ctx: Context) {
    this.ctx = ctx;
  }

  private get store() {
    return this.ctx.store;
  }

  async getById(id: string): Promise<Repo | null> {
    if (!/^[0-9a-f]{16}$/.test(id)) return null;
    return this.store.view().get<Repo>(`repos/${id}.json`);
  }

  async getByName(owner: User, name: string): Promise<Repo | null> {
    if (!validRepoName(name)) return null;
    const view = this.store.view();
    const id = await view.getText(`index/repo/${owner.id}/${name}`);
    return id ? view.get<Repo>(`repos/${id}.json`) : null;
  }

  async listByOwner(ownerId: string): Promise<Repo[]> {
    const view = this.store.view();
    const out: Repo[] = [];
    for (const name of await view.list(`index/repo/${ownerId}`)) {
      const id = await view.getText(`index/repo/${ownerId}/${name}`);
      const repo = id ? await view.get<Repo>(`repos/${id}.json`) : null;
      if (repo) out.push(repo);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  // Public repositories whose owners are not blocked.
  async listPublic(): Promise<Array<{ repo: Repo; owner: User }>> {
    const view = this.store.view();
    const out: Array<{ repo: Repo; owner: User }> = [];
    const owners = new Map<string, User | null>();
    for (const id of await view.list('index/public')) {
      const repo = await view.get<Repo>(`repos/${id}.json`);
      if (!repo || repo.visibility !== 'public') continue;
      if (!owners.has(repo.ownerId)) owners.set(repo.ownerId, await view.get<User>(`users/${repo.ownerId}.json`));
      const owner = owners.get(repo.ownerId);
      if (owner && !owner.blocked) out.push({ repo, owner });
    }
    return out.sort((a, b) => b.repo.createdAt.localeCompare(a.repo.createdAt));
  }

  // Creates an empty repository.
  async create(owner: User, opts: { name: string; description: string; visibility: Visibility }): Promise<Repo> {
    const name = opts.name.trim();
    if (!validRepoName(name)) throw new ServiceError('invalid_repo_name');
    const id = randomId();
    const repo: Repo = {
      id,
      ownerId: owner.id,
      name,
      description: opts.description.trim().slice(0, 500),
      visibility: opts.visibility === 'public' ? 'public' : 'private',
      createdAt: this.ctx.now(),
    };
    // Reserve the name first so that a failure leaves no orphan on disk.
    await this.store.transact(`Create repository ${owner.handle}/${name}`, async (tx) => {
      if (await tx.getText(`index/repo/${owner.id}/${name}`)) throw new ServiceError('repo_exists');
      tx.put(`repos/${id}.json`, repo);
      tx.putText(`index/repo/${owner.id}/${name}`, id);
      indexVisibility(tx, repo);
    });
    try {
      await this.ctx.git.openOrInit(this.ctx.repoPath(id));
    } catch (err) {
      await this.delete(repo, owner.handle).catch(() => undefined);
      throw err;
    }
    return repo;
  }

  async update(repo: Repo, patch: { name?: string; description?: string; visibility?: Visibility }, actor: string): Promise<Repo> {
    return this.store.transact(`Update repository ${repo.id} by ${actor}`, async (tx) => {
      const cur = await tx.get<Repo>(`repos/${repo.id}.json`);
      if (!cur) throw new ServiceError('not_found', 404);
      if (patch.name !== undefined && patch.name.trim() !== cur.name) {
        const name = patch.name.trim();
        if (!validRepoName(name)) throw new ServiceError('invalid_repo_name');
        if (await tx.getText(`index/repo/${cur.ownerId}/${name}`)) throw new ServiceError('repo_exists');
        tx.delete(`index/repo/${cur.ownerId}/${cur.name}`);
        tx.putText(`index/repo/${cur.ownerId}/${name}`, cur.id);
        cur.name = name;
      }
      if (patch.description !== undefined) cur.description = patch.description.trim().slice(0, 500);
      if (patch.visibility !== undefined) cur.visibility = patch.visibility === 'public' ? 'public' : 'private';
      tx.put(`repos/${cur.id}.json`, cur);
      indexVisibility(tx, cur);
      return cur;
    });
  }

  async delete(repo: Repo, actor: string): Promise<void> {
    await this.store.transact(`Delete repository ${repo.id} by ${actor}`, async (tx) => {
      tx.delete(`repos/${repo.id}.json`);
      tx.delete(`index/repo/${repo.ownerId}/${repo.name}`);
      tx.delete(`index/public/${repo.id}`);
      // Repository-scoped tokens become useless; remove them as well.
      // They always belong to the owner.
      await deleteUserTokens(tx, repo.ownerId, (t) => t.repoId === repo.id);
    });
    await rm(this.ctx.repoPath(repo.id), { recursive: true, force: true });
  }

  async open(repo: Repo): Promise<GitRepo> {
    return this.ctx.git.open(this.ctx.repoPath(repo.id));
  }

  // When a branch of the repository last changed (or when it was
  // created), in milliseconds since the epoch. Every commit or push
  // rewrites a branch ref file or packed-refs, so their modification
  // times tell without opening the repository.
  async lastUpdated(repo: Repo): Promise<number> {
    let latest = Date.parse(repo.createdAt);
    const dir = this.ctx.repoPath(repo.id);
    const files = [join(dir, 'packed-refs')];
    try {
      for (const f of await readdir(join(dir, 'refs', 'heads'), { recursive: true, withFileTypes: true })) {
        if (f.isFile()) files.push(join(f.parentPath, f.name));
      }
    } catch {
      // No branches yet.
    }
    for (const f of files) {
      const st = await stat(f).catch(() => null);
      if (st) latest = Math.max(latest, st.mtimeMs);
    }
    return latest;
  }

  // ZIP archive of the files at a commit, each under `prefix/`. libgit2
  // has no archive support, so `git archive` produces it. Fails when git
  // fails before writing; a later failure aborts the stream.
  async archive(repo: Repo, commitOid: string, prefix: string): Promise<ReadableStream<Uint8Array>> {
    if (!/^[0-9a-f]{40}$/.test(commitOid)) throw new ServiceError('not_found', 404);
    const child = spawn(this.ctx.config.gitBinary, [
      '--git-dir', this.ctx.repoPath(repo.id), 'archive', '--format=zip', `--prefix=${prefix}/`, commitOid,
    ], { env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', HOME: '/nonexistent' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const output = processOutput(child, 'git archive');
    if ((await output.start) === 'failed') throw new ServiceError('internal', 500);
    return output.body;
  }

  // ---- Content operations -------------------------------------------------

  async branches(git: GitRepo): Promise<RefInfo[]> {
    return git.listRefs('refs/heads/');
  }

  async tags(git: GitRepo): Promise<RefInfo[]> {
    return git.listRefs('refs/tags/');
  }

  // Branch that HEAD points to (what a fresh clone checks out).
  async defaultBranch(git: GitRepo): Promise<string> {
    const target = await git.getHeadTarget();
    return target.startsWith('refs/heads/') ? target.slice('refs/heads/'.length) : DEFAULT_BRANCH;
  }

  async resolveBranch(git: GitRepo, branch: string): Promise<string | null> {
    if (!validRefName(branch)) return null;
    return git.resolveRef(`refs/heads/${branch}`);
  }

  // Resolves a branch name, tag name or full commit id to a commit.
  async resolveRevision(git: GitRepo, rev: string): Promise<string | null> {
    if (/^[0-9a-f]{40}$/.test(rev)) return (await git.getCommit(rev)) ? rev : null;
    if (!validRefName(rev)) return null;
    return (await git.resolveRef(`refs/heads/${rev}`)) ?? (await git.resolveRef(`refs/tags/${rev}`));
  }

  async treeAt(git: GitRepo, commitOid: string, path: string): Promise<{ entry: TreeEntry; entries?: TreeEntry[] } | null> {
    const commit = await git.getCommit(commitOid);
    if (!commit) return null;
    const entry = await git.lookupPath(commit.treeOid, path);
    if (!entry) return null;
    if (entry.type === 'tree') {
      const entries = await git.readTree(entry.oid);
      entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'tree' ? -1 : 1));
      return { entry, entries };
    }
    return { entry };
  }

  // Commits changes on top of a branch. expectedHead protects against
  // overwriting concurrent changes: pass the commit the edit was based on,
  // or null when the branch is expected to not exist yet.
  async commitFiles(git: GitRepo, branch: string, expectedHead: string | null, changes: TreeChanges,
    message: string, author: Author): Promise<string> {
    if (!validRefName(branch)) throw new ServiceError('invalid_branch');
    for (const p of changes.keys()) if (!validFilePath(p)) throw new ServiceError('invalid_path');
    const current = await git.resolveRef(`refs/heads/${branch}`);
    if (current !== expectedHead) throw new ServiceError('edit_conflict', 409);
    const base = current ? await git.getCommit(current) : null;
    let treeOid: string;
    try {
      treeOid = await git.writeTree(base ? base.treeOid : null, changes);
    } catch (err) {
      if (err instanceof PathConflictError) throw new ServiceError('path_conflict');
      throw err;
    }
    const commitOid = await git.createCommit({
      treeOid,
      parents: current ? [current] : [],
      message: message.trim() || 'Update',
      author,
    });
    try {
      await git.updateRef(`refs/heads/${branch}`, commitOid, current);
    } catch (err) {
      if (err instanceof RefConflictError) throw new ServiceError('edit_conflict', 409);
      throw err;
    }
    return commitOid;
  }

  async createBranch(git: GitRepo, name: string, fromRev: string): Promise<void> {
    if (!validRefName(name)) throw new ServiceError('invalid_branch');
    const oid = await this.resolveRevision(git, fromRev);
    if (!oid) throw new ServiceError('not_found', 404);
    try {
      await git.updateRef(`refs/heads/${name}`, oid, null);
    } catch (err) {
      if (err instanceof RefConflictError) throw new ServiceError('branch_exists');
      throw err;
    }
  }

  // `expectedOid` is the value of the ref when the user chose to delete
  // it; a ref changed since (e.g. by a push) is kept.
  async deleteBranch(git: GitRepo, name: string, expectedOid: string): Promise<void> {
    if (name === DEFAULT_BRANCH) throw new ServiceError('cannot_delete_main');
    if (!validRefName(name) || !(await git.resolveRef(`refs/heads/${name}`))) throw new ServiceError('not_found', 404);
    await deleteRefIfUnchanged(git, `refs/heads/${name}`, expectedOid);
  }

  async createTag(git: GitRepo, name: string, fromRev: string, message: string, tagger: Author): Promise<void> {
    if (!validRefName(name)) throw new ServiceError('invalid_tag');
    const oid = await this.resolveRevision(git, fromRev);
    if (!oid) throw new ServiceError('not_found', 404);
    if (await git.resolveRef(`refs/tags/${name}`)) throw new ServiceError('tag_exists');
    try {
      if (message.trim()) {
        await git.createAnnotatedTag(name, oid, message.trim() + '\n', tagger);
      } else {
        await git.updateRef(`refs/tags/${name}`, oid, null);
      }
    } catch (err) {
      if (err instanceof RefConflictError) throw new ServiceError('tag_exists');
      throw err;
    }
  }

  async deleteTag(git: GitRepo, name: string, expectedOid: string): Promise<void> {
    if (!validRefName(name) || !(await git.resolveRef(`refs/tags/${name}`))) throw new ServiceError('not_found', 404);
    await deleteRefIfUnchanged(git, `refs/tags/${name}`, expectedOid);
  }

  async log(git: GitRepo, commitOid: string, limit: number, skip: number): Promise<CommitInfo[]> {
    return git.log(commitOid, limit, skip);
  }

  // The most recent commit, reachable from `commitOid`, that changed the
  // file at `path` relative to its first parent. Gives up (null) after
  // `maxCommits` commits so that long histories stay cheap.
  async lastChange(git: GitRepo, commitOid: string, path: string, maxCommits = 1000): Promise<CommitInfo | null> {
    // A commit's parent is usually the next commit of the log: cache by tree.
    const seen = new Map<string, string | null>();
    const blobAt = async (treeOid: string | undefined) => {
      if (!treeOid) return null;
      let oid = seen.get(treeOid);
      if (oid === undefined) {
        oid = (await git.lookupPath(treeOid, path))?.oid ?? null;
        seen.set(treeOid, oid);
      }
      return oid;
    };
    let n = 0;
    for await (const c of git.walk(commitOid)) {
      if (++n > maxCommits) break;
      const parent = c.parents[0] ? await git.getCommit(c.parents[0]) : null;
      if ((await blobAt(c.treeOid)) !== (await blobAt(parent?.treeOid))) return c;
    }
    return null;
  }

  // Lists paths changed by a commit relative to its first parent.
  async changedPaths(git: GitRepo, commit: CommitInfo): Promise<Array<{ path: string; status: 'added' | 'modified' | 'deleted' }>> {
    const parent = commit.parents[0] ? await git.getCommit(commit.parents[0]) : null;
    const out: Array<{ path: string; status: 'added' | 'modified' | 'deleted' }> = [];
    await diffTrees(git, parent ? parent.treeOid : null, commit.treeOid, '', out);
    return out;
  }
}

async function deleteRefIfUnchanged(git: GitRepo, ref: string, expectedOid: string): Promise<void> {
  try {
    await git.deleteRef(ref, expectedOid);
  } catch (err) {
    if (err instanceof RefConflictError) throw new ServiceError('ref_changed', 409);
    throw err;
  }
}

async function diffTrees(git: GitRepo, a: string | null, b: string | null, prefix: string,
  out: Array<{ path: string; status: 'added' | 'modified' | 'deleted' }>): Promise<void> {
  if (a === b) return;
  const ea = new Map((a ? await git.readTree(a) : []).map((e) => [e.name, e]));
  const eb = new Map((b ? await git.readTree(b) : []).map((e) => [e.name, e]));
  const names = [...new Set([...ea.keys(), ...eb.keys()])].sort();
  for (const name of names) {
    const x = ea.get(name);
    const y = eb.get(name);
    const path = prefix + name;
    if (x && y && x.oid === y.oid) continue;
    const xt = x?.type === 'tree' ? x.oid : null;
    const yt = y?.type === 'tree' ? y.oid : null;
    if (xt || yt) await diffTrees(git, xt, yt, path + '/', out);
    if (x && x.type !== 'tree' && (!y || y.type === 'tree')) out.push({ path, status: 'deleted' });
    else if (y && y.type !== 'tree' && (!x || x.type === 'tree')) out.push({ path, status: 'added' });
    else if (x && y && x.type !== 'tree' && y.type !== 'tree') out.push({ path, status: 'modified' });
    if (out.length > 1000) return;
  }
}
