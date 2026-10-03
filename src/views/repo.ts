import type { Page } from '../http/app.ts';
import { type Repo, type User, contactEmailOf } from '../db/models.ts';
import type { CommitInfo, GitRepo, RefInfo, TreeEntry } from '../git/types.ts';
import type { Hunk } from '../util/diff.ts';
import { html, raw, urlPath, type Html } from './html.ts';
import { csrfField, formatDate, formatDay, layout } from './layout.ts';
import { DEFAULT_BRANCH } from '../services/repos.ts';

export interface RepoCtx {
  page: Page;
  owner: User;
  repo: Repo;
  git: GitRepo;
  isOwner: boolean;
  advanced: boolean;
  ref: string;
  refKind: 'branch' | 'tag' | 'commit';
  commitOid: string | null;
  branches: RefInfo[];
  cloneUrl: string;
}

export function repoUrl(rc: RepoCtx, ...rest: string[]): string {
  return urlPath(rc.owner.handle, rc.repo.name, ...rest);
}

export function withRef(rc: RepoCtx, url: string): string {
  if (rc.ref === DEFAULT_BRANCH) return url;
  return url + (url.includes('?') ? '&' : '?') + 'ref=' + encodeURIComponent(rc.ref);
}

function firstLine(msg: string): string {
  return msg.split('\n')[0];
}

function visibilityBadge(page: Page, repo: Repo): Html {
  return repo.visibility === 'public'
    ? html`<span class="badge badge-public">${page.t('repo.public')}</span>`
    : html`<span class="badge">${page.t('repo.private')}</span>`;
}

function refSelector(rc: RepoCtx, action: string): Html {
  const { t } = rc.page;
  if (!rc.advanced) return html``;
  const names = rc.branches.map((b) => b.name.slice('refs/heads/'.length));
  if (rc.refKind === 'branch' && !names.includes(rc.ref)) names.push(rc.ref);
  return html`<form method="get" action="${action}" class="refsel">
    <label>${t('repo.branch')}
    <select name="ref" data-autosubmit>
      ${names.map((n) => html`<option value="${n}" ${n === rc.ref ? 'selected' : ''}>${n}</option>`)}
      ${rc.refKind !== 'branch' ? html`<option value="${rc.ref}" selected>${rc.ref.length === 40 ? rc.ref.slice(0, 10) : rc.ref}</option>` : ''}
    </select></label>
    <noscript><button class="btn btn-small">${t('action.go')}</button></noscript>
  </form>`;
}

export function repoLayout(rc: RepoCtx, tab: string, title: string, body: Html): string {
  const { t } = rc.page;
  const tabItem = (key: string, href: string) =>
    html`<a href="${href}" class="${tab === key ? 'active' : ''}">${t('repo.tab_' + key)}</a>`;
  return layout(rc.page, title, html`<div class="repo-head">
  <h1><a href="${urlPath(rc.owner.handle)}">${rc.owner.handle}</a> / <a href="${repoUrl(rc)}">${rc.repo.name}</a> ${visibilityBadge(rc.page, rc.repo)}</h1>
  ${rc.repo.description ? html`<p class="muted">${rc.repo.description}</p>` : ''}
</div>
<nav class="tabs">
  ${tabItem('files', withRef(rc, repoUrl(rc)))}
  ${tabItem('commits', withRef(rc, repoUrl(rc, 'commits')))}
  ${tabItem('tags', repoUrl(rc, 'tags'))}
  ${rc.advanced ? tabItem('branches', repoUrl(rc, 'branches')) : ''}
  ${rc.isOwner ? tabItem('settings', repoUrl(rc, 'settings')) : ''}
</nav>
${body}`);
}

function breadcrumbs(rc: RepoCtx, path: string): Html {
  const parts = path.split('/').filter(Boolean);
  const crumbs: Html[] = [html`<a href="${withRef(rc, repoUrl(rc))}">${rc.repo.name}</a>`];
  parts.forEach((p, i) => {
    const sub = parts.slice(0, i + 1).join('/');
    crumbs.push(i === parts.length - 1 ? html`<strong>${p}</strong>` : html`<a href="${withRef(rc, repoUrl(rc, 'tree', sub))}">${p}</a>`);
  });
  return html`<div class="crumbs">${crumbs.map((c, i) => (i ? html` / ${c}` : c))}</div>`;
}

