Draftbox
========

Git hosting for non-technical users: write and edit Markdown and text
documents in the browser, keep every version, and share with Git when
needed. See [AGENTS.md](AGENTS.md) for the product outline.

Features
--------

* Login exclusively through OAuth (Google, GitHub, any OpenID Connect
  provider). Registration is open, by invitation link, or by
  pre-registration through the admin API, in any combination.
* Repositories, private by default, with a clear explanation of what
  "public" means. Public repositories can be browsed and cloned without
  an account.
* In-browser file editor with Markdown preview, file upload, rename and
  delete, version history with changes, and tags. Advanced mode adds
  branches; simple mode always works on `main`.
* Git smart HTTP (protocol v0 and v2) with access tokens: global or
  per-repository, read-write or read-only, permanent or valid for
  1/3/6/12 months. A token can have a one-time 8-digit password that is
  exchanged for the token once.
* Administration: block, unblock and delete users; invitation links;
  pre-registrations; branding (name, colors, logo, theme, custom CSS).
* Web interface in English, Ukrainian and German, remembered per user.

Requirements
------------

* Node.js 22.18 or newer (runs the TypeScript sources directly in
  development).
* `git` on the server: libgit2 has no server side of the pack protocol,
  so `git upload-pack` / `git receive-pack` serve clone and push. All
  other repository access, including the metadata database, goes
  through libgit2 (nodegit).
* Build tools for nodegit if no prebuilt binary matches the platform
  (`python3`, `make`, `g++`, `libssl-dev`, `libkrb5-dev`).

Running
-------

    npm install
    cp draftbox.config.example.json draftbox.config.json   # then edit
    export DRAFTBOX_SESSION_SECRET=$(openssl rand -base64 36)
    export DRAFTBOX_ENCRYPTION_KEY=$(openssl rand -base64 36)
    npm run build
    npm start

For local development `npm run dev` runs the sources without building.
Setting `"oauth": {"dev": {"enabled": true}}` adds a login form that
accepts any email address; never enable it in production.

OAuth redirect URIs to register with providers:
`<baseUrl>/auth/google/callback`, `<baseUrl>/auth/github/callback`,
`<baseUrl>/auth/<id>/callback` for OIDC providers.

Configuration values can be overridden with `DRAFTBOX_CONFIG` (path of
the config file), `DRAFTBOX_SESSION_SECRET`, `DRAFTBOX_ENCRYPTION_KEY`,
`DRAFTBOX_ADMIN_API_KEYS` (comma separated), `DRAFTBOX_PORT`,
`DRAFTBOX_DATA_DIR` and `DRAFTBOX_BASE_URL`.

Run behind a TLS-terminating reverse proxy; set `trustProxy` so that
rate limiting sees client addresses.

Using Git
---------

    git clone https://draftbox.example.com/<user>/<repo>.git

Git asks for a user name (anything) and a password: use an access token
created under "Access tokens".

APIs
----

Exchange a one-time password for its token (rate limited, single use):

    curl -X POST -H 'Content-Type: application/json' \
      -d '{"password":"12345678"}' https://draftbox.example.com/api/v1/token-exchange

Administrative API, authenticated with one of `adminApiKeys`
(at least 16 characters):

    curl -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
      -d '{"email":"new.user@example.com","note":"order 1234"}' \
      https://draftbox.example.com/api/v1/admin/preregistrations

| Method | Path | Purpose |
|--------|------|---------|
| GET    | /api/v1/admin/preregistrations | list pre-registrations |
| POST   | /api/v1/admin/preregistrations | allow an email address to register |
| GET    | /api/v1/admin/preregistrations/{email} | pre-registration and account status |
| DELETE | /api/v1/admin/preregistrations/{email} | withdraw a pre-registration |
| POST   | /api/v1/admin/invitations | create an invitation link (`note`, `expiresDays`) |

Data
----

Everything lives under `dataDir`:

* `meta.git` - bare repository used as the database; every change is a
  commit on `main` (layout documented in `src/db/models.ts`). Its
  history doubles as an audit log, and it can be backed up with
  `git clone --mirror`.
* `repos/<id>.git` - user repositories, named by a stable id so that
  renaming users or repositories does not move data.

Development
-----------

    npm test             # unit, web flow and Git-over-HTTP tests
    npm run typecheck
    npm run check-ascii  # code must be ASCII only (see AGENTS.md)
