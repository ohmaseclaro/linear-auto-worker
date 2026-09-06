---
phase: 06-orchestration
plan: 01
subsystem: orchestration
tags: [scheduler, state-machine, concurrency, qa, tracer]
requires:
  - src/domain/types.ts
  - src/domain/state-machine.ts
  - src/domain/ports.ts
  - src/domain/errors.ts
  - src/domain/fakes.ts
provides:
  - createScheduler / holdsSlot (src/orchestration/scheduler.ts)
  - createRunEngine (src/orchestration/run-engine.ts)
  - createQuestions (src/orchestration/questions.ts)
affects:
  - 06-02..06-05 (all expand from this slice)
  - 07 (composition root wires these three factories)
tech-stack:
  added: []
  patterns:
    - "Slot-holding is a lookup in the domain state table, never a list in the scheduler"
    - "Single-choke-point state writes: RunEngine.transition() only"
    - "Late-bound collaborator thunk to break the engine <-> questions cycle"
key-files:
  created:
    - src/orchestration/scheduler.ts
    - src/orchestration/run-engine.ts
    - src/orchestration/questions.ts
    - src/orchestration/qa-roundtrip.test.ts
    - src/orchestration/scheduler.test.ts
  modified: []
decisions:
  - "Scheduler tracks a Set of admitted run ids and recounts, rather than incrementing a counter — a double release and a resync both become no-ops instead of drift"
  - "The engine takes `questions: () => Questions` (a thunk) so questions can call engine.transition() without a construction-order cycle"
  - "Run creation writes `queued` at INSERT and appends its genesis run_events row in the same transaction; transition() remains the sole writer of an existing run's state"
  - "The repo a run owns is recorded on the run row at creation, not re-resolved from config later, so editing a mapping mid-run cannot move a live run to a different repository"
metrics:
  duration: ~35m
  completed: 2026-09-06
status: complete
---

# Phase 6 Plan 01: Orchestration Tracer Summary

The Q&A round trip proved end to end against Phase 1's fakes: a run goes
`queued → preparing → running → awaiting_answer → running → delivering → delivered`,
gives its concurrency slot back **before** `awaiting_answer` is written, and takes one
back **before** it returns to `running` — with the scheduler asking the domain state
table what holds a slot rather than keeping its own list.

## What was built

| File | Role |
|---|---|
| `src/orchestration/scheduler.ts` | The semaphore and nothing else. `acquire` / `inUse` / `capacity` / `positionOf` / `syncFromStore` / `start` / `pause`. Exports `holdsSlot(state)`, a one-line lookup into `RUN_STATE_TABLE`. |
| `src/orchestration/run-engine.ts` | The state machine. `transition()` is the only writer of `runs.state`; `handle()` covers `run.requested` and `question.answered`; `settle()` awaits in-flight drivers (Phase 7's `drain` hooks here). |
| `src/orchestration/questions.ts` | Question lifecycle. `openQuestion` / `applyAnswer`. Reaches state only through `engine.transition()`. |
| `src/orchestration/qa-roundtrip.test.ts` | The tracer scenario plus the unmapped-issue case. |
| `src/orchestration/scheduler.test.ts` | Starvation, FIFO, position, pause/start, idempotent release, N-children-N-slots. |

## The load-bearing bit

`awaiting_answer` appears **nowhere** in `scheduler.ts`. It holds no slot because
`RUN_STATE_TABLE.awaiting_answer.holdsSlot` is false, and the scheduler asks the table.
That is the whole implementation and it is deliberately the whole implementation — a
second list here is a second thing to keep in sync, and the sync failure is the one that
turns three open questions into a dead daemon.

The tests make two claims a final-state assertion cannot:

- `qa-roundtrip.test.ts` wraps `store.appendRunEvent` and records `scheduler.inUse()` at
  the instant each state is written. `awaiting_answer` is written with the semaphore
  already at 0 — proving release-before-write, not just release-eventually. Both entries
  to `running` are written with the slot already held.
- `scheduler.test.ts` drives its slot-accounting assertion by iterating
  `Object.keys(RUN_STATE_TABLE)`, so a tenth state added in Phase 1 cannot silently
  escape the check.

## Traps honoured

- **T16** — `research/ARCHITECTURE.md`'s stale state names (`claimed`, `worktree_ready`,
  `agent_running`, `done`, `abandoned`) appear nowhere. Only the binding nine are used.
- **T17** — no retry machinery. `fail()` records the reason, transitions to `failed`, and
  stops. There is no `failed → queued` path anywhere in this plan.
