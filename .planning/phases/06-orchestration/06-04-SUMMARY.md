---
phase: 06-orchestration
plan: 04
subsystem: orchestration
tags: [recovery, boot-sweep, reconciliation, watermark, ops, security]
requires:
  - src/domain/types.ts
  - src/domain/ports.ts
  - src/domain/state-machine.ts
  - src/orchestration/run-engine.ts
  - src/orchestration/scheduler.ts
  - src/orchestration/questions.ts
provides:
  - recoverAtBoot(deps) — the per-state boot sweep (D-07/D-08, OPS-01)
  - reconcile(deps, now) — the reconciliation poll (INTK-07 + 03-CONTEXT D-05)
  - POLL_WATERMARK_KEY ('poll_watermark') — shared with Phase 3's poll
  - BOOT_ACTION / nonTerminalStates() — the dispatch table and its enumeration
affects:
  - 07 (composition root: sweep BEFORE the HTTP server binds; drives reconcile on a 5-min interval)
  - 03 (shares the poll_watermark key; pollForMissedWork() overlaps reconcile() — wire exactly one)
  - 04 (boot GC prunes the worktree of a requeued `preparing` run; recovery deliberately does not)
tech-stack:
  added: []
  patterns:
    - "Recovery never writes runs.state — every move goes through engine.transition(), which is what produces the run_events audit row"
    - "Non-terminal states are enumerated from RUN_STATE_TABLE; the dispatch is Record<RunState, BootAction> so a tenth state fails tsc"
    - "The watermark advances only after a clean pass, and never past our own clock — prefer re-processing over skipping"
    - "One correlator: listed comments go through questions.ingestComment(), never a second matcher"
key-files:
  created:
    - src/orchestration/recovery.ts
    - src/orchestration/recovery.test.ts
  modified: []
decisions:
  - "D-07 over research invariant 7: running/delivering FAIL at boot rather than requeue, because a row surviving to boot means an unclean exit and an unknowable push status"
  - "The unknown-state runtime backstop defaults to `fail`, not `requeue` — a wrong fail costs a re-assignment, a wrong requeue ships a second PR"
  - "Issues holding an open question are derived from store.listByState('awaiting_answer') rather than a new question-side query — zero new port methods"
  - "Listed comments go through questions.ingestComment() rather than a bare correlate() call, because ingestComment IS correlate() plus the resume, answeredBy attribution and ambiguity logging"
  - "Issues are filtered against the watermark client-side off listAssignedOpenIssues() rather than with a server-side updatedAt predicate — one filter, one place to be wrong"
  - "The watermark is clamped to `now`, so a Linear clock ahead of ours cannot carry it into the future and skip a window"
metrics:
  duration: ~35m
  completed: 2026-09-06
status: complete
---

# Phase 6 Plan 04: Restart Recovery Summary

Per-state boot recovery (`queued`/`preparing` requeue, `running`/`delivering` fail with a
diagnosis, `awaiting_answer` untouched) plus the reconciliation poll that turns a lost
webhook — an assignment **or** a threaded answer — into a latency problem rather than a
correctness problem.

## What was built

### `recoverAtBoot(deps)` — the boot sweep (OPS-01, D-07, D-08)

Loads every run in a non-terminal state, where "non-terminal" is asked of
`RUN_STATE_TABLE` rather than written out in `recovery.ts`, and dispatches each one:

| State | Action | Why |
|---|---|---|
| `queued` | leave | already correct; the queue drain picks it up |
| `preparing` | requeue → `queued` | nothing was spent, no agent was spawned |
| `running` | fail | unclean exit ⇒ push status unknowable (D-07, T-06-18) |
| `delivering` | fail | ditto — a partial push cannot be resumed blind |
| `awaiting_answer` | leave | deadline is a column, not a timer; nothing to re-arm |
| `delivered` / `partial` / `failed` / `cancelled` | not loaded | terminal is terminal |

- **Completeness (D-08).** The dispatch is `Readonly<Record<RunState, BootAction>>`, so a
  tenth state added to the contract fails `tsc`. Because nothing typechecks during rush
  mode there is also a runtime backstop: an unmapped state logs an error and defaults to
  `fail`. That default is the safe direction — a wrong `fail` costs a re-assignment, a
  wrong `requeue` ships a second pull request.
- **Sole writer preserved.** Every move goes through `engine.transition()`, so recovery
  contains no SQL and no `runs.state` write, and each recovery gets its `run_events` row
  naming what it was recovered from (T-06-20).
- **The ticket is not touched.** A requeued run is going to run, so In Progress is still
  the truth. `RecoveryDeps` has no worktree port at all, so pruning is structurally
  unreachable from here — Phase 4's boot GC owns a leftover `preparing` worktree, and a
  failed run's worktree is deliberately left for inspection (D-13).
