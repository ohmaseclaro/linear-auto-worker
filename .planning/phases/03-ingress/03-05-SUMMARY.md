---
phase: 03-ingress
plan: 05
subsystem: ingress
tags: [webhook, hmac, ack-latency, dedupe, loop-prevention]
requires:
  - "@linear/sdk/webhooks — LinearWebhookClient, LINEAR_WEBHOOK_SIGNATURE_HEADER"
  - "src/domain/ports.ts — Logger, Store (Store.tryInsertDelivery is a contract addition)"
  - "src/ingress/guards.ts — selfEventGuards, incSelfEventDrop (plan 03-03)"
  - "src/ingress/router.ts — Router.enqueue (plan 03-04)"
  - "the webhook secret plan 03-02 persisted to kv before registering"
provides:
  - "createReceiver(deps): http.RequestListener — the phase's HTTP entry point"
  - "logFirstDeliveryShape(log, req, payload) — the one-time A1/A2/A6 diagnostic"
  - "loop-prevention layer 4 (delivery-id uniqueness), completing D-06's four layers"
affects:
  - "Phase 6 consumes DomainEvents produced downstream of the deferred router hand-off"
  - "Phase 8's wizard supplies the credentials the deferred live-UAT item needs"
tech-stack:
  added: []
  patterns:
    - "verify-before-parse via client.parseData() on a plain node:http listener"
    - "acknowledge-then-defer: res.end() precedes setImmediate(), enforced by line order"
key-files:
  created:
    - src/ingress/receiver.ts
    - src/ingress/fixtures.ts
    - src/ingress/receiver.test.ts
    - .planning/phases/03-ingress/03-HUMAN-UAT.md
  modified: []
decisions:
  - "D-11 amended: parseData() on a plain node:http listener, not the SDK's bundled request-listener helper"
  - "An absent delivery header degrades to a sha256-of-body surrogate id rather than a rejection"
  - "The explicit ±60s comparison is this module's, because the two-arg parseData leaves the SDK's inert"
metrics:
  duration: ~25m
  completed: 2026-09-06
status: complete
---

# Phase 3 Plan 5: ACK-First Receiver Summary

A `node:http` request listener that verifies the HMAC over the received bytes before
anything parses them, names the guard on every rejection, writes the 200 before it does any
work, and drops replayed deliveries idempotently.

## What was built

`src/ingress/receiver.ts` — `createReceiver({ secret, store, log, botUserId, router })`
returning an `http.RequestListener`. The request path, in order:

| Step | Guard | Outcome |
|---|---|---|
| non-POST | — | 405, stream never touched |
| headers captured before the body | — | delivery id + signature read while still reachable |
| body read once into a Buffer | `body:unreadable` | 400 |
| G0 `client.parseData(raw, sig)` | `signature` | 400 |
| G1 `typeof ts !== "number" \|\| !ts` | `timestamp:absent` | 400 |
| G1 `abs(now - ts) > 60_000` | `timestamp:stale` | 400, drift in the detail |
| G2 `store.tryInsertDelivery(id)` | `delivery-id:replay` | **200**, no router call |
| G3-G5 `selfEventGuards()` | layer 1/2/3 names | 200, no router call |
| ACK | — | `res.end('OK')`, **then** `setImmediate(router.enqueue)` |

HOOK-08 is structural, not a timing hope: the deferred hand-off is the last statement in
the file and every `res.end` precedes it by line number, which is what the plan's gate
asserts.

## Requirements

- **HOOK-04** — HMAC verified over the received `Buffer`; invalid ⇒ 400 with guard
  `signature`, nothing inserted into `deliveries`.
- **HOOK-05** — explicit `webhookTimestamp` presence assertion, closing the SDK's silent
  skip; `0` is treated as absent because it is falsy.
- **HOOK-06** — delivery-id uniqueness via the synchronous `tryInsertDelivery`, answered
  200 so Linear's retry budget is not spent on our own filtering.
- **HOOK-08** — 1200 ms router hand-off with a sub-200 ms acknowledgement assertion.
- **D-09** — every rejection carries a distinct guard name in the log.
- **D-10 / T6** — 400 throughout; the unauthorized status appears nowhere in the module,
  and the gate greps for its absence.

## Contract additions requested

```ts
// src/domain/ports.ts — Store
/** false ⇒ UNIQUE violation ⇒ this delivery was already seen (HOOK-06, loop layer 4). */
tryInsertDelivery(deliveryId: string): boolean;
```

Synchronous by design. An awaited dedupe write inside the acknowledgement path would
reintroduce the latency this whole plan exists to remove. Phase 1 owns the SQL side; the
`deliveries` table needs a `UNIQUE` on the id and the method must return `false` rather
than throw on violation.

No other port additions. `Logger`, `Store` and `DomainEvent` are consumed as already
specified in the ADDENDUM.

## Deviations from Plan

### Auto-fixed issues

**1. [Rule 3 - Blocking] Tests co-located under `src/`, not `test/`**
- **Found during:** Task 2
- **Issue:** The plan places the fixtures and the test at `test/ingress/`. T41 (and the
  checked-in `tsconfig.json`, `rootDir: "src"` / `include: ["src"]`, with `verify` being
  `tsc && node --test dist`) means a file under a top-level `test/` never compiles into
  `dist` and is therefore never run. Green gate, zero coverage — the silent-success shape
  T41 exists to prevent. Every existing test in the repo is already co-located.
