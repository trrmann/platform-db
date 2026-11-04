/**
 * TableBackup: export a fixed set of tables of one schema, and import them back with upsert
 * semantics (existing rows updated to the backup's values, new rows inserted, nothing deleted),
 * so importing the same backup twice changes nothing. Shared by every service's backup
 * (iam-service's identity tables, FlashCards' app tables).
 *
 * - Natural-key tables (e.g. roles, matched by name) are matched on their natural key, and the
 *   install-specific ids they had in the backup are rewritten in later tables.
 * - Only columns that exist in the table (database catalog) are written; any other key in a
 *   backup row is skipped with a warning. Names from a file never reach the SQL (CODING_STANDARDS
 *   0.1), and backups made before a column was dropped still restore.
 * - Serial primary keys are realigned after an import so new rows don't collide.
 * - Columns without a time zone (`timestamp`, `date`) are exported as plain clock-time text.
 *   The driver reads them as local time into Date objects, and JSON would turn those into UTC
 *   (`…Z`), which PostgreSQL then ignores on such a column, shifting every value by the machine's
 *   UTC offset whenever a backup passed through a file or HTTP.
 * The caller provides the transaction (withTransaction) and the table order (references first).
 */

import { PostgresDatabase } from './postgresDatabase.mjs';

export class TableBackup {
  static queries = PostgresDatabase.loadNamedSqlStatements(
    'pg/table-backup-queries.sql',
    PostgresDatabase.sqlRoot
  );

  static IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

  /** Column types exported as plain text (see the class comment). */
  static ZONELESS_TYPES = new Set(['timestamp without time zone', 'date']);

  static pad(value, size = 2) {
    return String(value).padStart(size, '0');
  }

  /**
   * A Date read from a zoneless column, as the clock-time text PostgreSQL stored
   * (`YYYY-MM-DD HH:MM:SS.mmm`, or `YYYY-MM-DD` for a date). Other values are returned as is.
   */
  static clockText(value, dataType) {
    if (!(value instanceof Date)) return value;
    const p = TableBackup.pad;
    const day = `${value.getFullYear()}-${p(value.getMonth() + 1)}-${p(value.getDate())}`;
    if (dataType === 'date') return day;
    return `${day} ${p(value.getHours())}:${p(value.getMinutes())}:${p(value.getSeconds())}.${p(value.getMilliseconds(), 3)}`;
  }

  /**
   * @param {object} options
   * @param {PostgresDatabase} options.database - The adapter whose schema holds the tables
   * @param {string[]} options.tables - Tables to back up, in import order (references first)
   * @param {string} [options.schema] - Default: the adapter's static SCHEMA
   * @param {object} [options.naturalKeyTables] - { table: { naturalKey: [columns], id: column } }
   * @param {object} [options.serialPkTables] - { table: serial primary key column }
   * @param {object} [options.work] - Scheduling options for the exports' queries
   */
  constructor({
    database,
    tables,
    schema = database.constructor.SCHEMA,
    naturalKeyTables = {},
    serialPkTables = {},
    work = { priority: 'background' },
  }) {
    for (const name of [schema, ...tables]) TableBackup.assertIdentifier(name);
    this.database = database;
    this.schema = schema;
    this.tables = tables;
    this.naturalKeyTables = naturalKeyTables;
    this.serialPkTables = serialPkTables;
    this.work = work;
  }

  static assertIdentifier(name) {
    if (!TableBackup.IDENTIFIER.test(String(name))) {
      throw new Error(`TableBackup: invalid identifier ${JSON.stringify(name)}`);
    }
    return name;
  }

  qualified(table) {
    if (!this.tables.includes(table)) throw new Error(`TableBackup: ${table} is not backed up`);
    return `${this.schema}.${table}`;
  }

  static naturalKeyOf(row, natural) {
    return JSON.stringify(natural.naturalKey.map((column) => row[column] ?? null));
  }

  /** Rewrite the values of `columns` in every row of every table through `map` (old → new). */
  static remapColumns(data, columns, map) {
    if (map.size === 0) return;
    for (const rows of Object.values(data)) {
      if (!Array.isArray(rows)) continue;
      for (const row of rows) {
        for (const column of columns) {
          if (row[column] && map.has(row[column])) row[column] = map.get(row[column]);
        }
      }
    }
  }

  /** Column descriptions of a table, from the catalog. */
  async columnsOf(executor, table, options) {
    const { rows } = await executor.query(
      TableBackup.queries.table_columns,
      [this.schema, table],
      options
    );
    return rows;
  }

  /**
   * Every row of every table, and each table's columns.
   * @returns {Promise<{schema: object, data: object}>}
   */
  async exportTables() {
    const out = { schema: {}, data: {} };
    for (const table of this.tables) {
      const columns = await this.columnsOf(this.database, table, this.work);
      out.schema[table] = { columns, exists: columns.length > 0 };
      const rows = columns.length
        ? (
            await this.database.query(
              TableBackup.queries.select_all_rows_template.replace(
                '{{table}}',
                this.qualified(table)
              ),
              [],
              this.work
            )
          ).rows
        : [];
      const zoneless = columns.filter((column) => TableBackup.ZONELESS_TYPES.has(column.data_type));
      for (const row of rows) {
        for (const { column_name: name, data_type: type } of zoneless) {
          row[name] = TableBackup.clockText(row[name], type);
        }
      }
      out.data[table] = rows;
    }
    return out;
  }

