---
phase: 07-integration-daemon-lifecycle
plan: 04
subsystem: composition-root
tags: [daemon, wiring, execution, outbound, notifier, linear, worktree, integration]
status: complete
requires:
  - "07-03: bootDaemon(), the ingress seam, the boot smoke, src/cli/daemon-fixture.ts"
provides:
  - "src/cli/adapters.ts — WorktreeManager / AgentRunner / Deliverer expressed over Phase 4's functions"
  - "src/cli/daemon.ts — the full component graph: no domain fake remains on the wired path"
  - "src/outbound/linear-client.ts — LinearClientImpl now `implements` the domain LinearClient port"
  - "bootDaemon resolves the bot user id and every mapped team's In Progress state before ingress binds"
  - "test/integration/07-run-path.test.ts — 7 cases, written, not yet run"
affects:
  - "07-05 (starts the scheduler — now exposed on DaemonHandle; the registrar's createWebhook signature changed)"
  - "07-06 (owns the first `node --test` run; two new test files and one rewritten test block land in it)"
tech-stack:
  added: []
  patterns:
    - "The injection seam is four ports wide and the rule that sizes it is written at the options type: overridable only if it crosses a process or network boundary this machine cannot cross in a test."
    - "A layer that needs another layer's type imports it from src/domain/ports.ts and writes `implements`. A rival interface is how three unimplemented methods survived a green typecheck."
    - "The notifier hangs off `transition()`, the single writer of runs.state, so 'every transition is reported' is structural rather than a convention."
key-files:
  created:
    - src/cli/adapters.ts
    - test/integration/07-run-path.test.ts
  modified:
    - src/cli/daemon.ts
    - src/cli/daemon-fixture.ts
    - scripts/boot-smoke.ts
    - src/domain/ports.ts
    - src/domain/fakes.ts
    - src/outbound/linear-client.ts
    - src/outbound/linear-client.test.ts
    - src/orchestration/run-engine.ts
    - src/execution/supervisor.ts
    - src/execution/execute-run.ts
    - src/execution/deliver.ts
    - src/execution/deliver.test.ts
decisions:
  - "The port's `setIssueState(id, 'started'|'review')` was wrong and the facade was right: 'review' is not a Linear state TYPE. Corrected to 'started'|'completed'|'canceled'; the facade reads the team back off the issue because the run engine has no teamId to pass."
  - "The port's `createWebhook` claiming Linear returns the secret was wrong and the facade was right (research landmine #3). The secret is caller-generated, persisted to kv before the remote call, and never read back."
  - "`LinearClientImpl implements LinearClient` — the rival interface deleted rather than reconciled, so a sixth divergence is a compile error instead of a comment."
  - "The bot user id comes from `viewer()`, not from `config.botUserId`: the config value is whatever the wizard wrote once, the key is what authenticates today, and loop guard L1 compares against it."
  - "The notifier is built with the log and Slack channels only. LinearCommentChannel is excluded because the run engine already owns every Linear comment and adding it would double-post every milestone (WINDOWS #4)."
  - "The worktree manager is NOT in the injection seam: `git` is local, so a test that wants a worktree creates a scratch repository."
metrics:
  duration: ~75min
  tasks: 3
  files: 14
  completed: 2026-09-06
---

# Phase 7 Plan 04: Wiring the Execution and Outbound Layers Summary

Every layer is now composed into one graph: the real worktree manager, agent runner,
deliverer, Linear client and notifier all reach the run engine, the boot smoke still exits
0 with all of them constructed offline, and the seam 07-03 left throwing is closed at the
interface rather than with a cast.

## The seam 07-03 named me for

`bootDaemon()` threw when `opts.linear` was absent because `outbound/linear-client.ts`
declared its own `LinearClient` and `LinearIssue`. Each of 07-02's five divergences was
resolved by deciding which side was right, not by widening either to fit:

