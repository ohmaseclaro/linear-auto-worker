---
phase: 02-foundation
plan: 02
subsystem: database
tags: [better-sqlite3, sqlite, pino, logging, redaction, store]

requires:
  - phase: 02-foundation (plan 01)
    provides: openStore()/runMigrations() (WAL + busy_timeout handle), createLogger()/registerSecret()
provides:
  - createSqliteStore(db) — typed CRUD over runs/questions/deliveries/kv/run_events, zero state-machine validation
  - Written proof (logger.test.ts) that a secret registered after boot redacts identically to a boot-time secret
affects: [phase-3-ingress, phase-6-orchestration, phase-4-execution, phase-7-integration]

tech-stack:
  added: []
  patterns:
    - "Generic patch UPDATE built from Object.keys(patch) -- adding a column never requires a new method"
    - "camelCase <-> snake_case column conversion via one regex pair, not a per-table map"
    - "Store methods distinguish terminal-value filters (findActiveRunByIssue) from transition checks (RunEngine.transition(), Phase 6) with an explicit comment at the seam"

key-files:
  created:
    - src/infra/store/sqlite-store.ts
    - src/infra/store/sqlite-store.test.ts
    - src/infra/logger.test.ts
    - .planning/phases/02-foundation/deferred-items.md
  modified: []

key-decisions:
  - "findActiveRunByIssue excludes 'partial' from the active set in addition to the plan text's delivered/failed/cancelled -- D-01 documents four terminal states (delivered/partial/failed/cancelled), and the plan text omitted 'partial'. Leaving it in would let a completed partial-delivery run be reported active, permitting a duplicate run against the same issue."
  - "openQuestionsForIssue joins through runs.issue_id rather than denormalizing issue_id onto questions -- CONTEXT.md left either choice open; the join needs no schema addition."
  - "logger.test.ts captures output by swapping process.stdout.write for the test's duration, not by adding a destination parameter to createLogger() -- avoids touching logger.ts (plan 02-01's file, outside this plan's files_modified scope) and needed no Contract addition."

patterns-established:
  - "Generic insert/update builders (insertRow/updateRow in sqlite-store.ts) take any row/patch object and derive SQL from its own keys -- the enforcement mechanism for 'the store holds no business rules', not just a stated intent."

requirements-completed: [OPS-02]

coverage:
  - id: D1
    description: "SqliteStore CRUD over all five tables (runs, questions, deliveries, kv, run_events), no transition/status validation"
    requirement: "OPS-02"
    verification:
      - kind: unit
        ref: "src/infra/store/sqlite-store.test.ts (written, not run -- RUSH mode; no node_modules installed)"
        status: unknown
    human_judgment: true
    rationale: "RUSH mode forbids running node --test or tsc in this worktree. Tests are written and grep-verified for structural coverage (see plan's own <verify> block, all passed) but never executed. The milestone's single end-of-run integration gate is the first point these tests actually run."
  - id: D2
    description: "recordDelivery() is dedupe-safe by construction (INSERT OR IGNORE + changes check, never SELECT-then-INSERT)"
    requirement: "OPS-02"
    verification:
      - kind: unit
        ref: "src/infra/store/sqlite-store.test.ts#recordDelivery() is dedupe-safe: true once, false on repeat, one row total"
        status: unknown
    human_judgment: true
    rationale: "Same RUSH-mode constraint as D1 -- written, not run."
  - id: D3
    description: "A secret registered after boot (registerSecret()) redacts from its first subsequent log line, closing the gap plan 01's boot-time-only wiring left open"
    requirement: "OPS-02"
    verification:
      - kind: unit
        ref: "src/infra/logger.test.ts#registerSecret() called after the logger already exists redacts from its first subsequent log line"
        status: unknown
    human_judgment: true
    rationale: "RUSH mode: written, not run. Also flags a real, separate gap (circular-object handling) documented below and in deferred-items.md."

duration: 8min
completed: 2026-09-06
status: complete
---

# Phase 2 Plan 2: SqliteStore CRUD + Post-Boot Redaction Proof Summary

**`createSqliteStore(db)` implements typed CRUD over all five ADDENDUM tables with zero transition validation, plus a written proof that `registerSecret()` redacts a secret discovered after Foundation's own boot.**

## Performance

- **Duration:** ~8 min
- **Tasks:** 2 completed
- **Files modified:** 4 (3 created source/test files + 1 deferred-items ledger)