function cloneBox(rc: RepoCtx): Html {
  const { t } = rc.page;
  return html`<details class="clone"><summary>${t('repo.clone')}</summary>
  <div class="copyrow"><input type="text" readonly value="${rc.cloneUrl}" class="mono" id="clone-url"><button type="button" class="btn btn-small" data-copy="clone-url">${t('action.copy')}</button></div>
  <p class="muted small">${rc.repo.visibility === 'public' ? t('repo.clone_help_public') : t('repo.clone_help_private')}
  <a href="/settings/tokens">${t('nav.tokens')}</a></p>
</details>`;
}

function canEdit(rc: RepoCtx): boolean {
  return rc.isOwner && rc.refKind === 'branch';
}

export function treePage(rc: RepoCtx, path: string, entries: TreeEntry[], readme: { name: string; html: string } | null, head: CommitInfo | null): string {
  const { t } = rc.page;
  const dir = path ? path + '/' : '';
  return repoLayout(rc, 'files', path ? `${path} - ${rc.repo.name}` : rc.repo.name, html`
<div class="toolbar">
  ${refSelector(rc, path ? repoUrl(rc, 'tree', path) : repoUrl(rc))}
  ${breadcrumbs(rc, path)}
  <span class="spacer"></span>
  ${canEdit(rc) ? html`
    <a class="btn btn-small" href="${withRef(rc, repoUrl(rc, 'new') + (path ? '?dir=' + encodeURIComponent(path) : ''))}">${t('repo.new_file')}</a>
    <a class="btn btn-small btn-secondary" href="${withRef(rc, repoUrl(rc, 'upload') + (path ? '?dir=' + encodeURIComponent(path) : ''))}">${t('repo.upload')}</a>` : ''}
  ${cloneBox(rc)}
</div>
${head ? html`<div class="lastcommit"><a href="${repoUrl(rc, 'commit', head.oid)}" class="mono">${head.oid.slice(0, 8)}</a>
  ${firstLine(head.message)} <span class="muted">&middot; ${head.author.name} &middot; ${formatDate(rc.page, head.author.time)}</span></div>` : ''}
<div class="card flush"><table class="files">
  ${path ? html`<tr><td colspan="2"><a href="${withRef(rc, path.includes('/') ? repoUrl(rc, 'tree', path.slice(0, path.lastIndexOf('/'))) : repoUrl(rc))}">..</a></td></tr>` : ''}
  ${entries.map((e) => html`<tr>
    <td><span class="ico ico-${e.type === 'tree' ? 'dir' : 'file'}"></span>
      ${e.type === 'commit' ? html`<span>${e.name}</span>` : html`<a href="${withRef(rc, repoUrl(rc, e.type === 'tree' ? 'tree' : 'blob', dir + e.name))}">${e.name}</a>`}</td>
  </tr>`)}
  ${entries.length === 0 ? html`<tr><td class="muted">${t('repo.empty_dir')}</td></tr>` : ''}
</table></div>
${readme ? html`<article class="card markdown"><div class="filehead">${readme.name}</div>${raw(readme.html)}</article>` : ''}`);
}

export function emptyRepoPage(rc: RepoCtx): string {
  const { t } = rc.page;
  return repoLayout(rc, 'files', rc.repo.name, html`
<section class="card">
  <h2>${t('repo.empty_title')}</h2>
  ${rc.isOwner ? html`<p>${t('repo.empty_owner')}</p>
    <p><a class="btn" href="${withRef(rc, repoUrl(rc, 'new'))}">${t('repo.new_file')}</a>
       <a class="btn btn-secondary" href="${withRef(rc, repoUrl(rc, 'upload'))}">${t('repo.upload')}</a></p>
    <h3>${t('repo.empty_push')}</h3>
    <pre class="mono">git remote add origin ${rc.cloneUrl}
git push -u origin ${rc.ref}</pre>` : html`<p class="muted">${t('repo.empty_visitor')}</p>`}
  ${cloneBox(rc)}
</section>`);
}