| # | Divergence | Which side was right | Resolution |
|---|---|---|---|
| 1 | `setIssueState(id, teamId, 'started'\|'completed'\|'canceled')` vs `(id, 'started'\|'review')` | **facade** | "In Review" is not a Linear state *type* — a stock workspace has both "In Progress" and "In Review" typed `started`, which is why `resolveTeamStates` already sorted by `position`. The port named one value that cannot exist and omitted two that do. Port corrected; the facade dropped the `teamId` parameter and reads the team back off the issue, because a `RepoRun` records its repository and not its Linear team. |
| 2 | `updateComment` / `addSubscriber` / `listComments` declared on the port, absent from the facade | **port** | All three implemented. Every one was a `TypeError` waiting on first use — the queue-position edit (D-10), the INTK-03 subscribe, and the answer-correlation re-fetch that the ingress mapper calls on *every threaded reply*. |
| 3 | `createWebhook` returning `{id, secret}` vs taking a caller `secret` and returning `{id}` | **facade** (landmine #3) | The port moved. Linear's docs and Linear's shipped GraphQL schema contradict each other on whether the secret comes back; generating it locally and passing it in means the contradiction never has to be resolved. |
| 4 | `teamId: string` vs `string \| null` | neither, structurally | `string` is assignable to `string \| null`; the facade's stricter guarantee survives unchanged. |
| 5 | `LinearIssue` declared twice | **port** | One declaration, in `ports.ts`; the facade re-exports it. |

The enforcement is one clause: `export class LinearClientImpl implements LinearClient`.
A rival interface is precisely what let three unimplemented methods sit behind a green
typecheck for five phases.

## The two boot resolutions

Both go through the substitutable client, so the smoke exercises them offline.

**The bot user id** now comes from `viewer()` rather than from `config.botUserId`, and an
empty one is fatal. The config value is whatever the wizard wrote once; the key is what
authenticates today. A disagreement means the operator swapped `LINEAR_API_KEY` without
re-running setup, and loop guard L1 would then compare every delivery actor against an id
the bot no longer has — the daemon's own first comment comes back in as a human event.

That change immediately turned the smoke **red**, which is the point: `RecordingLinear`'s
fake viewer reported `fake-bot-user` while the fixture's issue was assigned to
`bot-user-id`, so the router correctly refused every delivery. The fixture now seeds the
bot user, and the failure is recorded here because it is the shape of the real
misconfiguration this resolution exists to catch.

**Every mapped team's In Progress state** is resolved by type at boot (`started`, lowest
`position`), never by name and never as a hardcoded id, and the facade memoizes it per team
for the process lifetime. Resolving here rather than on the first ticket means a team with
no `started` state fails `law start` with the team named instead of failing an
acknowledgement thirty seconds into the first run.

## The reconciliation items

| Item | What was wrong | Fix |
|---|---|---|
| **P5** — `onProgress` unwired | `event-router.ts` routed `task_summary` / `post_turn_summary` into a callback nothing threaded past `runAgent`. A 40-minute run said nothing between its acknowledgement and its terminal comment and read as hung. | `RunAgentInput.onProgress`, forwarded to `makeEventRouter`; the adapter formats one line; the composition root logs it. **Not** a Linear comment: D-01 caps the ticket at 4–6 milestones and every bot comment is an event the four loop guards must drop. |
| **P5 (second half)** | `runAgent` reported `denials` from `resultEvent.permission_denials`. A reaped run has no result event, so it reported *zero* denials for exactly the runs whose denials are the explanation. | Prefer `router.denials`; the adapter's failure diagnosis reads it. |
| **P6 / T61** — `timedOut` unthreaded | A run killed at its deadline **with commits present classified `delivered`**, shipping a truncated branch as a ready PR described as complete. | One argument at the `execute-run.ts` call site. |
| **P7 / T60** — `gh pr list` text parse | A grep gate banning `--json` file-wide forced `findOpenPrUrl` into "first integer of the first non-empty line", on the one path that decides whether a second PR is opened for a branch that already has one. | Rewritten on `gh pr list --json number,url`; the URL now comes back from `gh` instead of being reassembled, so GitHub Enterprise works. The gate in `deliver.test.ts` now names `gh pr create`, and a second case asserts the list call **does** use `--json`. |
| **T49** — loop guard 3 half-wired | Nothing recorded a self-write for issue state transitions. | `noteSelfWrite('Issue', id)` inside the facade's `setIssueState` — the daemon's only issue-state writer, so a future second caller cannot bypass it. Falsified in `linear-client.test.ts`: the guard is asserted to **pass** the event first, then drop it. |

