---
phase: 04-execution
plan: 02
subsystem: execution
tags: [worktree, git, concurrency, boot-reconcile]
requires:
  - src/domain/errors.ts (WorktreeError)
  - src/execution/execute-run.ts (RunCommand, ExecutionVerdict — type-only)
provides:
  - src/execution/worktree.ts (prepareWorktree with collision suffixing + mutex,
    finishWorktree, reconcileWorktrees)
affects:
  - execute-run.ts's future callers (Phase 6/7) once they wire in finishWorktree /
    reconcileWorktrees — execute-run.ts itself is untouched by this plan
  - plans 04-03..04-06 (still build against execute-run.ts's fixed signatures; this
    plan only expanded worktree.ts)
tech-stack:
  added: []
  patterns:
    - "in-process promise-chain mutex (Map<string, Promise<unknown>>) keyed by resolved
      repo path, chaining onto the previous link with .then(fn, fn) so a failed
      preparation never deadlocks the queue"
    - "resolved-path + trailing-separator containment check, shared by prepareWorktree's
      defense-in-depth guard and reconcileWorktrees' daemon-root filter"
key-files:
  created: []
  modified:
    - src/execution/worktree.ts
    - src/execution/worktree.test.ts
decisions:
  - "finishWorktree(verdict, ...) is additive — the tracer's removeWorktree stays
    exported unconditionally for existing callers; finishWorktree is the new
    verdict-gated entry point future callers (execute-run.ts, Phase 6/7) should move to."
  - "A fetch failure inside prepareWorktree's mutex is swallowed, not logged — no
    Logger is threaded into worktree.ts, and adding one only for this one call site
    with no current caller would be unused ceremony; the non-fatal behavior is what
    D-11/Pitfall 6 actually require, not the logging mechanism."
  - "reconcileWorktrees takes its non-terminal run rows as a parameter and issues no
    database read — Phase 6/7 own the query; this keeps the whole module testable
    with a scripted runCommand and no SQLite, matching every other module in this
    phase."
metrics:
  duration: ~35m
  completed: 2026-09-06
status: complete
---

# Phase 4 Plan 02: Worktree Lifecycle Summary

Collision suffixing, a per-repo mutex, verdict-gated removal, and the boot-time
reconcile are all added to `src/execution/worktree.ts` behind the tracer's fixed
`prepareWorktree` / `removeWorktree` signatures, making ROADMAP Phase 4 success
criterion 1 — two runs against one repository proceeding simultaneously without
touching each other or the operator's working copy — actually hold.

## What was built

| Capability | Requirement | Where |
|---|---|---|
| Colliding branch name suffixed `-2`, `-3`, ... bounded at 50 attempts, never resetting an existing branch | AGNT-01, D-11 | `resolveBranchName` / `branchExists` in `worktree.ts` |
| Per-repo in-process mutex serializing fetch + branch-create against one repo's `index.lock`, while different repos still run in parallel | Pitfall 6 | `withRepoMutex` (`Map<string, Promise<unknown>>`) |
| Best-effort `git fetch` before branching, non-fatal on failure | D-11 note | `prepareWorktree`, inside the mutex |
| Defense-in-depth path containment on the resolved worktree path before any subprocess runs | T-04-11, T-04-09 | `isUnderRoot` guard in `prepareWorktree` |
| Verdict-gated removal: `delivered` only | AGNT-02 | `finishWorktree` |
| Boot reconcile: `prune` before `list --porcelain`, remove unreferenced worktrees under the daemon root, report vanished run rows | AGNT-03 | `reconcileWorktrees` |
| Porcelain parser tolerant of a path containing a space | AGNT-03 | `parseWorktreePaths` |

## Exported signatures (additions to the 04-01 contract)

Plan 01 fixed `prepareWorktree` and `removeWorktree`'s existing required fields; both
are unchanged. `PrepareWorktreeInput` gained one optional field (`remote?`), which is
additive and does not break any existing caller.