export interface BlobView {
  path: string;
  size: number;
  text: string | null;
  rendered: string | null;
  showSource: boolean;
}

export function blobPage(rc: RepoCtx, b: BlobView): string {
  const { t } = rc.page;
  const name = b.path.split('/').pop() ?? b.path;
  let content: Html;
  if (b.text === null) {
    content = html`<p class="muted pad">${t('repo.binary_file', { size: b.size })}</p>`;
  } else if (b.rendered !== null && !b.showSource) {
    content = html`<div class="markdown pad">${raw(b.rendered)}</div>`;
  } else {
    const lines = b.text.split('\n');
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    content = html`<div class="code"><table>${lines.map((l, i) => html`<tr><td class="ln">${i + 1}</td><td><pre>${l}</pre></td></tr>`)}</table></div>`;
  }
  const blobUrl = withRef(rc, repoUrl(rc, 'blob', b.path));
  return repoLayout(rc, 'files', `${name} - ${rc.repo.name}`, html`
<div class="toolbar">${refSelector(rc, repoUrl(rc, 'blob', b.path))}${breadcrumbs(rc, b.path)}</div>
<div class="card flush">
  <div class="filehead">
    <span>${t('repo.size_bytes', { size: b.size })}</span>
    <span class="spacer"></span>
    ${b.rendered !== null ? (b.showSource
      ? html`<a class="btn btn-small btn-secondary" href="${blobUrl}">${t('repo.view_rendered')}</a>`
      : html`<a class="btn btn-small btn-secondary" href="${blobUrl + (blobUrl.includes('?') ? '&' : '?')}source=1">${t('repo.view_source')}</a>`) : ''}
    <a class="btn btn-small btn-secondary" href="${withRef(rc, repoUrl(rc, 'raw', b.path))}">${t('repo.raw')}</a>
    ${canEdit(rc) && b.text !== null ? html`<a class="btn btn-small" href="${withRef(rc, repoUrl(rc, 'edit', b.path))}">${t('action.edit')}</a>` : ''}
    ${canEdit(rc) ? html`<form method="post" action="${repoUrl(rc, 'delete', b.path)}" class="inline" data-confirm="${t('repo.delete_file_confirm', { name })}">
      ${csrfField(rc.page)}<input type="hidden" name="ref" value="${rc.ref}"><input type="hidden" name="base" value="${rc.commitOid ?? ''}">
      <button class="btn btn-small btn-danger">${t('action.delete')}</button></form>` : ''}
  </div>
  ${content}
</div>`);
}

export interface EditView {
  path: string;
  dir: string;
  isNew: boolean;
  content: string;
  base: string;
  message: string;
  error?: string;
}

export function editPage(rc: RepoCtx, v: EditView): string {
  const { t } = rc.page;
  const action = v.isNew ? repoUrl(rc, 'new') : repoUrl(rc, 'edit', v.path);
  const isMd = v.isNew || /\.(md|markdown)$/i.test(v.path);
  return repoLayout(rc, 'files', `${v.isNew ? t('repo.new_file') : v.path} - ${rc.repo.name}`, html`
${v.error ? html`<p class="flash flash-error">${t('error.' + v.error)}</p>` : ''}
<form method="post" action="${action}" class="card stack editor" data-editor>
  ${csrfField(rc.page)}
  <input type="hidden" name="ref" value="${rc.ref}">
  <input type="hidden" name="base" value="${v.base}">
  <label>${t('repo.file_path')}
    <div class="pathrow">${v.dir ? html`<span class="mono muted">${v.dir}/</span>` : ''}
    <input type="hidden" name="dir" value="${v.dir}">
    <input type="text" name="name" class="mono" required value="${v.isNew ? v.path : v.path.slice(v.dir ? v.dir.length + 1 : 0)}" placeholder="${t('repo.file_name_placeholder')}"></div>
    ${v.isNew ? '' : html`<small class="muted">${t('repo.rename_help')}</small>`}</label>
  <div class="edittabs" ${isMd ? '' : 'hidden'}>
    <button type="button" class="tab active" data-tab="write">${t('repo.write')}</button>
    <button type="button" class="tab" data-tab="preview">${t('repo.preview')}</button>
  </div>
  <textarea name="content" rows="24" class="mono" spellcheck="true">${v.content}</textarea>
  <div class="markdown preview" hidden></div>
  <label>${t('repo.commit_message')}<input type="text" name="message" value="${v.message}" placeholder="${t('repo.commit_message_placeholder')}"></label>
  <div><button class="btn">${t('action.save')}</button>
    <a class="btn btn-secondary" href="${v.isNew ? withRef(rc, v.dir ? repoUrl(rc, 'tree', v.dir) : repoUrl(rc)) : withRef(rc, repoUrl(rc, 'blob', v.path))}">${t('action.cancel')}</a></div>
</form>`);
}

