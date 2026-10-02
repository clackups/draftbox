import type { Hono } from 'hono';
import { type AppEnv, type Ctx, type Services, formFields, requireUser, setFlash } from './app.ts';
import { ServiceError } from '../services/context.ts';
import { DEFAULT_BRANCH, validFilePath } from '../services/repos.ts';
import type { Visibility } from '../db/models.ts';
import { isMarkdownPath, renderMarkdown, type LinkResolver } from '../util/markdown.ts';
import { diffLines, hunks } from '../util/diff.ts';
import { urlPath } from '../views/html.ts';
import {
  type FileChange, type RepoCtx, blobPage, branchesPage, commitPage, commitsPage, editPage, emptyRepoPage,
  explorePage, homePage, landingPage, newRepoPage, profilePage, repoSettingsPage, repoUrl, tagsPage, treePage,
  uploadPage, withRef,
} from '../views/repo.ts';

const MAX_EDIT_BYTES = 1024 * 1024;
const MAX_DIFF_BYTES = 256 * 1024;
const MAX_DIFF_FILES = 50;
const COMMITS_PER_PAGE = 30;

const utf8 = new TextDecoder('utf-8', { fatal: true });
const enc = new TextEncoder();

// Decodes file contents as text, or returns null for binary data.
function asText(data: Uint8Array): string | null {
  if (data.subarray(0, 8000).includes(0)) return null;
  try {
    return utf8.decode(data);
  } catch {
    return null;
  }
}

function normalizeNewlines(s: string): string {
  return s.replace(/\r\n?/g, '\n');
}

function joinPath(dir: string, name: string): string {
  return [...dir.split('/'), ...name.split('/')].map((s) => s.trim()).filter(Boolean).join('/');
}

// Extracts the file path following /<owner>/<repo>/<marker>/ in the URL.
function subPath(c: Ctx, marker: string): string {
  const prefix = `/${c.req.param('owner')}/${c.req.param('repo')}/${marker}`;
  const raw = c.req.path.startsWith(prefix) ? c.req.path.slice(prefix.length) : '';
  try {
    return raw.split('/').filter(Boolean).map(decodeURIComponent).join('/');
  } catch {
    throw new ServiceError('not_found', 404);
  }
}

function resolver(rc: RepoCtx, dir: string): LinkResolver {
  return {
    dir,
    link: (p) => withRef(rc, repoUrl(rc, 'blob', p)),
    image: (p) => withRef(rc, repoUrl(rc, 'raw', p)),
  };
}

async function loadRepo(c: Ctx, svc: Services, opts: { owner?: boolean; ref?: string } = {}): Promise<RepoCtx> {
  const page = c.var.page;
  const viewer = page.user;
  const owner = await svc.users.getByHandle(c.req.param('owner') ?? '');
  if (!owner) throw new ServiceError('not_found', 404);
  const isOwner = viewer?.id === owner.id;
  if (owner.blocked && !isOwner) throw new ServiceError('not_found', 404);
  const repo = await svc.repos.getByName(owner, c.req.param('repo') ?? '');
  if (!repo || (repo.visibility !== 'public' && !isOwner)) throw new ServiceError('not_found', 404);
  if (opts.owner && !isOwner) throw new ServiceError('forbidden', 403);

  const git = await svc.repos.open(repo);
  const advanced = viewer?.prefs.advancedMode ?? false;
  let ref = opts.ref ?? c.req.query('ref') ?? DEFAULT_BRANCH;
  let refKind: RepoCtx['refKind'] = 'branch';
  let commitOid: string | null = null;

  if (/^[0-9a-f]{40}$/.test(ref)) {
    refKind = 'commit';
    commitOid = (await git.getCommit(ref)) ? ref : null;
    if (!commitOid) throw new ServiceError('not_found', 404);
  } else {
    const branchOid = await svc.repos.resolveBranch(git, ref);
    if (branchOid && (advanced || ref === DEFAULT_BRANCH)) {
      commitOid = branchOid;
    } else {
      const tagOid = await git.resolveRef(`refs/tags/${ref}`).catch(() => null);
      if (tagOid) {
        refKind = 'tag';
        commitOid = tagOid;
      } else if (ref === DEFAULT_BRANCH || !advanced) {
        // Simple mode only shows the main branch, which may be unborn.
        ref = DEFAULT_BRANCH;
        commitOid = await svc.repos.resolveBranch(git, DEFAULT_BRANCH);
      } else {
        throw new ServiceError('not_found', 404);
      }
    }
  }
  const branches = advanced ? await svc.repos.branches(git) : [];
  return {
    page, owner, repo, git, isOwner, advanced, ref, refKind, commitOid, branches,
    cloneUrl: `${svc.ctx.config.baseUrl}${urlPath(owner.handle, repo.name)}.git`,
  };
}

