/**
 * Signed-payload fixtures for the receiver tests.
 *
 * ONE rule governs this file: the bytes that are SIGNED are the very same Buffer object
 * that is SENT. Serialise once, keep the Buffer, HMAC that Buffer, hand the caller that
 * Buffer. Never serialise twice, never let a test re-encode the body on its way into the
 * request.
 */
// Pitfall 5: this is not fussiness. Measured this session, `JSON.stringify(JSON.parse(raw))`
// produced BYTE-IDENTICAL output for a payload carrying emoji, CJK, accents, smart quotes
// and a zero-width space — V8 preserves insertion order for non-numeric keys — so the
// classic parse/re-stringify round-trip bug PASSES a naive unicode test and ships. A
// fixture that never reconstructs the bytes is the only design that can catch it.
// T41: this file lives under src/ because tsconfig is rootDir/include "src" and the gate
// is `tsc && node --test dist`; anything in a top-level test/ never reaches dist.
import crypto from 'node:crypto';

/** The secret the receiver under test is constructed with. */
export const TEST_SECRET = 'test-webhook-secret-0123456789';

export interface Fixture {
  /** The exact bytes to send AND the exact bytes that were signed. */
  raw: Buffer;
  signature: string;
  deliveryId: string;
}

export interface SignOptions {
  secret?: string;
  deliveryId?: string;
  /**
   * Hash something other than the bytes that will be sent. Negative tests only — this is
   * how the latin1-reinterpretation case is expressed without the fixture ever
   * reconstructing the body it hands back.
   */
  signBytes?: (raw: Buffer) => Buffer;
}

let deliverySeq = 0;

export function signed(payload: unknown, opts: SignOptions = {}): Fixture {
  // Serialised exactly once. `raw` is the single source of truth from here on.
  const raw = Buffer.from(JSON.stringify(payload), 'utf8');
  const toHash = opts.signBytes ? opts.signBytes(raw) : raw;
  const signature = crypto
    .createHmac('sha256', opts.secret ?? TEST_SECRET)
    .update(toHash)
    .digest('hex');
  return { raw, signature, deliveryId: opts.deliveryId ?? `delivery-${++deliverySeq}` };
}

/** Reinterpret the bytes as latin1 and re-encode as utf8 — the wrong-encoding negative. */
export const latin1Reinterpretation = (raw: Buffer): Buffer =>
  Buffer.from(raw.toString('latin1'), 'utf8');

/**
 * A plausible `Issue` update delivery. `webhookTimestamp` is MILLISECONDS (T20), and is
 * spread last so a test can delete or zero it.
 */
export function issuePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: 'update',
    type: 'Issue',
    actor: { id: 'human-user-id', type: 'user' },
    data: { id: 'issue-uuid', assigneeId: 'bot-user-id' },
    updatedFrom: { assigneeId: null },
    webhookTimestamp: Date.now(),
    ...overrides,
  };
}

/** Emoji, CJK, accents, smart quotes and a zero-width space — D-10's non-ASCII case. */
export const UNICODE_TITLE = 'Fix 🚀 the 日本語 café “quote” bug​ now';