export function uploadPage(rc: RepoCtx, dir: string, base: string, error?: string): string {
  const { t } = rc.page;
  return repoLayout(rc, 'files', `${t('repo.upload')} - ${rc.repo.name}`, html`
${error ? html`<p class="flash flash-error">${t('error.' + error)}</p>` : ''}
<form method="post" action="${repoUrl(rc, 'upload')}" enctype="multipart/form-data" class="card stack">
  ${csrfField(rc.page)}
  <input type="hidden" name="ref" value="${rc.ref}">
  <input type="hidden" name="base" value="${base}">
  <label>${t('repo.upload_dir')}<input type="text" name="dir" value="${dir}" class="mono" placeholder="/"></label>
  <label>${t('repo.upload_files')}<input type="file" name="files" multiple required></label>
  <label>${t('repo.commit_message')}<input type="text" name="message" placeholder="${t('repo.commit_message_placeholder')}"></label>
  <div><button class="btn">${t('repo.upload')}</button></div>
</form>`);
}

export function commitsPage(rc: RepoCtx, commits: CommitInfo[], pageNo: number, hasMore: boolean): string {
  const { t } = rc.page;
  const base = withRef(rc, repoUrl(rc, 'commits'));
  const sep = base.includes('?') ? '&' : '?';
  return repoLayout(rc, 'commits', `${t('repo.tab_commits')} - ${rc.repo.name}`, html`
<div class="toolbar">${refSelector(rc, repoUrl(rc, 'commits'))}</div>
${commits.length === 0 ? html`<p class="muted">${t('repo.no_commits')}</p>` : html`<div class="card flush"><table class="commits">
${commits.map((c) => html`<tr>
  <td><a href="${repoUrl(rc, 'commit', c.oid)}">${firstLine(c.message)}</a><br>
    <span class="muted small">${c.author.name} &middot; ${formatDate(rc.page, c.author.time)}</span></td>
  <td class="mono right"><a href="${repoUrl(rc, 'commit', c.oid)}">${c.oid.slice(0, 8)}</a></td>
  <td class="right"><a class="btn btn-small btn-secondary" href="${repoUrl(rc, 'tree') + '?ref=' + c.oid}">${t('repo.browse')}</a></td>
</tr>`)}
</table></div>`}
<div class="pager">
  ${pageNo > 1 ? html`<a href="${base}${sep}page=${pageNo - 1}">${raw('&larr;')} ${t('action.newer')}</a>` : ''}
  ${hasMore ? html`<a href="${base}${sep}page=${pageNo + 1}">${t('action.older')} ${raw('&rarr;')}</a>` : ''}
</div>`);
}

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  hunks: Hunk[] | null;
  note?: string;
}

