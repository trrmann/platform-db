/**
 * PostgresDatabase test (platform-db): SQL splitting and named-query loading,
 * connection and health, schema bootstrap (including failure reporting),
 * table existence, transactions (commit and rollback), the expiry warning, and start-up
 * resilience (waiting for a database that comes up late, giving up after the limit,
 * surviving a dropped idle connection, and the schema bootstrap lock).
 * Runs only against the local scratch database (local-db.sh).
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgresDatabase, DatabaseUnavailableError } from '../postgresDatabase.mjs';
import { LocalDatabaseTest } from '../localDatabaseTest.mjs';
import { TcpRelay } from './tcpRelay.mjs';

class FixtureDatabase extends PostgresDatabase {
  static sqlRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../sql/test');
}

export class PostgresDatabaseTest extends LocalDatabaseTest {
  static fixtures = FixtureDatabase.loadNamedSqlStatements('fixture-queries.sql');

  constructor(database = new FixtureDatabase()) {
    super([database]);
    this.database = database;
  }

  async resetDatabase() {
    await this.database.query(this.constructor.fixtures.drop_test_schema);
  }

  static throws(work) {
    try {
      work();
      return false;
    } catch {
      return true;
    }
  }

  checkSqlLoading() {
    console.log('SQL loading');
    const statements = FixtureDatabase.loadSqlStatements('fixture-schema.sql');
    this.check(
      'fixture splits into 4 statements',
      statements.length === 4,
      String(statements.length)
    );
    this.check(
      'dollar-quoted body kept whole',
      statements.some(
        (s) => s.startsWith('DO $guard$') && s.includes('PERFORM 1;') && s.endsWith('$guard$')
      )
    );
    this.check(
      'semicolon inside a string kept',
      statements.some((s) => s.includes("'semi;colon -- not a comment'"))
    );
    this.check('comments removed', !statements.some((s) => s.includes('block comment')));
    this.check('named queries load', Object.keys(this.constructor.fixtures).length === 7);
    this.check(
      'duplicate query names rejected',
      this.constructor.throws(() => FixtureDatabase.loadNamedSqlStatements('fixture-duplicate.sql'))
    );
    this.check(
      'more than one statement per named query rejected',
      this.constructor.throws(() => FixtureDatabase.loadNamedSqlStatements('fixture-multiple.sql'))
    );
  }

  async checkDatabase() {
    console.log('\nConnection, bootstrap, transactions');
    const q = this.constructor.fixtures;
    this.check('connects', await this.database.initializeDatabaseConnection());
    this.check('health is healthy', (await this.database.healthCheck()).status === 'healthy');
    await this.database.initializeSchemaFromFile('fixture-schema.sql', 'Fixture schema');
    this.check(
      'bootstrap created the table',
      await this.database.tableExists('platform_test.items')
    );
    this.check(
      'missing table reported as absent',
      !(await this.database.tableExists('platform_test.nope'))
    );
    const seeded = (await this.database.query(q.count_label, ['semi;colon -- not a comment']))
      .rows[0].count;
    this.check('bootstrap inserted the seed row intact', seeded === 1);

    let bootstrapError = null;
    try {
      await this.database.initializeSchemaFromFile('fixture-broken.sql', 'Broken fixture');
    } catch (error) {
      bootstrapError = error;
    }
    this.check(
      'failing bootstrap throws',
      /1 statement\(s\) errored/.test(bootstrapError?.message || '')
    );
    this.check(
      'statements after the failure still ran',
      await this.database.tableExists('platform_test.after_failure')
    );

    const before = (await this.database.query(q.count_items)).rows[0].count;
    await this.database.withTransaction(async (client) => {
      await client.query(q.insert_item, ['committed']);
    });
    this.check(
      'transaction commits',
      (await this.database.query(q.count_items)).rows[0].count === before + 1
    );
    let rolledBack = false;
    try {
      await this.database.withTransaction(async (client) => {
        await client.query(q.insert_item, ['rolled back']);
        throw new Error('abort');
      });
    } catch (error) {
      rolledBack = error.message === 'abort';
    }
    this.check('transaction rethrows the error', rolledBack);
    this.check(
      'transaction rolled back its insert',
      (await this.database.query(q.count_label, ['rolled back'])).rows[0].count === 0
    );
  }

  /**
   * A local calendar date `days` from today, as YYYY-MM-DD (how DB_PG_EXPIRE is written).
   */
  static localDateInDays(days) {
    const date = new Date();
    date.setDate(date.getDate() + days);
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${date.getFullYear()}-${month}-${day}`;
  }

  checkExpiry() {
    console.log('\nExpiry warning (DB_PG_EXPIRE)');
    const original = process.env.DB_PG_EXPIRE;
    const inDays = this.constructor.localDateInDays;
    try {
      const cases = [
        [inDays(30), 'safe'],
        [inDays(7), 'warning'],
        [inDays(2), 'critical'],
        [inDays(1), 'critical-1day'],
        [inDays(-1), 'expired'],
      ];
      for (const [date, status] of cases) {
        process.env.DB_PG_EXPIRE = date;
        const info = this.database.getDbExpirationInfo();
        this.check(`${date} → ${status}`, info.status === status, info.status);
      }
      delete process.env.DB_PG_EXPIRE;
      this.check('unset → unknown', this.database.getDbExpirationInfo().status === 'unknown');
    } finally {
      if (original === undefined) delete process.env.DB_PG_EXPIRE;
      else process.env.DB_PG_EXPIRE = original;
    }
  }

  /**
   * A second adapter on the same database with config overrides; closed with the test.
   */
  createAdapter(overrides) {
    const adapter = new FixtureDatabase({ ...this.database.config, ...overrides });
    this.databases.push(adapter);
    return adapter;
  }

  /**
   * Settle state of a promise without waiting for it: 'pending', 'resolved' or 'rejected'.
   */
  static async stateOf(promise) {
    const marker = Symbol('pending');
    try {
      const value = await Promise.race([promise, Promise.resolve(marker)]);
      return value === marker ? 'pending' : 'resolved';
    } catch {
      return 'rejected';
    }
  }

  async checkWaitForConnection() {
    console.log('\nStart-up: waiting for the database');
    const fast = { baseDelayMs: 100, maxDelayMs: 300 };
    this.check(
      'reachable database: connected on the first attempt',
      (await this.database.waitForConnection(fast)) === 1
    );

    const deadPort = await TcpRelay.freePort();
    const unreachable = this.createAdapter({ port: deadPort, connectionTimeoutMillis: 500 });
    let gaveUp = null;
    const started = Date.now();
    try {
      await unreachable.waitForConnection({ ...fast, maxWaitMs: 1200 });
    } catch (error) {
      gaveUp = error;
    }
    this.check(
      'unreachable database: gives up with DatabaseUnavailableError',
      gaveUp instanceof DatabaseUnavailableError,
      gaveUp?.message
    );
    this.check('… after retrying', gaveUp?.attempts > 1, String(gaveUp?.attempts));
    this.check('… within the wait limit', Date.now() - started < 3000);

    const latePort = await TcpRelay.freePort();
    const relay = new TcpRelay({
      targetHost: this.database.config.host,
      targetPort: this.database.config.port,
    });
    const late = this.createAdapter({ port: latePort, connectionTimeoutMillis: 500 });
    try {
      const waiting = late.waitForConnection({ ...fast, maxWaitMs: 15000 });
      await this.constructor.sleep(800);
      this.check(
        'database down at start: still waiting',
        (await this.constructor.stateOf(waiting)) === 'pending'
      );
      await relay.start(latePort);
      const attempts = await waiting;
      this.check('database comes up: connects', attempts > 1, String(attempts));
      this.check('… and queries work', (await late.healthCheck()).status === 'healthy');
    } finally {
      await late.close();
      this.databases.splice(this.databases.indexOf(late), 1);
      await relay.stop();
    }
  }

  async checkIdleConnectionDrop() {
    console.log('\nAn idle connection dropped by the server');
    const q = this.constructor.fixtures;
    const appName = 'platform_db_idle_drop_test';
    const idle = this.createAdapter({ application_name: appName, idleTimeoutMillis: 60000 });
    await idle.healthCheck(); // leaves one idle connection in the pool

    const originalExit = process.exit;
    let exitCalled = false;
    process.exit = () => {
      exitCalled = true;
    };
    try {
      const { terminated } = (
        await this.database.query(q.terminate_application_sessions, [appName])
      ).rows[0];
      this.check('server ended the idle connection', terminated === 1, String(terminated));
      await this.constructor.sleep(300);
      this.check('process keeps running', !exitCalled);
    } finally {
      process.exit = originalExit;
    }
    this.check(
      'pool reconnects on the next query',
      (await idle.healthCheck()).status === 'healthy'
    );
  }

  async checkBootstrapLock() {
    console.log('\nSchema bootstrap lock');
    const q = this.constructor.fixtures;
    const key = PostgresDatabase.BOOTSTRAP_LOCK_KEY;
    const holder = await this.database.getClient();
    const other = this.createAdapter({});
    try {
      await holder.query(PostgresDatabase.lockQueries.acquire_advisory_lock, [key]);
      const bootstrap = other.initializeSchemaFromFile('fixture-schema.sql', 'Locked bootstrap');
      bootstrap.catch(() => {});
      await this.constructor.sleep(500);
      this.check(
        'bootstrap waits while another process holds the lock',
        (await this.constructor.stateOf(bootstrap)) === 'pending'
      );
      await holder.query(q.release_advisory_lock, [key]);
      await bootstrap;
      this.check('bootstrap runs once the lock is free', true);
      const { locked } = (await holder.query(q.try_advisory_lock, [key])).rows[0];
      this.check('bootstrap released the lock afterwards', locked === true);
      await holder.query(q.release_advisory_lock, [key]);
    } finally {
      holder.release();
    }
  }

  static sleep(ms) {
    return PostgresDatabase.sleep(ms);
  }

  async run() {
    this.assertLocalTarget();
    console.log('PostgresDatabase test (local scratch database)\n');
    this.checkSqlLoading();
    await this.resetDatabase();
    await this.checkDatabase();
    this.checkExpiry();
    await this.checkWaitForConnection();
    await this.checkIdleConnectionDrop();
    await this.checkBootstrapLock();
    await this.resetDatabase();
    return this.summary();
  }
}

export const postgresDatabaseTest = new PostgresDatabaseTest();
export default postgresDatabaseTest;
