-- Named queries used by PostgresDatabaseTest.

-- Query: insert_item
INSERT INTO platform_test.items (label) VALUES ($1) RETURNING id;

-- Query: count_items
SELECT COUNT(*)::int AS count FROM platform_test.items;

-- Query: count_label
SELECT COUNT(*)::int AS count FROM platform_test.items WHERE label = $1;

-- Query: drop_test_schema
DROP SCHEMA IF EXISTS platform_test CASCADE;

-- Query: try_advisory_lock
SELECT pg_try_advisory_lock(hashtext($1)) AS locked;

-- Query: release_advisory_lock
SELECT pg_advisory_unlock(hashtext($1)) AS released;

-- Query: terminate_application_sessions
SELECT COUNT(pg_terminate_backend(pid))::int AS terminated
FROM pg_stat_activity
WHERE datname = current_database() AND application_name = $1 AND pid <> pg_backend_pid();