export function commitPage(rc: RepoCtx, c: CommitInfo, changes: FileChange[]): string {
  const { t } = rc.page;
  const [subject, ...body] = c.message.split('\n');
  return repoLayout(rc, 'commits', `${subject} - ${rc.repo.name}`, html`
<section class="card">
  <h2>${subject}</h2>
  ${body.join('\n').trim() ? html`<pre class="commitmsg">${body.join('\n').trim()}</pre>` : ''}
  <p class="muted">${c.author.name} &lt;${c.author.email}&gt; &middot; ${formatDate(rc.page, c.author.time)}</p>
  <p class="mono small">${t('repo.commit')} ${c.oid}
    ${c.parents.map((p) => html` &middot; ${t('repo.parent')} <a href="${repoUrl(rc, 'commit', p)}">${p.slice(0, 8)}</a>`)}</p>
  <p><a class="btn btn-small btn-secondary" href="${repoUrl(rc, 'tree') + '?ref=' + c.oid}">${t('repo.browse_at_commit')}</a></p>
</section>
${changes.map((f) => html`<section class="card flush diff">
  <div class="filehead"><span class="badge badge-${f.status}">${t('repo.status_' + f.status)}</span> <span class="mono">${f.path}</span></div>
  ${f.note ? html`<p class="muted pad">${t(f.note)}</p>` : ''}
  ${f.hunks ? html`<div class="code"><table>${f.hunks.map((h) => html`
    <tr class="hunk"><td class="ln"></td><td class="ln"></td><td><pre>@@ -${h.oldStart} +${h.newStart} @@</pre></td></tr>
    ${(() => {
      let o = h.oldStart;
      let n = h.newStart;
      return h.lines.map((l) => {
        const on = l.op === '+' ? '' : String(o++);
        const nn = l.op === '-' ? '' : String(n++);
        const cls = l.op === '+' ? 'add' : l.op === '-' ? 'del' : '';
        return html`<tr class="${cls}"><td class="ln">${on}</td><td class="ln">${nn}</td><td><pre>${l.op}${l.text}</pre></td></tr>`;
      });
    })()}`)}</table></div>` : ''}
</section>`)}`);
}

export interface TagRow {
  name: string;
  commit: CommitInfo | null;
}

export function tagsPage(rc: RepoCtx, tags: TagRow[]): string {
  const { t } = rc.page;
  return repoLayout(rc, 'tags', `${t('repo.tab_tags')} - ${rc.repo.name}`, html`
<p class="muted">${t('repo.tags_intro')}</p>
${rc.isOwner ? html`<section class="card"><h2>${t('repo.tag_create')}</h2>
<form method="post" action="${repoUrl(rc, 'tags')}" class="stack">
  ${csrfField(rc.page)}
  <div class="row">
    <label>${t('repo.tag_name')}<input type="text" name="name" required class="mono" placeholder="v1.0"></label>
    ${rc.advanced ? html`<label>${t('repo.tag_target')}<input type="text" name="target" value="${DEFAULT_BRANCH}" class="mono"></label>`
      : html`<input type="hidden" name="target" value="${DEFAULT_BRANCH}">`}
  </div>
  <label>${t('repo.tag_message')}<input type="text" name="message" placeholder="${t('repo.tag_message_placeholder')}"></label>
  <div><button class="btn">${t('repo.tag_create')}</button></div>
</form></section>` : ''}
<div class="card flush">${tags.length === 0 ? html`<p class="muted pad">${t('repo.no_tags')}</p>` : html`<table>
${tags.map((tag) => html`<tr>
  <td><a href="${repoUrl(rc, 'tree') + '?ref=' + encodeURIComponent(tag.name)}"><strong class="mono">${tag.name}</strong></a></td>
  <td>${tag.commit ? html`<a href="${repoUrl(rc, 'commit', tag.commit.oid)}">${firstLine(tag.commit.message)}</a><br><span class="muted small">${formatDay(rc.page, new Date(tag.commit.author.time * 1000).toISOString())}</span>` : ''}</td>
  <td class="actions">${rc.isOwner ? html`<form method="post" action="${repoUrl(rc, 'tags', 'delete')}" class="inline" data-confirm="${t('repo.tag_delete_confirm', { name: tag.name })}">
    ${csrfField(rc.page)}<input type="hidden" name="name" value="${tag.name}"><button class="btn btn-small btn-danger">${t('action.delete')}</button></form>` : ''}</td>
</tr>`)}</table>`}</div>`);
}

