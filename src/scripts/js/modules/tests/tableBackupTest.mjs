/**
 * TableBackup test (local scratch database): export, then import into a freshly created schema
 * whose generated ids differ, with natural-key remapping, user-id remapping, a row key that
 * isn't a column (including an injection attempt) skipped with a warning, re-import changing
 * nothing, serial realignment, and refusal of a table without a primary key.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgresDatabase } from '../postgresDatabase.mjs';
import { LocalDatabaseTest } from '../localDatabaseTest.mjs';
import { TableBackup } from '../tableBackup.mjs';

class FixtureDatabase extends PostgresDatabase {
  static sqlRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../sql/test');
}

export class TableBackupTest extends LocalDatabaseTest {
  static fixtures = FixtureDatabase.loadNamedSqlStatements('backup-fixture-queries.sql');
  static OWNER = '11111111-1111-1111-1111-111111111111';
  static NEW_OWNER = '22222222-2222-2222-2222-222222222222';

  constructor(database = new FixtureDatabase()) {
    super([database]);
    this.database = database;
    this.backup = new TableBackup({
      database,
      schema: 'platform_backup_test',
      tables: ['kinds', 'things'],
      naturalKeyTables: { kinds: { naturalKey: ['code'], id: 'kind_id' } },
      serialPkTables: { things: 'thing_id' },
    });
  }

  async createSchema() {
    const q = this.constructor.fixtures;
    await this.database.query(q.backup_drop_schema);
    await this.database.query(q.backup_create_schema);
    await this.database.query(q.backup_create_kinds);
    await this.database.query(q.backup_create_things);
  }

  async importAll(data) {
    const results = { imported: {}, warnings: [] };
    await this.database.withTransaction((client) =>
      this.backup.importTables(client, data, results)
    );
    return results;
  }

  async rows() {
    return (await this.database.query(this.constructor.fixtures.backup_things_with_codes)).rows;
  }

  async run() {
    this.assertLocalTarget();
    console.log('TableBackup test (local scratch database)\n');
    const q = this.constructor.fixtures;
    try {
      this.check(
        'identifiers are checked',
        (() => {
          try {
            new TableBackup({ database: this.database, schema: 'x', tables: ['bad name'] });
            return false;
          } catch {
            return true;
          }
        })()
      );

      await this.createSchema();
      const red = (await this.database.query(q.backup_insert_kind, ['red', 'Red'])).rows[0].kind_id;
      await this.database.query(q.backup_insert_thing, [red, this.constructor.OWNER, 'apple']);
      await this.database.query(q.backup_insert_thing, [null, null, 'stone']);
      const before = await this.rows();
      const exported = await this.backup.exportTables();
      this.check(
        "export has every row and each table's columns",
        exported.data.kinds.length === 1 &&
          exported.data.things.length === 2 &&
          exported.schema.things.columns.some((column) => column.column_name === 'owner_id')
      );

      // A fresh schema: the same kind gets a different generated id.
      await this.createSchema();
      await this.database.query(q.backup_insert_kind, ['red', 'Red (new install)']);
      const data = structuredClone(exported.data);
      data.things[0]['name, owner_id) VALUES (null, null); DROP SCHEMA platform_backup_test; --'] =
        'x';
      data.things[1].colour = 'grey';
      TableBackup.remapColumns(
        data,
        ['owner_id'],
        new Map([[this.constructor.OWNER, this.constructor.NEW_OWNER]])
      );
      const results = await this.importAll(data);
      const after = await this.rows();
      this.check(
        "rows restored, with the natural-key reference rewritten to this install's id",
        after.length === 2 && after[0].name === 'apple' && after[0].code === 'red'
      );
      this.check('user ids remapped', after[0].owner_id === this.constructor.NEW_OWNER);
      this.check(
        "only one kind: matched on its natural key, updated to the backup's values",
        (await this.database.query(q.backup_count_kinds)).rows[0].count === 1
      );
      this.check(
        "keys that aren't columns are skipped with a warning (injection attempt included)",
        (await this.database.query(q.backup_schema_exists)).rows[0].exists &&
          results.warnings.filter((w) => w.startsWith('Ignored column things.')).length === 2,
        results.warnings.join(' | ')
      );

      await this.importAll(structuredClone(data));
      this.check(
        'importing again changes nothing',
        JSON.stringify(await this.rows()) === JSON.stringify(after)
      );
      const next = (await this.database.query(q.backup_insert_new_thing, ['new'])).rows[0].thing_id;
      this.check(
        'serial realigned: a new row gets the next id',
        next === Math.max(...before.map((row) => row.thing_id)) + 1,
        String(next)
      );

      await this.database.query(q.backup_create_no_key);
      const noKey = new TableBackup({
        database: this.database,
        schema: 'platform_backup_test',
        tables: ['no_key'],
      });
      let refused = null;
      try {
        await this.database.withTransaction((client) =>
          noKey.importTables(client, { no_key: [{ value: 'a' }] }, { imported: {}, warnings: [] })
        );
      } catch (error) {
        refused = error.message;
      }
      this.check(
        'a table without a primary key is refused',
        /no primary key/.test(refused ?? ''),
        refused
      );
    } finally {
      await this.database.query(q.backup_drop_schema);
    }
    return this.summary();
  }
}

export const tableBackupTest = new TableBackupTest();
export default tableBackupTest;
