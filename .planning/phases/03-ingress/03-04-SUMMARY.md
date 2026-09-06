---
phase: 03-ingress
plan: 04
subsystem: ingress
tags: [router, poll, reconciliation, webhooks, linear]
requires:
  - src/domain/ports.ts (DomainEvent, Logger, Store)
provides:
  - createRouter() — verified delivery → at most one normalised DomainEvent
  - pollForMissedWork() — the D-04 reconciliation QUERY (Phase 6 owns the timer)
affects:
  - plan 03-05 (receiver calls router.enqueue from its deferred callback)
  - Phase 6 (wires the 5-minute timer to pollForMissedWork and persists the watermark)
tech-stack:
  added: []
  patterns:
    - "Edge-detect on updatedFrom key membership, then re-fetch and decide from fresh state"
    - "Exhaust-then-read pagination (T22)"
key-files:
  created:
    - src/ingress/router.ts
    - src/ingress/router.test.ts
    - src/ingress/poll.ts
    - src/ingress/poll.test.ts
  modified: []
decisions:
  - "DomainEvent imported from src/domain/ports.ts (not types.ts) — matches the already-merged run-engine.ts"
  - "Tests colocated in src/ingress/ rather than test/ — tsconfig include is [\"src\"], so test/ would never compile or run"
  - "Watermark clamped to the query start time, so an issue updated mid-poll is not skipped by a later comment's timestamp"
metrics:
  duration: ~25m
  completed: 2026-09-06
status: complete
---

# Phase 3 Plan 04: Event Router and Missed-Work Poll Query Summary

The ingress phase boundary: a verified delivery becomes at most one normalised
`DomainEvent`, always decided from a fresh fetch rather than the payload — plus the query
half of the reconciliation poll that recovers whatever the webhook path dropped.

## What Was Built

### `src/ingress/router.ts` — `createRouter(deps)` → `{ enqueue(payload, deliveryId?) }`

Two distinct steps, in this order, and the order is the whole point:

1. **Decide whether to look.** For `action: 'update'` the edge is key *membership*:
   `payload.updatedFrom != null && 'assigneeId' in payload.updatedFrom`. Keying on "the
   assignee is the bot" instead would re-fire on every later edit of that issue forever,
   including the bot's own writes (loop surface 3). For `action: 'create'` there is no
   prior-value object at all, so a pre-assigned bot on creation is the edge instead.
2. **Decide what happened.** `await client.issue(id)`, then read the assignee off the
   *fetched* issue. `issue.assigned` when it is the bot; `issue.unassigned` when the edge
   fired on an update and it is not. On a create there was never an assignment to lose, so
   a payload that claims the bot while the fetch disagrees emits nothing (INTK-05).

Comment path emits `comment.created` with `issueId`, `commentId`, `parentId` straight from
`payload.data` — these are identifiers, not decisions, so no branch is taken on payload
content and no second fetch is needed. `parentId` is what Phase 6 threads answers with.

`enqueue()` never throws. It runs from 03-05's deferred callback *after* the 200 is
written, so an escaping rejection would be an unhandled rejection in the receiver rather
than a failed ACK. Failures log the message plus the delivery id (assumption A1's only
correlation key) — never the raw error object (T23/T24).

### `src/ingress/poll.ts` — `pollForMissedWork(deps)` → `{ events, watermark }`

Reads `store.kvGet('poll_watermark')`, defaults to the epoch, then two passes:

- bot-assigned issues with `updatedAt > watermark` → `issue.assigned`, the *same* event
  shape the router emits (D-04: identical events are what make a lost delivery a latency
  problem, and what makes D-08's null-actor drop sound);
- for each `openQuestionIssueIds` entry, comments with `createdAt > watermark` →
  `comment.created` (D-05: an issue-level diff cannot see a threaded answer, because a
  comment is not an issue field).

No dedupe — an issue the caller already knows about is still emitted; deduplication
belongs to the consumer's run records (T-03-17 accepts at-least-once deliberately).
Pagination exhausts `hasNextPage` then reads `nodes` once (T22).

**No timer, no interval, no self-scheduling of any kind, and no watermark write-back.**
D-12: Phase 3 owns the query, Phase 6 owns the schedule and the persist.

## Contract additions requested

### ⚠️ `DomainEvent` — a live collision Phase 7 must resolve, not a gap

Two incompatible unions are in circulation under the same name, and **both are already
committed to `main`-bound branches**:

```ts
// A. research/ARCHITECTURE.md — what src/orchestration/run-engine.ts ALREADY imports
//    and switches on today (merged, Phase 6):
type DomainEvent =
  | { kind: 'run.requested'; issueId: IssueId }
  | { kind: 'run.cancelled'; issueId: IssueId; reason: string }
  | { kind: 'question.answered'; questionId: string; answer: string; authorName: string }
  | { kind: 'ignored'; reason: string };

// B. 03-RESEARCH.md § Contract Additions Requested — what 03-04-PLAN.md mandates,
//    gate-enforced, and what this plan emits:
type DomainEvent =
  | { kind: 'issue.assigned';   issueId: string; deliveryId?: string }
  | { kind: 'issue.unassigned'; issueId: string; deliveryId?: string }
  | { kind: 'comment.created';  issueId: string; commentId: string;
      parentId?: string; deliveryId?: string };
```

They do not overlap on a single `kind`. As it stands, ingress emits events the engine's
`handle()` drops through its `default:` arm — **the daemon would boot clean, verify clean,
and process nothing.** That is the worst failure shape in this project (cf. T19).

Recommendation for Phase 7 (cheapest reconciliation, nothing to rewrite in either layer):
take the **union of both** in `src/domain/ports.ts`, and add a mapping step at the seam —
`issue.assigned` → `run.requested`, `issue.unassigned` → `run.cancelled`,
`comment.created` → `question.answered` after Phase 6 correlates `parentId` to an open
question. That mapping is Phase 6's, is exactly where D-05's correlation already has to
live, and it keeps ingress honest: ingress reports *what Linear did*, the engine decides
*what that means for a run*. Do **not** resolve it by renaming this phase's kinds — three
gated verify strings in Phase 3 assert them literally.

### Other symbols this plan calls

```ts
// src/domain/ports.ts
Store.kvGet(key: string): string | undefined;   // used with key 'poll_watermark'
// (kvSet/kvPut is NOT called here by design — Phase 6 persists after consumption.
//  Note the contract still disagrees with itself: ARCHITECTURE.md says kvSet,
//  01-CONTEXT and 03-02 say kvPut. Phase 7 must pick one.)
Logger;                                          // child/info/warn/error/debug
```

### The exact signature Phase 6 wires its timer to

```ts
// src/ingress/poll.ts
export const POLL_WATERMARK_KEY = 'poll_watermark';

export function pollForMissedWork(deps: {
  client: PollClient;                 // { issues({filter}), comments({filter}) } — SDK slice
  store: Pick<Store, 'kvGet'>;
  botUserId: string;
  openQuestionIssueIds: string[];     // caller supplies from store.openQuestionsForIssue
  now?: () => Date;                   // injectable clock, tests only
}): Promise<{ events: DomainEvent[]; watermark: string }>;
```

Phase 6: call it at boot and on a 5-minute interval, hand `events` to
`runEngine.handle()`, and **only then** persist `watermark` under `POLL_WATERMARK_KEY`.
Persisting first discards work if the process dies in between.

### Client types are declared structurally, on purpose

`router.ts` and `poll.ts` each declare the narrow slice of `@linear/sdk`'s `LinearClient`
they call (`RouterClient`, `PollClient`, `Connection<T>`, `FetchedIssue`, `PolledIssue`,
`PolledComment`) rather than importing the SDK's 74k-line type. Two reasons: a test can
pass a four-line fake, and Phase 3 is not bound to the domain `LinearClient` port, whose
method is `getIssue(id)` while the plan and the SDK both say `client.issue(id)`. If Phase 7
prefers a single port, these interfaces are the exact required surface.

## Deviations from Plan

**1. [Rule 3 — blocking] Tests colocated in `src/ingress/`, not `test/ingress/`**

- **Found during:** Task 1, before writing the first test.
- **Issue:** `tsconfig.json` has `rootDir: "src"` and `include: ["src"]`, and the milestone
  gate is `tsc && node --test dist`. A test at `test/ingress/router.test.ts` is never
  compiled, so it is never run — it would look like passing coverage and execute zero
  assertions. Every existing test in the repo (`src/infra/config.test.ts`,
  `src/orchestration/scheduler.test.ts`, `src/domain/state-machine.test.ts`) is colocated.
- **Fix:** wrote `src/ingress/router.test.ts` and `src/ingress/poll.test.ts`. Both plan
  gates were re-run with only the two test-file paths substituted; every other clause
  (including the line-order assertion) passes unmodified.
- **Impact on the gate string:** the two `test -f test/ingress/*.test.ts` clauses in
  03-04-PLAN.md are stale. Phase 7 should read them as `src/ingress/`.

**2. [Rule 3] `DomainEvent` imported from `../domain/ports.js`, not `../domain/types.js`**

- The plan says `types.ts`; the already-merged `src/orchestration/run-engine.ts` imports it
  from `ports.ts`, and 01-CONTEXT lists it among the *ports* additions. Followed the code
  that exists. Neither file is on this branch yet (Phase 1 is writing them in parallel), so
  this is a one-word fix either way.

**3. [Rule 2] Watermark clamped to the query start time**

- **Issue:** a single scalar watermark advanced to `max(all observed timestamps)` can skip
  work: an issue updated *after* the issues query ran but *before* a comment observed at a
  later timestamp would sit below the new watermark forever — silent work loss, in the one
  file whose entire job is preventing silent work loss.
- **Fix:** one line — `watermark: newest > startedAt ? startedAt : newest`. Cost is
  re-emitting a comment once, which the consumer already dedupes (T-03-17).

**4. STATE.md / ROADMAP.md not updated**

- Eight phases are executing simultaneously in isolated worktrees. Eight branches editing
  `.planning/STATE.md` is a guaranteed merge conflict on every merge. Left to the
  integration gate, per RUSH.md's "commit working code and move on".

## Verification

Per RUSH.md rule 4 nothing was installed, compiled, or executed. Both plan gate commands
were run with the test-file paths corrected (deviation 1):

```
TASK 1 GATE PASS   # incl. `client.issue(` at line 79 < first `kind: 'issue.assigned'` at 82
TASK 2 GATE PASS   # incl. no setInterval/setTimeout/kv-write outside comments
```

## Known Stubs

None. Both modules are complete against their behavior blocks. Deliberately **out of
scope** and owned elsewhere, not stubbed here:

| Not built | Owner |
|---|---|
| The 5-minute timer that calls `pollForMissedWork` | Phase 6 (D-12) |
| Persisting the returned watermark | Phase 6 |
| Correlating a `comment.created` `parentId` back to a parked run | Phase 6 (D-05) |
| Self-write / bot-authored / null-actor filtering | plan 03-03 `guards.ts` (D-06…D-09) |
| Delivery-ID dedupe | plan 03-05 receiver (HOOK-06) |

## Threat Flags

None. The two mitigations this plan owns are both in place: T-03-14 (decide from the
re-fetch, asserted by line order in the gate) and T-03-15 (edge is key membership, asserted
by grep and by the second test).

## Self-Check: PASSED

- `src/ingress/router.ts` — FOUND
- `src/ingress/router.test.ts` — FOUND
- `src/ingress/poll.ts` — FOUND
- `src/ingress/poll.test.ts` — FOUND
- commit `273f1d3` — FOUND
- commit `9eb3fc9` — FOUND