- **Fix:** written as `src/ingress/fixtures.ts` and `src/ingress/receiver.test.ts`. Task
  2's gate commands were run against those paths.
- **Commit:** 33caa90

**2. [Rule 1 - Bug] No second `incSelfEventDrop` after `selfEventGuards`**
- **Found during:** Task 1
- **Issue:** The plan says to increment the counter on a layers-1-3 drop, but
  `selfEventGuards` in `guards.ts` already increments its own bucket internally. Doing it
  again double-counts every self-event drop, which corrupts exactly the signal D-09 and
  ROADMAP criterion 4 rely on.
- **Fix:** the receiver logs the guard name and the delivery id, and leaves the counter to
  `guards.ts`. Commented in place.
- **Commit:** 7136552

**3. [Rule 3 - Blocking] `logFirstDeliveryShape` takes the logger**
- **Issue:** The plan's signature is `logFirstDeliveryShape(req, payload)`, but the module
  has no ambient logger — `log` arrives through `createReceiver`'s deps.
- **Fix:** `logFirstDeliveryShape(log, req, payload)`. Behaviour is otherwise exactly as
  specified: once per process, header **keys** only, plus `typeof webhookTimestamp` and
  `actor?.type`.
- **Commit:** 7136552

### Deliberate deviations from 03-RESEARCH § Example 1

**4. An absent delivery header takes a surrogate id instead of rejecting (planned)**
Example 1 rejects with `delivery-id:absent`. The receiver instead derives
`sha256:<hex>` over the raw buffer, logs a one-time warning naming the observed header
keys, and proceeds. The header's name rests on assumption A1, which no live delivery has
confirmed; a wrong guess with a rejecting receiver drops 100% of real traffic (T-03-26).
The surrogate dedupes correctly because Linear's retries resend an identical body, and it
degrades to a documented assumption rather than an outage. Settled by the live-UAT item.

**5. The ±60 s comparison is this module's, not redundant with the SDK's**
Worth recording precisely, because it reads like a T20 violation and is not.
`parseData(rawBody, signature, timestamp)` takes the timestamp as its **third argument**,
and the receiver deliberately does not pass one — passing it would fold a stale delivery
into the signature failure and make the two indistinguishable, which D-09 forbids. With
two arguments the SDK's `if (timestamp)` block never runs, so the SDK's window is inert on
this path and the explicit check is the only window, not a second one. Same bound, same
symmetry (±60 000 ms), one owner. Example 1 measured exactly this shape:
`stale -> 400 guard=timestamp: stale by 90001ms`.

**6. Layer 4 uses two names for one event**
The counter is incremented under `delivery:duplicate` (the bucket `guards.ts` reserved in
its header comment) while the log line carries `guard: 'delivery-id:replay'` (the name
D-09 and the test matrix assert). Both names are load-bearing in different places;
collapsing them would break one or the other. Commented at the call site. Worth
reconciling in Phase 7 if a single spelling is wanted.

**7. One guard name not in the plan: `body:unreadable`**
A socket error while reading the stream had no named outcome in the plan. It rejects 400
under its own guard rather than falling into an unnamed 400, per D-09.

## Known stubs

None.

## Deferred items

- `.planning/phases/03-ingress/03-HUMAN-UAT.md` — one live delivery against a Linear
  scratch team settles assumptions A1 (delivery header name), A2 (`webhookTimestamp`
  populated) and A6 (bot actor discriminant) simultaneously, via
  `logFirstDeliveryShape`. Non-blocking; needs credentials Phase 8's wizard provides.
  Each outcome's remediation is written out in the document. A3 and A5 are explicitly
  **not** settled by it.

## Tests written, not run

Per RUSH.md rule 4 nothing was installed, compiled or executed. `src/ingress/receiver.test.ts`
covers all fourteen rows of Task 1's behavior block, including the four D-10 signature
cases, the latin1-reinterpretation negative, both falsy-timestamp rows asserting the guard
**name**, the replay drop, the surrogate-id path deduping a resent identical body, and the
1200 ms hand-off with a sub-200 ms ACK assertion.

`src/ingress/fixtures.ts` serialises once, signs that Buffer, and returns that same Buffer.
Per Pitfall 5 a parse/re-stringify round-trip is byte-identical in V8 even for emoji, CJK
and zero-width spaces, so a fixture that reconstructs the bytes cannot catch the encoding
bug it exists to catch.

**Unverified by execution:** the fixture computes the signature as
`HMAC-SHA256(rawBody, secret).digest('hex')`. That is Linear's documented scheme, but it
was not run against the installed SDK on this branch. If the integration gate shows every
signature test failing identically including the valid one, this is the line to check
first — not the receiver.

## Self-Check: PASSED

- `src/ingress/receiver.ts` — FOUND
- `src/ingress/fixtures.ts` — FOUND
- `src/ingress/receiver.test.ts` — FOUND
- `.planning/phases/03-ingress/03-HUMAN-UAT.md` — FOUND
- `7136552`, `33caa90`, `3113836` — all FOUND in `git log`
- All three of the plan's automated gate commands pass (task 2's re-pointed at `src/`).