export function branchesPage(rc: RepoCtx, rows: Array<{ name: string; commit: CommitInfo | null }>): string {
  const { t } = rc.page;
  return repoLayout(rc, 'branches', `${t('repo.tab_branches')} - ${rc.repo.name}`, html`
<p class="muted">${t('repo.branches_intro')}</p>
${rc.isOwner ? html`<section class="card"><h2>${t('repo.branch_create')}</h2>
<form method="post" action="${repoUrl(rc, 'branches')}" class="row">
  ${csrfField(rc.page)}
  <label>${t('repo.branch_name')}<input type="text" name="name" required class="mono"></label>
  <label>${t('repo.branch_from')}<select name="from">${rows.map((r) => html`<option value="${r.name}" ${r.name === DEFAULT_BRANCH ? 'selected' : ''}>${r.name}</option>`)}</select></label>
  <button class="btn">${t('repo.branch_create')}</button>
</form></section>` : ''}
<div class="card flush"><table>
${rows.map((r) => html`<tr>
  <td><a href="${repoUrl(rc) + '?ref=' + encodeURIComponent(r.name)}"><strong class="mono">${r.name}</strong></a>
    ${r.name === DEFAULT_BRANCH ? html` <span class="badge">${t('repo.default_branch')}</span>` : ''}</td>
  <td>${r.commit ? html`${firstLine(r.commit.message)}<br><span class="muted small">${formatDate(rc.page, r.commit.author.time)}</span>` : ''}</td>
  <td class="actions">${rc.isOwner && r.name !== DEFAULT_BRANCH ? html`<form method="post" action="${repoUrl(rc, 'branches', 'delete')}" class="inline" data-confirm="${t('repo.branch_delete_confirm', { name: r.name })}">
    ${csrfField(rc.page)}<input type="hidden" name="name" value="${r.name}"><button class="btn btn-small btn-danger">${t('action.delete')}</button></form>` : ''}</td>
</tr>`)}
</table></div>`);
}

export function visibilityFields(page: Page, current: 'public' | 'private'): Html {
  const { t } = page;
  return html`<fieldset class="visibility"><legend>${t('repo.visibility')}</legend>
  <label class="check"><input type="radio" name="visibility" value="private" ${current === 'private' ? 'checked' : ''}>
    <span><strong>${t('repo.private')}</strong><br><small class="muted">${t('repo.private_help')}</small></span></label>
  <label class="check"><input type="radio" name="visibility" value="public" ${current === 'public' ? 'checked' : ''}>
    <span><strong>${t('repo.public')}</strong><br><small class="muted">${t('repo.public_help')}</small></span></label>
  <p class="warning small">${t('repo.public_warning')}</p>
</fieldset>`;
}

export function repoSettingsPage(rc: RepoCtx, error?: string): string {
  const { t } = rc.page;
  return repoLayout(rc, 'settings', `${t('repo.tab_settings')} - ${rc.repo.name}`, html`
${error ? html`<p class="flash flash-error">${t('error.' + error)}</p>` : ''}
<form method="post" action="${repoUrl(rc, 'settings')}" class="card stack">
  ${csrfField(rc.page)}
  <label>${t('repo.name')}<input type="text" name="name" value="${rc.repo.name}" required class="mono">
    <small class="muted">${t('repo.rename_repo_help')}</small></label>
  <label>${t('repo.description')}<input type="text" name="description" value="${rc.repo.description}" maxlength="500"></label>
  ${visibilityFields(rc.page, rc.repo.visibility)}
  <div><button class="btn">${t('action.save')}</button></div>
</form>
<section class="card danger">
  <h2>${t('repo.delete_title')}</h2>
  <p>${t('repo.delete_help')}</p>
  <form method="post" action="${repoUrl(rc, 'settings', 'delete')}" class="row">
    ${csrfField(rc.page)}
    <input type="text" name="confirm" required placeholder="${rc.repo.name}" class="mono" autocomplete="off">
    <button class="btn btn-danger">${t('repo.delete_button')}</button>
  </form>
</section>`);
}

