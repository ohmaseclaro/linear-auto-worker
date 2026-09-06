/**
 * The request path — HOOK-04/05/06/08, plus D-06 loop-prevention layer 4, D-09 and D-10.
 *
 * Four properties, in the order the code enforces them:
 *
 *   1. VERIFY BEFORE PARSE. The stream is read once into a Buffer and that Buffer is what
 *      gets HMAC'd. Nothing above `client.parseData()` may be trusted.
 *   2. ASSERT THE TIMESTAMP IS PRESENT. The SDK's window is skipped on a falsy value.
 *   3. DEDUPE THE DELIVERY, answer 200 on a replay.
 *   4. ACKNOWLEDGE, THEN WORK. Nothing below the 200 is awaited.
 *
 * Every rejection names the guard that fired. That is the whole of D-09: a status code
 * alone cannot tell "someone is replaying deliveries" from "our persisted secret is
 * stale" — opposite incidents with opposite fixes.
 */
// D-11 (AMENDED 2026-09-06): a plain node:http listener calling `client.parseData()`.
// The SDK's bundled all-in-one request-listener helper is forbidden here: measured, it
// parses unverified bytes before hashing them, awaits every handler before writing the
// 200 (1205 ms for a 1200 ms handler), discards the delivery header so dedupe is
// unreachable, and collapses stale/tampered/malformed into one identical response.
// The no-framework rule the decision exists to protect is unchanged and still binding.
// T5: the pre-v93 webhooks class was removed; LinearWebhookClient is the only entry point.
import crypto from 'node:crypto';
import type http from 'node:http';
import { LINEAR_WEBHOOK_SIGNATURE_HEADER, LinearWebhookClient } from '@linear/sdk/webhooks';

import type { Logger, Store } from '../domain/ports.js';
import { type GuardPayload, incSelfEventDrop, selfEventGuards } from './guards.js';
import type { Router, WebhookPayload } from './router.js';

/**
 * Mirrors the SDK's own window exactly (±60 s, symmetric — measured: −61 000 rejects,
 * −59 000 accepts, +61 000 rejects).
 *
 * This is NOT a second window competing with the SDK's. `parseData(raw, signature)` takes
 * the timestamp as its third argument, and we deliberately do not pass one, so the SDK's
 * check is inert on this path — passing it would fold a stale delivery into the signature
 * failure and make the two indistinguishable, which is exactly what D-09 forbids. Same
 * bound, same symmetry, one owner. See T20 and 03-RESEARCH § Unknown 2.
 */
const STALENESS_MS = 60_000;

/** The delivery-correlation header. Assumption A1 — unconfirmed against live traffic. */
const DELIVERY_HEADER = 'linear-delivery';

/**
 * The verified payload, typed structurally. `webhookTimestamp` is deliberately `unknown`:
 * the whole point of G1 is that its type is not to be assumed.
 */
interface VerifiedPayload {
  action: string;
  type?: string;
  data?: Record<string, unknown>;
  updatedFrom?: Record<string, unknown> | null;
  webhookTimestamp?: unknown;
  actor?: { id?: string; type?: string } | null;
}

export interface ReceiverDeps {
  /** The secret plan 03-02 persisted to kv before registering. A mismatch 400s everything. */
  secret: string;
  store: Store;
  log: Logger;
  botUserId: string;
  router: Pick<Router, 'enqueue'>;
}

const single = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v;

/**
 * Read the body ONCE and keep the Buffer.
 */
// T14: any parse-then-restringify path destroys byte-exactness and produces signature
// mismatches on key ordering and unicode escaping. Per Pitfall 5 that bug PASSES a naive
// round-trip test — V8 happens to re-emit emoji/CJK/ZWSP byte-identically — so the only
// defence is never constructing the hash input in the first place.
function readRaw(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, fail) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', fail);
  });
}

/** Surrogate delivery id when the header is absent — see G2 for why this is not a rejection. */
const surrogateDeliveryId = (raw: Buffer): string =>
  `sha256:${crypto.createHash('sha256').update(raw).digest('hex')}`;

let firstDeliveryLogged = false;

/**
 * One-time diagnostic, fired on the first delivery that clears G0. Settles assumptions
 * A1 (the delivery header's name), A2 (whether `webhookTimestamp` is populated) and A6
 * (the actor discriminant a personal-API-key bot presents as) from a single real
 * delivery. Task 3's checklist collects the three lines.
 */
// T-03-24: header KEYS only, never values — the signature header is sensitive (Pitfall 4).
export function logFirstDeliveryShape(
  log: Logger,
  req: http.IncomingMessage,
  payload: { webhookTimestamp?: unknown; actor?: { type?: string } | null },
): void {
  if (firstDeliveryLogged) return;
  firstDeliveryLogged = true;
  log.info(
    {
      headerKeys: Object.keys(req.headers),
      webhookTimestampType: typeof payload.webhookTimestamp,
      actorType: payload.actor?.type,
    },
    'first delivery shape (settles A1/A2/A6)',
  );
}