- **Idempotent.** After one pass the only non-terminal rows are `queued` and
  `awaiting_answer`, both `leave`, so a second pass writes nothing.
- **Resilient.** A row whose transition throws is logged and skipped; the sweep continues.
  Aborting would strand every run behind it — the opposite of what D-08 asks for.
- Finishes with `scheduler.syncFromStore()` on the post-sweep rows, so the semaphore starts
  the process agreeing with the database. `awaiting_answer` contributes zero because the
  state table says it holds no slot (01-CONTEXT D-02).

### `reconcile(deps, now)` — the reconciliation poll

**Half one (INTK-07).** `linear.listAssignedOpenIssues(botUserId)`, filtered to
`updatedAt > watermark`, enqueued via `engine.handle({ kind: 'run.requested', issueId })`
when `store.findActiveRunByIssue()` is empty. Three passes over one issue produce one run.
The engine re-fetches the issue, so the decision is made from fresh state and never from a
cached payload (invariant 2).

**Half two (03-CONTEXT D-05) — the half that gets left out.** Issues holding an open
question are exactly `store.listByState('awaiting_answer')` (that is what `openQuestion`
transitions into and what `applyAnswer` is the only exit from), so this needed **no new
query and no new port method**. For each, `linear.listComments(issueId, watermark)` and
every comment goes through `questions.ingestComment()`.

**The watermark.** `kv` key **`poll_watermark`** — the exact string Phase 3's
`pollForMissedWork()` uses (03-04-PLAN line 165). Advanced only after a pass completes
without error, only forward, and never past `now`. A mid-poll Linear failure is logged and
swallowed, leaving the watermark where it was so the next pass re-covers the same window.
Preferring re-processing over skipping is safe here because the no-active-run check absorbs
a duplicate, while a skipped window is silently lost work.

## The D-07 / invariant-7 reconciliation (record this — Phase 7 owns the other half)

`research/SUMMARY.md` invariant 7 and `ARCHITECTURE.md` both say *"every `agent_running`
row found at boot is a crash artefact — requeue it."* 06-CONTEXT **D-07 supersedes that**
for the boot path, and the two are reconcilable:

> Phase 7's **clean** shutdown transitions in-flight runs to `queued` **before** exiting.
> That path stays lossless. A `running` or `delivering` row that survives to boot therefore
> means the daemon did **not** shut down cleanly — it crashed, was killed, or lost power —
> and in exactly that case the worktree contents and whether anything was pushed are both
> unknowable. Requeueing blind is what produces a second PR for already-shipped work.

**This half assumes the other half exists.** If plan 07-05 only logs on SIGTERM instead of
writing `running`/`delivering` → `queued`, then Ctrl-C costs a manual re-assignment of every
live run. See TRAPS T18 and T26 — the Phase 7 planner reached that wrong conclusion once
already, before T18 was committed. Do not soften the fail-on-`running` rule to compensate;
fix the shutdown transition.

## Integration notes for Phase 7

1. **Ordering is load-bearing.** `recoverAtBoot()` must complete **before the HTTP server
   binds**. A delivery landing while the database still shows a phantom `running` row makes
   the router treat the ticket as already in flight and drop the event.
2. **`reconcile()` and Phase 3's `pollForMissedWork()` overlap.** Both read `poll_watermark`
   and both cover the D-04 + D-05 obligation. `reconcile()` is the self-contained one — it
   consumes the results and persists the watermark; `pollForMissedWork()` returns
   `{ events, watermark }` and persists nothing. **Wire exactly one.** If Phase 3's is
   chosen, `reconcile()`'s body reduces to draining its events through `engine.handle()` /
   `questions.ingestComment()` and one `kvPut`.
3. **`kvSet` vs `kvPut` — one method, two spellings, both already on main.** `run-engine.ts`
   (06-02) calls `store.kvSet`; `registrar.ts` (03-02) and this module call `store.kvPut`.
   Phase 1 must pick one and the loser's call sites get renamed. This is the highest-value
   line in this section: it is a guaranteed integration-gate failure, not a risk.

## Contract additions requested

Nothing under `src/domain/` was created or edited, and `run-engine.ts`, `scheduler.ts` and
`questions.ts` were not touched. Everything below is a **real call site** in `recovery.ts`.

### `src/domain/ports.ts` — `LinearClient`

```ts
/**
 * D-05's comment half. `since` is the poll watermark; comments created at or
 * before it were covered by a previous clean pass.
 */
listComments(issueId: IssueId, since?: string): Promise<LinearComment[]>;

/** The projection recovery maps onto `AnswerComment` from questions.ts. */
export interface LinearComment {
  id: string;
  parentId: string | null;   // threaded replies carry the parent comment id
  body: string;
  authorId: string | null;
  authorName: string | null;
  createdAt: string;         // ISO 8601 UTC, compared lexicographically
}
```

