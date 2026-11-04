# Coding Standards

> Shared standards for FlashCards, iam-service, platform-db, and request-queue. The canonical copy is
> FlashCards `documents/CODING_STANDARDS.md`; keep this copy identical apart from this note.

These are the binding standards for all changes to FlashCards, whether made by people or by AI
assistants. **Section 0 contains the owner-mandated core standards. They override anything else in
this document or in existing code.** Where the code currently breaks a standard, the violation is
listed at the end so it gets fixed rather than copied. Tooling details (ESLint and Prettier
configuration) are in [CODE_QUALITY.md](./CODE_QUALITY.md).

A change is not done until it meets every **must** below. More standards will be added. Append new
owner-mandated rules to section 0.

## 0. Core standards (owner-mandated)

### 0.1 No inline SQL: all SQL comes from SQL scripts in `src/scripts/sql/`

- Every SQL statement **must** live in a `.sql` file under `src/scripts/sql/pg/` and be loaded by
  name (`-- Query: name` sections via `loadNamedSqlStatements`, or whole files via `loadSqlStatements`).
- JavaScript **must not** contain SQL text: no keywords, clauses, operators, conditions, column
  assignments, or transaction commands (`'BEGIN'`, `` `AND class = $2` ``, `` `${col} = EXCLUDED.${col}` ``
  are all violations). JS refers to queries by name and passes **values** as bound parameters.
- Optional filters are written **in the SQL** with nullable parameters, not assembled in JS:

  ```sql
  AND ($2::text IS NULL OR f.class ILIKE $2)
  AND p.current_box = ANY($3::int[])
  ```

  JS may compute the parameter values (e.g. turn `Bio*` into `Bio%`, or build the list of due boxes).

- Partial updates use fixed statements, for example `SET col = COALESCE($n, col)`, or separate named queries.
- Transactions use named queries (for example `begin_transaction` / `commit_transaction` /
  `rollback_transaction` in a shared `transaction-queries.sql`).
- **Only exception:** generic table-level operations where an identifier cannot be a bound parameter
  (backup/restore across all tables, introspection). The `.sql` file must hold the complete
  statement and all of its syntax. JS may fill `{{table}}`, `{{columns}}`, and `{{placeholders}}`
  slots only with identifiers validated against the database catalog or a static whitelist, and
  with `$n` placeholder lists. JS still never produces keywords or operators.

### 0.2 No inline styles: all styles come from the CSS files in `public/css/`

- Every style **must** live in a `.css` file under `public/css/`: shared rules in the tier files and
  `app.css`, page rules in `public/css/pages/<page>.css`.
- Forbidden: `style="…"` attributes (in EJS **and** in HTML built by JS template strings), `<style>`
  blocks, `element.style.*`, `style.cssText`, `setAttribute('style', …)`, and CSS-in-JS.
- JS changes appearance **only** by adding, removing, or toggling classes defined in the CSS files.
  Dynamic values use stepped utility classes (e.g. `.progress-w0` … `.progress-w100`).

### 0.3 JavaScript is fully object-oriented

- **All** JavaScript, server and client, is organized into classes. There are no standalone or
  module-level functions, and no module-level mutable state.
- Reusable logic is a **method** (a `static` method when it needs no instance state). Named helper
  closures defined inside methods (`const shuffle = (…) => …`) are not allowed; make them methods.
  Anonymous callbacks passed directly as arguments (`array.map(…)`, `addEventListener(…, …)`,
  `router.get(…, …)`) are fine.
- Shared behavior comes from inheritance or composition (e.g. `BaseRouter`, `PostgresDatabase`, or
  a shared utility class), never from copy-pasted helpers.
- Configuration and constants are `static` fields. Per-object state is instance fields.
  Dependencies are constructor parameters.
- Entry points (`server.js`, `tests/preview-tests.mjs`) only import, instantiate, and invoke. They contain no logic.
- **Client side:** page and partial behavior lives in classes in `public/js/` (one class per page or
  component, e.g. `public/js/pages/entries-page.js`). Views include them with
  `<script src="…">` and must not contain inline `<script>` logic. Server-rendered values reach the
  class through `data-*` attributes on the page.
- Config files consumed by tools (`eslint.config.js`) are exempt.

### 0.4 Responsive design: mobile first, five tiers

Styles are written **mobile first**: base rules target phones, and each larger tier adds or
overrides with `min-width` queries only. `max-width` queries are not allowed.

