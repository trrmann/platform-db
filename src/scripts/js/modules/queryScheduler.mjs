/**
 * QueryScheduler: queues, throttles and prioritises database work.
 *
 * - Throttle: at most `maxConcurrent` jobs run at once, and optionally a TokenBucket rate.
 * - Priority: each job has a class (default `critical`, `interactive`, `background`); lower
 *   priority numbers run first. A waiting job gains one priority step every `agingMs`, so
 *   background work is never starved.
 * - Waiting limit: a job that has not finished `maxWaitMs` (per class) after it was queued
 *   fails with QueryWaitTimeoutError; a running job is never interrupted.
 * - Retry: temporary failures (connection refused or dropped, database restarting, too many
 *   connections, deadlock, serialization failure) are retried with backoff within the
 *   class's waiting limit. A job is one unit: a transaction is retried as a whole.
 * - Rules: query names map to classes (`*` wildcards), e.g. { 'backup_*': 'background' }; an
 *   exact name beats a wildcard, and a longer wildcard beats a shorter one.
 * Jobs are held in memory only (they wait for the database, so they can't be stored in it).
 */

export class QueryWaitTimeoutError extends Error {
  constructor(cls, waitedMs, cause) {
    super(`Database work (${cls}) did not complete within ${waitedMs} ms`, { cause });
    this.name = 'QueryWaitTimeoutError';
    this.cls = cls;
  }
}

export class QueryScheduler {
  static DEFAULT_CLASSES = {
    critical: { priority: 0, maxWaitMs: 5000 },
    interactive: { priority: 1, maxWaitMs: 30000 },
    background: { priority: 2, maxWaitMs: 600000 },
  };

  static DEFAULT_CLASS = 'interactive';

  /** PostgreSQL SQLSTATEs and Node network codes that mean "try again shortly". */
  static RETRYABLE_CODES = new Set([
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'EPIPE',
    'EAI_AGAIN',
    '08000',
    '08001',
    '08003',
    '08004',
    '08006',
    '53300',
    '57P01',
    '57P02',
    '57P03',
    '40001',
    '40P01',
  ]);

  static RETRYABLE_MESSAGES = [
    /Connection terminated/i,
    /timeout exceeded when trying to connect/i,
    /the database system is (starting up|shutting down)/i,
  ];

  /**
   * @param {object} [options]
   * @param {number} [options.maxConcurrent]
   * @param {{tryTake: Function, waitTimeMs: Function}} [options.rateLimiter] - e.g. TokenBucket
   * @param {object} [options.classes] - class → { priority, maxWaitMs } (merged over defaults)
   * @param {object} [options.rules] - { default?: class, queries?: { pattern: class } }
   * @param {number} [options.agingMs]
   * @param {number} [options.retryBaseDelayMs]
   * @param {number} [options.retryMaxDelayMs]
   */
  constructor({
    maxConcurrent = 10,
    rateLimiter = null,
    classes = {},
    rules = {},
    agingMs = 5000,
    retryBaseDelayMs = 200,
    retryMaxDelayMs = 5000,
  } = {}) {
    this.maxConcurrent = Math.max(1, maxConcurrent);
    this.rateLimiter = rateLimiter;
    this.classes = { ...QueryScheduler.DEFAULT_CLASSES, ...classes };
    this.agingMs = agingMs;
    this.retryBaseDelayMs = retryBaseDelayMs;
    this.retryMaxDelayMs = retryMaxDelayMs;
    this.pending = [];
    this.running = 0;
    this.timer = null;
    this.sequence = 0;
    this.setRules(rules);
  }

  /**
   * Replace the classification rules: { default, queries: { 'name_or_glob*': class } }.
   */
  setRules({ default: fallback = QueryScheduler.DEFAULT_CLASS, queries = {} } = {}) {
    this.defaultClass = this.knownClass(fallback);
    // Exact names first, then wildcard patterns from most to least specific (longest first),
    // so the result never depends on the order the rules were written in.
    this.rules = Object.entries(queries)
      .map(([pattern, cls]) => ({
        pattern,
        wildcard: pattern.includes('*'),
        test: QueryScheduler.globToRegExp(pattern),
        cls: this.knownClass(cls),
      }))
      .sort((a, b) => a.wildcard - b.wildcard || b.pattern.length - a.pattern.length);
  }

