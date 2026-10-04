// Backend-neutral interface to a bare Git repository. All access goes
// through object and reference APIs; no working directory is ever used.
// The default implementation is libgit2 via nodegit (see nodegit.ts); an
// alternative libgit2 binding can be plugged in by implementing GitBackend.

export type EntryType = 'blob' | 'tree' | 'commit';

export interface TreeEntry {
  name: string;
  oid: string;
  type: EntryType;
  mode: number;
}

export interface Person {
  name: string;
  email: string;
  // Seconds since the epoch.
  time: number;
}

export interface CommitInfo {
  oid: string;
  treeOid: string;
  parents: string[];
  message: string;
  author: Person;
  committer: Person;
}

export interface RefInfo {
  name: string;
  // Object the reference points to directly.
  oid: string;
  // Commit the reference eventually resolves to (differs for annotated tags).
  commitOid: string | null;
}

// Map of slash-separated paths to new file contents; null deletes the path.
export type TreeChanges = Map<string, Uint8Array | null>;

export class RefConflictError extends Error {
  constructor(ref: string) {
    super(`reference ${ref} was changed concurrently`);
    this.name = 'RefConflictError';
  }
}

// Whether a path segment names the .git directory on some file system:
// case-insensitive (Windows, macOS), with trailing dots or spaces or as
// the 8.3 short name (NTFS), or with characters HFS+ ignores. Git
// clients refuse such paths; they are never written.
export function isGitDirName(segment: string): boolean {
  const s = segment.replace(/[\u200b-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g, '').toLowerCase().replace(/[. ]+$/, '');
  return s === '.git' || s === 'git~1';
}

export class PathConflictError extends Error {
  constructor(path: string) {
    super(`path conflict at ${path}`);
    this.name = 'PathConflictError';
  }
}

export interface GitRepo {
  readonly path: string;
  resolveRef(name: string): Promise<string | null>;
  listRefs(prefix: string): Promise<RefInfo[]>;
  getCommit(oid: string): Promise<CommitInfo | null>;
  log(startOid: string, limit: number, skip?: number): Promise<CommitInfo[]>;
  readTree(treeOid: string): Promise<TreeEntry[]>;
  lookupPath(treeOid: string, path: string): Promise<TreeEntry | null>;
  readBlob(oid: string): Promise<Uint8Array>;
  writeTree(baseTreeOid: string | null, changes: TreeChanges): Promise<string>;
  createCommit(opts: {
    treeOid: string;
    parents: string[];
    message: string;
    author: { name: string; email: string };
  }): Promise<string>;
  // Moves a reference. expectedOld === null means the reference must not
  // exist yet. Throws RefConflictError on mismatch.
  updateRef(name: string, newOid: string, expectedOld: string | null): Promise<void>;
  deleteRef(name: string, expectedOld?: string): Promise<void>;
  createAnnotatedTag(name: string, targetOid: string, message: string, tagger: { name: string; email: string }): Promise<string>;
  getHeadTarget(): Promise<string>;
  setHead(refName: string): Promise<void>;
}

export interface GitBackend {
  name: string;
  // Opens a bare repository, creating it if it does not exist.
  openOrInit(path: string): Promise<GitRepo>;
  open(path: string): Promise<GitRepo>;
}
