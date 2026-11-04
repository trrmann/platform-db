-- Transaction control, used by PostgresDatabase.withTransaction().

-- Query: begin_transaction
BEGIN;

-- Query: commit_transaction
COMMIT;

-- Query: rollback_transaction
ROLLBACK;
