---
phase: 04-execution
plan: 04
subsystem: execution
tags: [stream-json, parser, event-router, agent-stdout]
requires:
  - src/domain/errors.ts (LawError)
  - src/infra/logger.ts (Logger)
  - src/execution/agent-args.ts (PERMISSION_MODE)
  - src/execution/stream-parser.ts and src/execution/event-router.ts as plan 04-01 left them
provides:
  - src/execution/stream-parser.ts (makeLineParser — carry-buffer NDJSON, now with a
    growth ceiling)
  - src/execution/event-router.ts (assertSessionUsable + makeEventRouter — extended
    with progress callbacks and a denial tally)
  - src/execution/fixtures/stream-events.jsonl (22-event fixture, real shapes)
affects:
  - plan 04-05 (supervisor.ts) — consumes router.routed.result and can now also read
    router.denials
  - Phase 5 (progress reporting) — consumes onProgress; this phase formats nothing
  - Phase 7 (integration gate) — re-capture the fixture live; run both test files
tech-stack:
  added: []
  patterns:
    - pure factory functions, no I/O, tested with fixtures rather than a live claude binary
    - options-bag defaults (expectedPermissionMode / requiredSkills) so a function's own
      exported constants are the default and a caller only overrides for testing
key-files:
  created:
    - src/execution/stream-parser.test.ts
    - src/execution/event-router.test.ts
    - src/execution/fixtures/stream-events.jsonl
  modified:
    - src/execution/stream-parser.ts
    - src/execution/event-router.ts
decisions:
  - "assertSessionUsable's 'skills absent entirely' case is its own branch with its own message, not a fallthrough of the missing-skills branch via a nullish default — 'the key was never sent' and 'the key was sent empty' are different diagnoses even though both currently throw the same LawError code."
  - "makeEventRouter's new fields (expectedPermissionMode, requiredSkills, onProgress) are all optional and default from this module's own exported constants, so supervisor.ts's existing call site (makeEventRouter({ log })) needed no change."
  - "EventRouter gained a readonly denials array alongside the existing routed property rather than replacing routed — additive, not breaking, per the locked 04-01 contract (do not change route's signature)."
metrics:
  duration: ~35m
  completed: 2026-09-06
status: complete
---

# Phase 4 Plan 04: Stream Parser and Event Router Summary

The carry-buffer NDJSON parser is complete with an unbounded-growth guard, and the event
router now routes progress and denial signals alongside the `system/init` assertion and
`result` capture that plan 04-01 fixed. A 22-event fixture transcribing real observed
`stream-json` shapes backs both test files.

## What was built

| Module | What this plan added |
|---|---|
| `stream-parser.ts` | An 8 MiB carry-growth ceiling: a line that never terminates in a newline is reported through `onBad` and the carry is reset, rather than growing until the daemon OOMs (T-04-21). The existing `indexOf`-loop scan and double-flush safety were already correct from 04-01 and are unchanged. |
| `event-router.ts` | `system/task_summary` and `system/post_turn_summary` routed through an optional `onProgress` callback (formats and posts nothing — Phase 5's job). `system/permission_denied` tallied into a new `denials` array carrying `tool_name` and `decision_reason_type`. `assertSessionUsable` gained a distinct branch for `skills` absent entirely, and an options bag so the expected mode and required skill list are overridable (both default to this module's own constants). Unknown event types remain ignored. |
| `fixtures/stream-events.jsonl` | 22 lines in the emission order `04-RESEARCH.md` records: 8 `hook_started`/`hook_response` pairs, `system/init` with the verbatim key list, an `assistant` tool-use event, `task_summary`, a `user` tool-result event, `post_turn_summary`, and a terminal `result` event with every `ResultEvent` field. Every line carries `session_id` and `uuid`. |

## Exported signatures (additions on top of 04-01's contract)

```ts
// stream-parser.ts — unchanged surface, ceiling is internal
export function makeLineParser(
  onEvent: (event: unknown) => void, onBad: (line: string) => void
): LineParser;

// event-router.ts
export interface AssertSessionUsableOptions {
  expectedPermissionMode?: string; requiredSkills?: readonly string[];
}
export type ProgressUpdate =
  | { kind: 'task_summary'; detail: string }
  | { kind: 'post_turn_summary'; status_category?: string; status_detail?: string; needs_action: string | null };
export interface MakeEventRouterOptions {
  log: Logger; expectedPermissionMode?: string; requiredSkills?: readonly string[];
  onProgress?: (update: ProgressUpdate) => void;
}
export interface EventRouter {
  route(event: unknown): void;
  readonly routed: RoutedRun;
  readonly denials: readonly PermissionDenial[];   // NEW
}
export function assertSessionUsable(init: SystemInitEvent, o?: AssertSessionUsableOptions): void;
export function makeEventRouter(o: MakeEventRouterOptions): EventRouter;
```

