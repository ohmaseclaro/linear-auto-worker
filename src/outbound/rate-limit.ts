/**
 * Pure rate-limit detection and backoff helpers for the Linear facade.
 *
 * TRAPS.md T7 / 05-CONTEXT D-07: Linear signals rate limiting with an **HTTP 400** whose
 * body carries `errors[].extensions.code === "RATELIMITED"`. It never sends a 429, so any
 * `status === 429` branch is dead code that never executes. Detection in this file — and in
 * linear-client.ts — is keyed exclusively on the GraphQL extension code.
 *
 * Budgets (for the callers that act on a RateLimitedError): 2,500 requests/hour and an
 * independent 3,000,000 complexity points/hour, with a 10,000-point ceiling per query.
 */

const RATELIMITED_CODE = 'RATELIMITED';

/** Reset instant, as a UTC epoch **milliseconds** value (not seconds). */
const RESET_HEADER = 'x-ratelimit-requests-reset';
/** Complexity cost of the response that carried it. */
const COMPLEXITY_HEADER = 'x-complexity';

export class RateLimitedError extends Error {
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super(`Linear rate limited; retry after ${retryAfterMs}ms`);
    this.name = 'RateLimitedError';
    this.retryAfterMs = retryAfterMs;
  }
}

/** Milliseconds to wait until `resetAtMs`. Never negative, never NaN. */
export function computeBackoffMs(resetAtMs: number, now: number): number {
  if (!Number.isFinite(resetAtMs) || !Number.isFinite(now)) return 0;
  return Math.max(0, resetAtMs - now);
}

type Bag = Record<string, unknown>;

function asBag(value: unknown): Bag | undefined {
  return typeof value === 'object' && value !== null ? (value as Bag) : undefined;
}

/**
 * The exact error shape `@linear/sdk@93.0.1` throws could not be confirmed on this branch
 * (no node_modules — see 05-01-SUMMARY), so all three plausible carriers are checked.
 */
function graphQLErrorLists(err: unknown): Bag[][] {
  const root = asBag(err);
  if (!root) return [];
  const candidates = [root.errors, asBag(root.raw)?.errors, asBag(root.response)?.errors];
  return candidates.filter((c): c is Bag[] => Array.isArray(c));
}

export function isRateLimitedError(err: unknown): boolean {
  return graphQLErrorLists(err).some((errors) =>
    errors.some((e) => asBag(asBag(e)?.extensions)?.code === RATELIMITED_CODE),
  );
}

type HeaderReader = (name: string) => string | undefined;

function headerReader(value: unknown): HeaderReader | undefined {
  const bag = asBag(value);
  if (!bag) return undefined;

  // A `Headers` instance (or anything else with a case-insensitive get()).
  if (typeof bag.get === 'function') {
    const get = bag.get as (name: string) => unknown;
    return (name) => {
      const raw = get.call(bag, name);
      return typeof raw === 'string' || typeof raw === 'number' ? String(raw) : undefined;
    };
  }

  const lowered = new Map(Object.keys(bag).map((k) => [k.toLowerCase(), bag[k]]));
  return (name) => {
    const raw = lowered.get(name);
    return typeof raw === 'string' || typeof raw === 'number' ? String(raw) : undefined;
  };
}

function toNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Best-effort read of Linear's rate-limit headers off whatever object we were handed —
 * a thrown SDK error, or a resolved SDK value. Returns `{}` and never throws when the
 * object exposes none of the paths we know how to look at.
 */
export function extractRateLimitInfo(source: unknown): {
  resetAtMs?: number;
  complexity?: number;
} {
  const root = asBag(source);
  if (!root) return {};

  const candidates = [root.headers, asBag(root.response)?.headers, asBag(root.raw)?.headers];
  for (const candidate of candidates) {
    try {
      const read = headerReader(candidate);
      if (!read) continue;
      const resetAtMs = toNumber(read(RESET_HEADER));
      const complexity = toNumber(read(COMPLEXITY_HEADER));
      if (resetAtMs === undefined && complexity === undefined) continue;
      return {
        ...(resetAtMs !== undefined ? { resetAtMs } : {}),
        ...(complexity !== undefined ? { complexity } : {}),
      };
    } catch {
      // A hostile or detached header bag must not take down the call path.
      continue;
    }
  }
  return {};
}