Also used, already sketched: `listAssignedOpenIssues(botUserId)` (present on Phase 5's
`src/outbound/linear-client.ts` — the port must carry the same method).

### `src/domain/ports.ts` — `LinearIssue`

```ts
/**
 * REQUIRED. ISO 8601 UTC. Without it the watermark cannot filter and the poll
 * either re-enqueues everything every five minutes or needs a second query.
 * Phase 5's LinearIssue does not currently carry it.
 */
updatedAt: string;
```

### `src/domain/ports.ts` — `Store`

```ts
listByState(...states: RunState[]): Run[];        // variadic — 06-02 requested it, recovery spreads nonTerminalStates()
findActiveRunByIssue(issueId: IssueId): Run[];    // "active" = non-terminal; the poll's idempotence check
kvGet(key: string): string | undefined;
kvPut(key: string, value: string): void;          // see the kvSet/kvPut collision above
updateRun(id: RunId, patch: Partial<Run>): void;
```

### `src/domain/ports.ts` — `DomainEvent`

`run.requested` is emitted with `{ kind: 'run.requested', issueId }` only. If Phase 3's
union carries more required fields (a `deliveryId`, a `source`), they need defaults the
poll can supply — the poll has no delivery to name.

### `src/orchestration/run-engine.ts` — `RunEngine` (**the one that needs a decision**)

```ts
/** Already exists PRIVATELY in run-engine.ts. Expose it. */
fail(runId: RunId, reason: string): Promise<void>;

/** Also private. kv-guarded, posts the terminal/diagnosis comment exactly once. */
announceTerminal(runId: RunId): Promise<void>;
```

Recovery currently does `store.updateRun({ failureReason })` + `engine.transition(→failed)`,
which is correct in the database and in `run_events` but **posts no comment on the ticket**:
`announceTerminal` is emitted from the driver's `finally`, and a recovered run has no
driver. Exposing either method makes it one line. Until then, a run failed by the boot sweep
is silent on Linear — the operator sees a ticket stuck In Progress with no explanation,
which is the failure shape D-08 exists to prevent.

## Deviations from plan

**1. [Design] `questions.ingestComment()` instead of a bare `correlate()` call.**
The plan said "pass each one through `questions.correlate()`". `ingestComment` **is**
`correlate()` plus the resume, the `answeredBy` attribution and the ambiguity log. Calling
the bare `correlate()` would have forced recovery to reimplement all three — the opposite of
the instruction's intent. The bot-author drop that 06-03 deliberately put *inside*
`correlate` (T-06-17) is inherited either way, and a test asserts it. Every plan verify grep
still passes.

**2. [Rule 3] `recoverAtBoot` catches per-run failures.** Not in the plan. A row whose
transition throws would otherwise abandon the sweep and strand every run behind it, which
directly violates D-08's "*every* mid-flight run".

**3. [Scope] Both halves landed in commit 1.** Commit 1 carries all of `recovery.ts` (sweep
+ poll) with the sweep's tests; commit 2 carries the poll's tests. Splitting the module
across two commits bought nothing.

## Threat mitigations

| Threat | Status |
|---|---|
| T-06-17 (spoofed comment via the poll's second entry point) | mitigated — `ingestComment` → `correlate`'s bot-author drop; tested with a bot-authored comment |
| T-06-18 (a second PR for already-pushed work) | mitigated — `running`/`delivering` fail; the unknown-state backstop also defaults to `fail` |
| T-06-19 (a run stranded holding a slot) | mitigated — enumeration from `RUN_STATE_TABLE`, `Record<RunState, …>` dispatch, plus the D-08 survivor test |
| T-06-20 (unrecorded recovery) | mitigated — every move goes through `engine.transition()` |
| T-06-21 (secret leak in a diagnosis) | mitigated — recovery supplies a short reason string; `run-engine`'s `diagnosis()` composes the operator-facing text |
| T-06-22 (unbounded comment listing) | **accepted** — the watermark bounds it in practice; noted in a `ponytail:` comment with the page-cap upgrade path |
| T-06-SC (package installs) | n/a — no packages installed; Node builtins and `src/` imports only |

## Known stubs

None. Both functions are complete implementations.

## Not run (rush mode)

`npm install`, `tsc` and `node --test` were not run, per RUSH.md item 4. Both files are
written and committed with `git commit -n`. `recovery.test.ts` imports `InMemoryStore` from
`src/domain/fakes.js`, which does not exist on this branch — first execution is the
milestone integration gate.

## Commits

- `0e45e60` feat(06-04): per-state boot recovery — requeue the cheap two, fail the expensive two
- `fc45736` test(06-04): reconciliation poll — missed assignments and missed answers

## Self-Check: PASSED

Both artifacts exist on disk; both task commits are in `git log`; the two commits delete no
tracked files; no untracked leftovers.