```ts
export interface PrepareWorktreeInput {
  runCommand: RunCommand; repoPath: string; repoSlug: string;
  daemonDir: string; branchName: string; base: string;
  remote?: string; // NEW, optional, defaults to 'origin'
}
export function prepareWorktree(o: PrepareWorktreeInput): Promise<PreparedWorktree>; // unchanged shape

export interface FinishWorktreeInput {
  verdict: ExecutionVerdict; runCommand: RunCommand; repoPath: string; path: string;
}
export function finishWorktree(o: FinishWorktreeInput): Promise<void>;

export interface NonTerminalRun { runId: string; worktreePath: string }
export interface ReconcileWorktreesInput {
  runCommand: RunCommand; daemonDir: string;
  repoPaths: readonly string[]; nonTerminalRuns: readonly NonTerminalRun[];
}
export interface ReconcileResult { pruned: string[]; orphanedRuns: string[] }
export function reconcileWorktrees(o: ReconcileWorktreesInput): Promise<ReconcileResult>;
```

`ExecutionVerdict` is imported type-only from `execute-run.ts` (the established
type-only back-edge pattern from plan 01), so `finishWorktree`'s verdict parameter
stays in sync with `classifyOutcome`'s output without a second copy of the union.

## Contract additions requested

None. Nothing under `src/domain/` was touched (RUSH rule 3), and no port method beyond
what plan 01 already requested was needed — `reconcileWorktrees` deliberately takes its
non-terminal run rows as a plain parameter rather than querying a store, so it needs no
`Store` port surface of its own.

One note for Phase 6/7 integration, not a contract gap: `execute-run.ts` still calls
the tracer's unconditional `removeWorktree` directly (only on the `delivered` path) and
does not yet call `finishWorktree` or `reconcileWorktrees` — this plan was scoped to
expand `worktree.ts` only and explicitly forbidden from editing `execute-run.ts`
(five plans touch `src/execution/` simultaneously). Wiring `finishWorktree` into
`execute-run.ts`'s step 7, and calling `reconcileWorktrees` at daemon boot with the
`Store`'s non-terminal rows, is Phase 6/7's integration work.

## Deviations from Plan

### Auto-fixed issues

**1. [Rule 2 — missing critical functionality] Defense-in-depth path containment on
the resolved worktree path in `prepareWorktree`.**
- **Found during:** Task 1, implementing collision suffixing.
- **Issue:** the threat model (T-04-11) names Linear-supplied `branchName` becoming a
  filesystem path as a trust boundary, and notes git's own ref validation as the
  mitigation. Relying solely on git's own validation means the daemon still
  constructs and stats a path derived from untrusted text before any subprocess ever
  rejects it.
- **Fix:** `isUnderRoot` (the same resolved-path, trailing-separator containment check
  used by `reconcileWorktrees`) is checked against the computed worktree path before
  `git worktree add` is invoked at all, throwing `WorktreeError` on a mismatch. Shared
  between both functions rather than duplicated.
- **Commit:** ae9252e

No other deviations. Both tasks were implemented as specified; the plan's own examples
(bounded collision search, mutex keyed per resolved repo path, porcelain-only parsing,
prune-before-list ordering) matched what shipped without needing reinterpretation.

### Process deviations

**2. STATE.md / ROADMAP.md / REQUIREMENTS.md were not updated in this worktree.**
Per RUSH mode (all eight phases fanned out simultaneously in isolated worktrees), these
shared files are reconciled by the orchestrator at merge time, not per-plan-executor.

## Known Stubs

None. Both `finishWorktree` and `reconcileWorktrees` are fully implemented, not
placeholders — they are simply not yet called from `execute-run.ts`, which is a scoping
boundary (see Contract additions requested), not a stub.

## Self-Check: PASSED

- `src/execution/worktree.ts` — FOUND
- `src/execution/worktree.test.ts` — FOUND
- Task 1 commit `ae9252e` — FOUND (`git log --oneline --all | grep ae9252e`)
- Task 2 commit `6e193c7` — FOUND (`git log --oneline --all | grep 6e193c7`)
- `src/execution/execute-run.ts` — confirmed unchanged (`git diff --stat` against it
  over both commits is empty)