## Deviations from Plan

**1. [Rule 3] The three execution ports needed adapters — `src/cli/adapters.ts`.**
Phase 4 shipped `prepareWorktree` / `runAgent` / `deliver` as free functions with injectable
process runners; `RunEngineDeps` takes objects. The translation is ~280 lines and putting it
in `daemon.ts` would have buried the wiring list it exists to make readable. Nothing in the
file performs I/O at construction time — the smoke composes all three offline with no git
repository and no `claude` on PATH.

**2. [Rule 4-adjacent, resolved deliberately] The notifier is built with two channels, not
three.** 05-CONTEXT lists Linear comments, Slack and log. `LinearCommentChannel.enabled()`
gates on the mapping toggle alone and fires on *every* kind — but the run engine already
posts every Linear comment this product makes, and posts them with things the channel
structurally cannot do: the acknowledgement is **edited in place** as the queue moves
(D-10 / INTK-06), a question is a **threaded reply** whose comment id is stored for tier-1
answer correlation, and a multi-repo ticket gets **one rollup** instead of one comment per
child (D-12 / DELV-07). Wiring it would post a second, poorer comment for every milestone
on every ticket — the wall of bot noise D-10 exists to prevent. The log channel, which is
the half the engine does *not* already do, is unconditional and unremovable by construction
(D-04 / NOTF-01). Recorded as WINDOWS #4: the right resolution is moving the engine's four
comment sites onto the channel, which is a Phase 5/6 redesign, not a wiring change.

**3. [Rule 1] The engine recorded the *requested* branch, not the resolved one.**
`drive()` wrote `{ worktreePath }` after `worktrees.create`. D-11 suffixes a colliding
branch name rather than resetting the existing branch — so on exactly the retries that
matter, the run row named a ref that was never created and `worktreeOf()` would hand the
deliverer that dead name at push time. One field added to the same `updateRun`.

**4. [Rule 2] `runAgent` had no way to be cancelled.** It owns the only pid, and the
engine's cancel path (D-11 / INTK-08) aborts an `AbortController` nothing was listening to.
An unassigned ticket would have left a `claude` session running for up to `maxRunMs` while
the run row already said `cancelled`. `RunAgentInput.signal` now triggers the same
process-group escalation the deadline uses; it deliberately does **not** set `timedOut`,
because a cancelled run is not a truncated one.

**5. [Rule 3] `DaemonHandle` gained `botUserId`, `startedStateIds` and `scheduler`.**
The first two are what the smoke asserts on. The third is what the run-path test starts —
the scheduler stays paused in `bootDaemon` (07-CONTEXT D-01) and 07-05 still owns starting
it in the boot lifecycle; exposing it keeps that boundary visible rather than eroded.

**6. [Rule 3] `src/cli/daemon-fixture.ts` gained `makeScratchRepo` and a seeded bot user.**
See "The two boot resolutions" for why the seed was not cosmetic.

## Contract additions requested

One, and it is on the port rather than away from it: **`LinearClient.resolveWorkflowStateId(teamId, stateType)`**.
`setIssueState` already did this lookup privately and memoized it; exposing it is what lets
the composition root prime the cache for every configured team at boot and assert the
result is non-empty. Without it, "resolved once at boot, not per event" is a comment.

## Constructors that had to change to avoid I/O

**None.** Every Phase 4 and Phase 5 component composed offline on the first attempt —
`prepareWorktree`, `runAgent` and `deliver` are free functions that do their work when
called, `LinearClientImpl` only constructs the SDK client, and `Notifier` only builds its
channel array. The plan asked this to be reported to the milestone summary; the answer is
that the Phase 4/5 decomposition already had the property.

