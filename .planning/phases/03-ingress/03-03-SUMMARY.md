---
phase: 03-ingress
plan: 03
subsystem: ingress
tags: [webhooks, loop-prevention, guards, linear, node-test]

requires:
  - phase: 01-domain-contract-state-machine-schema
    provides: "src/domain/ barrel exporting BOT_COMMENT_MARKER_PREFIX and isBotAuthoredBody (T32)"
provides:
  - "selfEventGuards(payload, botUserId) — loop-prevention layers 1-3 as pure named predicates"
  - "noteSelfWrite(entityType, entityId) — the layer-3 suppression stamp, called by Phase 5's outbound writer"
  - "selfEventDropCounts / incSelfEventDrop — per-guard drop counter (D-09, ROADMAP criterion 4)"
affects: [03-05 receiver, 05 outbound, 07 integration]

tech-stack:
  added: []
  patterns:
    - "Independent named guard layers returning the guard that fired, never a bare boolean"
    - "Structural payload view instead of importing the SDK type, so predicates stay pure and testable"

key-files:
  created:
    - src/ingress/guards.ts
    - src/ingress/guards.test.ts
  modified: []

key-decisions:
  - "Null/undefined actor is dropped as untrusted (D-08), tested before any id comparison"
  - "Marker symbols imported from the src/domain/ barrel; src/shared/markers.ts NOT created (T32 supersedes 03-CONTEXT D-13)"
  - "Test colocated at src/ingress/guards.test.ts rather than test/ingress/, matching the branch's six existing test files and the tsconfig rootDir/include"

patterns-established:
  - "Every drop increments a counter keyed by its own guard name, so a dead layer reads as a permanent zero"
  - "actorType is returned on passes as well as drops, so assumption A6 is settled by one real delivery"

metrics:
  duration: ~15m
  completed: 2026-09-06

status: complete
---

# Phase 03 Plan 03: Loop-Prevention Guards Summary

Three of HOOK-07's four independent loop-prevention layers — actor identity with a
null-actor-as-untrusted rule, the invisible bot-comment marker, and an in-process
self-write suppression window — as pure predicates that each name the guard that fired and
increment a per-guard counter.

## What Was Built

`src/ingress/guards.ts` exports:

| Export | Purpose |
|---|---|
| `selfEventGuards(payload, botUserId)` | Layers 1-3, first drop wins; returns `{ drop, guard?, actorType?, marker? }` |
| `noteSelfWrite(entityType, entityId)` | Stamps a self-write and prunes expired stamps in the same call |
| `SELF_WRITE_SUPPRESSION_MS` | 90 000 ms |
| `selfEventDropCounts` | Live read-only per-guard counter view |
| `incSelfEventDrop(guard)` | Shared counter increment, so 03-05's layer 4 counts into the same object |
| `GuardPayload` / `GuardActor` / `GuardResult` | Structural input view; the SDK payload is assignable to it |

Guard names: `actor:null-untrusted`, `actor:self`, `marker:bot-authored`,
`suppression:self-write`. Layer 4 (`delivery:duplicate`) is explicitly delegated to plan
03-05's receiver in the module header, because it needs the `Linear-Delivery` header and
the Store.

`src/ingress/guards.test.ts` is a ten-row table (one row per behavior case, each asserting
the guard *name*), plus three assertions beyond the table: per-layer independence, the
null-actor-is-not-self distinction (D-08), and per-guard counter deltas. The
suppression-window expiry uses `t.mock.timers.enable({ apis: ['Date'] })` rather than
sleeping 90 seconds.

## Contract additions requested

Phase 7 reconciles these. Signatures are exact.

1. **`noteSelfWrite(entityType: string, entityId: string): void`** — exported from
   `src/ingress/guards.js`. **Phase 5's outbound layer must call it after every Linear
   write** (comment create, state transition, anything that provokes a webhook). Until
   that wiring lands, layer 3 is dead code — which is exactly what the per-guard counter
   makes visible: `selfEventDropCounts['suppression:self-write']` stays at zero.

