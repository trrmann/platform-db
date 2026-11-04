/**
 * PostgresDatabase test entry point (npm test).
 * All behavior lives in the class-based PostgresDatabaseTest module.
 */

import { postgresDatabaseTest } from './postgresDatabaseTest.mjs';

process.exitCode = (await postgresDatabaseTest.execute()) ? 0 : 1;
