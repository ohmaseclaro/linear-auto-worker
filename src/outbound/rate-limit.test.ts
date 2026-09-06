import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  RateLimitedError,
  computeBackoffMs,
  extractRateLimitInfo,
  isRateLimitedError,
} from './rate-limit.js';

describe('computeBackoffMs', () => {
  it('returns the remaining milliseconds when the reset is in the future', () => {
    assert.equal(computeBackoffMs(1_000_000, 999_250), 750);
  });

  it('returns 0 when the reset instant has already passed — never a negative wait', () => {
    assert.equal(computeBackoffMs(999_000, 1_000_000), 0);
    assert.equal(computeBackoffMs(1_000_000, 1_000_000), 0);
  });

  it('returns 0 rather than NaN when a header failed to parse', () => {
    assert.equal(computeBackoffMs(Number.NaN, 1_000_000), 0);
    assert.equal(computeBackoffMs(Number.POSITIVE_INFINITY, 1_000_000), 0);
  });
});

describe('isRateLimitedError', () => {
  it('detects a top-level GraphQL errors[].extensions.code', () => {
    assert.equal(
      isRateLimitedError({ errors: [{ extensions: { code: 'RATELIMITED' } }] }),
      true,
    );
  });

  it('detects a nested raw.errors[].extensions.code', () => {
    assert.equal(
      isRateLimitedError({ raw: { errors: [{ extensions: { code: 'RATELIMITED' } }] } }),
      true,
    );
  });

  it('detects a nested response.errors[].extensions.code', () => {
    assert.equal(
      isRateLimitedError({ response: { errors: [{ extensions: { code: 'RATELIMITED' } }] } }),
      true,
    );
  });

  it('scans past unrelated GraphQL errors in the same array', () => {
    assert.equal(
      isRateLimitedError({
        errors: [
          { extensions: { code: 'INTERNAL_SERVER_ERROR' } },
          { extensions: { code: 'RATELIMITED' } },
        ],
      }),
      true,
    );
  });

  it('returns false for a plain Error', () => {
    assert.equal(isRateLimitedError(new Error('boom')), false);
  });

  it('returns false for an error carrying only a transport status — detection never keys off a status code (TRAPS T7)', () => {
    // Linear signals rate limiting with an HTTP 400 body; a status-code branch is dead code.
    assert.equal(isRateLimitedError({ status: 400, statusCode: 400 }), false);
    assert.equal(isRateLimitedError({ status: 429, statusCode: 429 }), false);
  });

  it('returns false for a non-object', () => {
    assert.equal(isRateLimitedError(undefined), false);
    assert.equal(isRateLimitedError('RATELIMITED'), false);
  });
});

describe('extractRateLimitInfo', () => {
  it('parses the reset and complexity headers from a plain header object', () => {
    assert.deepEqual(
      extractRateLimitInfo({
        headers: { 'X-RateLimit-Requests-Reset': '1750000000000', 'X-Complexity': '412' },
      }),
      { resetAtMs: 1_750_000_000_000, complexity: 412 },
    );
  });

  it('parses headers exposed via a Headers-like get()', () => {
    const bag = new Map<string, string>([
      ['x-ratelimit-requests-reset', '1750000000000'],
      ['x-complexity', '9'],
    ]);
    const headers = { get: (n: string) => bag.get(n.toLowerCase()) ?? null };
    assert.deepEqual(extractRateLimitInfo({ response: { headers } }), {
      resetAtMs: 1_750_000_000_000,
      complexity: 9,
    });
  });

  it('finds headers nested under raw', () => {
    assert.deepEqual(
      extractRateLimitInfo({ raw: { headers: { 'x-complexity': '7' } } }),
      { complexity: 7 },
    );
  });

  it('returns an empty object — never throws — when nothing resembles headers', () => {
    assert.deepEqual(extractRateLimitInfo({}), {});
    assert.deepEqual(extractRateLimitInfo(new Error('boom')), {});
    assert.deepEqual(extractRateLimitInfo(undefined), {});
    assert.deepEqual(extractRateLimitInfo({ headers: { 'x-complexity': 'not-a-number' } }), {});
  });

  it('does not throw when a Headers-like get() blows up', () => {
    const headers = {
      get() {
        throw new Error('detached');
      },
    };
    assert.deepEqual(extractRateLimitInfo({ headers }), {});
  });
});

describe('RateLimitedError', () => {
  it('carries the computed wait', () => {
    const err = new RateLimitedError(1_500);
    assert.equal(err.retryAfterMs, 1_500);
    assert.equal(err.name, 'RateLimitedError');
    assert.ok(err instanceof Error);
  });
});
