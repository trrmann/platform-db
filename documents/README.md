# platform-db

Shared PostgreSQL layer for the platform's applications (iam-service, FlashCards, request-queue, …).
It is a **library**, not a service: each application uses it in-process against the shared database.

| Export                                    | Purpose                                                                                                                                                                                                                                      |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PostgresDatabase`                        | Base adapter: pool, `static SCHEMA` (connection `search_path`), `static sqlRoot`, SQL file and named-query loading, `waitForConnection`, `initializeSchemaFromFile`, `withTransaction`, `tableExists`, `healthCheck`, `DB_PG_EXPIRE` warning |
| `DatabaseUnavailableError`                | Thrown by `waitForConnection()` when the database didn't answer within the wait limit (`attempts`, `waitedMs`, `cause`)                                                                                                                      |
| `LocalDatabaseTest`                       | Base class for tests on a local scratch database: local-only guard, checks, summary, pool cleanup                                                                                                                                            |
| `DatabaseTargetGuard`                     | `DatabaseTargetGuard.assert(env, config)`: a development or preview server may use only a local or read-only database (override `DB_PG_ALLOW_REMOTE_WRITES=true`). Call it before anything touches the database                              |
| `QueryScheduler`, `QueryWaitTimeoutError` | Queues, throttles and prioritises database work (see "Queued database work")                                                                                                                                                                 |
| `TokenBucket`                             | Rate limiter (burst + refill per second), shared with request-queue                                                                                                                                                                          |
| `TcpRelay`                                | Test tooling: forwards a local port to the scratch database. Start it late to simulate a database that comes up after the service; stop it to simulate an outage                                                                             |

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

## Queued database work

Every `query()` and `withTransaction()` runs through the adapter's `QueryScheduler` (memory only, since it waits for
the database). Schema bootstrap and `waitForConnection()` bypass it.

| Setting                                      | Default                                                 | Meaning                                                                                                 |
| -------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Concurrency                                  | the pool size (`DB_PG_POOL_MAX`, default 20)            | at most this many queries or transactions at once                                                       |
| `DB_PG_RATE_PER_SECOND` / `DB_PG_RATE_BURST` | off                                                     | optional rate limit (token bucket)                                                                      |
| Classes                                      | `critical` 5 s, `interactive` 30 s, `background` 10 min | priority order and the longest a job may wait (queue + retries)                                         |
| Ageing                                       | 5 s                                                     | a waiting job gains one priority step every 5 s, so background work is never starved                    |
| `DB_PG_QUERY_RULES`                          | none                                                    | JSON file `{ "default": "interactive", "queries": { "backup_*": "background" } }`                       |
| `DB_PG_SCHEDULER=off`                        | on                                                      | bypass the scheduler (escape hatch)                                                                     |
| `DB_PG_LOG_QUERIES`                          | `slow` in production (or on Render), else `all`         | `all`, `slow` (only queries ≥ `DB_PG_SLOW_QUERY_MS`, default 500) or `off`; parameters are never logged |

- **Rules** map named queries (from `-- Query: name` sections) to classes. Precedence: this package's
  (`health_check`, `connection_probe`, `table_exists` are `critical`), then the adapter's `static QUERY_RULES`, then the
  `DB_PG_QUERY_RULES` file. An exact name beats a wildcard, and a longer wildcard beats a shorter one. A call can
  override: `db.query(sql, params, { priority: 'background' })`, `db.withTransaction(work, { priority })`, and shorten
  the waiting limit with `{ maxWaitMs }` (callers with their own retry, like request-queue's store, use a short one).
- **Retry:** temporary failures are retried with backoff (0.2 s doubling to 5 s) within the class's waiting limit:
  connection refused or dropped, `57P01`/`57P02`/`57P03` restarts, `53300` too many connections, `08xxx`
  connection errors, `40001`/`40P01` serialization and deadlock. Real errors (syntax, constraint) fail at once.
- **Transactions are one job,** so a retry reruns the whole `work(client)`: it must be safe to run again. Inside it use
  `client.query`. Calling the adapter's `query()` from inside takes a second slot.
- A job still queued at its waiting limit fails with `QueryWaitTimeoutError` (`cause`: the last error). A running job
  is never interrupted.

## Local scratch database

`src/scripts/sh/local-db.sh` runs one private PostgreSQL cluster (127.0.0.1:5433, data in
`~/.local/share/platform-db`) shared by every project; each project gets its own database named after its
`package.json` name (`flashcards_local`, `iam_service_local`, `platform_db_local`, …). Its app user mirrors the
Render database's default login: not a superuser, but allowed to create roles (`CREATEROLE`), so iam-service's
per-app login provisioning can be tested locally. Clusters made earlier get the right on their next `start`. Projects call it through a
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