export function newRepoPage(page: Page, values: { name: string; description: string; visibility: 'public' | 'private' }, error?: string): string {
  const { t } = page;
  return layout(page, t('nav.new_repo'), html`<h1>${t('nav.new_repo')}</h1>
${error ? html`<p class="flash flash-error">${t('error.' + error)}</p>` : ''}
<form method="post" action="/new" class="card stack">
  ${csrfField(page)}
  <label>${t('repo.name')}<input type="text" name="name" value="${values.name}" required class="mono" pattern="[A-Za-z0-9_][A-Za-z0-9._\\-]{0,99}" autofocus>
    <small class="muted">${t('repo.name_help')}</small></label>
  <label>${t('repo.description')}<input type="text" name="description" value="${values.description}" maxlength="500"></label>
  ${visibilityFields(page, values.visibility)}
  <div><button class="btn">${t('repo.create')}</button></div>
</form>`);
}

export function repoList(page: Page, items: Array<{ repo: Repo; owner: User }>, showOwner: boolean): Html {
  const { t } = page;
  if (items.length === 0) return html`<p class="muted">${t('repo.none')}</p>`;
  return html`<ul class="repolist">${items.map(({ repo, owner }) => html`<li class="card">
    <a href="${urlPath(owner.handle, repo.name)}"><strong>${showOwner ? `${owner.handle} / ` : ''}${repo.name}</strong></a> ${visibilityBadge(page, repo)}
    ${repo.description ? html`<p class="muted">${repo.description}</p>` : ''}
    <p class="muted small">${t('repo.created_on', { date: formatDay(page, repo.createdAt) })}</p>
  </li>`)}</ul>`;
}

export function homePage(page: Page, user: User, repos: Repo[]): string {
  const { t } = page;
  return layout(page, '', html`<div class="pagehead"><h1>${t('home.my_repos')}</h1>
  <a class="btn" href="/new">${t('nav.new_repo')}</a></div>
${repos.length === 0 ? html`<section class="card center"><p>${t('home.no_repos')}</p><p><a class="btn" href="/new">${t('home.create_first')}</a></p></section>`
  : repoList(page, repos.map((repo) => ({ repo, owner: user })), false)}`);
}

export function landingPage(page: Page): string {
  const { t } = page;
  return layout(page, '', html`<section class="hero">
  <h1>${t('landing.title', { site: page.branding.siteName })}</h1>
  <p class="lead">${t('landing.lead')}</p>
  <p><a class="btn" href="/login">${t('nav.login')}</a> <a class="btn btn-secondary" href="/explore">${t('nav.explore')}</a></p>
</section>
<section class="features">
  <div class="card"><h3>${t('landing.f1_title')}</h3><p>${t('landing.f1')}</p></div>
  <div class="card"><h3>${t('landing.f2_title')}</h3><p>${t('landing.f2')}</p></div>
  <div class="card"><h3>${t('landing.f3_title')}</h3><p>${t('landing.f3')}</p></div>
</section>`);
}

export function explorePage(page: Page, items: Array<{ repo: Repo; owner: User }>): string {
  const { t } = page;
  return layout(page, t('nav.explore'), html`<h1>${t('explore.title')}</h1><p class="muted">${t('explore.intro')}</p>${repoList(page, items, true)}`);
}

export function profilePage(page: Page, owner: User, repos: Repo[]): string {
  const { t } = page;
  const email = contactEmailOf(owner);
  return layout(page, owner.handle, html`<div class="pagehead"><h1>${owner.name} <span class="muted">@${owner.handle}</span></h1></div>
<section class="card profile">
  ${owner.description ? html`<p class="profile-about">${owner.description}</p>` : ''}
  <p><a href="mailto:${email}">${email}</a></p>
  ${owner.homepage ? html`<p><a href="${owner.homepage}" rel="nofollow ugc noopener" target="_blank">${owner.homepage.replace(/^https?:\/\//, '').replace(/\/$/, '')}</a></p>` : ''}
</section>
<h2>${t('profile.repositories')}</h2>
${repoList(page, repos.map((repo) => ({ repo, owner })), false)}`);
}
