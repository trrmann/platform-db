/**
 * Token-bucket rate limiter: up to `capacity` operations in a burst, refilled at
 * `refillPerSecond`. take() waits (never fails) until a token is available; tryTake()
 * takes one only if available now. Shared by platform-db's QueryScheduler and request-queue.
 */

export class TokenBucket {
  constructor({ capacity = 10, refillPerSecond = 5, now = () => Date.now() } = {}) {
    if (capacity < 1 || refillPerSecond <= 0)
      throw new Error('TokenBucket needs capacity ≥ 1 and refill > 0');
    this.capacity = capacity;
    this.refillPerSecond = refillPerSecond;
    this.now = now;
    this.tokens = capacity;
    this.updatedAt = now();
  }

  refill() {
    const current = this.now();
    this.tokens = Math.min(
      this.capacity,
      this.tokens + ((current - this.updatedAt) / 1000) * this.refillPerSecond
    );
    this.updatedAt = current;
  }

  /** Milliseconds until a token is available (0 when one is available now). */
  waitTimeMs() {
    this.refill();
    return this.tokens >= 1 ? 0 : Math.ceil(((1 - this.tokens) / this.refillPerSecond) * 1000);
  }

  static sleep(ms) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  /** Take a token if one is available now; returns whether it did. */
  tryTake() {
    if (this.waitTimeMs() > 0) return false;
    this.tokens -= 1;
    return true;
  }

  async take() {
    for (let wait = this.waitTimeMs(); wait > 0; wait = this.waitTimeMs()) {
      await TokenBucket.sleep(wait);
    }
    this.tokens -= 1;
  }
}

export default TokenBucket;
