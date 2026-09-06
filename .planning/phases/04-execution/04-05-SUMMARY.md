---
phase: 04-execution
plan: 05
subsystem: execution
tags: [supervision, process-group-kill, verdict, needs-input, AGNT-08, QA-01]
requires:
  - src/execution/event-router.ts (makeEventRouter, AgentResultEvent, PermissionDenial)
  - src/execution/stream-parser.ts (makeLineParser)
  - src/execution/execute-run.ts (ExecutionVerdict)
  - src/domain/agent-result.ts (AgentResultSchema, parseAgentResult)
  - src/infra/logger.ts (Logger)
provides:
  - runAgent with an escalating process-group kill, liveness gates, and a two-stream drain
  - classifyOutcome as an exit-code-blind evidence verdict with a validated needs_input hand-off
affects:
  - src/execution/execute-run.ts (additive only — it still compiles unchanged)
tech-stack:
  added: []
  patterns:
    - "OS interaction injected (spawn / kill / isAlive / sleep) so the escalation is a state machine a test can drive"
    - "completion is Promise.race(child, escalation) — never the child promise alone"
key-files:
  created:
    - src/execution/supervisor.test.ts
    - src/execution/verdict.test.ts
  modified:
    - src/execution/supervisor.ts
    - src/execution/verdict.ts
decisions:
  - "The handle's own kill method is omitted from AgentSubprocess entirely, so calling it is a compile error rather than a review catch (T29)"
  - "verdict.ts normalises both contested AgentResult shapes before validating, so neither branch is silently rejected while T58 is open"
  - "Strict domain validation runs only on the needs_input branch — the only branch whose fields are acted on"
metrics:
  duration: ~35m
  completed: 2026-09-06
status: complete
---

# Phase 4 Plan 05: Process Supervision and the Evidence Verdict — Summary

Escalating process-group kill (SIGINT → SIGTERM → SIGKILL to the **negated** pid, liveness
checked between every step), a two-stream drain, completion as a race rather than an await,
and an exit-code-blind verdict whose `needs_input` hand-off is schema-validated before any
field of it is read.

## What was built

### `supervisor.ts` — the escalation, the drain, the race

| Concern | How it lands |
|---|---|
| **AGNT-08 / T29** | `escalate()` walks `[SIGINT, 15s] → [SIGTERM, 10s] → [SIGKILL, 0]`, calling `kill(-pid, signal)` and re-checking `isAlive(pid)` after each grace. It breaks the moment the group is gone. |
| **The sign of the pid** | `kill` receives the pid **already negated**. The test asserts `call.pid === -PID` on every recorded call, because a positive pid reaps the leader, orphans the agent's own Bash subtree, and passes every other assertion in the file. |
| **The handle's own kill** | Not on the `AgentSubprocess` interface at all. It orphans the grandchild and leaves the promise permanently pending; omitting it from the type is the cheapest enforcement available. |
| **Pitfall 3** | `await Promise.race([completed, reaped])`. `reaped` resolves only when the escalation has finished, so a surviving grandchild holding the stdout pipe cannot hang the run. |
| **D-07** | Both streams started before either is awaited. stderr goes to the log at `debug` and no further (ASVS V7); redaction is the sink's job. |
| **Fail fast (D-05)** | A router assertion rejects the drain, which triggers the escalation **immediately** rather than at the deadline, then rethrows out of `runAgent`. Waiting 45 minutes to report a fault detected in the first second is a slow failure, not a loud one. |
| **T30** | No `.on()` anywhere. Only `pid`, `stdout`, `stderr`, `then`. |
| **No cleanup** | The module performs no filesystem operation of any kind. The test creates a real temp directory as `cwd`, times the run out, and asserts the directory still exists. |

New exports: `DEFAULT_MAX_RUN_MS`, `SIGINT_GRACE_MS`, `SIGTERM_GRACE_MS`, `KillGroup`,
`IsAlive`, `Sleep`, `EscalationStep`. `AgentRunOutcome` gains `timedOut: boolean` and
`killedBy?: EscalationStep`. `RunAgentInput` gains optional `kill`, `isAlive`, `sleep`.
All additive — `execute-run.ts` compiles unchanged.

### `verdict.ts` — judged by evidence, never by exit

Classification order is the requirement: valid `needs_input` → commits + completed
`delivered` → commits + truncated `partial` → otherwise `failed`.

- **The exit code is not a parameter.** It is not read off the result event either — the
  previous `is_error === false` check is gone, replaced by `subtype !== 'success' || timedOut`.
  A function that cannot see the exit code cannot be tempted by it.
- **`needs_input` wins over the evidence** — a run that committed and still asked a
  question is a question, because the answer changes what the rest of the work should be.
- **Only a *valid* one wins.** Validation goes through `parseAgentResult`; a question with
  no assumption falls through to the evidence with `schemaError` set.
- New on `Classification`: `deniedTools`, `schemaError`, `uncommittedPaths`, `shipDraftPr`.
  `WorktreeEvidence` gains optional `uncommittedPaths`.

## Deviations from Plan

**1. [Rule 2 — missing critical functionality] `AgentResultSchema` is a JSON Schema document, not a validator.**
The plan said "validate against `AgentResultSchema`". Phase 1's `src/domain/agent-result.ts`
exports it as a schema *document* alongside `parseAgentResult`, which is the actual
validator. `verdict.ts` calls `parseAgentResult` and quotes `AgentResultSchema.required` in
the error message. Same intent, correct API.