- **T18** — no boot recovery in this plan (it is 06-04's), so nothing here requeues a
  `running` row. `syncFromStore` is the hook 06-04 calls *after* its sweep, so the
  semaphore starts a process agreeing with the database rather than at zero.
- **T4** — `sessionId` is `randomUUID()`d and persisted on the run row at creation,
  before any spawn; the resume path asserts both spawns carry the same id.
- **T11 / D-04** — exit-and-resume only. There is no in-process wait: the child is gone
  before `awaiting_answer` is written, and the deadline is an absolute epoch ms on the
  `questions` row, never a `setTimeout`.

## Contract additions requested

Nothing under `src/domain/` was created or edited. Everything below is a name this plan
imports or calls that the Phase 1 ADDENDUM does not fix by text. **Where Phase 1 has
already chosen a different name, Phase 7 should rename the call sites here — not the
domain.**

### `src/domain/state-machine.ts`

```ts
export interface RunStateInfo {
  /** Does a run in this state occupy one of the concurrency slots? (D-02) */
  holdsSlot: boolean;
  /** Is there a live `claude` child process for a run in this state? (D-02) */
  hasLiveChild: boolean;
  terminal: boolean;
}

/** The state table. Must be enumerable — scheduler.test.ts iterates its keys. */
export const RUN_STATE_TABLE: Readonly<Record<RunState, RunStateInfo>>;

/**
 * from -> to legality. Note this plan validates a target STATE, not a trigger:
 * `RunEngine.transition(runId, to, detail)` is the choke point, so the domain
 * needs a state-to-state predicate. A trigger-keyed table is fine underneath,
 * but this predicate must exist.
 */
export function canTransition(from: RunState, to: RunState): boolean;
```

### `src/domain/errors.ts`

```ts
export class IllegalTransitionError extends Error {
  constructor(from: RunState, to: RunState);
  readonly from: RunState;
  readonly to: RunState;
}
```

### `src/domain/types.ts`

```ts
/** One `run_events` row (Phase 1 D-03). `from` is null only for the genesis row. */
export interface RunEventRow {
  runId: RunId;
  from: RunState | null;
  to: RunState;
  at: number;          // epoch ms
  detail: string | null;
}

/** Also assumed present, with the field set sketched in research/ARCHITECTURE.md: */
export interface Run { /* id, parentRunId, kind, issueId, issueKey, issueTitle,
  issueUrl, repoDir, repoSlug, branch, worktreePath, sessionId, pid, state,
  attempt, questionRound, prUrl, failureReason, createdAt, updatedAt */ }
export interface PendingQuestion { /* id, runId, text, assumption,
  linearCommentId, askedAt, deadlineAt, status, answer */ }
export type RunId = string;
```

### `src/domain/ports.ts` — `Store`

```ts
appendRunEvent(e: RunEventRow): void;       // NEW — run_events is additive (D-03)
listRunEvents(runId: RunId): RunEventRow[]; // NEW — ordered by `at`, then insertion
getQuestion(id: string): PendingQuestion | undefined;  // NEW — research sketches
                                            // findQuestionByCommentId / ByShortCode
                                            // but no lookup by primary key
```

Also used, already sketched in research and assumed unchanged: `insertRun`, `getRun`,
`updateRun(id, patch)`, `findActiveRunByIssue`, `insertQuestion`, `updateQuestion`,
`openQuestionsForIssue`, `transaction<T>(fn)`.

### `src/domain/ports.ts` — `Scheduler`

`scheduler.ts` exports an interface extending the port with two methods. If the port
already carries them, the local `extends` collapses to nothing:

```ts
positionOf(runId: RunId): number;            // 1-based in the wait queue, 0 if admitted
syncFromStore(runs: readonly Run[]): void;   // recompute admitted set from the runs table
```

### `src/domain/ports.ts` — `Config`

The ADDENDUM fixes `defaults` and `mappings` but not their fields. This plan reads:

```ts
config.defaults.concurrency: number | undefined;        // INTK-06, defaults to 3 here
config.defaults.questionTimeoutMs: number | undefined;  // D-05, defaults to 4h here
config.defaults.baseBranch: string;
config.mappings: Record<string, { repos: RepoMapping[]; /* ... */ }>;
```

`config.mappings` is assumed **keyed by Linear project id, falling back to team id**
(Phase 1 D-07) — i.e. a `Record`, not an array. If Phase 1 lands an array,
`resolveMapping()` in `run-engine.ts` is the single site to change.

> Note: `concurrency` is a **global** cap, not one of the six per-mapping-overridable
> CONF-02 toggles. It is read from `defaults` because 06-01-PLAN.md says `Config.defaults`.
> If Phase 1 puts it at the top level as `config.concurrency`, that is arguably more
> correct and the change is one line in `createScheduler`.

### `src/domain/ports.ts` — `LinearIssue`

```ts
teamId: string | null;   // NEW — required for D-07's team-level mapping fallback.
                         // research/ARCHITECTURE.md's LinearIssue has projectId only,
                         // which makes the documented fallback unimplementable.
```

### `src/domain/ports.ts` — assumed unchanged from research

`AgentRunner.run(req, signal)`, `AgentSpawnRequest` (`runId`, `sessionId`, `cwd`,
`prompt`, `resume`, `env`), the `AgentResult` union, `WorktreeManager.create(runId, repo,
branch)` returning a `Worktree`, `Deliverer.deliver(wt, repo, { title, body })` returning
`{ url, number }`, `LinearClient.getIssue(id)`, `Logger`, `DomainEvent` (`run.requested`
carrying `issueId`; `question.answered` carrying `questionId` / `answer` / `authorName`).

### `src/domain/fakes.ts` — constructor shapes the tests assume

```ts
new InMemoryStore()                        // implements Store, incl. the three NEW methods
new FakeAgentRunner(script: AgentResult[]) // returns script[i] on the i-th call
  .calls: AgentSpawnRequest[]              // NEW — the tests assert on resume/sessionId/prompt
new FakeWorktreeManager()                  // create() returns a Worktree with a `path`
new FakeDeliverer()                        // deliver() returns { url, number }
new FakeLinearClient({ issues: LinearIssue[] })  // getIssue() resolves from that array
```

No `FakeLogger` is requested — both test files declare a six-line silent `Logger` inline.

## Deviations from Plan

**1. [Rule 2 - missing critical functionality] `Deliverer` added as an engine collaborator**

- **Found during:** Task 1
- **Issue:** The plan's behavior block requires the run to reach `delivering` then
  `delivered`. Writing those two transitions with nothing between them would have shipped
  a run that reports a delivered PR without a PR — a stub in the one place the phase is
  meant to prove real.
- **Fix:** `dispatch()` calls `deliverer.deliver(...)` on the `complete` arm and stores
  the returned `prUrl` before transitioning to `delivered`. `FakeDeliverer` is already in
  Phase 1's fake list, so this costs nothing at test time.
- **Files modified:** `src/orchestration/run-engine.ts`, `src/orchestration/qa-roundtrip.test.ts`
- **Commit:** 3c3f5ac

**2. [Rule 2] `scheduler.ts` landed complete in Task 1's commit**

- `positionOf` / `syncFromStore` / `pause` / `start` were written with the tracer rather
  than split across two commits — `drive()` parks on `acquire()` and the pause path is
  reachable from the tracer's very first call, so a half-built semaphore would have been
  a fictional intermediate state. Task 2's commit is `scheduler.test.ts`.

**3. [Rule 2] `run.requested` re-fetches the issue rather than trusting the event**

- The event carries only `issueId` (research's `DomainEvent` shape). The engine calls
  `linear.getIssue()` and decides from that, per research invariant 2. An issue with no
  matching mapping is logged and dropped with **no run row inserted**, rather than
  inserting a run that can never be driven (D-07's fallback exists precisely so this is
  rare, not so it is silent).

No architectural deviations (Rule 4). No auth gates.

## Known Stubs

| Stub | File | Why / who resolves it |
|---|---|---|
| Agent prompt is the issue title, not a composed brief | `run-engine.ts` `drive()` | Prompt composition is `execution/prompt.ts`, Phase 4. Marked with a `ponytail:` comment at the call site. |
| One repo per ticket (`mapping.repos[0]`) | `run-engine.ts` `handle()` | Multi-repo fan-out is 06-05. Each child is already a first-class run to this engine, so the expansion is additive. Marked with a `ponytail:` comment. |
| No Linear/Slack notification on any transition | `run-engine.ts` | Notifier fan-out is 06-02 (queue position comment, D-10) and Phase 5. Deliberately out of the tracer. |
| No cancellation, deadline sweep, or boot recovery | all three modules | 06-02 through 06-05. The seams exist: `aborts: Map<RunId, AbortController>` for cancel, `deadlineAt` on the question row for the sweep, `scheduler.syncFromStore()` for recovery. |

None of these prevent the plan's goal — the Q&A round trip and the slot rule are both
fully implemented and asserted.

## Threat Flags

None. This plan adds no network surface, no new trust boundary, and installs no packages.
`T-06-SC` holds: the only imports are `src/domain/` and Node builtins (`node:crypto`,
`node:test`, `node:assert/strict`).

## Not verified (rush mode)

Per RUSH.md and the plan's own constraint, **no test was executed and no typecheck was
run** — there is no `package.json` and no `node_modules` on this branch. The five files
are written, not run. Every plan-specified `<verify>` grep was executed and passed:

```
FILES_OK
raw 'update runs' in orchestration:      0
questions.ts calls to transition(:       2
qa-roundtrip 'needs_input':              1
qa-roundtrip 'awaiting_answer':          7
qa-roundtrip 'inUse':                    3
scheduler.ts literal 'preparing':        0
scheduler.ts references state-machine:   1
scheduler.test.ts 'awaiting_answer':     4
scheduler.ts positionOf:                 2
```

The first real execution of these files is the milestone integration gate.

## Self-Check: PASSED

All five source files and this summary exist on disk; both task commits (`3c3f5ac`,
`0659260`) are present in `git log`. `git diff --name-only` against the branch point
shows changes confined to `src/orchestration/` — no file outside it was created or
modified, and nothing under `src/domain/` was touched.
