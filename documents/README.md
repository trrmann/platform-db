# platform-db

Shared PostgreSQL layer for the platform's applications (iam-service, FlashCards, request-queue, …).
It is a **library**, not a service: each application uses it in-process against the shared database.

| Export              | Purpose                                                                                                                                                                                                                 |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PostgresDatabase`  | Base adapter: pool, `static SCHEMA` (connection `search_path`), `static sqlRoot`, SQL file and named-query loading, `initializeSchemaFromFile`, `withTransaction`, `tableExists`, `healthCheck`, `DB_PG_EXPIRE` warning |
| `LocalDatabaseTest` | Base class for tests on a local scratch database: local-only guard, checks, summary, pool cleanup                                                                                                                       |

## Using it

```js
import { PostgresDatabase } from 'platform-db';

export class AppDatabase extends PostgresDatabase {
  static SCHEMA = 'myapp';
  static sqlRoot = '<absolute path to this app's src/scripts/sql>';
}
```

Configuration comes from `DB_PG_*` environment variables (see `src/scripts/js/modules/postgresDatabase.mjs`).

## Local scratch database

`src/scripts/sh/local-db.sh` runs one private PostgreSQL cluster (127.0.0.1:5433, data in
`~/.local/share/platform-db`) shared by every project; each project gets its own database named after its
`package.json` name (`flashcards_local`, `iam_service_local`, `platform_db_local`, …). Projects call it through a
thin wrapper in their own `src/scripts/sh/local-db.sh`. Commands: `init`, `start`, `stop`, `status`, `psql`, `env`,
`run CMD…`, `serve`, `reset`, `drop`, `load-prod` (owner only: copies real user data), `destroy`.

## Tests

`npm test` (on the local scratch database): SQL splitting, named queries, bootstrap and failure reporting,
transactions, table existence, health, expiry warning.

See [CODING_STANDARDS.md](./CODING_STANDARDS.md) (shared across all platform repositories) and [Issues.md](./Issues.md).