function requireBranch(rc: RepoCtx): void {
  if (rc.refKind !== 'branch') throw new ServiceError('not_a_branch');
}

function author(c: Ctx): { name: string; email: string } {
  const u = requireUser(c);
  return { name: u.name, email: u.email };
}

export function registerRepoRoutes(app: Hono<AppEnv>, svc: Services): void {
  app.get('/', async (c) => {
    const user = c.var.page.user;
    if (!user) return c.html(landingPage(c.var.page));
    return c.html(homePage(c.var.page, user, await svc.repos.listByOwner(user.id)));
  });

  app.get('/explore', async (c) => c.html(explorePage(c.var.page, await svc.repos.listPublic())));

  app.get('/new', (c) => {
    requireUser(c);
    return c.html(newRepoPage(c.var.page, { name: '', description: '', visibility: 'private' }));
  });

  app.post('/new', async (c) => {
    const user = requireUser(c);
    const f = await formFields(c);
    const values = { name: (f.name ?? '').trim(), description: f.description ?? '', visibility: (f.visibility === 'public' ? 'public' : 'private') as Visibility };
    try {
      const repo = await svc.repos.create(user, { ...values, initReadme: f.readme === '1' });
      setFlash(c, 'ok', 'repo_created');
      return c.redirect(urlPath(user.handle, repo.name));
    } catch (err) {
      if (err instanceof ServiceError && err.status === 400) return c.html(newRepoPage(c.var.page, values, err.code), 400);
      throw err;
    }
  });

  app.post('/preview', async (c) => {
    requireUser(c);
    const f = await formFields(c);
    return c.json({ html: renderMarkdown(normalizeNewlines(f.content ?? '').slice(0, MAX_EDIT_BYTES)) });
  });

  app.get('/:owner', async (c) => {
    const owner = await svc.users.getByHandle(c.req.param('owner'));
    const viewer = c.var.page.user;
    if (!owner || (owner.blocked && viewer?.id !== owner.id)) return c.notFound();
    const repos = (await svc.repos.listByOwner(owner.id)).filter((r) => r.visibility === 'public' || viewer?.id === owner.id);
    return c.html(profilePage(c.var.page, owner, repos));
  });

  // ---- Browsing -----------------------------------------------------------

  const showTree = async (c: Ctx, path: string) => {
    const rc = await loadRepo(c, svc);
    if (!rc.commitOid) {
      if (path) return c.notFound();
      return c.html(emptyRepoPage(rc));
    }
    const found = await svc.repos.treeAt(rc.git, rc.commitOid, path);
    if (!found) return c.notFound();
    if (!found.entries) return c.redirect(withRef(rc, repoUrl(rc, 'blob', path)));
    const readmeEntry = found.entries.find((e) => e.type === 'blob' && /^readme(\.(md|markdown|txt))?$/i.test(e.name));
    let readme: { name: string; html: string } | null = null;
    if (readmeEntry) {
      const text = asText(await rc.git.readBlob(readmeEntry.oid));
      if (text !== null) {
        readme = {
          name: readmeEntry.name,
          html: isMarkdownPath(readmeEntry.name) ? renderMarkdown(text, resolver(rc, path)) : `<pre>${text.replace(/[&<>]/g, (ch) => (ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : '&gt;'))}</pre>`,
        };
      }
    }
    const head = await rc.git.getCommit(rc.commitOid);
    return c.html(treePage(rc, path, found.entries, readme, head));
  };

  app.get('/:owner/:repo', (c) => showTree(c, ''));
  app.get('/:owner/:repo/tree', (c) => showTree(c, ''));
  app.get('/:owner/:repo/tree/*', (c) => showTree(c, subPath(c, 'tree')));

  app.get('/:owner/:repo/blob/*', async (c) => {
    const rc = await loadRepo(c, svc);
    const path = subPath(c, 'blob');
    if (!rc.commitOid || !path) return c.notFound();
    const found = await svc.repos.treeAt(rc.git, rc.commitOid, path);
    if (!found) return c.notFound();
    if (found.entries) return c.redirect(withRef(rc, repoUrl(rc, 'tree', path)));
    const data = await rc.git.readBlob(found.entry.oid);
    const text = asText(data);
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    const rendered = text !== null && isMarkdownPath(path) ? renderMarkdown(text, resolver(rc, dir)) : null;
    return c.html(blobPage(rc, { path, size: data.length, text, rendered, showSource: c.req.query('source') === '1' }));
  });

  app.get('/:owner/:repo/raw/*', async (c) => {
    const rc = await loadRepo(c, svc);
    const path = subPath(c, 'raw');
    if (!rc.commitOid || !path) return c.notFound();
    const found = await svc.repos.treeAt(rc.git, rc.commitOid, path);
    if (!found || found.entries) return c.notFound();
    const data = await rc.git.readBlob(found.entry.oid);
    const ext = (path.split('.').pop() ?? '').toLowerCase();
    const images: Record<string, string> = {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon',
    };
    const headers: Record<string, string> = {
      // User content must never run scripts in the site's origin.
      'Content-Security-Policy': "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'",
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-cache',
    };
    if (images[ext]) {
      headers['Content-Type'] = images[ext];
    } else if (asText(data) !== null) {
      headers['Content-Type'] = 'text/plain; charset=utf-8';
    } else {
      headers['Content-Type'] = 'application/octet-stream';
      headers['Content-Disposition'] = `attachment; filename="${(path.split('/').pop() ?? 'file').replace(/[^A-Za-z0-9._-]/g, '_')}"`;
    }
    return c.body(data as Uint8Array<ArrayBuffer>, 200, headers);
  });

  // ---- Editing ------------------------------------------------------------

  app.get('/:owner/:repo/edit/*', async (c) => {
    const rc = await loadRepo(c, svc, { owner: true });
    requireBranch(rc);
    const path = subPath(c, 'edit');
    if (!rc.commitOid || !path) return c.notFound();
    const found = await svc.repos.treeAt(rc.git, rc.commitOid, path);
    if (!found || found.entries) return c.notFound();
    const data = await rc.git.readBlob(found.entry.oid);
    const text = asText(data);
    if (text === null || data.length > MAX_EDIT_BYTES) throw new ServiceError('not_editable');
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    return c.html(editPage(rc, { path, dir, isNew: false, content: text, base: rc.commitOid, message: '' }));
  });

  app.post('/:owner/:repo/edit/*', async (c) => {
    const f = await formFields(c);
    const rc = await loadRepo(c, svc, { owner: true, ref: f.ref });
    requireBranch(rc);
    const path = subPath(c, 'edit');
    const dir = f.dir ?? '';
    const newPath = joinPath(dir, f.name ?? '');
    const content = normalizeNewlines(f.content ?? '');
    const view = { path, dir, isNew: false, content, base: f.base ?? '', message: f.message ?? '' };
    if (!validFilePath(newPath)) return c.html(editPage(rc, { ...view, error: 'invalid_path' }), 400);
    const changes = new Map<string, Uint8Array | null>([[newPath, enc.encode(content)]]);
    if (newPath !== path) {
      if (rc.commitOid && (await rc.git.lookupPath((await rc.git.getCommit(rc.commitOid))!.treeOid, newPath))) {
        return c.html(editPage(rc, { ...view, error: 'file_exists' }), 400);
      }
      changes.set(path, null);
    }
    const message = (f.message ?? '').trim() || (newPath !== path ? `Rename ${path} to ${newPath}` : `Update ${path}`);
    try {
      await svc.repos.commitFiles(rc.git, rc.ref, f.base || null, changes, message, author(c));
    } catch (err) {
      if (err instanceof ServiceError && (err.code === 'edit_conflict' || err.status === 400)) {
        // Keep the user's text; saving again applies it on top of the latest version.
        return c.html(editPage(rc, { ...view, base: rc.commitOid ?? '', error: err.code }), 409);
      }
      throw err;
    }
    setFlash(c, 'ok', 'file_saved');
    return c.redirect(withRef(rc, repoUrl(rc, 'blob', newPath)));
  });

  app.get('/:owner/:repo/new', async (c) => {
    const rc = await loadRepo(c, svc, { owner: true });
    requireBranch(rc);
    const dir = joinPath(c.req.query('dir') ?? '', '');
    return c.html(editPage(rc, { path: '', dir, isNew: true, content: '', base: rc.commitOid ?? '', message: '' }));
  });

  app.post('/:owner/:repo/new', async (c) => {
    const f = await formFields(c);
    const rc = await loadRepo(c, svc, { owner: true, ref: f.ref });
    requireBranch(rc);
    const dir = joinPath(f.dir ?? '', '');
    const name = (f.name ?? '').trim();
    const path = joinPath(dir, name);
    const content = normalizeNewlines(f.content ?? '');
    const view = { path: name, dir, isNew: true, content, base: f.base ?? '', message: f.message ?? '' };
    if (!validFilePath(path)) return c.html(editPage(rc, { ...view, error: 'invalid_path' }), 400);
    if (rc.commitOid && (await rc.git.lookupPath((await rc.git.getCommit(rc.commitOid))!.treeOid, path))) {
      return c.html(editPage(rc, { ...view, error: 'file_exists' }), 400);
    }
    try {
      await svc.repos.commitFiles(rc.git, rc.ref, f.base || null, new Map([[path, enc.encode(content)]]),
        (f.message ?? '').trim() || `Create ${path}`, author(c));
    } catch (err) {
      if (err instanceof ServiceError && (err.code === 'edit_conflict' || err.status === 400)) {
        return c.html(editPage(rc, { ...view, base: rc.commitOid ?? '', error: err.code }), 409);
      }
      throw err;
    }
    setFlash(c, 'ok', 'file_saved');
    return c.redirect(withRef(rc, repoUrl(rc, 'blob', path)));
  });

  app.get('/:owner/:repo/upload', async (c) => {
    const rc = await loadRepo(c, svc, { owner: true });
    requireBranch(rc);
    return c.html(uploadPage(rc, joinPath(c.req.query('dir') ?? '', ''), rc.commitOid ?? ''));
  });

  app.post('/:owner/:repo/upload', async (c) => {
    const body = await c.req.parseBody({ all: true });
    const str = (k: string) => (typeof body[k] === 'string' ? (body[k] as string) : '');
    const rc = await loadRepo(c, svc, { owner: true, ref: str('ref') });
    requireBranch(rc);
    const dir = joinPath(str('dir'), '');
    const raw = body.files;
    const files = (Array.isArray(raw) ? raw : [raw]).filter((x): x is File => x instanceof File && x.name !== '');
    if (files.length === 0) return c.html(uploadPage(rc, dir, str('base'), 'no_files'), 400);
    const changes = new Map<string, Uint8Array | null>();
    for (const file of files) {
      const path = joinPath(dir, file.name.split(/[\\/]/).pop() ?? '');
      if (!validFilePath(path)) return c.html(uploadPage(rc, dir, str('base'), 'invalid_path'), 400);
      changes.set(path, new Uint8Array(await file.arrayBuffer()));
    }
    const message = str('message').trim() || (files.length === 1 ? `Upload ${joinPath(dir, files[0].name)}` : `Upload ${files.length} files`);
    try {
      await svc.repos.commitFiles(rc.git, rc.ref, str('base') || null, changes, message, author(c));
    } catch (err) {
      if (err instanceof ServiceError && (err.code === 'edit_conflict' || err.status === 400)) {
        return c.html(uploadPage(rc, dir, rc.commitOid ?? '', err.code), 409);
      }
      throw err;
    }
    setFlash(c, 'ok', 'files_uploaded');
    return c.redirect(withRef(rc, dir ? repoUrl(rc, 'tree', dir) : repoUrl(rc)));
  });

  app.post('/:owner/:repo/delete/*', async (c) => {
    const f = await formFields(c);
    const rc = await loadRepo(c, svc, { owner: true, ref: f.ref });
    requireBranch(rc);
    const path = subPath(c, 'delete');
    if (!path) return c.notFound();
    await svc.repos.commitFiles(rc.git, rc.ref, f.base || null, new Map([[path, null]]), `Delete ${path}`, author(c));
    setFlash(c, 'ok', 'file_deleted');
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    // The directory disappears with its last file; fall back to the root.
    const head = await svc.repos.resolveBranch(rc.git, rc.ref);
    const dirExists = dir && head ? await svc.repos.treeAt(rc.git, head, dir) : null;
    return c.redirect(withRef(rc, dirExists ? repoUrl(rc, 'tree', dir) : repoUrl(rc)));
  });

  // ---- History ------------------------------------------------------------

  app.get('/:owner/:repo/commits', async (c) => {
    const rc = await loadRepo(c, svc);
    const pageNo = Math.max(1, Number(c.req.query('page')) || 1);
    if (!rc.commitOid) return c.html(commitsPage(rc, [], 1, false));
    const commits = await svc.repos.log(rc.git, rc.commitOid, COMMITS_PER_PAGE + 1, (pageNo - 1) * COMMITS_PER_PAGE);
    return c.html(commitsPage(rc, commits.slice(0, COMMITS_PER_PAGE), pageNo, commits.length > COMMITS_PER_PAGE));
  });

  app.get('/:owner/:repo/commit/:oid', async (c) => {
    const rc = await loadRepo(c, svc);
    const oid = c.req.param('oid');
    if (!/^[0-9a-f]{40}$/.test(oid)) return c.notFound();
    const commit = await rc.git.getCommit(oid);
    if (!commit) return c.notFound();
    const parent = commit.parents[0] ? await rc.git.getCommit(commit.parents[0]) : null;
    const paths = await svc.repos.changedPaths(rc.git, commit);
    const changes: FileChange[] = [];
    for (const [i, ch] of paths.entries()) {
      const change: FileChange = { ...ch, hunks: null };
      changes.push(change);
      if (i >= MAX_DIFF_FILES) {
        change.note = 'repo.diff_skipped';
        continue;
      }
      const read = async (treeOid: string | undefined) => {
        if (!treeOid) return new Uint8Array();
        const e = await rc.git.lookupPath(treeOid, ch.path);
        return e && e.type === 'blob' ? rc.git.readBlob(e.oid) : new Uint8Array();
      };
      const before = ch.status === 'added' ? new Uint8Array() : await read(parent?.treeOid);
      const after = ch.status === 'deleted' ? new Uint8Array() : await read(commit.treeOid);
      if (before.length > MAX_DIFF_BYTES || after.length > MAX_DIFF_BYTES) {
        change.note = 'repo.diff_too_large';
        continue;
      }
      const a = asText(before);
      const b = asText(after);
      if (a === null || b === null) {
        change.note = 'repo.diff_binary';
        continue;
      }
      const ops = diffLines(a, b);
      if (!ops) change.note = 'repo.diff_too_large';
      else change.hunks = hunks(ops);
    }
    return c.html(commitPage(rc, commit, changes));
  });

  // ---- Tags and branches --------------------------------------------------

  app.get('/:owner/:repo/tags', async (c) => {
    const rc = await loadRepo(c, svc);
    const refs = await svc.repos.tags(rc.git);
    const rows = await Promise.all(refs.map(async (r) => ({
      name: r.name.slice('refs/tags/'.length),
      commit: r.commitOid ? await rc.git.getCommit(r.commitOid) : null,
    })));
    rows.sort((a, b) => (b.commit?.committer.time ?? 0) - (a.commit?.committer.time ?? 0));
    return c.html(tagsPage(rc, rows));
  });

  app.post('/:owner/:repo/tags', async (c) => {
    const rc = await loadRepo(c, svc, { owner: true });
    const f = await formFields(c);
    const target = rc.advanced ? (f.target || DEFAULT_BRANCH) : DEFAULT_BRANCH;
    await svc.repos.createTag(rc.git, (f.name ?? '').trim(), target, f.message ?? '', author(c));
    setFlash(c, 'ok', 'tag_created');
    return c.redirect(repoUrl(rc, 'tags'));
  });

  app.post('/:owner/:repo/tags/delete', async (c) => {
    const rc = await loadRepo(c, svc, { owner: true });
    const f = await formFields(c);
    await svc.repos.deleteTag(rc.git, f.name ?? '');
    setFlash(c, 'ok', 'tag_deleted');
    return c.redirect(repoUrl(rc, 'tags'));
  });

  app.get('/:owner/:repo/branches', async (c) => {
    const rc = await loadRepo(c, svc);
    if (!rc.advanced) return c.redirect(repoUrl(rc));
    const rows = await Promise.all(rc.branches.map(async (b) => ({
      name: b.name.slice('refs/heads/'.length),
      commit: b.commitOid ? await rc.git.getCommit(b.commitOid) : null,
    })));
    return c.html(branchesPage(rc, rows));
  });

  app.post('/:owner/:repo/branches', async (c) => {
    const rc = await loadRepo(c, svc, { owner: true });
    if (!rc.advanced) throw new ServiceError('advanced_mode_required', 403);
    const f = await formFields(c);
    const name = (f.name ?? '').trim();
    await svc.repos.createBranch(rc.git, name, f.from || DEFAULT_BRANCH);
    setFlash(c, 'ok', 'branch_created');
    return c.redirect(repoUrl(rc) + '?ref=' + encodeURIComponent(name));
  });

  app.post('/:owner/:repo/branches/delete', async (c) => {
    const rc = await loadRepo(c, svc, { owner: true });
    if (!rc.advanced) throw new ServiceError('advanced_mode_required', 403);
    const f = await formFields(c);
    await svc.repos.deleteBranch(rc.git, f.name ?? '');
    setFlash(c, 'ok', 'branch_deleted');
    return c.redirect(repoUrl(rc, 'branches'));
  });

  // ---- Repository settings ------------------------------------------------

  app.get('/:owner/:repo/settings', async (c) => {
    const rc = await loadRepo(c, svc, { owner: true });
    return c.html(repoSettingsPage(rc));
  });

  app.post('/:owner/:repo/settings', async (c) => {
    const rc = await loadRepo(c, svc, { owner: true });
    const f = await formFields(c);
    try {
      const updated = await svc.repos.update(rc.repo, {
        name: f.name,
        description: f.description,
        visibility: f.visibility === 'public' ? 'public' : 'private',
      }, rc.owner.email);
      setFlash(c, 'ok', 'repo_saved');
      return c.redirect(urlPath(rc.owner.handle, updated.name, 'settings'));
    } catch (err) {
      if (err instanceof ServiceError && err.status === 400) return c.html(repoSettingsPage(rc, err.code), 400);
      throw err;
    }
  });

  app.post('/:owner/:repo/settings/delete', async (c) => {
    const rc = await loadRepo(c, svc, { owner: true });
    const f = await formFields(c);
    if ((f.confirm ?? '').trim() !== rc.repo.name) return c.html(repoSettingsPage(rc, 'confirm_mismatch'), 400);
    await svc.repos.delete(rc.repo, rc.owner.email);
    setFlash(c, 'ok', 'repo_deleted');
    return c.redirect('/');
  });
}
