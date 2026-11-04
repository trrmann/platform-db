# platform-db

Shared PostgreSQL layer for the platform's applications (iam-service, FlashCards, request-queue, …).
It is a **library**, not a service: each application uses it in-process against the shared database.

| Export                     | Purpose                                                                                                                                                                                                                                      |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PostgresDatabase`         | Base adapter: pool, `static SCHEMA` (connection `search_path`), `static sqlRoot`, SQL file and named-query loading, `waitForConnection`, `initializeSchemaFromFile`, `withTransaction`, `tableExists`, `healthCheck`, `DB_PG_EXPIRE` warning |
| `DatabaseUnavailableError` | Thrown by `waitForConnection()` when the database didn't answer within the wait limit (`attempts`, `waitedMs`, `cause`)                                                                                                                      |
| `LocalDatabaseTest`        | Base class for tests on a local scratch database: local-only guard, checks, summary, pool cleanup                                                                                                                                            |
| `TcpRelay`                 | Test tooling: forwards a local port to the scratch database. Start it late to simulate a database that comes up after the service; stop it to simulate an outage                                                                             |

## Using it

```js
import { PostgresDatabase } from 'platform-db';

export class AppDatabase extends PostgresDatabase {
  static SCHEMA = 'myapp';
  static sqlRoot = '<absolute path to this app's src/scripts/sql>';
}
```

Configuration comes from `DB_PG_*` environment variables (see `src/scripts/js/modules/postgresDatabase.mjs`).

**Read-only mode:** `DB_PG_READ_ONLY=true` (or `readOnly: true` in the config) makes every session read-only
(`default_transaction_read_only=on`). PostgreSQL then refuses any write (error `25006`), and `initializeSchemaFromFile()`
refuses to run. Use it to point a local server at production for read-only checks. The flag is added to whatever
`options` the config has, so copying another adapter's settings and setting `readOnly` is safe.

## Start-up and outages

Render has no start order between services, and free databases sleep and restart, so every service must cope with
a database that isn't there yet or drops out:

- **Start-up:** call `await db.waitForConnection()` before the schema bootstrap. It retries with exponential backoff
  (0.5 s doubling to 10 s) and throws `DatabaseUnavailableError` after `maxWaitMs` (default 120 s). It logs the 1st,
  2nd, 4th, 8th … failure, so a long outage doesn't flood the log. Options: `{ maxWaitMs, baseDelayMs, maxDelayMs }`.
  `initializeDatabaseConnection()` is the single-try version.
- **Schema bootstrap:** `initializeSchemaFromFile()` holds a PostgreSQL advisory lock
  (`platform-db:schema-bootstrap`) for the whole file. Services starting together bootstrap one after another,
  never at the same moment. The lock is per connection, so a process that dies mid-bootstrap releases it.
- **Dropped connections:** when the database ends an idle pooled connection (restart, maintenance), the pool logs it
  and opens a new connection on the next query. The process keeps running. Earlier versions exited.
- **Queries during an outage** fail with the driver's error. Queued, throttled and prioritised database work is
  planned (see [Issues.md](./Issues.md)).

## Local scratch database

`src/scripts/sh/local-db.sh` runs one private PostgreSQL cluster (127.0.0.1:5433, data in
`~/.local/share/platform-db`) shared by every project; each project gets its own database named after its
`package.json` name (`flashcards_local`, `iam_service_local`, `platform_db_local`, …). Projects call it through a
thin wrapper in their own `src/scripts/sh/local-db.sh`. Commands: `init`, `start`, `stop`, `status`, `psql`, `env`,
`run CMD…`, `serve`, `reset`, `drop`, `load-prod`, `destroy`. Set `LOCAL_DB_NAME` to work on another database of the
cluster (for example an app's dev copy, kept apart from the database its tests wipe).

`load-prod` copies production (real user data; owner use) into the project's local database. It dumps production
first, read-only, so a failed dump leaves the local database untouched. It then drops and recreates the local
database (a clean start, nothing left over), restores the dump with `--exit-on-error`, and deletes the dump file.

## Tests

`npm test` (on the local scratch database): SQL splitting, named queries, bootstrap and failure reporting,
transactions, table existence, health, expiry warning, and start-up resilience:

- a database that is down at start and comes up later (simulated with a TCP relay that starts late);
- giving up at the wait limit;
- surviving an idle connection ended by the server;
- the bootstrap lock.

See [CODING_STANDARDS.md](./CODING_STANDARDS.md) (shared across all platform repositories) and [Issues.md](./Issues.md).
