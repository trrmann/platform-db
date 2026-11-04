/**
 * Generic PostgreSQL adapter (platform-db): connection pool, schema search path,
 * SQL file loading (whole files and named queries), schema bootstrap,
 * transactions, health checks, and the free-tier expiry warning.
 *
 * Start-up resilience: waitForConnection() retries with backoff until the
 * database answers (Render may start a service before its database, and free
 * databases restart); schema bootstrap holds an advisory lock so services that
 * start together never run their bootstraps at the same moment; and a dropped
 * idle connection is logged and replaced by the pool instead of ending the process.
 *
 * Subclasses set `static SCHEMA` (their PostgreSQL schema) and `static sqlRoot`
 * (their own SQL folder). The introspection and transaction queries always load
 * from this package's SQL folder.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import dotenv from 'dotenv';
import { QueryScheduler } from './queryScheduler.mjs';
import { TokenBucket } from './tokenBucket.mjs';

/**
 * The database did not answer within the wait limit of waitForConnection().
 */
export class DatabaseUnavailableError extends Error {
  /**
   * @param {string} message
   * @param {{attempts: number, waitedMs: number, cause?: Error}} details
   */
  constructor(message, { attempts, waitedMs, cause } = {}) {
    super(message, { cause });
    this.name = 'DatabaseUnavailableError';
    this.attempts = attempts;
    this.waitedMs = waitedMs;
  }
}

export class PostgresDatabase {
  static Pool = pg.Pool;
  static filePath = fileURLToPath(import.meta.url);
  static directory = path.dirname(this.filePath);
  static sqlRoot = path.resolve(this.directory, '../../sql');
  static DEFAULT_PORT = 5432;
  static DEFAULT_POOL_MAX = 20;
  static DEFAULT_IDLE_TIMEOUT_MS = 30000;
  static DEFAULT_CONNECTION_TIMEOUT_MS = 2000;
  static DEFAULT_SSL = { rejectUnauthorized: false };

  /** waitForConnection() defaults: total wait, first retry delay, longest retry delay. */
  static DEFAULT_CONNECT_WAIT_MS = 120000;
  static DEFAULT_RETRY_BASE_DELAY_MS = 500;
  static DEFAULT_RETRY_MAX_DELAY_MS = 10000;

  /**
   * Classes for the package's own queries; subclasses add theirs in `static QUERY_RULES`
   * ({ default?, queries: { 'name_or_glob*': 'critical' | 'interactive' | 'background' } }), and
   * DB_PG_QUERY_RULES may name a JSON file with the same shape (applied last).
   */
  static DEFAULT_QUERY_RULES = {
    queries: { connection_probe: 'critical', health_check: 'critical', table_exists: 'critical' },
  };

  static QUERY_RULES = {};

  /** SQL text → query name, filled by loadNamedSqlStatements (lets rules name queries). */
  static queryNames = new Map();

  /** Advisory lock held while any schema file is bootstrapped (one at a time per database). */
  static BOOTSTRAP_LOCK_KEY = 'platform-db:schema-bootstrap';

  /**
   * PostgreSQL schema owned by the adapter (null = server default). Subclasses
   * set it; connections then use search_path = <schema>, public, so the
   * adapter's SQL stays unqualified within its own domain.
   */
  static SCHEMA = null;

  static initializeEnvironment() {
    return dotenv.config();
  }

  /**
   * PostgreSQL connection options: the adapter's search_path, plus a read-only default for
   * every transaction when `readOnly` is set (PostgreSQL then refuses any write, error 25006).
   */
  static connectionOptions(baseOptions, readOnly) {
    const options = [];
    const base = baseOptions ?? (this.SCHEMA ? `-c search_path=${this.SCHEMA},public` : undefined);
    if (base) options.push(base);
    if (readOnly && !base?.includes(this.READ_ONLY_OPTION)) options.push(this.READ_ONLY_OPTION);
    return options.length > 0 ? options.join(' ') : undefined;
  }

  static READ_ONLY_OPTION = '-c default_transaction_read_only=on';

