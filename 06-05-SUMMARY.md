---
phase: 06-orchestration
plan: 05
subsystem: orchestration
tags: [multi-repo, fan-out, derived-status, concurrency, DELV-06, DELV-07]
requires:
  - src/domain/types.ts (Run, RunState, RunId)
  - src/domain/state-machine.ts (RUN_STATE_TABLE)
  - src/orchestration/scheduler.ts (plan 06-01)
  - src/orchestration/run-engine.ts (plan 06-02)
provides:
  - src/orchestration/fanout.ts (planSubRuns, deriveParentStatus, ticketBriefRepos, ParentRun, FanoutPlan, DerivedParentStatus)
  - "run-engine: one ticket -> one parent + N child runs, one slot each"
  - "ticket-level rollup comment, derived on read"
affects:
  - src/orchestration/run-engine.ts
  - Phase 4 (prompt): ticketBriefRepos supplies the repo list for the ticket brief
  - Phase 5 (notify): the two event shapes below
  - Phase 1 (schema): parent row needs a nullable state column
tech-stack:
  added: []
  patterns:
    - "Derived-not-stored status as a pure total function over children"
    - "Structural input types instead of port imports, so a store cannot reach a pure module"
key-files:
  created:
    - src/orchestration/fanout.ts
    - src/orchestration/fanout.test.ts
  modified:
    - src/orchestration/run-engine.ts
decisions:
  - "The parent row's state column is typed `null` (ParentRun = Omit<Run,'state'> & {state:null}) rather than cast, so a non-nullable Run.state fails at the integration gate instead of hiding the requirement"
  - "Child branch = `${issue.branchName}-${sanitized full repo slug}`, not the trailing segment, so orgA/api and orgB/api cannot collide"
  - "Linear gets one ticket rollup; Slack keeps one message per child. Three children posting three terminal comments is the noise D-10 forbids"
  - "The lead child owns the single ack comment; siblings have no ack entry, so refreshQueuePositions no-ops on them via its existing swallowed-ack branch"
  - "No sibling-cancel, sibling-cleanup or fail-fast path exists, deliberately"
metrics:
  duration: ~35m
  completed: 2026-09-06
status: complete
---

# Phase 6 Plan 05: Multi-Repo Fan-Out Summary

One ticket over N repos becomes one parent run and N child runs, each with its own worktree,
branch, session, state and concurrency slot — with the parent's status computed from its
children on every read and stored nowhere, so a failing repo cannot discard a shipped PR.

## What Was Built

### `src/orchestration/fanout.ts` — two pure functions

`planSubRuns(issue, mapping, { now })` returns `{ parent, children }`:

- **One repo → one run, no parent.** Byte-identical in shape to what plan 02 produced,
  including using Linear's `branchName` unchanged. The common case is not wrapped in a
  degenerate parent of one.
- **N repos → one parent (`kind: 'ticket'`) + N children (`kind: 'repo'`).** Each child carries
  its own `repoDir`/`repoSlug`, its own branch, its own pre-assigned `sessionId` (T4), and its
  parent's id. The parent carries no repo, no branch, no session, no pid — and no state.
- **Branch names** are `${issue.branchName}-${sanitize(repoSlug)}`. The *full* slug is used, so
  `orgA/api` and `orgB/api` derive different branches (T-06-25). Identical slugs — a config
  error — are numbered rather than collided.
- **`worktreePath` is left `null`** on every row, exactly as plan 02 left it. The worktree is
  keyed by run id and its path is returned by `WorktreeManager.create()`; each child gets a
  distinct worktree by construction. Writing a guessed path here would make `fanout.ts` a
  second source of truth for it.

`deriveParentStatus(children)` returns `{settled:false}` or `{settled:true, state}`:

| Children | Derived |
|---|---|
| any non-terminal | `{settled:false}` — in flight, not a terminal state |
| all `delivered` | `delivered` |
| something shipped (`delivered`/`partial`) but not all delivered | `partial` |
| nothing shipped, all `cancelled` | `cancelled` |
| nothing shipped, otherwise | `failed` |

There is no tenth state: `{settled:false}` is the *absence* of an answer, not a new name for
one. `cancelled + failed` derives `failed` rather than `partial` — nothing shipped, so calling
it `partial` would claim a delivery that does not exist.

`ticketBriefRepos(plan)` returns the repo list Phase 4's prompt work needs. Composing and
writing the brief into each worktree is Phase 4's; this plan supplies the list and nothing
else. **No cross-run agent messaging was built** — for a single-operator tool that is
speculative complexity with a coordination-failure mode attached.