`makeEventRouter({ log })` (04-01's call shape, used by `supervisor.ts`) still compiles
and behaves identically — every new field is optional.

## Deviations from Plan

### Auto-fixed issues

**1. [Rule 2 — missing critical functionality] `assertSessionUsable`'s "skills absent"
case is a separate branch, not the pre-existing nullish default.**
- **Found during:** Task 2, writing the behavior for "skills absent entirely (not
  empty) throws rather than passing on a nullish default."
- **Issue:** 04-01's `init.skills ?? []` already threw when `skills` was `undefined`
  (the empty array made every required skill "missing"), so the *outcome* the plan asks
  for was already correct. But the diagnosis text was identical to the "skills present
  but incomplete" case, which conflates two different root causes an operator would
  otherwise have to guess between.
- **Fix:** an explicit `init.skills === undefined` branch with its own message ("system/init
  carried no \"skills\" key at all"), checked before the `includes()` filter.
- **Commit:** ceff84b

None of the other auto-fix rules applied — no bugs found in 04-01's code, no
architectural changes needed, no blocking issues.

## Contract additions requested

Phase 7 reconciles. Nothing under `src/domain/` was created or edited (RUSH rule 3).

**1. `EventRouter.denials` is new surface, not yet consumed anywhere.** `supervisor.ts`
(plan 04-01) still reads `resultEvent?.permission_denials` off the `result` event
directly rather than `router.denials`. Both are populated identically in the tracer's
canned-stream shape (the `result` event's own `permission_denials` field mirrors what
was tallied live), but a real run could in principle see a denial that never reaches the
`result` event body (e.g., the process is killed before the terminal event is emitted).
**Recommend:** plan 05 (or whichever plan implements the kill timer) prefer
`router.denials` over `resultEvent.permission_denials` when composing the diagnosis,
since the router's tally is populated incrementally and survives a `result` event that
never arrives.

**2. `onProgress` is unwired.** No caller passes it yet — `supervisor.ts`'s call site
is `makeEventRouter({ log: o.log })`. Phase 5's progress-reporting plan needs to thread a
callback through `RunAgentInput` → `runAgent` → `makeEventRouter`, which is a
`supervisor.ts` change plan 04-04 is explicitly forbidden from making (see plan
preamble, rule 4).

**3. `AgentEnvironmentError` (repeated from 04-01).** `event-router.ts` still throws
`new LawError('AGENT_ENV', …)` rather than a dedicated class. 04-01's SUMMARY already
files this; not re-filing a duplicate, just confirming it is still open after this plan's
edits.

## Process deviations

**STATE.md / ROADMAP.md / REQUIREMENTS.md were not updated**, per the same rationale as
04-01: multiple executors are running in parallel worktrees off the same base commit
under rush mode, and the orchestrator owns these files for this milestone.

## TDD Gate Compliance

