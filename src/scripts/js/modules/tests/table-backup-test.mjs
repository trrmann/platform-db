/**
 * TableBackup test entry point (npm run test:backup).
 * All behavior lives in the class-based TableBackupTest module.
 */

import { tableBackupTest } from './tableBackupTest.mjs';

process.exitCode = (await tableBackupTest.execute()) ? 0 : 1;
