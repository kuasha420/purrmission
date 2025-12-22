import { logger } from '../logging/logger.js';

interface RateLimitConfig {
    windowMs: number;
    maxRequests: number;
}

interface TokenBucket {
    tokens: number;
    lastRefill: number;
}

/**
 * Valid keys for rate limiting.
 * e.g., "userId:resourceId:action"
 */
type RateLimitKey = string;

export class RateLimiter {
    private buckets: Map<RateLimitKey, TokenBucket> = new Map();
    private config: RateLimitConfig;

    /**
     * @param windowMs - Time window in milliseconds
     * @param maxRequests - Max requests allowed in the window
     */
    constructor(windowMs: number = 60000, maxRequests: number = 10) {
        this.config = { windowMs, maxRequests };

        // Cleanup interval to remove stale buckets
        const interval = setInterval(() => this.cleanup(), 60000 * 5); // Every 5 min
        interval.unref(); // Allow process to exit if only the interval is active
    }

    /**
     * Check if a request should be rate limited.
     * Returns true if request is allowed, false if limited.
     * Consumes a token if allowed.
     */
    check(key: RateLimitKey): boolean {
        const now = Date.now();
        let bucket = this.buckets.get(key);

        if (!bucket) {
            bucket = {
                tokens: this.config.maxRequests,
                lastRefill: now,
            };
            this.buckets.set(key, bucket);
        }

        this.refill(bucket, now);

        if (bucket.tokens >= 1) {
            bucket.tokens -= 1;
            return true;
        }

        logger.warn(`Rate limit exceeded for key: ${key}`);
        return false;
    }

    private refill(bucket: TokenBucket, now: number): void {
        const elapsed = now - bucket.lastRefill;
        if (elapsed > this.config.windowMs) {
            // Full refill after window passes (simple fixed window reset)
            bucket.tokens = this.config.maxRequests;
            bucket.lastRefill = now;
        }
    }

    private cleanup(): void {
        const now = Date.now();
        for (const [key, bucket] of this.buckets.entries()) {
            if (now - bucket.lastRefill > this.config.windowMs * 2) {
                this.buckets.delete(key);
            }
        }
    }
}

// Singleton instance for global rate limiting
// Default: 10 requests per minute per key
export const rateLimiter = new RateLimiter(60000, 10);
