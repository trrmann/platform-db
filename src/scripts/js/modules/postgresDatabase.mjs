/**
 * Generic PostgreSQL adapter (platform-db): connection pool, schema search path,
 * SQL file loading (whole files and named queries), schema bootstrap,
 * transactions, health checks, and the free-tier expiry warning.
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

  /**
   * PostgreSQL schema owned by the adapter (null = server default). Subclasses
   * set it; connections then use search_path = <schema>, public, so the
   * adapter's SQL stays unqualified within its own domain.
   */
  static SCHEMA = null;

  static initializeEnvironment() {
    return dotenv.config();
  }

  static createConfig(config = {}) {
    const isProduction = process.env.NODE_ENV === 'production' || process.env.RENDER;

    return {
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
      max: config.max ?? this.DEFAULT_POOL_MAX,
      idleTimeoutMillis: config.idleTimeoutMillis ?? this.DEFAULT_IDLE_TIMEOUT_MS,
      connectionTimeoutMillis: config.connectionTimeoutMillis ?? this.DEFAULT_CONNECTION_TIMEOUT_MS,
      options: config.options ?? (this.SCHEMA ? `-c search_path=${this.SCHEMA},public` : undefined),
      ...config,
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

  constructor(config = {}) {
    this.constructor.initializeEnvironment();

    const resolvedConfig = this.constructor.createConfig(config);

    this.config = resolvedConfig;
    this.pool = new this.constructor.Pool(resolvedConfig);

    this.pool.on('error', (err) => {
      console.error('Unexpected error on idle client', err);
      process.exit(-1);
    });
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
   * Commits when it resolves; rolls back and rethrows when it throws.
   */
  async withTransaction(work) {
    const queries = PostgresDatabase.transactionQueries;
    const client = await this.pool.connect();
    try {
      await client.query(queries.begin_transaction);
      const result = await work(client);
      await client.query(queries.commit_transaction);
      return result;
    } catch (error) {
      await client.query(queries.rollback_transaction);
      throw error;
    } finally {
      client.release();
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
   * Run every statement in a schema SQL file (idempotent bootstrap),
   * logging progress per statement, then list the public tables.
   * Throws if any statement fails so bootstrap problems are never silent.
   */
  async initializeSchemaFromFile(relativePath, bannerTitle) {
    const allSQL = this.constructor.loadSqlStatements(relativePath, this.constructor.sqlRoot);

    const describeStatement = (sql) => {
      const match = sql.match(
        /(CREATE|INSERT)\s+(?:INTO\s+)?(TABLE|INDEX|EXTENSION)?(?:\s+IF\s+NOT\s+EXISTS)?\s*("?[\w-]+"?)/i
      );
      if (match) {
        return `${match[1].toUpperCase()} ${match[2] ? match[2].toUpperCase() + ' ' : ''}${match[3]}`;
      }
      return sql.replace(/\s+/g, ' ').slice(0, 40);
    };

    const client = await this.pool.connect();

    try {
      console.log('╔════════════════════════════════════════════════╗');
      console.log(`║ ${bannerTitle.padEnd(46)} ║`);
      console.log('╚════════════════════════════════════════════════╝\n');
      console.log(`Host: ${this.config.host}`);
      console.log(`Database: ${this.config.database}\n`);

      const failures = [];

      for (let i = 0; i < allSQL.length; i += 1) {
        const label = describeStatement(allSQL[i]);
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
      client.release();
    }
  }

  async initializeDatabaseConnection() {
    let client = null;
    try {
      client = await this.pool.connect();
      await client.query(this.constructor.introspectionQueries.connection_probe);
      console.log(`✅ Database connected: ${this.config.host}`);
      return true;
    } catch (error) {
      console.error(`❌ Database connection failed: ${error.message}`);
      return false;
    } finally {
      // Always return the connection, or closing the pool waits forever.
      client?.release();
    }
  }

  async query(text, params = []) {
    const start = Date.now();

    try {
      const result = await this.pool.query(text, params);
      const duration = Date.now() - start;
      console.log('Executed query', { text, duration, rows: result.rowCount });
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