  /**
   * Upsert every table's rows from `data`, in this.tables order, on a transaction client.
   * Throws on the first failing row (the caller's transaction rolls back).
   * @param {{query: Function}} client
   * @param {object} data - { table: rows }
   * @param {{imported: object, warnings: string[]}} results - filled in
   * @returns {Promise<object>} natural-key id maps: { table: Map(backup id → this install's id) }
   */
  async importTables(client, data, results) {
    const idMaps = {};
    for (const table of this.tables) {
      const rows = data[table] || [];
      if (rows.length === 0) {
        results.imported[table] = 0;
        continue;
      }
      const known = new Set(
        (await this.columnsOf(client, table)).map((column) => column.column_name)
      );
      if (known.size === 0) throw new Error(`Import aborted: table ${table} does not exist`);
      const natural = this.naturalKeyTables[table];
      const conflictColumns = natural
        ? natural.naturalKey
        : (
            await client.query(TableBackup.queries.primary_key_columns, [this.qualified(table)])
          ).rows.map((row) => row.column_name);
      if (conflictColumns.length === 0) {
        throw new Error(`Import aborted: no primary key found for ${table}`);
      }

      const skipped = new Set();
      const naturalRows = [];
      let imported = 0;
      for (const dataRow of rows) {
        const row = this.prepareRow(dataRow, table, natural, idMaps, results);
        if (!row) continue;
        for (const column of Object.keys(row)) {
          if (!known.has(column)) {
            skipped.add(column);
            delete row[column];
          }
        }
        if (natural) naturalRows.push([dataRow[natural.id], row]);
        try {
          await this.upsertRow(client, table, row, conflictColumns);
        } catch (error) {
          throw new Error(`Import aborted at table ${table}: ${error.message}`, { cause: error });
        }
        imported += 1;
      }
      for (const column of skipped) {
        results.warnings.push(`Ignored column ${table}.${column}: not in this database`);
      }
      results.imported[table] = imported;
      if (natural) idMaps[table] = await this.naturalKeyIdMap(client, table, natural, naturalRows);
    }

    for (const [table, column] of Object.entries(this.serialPkTables)) {
      TableBackup.assertIdentifier(column);
      await client.query(
        TableBackup.queries.reset_serial_sequence_template
          .replace(/\{\{table\}\}/g, this.qualified(table))
          .replace(/\{\{column\}\}/g, column)
      );
    }
    return idMaps;
  }

  /**
   * A backup row ready to write: without the install-specific id of a natural-key table, and
   * with references to natural-key tables rewritten. Null skips a row whose reference can't be
   * resolved (with a warning).
   */
  prepareRow(dataRow, table, natural, idMaps, results) {
    const row = { ...dataRow };
    if (natural) delete row[natural.id];
    for (const [refTable, ref] of Object.entries(this.naturalKeyTables)) {
      const map = idMaps[refTable];
      // null references (e.g. a platform-wide role's app_id) stay null
      if (map && row[ref.id] !== undefined && row[ref.id] !== null) {
        const mapped = map.get(row[ref.id]);
        if (!mapped) {
          results.warnings.push(`Skipped ${table} row: unknown ${refTable} id ${row[ref.id]}`);
          return null;
        }
        row[ref.id] = mapped;
      }
    }
    return row;
  }

  /** Upsert one row whose columns are all known to exist. */
  async upsertRow(client, table, row, conflictColumns) {
    const columns = Object.keys(row);
    const updatable = columns.filter((column) => !conflictColumns.includes(column));
    const template = updatable.length
      ? TableBackup.queries.upsert_rows_template
      : TableBackup.queries.upsert_rows_ignore_template;
    const statement = template
      .replace('{{table}}', this.qualified(table))
      .replace('{{columns}}', columns.join(', '))
      .replace('{{placeholders}}', columns.map((_, i) => `$${i + 1}`).join(', '))
      .replace('{{conflict_columns}}', conflictColumns.join(', '))
      .replaceAll('{{update_columns}}', updatable.join(', '));
    await client.query(
      statement,
      columns.map((column) => row[column])
    );
  }

  /** After importing a natural-key table: backup id → this install's id, by natural key. */
  async naturalKeyIdMap(client, table, natural, naturalRows) {
    const current = await client.query(
      TableBackup.queries.select_all_rows_template.replace('{{table}}', this.qualified(table))
    );
    const byNatural = new Map(
      current.rows.map((row) => [TableBackup.naturalKeyOf(row, natural), row[natural.id]])
    );
    return new Map(
      naturalRows
        .filter(([, row]) => byNatural.has(TableBackup.naturalKeyOf(row, natural)))
        .map(([exportedId, row]) => [
          exportedId,
          byNatural.get(TableBackup.naturalKeyOf(row, natural)),
        ])
    );
  }
}

export default TableBackup;