## Accomplishments
- `sqlite-store.ts`: full `Store` interface (runs, questions, deliveries, kv, run_events) built entirely on prepared statements against plan 01's `openStore()` handle -- no second connection, no separate pragmas.
- `updateRun`/`updateQuestion` are generic column-by-column patches derived from `Object.keys(patch)` -- structurally incapable of validating a `state`/`status` value, not just documented as not doing so.
- `recordDelivery` is one `INSERT OR IGNORE` + `changes` check.
- `sqlite-store.test.ts` written covering migration idempotency, WAL/busy-timeout pragmas, delivery dedupe, both required indexes, and three sequential writers with no locking exception.
- `logger.test.ts` written proving: a boot-time secret never appears in a captured line; an `authorization`-named field redacts independent of the value list; a secret registered via `registerSecret()` after the logger already exists redacts a plain-string occurrence (the webhook-signing-secret case); `child()` inherits redaction with no per-child setup.
- Discovered and documented (not fixed, out of scope) a real cycle-detection gap in `logger.ts`'s `redact()`.

## Task Commits

1. **Task 1: SqliteStore — typed CRUD over all five tables** - `55fd32a` (feat)
2. **Task 2: Prove redaction survives a secret born after boot** - `c47d240` (test)

**Plan metadata:** (this commit)

## Files Created/Modified
- `src/infra/store/sqlite-store.ts` - `Store` interface + `createSqliteStore(db)`, full CRUD over runs/questions/deliveries/kv/run_events
- `src/infra/store/sqlite-store.test.ts` - written (not run) node:test coverage per the plan's `<behavior>` block
- `src/infra/logger.test.ts` - written (not run) node:test coverage proving post-boot redaction
- `.planning/phases/02-foundation/deferred-items.md` - new ledger; one entry (see Deviations)

## Decisions Made
- `findActiveRunByIssue` excludes `partial` in addition to the plan text's `delivered`/`failed`/`cancelled` (see Deviations — Rule 1).
- `openQuestionsForIssue` joins `questions.run_id -> runs.id` and filters on `runs.issue_id`, rather than denormalizing `issue_id` onto `questions`. Either was sanctioned by CONTEXT.md; the join needs no schema change and matches the currently-visible (soon-to-be-superseded per T33) migration.
- Post-boot secret capture in `logger.test.ts` swaps `process.stdout.write` rather than requesting a destination-injection constructor parameter on `createLogger()` — the existing signature was sufficient, so no `Contract addition` was needed for this.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug in plan text] `findActiveRunByIssue` also excludes `partial`**
- **Found during:** Task 1
- **Issue:** The plan's `<action>` text names only `delivered`/`failed`/`cancelled` as the terminal-value exclusion set. Phase 1 D-01 documents four terminal states — `delivered`, `partial`, `failed`, `cancelled` — so the plan text's list appears to have dropped `partial` by omission, not intent. Leaving it out would classify an already-completed partial-delivery run as still active, and a later webhook for the same issue would then be blocked from starting a genuinely new run — or worse, treated as a duplicate of a run that already finished.
- **Fix:** Included `'partial'` in the `NOT IN (...)` clause alongside the three named states.
- **Files modified:** `src/infra/store/sqlite-store.ts`
- **Committed in:** `55fd32a` (Task 1 commit)

### Discovered but deferred (out of scope, not fixed)

**2. `logger.ts`'s `redact()` has no cycle guard**
- **Found during:** Task 2, while writing the circular-object test the plan's `<behavior>` block requires.
- **Issue:** `redact()` recurses over `Object.entries()` with no visited-object tracking. A genuinely circular object (`o.self = o`) will overflow the call stack rather than redact cleanly, contradicting the exact property `logger.test.ts`'s last test asserts.
- **Why not fixed:** `logger.ts` belongs to plan `02-01` (already merged) and is explicitly outside this plan's `files_modified` and `<verification>` scope ("No file outside `src/infra/store/` and `src/infra/logger.test.ts` was created or modified"). Per the executor's SCOPE BOUNDARY rule, pre-existing bugs in files the current task did not change are logged, not fixed.
- **Logged to:** `.planning/phases/02-foundation/deferred-items.md`, with a suggested fix (thread a `WeakSet<object>` through `redact()`).
- **Consequence:** the circular-object test in `logger.test.ts` is expected to **fail** once actually run, until this gap is closed. This is flagged prominently (in-code comment, this SUMMARY, and the deferred-items ledger) rather than silently omitted from the test file.

---

**Total deviations:** 1 auto-fixed (Rule 1 — bug in plan text), 1 discovered-and-deferred (pre-existing bug, out of scope).
**Impact on plan:** The auto-fix is necessary for `findActiveRunByIssue` to actually distinguish active from terminal runs. The deferred item does not block this plan's own deliverables (both required files exist, are structurally complete, and pass every grep-based `<verify>` check) but will surface as a failing test at the milestone's integration gate.

