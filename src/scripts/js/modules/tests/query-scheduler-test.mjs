/**
 * QueryScheduler test entry point (npm run test:scheduler).
 * All behavior lives in the class-based QuerySchedulerTest module.
 */

import { querySchedulerTest } from './querySchedulerTest.mjs';

process.exitCode = (await querySchedulerTest.execute()) ? 0 : 1;