  /**
   * Pool configuration from explicit settings, else DB_PG_* environment variables.
   * DB_PG_READ_ONLY=true (or `readOnly: true`) makes every session read-only: used to point a
   * local server at production safely (no writes, no schema bootstrap).
   */
  static createConfig(config = {}) {
    const isProduction = process.env.NODE_ENV === 'production' || process.env.RENDER;
    const readOnly = config.readOnly ?? process.env.DB_PG_READ_ONLY === 'true';

    // Explicit settings first; the computed fields below use them when given, so a key that is
    // present but undefined still gets its default, and readOnly always reaches the options.
    return {
      ...config,
      host:
        config.host ??
        (isProduction
          ? process.env.DB_PG_INTERNAL_HOSTNAME
          : process.env.DB_PG_EXTERNAL_HOSTNAME || process.env.DB_PG_INTERNAL_HOSTNAME),
      port: config.port ?? Number(process.env.DB_PG_PORT || this.DEFAULT_PORT),
      database: config.database ?? process.env.DB_PG_DATABASE,
      user: config.user ?? process.env.DB_PG_USER,
      password: config.password ?? process.env.DB_PG_PASSWORD,
      // DB_PG_SSL=disable is for the local scratch cluster (local-db.sh); Render requires SSL.
      ssl: config.ssl ?? (process.env.DB_PG_SSL === 'disable' ? false : this.DEFAULT_SSL),
      max: config.max ?? Number(process.env.DB_PG_POOL_MAX || this.DEFAULT_POOL_MAX),
      idleTimeoutMillis: config.idleTimeoutMillis ?? this.DEFAULT_IDLE_TIMEOUT_MS,
      connectionTimeoutMillis: config.connectionTimeoutMillis ?? this.DEFAULT_CONNECTION_TIMEOUT_MS,
      options: this.connectionOptions(config.options, readOnly),
      readOnly,
    };
  }

  static loadSqlStatements(relativePath, sqlRoot = this.sqlRoot) {
    const filePath = path.join(sqlRoot, relativePath);
    const sql = fs.readFileSync(filePath, 'utf8');
    return this.splitSqlStatements(sql);
  }

  static loadNamedSqlStatements(relativePath, sqlRoot = this.sqlRoot) {
    const filePath = path.join(sqlRoot, relativePath);
    const sql = fs.readFileSync(filePath, 'utf8');
    const sections = sql.split(/^--\s*Query:\s*(\S+)\s*$/m);
    const named = {};

    for (let i = 1; i < sections.length; i += 2) {
      const name = sections[i];
      const statements = this.splitSqlStatements(sections[i + 1]);

      if (statements.length !== 1) {
        throw new Error(
          `Expected exactly one SQL statement for query "${name}" in ${relativePath}, found ${statements.length}`
        );
      }

      if (named[name]) {
        throw new Error(`Duplicate SQL query name "${name}" in ${relativePath}`);
      }

      named[name] = statements[0];
      PostgresDatabase.queryNames.set(statements[0], name);
    }

    return named;
  }

  static splitSqlStatements(sql) {
    const statements = [];
    let currentStatement = '';
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let inLineComment = false;
    let inBlockComment = false;
    let inDollarQuote = null;
    let index = 0;

    while (index < sql.length) {
      const char = sql[index];
      const next = sql[index + 1];

      if (inLineComment) {
        if (char === '\n') {
          inLineComment = false;
        }
        index += 1;
        continue;
      }

      if (inBlockComment) {
        if (char === '*' && next === '/') {
          inBlockComment = false;
          index += 2;
          continue;
        }
        index += 1;
        continue;
      }

      if (inDollarQuote) {
        const closingTag = `$${inDollarQuote}$`;
        if (sql.startsWith(closingTag, index)) {
          currentStatement += closingTag;
          index += closingTag.length;
          inDollarQuote = null;
          continue;
        }

        currentStatement += char;
        index += 1;
        continue;
      }

      if (inSingleQuote) {
        currentStatement += char;

        if (char === "'" && next === "'") {
          currentStatement += next;
          index += 2;
          continue;
        }

        if (char === "'") {
          inSingleQuote = false;
        }

        index += 1;
        continue;
      }

      if (inDoubleQuote) {
        currentStatement += char;

        if (char === '"' && next === '"') {
          currentStatement += next;
          index += 2;
          continue;
        }

        if (char === '"') {
          inDoubleQuote = false;
        }

        index += 1;
        continue;
      }

      if (char === '-' && next === '-') {
        inLineComment = true;
        index += 2;
        continue;
      }

      if (char === '/' && next === '*') {
        inBlockComment = true;
        index += 2;
        continue;
      }

      if (char === '$') {
        const match = sql.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$/);
        if (match) {
          currentStatement += match[0];
          inDollarQuote = match[0].slice(1, -1);
          index += match[0].length;
          continue;
        }
      }

      if (char === "'") {
        currentStatement += char;
        inSingleQuote = true;
        index += 1;
        continue;
      }

      if (char === '"') {
        currentStatement += char;
        inDoubleQuote = true;
        index += 1;
        continue;
      }

      if (char === ';') {
        // Comments outside quotes were already skipped while scanning; trimming is
        // enough (stripping "--" here would also cut string literals that contain it).
        const normalized = currentStatement.trim();
        if (normalized.length > 0) {
          statements.push(normalized);
        }
        currentStatement = '';
        index += 1;
        continue;
      }

      currentStatement += char;
      index += 1;
    }