  knownClass(cls) {
    if (!this.classes[cls]) throw new Error(`Unknown database work class: ${cls}`);
    return cls;
  }

  static globToRegExp(pattern) {
    const escaped = String(pattern).replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^${escaped.replaceAll('*', '.*')}$`);
  }

  /** The class for a named query (most specific matching rule), else the default class. */
  classify(queryName) {
    if (queryName) {
      for (const rule of this.rules) {
        if (rule.test.test(queryName)) return rule.cls;
      }
    }
    return this.defaultClass;
  }

  static isRetryable(error) {
    if (!error) return false;
    if (QueryScheduler.RETRYABLE_CODES.has(error.code)) return true;
    return QueryScheduler.RETRYABLE_MESSAGES.some((pattern) => pattern.test(error.message || ''));
  }

  retryDelay(attempt) {
    return Math.min(this.retryMaxDelayMs, this.retryBaseDelayMs * 2 ** (attempt - 1));
  }

  /**
   * Queue `work` (an async function) in class `cls`; resolves with its result. `maxWaitMs`
   * shortens the class's waiting limit for this job (callers with their own retry, such as
   * request-queue's store, use a short one so they fail fast).
   */
  run(work, { cls = this.defaultClass, maxWaitMs } = {}) {
    const settings = this.classes[this.knownClass(cls)];
    const limit = Math.min(settings.maxWaitMs, maxWaitMs ?? Infinity);
    return new Promise((resolve, reject) => {
      const now = Date.now();
      const job = {
        work,
        cls,
        priority: settings.priority,
        enqueuedAt: now,
        deadline: now + limit,
        notBefore: 0,
        attempts: 0,
        order: (this.sequence += 1),
        resolve,
        reject,
        lastError: null,
      };
      job.expiry = setTimeout(() => this.expire(job), limit);
      this.pending.push(job);
      this.dispatch();
    });
  }

  /** A queued (not running) job reached its waiting limit. */
  expire(job) {
    const index = this.pending.indexOf(job);
    if (index === -1) return;
    this.pending.splice(index, 1);
    job.reject(new QueryWaitTimeoutError(job.cls, Date.now() - job.enqueuedAt, job.lastError));
  }

  effectivePriority(job, now) {
    return job.priority - Math.floor((now - job.enqueuedAt) / this.agingMs);
  }

  /** The ready job to run next: best effective priority, then oldest. */
  nextJob(now) {
    let best = null;
    for (const job of this.pending) {
      if (job.notBefore > now) continue;
      if (
        !best ||
        this.effectivePriority(job, now) < this.effectivePriority(best, now) ||
        (this.effectivePriority(job, now) === this.effectivePriority(best, now) &&
          job.order < best.order)
      ) {
        best = job;
      }
    }
    return best;
  }

  /** Call dispatch() again after `ms` (one timer at a time). */
  wakeIn(ms) {
    if (this.timer) return;
    this.timer = setTimeout(
      () => {
        this.timer = null;
        this.dispatch();
      },
      Math.max(1, ms)
    );
  }

  /** Start as many ready jobs as the concurrency and rate limits allow. */
  dispatch() {
    while (this.running < this.maxConcurrent && this.pending.length > 0) {
      const now = Date.now();
      const job = this.nextJob(now);
      if (!job) {
        const soonest = Math.min(...this.pending.map((pending) => pending.notBefore));
        this.wakeIn(soonest - now);
        return;
      }
      if (this.rateLimiter && !this.rateLimiter.tryTake()) {
        this.wakeIn(this.rateLimiter.waitTimeMs());
        return;
      }
      this.pending.splice(this.pending.indexOf(job), 1);
      this.execute(job);
    }
  }

  async execute(job) {
    this.running += 1;
    job.attempts += 1;
    try {
      const result = await job.work();
      clearTimeout(job.expiry);
      job.resolve(result);
    } catch (error) {
      job.lastError = error;
      const delay = this.retryDelay(job.attempts);
      if (QueryScheduler.isRetryable(error) && Date.now() + delay < job.deadline) {
        job.notBefore = Date.now() + delay;
        this.pending.push(job);
      } else {
        clearTimeout(job.expiry);
        job.reject(error);
      }
    } finally {
      this.running -= 1;
      this.dispatch();
    }
  }

  /** Queue depth, for health and logging. */
  stats() {
    return { pending: this.pending.length, running: this.running };
  }
}

export default QueryScheduler;
