# issues

## open

- **Queue, throttle and prioritise database work (owner request, 2026-11-04; after the FlashCards release).** Every
  query goes through a scheduler built on request-queue:
  - a concurrency cap (never above the pool size) and a rate limit;
  - priority classes from a rules file (`critical`: token and permission checks, health; `interactive`: user
    requests; `background`: backups, imports, exports, clean-up), with ageing so background work isn't starved;
  - a maximum wait per class, and retry with backoff of temporary failures (connection refused, `57P01`/`57P03`
    restarts, `53300` too many connections, `40001`/`40P01` serialisation and deadlock), with a transaction retried
    as a whole;
  - waiting jobs held in memory, since the database is what they wait for.

  Design: iam-service `documents/PLATFORM_ACCESS_AND_STARTUP.md`. Also: a pool size settable by env, so services
  sharing one Render database stay under its connection limit.

- **Add SQLite to the available database backends (owner request, 2026-11-04).** platform-db is PostgreSQL-only today.
  Add a `SqliteDatabase` adapter with the same interface as `PostgresDatabase` (named-query loading, schema bootstrap,
  `withTransaction`, `tableExists`, health), so an application can choose SQLite (local or embedded use, tests,
  small apps) or PostgreSQL by configuration. To design first: how per-dialect SQL is kept (separate `sql/sqlite/`
  files next to `sql/pg/`), what replaces PostgreSQL-only features (schemas/search_path → separate database files
  or table prefixes; `gen_random_uuid`, `NULLS NOT DISTINCT`, `JSONB`, `SKIP LOCKED`), and which driver
  (Node's built-in `node:sqlite` vs. a package). The local-db tooling and `LocalDatabaseTest` get a SQLite mode.

## resolved

- **Start-up resilience (v0.1.1, 2026-11-04).** `waitForConnection()` (retry with backoff, `DatabaseUnavailableError`
  at the limit), an advisory lock around schema bootstrap, and a dropped idle connection logged instead of exiting the
  process. `describeStatement` became a static method (it was a helper closure, against standard 0.3).
  **Resolved:** `npm test` 36/36 on the local scratch database, including a database down at start then up (TCP
  relay started late), giving up at the limit, a server-ended idle connection, and the lock blocking a second bootstrap.
- Published to GitHub (`trrmann/platform-db`, public); dependents use `git+https` tags.
