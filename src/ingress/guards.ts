/**
 * Loop prevention — HOOK-07, D-06. Three of the four independent layers, written as pure
 * predicates over an already-verified webhook payload. Each drop returns the NAME of the
 * guard that fired; the receiver does the logging so the delivery id can be attached.
 *
 *   layer 1  actor identity           -> 'actor:null-untrusted' | 'actor:self'   (D-08)
 *   layer 2  invisible comment marker -> 'marker:bot-authored'                   (D-06/D-07)
 *   layer 3  self-write suppression   -> 'suppression:self-write'                (in-process)
 *   layer 4  delivery-ID uniqueness   -> NOT IN THIS FILE.
 *
 * Layer 4 needs the `Linear-Delivery` request header and the Store, so it lives in the
 * receiver (plan 03-05) and drops as 'delivery:duplicate'. Three layers here is the
 * agreed split, not D-06 under-built.
 *
 * The layers are independent on purpose: any one of them can be silently wrong. That is
 * also why every drop is counted under its own guard name (D-09) — a layer that never
 * fires is otherwise indistinguishable from a layer that is working.
 */

// T32: BOT_MARKER_PREFIX and isBotAuthoredBody live in src/domain/ and are owned
// by Phase 1. Never declare, re-export or re-derive them here, and do not create
// src/shared/markers.ts (03-CONTEXT D-13 is superseded) — a second copy of the constant is
// exactly what makes this filter unmergeable against Phase 5's outbound writer.
import { BOT_MARKER_PREFIX, isBotAuthoredBody } from '../domain/index.js';

/**
 * Structural view of the fields these guards read. Deliberately not the SDK's
 * `LinearWebhookPayload`: the guards are pure predicates and stay importable by tests
 * without pulling in @linear/sdk. The SDK payload is assignable to this shape.
 *
 * `actor` is a FOUR-member union in the SDK (externalUser | integration | oauthClient |
 * user); all four carry `id` and `type`, so `type` is the discriminant to assert.
 */
export type GuardActor = { readonly id?: string; readonly type?: string };

export type GuardPayload = {
  readonly actor?: GuardActor | null;
  readonly type?: string;
  readonly data?: { readonly id?: string; readonly body?: string } | null;
};

export type GuardResult = {
  drop: boolean;
  guard?: string;
  actorType?: string;
  marker?: string;
};

/** D-06 layer 3 window. A hint, never correctness — see `noteSelfWrite`. */
export const SELF_WRITE_SUPPRESSION_MS = 90_000;

const dropCounts: Record<string, number> = Object.create(null) as Record<string, number>;

/**
 * D-09 / ROADMAP criterion 4. A live read-only view of the per-guard drop counters, so an
 * unwired filter is visible rather than silent. A plain object is the whole requirement:
 * this is a single-process daemon, and a metrics port would be a dependency bought for
 * nothing. Exported for the receiver (plan 03-05) to increment its layer-4 drops too.
 */
export const selfEventDropCounts: Readonly<Record<string, number>> = dropCounts;

export function incSelfEventDrop(guard: string): void {
  dropCounts[guard] = (dropCounts[guard] ?? 0) + 1;
}

const selfWrites = new Map<string, number>();

const suppressionKey = (entityType: string, entityId: string): string => `${entityType}:${entityId}`;

/**
 * Record that THIS process just wrote `entityId` in Linear, so the webhook it provokes can
 * be suppressed. In-process only, by design — the daemon is a single process, so there is
 * nothing to share this with. It is a hint layered under two stronger guards, never
 * correctness on its own.
 *
 * Prunes expired stamps on every call so the map cannot grow without bound.
 */
export function noteSelfWrite(entityType: string, entityId: string): void {
  const now = Date.now();
  for (const [key, at] of selfWrites) {
    if (now - at >= SELF_WRITE_SUPPRESSION_MS) selfWrites.delete(key);
  }
  selfWrites.set(suppressionKey(entityType, entityId), now);
}

/**
 * Layers 1-3, in order, first drop wins.
 *
 * `actorType` is populated on every result including passes: assumption A6 (that a
 * personal-API-key bot appears as the `user` variant) is unsettled, and one real delivery
 * logged with the observed discriminant settles it. If the bot turns up as `integration`,
 * layer 1 misses, layer 2 catches it, and the counters say so.
 */
export function selfEventGuards(payload: GuardPayload, botUserId: string): GuardResult {
  const actor = payload.actor;

  // D-08: a missing actor is NOT evidence an event came from a human — drop it as
  // untrusted. Testing falsiness FIRST is the point: the inverted form suggested by
  // intuition passes null actors straight through (03-RESEARCH anti-patterns). Safe only
  // because D-04's reconciliation poll re-discovers anything real lost this way, so the
  // failure mode is a short delay rather than a lost ticket.
  if (!actor) {
    incSelfEventDrop('actor:null-untrusted');
    return { drop: true, guard: 'actor:null-untrusted' };
  }

  const actorType = actor.type;

  if (actorType === 'user' && actor.id === botUserId) {
    incSelfEventDrop('actor:self');
    return { drop: true, guard: 'actor:self', actorType };
  }

  // Layer 2 applies to comments only; the body read is guarded rather than assumed, so an
  // Issue payload neither throws nor accidentally matches. A question comment is a bot
  // comment, so QUESTION_MARKER_PREFIX is not needed here — the predicate covers it.
  if (payload.type === 'Comment') {
    const body = payload.data?.body;
    if (typeof body === 'string' && isBotAuthoredBody(body)) {
      incSelfEventDrop('marker:bot-authored');
      return { drop: true, guard: 'marker:bot-authored', actorType, marker: BOT_MARKER_PREFIX };
    }
  }

  const entityType = payload.type;
  const entityId = payload.data?.id;
  if (entityType && entityId) {
    const at = selfWrites.get(suppressionKey(entityType, entityId));
    if (at !== undefined && Date.now() - at < SELF_WRITE_SUPPRESSION_MS) {
      incSelfEventDrop('suppression:self-write');
      return { drop: true, guard: 'suppression:self-write', actorType };
    }
  }

  return { drop: false, actorType };
}
