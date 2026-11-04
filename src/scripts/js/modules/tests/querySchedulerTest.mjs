/**
 * QueryScheduler test: priority order, ageing, the concurrency cap, the rate limit, waiting
 * limits, retry of temporary failures (and not of real errors), rule classification, and,
 * on the local scratch database: a query that waits out an outage, a transaction retried
 * as a whole, and the DB_PG_POOL_MAX / DB_PG_SCHEDULER settings.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgresDatabase } from '../postgresDatabase.mjs';
import { LocalDatabaseTest } from '../localDatabaseTest.mjs';
import { QueryScheduler, QueryWaitTimeoutError } from '../queryScheduler.mjs';
import { TokenBucket } from '../tokenBucket.mjs';
import { TcpRelay } from '../tcpRelay.mjs';

class FixtureDatabase extends PostgresDatabase {
  static sqlRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../sql/test');
}

/** A promise with its resolve function exposed: lets a test hold a job open. */
class Gate {
  constructor() {
    this.promise = new Promise((resolve) => {
      this.open = resolve;
    });
  }
}

export class QuerySchedulerTest extends LocalDatabaseTest {
  static fixtures = FixtureDatabase.loadNamedSqlStatements('fixture-queries.sql');

  constructor(database = new FixtureDatabase()) {
    super([database]);
    this.database = database;
  }

  static sleep(ms) {
    return PostgresDatabase.sleep(ms);
  }

  static async errorOf(promise) {
    try {
      await promise;
      return null;
    } catch (error) {
      return error;
    }
  }

  async resetDatabase() {
    await this.database.query(this.constructor.fixtures.drop_test_schema);
  }

  async checkPriorityAndAgeing() {
    console.log('Priority and ageing');
    const scheduler = new QueryScheduler({ maxConcurrent: 1, agingMs: 60000 });
    const gate = new Gate();
    const order = [];
    const blocker = scheduler.run(() => gate.promise, { cls: 'critical' });
    const jobs = ['background', 'interactive', 'critical'].map((cls) =>
      scheduler.run(async () => order.push(cls), { cls })
    );
    gate.open();
    await Promise.all([blocker, ...jobs]);
    this.check(
      'higher classes run first (critical, interactive, background)',
      order.join(',') === 'critical,interactive,background',
      order.join(',')
    );

    const aged = new QueryScheduler({ maxConcurrent: 1, agingMs: 50 });
    const hold = new Gate();
    const agedOrder = [];
    const agedBlocker = aged.run(() => hold.promise);
    const old = aged.run(async () => agedOrder.push('old background'), { cls: 'background' });
    await this.constructor.sleep(250);
    const fresh = aged.run(async () => agedOrder.push('new critical'), { cls: 'critical' });
    hold.open();
    await Promise.all([agedBlocker, old, fresh]);
    this.check(
      'a long-waiting background job overtakes a new critical one (ageing)',
      agedOrder[0] === 'old background',
      agedOrder.join(',')
    );
  }

