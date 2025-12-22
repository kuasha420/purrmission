import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter } from './rateLimit.js';

describe('RateLimiter', () => {
    it('should allow requests within limit', () => {
        const limiter = new RateLimiter(1000, 2);
        assert.equal(limiter.check('user-1'), true);
        assert.equal(limiter.check('user-1'), true);
        assert.equal(limiter.check('user-1'), false);
    });

    it('should use separate buckets for different keys', () => {
        const limiter = new RateLimiter(1000, 1);
        assert.equal(limiter.check('user-1'), true);
        assert.equal(limiter.check('user-1'), false);
        assert.equal(limiter.check('user-2'), true);
        assert.equal(limiter.check('user-2'), false);
    });

    it('should reset bucket after window expires', async () => {
        const limiter = new RateLimiter(100, 1);
        assert.equal(limiter.check('user-1'), true);
        assert.equal(limiter.check('user-1'), false);

        await new Promise(resolve => setTimeout(resolve, 150));

        assert.equal(limiter.check('user-1'), true);
    });

    it('should clean up stale buckets', async () => {
        // Use a tiny window for testing cleanup
        const limiter = new RateLimiter(50, 1);
        limiter.check('user-1');

        // Buckets internal Map is private, but we can indirectly test it
        // by waiting for cleanup and checking if it refills correctly.
        // Actually, cleanup just deletes the entry from the map.

        // @ts-expect-error - testing cleanup - accessing private member for testing
        assert.equal(limiter.buckets.size, 1);

        await new Promise(resolve => setTimeout(resolve, 150));

        // Manual trigger cleanup since the interval is 5 mins
        // @ts-expect-error - testing cleanup
        limiter.cleanup();

        // @ts-expect-error - testing cleanup
        assert.equal(limiter.buckets.size, 0);
    });
});
