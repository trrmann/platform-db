/**
 * Base class for tests that run against a local scratch database (local-db.sh).
 * Provides the safety guard (refuses any non-local target, because such tests
 * drop and rebuild schemas), check bookkeeping, the summary, and pool cleanup.
 * Subclasses implement resetDatabase() and run().
 */

export class LocalDatabaseTest {
  static LOCAL_HOSTS = ['127.0.0.1', 'localhost'];
  static LOCAL_DATABASE_SUFFIX = '_local';

  /**
   * @param {Array<import('./postgresDatabase.mjs').PostgresDatabase>} databases - Adapters under test
   */
  constructor(databases) {
    this.databases = databases;
    this.failures = [];
    this.checks = 0;
  }

  /**
   * Refuse to run anywhere except a local scratch database.
   */
  assertLocalTarget() {
    for (const db of this.databases) {
      const { host, database } = db.config;
      const local =
        LocalDatabaseTest.LOCAL_HOSTS.includes(host) &&
        String(database).endsWith(LocalDatabaseTest.LOCAL_DATABASE_SUFFIX);
      if (!local) {
        throw new Error(
          `Refusing to run: target ${host}/${database} is not a local scratch database. Use: local-db.sh run …`
        );
      }
    }
  }

  check(label, condition, detail = '') {
    this.checks += 1;
    if (condition) {
      console.log(`  ✓ ${label}`);
    } else {
      console.log(`  ✗ ${label}${detail ? `: ${detail}` : ''}`);
      this.failures.push(label);
    }
  }

  summary() {
    console.log(`\n${this.checks - this.failures.length}/${this.checks} checks passed`);
    return { success: this.failures.length === 0, failures: this.failures };
  }

  async resetDatabase() {
    throw new Error(`${this.constructor.name} must implement resetDatabase()`);
  }

  async run() {
    throw new Error(`${this.constructor.name} must implement run()`);
  }

  /**
   * Run the test and always release the database pools. Returns true on success.
   */
  async execute() {
    try {
      const { success } = await this.run();
      return success;
    } finally {
      await this.close();
    }
  }

  async close() {
    for (const db of new Set(this.databases)) {
      await db.close();
    }
  }
}

export default LocalDatabaseTest;
