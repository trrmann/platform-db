-- Fixture for PostgresDatabaseTest: statements the splitter must keep intact.
CREATE SCHEMA IF NOT EXISTS platform_test;

CREATE TABLE IF NOT EXISTS platform_test.items (
  id SERIAL PRIMARY KEY,
  label TEXT NOT NULL
);

/* A block comment; with a semicolon */
DO $guard$
BEGIN
  PERFORM 1; -- semicolons inside a dollar-quoted body
END
$guard$;

INSERT INTO platform_test.items (label) VALUES ('semi;colon -- not a comment');