| Tier         | Applies from        | File                                     | Notes                                                                                                   |
| ------------ | ------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Mobile       | 0 px (base)         | `mobile.css` (+ `core.css`, `forms.css`) | No media query. Single column, touch targets ≥ 44 px                                                    |
| Tablet       | `min-width: 768px`  | `tablet.css`                             |                                                                                                         |
| Laptop       | `min-width: 1024px` | `laptop.css`                             |                                                                                                         |
| Desktop      | `min-width: 1280px` | `desktop.css`                            |                                                                                                         |
| Large screen | `min-width: 1920px` | `large-screen.css`                       | Big-screen TVs. Legible from a distance, visible `:focus-visible` states for remote/keyboard navigation |

- Use exactly these breakpoint values, nothing in between.
- The cascade order is mobile → tablet → laptop → desktop → large screen, so larger tiers win.
  `styles.css` is the entry point and contains only the `@import` chain.
- Page and component files (`pages/*.css`, `app.css`) follow the same rule: base rules for mobile,
  then `@media (min-width: …)` blocks in ascending order using the tier values above.
- Every UI change must be checked at all five tiers (for example at 375, 768, 1024, 1280, and 1920 px wide).

### 0.5 Environments and the deploy pipeline

Run all three stages with `deploy.sh` (`src/scripts/sh/deploy.sh`). Each stage has one purpose:

| Stage   | Command              | Runs on                           | Purpose                   | What it does                                                                                                                        |
| ------- | -------------------- | --------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Dev     | `deploy.sh -dev`     | Local server, `:5000`             | Development and debugging | Starts the current code. **No** formatting, linting, or tests. Only what is needed to run (prerequisites, `npm install` if missing) |
| Preview | `deploy.sh -preview` | Local server, `:4000`             | Full quality gate         | Starts the current code, then runs **all** of 0.6. Any failure stops the pipeline                                                   |
| Prod    | `deploy.sh -prod`    | Render (auto-deploys from GitHub) | Release                   | Git commit and push to GitHub `main`. Render deploys automatically                                                                  |

- **Render is the production destination and the final verification point.** Code is production-ready
  only once it is deployed on Render and verified there (health, every page, read-only API checks).
- Preview must pass before anything is deployed to production.
- **All three environments use the same database** (Render PostgreSQL). See 0.7 for what that means for testing and data safety.
- **Approved exception:** schema and migration work is developed and tested first on the local scratch
  database (`local-db.sh`, [LOCAL_DATABASE.md](./LOCAL_DATABASE.md)). Work in progress that changes the schema
  is never run with `deploy.sh -dev`/`-preview` until it is approved for the shared database.

### 0.6 Preview testing: every page, every API

The preview stage must run all of the following against the preview server. **Every test covers
every page** of the site, in the signed-out state and in the signed-in states (normal user and admin)
where the page differs:

| Area            | Chrome                                                       | Firefox equivalent                                       | W3C                                            |
| --------------- | ------------------------------------------------------------ | -------------------------------------------------------- | ---------------------------------------------- |
| Formatting/lint | Prettier + ESLint (`npm run verify`)                         | n/a                                                      | n/a                                            |
| Audits          | Lighthouse (performance, accessibility, best practices, SEO) | Firefox accessibility audit (axe) and performance timing | n/a                                            |
| Memory          | Heap / external memory per page                              | Firefox memory measurement per page                      | n/a                                            |
| CSS             | In-browser CSS checks                                        | Firefox in-browser CSS checks                            | **W3C CSS Validator** on every stylesheet      |
| HTML            | `html-validate`                                              | n/a                                                      | **W3C Nu HTML Checker** on every rendered page |

**API tests:** every API endpoint is tested for every factor that can be tested: success
responses and shapes, validation errors (`400`), authentication (`401`), authorization and ownership
(`403`/`404`), quota (`413`), and side effects (data actually created, changed, or removed).
These tests also cover anything the browser tools don't, such as page behavior, multi-step flows like
practice → answer → box change, export/import round trips, and backup/restore.

- Test code follows 0.3. It's built from classes, e.g. a suite runner, an HTTP/API client that holds the
  session, and one test class per area. Test code lives in `src/scripts/js/modules/tests/`.
- Because the database is shared with production (0.5), tests must use **dedicated test accounts and
  test data**, must never modify or delete real users' data, and must remove everything they create.

### 0.7 Data safety: the database is reset every month

The Render database is on the **free plan, and its data is deleted every month**. Losing a
database must never mean losing data. Every change must keep these guarantees:

1. **Complete export.** One export, the admin backup (data JSON + media ZIP), contains **all** data
   needed to rebuild the application: identities, roles, cards, media, options, shares, removals,
   progress, history, quizzes, and logs. The only exclusions are transient tables (`session`).
   Every new table or column must be added to backup and restore in the same change.
2. **Full recovery onto an empty database.** On a freshly created database: the server bootstraps the
   schema automatically → an admin is created → the backup import rebuilds everything, with ids,
   relationships, media, and sequences intact and nothing missing. The import must be repeatable
   (running it again changes nothing) and must report anything it skipped.
3. **Proven, not assumed.** An automated export → reset → import → compare round trip (row counts and
   content per table) is part of the preview tests (0.6).
4. **Backups happen before the reset.** The app warns ahead of the expiry date (`DB_PG_EXPIRE`), and
   taking a fresh full backup is part of every production release and of the monthly routine.
   Backups are stored outside the repository, since they contain user data and password hashes.
5. **Backup format is versioned.** Restore keeps accepting backups from earlier format versions.

### 0.8 IAM is separate from every app and serves many apps

- Identity and access (users, applications, organizations, groups, roles, rights, sessions) is one
  domain, **separated from application data in the database** (its own PostgreSQL schema, `iam`). Each app
  (FlashCards first) has its own schema. Design: [IAM_MULTI_APP_DESIGN.md](./IAM_MULTI_APP_DESIGN.md).
- The IAM must support **multiple applications**, plus **organizations** and **groups**. Roles and rights
  are scoped to an application. Groups and organizations can carry roles.
- **No cross-domain SQL:** app SQL never queries IAM tables, and IAM code never queries app tables.
  Apps get identity data through the IAM service class. The only allowed link is a foreign key from
  app tables to `iam.users(user_id)` (`ON DELETE CASCADE`).
- Each adapter only touches its own schema (`IdentityManagementDatabase` → `iam`, `FlashCardsDatabase` → `flashcards`).

## 1. Workflow

1. **Verify before changing.** Reproduce a bug (or read the code path end to end) before fixing it.
   Behavior on production comes first. Large changes wait until current production functionality
   has been verified (see the gate at the top of [Issues.md](./Issues.md)).
2. **Keep the change focused.** Fix what was asked. Record unrelated problems you find in
   `Issues.md → open` instead of fixing them on the side. The exception is a defect that blocks
   the requested work.
3. **Test what you changed** and report how it was tested (a command, a simulation, or browser steps).
   Never claim something works without having run it.
4. **Quality gate:** `npm run verify` (Prettier + ESLint) must pass with no errors, and
   `deploy.sh -preview` (the full 0.6 suite) must pass before any production deploy.
5. **Documentation in the same change.** Any change to a route, table or column, env var, script, or
   user-visible behavior updates the matching current-reference doc (see [README.md](./README.md)).
   Log resolved issues in `Issues.md` with a short **Resolved:** note that says how it was verified.
6. **Commits and deploys:** commit, push, or run `deploy.sh -prod` only when asked. Commit messages
   have an imperative summary line (≤ 72 chars), a blank line, then a body that explains _why_ and
   _how it was verified_.
7. **New code complies fully with section 0.** When you change a function that has a listed
   violation, fix that violation in the same change.

## 2. Repository layout

- **Documentation lives only in `documents/`.** The root `README.md` is the only doc file allowed
  in the project root.
- Server code lives in `src/scripts/js/modules/` (`db/`, `auth/` services, `routes/`, `tests/`), SQL in
  `src/scripts/sql/pg/`, shell scripts in `src/scripts/sh/`, views in `src/views/`, styles in `public/css/`, and client JS in `public/js/`.
- **Shell scripts live only in `src/scripts/sh/`** (no scripts in the project root). That folder is on
  the VS Code terminal `PATH` (`.vscode/settings.json` and `FlashCards.code-workspace`), so each
  script must run correctly from **any** working directory: resolve the project root from the
  script's own location (`readlink -f "${BASH_SOURCE[0]}"`, then `../../..`) and `cd` there. Scripts
  are executable (`chmod +x`), start with `#!/bin/bash`, and use a `.sh` extension. See
  [DEPLOY_ACCESSIBILITY.md](./DEPLOY_ACCESSIBILITY.md).
- File names are camelCase `.mjs` for server modules (`entriesService.mjs`, `quizRouter.mjs`), and
  kebab-case for SQL, CSS, and client JS (`practice-queries.sql`, `navigation-tracker.js`).

