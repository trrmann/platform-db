# issues

## open

- **Add SQLite to the available database backends (owner request, 2026-11-04).** platform-db is PostgreSQL-only today.
  Add a `SqliteDatabase` adapter with the same interface as `PostgresDatabase` (named-query loading, schema bootstrap,
  `withTransaction`, `tableExists`, health), so an application can choose SQLite (local or embedded use, tests,
  small apps) or PostgreSQL by configuration. To design first: how per-dialect SQL is kept (separate `sql/sqlite/`
  files next to `sql/pg/`), what replaces PostgreSQL-only features (schemas/search_path → separate database files
  or table prefixes; `gen_random_uuid`, `NULLS NOT DISTINCT`, `JSONB`, `SKIP LOCKED`), and which driver
  (Node's built-in `node:sqlite` vs. a package). The local-db tooling and `LocalDatabaseTest` get a SQLite mode.

- Publish to GitHub and switch dependents from `file:` to `github:` dependencies (owner decision: visibility).
