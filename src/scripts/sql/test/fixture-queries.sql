-- Named queries used by PostgresDatabaseTest.

-- Query: insert_item
INSERT INTO platform_test.items (label) VALUES ($1) RETURNING id;

-- Query: count_items
SELECT COUNT(*)::int AS count FROM platform_test.items;

-- Query: count_label
SELECT COUNT(*)::int AS count FROM platform_test.items WHERE label = $1;

-- Query: drop_test_schema
DROP SCHEMA IF EXISTS platform_test CASCADE;