## 3. JavaScript conventions

- ES modules on the server (`import`/`export`), `const`/`let` (never `var`), `===`, braces on every
  block, single quotes, semicolons, 2-space indent, 100-column lines. Prettier and ESLint enforce these.
- **Server module pattern.** Each module defines one class and exports it in three ways:

  ```js
  class EntriesService { … }
  export const entriesService = new EntriesService();
  export { EntriesService };
  export default entriesService;
  ```

  Dependencies (database adapters) are constructor parameters with the shared instance as the
  default, so they can be swapped in tests.

- **JSDoc** (`/** … */`) on every class and public method. It says what the method does, plus any
  non-obvious _why_ (constraints, ordering, compatibility).
- Unused parameters are prefixed `_` (`_userId`).
- `console.log`/`console.error` are allowed for server logging. Never log secrets, passwords, or session contents.

## 4. Layering

| Layer                                               | Responsibility                                                              | Must not                           |
| --------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------- |
| Routers (`routes/*Router.mjs`, extend `BaseRouter`) | Parse input, authenticate/authorize, call services, shape the HTTP response | Run queries or hold business rules |
| Services (`auth/*Service.mjs`)                      | Business rules, ownership checks, multi-step operations                     | Read `req`/`res`                   |
| DB adapters (`db/`)                                 | Connection, pool, schema bootstrap, SQL loading                             | Contain app business logic         |

- New routers extend `BaseRouter` and implement `registerRoutes()`. Protected routes use
  `this.requireAuth` / `this.requireAdmin`, or the equivalent `req.session.userId` check that returns `401`.
- Register specific paths **before** parameter paths (`/shared-by-me` before `/:flashcardId`).
- Ownership is enforced in the service (`created_by = userId`), never trusted from the client.

## 5. SQL and the database

- See **0.1**: all SQL lives in `src/scripts/sql/pg/`. Named queries go in `*-queries.sql`
  (`-- Query: name`, exactly one statement each) and are loaded into a `static queries` map.
- **Always bind values as parameters** (`$1`, `$2`). User input never reaches a `{{slot}}`.
- **Schema changes** are appended to the owning schema file (`iam-postgres-schema.sql` for identity,
  `flashcards-postgres-schema.sql` for app data) as idempotent statements (`IF NOT EXISTS`,
  guarded `DO $name$ … $name$` blocks). A statement must come after everything it depends on,
  because a fresh database runs the file top to bottom. There is no migration runner.
- Identity tables belong to `IdentityManagementDatabase`, and app tables to `FlashCardsDatabase`.
  New tables that reference users must be considered for backup/import (`BackupService` table lists,
  user-id remapping columns).
- Multi-statement writes that must succeed or fail together use a transaction, through the named
  transaction queries (0.1).

## 6. HTTP API

- JSON responses use `{ status: 'success' | 'error', message, …data }`. Validation details go in
  `errors: string[]`.
- Status codes: `400` invalid input, `401` not logged in, `403` not allowed, `404` not found,
  `413` quota exceeded, `500` unexpected. Catch errors per route, log them server-side, and return a
  generic message.
- Validate every input on the server (`validationService` for users), even when the UI validates too.
- Field names: request bodies use camelCase (`flashcardIds`, `isPrivate`). Response rows keep the
  database's snake_case columns.

## 7. Views and client behavior

- Pages are EJS in `src/views/`. Each includes `partials/header` with `{ activePage: '<page>' }`, which
  loads `css/pages/<page>.css`. Styling follows **0.2** and **0.4**; scripts follow **0.3**.
- Escape all user content inserted into HTML (`escapeHtml` / `<%= %>`, never `<%- %>` for user data).
- Client code calls the JSON APIs with `fetch`, checks `data.status`, and shows errors to the user.

## 8. Security and data

- **Never commit secrets or real data.** That covers `.env`, copies of it, credentials, hostnames,
  backups with user data, and passwords written into docs. Docs use placeholders (`<db-host>`, `<password>`).
- Passwords are hashed with bcrypt in `validationService`. Never store, return, or log a hash.
- New per-user content must respect the storage quota and the visibility rules
  (owned / accepted share / public-not-removed).

## 9. Testing

- The required test coverage is defined in **0.6** and runs in the preview stage.
- Until that suite is complete, also verify each change with a targeted script (for example a
  simulation in a scratch directory with fake database adapters injected through constructors),
  API calls, or the browser, and write down what was verified.
- `npm test` is a placeholder today. It should become the entry point for the 0.6 API tests.