export function createReceiver(deps: ReceiverDeps): http.RequestListener {
  const { store, log, botUserId, router } = deps;
  const client = new LinearWebhookClient(deps.secret);
  let surrogateWarned = false;

  return async (req, res) => {
    // 1 — non-POST is answered without touching the stream.
    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.end('Method not allowed');
      return;
    }

    // 2 — capture headers BEFORE consuming the body; they are unreachable afterwards.
    const headerDeliveryId = single(req.headers[DELIVERY_HEADER]);
    const signature = single(req.headers[LINEAR_WEBHOOK_SIGNATURE_HEADER]);

    // D-09: name the guard. D-10 / T6: the status is 400 — the intuitive unauthorized
    // code is NOT what Linear's own verifier returns, and a test asserting it never fires.
    const reject = (guard: string, detail?: string): void => {
      log.warn({ deliveryId: headerDeliveryId, guard, detail }, 'delivery rejected');
      incSelfEventDrop(guard);
      res.statusCode = 400;
      res.end('Invalid webhook');
    };

    // 3 — the raw bytes, read once.
    let raw: Buffer;
    try {
      raw = await readRaw(req);
    } catch (err) {
      reject('body:unreadable', err instanceof Error ? err.message : String(err));
      return;
    }

    // G0 — signature (HOOK-04). parseData verifies FIRST and parses second, which is the
    // property the amended D-11 exists to protect.
    // Do not hand-roll the compare: the SDK uses a timing-safe one (T-03-23), and it
    // THROWS on failure rather than returning false, so a falsy-return branch is dead code.
    let payload: VerifiedPayload;
    try {
      payload = client.parseData(raw, signature ?? '') as unknown as VerifiedPayload;
    } catch (err) {
      reject('signature', err instanceof Error ? err.message : String(err));
      return;
    }

    logFirstDeliveryShape(log, req, payload);

    // G1 — timestamp (HOOK-05).
    // T20 / Pitfall 2: the field is MILLISECONDS, and the SDK's own window is wrapped in
    // `if (timestamp)` — an absent field, and a literal 0, both skip replay protection
    // entirely and return 200. That silent always-pass is the failure this assertion
    // closes. `!ts` is load-bearing alongside the typeof: 0 is a number and is falsy.
    const ts = payload.webhookTimestamp;
    if (typeof ts !== "number" || !ts) {
      reject('timestamp:absent', `typeof=${typeof ts}`);
      return;
    }
    const drift = Date.now() - ts;
    if (Math.abs(drift) > STALENESS_MS) {
      reject('timestamp:stale', `${drift}ms`);
      return;
    }

    // G2 — delivery id (HOOK-06, loop layer 4).
    //
    // Deliberate deviation from 03-RESEARCH § Example 1, which rejects when the header is
    // absent: the header's NAME rests on assumption A1, which no live delivery has yet
    // confirmed, and a wrong guess there rejects 100% of real traffic (T-03-26). A
    // sha256-of-body surrogate degrades to a documented assumption instead of an outage,
    // which is the project's stated reliability posture — and it dedupes correctly,
    // because Linear's retries resend the identical body.
    const deliveryId = headerDeliveryId ?? surrogateDeliveryId(raw);
    if (!headerDeliveryId && !surrogateWarned) {
      surrogateWarned = true;
      log.warn(
        { headerKeys: Object.keys(req.headers) },
        'delivery header absent — falling back to sha256-of-body surrogate id (assumption A1 is wrong)',
      );
    }

    // Synchronous by design: an awaited dedupe write inside the acknowledgement path
    // reintroduces exactly the latency this module exists to remove.
    // T46/P2: `recordDelivery`, two arguments. This used to read `tryInsertDelivery(id)` —
    // a method the real store does not have, called with one argument where the port takes
    // two. It survived six phases because the in-memory fake carried an alias; against the
    // production store it was a `TypeError` on the very first webhook delivery.
    if (!store.recordDelivery(deliveryId, Date.now())) {
      // The counter bucket guards.ts reserved for layer 4; the log carries the D-09 guard
      // name. Two spellings of one event, because both names are load-bearing elsewhere.
      incSelfEventDrop('delivery:duplicate');
      log.info({ deliveryId, guard: 'delivery-id:replay' }, 'duplicate delivery dropped');
      // 200, not an error: a rejection burns Linear's retry budget on our own filtering.
      res.statusCode = 200;
      res.end('OK');
      return;
    }

    // G3-G5 — loop layers 1/2/3 (HOOK-07, D-06).
    const verdict = selfEventGuards(payload as unknown as GuardPayload, botUserId);
    if (verdict.drop) {
      // selfEventGuards already incremented its own bucket; a second inc double-counts.
      log.info(
        { deliveryId, guard: verdict.guard, actorType: verdict.actorType },
        'self-event dropped',
      );
      res.statusCode = 200;
      res.end('OK');
      return;
    }

    // ════ HOOK-08 — ACKNOWLEDGE HERE. Nothing below this line is awaited. ════
    // Pitfall 3: a handler that runs before the response adds directly to Linear's
    // five-second budget, and the retries that follow are what auto-disable the webhook.
    // The ordering is the requirement; a verify gate asserts it by line number.
    res.statusCode = 200;
    res.end('OK');

    setImmediate(() => {
      void router.enqueue(payload as WebhookPayload, deliveryId);
    });
  };
}
