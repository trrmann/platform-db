-- Fixture: the middle statement fails; the others still run, then bootstrap throws.
CREATE TABLE IF NOT EXISTS platform_test.before_failure (id INT);
SELECT * FROM platform_test.no_such_table;
CREATE TABLE IF NOT EXISTS platform_test.after_failure (id INT);
