-- Query: table_exists
-- Accepts a plain name (resolved through the adapter's search_path) or schema.table.
SELECT to_regclass($1) IS NOT NULL AS exists;

-- Query: get_primary_key_columns
SELECT a.attname AS column_name
FROM pg_index i
JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
WHERE i.indrelid = $1::regclass
AND i.indisprimary
ORDER BY a.attnum;

-- Query: list_schema_tables
-- Tables in the adapter's own schema (the first schema on its search_path).
SELECT table_name
FROM information_schema.tables
WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
ORDER BY table_name;

-- Query: select_table_columns
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = current_schema() AND table_name = $1
ORDER BY ordinal_position;

-- Query: connection_probe
SELECT NOW();

-- Query: health_check
SELECT 1 AS status;