`fanout.ts` imports only `node:crypto`, `../domain/state-machine.js` and `../domain/types.js`.
Its inputs are narrow structural shapes (`FanoutIssue`, `FanoutRepo`, `FanoutMapping`) that
`LinearIssue` and a config mapping already satisfy — so a `Store` or `LinearClient` cannot
reach it even by accident. Purity is what makes "never stored" enforceable rather than merely
intended.

### `src/orchestration/run-engine.ts` — fan-out at pickup

- `createRun()` became `insertPlan(plan)`: inserts the parent (if any) plus every child in one
  transaction, appending a genesis `run_events` row per child. The parent gets none, because
  it has no state to record. Per-repo outcomes stay individually reconstructable (T-06-27).
- `run.requested` calls `planSubRuns` **after** resolving the mapping and **before** anything
  reaches the worktree port. Fan-out happens at the engine, never inside an agent session.
- **Each child parks for its own slot** via `scheduler.acquire(child.id)` (D-03). The scheduler
  needed nothing new: it already counts run ids rather than tickets, so a ticket over three
  repos legitimately fills a default three-slot daemon. `awaiting_answer` still appears nowhere
  in `scheduler.ts`, and no state-name special case for sub-runs was introduced.
- The **parent is never enqueued**: no slot, no worktree, no process.
- **Acknowledgement stays per ticket.** One ack comment (naming every mapped repo), one
  In Progress transition, one subscription — then the children. The ack was *not* moved into
  the per-child loop; plan 02's D-09 ordering still binds and the test's worktree spy still
  throws if anything reaches it first.
- The **lead child owns the single ack comment**. Siblings get no `kv` ack entry, so
  `refreshQueuePositions` no-ops on them through its existing swallowed-ack branch — no new
  code path, and no three children fighting over one comment's position.
- **Terminal reporting.** A child with a `parentRunId` does not post its own Linear comment;
  it calls `announceTicketRollup(parentRunId)`, which reads all children, calls
  `deriveParentStatus`, and posts exactly one rollup once the ticket settles (kv-guarded).
  Slack still gets one message per child — emitting both is Phase 5's.
- **Cancellation.** `run.cancelled` filters the parent out (it has no state to look up in the
  transition table) and applies plan 02's per-state rules to each child unchanged.
- **No sibling-cancel, sibling-cleanup or fail-fast path was added, deliberately.** A
  well-intentioned "abort the rest on first failure" is the fastest way to reintroduce exactly
  the bug DELV-07 exists to prevent.

## Verification

All plan gates re-run and passing:

| Gate | Expected | Actual |
|---|---|---|
| `fanout.ts` + `fanout.test.ts` exist | FILES_OK | FILES_OK |
| parent-status writer symbols in `fanout.ts` | 0 | 0 |
| `fanout.ts` imports `domain/ports` or `run-engine` | 0 | 0 |
| `partial` in `fanout.test.ts` | ≥1 | 8 |
| `prUrl`/pull request url in `fanout.test.ts` | ≥1 | 5 |
| `planSubRuns` in `run-engine.ts` | ≥1 | 2 |
| `cancelSiblings`/`abortSiblings`/`failFast` | 0 | 0 |
| `parentState =`/`parent_state` across `src/orchestration/` | 0 | 0 |
| `sibling`/`independent`/`untouched` in `fanout.test.ts` | ≥1 | 9 |
| T35 (enum / namespace / ctor param props) | none | none |
| T41 (tests inside `src/`) | co-located | co-located |

Additionally: `node --experimental-strip-types --check` parses all three files clean. Per rush
mode, **no `npm install`, no `tsc`, no `node --test` was run** — tests are written, not run.

## Contract additions requested

### 1. `Run.state` must be nullable — REQUIRED, and load-bearing

```ts
// src/domain/types.ts
export interface Run {
  // ...
  /**
   * `null` for a parent run of a multi-repo ticket (D-12, Phase 1 D-04): its
   * status is derived from its children and is never stored.
   */
  state: RunState | null;
}
```

Correspondingly the `runs.state` column must be **nullable** in `001-init.ts`, and any
`CHECK (state IN (...))` must permit NULL.

`fanout.ts` exports `ParentRun = Omit<Run,'state'> & { readonly state: null }` and types the
parent row that way rather than casting. If Phase 1 lands `state` non-nullable this **stops
compiling at the integration gate**, which is the intended forcing function — a cast here
would bury the one schema requirement the whole DELV-07 design rests on.

Alternative if a nullable column is unacceptable: keep `state` non-null but have every reader
dispatch on `kind === 'ticket'` first and treat the column as inapplicable. That is strictly
worse — a column with a value nobody may trust is the disagreement D-12 forbids, wearing a
disguise.

### 2. `Run.kind` and `Run.parentRunId` (already used by plan 02, confirmed needed here)

```ts
kind: 'repo' | 'ticket';
parentRunId: RunId | null;   // indexed: `CREATE INDEX runs_parent ON runs(parent_run_id)`
```