## Known Stubs

| Stub | Where | Why | Owner |
|---|---|---|---|
| The notifier's Linear comment channel is not constructed | `src/cli/daemon.ts` | Deviation 2. Would double-post every milestone. WINDOWS #4. | Phase 5/6 redesign |
| Terminal notifications report `costUsd: 0` and `tokensUsed: 0` | `src/cli/daemon.ts` (`toNotifyEvent`) | There is no cost or token column on `runs`. `classifyOutcome` already computes both; carrying them to the run row is a schema change, not a wiring change. Slack and the log therefore say `$0.0000` on every run. WINDOWS #5. | later |
| `worktree_ready` is never emitted | `src/cli/daemon.ts` (`NOTIFY_KIND`) | The engine transitions straight to `running` once the worktree exists, so there is no state to hang it on. One event per transition beats two events for one write. | none — deliberate |
| The engine trusts the agent's `status: 'complete'` claim rather than judging by worktree evidence | `src/orchestration/run-engine.ts` `dispatch()` | Two verdict designs exist: the engine's (trust the structured result) and `execute-run.ts`'s (`classifyOutcome`, commits-in-the-worktree). Only the engine's is on the wired path, so `partial` is currently unreachable from a live run. Reconciling them means adding `partial` to `AgentResult` and a draft flag to the `Deliverer` port — architectural, not wiring. | Phase 4/6 reconciliation |
| `test/integration/07-run-path.test.ts` has never been executed | that file | This plan was instructed not to run it; plan 06 owns the first `node --test`. It typechecks and holds 7 cases. **T71 applies to 07-06, not to this plan: none of its assertions has been shown to go red.** | **07-06** |
| `maxQuestionRounds` still unenforced (T44) | — | Not this plan's; unchanged. | 07-05/06 |

## Threat Flags

None. Every file touched sits inside the threat model the plan already declared; the two
new trust-boundary surfaces (`addSubscriber` and `listComments` reaching Linear) go through
the same `call()` wrapper as every other method, which is what makes rate-limit handling
and the never-log-the-raw-error rule impossible to forget.

## Falsification (T71)

Every check added in this plan that *can* be run today was proved to go red before being
trusted:

| deliberate break | result |
|---|---|
| `resolveStartedStates` resolves no teams | `SMOKE FAILED — the In Progress state resolved for every mapped team (0 team(s))` |
| a stale, config-derived bot id reaches the router | `SMOKE FAILED — the bot user id was resolved from viewer(), not from config (got stale-from-config)` |
| the fixture's fake viewer disagrees with the fixture's issue assignee (found accidentally, kept) | `SMOKE FAILED — timed out after 2000ms waiting for a queued run` |
| T49: `selfEventGuards` before any `setIssueState` | asserted to **pass** the event, inside the test itself, so the drop that follows means something |

All three smoke breaks were reverted. The T49 falsification is permanent — it is the first
assertion of that test case.

## Verification

| check | result |
|---|---|
| `npx tsc --noEmit` | exit 0 |
| `grep -cE 'TS1005\|TS1128\|TS1002\|TS1109\|TS1434'` (T54 syntax mask) | 0 |
| `npm run smoke` | exit 0, **13** assertions (was 10) |
| smoke falsified twice against deliberate breaks | both FAIL with the right diagnosis |
| `Fake(Worktree\|Agent\|Deliverer\|LinearClient)` in `src/cli/daemon.ts` | 0 |
| `grep -c 'test(' test/integration/07-run-path.test.ts` | 7 |
| `@ts-ignore` / `@ts-expect-error` added | 0 / 0 |
| `: any` / `as any` / `as unknown as` added by this plan's diff | 0 / 0 / 0 (`as unknown as` fell by 2 repo-wide) |

`node --test` was NOT run — plan 06 owns the first gate run.

## Self-Check: PASSED

- `src/cli/adapters.ts` and `test/integration/07-run-path.test.ts` present.
- Commits `394ac01`, `6df790e`, `b0f632f` present.
- `git status --short` clean before this summary.