- RED gate: not applicable in the strict sense — both `stream-parser.ts` and
  `event-router.ts` already existed (04-01 left working code behind them), so this plan
  extended existing modules and their test files rather than starting from a failing
  compile. Both `*.test.ts` files were authored fresh in this plan and describe behavior
  that the finished code (also written in this plan, for the router's new branches)
  satisfies.
- GREEN gate: `ceff84b` (event-router.ts) and `b03cf36` (stream-parser.ts + fixture)
  both carry implementation and test together.
- REFACTOR: not needed.
- **Warning: neither test file has been executed.** Per RUSH rule 2, `node --test` was
  not run. The milestone's single integration gate (`tsc && node --test dist`) is the
  first run of both files. All twenty `<verify>` grep assertions from the plan were run
  by hand against the finished files and pass (see Verification table below) — this
  substitutes for a green test run but is not one.

## Known Stubs

None. Both modules implement the full behavior their `<verify>` blocks describe. Two
notes worth flagging as *not* stubs but as scope boundaries:

- `ProgressUpdate` is defined and routed but has **no consumer yet** — see Contract
  addition #2. This is deliberate: the plan explicitly forbids editing
  `supervisor.ts`, which is where the callback would be threaded through.
- The fixture's `system/init.skills` array has 7 entries, not the 116 observed on the
  research machine. It is a faithful transcription of the *verbatim key list* and the
  three required entries (per the plan's explicit instruction), not an attempt at the
  full observed count — an abbreviated-but-real subset, called out here rather than left
  implicit.

## Fixture re-capture flag

Per the plan's own caveat and the `<success_criteria>`: **`fixtures/stream-events.jsonl`
is a transcription of the verbatim key lists, field names, and real values recorded in
`04-RESEARCH.md`, not a live capture** — nothing in this RUSH-mode session can invoke a
real `claude` process. It should be re-captured from an actual `claude -p
--output-format stream-json --verbose` run at the integration gate to confirm the
transcription didn't silently drift from real CLI output (new CLI versions could rename
or add keys). Everywhere the research gave a concrete verified value (the cost/usage
numbers, the `needs_input` structured output, the `system/init` key list), that exact
value was used rather than an invented one.

## Threat Flags

None new. This plan's edits stay inside the trust boundaries `<threat_model>` already
registers for `stream-parser.ts` and `event-router.ts` (T-04-21 through T-04-25,
T-04-SC). Notes on what landed:

- **T-04-21** (DoS, stream-parser.ts): the 8 MiB carry ceiling is the mitigation this
  plan adds — implemented as described.
- **T-04-22** (Spoofing, event-router.ts): unchanged from 04-01; the "skills absent"
  branch added here strengthens the same mitigation rather than introducing new surface.
- **T-04-23** (Repudiation, event-router.ts): the denial tally (`denials`,
  `decision_reason_type`) is this plan's direct implementation of the mitigation.
- **T-04-24** (Information Disclosure, event-router.ts): `onProgress` passes strings out
  through a callback and formats nothing; no new sink was added.
- **T-04-25** / **T-04-SC**: unchanged — no npm/pip/cargo installs, both modules import
  only Node builtins, `src/domain/errors.ts`, `src/infra/logger.ts`, and
  `src/execution/agent-args.ts`.

## Verification

All `<verify>` grep assertions from both tasks were run by hand and pass:

| Check | Expected | Actual |
|---|---|---|
| all five files exist | `FILES_OK` (×2) | `FILES_OK` / `FILES_OK` |
| `split("\n")` on non-comment lines of `stream-parser.ts` | 0 | 0 |
| value imports / `node:` imports in `stream-parser.ts` | 0 / 0 | 0 / 0 |
| `flush` / `carry` mentions in `stream-parser.ts` | ≥1 / ≥1 | 4 / 15 |
| `for (` / `onBad` in `stream-parser.test.ts` | ≥1 / ≥1 | 1 / 2 |
| `hook_started` / `post_turn_summary` / `structured_output` / `total_cost_usd` in fixture | ≥1 each | 8 / 1 / 1 / 1 |
| `session_id` count == non-blank line count in fixture | equal | 22 == 22 |
| `gsd-execute-phase` / `gsd-plan-phase` / `gsd-verify-work` in `event-router.ts` | ≥1 each | 1 / 1 / 1 |
| `^export const` / `throw` in `event-router.ts` | ≥1 / ≥1 | 1 / 3 |
| `permissionMode` in `event-router.ts` / `manual` in test | ≥1 / ≥1 | 4 / 3 |
| `JSON.parse` on non-comment lines of `event-router.ts` | 0 | 0 |
| `permission_denied` / `decision_reason_type` / `post_turn_summary` / `task_summary` in `event-router.ts` | ≥1 each | 3 / 4 / 4 / 4 |
| `missing` (case-insensitive) / `claude` in `event-router.ts` | ≥1 / ≥1 | 3 / 3 |
| `stream-events.jsonl` / `skills` in `event-router.test.ts` | ≥1 / ≥1 | 1 / 10 |

Not run, per RUSH rule 2: `npm install`, `tsc`, `node --test`, and any real `claude`
invocation.

## Self-Check: PASSED

All five files (`stream-parser.ts`, `stream-parser.test.ts`, `event-router.ts`,
`event-router.test.ts`, `fixtures/stream-events.jsonl`) exist on disk. Both commits
exist in `git log`: `b03cf36`, `ceff84b`.