2. **`selfEventDropCounts: Readonly<Record<string, number>>` and
   `incSelfEventDrop(guard: string): void`** — exported from `src/ingress/guards.js`.
   Plan 03-05 must call `incSelfEventDrop('delivery:duplicate')` on its layer-4 drop so all
   four layers count into one object. Phase 7 should surface this object (ROADMAP criterion
   4 wants it readable while the bot is commenting).

3. **Required from `src/domain/index.ts` (Phase 1, per T32):**
   `export const BOT_COMMENT_MARKER_PREFIX: string` and
   `export function isBotAuthoredBody(body: string): boolean`. This plan imports both and
   declares neither. `QUESTION_MARKER_PREFIX` is deliberately not imported — a question
   comment is a bot comment and `isBotAuthoredBody` already covers it.

4. **Superseded: 03-CONTEXT D-13.** D-13 assigns `src/shared/markers.ts` to Phase 3 and
   03-RESEARCH § Example 3 sketches it. Both are dead — Phase 1 owns the constants in
   `src/domain/`. `src/shared/markers.ts` was **not** created and must not be.

## Deviations from Plan

**1. [Rule 3 - Blocking] Test file colocated at `src/ingress/guards.test.ts`, not `test/ingress/guards.test.ts`**
- **Found during:** Task 2
- **Issue:** `tsconfig.json` on this branch sets `rootDir: "src"` and `include: ["src"]`,
  and `package.json`'s gate is `tsc && node --test dist` (T34's resolution). A test file
  under `test/` would never be compiled into `dist/` and therefore never run — it would be
  silently dead at the milestone integration gate. All six test files already on the branch
  (`src/domain/state-machine.test.ts`, `src/infra/config.test.ts`,
  `src/cli/wizard/preflight.test.ts`, `src/cli/wizard/repo-discovery.test.ts`,
  `src/orchestration/scheduler.test.ts`, `src/orchestration/qa-roundtrip.test.ts`) are
  colocated in `src/`.
- **Fix:** Wrote the test at `src/ingress/guards.test.ts`. Content is exactly as specified.
- **Commit:** e7ab4e6
- **Action for Phase 7:** if any sibling plan wrote tests under `test/`, they need moving
  or the tsconfig needs a second include root.

**2. [Cosmetic] Task 1's automated gate has a quote-style bug**
- The gate greps `from ".\./domain` (double quotes). The entire branch uses single-quoted
  imports and `verbatimModuleSyntax` says nothing about quote style. The import is
  `from '../domain/index.js'`, so the gate passes with `grep -qE "from '\.\./domain"` and
  fails as literally written. Every other clause of both gates passes verbatim — verified.

## Threat Mitigations Applied

| Threat ID | Mitigation |
|---|---|
| T-03-10 | Three independent layers here + the fourth in 03-05; each drop increments a named counter |
| T-03-11 | Falsy actor tested first and dropped as untrusted; the inverted `actor?.id !==` form is absent (gate-checked) |
| T-03-12 | Accepted as planned — no change |
| T-03-13 | Per-guard counter plus `actorType` returned on drops *and* passes, so A6 is settled by one real delivery |

## Known Stubs

None. Layer 3 is fully implemented but will read zero until Phase 5 calls `noteSelfWrite`
— that is the designed observability signal, not a stub.

## Verification

Both plan gates were run (grep-only; no `npm install`, `tsc`, or `node --test` per rush
mode). Task 1's gate passes verbatim except for the quote-style clause noted above; Task
2's gate passes verbatim against the colocated path. `src/shared/markers.ts` does not exist
anywhere in the tree. No marker symbol is declared locally.

## Self-Check: PASSED

- FOUND: src/ingress/guards.ts
- FOUND: src/ingress/guards.test.ts
- FOUND: commit e40cefb
- FOUND: commit e7ab4e6