    const finalStatement = currentStatement.trim();
    if (finalStatement.length > 0) {
      statements.push(finalStatement);
    }

    return statements;
  }

  /** Query log modes (DB_PG_LOG_QUERIES). */
  static QUERY_LOG_MODES = ['all', 'slow', 'off'];
  static DEFAULT_SLOW_QUERY_MS = 500;

  /**
   * How queries are logged: DB_PG_LOG_QUERIES = all | slow | off. Default: `slow` in production
   * (NODE_ENV=production or on Render), where every health check would otherwise add a line,
   * and `all` elsewhere. `slow` logs queries taking at least DB_PG_SLOW_QUERY_MS (default 500).
   * Parameters are never logged.
   * @returns {{mode: string, slowMs: number}}
   */
  static queryLogSettings(env = process.env) {
    const production = env.NODE_ENV === 'production' || Boolean(env.RENDER);
    const requested = String(env.DB_PG_LOG_QUERIES || '').toLowerCase();
    const mode = PostgresDatabase.QUERY_LOG_MODES.includes(requested)
      ? requested
      : production
        ? 'slow'
        : 'all';
    const slowMs = Number.parseInt(env.DB_PG_SLOW_QUERY_MS, 10);
    return {
      mode,
      slowMs:
        Number.isFinite(slowMs) && slowMs >= 0 ? slowMs : PostgresDatabase.DEFAULT_SLOW_QUERY_MS,
    };
  }

  /** Log one executed query according to the adapter's query log settings. */
  logQuery(text, duration, rows) {
    const { mode, slowMs } = this.queryLog;
    if (mode === 'off' || (mode === 'slow' && duration < slowMs)) return;
    console.log(mode === 'slow' ? 'Slow query' : 'Executed query', { text, duration, rows });
  }

  constructor(config = {}) {
    this.constructor.initializeEnvironment();
    this.queryLog = this.constructor.queryLogSettings(process.env);

    const resolvedConfig = this.constructor.createConfig(config);

    this.config = resolvedConfig;
    this.pool = new this.constructor.Pool(resolvedConfig);

    // An idle connection can drop when the database restarts. The pool discards it and opens a
    // new one on the next query, so this is logged rather than ending the process.
    this.pool.on('error', (error) => this.onIdleClientError(error));
    this.scheduler = this.constructor.createScheduler(this.config);
  }

  /**
   * The QueryScheduler for an adapter: concurrency = pool size, optional rate limit
   * (DB_PG_RATE_PER_SECOND, burst DB_PG_RATE_BURST), and the merged query rules.
   * Returns null when disabled (`scheduler: false`, or DB_PG_SCHEDULER=off).
   */
  static createScheduler(config, env = process.env) {
    if (config.scheduler === false || env.DB_PG_SCHEDULER === 'off') return null;
    const rate = Number(env.DB_PG_RATE_PER_SECOND || 0);
    return new QueryScheduler({
      maxConcurrent: config.max,
      rateLimiter:
        rate > 0
          ? new TokenBucket({
              capacity: Number(env.DB_PG_RATE_BURST || Math.max(1, Math.ceil(rate))),
              refillPerSecond: rate,
            })
          : null,
      rules: this.mergeQueryRules(
        PostgresDatabase.DEFAULT_QUERY_RULES,
        this.QUERY_RULES,
        config.queryRules ?? this.loadQueryRulesFile(env.DB_PG_QUERY_RULES)
      ),
    });
  }

  /** Combine rule sets; a later set overrides an earlier one's default and same patterns. */
  static mergeQueryRules(...ruleSets) {
    const merged = { default: undefined, queries: {} };
    for (const rules of ruleSets.filter(Boolean)) {
      if (rules.default) merged.default = rules.default;
      merged.queries = { ...merged.queries, ...rules.queries };
    }
    return merged;
  }

  /** Read a rules JSON file named by DB_PG_QUERY_RULES (none → no rules). */
  static loadQueryRulesFile(filePath) {
    if (!filePath) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  }

  /** The work class for a SQL text: by its query name through the rules, else the default. */
  classify(text) {
    return this.scheduler?.classify(PostgresDatabase.queryNames.get(text)) ?? null;
  }

  /** Run `work` through the scheduler in `cls` (directly when the scheduler is off). */
  schedule(work, cls, maxWaitMs) {
    return this.scheduler ? this.scheduler.run(work, { cls: cls ?? undefined, maxWaitMs }) : work();
  }

  /**
   * Log an error raised by an idle pooled connection (the pool has already removed it).
   */
  onIdleClientError(error) {
    console.error(`⚠️ Database connection dropped while idle (will reconnect): ${error.message}`);
  }

  /**
   * Wait `ms` milliseconds. A method so tests can replace it.
   */
  static sleep(ms) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  /**
   * Delay before retry number `attempt` (1-based): doubles from `baseDelayMs`, capped at `maxDelayMs`.
   */
  static retryDelay(attempt, baseDelayMs, maxDelayMs) {
    return Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  }

  /**
   * Whether failure number `attempt` should be logged: the 1st, 2nd, 4th, 8th, … so a long
   * outage doesn't flood the log.
   */
  static shouldLogAttempt(attempt) {
    return Number.isInteger(Math.log2(attempt));
  }

  static #lockQueries = null;

  static get lockQueries() {
    // Same subclass-safe pattern as introspectionQueries.
    if (!PostgresDatabase.#lockQueries) {
      PostgresDatabase.#lockQueries = PostgresDatabase.loadNamedSqlStatements(
        'pg/lock-queries.sql',
        PostgresDatabase.sqlRoot
      );
    }
    return PostgresDatabase.#lockQueries;
  }

  /**
   * Try the connection once. Returns null on success, else the error (nothing is logged).
   */
  async probeConnection() {
    let client = null;
    try {
      client = await this.pool.connect();
      await client.query(this.constructor.introspectionQueries.connection_probe);
      return null;
    } catch (error) {
      return error;
    } finally {
      // Always return the connection, or closing the pool waits forever.
      client?.release();
    }
  }

  /**
   * Wait until the database answers, retrying with exponential backoff.
   * Resolves with the number of attempts; throws DatabaseUnavailableError after `maxWaitMs`.
   * @param {{maxWaitMs?: number, baseDelayMs?: number, maxDelayMs?: number}} [options]
   */
  async waitForConnection({
    maxWaitMs = this.constructor.DEFAULT_CONNECT_WAIT_MS,
    baseDelayMs = this.constructor.DEFAULT_RETRY_BASE_DELAY_MS,
    maxDelayMs = this.constructor.DEFAULT_RETRY_MAX_DELAY_MS,
  } = {}) {
    const started = Date.now();
    for (let attempt = 1; ; attempt += 1) {
      const error = await this.probeConnection();
      const waitedMs = Date.now() - started;
      if (!error) {
        const after = attempt > 1 ? ` after ${attempt} attempts (${waitedMs} ms)` : '';
        console.log(`✅ Database connected: ${this.config.host}${after}`);
        return attempt;
      }
      const delay = this.constructor.retryDelay(attempt, baseDelayMs, maxDelayMs);
      if (waitedMs + delay > maxWaitMs) {
        console.error(`❌ Database unavailable after ${attempt} attempts: ${error.message}`);
        throw new DatabaseUnavailableError(
          `Database ${this.config.host} did not answer within ${maxWaitMs} ms`,
          { attempts: attempt, waitedMs, cause: error }
        );
      }
      if (this.constructor.shouldLogAttempt(attempt)) {
        console.warn(
          `⏳ Database not reachable yet (attempt ${attempt}): ${error.message}. Retrying in ${delay} ms`
        );
      }
      await this.constructor.sleep(delay);
    }
  }

  static #introspectionQueries = null;

  static #transactionQueries = null;

  static get transactionQueries() {
    // Same subclass-safe pattern as introspectionQueries.
    if (!PostgresDatabase.#transactionQueries) {
      PostgresDatabase.#transactionQueries = PostgresDatabase.loadNamedSqlStatements(
        'pg/transaction-queries.sql',
        PostgresDatabase.sqlRoot
      );
    }
    return PostgresDatabase.#transactionQueries;
  }

  /**
   * Run `work(client)` inside one transaction on a dedicated connection.
   * Commits when it resolves; rolls back and rethrows when it throws. Scheduled as one job
   * (default class `interactive`, or `priority`), so a temporary failure (deadlock,
   * serialization failure, dropped connection) reruns the whole transaction: `work` must
   * be safe to run again. Inside `work`, use `client.query`, not this adapter's query().
   */
  withTransaction(work, { priority, maxWaitMs } = {}) {
    return this.schedule(() => this.runTransaction(work), priority, maxWaitMs);
  }

  async runTransaction(work) {
    const queries = PostgresDatabase.transactionQueries;
    const client = await this.pool.connect();
    let broken = null;
    try {
      await client.query(queries.begin_transaction);
      const result = await work(client);
      await client.query(queries.commit_transaction);
      return result;
    } catch (error) {
      // A failed rollback (e.g. the connection dropped) must not hide the original error.
      await client.query(queries.rollback_transaction).catch((rollbackError) => {
        broken = rollbackError;
      });
      throw error;
    } finally {
      client.release(broken ?? undefined);
    }
  }

  static get introspectionQueries() {
    // Reference PostgresDatabase explicitly: private static fields are only
    // declared on this class, so `this.#...` would throw when the getter is
    // reached through a subclass such as FlashCardsDatabase.
    if (!PostgresDatabase.#introspectionQueries) {
      PostgresDatabase.#introspectionQueries = PostgresDatabase.loadNamedSqlStatements(
        'pg/postgres-introspection.sql',
        PostgresDatabase.sqlRoot
      );
    }
    return PostgresDatabase.#introspectionQueries;
  }

  /**
   * Check whether a table exists (plain name via search_path, or schema.table).
   */
  async tableExists(tableName) {
    const result = await this.query(this.constructor.introspectionQueries.table_exists, [
      tableName,
    ]);
    return Boolean(result.rows[0]?.exists);
  }

  /**
   * Short label for a schema statement in the bootstrap log.
   */
  static describeStatement(sql) {
    const match = sql.match(
      /(CREATE|INSERT)\s+(?:INTO\s+)?(TABLE|INDEX|EXTENSION)?(?:\s+IF\s+NOT\s+EXISTS)?\s*("?[\w-]+"?)/i
    );
    if (match) {
      return `${match[1].toUpperCase()} ${match[2] ? match[2].toUpperCase() + ' ' : ''}${match[3]}`;
    }
    return sql.replace(/\s+/g, ' ').slice(0, 40);
  }

  /**
   * Run every statement in a schema SQL file (idempotent bootstrap),
   * logging progress per statement, then list the public tables.
   * Throws if any statement fails so bootstrap problems are never silent.
   * Holds the bootstrap advisory lock for the whole file, so two processes never bootstrap
   * at the same moment (concurrent CREATE ... IF NOT EXISTS can still collide in PostgreSQL).
   */
  async initializeSchemaFromFile(relativePath, bannerTitle) {
    if (this.config.readOnly) {
      throw new Error(
        `Schema bootstrap of ${relativePath} refused: the connection is read-only (DB_PG_READ_ONLY)`
      );
    }
    const allSQL = this.constructor.loadSqlStatements(relativePath, this.constructor.sqlRoot);
    const locks = PostgresDatabase.lockQueries;
    const lockKey = this.constructor.BOOTSTRAP_LOCK_KEY;

    const client = await this.pool.connect();

    try {
      await client.query(locks.acquire_advisory_lock, [lockKey]);
      console.log('╔════════════════════════════════════════════════╗');
      console.log(`║ ${bannerTitle.padEnd(46)} ║`);
      console.log('╚════════════════════════════════════════════════╝\n');
      console.log(`Host: ${this.config.host}`);
      console.log(`Database: ${this.config.database}\n`);

      const failures = [];

      for (let i = 0; i < allSQL.length; i += 1) {
        const label = this.constructor.describeStatement(allSQL[i]);
        try {
          process.stdout.write(`[${i + 1}/${allSQL.length}] ${label}... `);
          await client.query(allSQL[i]);
          console.log('✅');
        } catch (error) {
          console.log('⚠️');
          console.error(`  Error: ${error.message}`);
          failures.push(`${label}: ${error.message}`);
        }
      }

      const result = await client.query(this.constructor.introspectionQueries.list_schema_tables);

      console.log(`Tables now present in schema: ${result.rows.length}`);

      if (failures.length > 0) {
        console.error(`❌ Schema bootstrap failed: ${failures.length} statement(s) errored.`);
        throw new Error(
          `Schema bootstrap of ${relativePath} failed: ${failures.length} statement(s) errored. First failure - ${failures[0]}`
        );
      }

      console.log('\n✅ Schema bootstrap complete!');
      return result.rows;
    } finally {
      // The lock is session-level: release it before the connection goes back to the pool.
      // If the connection itself died, PostgreSQL released the lock with the session.
      await client.query(locks.release_advisory_lock, [lockKey]).catch(() => {});
      client.release();
    }
  }

  /**
   * Try the connection once and log the result. Returns true when connected.
   * Start-up code should prefer waitForConnection(), which retries.
   */
  async initializeDatabaseConnection() {
    const error = await this.probeConnection();
    if (error) {
      console.error(`❌ Database connection failed: ${error.message}`);
      return false;
    }
    console.log(`✅ Database connected: ${this.config.host}`);
    return true;
  }

  /**
   * Run one statement through the scheduler. Its class comes from the rules by query name
   * (named queries only), or from `priority` ('critical' | 'interactive' | 'background').
   * `maxWaitMs` shortens the class's waiting limit for this call.
   */
  query(text, params = [], { priority, maxWaitMs } = {}) {
    return this.schedule(
      () => this.runQuery(text, params),
      priority ?? this.classify(text),
      maxWaitMs
    );
  }

  async runQuery(text, params) {
    const start = Date.now();

    try {
      const result = await this.pool.query(text, params);
      const duration = Date.now() - start;
      this.logQuery(text, duration, result.rowCount);
      return result;
    } catch (error) {
      console.error('Database query error:', error.message);
      throw error;
    }
  }

  async getClient() {
    return this.pool.connect();
  }

  async healthCheck() {
    try {
      await this.query(this.constructor.introspectionQueries.health_check);
      return {
        status: 'healthy',
        database: this.config.database,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        error: error.message,
        timestamp: new Date().toISOString(),
      };
    }
  }

  async close() {
    await this.pool.end();
  }

  /**
   * Parse DB_PG_EXPIRE. A date-only value (YYYY-MM-DD) is a *local* calendar date;
   * `new Date('YYYY-MM-DD')` would read it as UTC midnight, which is the previous
   * day in time zones behind UTC.
   */
  static parseExpiryDate(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value).trim());
    if (match) return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    return new Date(value);
  }

  getDbExpirationInfo() {
    const expirationDateStr = process.env.DB_PG_EXPIRE;

    if (!expirationDateStr) {
      return {
        daysRemaining: null,
        expirationDate: null,
        status: 'unknown',
      };
    }

    try {
      const expirationDate = PostgresDatabase.parseExpiryDate(expirationDateStr);
      const today = new Date();

      today.setHours(0, 0, 0, 0);
      expirationDate.setHours(0, 0, 0, 0);

      const daysRemaining = Math.ceil((expirationDate - today) / (1000 * 60 * 60 * 24));

      let status = 'safe';
      if (daysRemaining <= 0) {
        status = 'expired';
      } else if (daysRemaining === 1) {
        status = 'critical-1day';
      } else if (daysRemaining <= 3) {
        status = 'critical';
      } else if (daysRemaining <= 10) {
        status = 'warning';
      }

      return {
        daysRemaining,
        expirationDate: expirationDate.toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'long',
          day: 'numeric',
        }),
        status,
      };
    } catch (error) {
      console.error('Error parsing DB expiration date:', error);
      return {
        daysRemaining: null,
        expirationDate: null,
        status: 'unknown',
      };
    }
  }

  getExpirationWarning() {
    const info = this.getDbExpirationInfo();

    if (info.status === 'safe' || info.status === 'unknown') {
      return { message: null, level: null };
    }

    if (info.status === 'expired') {
      return {
        message: `⚠️ DATABASE EXPIRED - Expires: ${info.expirationDate}. Contact support immediately!`,
        level: 'expired',
      };
    }

    if (info.status === 'critical-1day') {
      return {
        message: `🚨 DATABASE EXPIRES IN 1 DAY - ${info.expirationDate}. Action required immediately!`,
        level: 'critical-1day',
      };
    }

    if (info.status === 'critical') {
      return {
        message: `🔴 DATABASE EXPIRES IN ${info.daysRemaining} DAYS - ${info.expirationDate}. Action needed soon!`,
        level: 'critical',
      };
    }

    if (info.status === 'warning') {
      return {
        message: `⚠️ DATABASE EXPIRES IN ${info.daysRemaining} DAYS - ${info.expirationDate}`,
        level: 'warning',
      };
    }

    return { message: null, level: null };
  }
}

export default PostgresDatabase;
