-- TableBackupTest fixtures (local scratch database only).

-- Query: backup_drop_schema
DROP SCHEMA IF EXISTS platform_backup_test CASCADE;

-- Query: backup_create_schema
CREATE SCHEMA platform_backup_test;

-- Query: backup_create_kinds
CREATE TABLE platform_backup_test.kinds (
  kind_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT UNIQUE NOT NULL,
  label TEXT
);

-- Query: backup_create_things
CREATE TABLE platform_backup_test.things (
  thing_id SERIAL PRIMARY KEY,
  kind_id UUID REFERENCES platform_backup_test.kinds(kind_id),
  owner_id UUID,
  name TEXT NOT NULL,
  seen_at TIMESTAMP NOT NULL DEFAULT '2026-11-04 08:30:15.250',
  due_on DATE NOT NULL DEFAULT '2026-11-05',
  stamped_at TIMESTAMPTZ NOT NULL DEFAULT '2026-11-04 08:30:15.250+00'
);

-- Query: backup_times
SELECT name, seen_at::text AS seen_at, due_on::text AS due_on, stamped_at = '2026-11-04 08:30:15.250+00' AS stamped_ok
FROM platform_backup_test.things ORDER BY thing_id;

-- Query: backup_create_no_key
CREATE TABLE platform_backup_test.no_key (value TEXT);

-- Query: backup_insert_kind
INSERT INTO platform_backup_test.kinds (code, label) VALUES ($1, $2) RETURNING kind_id;

-- Query: backup_insert_thing
INSERT INTO platform_backup_test.things (kind_id, owner_id, name) VALUES ($1, $2, $3) RETURNING thing_id;

-- Query: backup_insert_new_thing
INSERT INTO platform_backup_test.things (name) VALUES ($1) RETURNING thing_id;

-- Query: backup_things_with_codes
SELECT t.thing_id, t.name, t.owner_id, k.code
FROM platform_backup_test.things t LEFT JOIN platform_backup_test.kinds k ON k.kind_id = t.kind_id
ORDER BY t.thing_id;

-- Query: backup_count_kinds
SELECT count(*)::int AS count FROM platform_backup_test.kinds;

-- Query: backup_schema_exists
SELECT to_regnamespace('platform_backup_test') IS NOT NULL AS exists;
