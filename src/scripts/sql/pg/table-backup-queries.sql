-- TableBackup: export and import whole tables (backup and restore).
-- Templates take only identifiers that TableBackup checks first: table names from the caller's
-- fixed list, and column names that exist in the database catalog (never names from a file).

-- Query: table_columns
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = $1 AND table_name = $2
ORDER BY ordinal_position;

-- Query: primary_key_columns
-- $1 = schema-qualified table name.
SELECT a.attname AS column_name
FROM pg_index i
JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
WHERE i.indrelid = $1::regclass
AND i.indisprimary
ORDER BY a.attnum;

-- Query: select_all_rows_template
SELECT * FROM {{table}};

-- Query: upsert_rows_template
-- {{update_columns}} is a plain identifier list; the new values come from EXCLUDED in SQL.
INSERT INTO {{table}} ({{columns}}) VALUES ({{placeholders}})
ON CONFLICT ({{conflict_columns}}) DO UPDATE
SET ({{update_columns}}) = (SELECT {{update_columns}} FROM (SELECT EXCLUDED.*) AS excluded_row);

-- Query: upsert_rows_ignore_template
INSERT INTO {{table}} ({{columns}}) VALUES ({{placeholders}})
ON CONFLICT ({{conflict_columns}}) DO NOTHING;

-- Query: reset_serial_sequence_template
SELECT setval(
  pg_get_serial_sequence('{{table}}', '{{column}}'),
  COALESCE((SELECT MAX({{column}}) FROM {{table}}), 1)
);