### 3. `Store.listRunsByParent` — REQUIRED

```ts
// src/domain/ports.ts, on Store
/** Every child of a parent run, in creation order, terminal ones included. */
listRunsByParent(parentRunId: RunId): Run[];
```

Real call site: `run-engine.ts` → `announceTicketRollup()`. `findActiveRunByIssue` is not a
substitute — it returns only non-terminal runs, and the whole point of the rollup is reading
the terminal ones. `fanout.test.ts` supplies a temporary implementation over `listByState` so
the test does not block on it; delete that shim once the port lands.

### 4. `Store.findActiveRunByIssue` must exclude the parent row

The parent has `state === null`. An implementation that treats `state IS NULL` as "not
terminal" would return the parent and `RUN_STATE_TABLE[null]` would throw in `cancel()`. The
engine filters `kind !== 'ticket'` defensively, but the store should not return it either.

### 5. Notification event shapes for Phase 5

Two shapes, per the plan's "Slack gets one message per child plus a rollup, Linear gets a
rollup":

```ts
/** Per child. Slack emits one of these each; Linear emits none for a child of a parent. */
interface RunTerminalEvent {
  kind: 'run.terminal';
  runId: RunId;
  parentRunId: RunId | null;
  issueId: IssueId;
  issueKey: string;
  repoSlug: string;
  state: 'delivered' | 'partial' | 'failed' | 'cancelled';
  prUrl: string | null;
  failureReason: string | null;
  logPath: string;
}

/** Once per ticket, when every child has settled. Linear posts this; Slack rolls it up. */
interface TicketRollupEvent {
  kind: 'ticket.rollup';
  parentRunId: RunId;
  issueId: IssueId;
  issueKey: string;
  /** DERIVED at emit time via deriveParentStatus(children). Never read from a column. */
  status: 'delivered' | 'partial' | 'failed' | 'cancelled';
  children: Array<{
    runId: RunId;
    repoSlug: string;
    state: RunState;
    prUrl: string | null;
    failureReason: string | null;
  }>;
}
```

`run-engine.ts` currently formats the rollup body inline; Phase 5 should replace that body
construction with an emit of `TicketRollupEvent` and leave `announceTicketRollup`'s
read-derive-guard structure intact.

### 6. Phase 8 (wizard) — carried reliance, not a request

T-06-26: which repositories a ticket may touch is determined **entirely** by the
operator-authored mapping. Ticket text never selects a repo, and `planSubRuns` reads only
`mapping.repos[]`. The wizard must keep mapping authorship out of ticket content.

## On `partial`

`partial` in the contract means a run that shipped something incomplete. Here it also means a
ticket where some repos shipped and some did not. Both readings answer *"did this ship
anything"* with the same query — which is what Phase 1 D-01 chose the state vocabulary for. No
new state name was needed or invented.

## Deviations from Plan

**1. [Rule 2 — missing correctness] Parent row filtered out of the cancel path**

- **Found during:** Task 2
- **Issue:** `run.cancelled` fed every row from `findActiveRunByIssue` into `cancel()`, which
  does `RUN_STATE_TABLE[run.state]`. A parent row with `state === null` would throw there.
- **Fix:** `.filter((run) => run.kind !== 'ticket')`, with the reason in a comment; plus
  contract request #4 so the store does not return it in the first place.
- **Files:** `src/orchestration/run-engine.ts`
- **Commit:** `082cb3a`

**2. [Rule 3 — blocking] `Ack.repos` added**

- **Found during:** Task 2
- **Issue:** the ack text must name all three repos, and `refreshQueuePositions` re-renders
  that same text on every position change. Re-reading config there would let a mapping edited
  mid-run rewrite an already-posted acknowledgement.
- **Fix:** one optional `repos?: readonly string[]` on the existing `kv` Ack record. No schema
  change, no new port.
- **Files:** `src/orchestration/run-engine.ts`
- **Commit:** `082cb3a`

**3. Removed the now-unused `randomUUID` import from `run-engine.ts`** — id minting moved into
`fanout.ts`. Left in place it would fail `noUnusedLocals` at the integration gate.

## Known Stubs

None. `ticketBriefRepos` is a complete function whose *consumer* (Phase 4's prompt composition)
is out of scope by plan instruction, not a stub.

## Commits

| Task | Commit | What |
|---|---|---|
| 1 | `c32cc12` | `fanout.ts` + `fanout.test.ts` — sub-run planning and the derived parent status |
| 2 | `082cb3a` | engine pickup fan-out, per-ticket ack, ticket rollup, per-child cancel |

## Self-Check: PASSED

All created files exist on disk; both task commits are reachable in this branch's history; no
tracked file was deleted by either commit.