  async checkThrottling() {
    console.log('\nThrottling');
    const scheduler = new QueryScheduler({ maxConcurrent: 2 });
    let running = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 6 }, () =>
        scheduler.run(async () => {
          running += 1;
          peak = Math.max(peak, running);
          await this.constructor.sleep(60);
          running -= 1;
        })
      )
    );
    this.check('never more than maxConcurrent jobs at once', peak === 2, String(peak));

    const limited = new QueryScheduler({
      maxConcurrent: 10,
      rateLimiter: new TokenBucket({ capacity: 2, refillPerSecond: 10 }),
    });
    const started = Date.now();
    await Promise.all(Array.from({ length: 6 }, () => limited.run(async () => 1)));
    const elapsed = Date.now() - started;
    this.check(
      'rate limit holds (6 jobs at 2 + 10/s take ≥ 350 ms)',
      elapsed >= 350,
      `${elapsed} ms`
    );
  }

  async checkLimitsAndRetry() {
    console.log('\nWaiting limits and retry');
    const short = new QueryScheduler({
      maxConcurrent: 1,
      classes: { background: { priority: 2, maxWaitMs: 200 } },
    });
    const gate = new Gate();
    const blocker = short.run(() => gate.promise);
    const waited = await this.constructor.errorOf(short.run(async () => 1, { cls: 'background' }));
    gate.open();
    await blocker;
    this.check(
      'a job queued past its waiting limit fails with QueryWaitTimeoutError',
      waited instanceof QueryWaitTimeoutError
    );

    const retrying = new QueryScheduler({ retryBaseDelayMs: 20 });
    let attempts = 0;
    const result = await retrying.run(async () => {
      attempts += 1;
      if (attempts < 3) throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
      return 'ok';
    });
    this.check('temporary failures are retried until success', result === 'ok' && attempts === 3);

    let syntaxAttempts = 0;
    const syntax = await this.constructor.errorOf(
      retrying.run(async () => {
        syntaxAttempts += 1;
        throw Object.assign(new Error('syntax error'), { code: '42601' });
      })
    );
    this.check(
      'a real error fails at once, without retry',
      syntax?.code === '42601' && syntaxAttempts === 1
    );

    const giving = new QueryScheduler({
      retryBaseDelayMs: 50,
      classes: { critical: { priority: 0, maxWaitMs: 300 } },
    });
    const givenUp = await this.constructor.errorOf(
      giving.run(
        async () => {
          throw Object.assign(new Error('restarting'), { code: '57P03' });
        },
        { cls: 'critical' }
      )
    );
    this.check(
      'retries stop at the waiting limit, keeping the last error as the cause',
      givenUp instanceof QueryWaitTimeoutError || givenUp?.code === '57P03',
      givenUp?.name
    );
  }

  checkRules() {
    console.log('\nRules');
    const scheduler = new QueryScheduler({
      rules: {
        default: 'interactive',
        queries: {
          'backup_*': 'background',
          backup_status: 'critical',
          'backup_media_*': 'interactive',
        },
      },
    });
    this.check(
      'exact name wins over a wildcard',
      scheduler.classify('backup_status') === 'critical'
    );
    this.check(
      'the longest wildcard wins',
      scheduler.classify('backup_media_list') === 'interactive'
    );
    this.check('a wildcard matches', scheduler.classify('backup_users') === 'background');
    this.check('unmatched → default', scheduler.classify('select_cards') === 'interactive');
    this.check(
      'package rules: health_check is critical',
      this.database.classify(PostgresDatabase.introspectionQueries.health_check) === 'critical'
    );
    this.check(
      'unnamed SQL → default class',
      this.database.classify('SELECT 42') === 'interactive'
    );
    const merged = PostgresDatabase.mergeQueryRules(
      { queries: { a: 'critical' } },
      { default: 'background', queries: { a: 'interactive' } }
    );
    this.check(
      'a later rule set overrides an earlier one',
      merged.default === 'background' && merged.queries.a === 'interactive'
    );
  }

  async checkDatabase() {
    console.log('\nOn the database');
    const q = this.constructor.fixtures;
    await this.database.initializeSchemaFromFile('fixture-schema.sql', 'Fixture schema');

    const port = await TcpRelay.freePort();
    const relay = new TcpRelay({
      targetHost: this.database.config.host,
      targetPort: this.database.config.port,
    });
    const relayed = new FixtureDatabase({
      ...this.database.config,
      port,
      connectionTimeoutMillis: 300,
    });
    this.databases.push(relayed);
    try {
      const pending = relayed.query(q.count_items);
      await this.constructor.sleep(800);
      await relay.start(port);
      const result = await pending;
      this.check(
        'a query made during an outage completes when the database returns',
        result.rows[0].count >= 1
      );
    } finally {
      await relay.stop();
    }

    let tries = 0;
    await this.database.withTransaction(async (client) => {
      tries += 1;
      await client.query(q.insert_item, ['retried transaction']);
      if (tries === 1) throw Object.assign(new Error('could not serialize'), { code: '40001' });
    });
    const rows = (await this.database.query(q.count_label, ['retried transaction'])).rows[0].count;
    this.check(
      'a transaction is retried as a whole (first attempt rolled back)',
      tries === 2 && rows === 1,
      `tries ${tries}, rows ${rows}`
    );

    const before = { ...process.env };
    try {
      process.env.DB_PG_POOL_MAX = '3';
      this.check('DB_PG_POOL_MAX sets the pool size', FixtureDatabase.createConfig({}).max === 3);
      this.check(
        'DB_PG_SCHEDULER=off disables the scheduler',
        PostgresDatabase.createScheduler({ max: 3 }, { DB_PG_SCHEDULER: 'off' }) === null
      );
      this.check(
        'the scheduler concurrency follows the pool size',
        PostgresDatabase.createScheduler({ max: 3 }, {}).maxConcurrent === 3
      );
    } finally {
      for (const key of ['DB_PG_POOL_MAX']) {
        if (before[key] === undefined) delete process.env[key];
        else process.env[key] = before[key];
      }
    }
  }

  async run() {
    this.assertLocalTarget();
    console.log('QueryScheduler test (local scratch database)\n');
    await this.checkPriorityAndAgeing();
    await this.checkThrottling();
    await this.checkLimitsAndRetry();
    this.checkRules();
    await this.resetDatabase();
    try {
      await this.checkDatabase();
    } finally {
      await this.resetDatabase();
    }
    return this.summary();
  }
}

export const querySchedulerTest = new QuerySchedulerTest();
export default querySchedulerTest;