**2. [Rule 3 — blocking] The two `AgentResult` shapes (T58) had to be bridged to validate at all.**
The wire schema this phase verified live (`AGENT_RESULT_JSON_SCHEMA` in `agent-args.ts`)
emits `status: "delivered" | "needs_input"` with `assumption`. The domain type expects
`complete` with `assumptionIfUnanswered`. `parseAgentResult` would reject every real
`needs_input` the agent can physically produce. `validateNeedsInput()` normalises the
agent's `assumption` onto the domain's `assumptionIfUnanswered` before validating — six
lines, commented, and it picks **neither** side. See `Contract additions requested`.

**3. [Deliberate] Strict validation runs only on the `needs_input` branch.**
`parseAgentResult` requires `prTitle`/`prBody` for a `complete` result; the wire schema
requires neither, so validating every branch would mark every real delivered run malformed.
`needs_input` is the only branch whose fields are acted on, and the only one D-16 constrains.

**4. [Deliberate] The "chunk reaches the injected line parser" assertion observes the routed result instead.**
The plan's behaviour block says "the injected line parser". `supervisor.ts` builds its own
parser and injecting one would be a test-only seam. The test instead splits a `result` event
**inside a JSON token**, pushes the halves after the deadline, and asserts
`outcome.resultEvent.num_turns`. That proves the full drain → parser → router path, which is
strictly stronger than asserting on a spy.

**5. [Deliberate] `summary` is defaulted, not required, on the hand-off.**
D-16 requires the question and the assumption. The domain validator's non-empty rule on
`summary` would fail a well-formed hand-off for the one field whose absence costs nothing.

None of the five needed a checkpoint. No architectural change was made.

## Contract additions requested

Nothing new is *needed* — `MappingToggles.maxRunMs` already exists and every import
resolved. One reconciliation is requested:

**T58 — pick one `AgentResult` shape, then delete the bridge in `verdict.ts`.**
If Phase 4's live-verified wire shape wins, `src/domain/agent-result.ts` becomes:

```ts
export type AgentResult =
  | { status: 'delivered'; summary?: string }
  | { status: 'needs_input'; question: string; assumption: string; summary?: string }
  | { status: 'failed'; summary?: string; failureReason?: string }
  | { status: 'crashed'; exitCode: number; stderrTail: string }
  | { status: 'cancelled' };

export function parseAgentResult(raw: unknown): AgentResult;
```

If the domain shape wins instead, `AGENT_RESULT_JSON_SCHEMA` in `agent-args.ts` must be
changed to match — it sets `additionalProperties: false`, so an agent physically cannot
return `prTitle`/`prBody`/`assumptionIfUnanswered` until they are added to it. Either way,
delete `validateNeedsInput`'s normalisation once the winner is picked; leaving both alive is
how a third shape appears.

**Also for Phase 7:** `runAgent`'s new `timedOut` must be threaded into `classifyOutcome` at
the `execute-run.ts` call site (one argument), or a reaped run with commits classifies
`delivered` instead of `partial`. `execute-run.ts` is owned by 04-01 and was not edited here.

## Stated assumptions

- **A3 — the run deadline is inherited, not measured.** `DEFAULT_MAX_RUN_MS` is 45 minutes,
  taken from `PITFALLS.md`, never timed against a real GSD phase run. Erring long is the
  safer error: too short truncates real work into `partial` rather than losing it, and
  `partial` still ships a draft PR. Commented as an assumption at the constant.
- The 15s / 10s escalation graces come from `04-RESEARCH.md` Pattern 6 and were not
  independently re-measured this session.

## Known Stubs

None.

## Verification

All plan grep gates pass:

| Gate | Result |
|---|---|
| `kill(-` present in supervisor | 2 |
| `child.kill(` / `.on("exit"` / `.on('exit'` outside comments | 0 / 0 / 0 |
| `SIGINT` / `SIGTERM` / `SIGKILL` | 9 / 6 / 3 |
| `race` / `stderr` / `detached` | 9 / 5 / 2 |
| `worktree` outside comments in supervisor | 0 |
| test: `-pid|negative` / `isAlive` / `timedOut` | 2 / 7 / 5 |
| `exitCode` / `is_error` / `result.result` / `end_turn` / `JSON.parse` outside comments in verdict | 0 / 0 / 0 / 0 / 0 |
| `needs_input` / `question` / `assumption` / `AgentResultSchema` | 5 / 10 / 11 / 2 |
| `delivered` / `partial` / `failed` / `permission_denials` | 2 / 2 / 4 / 1 |
| test: `barren` / `tool_use` / `assumption` | 1 / 8 / 10 |
| test: `is_error: true` | 0 |

**Not run, per RUSH mode:** no `npm install`, no `tsc`, no `node --test`. Both test files
are written and co-located under `src/` (T41). `execute-run.ts`, `stream-parser.ts` and
`event-router.ts` are untouched — `git diff` over this plan's commits lists exactly four
files.

**Manual, at the milestone integration gate:** re-run `04-RESEARCH.md` Probe 13's A–D kill
matrix with a real backgrounded grandchild after any `claude` upgrade. The process-group
behaviour is measured, not documented, and its validity window is shorter than the design's.

## Commits

| Task | Commit | Files |
|---|---|---|
| 1 — escalation + drain | `a4a0549` | `src/execution/supervisor.ts`, `src/execution/supervisor.test.ts` |
| 2 — evidence verdict | `9326ca1` | `src/execution/verdict.ts`, `src/execution/verdict.test.ts` |

## Self-Check: PASSED

All four source artifacts and the summary exist on disk; both task commits resolve in
`git log`.
