# issues

## open

- **Add SQLite to the available database backends (owner request, 2026-11-04).** platform-db is PostgreSQL-only today.
  Add a `SqliteDatabase` adapter with the same interface as `PostgresDatabase` (named-query loading, schema bootstrap,
  `withTransaction`, `tableExists`, health), so an application can choose SQLite (local or embedded use, tests,
  small apps) or PostgreSQL by configuration. To design first: how per-dialect SQL is kept (separate `sql/sqlite/`
  files next to `sql/pg/`), what replaces PostgreSQL-only features (schemas/search_path → separate database files
  or table prefixes; `gen_random_uuid`, `NULLS NOT DISTINCT`, `JSONB`, `SKIP LOCKED`), and which driver
  (Node's built-in `node:sqlite` vs. a package). The local-db tooling and `LocalDatabaseTest` get a SQLite mode.

## resolved

- **`TableBackup`: shared backup and restore of tables (v0.2.4, 2026-11-04).** Phase 3d needs the IAM service and
  FlashCards to back up their own tables. The generic part moves here from FlashCards' backup service: export, upsert
  import, natural keys, id remapping, serial realignment. **Fixed on the way:** the import put the keys of the backup
  file's rows into the SQL as column names unchecked, so a crafted file could inject SQL (admin-only, but against
  CODING_STANDARDS 0.1). Only catalog columns are written now; other keys are skipped with a warning. **Resolved:**
  `npm run test:backup` 9/9, including an injection attempt that is skipped; `npm test` 56/56 and 21/21.
- **Quieter query log in production (v0.2.3, 2026-11-04).** Every query was logged (`Executed query …`), so in
  production Render's health checks alone added a line every few seconds. `DB_PG_LOG_QUERIES` = `all` | `slow` | `off`;
  the default is `slow` in production (or on Render) and `all` elsewhere; `slow` logs queries taking at least
  `DB_PG_SLOW_QUERY_MS` (default 500) as `Slow query`. **Resolved:** `npm test` 56/56 (6 new checks) and 21/21.
- **Local app user mirrors Render's admin login (v0.2.2, 2026-11-04).** `CREATEROLE` (not superuser), set at `init`
  and on `start` for existing clusters, so iam-service's `iam-provision` (per-app logins) is tested locally under the
  same rights it has on Render (checked there: `app_admin` can create roles, is not a superuser). **Resolved:**
  `local-db.sh start` on the existing cluster set it; iam-service `npm run test:provision` 24/24.
- **Queued, throttled and prioritised database work (v0.2.0, 2026-11-04, owner request).** `QueryScheduler`
  (concurrency = pool size, optional rate, classes with waiting limits, ageing, rules by query name, retry of temporary
  failures, transactions retried whole); `DB_PG_POOL_MAX`; `TokenBucket` moved here from request-queue. **Resolved:**
  `npm run test:scheduler` 20/20, including a query made during an outage (TCP relay) that completes when the
  database returns, and a transaction whose first attempt is rolled back and rerun. `npm run test:database` 50/50.
  Found and fixed during testing: scheduler timers must keep the process alive while work is pending.
- **Start-up resilience (v0.1.1, 2026-11-04).** `waitForConnection()` (retry with backoff, `DatabaseUnavailableError`
  at the limit), an advisory lock around schema bootstrap, and a dropped idle connection logged instead of exiting the
  process. `describeStatement` became a static method (it was a helper closure, against standard 0.3).
  **Resolved:** `npm test` 36/36 on the local scratch database, including a database down at start then up (TCP
  relay started late), giving up at the limit, a server-ended idle connection, and the lock blocking a second bootstrap.
- Published to GitHub (`trrmann/platform-db`, public); dependents use `git+https` tags.
