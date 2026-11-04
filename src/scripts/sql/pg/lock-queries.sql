-- Session-level advisory locks, used by PostgresDatabase to serialize schema bootstrap
-- across processes (several services may start at the same time against one database).
-- The key is a text name, hashed to the lock's integer id.

-- Query: acquire_advisory_lock
SELECT pg_advisory_lock(hashtext($1));

-- Query: release_advisory_lock
SELECT pg_advisory_unlock(hashtext($1)) AS released;