## Issues Encountered
None beyond the deviations above.

## Contract additions requested

This plan's `Store` interface is **this plan's own local type** in `sqlite-store.ts`, not an import from `src/domain/` (per 02-CONTEXT.md, "Store method surface" is Foundation's discretion). The following should fold into `src/domain/ports.ts`'s `Store` interface at Phase 1/7 integration, reconciled against what Phase 6's already-merged `run-engine.ts`/`questions.ts` and Phase 3's contract-additions list actually call:

- **Method surface actually exercised by Phase 6 (already merged into this branch via `06-01`)** — confirms the shape below is not speculative:
  - `getRun(id): RunRow | undefined`
  - `updateRun(id, patch: Partial<RunRow>): void` — called with partial patches like `{ state, updatedAt }`, `{ worktreePath, updatedAt }`, `{ prUrl, updatedAt }`, `{ failureReason, updatedAt }`
  - `insertRun(row: RunRow): void`
  - `appendRunEvent({ runId, from, to, at, detail }): void` — `detail` passed as `null` in `createRun`'s genesis event
  - `getQuestion(id): QuestionRow | undefined`
  - `insertQuestion(row: QuestionRow): void`
  - `updateQuestion(id, patch: Partial<QuestionRow>): void` — called with `{ status, answer }`
  - `transaction<T>(fn: () => T): T`
- **Full surface this plan adds beyond what Phase 6 already calls:** `findActiveRunByIssue`, `listByState(...states)`, `nextQueued(limit)`, `childRuns(parentRunId)`, `openQuestionsForIssue(issueId)`, `findQuestionByCommentId(linearCommentId)`, `expiredQuestions(now)`, `recordDelivery(deliveryId, receivedAt): boolean`, `pruneDeliveries(olderThan)`, `kvGet(key)`, `kvSet(key, value)`, `listRunEvents(runId)`, `close()`.
- **Naming conflict to reconcile — deliveries.** This plan implements `recordDelivery(id, receivedAt): boolean` (per this plan's own `<action>` text). Phase 3's planning already recorded a request for `tryInsertDelivery` in `01-CONTEXT.md`'s "CONTRACT ADDITIONS REQUESTED" section, with identical semantics (atomic dedupe insert, reports whether the row was new). Same operation, two names — Phase 1/7 should pick one and alias/rename the other at integration. Recommend keeping `recordDelivery` since it is the name actually implemented and tested here.
- **Naming conflict to reconcile — KV.** This plan implements `kvGet`/`kvSet`. Phase 3's planning requested `kvGet`/`kvPut`. Same note as above — pick one name for the write method (`kvSet` vs `kvPut`) at integration.
- **Timestamp representation is genuinely ambiguous across phases and worth settling explicitly.** `src/infra/store/migrations/001-init.ts` (superseded per T33, but the only schema visible on this branch) declares `created_at`/`updated_at`/`asked_at`/`deadline_at`/`run_events.at` as `TEXT NOT NULL`. Phase 6's already-merged `run-engine.ts`/`questions.ts` construct these values as **epoch-millisecond numbers** (`Date.now()`, `at + timeoutMs`), not ISO-8601 strings. `sqlite-store.ts`'s methods pass these values through untouched (they are opaque to the store — a deliberate design choice, not a bug), so no runtime failure exists in this plan's own code. But a `TEXT`-affinity column storing a bound JS number gets converted to its text form by SQLite, and a later read-then-compare (e.g. `expiredQuestions(now)`'s `deadline_at < ?`) then compares TEXT-affinity values -- this happens to produce correct results only because epoch-ms values are consistently 13 digits for the foreseeable lifetime of this project (lexicographic compare == numeric compare at fixed width), which is a fragile invariant nobody has written down anywhere. **Recommend Phase 1/7 either types these columns `INTEGER` (matching what every layer actually stores) or documents the fixed-width assumption explicitly**, so a future migration or a differently-shaped debug fixture cannot silently break comparisons.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
Foundation's store and logger surfaces are both structurally complete and grep-verified against this plan's own `<verify>` block. Downstream phases (3 ingress, 6 orchestration — already partially merged, 4 execution) can code against the `Store` shape recorded above. At the milestone's single integration gate: `sqlite-store.test.ts` and `logger.test.ts` will run for the first time; the `logger.ts` circular-object gap in `deferred-items.md` is the one known-likely failure, everything else in this plan's own tests is expected to pass unmodified.

---
*Phase: 02-foundation*
*Completed: 2026-09-06*

## Self-Check: PASSED

All created files verified present on disk; both task commits (`55fd32a`, `c47d240`) verified present in `git log`.
