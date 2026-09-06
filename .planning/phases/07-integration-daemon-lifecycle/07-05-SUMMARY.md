---
phase: 07-integration-daemon-lifecycle
plan: 05
subsystem: daemon-lifecycle
tags: [daemon, boot, shutdown, signals, process-group, recovery, webhook, preflight]
status: complete
requires:
  - "07-04: the full component graph, DaemonHandle.scheduler, adapters.ts"
  - "07-03: bootDaemon(), the ingress seam, probingTunnel's open-side TCP probe"
provides:
  - "src/cli/daemon.ts — the complete ordered boot and the reverse-order shutdown, both exported"
  - "installSignalHandlers(handle, exit?) — SIGINT/SIGTERM, with a remover, installed by `law start` and NOT by bootDaemon"
  - "SHUTDOWN_NOTE — the marker every in-flight run carries after a clean stop"
  - "RunEngine.stop() — abort every live child (process-group reap) and stop every driver writing run state"
  - "RunEngine.announceTerminal(runId) — T50/R24 closed: a boot-recovered failure reaches the ticket"
  - "src/ingress/registrar.ts — reconcile() over the domain port, plus disable() for shutdown"
  - "BootOptions.runCommand — the fifth injection slot, so preflight is exercised rather than skipped"
  - "test/integration/07-lifecycle.test.ts — 8 cases, written, not yet run"
affects:
  - "07-06 (owns the first `node --test`; two new/changed test files land in it — 07-lifecycle.test.ts and the rewritten registrar.test.ts)"
tech-stack:
  added: []
  patterns:
    - "An ordering rule is only real if a wrong order FAILS. Both ends of the daemon's life are now runtime probes: the tunnel stub TCP-connects on open (bind must precede tunnel) and again on close (tunnel must precede server)."
    - "A source grep for a signal name is satisfied by prose. Count `process.listenerCount` instead."
    - "Shutdown waits for the drivers that HOLD A SLOT, never for every driver: a driver parked on a paused semaphore can never proceed and has no child to reap."
    - "Signal handlers are process-wide state, so they are installed by the CLI entry point and not by `bootDaemon` — otherwise every integration test leaves another handler on a shared process."
key-files:
  created:
    - test/integration/07-lifecycle.test.ts
  modified:
    - src/cli/daemon.ts
    - src/cli/daemon-fixture.ts
    - src/cli/index.ts
    - src/ingress/registrar.ts
    - src/ingress/registrar.test.ts
    - src/orchestration/run-engine.ts
    - src/orchestration/recovery.ts
    - scripts/boot-smoke.ts
decisions:
  - "A clean stop REQUEUES `preparing` and `running`; `delivering` is deliberately left where it is. The plan's task-2 text said to leave every in-flight run's state in place, but recovery.ts's own docstring, 07-CONTEXT D-06 and the orchestrator all say a clean stop must transition — and without the transition every Ctrl-C costs a manual restart of every live run. Which runs move is asked of `canTransition(state,'queued')`, not written as a second list, and the domain table is what refuses `delivering`."
  - "Children are reaped through `engine.stop()` -> AbortController -> the supervisor's existing negated-pid escalation, NOT by a second `process.kill(-pid)` in daemon.ts. The escalation with its between-step liveness checks already exists, is tested for the SIGN of the pid, and carries T29's measurement in its docstring; a second copy in the composition root is the duplication that goes stale."
  - "`stop()` also sets a `stopping` flag that every driver checks before writing run state. Without it, aborting a live child makes `agent.run` return `cancelled`, the driver transitions the run to a terminal state and posts a terminal comment — so Ctrl-C would abandon every in-flight run and announce it in Linear."
  - "The registrar was moved onto the domain port and matches ownership by LABEL rather than by a self-assigned id. T22 pagination and T23 secret projection now live once, in LinearClientImpl; and a webhook re-made in the Linear UI no longer makes the reconciler create a second registration it then refuses to prune."
  - "`installSignalHandlers` is exported and called from `index.ts`, with an injectable `exit`. That is what let the smoke exercise the real signal path instead of calling `shutdown()` directly."
  - "Preflight gets the fifth injection slot (`runCommand`) rather than a `skipPreflight` boolean. A skipped preflight is a boot step whose failure messages have never once been seen."
metrics:
  duration: ~95min
  tasks: 3
  files: 9
  completed: 2026-09-06
---

# Phase 7 Plan 05: Ordered Boot and Reverse-Order Shutdown Summary

The daemon now starts in one defined order and stops in exactly that order backwards, with
both ends of the sequence proved by runtime probes rather than by comments — and a clean
stop is lossless, so 06-CONTEXT D-07's fail-on-`running` at boot finally means what it says
it means: an unclean exit.

## The shutdown step order, verbatim

Plan 06's gate and the human checklist both reference this list, so it is the contract:

| # | Step | Why it is here and not elsewhere |
|---|------|----------------------------------|
| 1 | `scheduler.pause()` | Nothing new is claimed. Parked waiters stay parked and are correct as-is. |
| 2 | `engine.stop()`, bounded at 30s | Aborts every live child, which runs the supervisor's escalation — SIGINT, SIGTERM, SIGKILL, each to the **negated** pid, liveness checked between steps. Also stops every driver writing run state, which is what makes step 6 possible at all. |
| 3 | `registrar.disable()`, bounded at 3s | The URL is about to stop answering; leaving the webhook enabled spends Linear's three retries on deliveries that cannot land. Best effort — returns `false`, never throws. |
| 4 | `tunnel.close()`, bounded at 5s | The public URL stops resolving **before** the thing behind it stops answering. |
| 5 | `server.close()` + `closeAllConnections()` | Releases the port. |
| 6 | mark in-flight runs | **Before** the store closes, which is the only reason this step is not earlier. |
| 7 | `store.close()` | Everything above may still need to read or write. |

Memoised, so `shutdown()` called twice returns the *same promise* — the precise form of "a
second handler must not double-signal a process group whose pid may have been reused",
since there is no second escalation to run. A second *signal* is a different thing and is
not swallowed: it exits `1` immediately.

## Boot, in order

`config/secrets/logger/db` → store → **preflight** → `viewer()` + every team's In Progress
state → scheduler (paused) → engine + questions → **boot recovery sweep** → stale-worktree
GC → webhook secret + `logger.registerSecret` → router → **bind** → **tunnel** → **webhook
reconcile** → **missed-work sweep** → **`scheduler.start()`**.

Only the last line makes it possible for anything to spawn a child process.

## The two orderings, and why neither is a comment any more

**Bind before tunnel (HOOK-01 / D-02).** Asserted from three sides now. The smoke's tunnel
stub TCP-connects to the port it is handed and rejects on `ECONNREFUSED`; the daemon itself
checks `server.listening` before entering `tunnel.open`, which is the half that also holds
for the real ngrok tunnel where nothing probes anything; and a naive source reorder does not
even compile, because `server` and `port` are block-scoped below.

**Tunnel before server on the way out.** This is new, and it is the mirror image:
`probingTunnel().close()` connects to the port it opened against and *fails if the
connection is refused*. Closing the server first means the last deliveries in flight take a
502 from a live public URL — the same failed delivery, and the same march toward Linear's
auto-disable, that the bind-before-tunnel rule exists to prevent, just at the other end of
the process's life.

## D-06: what a clean stop writes, and what it deliberately does not

`recovery.ts` has always documented the contract — "Phase 7's *clean* shutdown transitions
in-flight runs to `queued` **before** exiting, so that path stays lossless" — and until now
nothing implemented it. The plan's task-2 prose said the opposite (leave every state in
place and let the next boot's rules apply), which would have made every Ctrl-C cost a manual
re-assignment of every live ticket. The docstring, 07-CONTEXT D-06 and TRAPS T18/T26 agree
against it, so the docstring won.

What runs is asked of the domain, not decided in `daemon.ts`:

| state | in flight? (`holdsSlot`) | requeued? (`canTransition(s,'queued')`) | outcome |
|---|---|---|---|
| `queued` | no | — | untouched; already correct for the next boot |
| `preparing` | yes | yes | requeued, marked |
| `running` | yes | yes | **requeued, marked** — this is the write that narrows D-07 |
| `delivering` | yes | **no** | marked only; the next boot fails it with a diagnosis |
| `awaiting_answer` | no | — | untouched; its deadline is a column, so there is no timer to re-arm |

`delivering` is the one that stays. The transition table refuses `delivering → queued`, and
it refuses it for exactly the reason D-07 fails it at boot: a run that reached `delivering`
may already have pushed, and replaying it opens a second pull request for work that already
shipped (T-07-26, accepted). Reading the answer off `canTransition` rather than writing a
second list here is what keeps the two from drifting apart.

## T50 / R24, closed

`announceTerminal` was private to the run engine and reached only from its driver's
`finally` — and a boot-recovered run has no driver, its driver having died with the previous
process. So a recovered failure was correct in `runs` and in `run_events` and **said nothing
on the ticket**: the operator got a ticket stuck In Progress with no explanation, which is
the exact silence 06-CONTEXT D-08 exists to forbid.

It is now on the `RunEngine` interface and `recovery.ts`'s `failRecovered` calls it, after
the transition (the announcement reads the run's state to decide it is terminal at all) and
inside a `try` (Linear being down at boot must not abort the sweep and strand every run
behind this one).

## Deviations from Plan

**1. [Rule 1] `run.requested` had no live-run guard — two runs, two worktrees, two PRs.**
Found the moment the missed-work sweep went live: the smoke created two runs for one issue.
The sweep enqueues every bot-assigned open issue at boot; ingress enqueues on the assignment
webhook. Both are correct alone, and Linear retries a failed delivery for up to six hours —
so a delivery that could not land while the daemon was down arrives moments *after* the boot
sweep has already enqueued the same issue. `reconcile()` carried its own copy of the check
as an early-out; the webhook path had none. The guard now lives in the engine, where the two
producers meet.

**2. [Rule 1] Shutdown waited for drivers that could never finish.** Found by the new SIGINT
smoke check on its first run: Ctrl-C on an otherwise idle daemon burned the full 30-second
child-reap budget. `engine.settle()` waits for *every* driver, including one parked on
`scheduler.acquire` for a slot step 1 just stopped admitting — a driver that holds no child,
can never proceed, and whose run already sits at `queued`. `stop()` now resolves when the
**aborted** drivers have unwound, and a driver enters that map only after it has its slot.

**3. [Rule 3] The registrar spoke the raw `@linear/sdk` client, so the one boot step that
mutates workspace configuration could not run offline.** Rewritten over the domain port; its
8 tests rewritten against `FakeLinearClient`. Two traps left this file in the process: T22
(the mutate-and-return-`this` connection) and T23 (raw `Webhook` objects carry a live signing
secret) are both owned by `LinearClientImpl.listWebhooks` now, which pages with `pageAll` and
projects `secret` away at the only place raw webhooks exist. The pagination test moved with
them; what replaced it at this level is a prune test with three strays, which is the same
"act on the whole list once" property expressed where the list is now flat.

**4. [Rule 3, deliberate] Ownership matched by LABEL, not by a self-assigned id.** The domain
port does not expose the client-supplied `id` the old reconciler used, and it should not:
an operator who re-makes the webhook in the Linear UI leaves a persisted id matching nothing,
and id-matching then creates a second registration while the prune refuses to touch the first
— because the prune skips whatever id is live. There is a test for exactly that sequence.

**5. [Rule 2] The webhook signing secret was never registered with the logger.** It is
generated at *runtime*, so the logger — constructed at boot with the two `.env` secrets —
had never heard of it. `logger.registerSecret(secret)` at the point of generation. This is
the post-boot case 07-RUNTIME-EVIDENCE verified redaction handles, and nothing was calling it.

**6. [Rule 3] `BootOptions.runCommand`, the fifth injection slot.** It meets the seam rule
(`gh auth status` crosses the network, `git`/`claude` cross a process boundary) and it is the
alternative to a `skipPreflight` boolean, which would have made preflight the one boot step
whose failure messages had never been seen. It is the same `RunCommand` the worktree manager
and the deliverer already took.

**7. [Rule 3] Signal handlers are installed by `index.ts`, not by `bootDaemon`.** They are
process-wide state; a boot that installs them means every integration test that boots a
daemon leaves another handler behind on a process they all share, and the second test's
Ctrl-C shuts down the first test's daemon. `installSignalHandlers(handle, exit?)` is exported
with a remover, which is also what let the smoke exercise the real signal path.

## Falsification (T71)

Every check added here was shown to go red before being trusted, then reverted.

| deliberate break | result |
|---|---|
| close the server before the tunnel | `SMOKE FAILED — the tunnel closed while the server was still accepting`, and the stub's own message in the log: *"127.0.0.1:60824 already refuses connections when the tunnel was asked to close … The tunnel must close BEFORE the HTTP server"* |
| `markInFlight()` after `store.close()` | `TypeError` from `sqlite-store.ts:216` inside `markInFlight` — the write genuinely could not have happened |
| swap the bind and tunnel blocks | **`tsc` refuses it**: `server` and `port` used before declaration. Caught before the smoke runs. |
| `server.close()` immediately before `tunnel.open` (the runtime shape of the same bug) | `HOOK-01: refusing to open a tunnel — the receiver is not accepting connections` |
| `markInFlight` stops requeueing | `SMOKE FAILED — the in-flight run was requeued for the next boot (got running)` |
| preflight accepts any exit code, `gh` returns 1 | smoke **passes** — the guard is what carries it. Restored: `law start: gh is not usable. Fix: run 'gh auth login'` |
| second signal ignored instead of escalating | `SMOKE FAILED — a second signal escalates to an immediate exit (got [0])` |
| `SIGTERM` removed from the handler list | **the plan's grep still passes** — `SIGTERM` appears in prose in this file. The listener-count check catches it: `SMOKE FAILED — installSignalHandlers registered a handler for SIGINT AND for SIGTERM` |

That last row is the one worth carrying forward: the plan's `node -e` gate for
`SIGINT`/`SIGTERM` in `daemon.ts` is **vacuous**, and so is its process-group gate
(`/-\s*\w*[Pp]id/` matches the word "-pid" in a comment). Both pass; neither proves
anything. The real proofs are the smoke's listener count and the lifecycle test's grandchild
assertion.

## Known Stubs

| Stub | Where | Why | Owner |
|---|---|---|---|
| `test/integration/07-lifecycle.test.ts` has never been executed | that file | Instructed not to run `node --test`; plan 06 owns the gate. It typechecks and holds 8 cases. **T71 does not yet apply to it: none of its assertions has been shown to go red.** | **07-06** |
| `registrar.test.ts` was rewritten and never executed | that file | Same. | **07-06** |
| Nothing drives `engine.tick()` or a periodic reconciliation poll | `src/cli/daemon.ts` | The plan's boot list ends at `scheduler.start()`; no timer is in scope here. Consequence: an `awaiting_answer` question's deadline is only enforced at the next boot, and missed work is only swept at boot. `reconcile()` and `questions.sweep()` are both ready to be called on an interval. | later / 07-06 |
| `maxQuestionRounds` still unenforced (T44) | — | Not this plan's; unchanged. | 07-06 |
| Terminal notifications still report `costUsd: 0` / `tokensUsed: 0` | `src/cli/daemon.ts` | Unchanged from 07-04. WINDOWS #5. | later |
| The notifier's Linear comment channel is still not constructed | `src/cli/daemon.ts` | Unchanged from 07-04. WINDOWS #4. | Phase 5/6 redesign |
| The `runs.pid` column is still never written | `src/domain/fanout.ts` inserts `pid: null` | Shutdown reaps through the in-process `AbortController` map, so it does not need the column. After an **unclean** exit there is therefore no recorded pid for the operator to inspect. One `onSpawn` callback in the supervisor would fill it. | later |

## Threat Flags

None. Every file touched sits inside the threat model the plan declared. The two dispositions
worth restating: T-07-22 (webhook id and secret in one transaction) is implemented and tested;
T-07-26 (blind resume of an already-pushed run) remains **accepted** and is now enforced by
the transition table rather than by a convention.

## Verification

| check | result |
|---|---|
| `npx tsc --noEmit` | exit 0 |
| `grep -cE 'TS1005\|TS1128\|TS1002\|TS1109\|TS1434'` (T54 syntax mask) | 0 |
| `npm run smoke` | exit 0, **30** assertions (was 13) |
| smoke falsified against 8 deliberate breaks | 7 fail with the right diagnosis; the 8th (preflight) passes broken, which is the point of the guard |
| plan gate: bind precedes tunnel in source | `boot order ok` |
| plan gate: SIGINT/SIGTERM + process-group grep | `ok` — but see Falsification: both are vacuous |
| `grep -c 'test(' test/integration/07-lifecycle.test.ts` | 8 (plan requires ≥ 7) |
| `@ts-ignore` / `@ts-expect-error` / `: any` / `as any` / `as unknown as` added by this diff | 0 |

`node --test` was NOT run — plan 06 owns the first gate run.

## Self-Check: PASSED

- `test/integration/07-lifecycle.test.ts` present.
- Commits `93a7be2`, `b47b4b3`, `1b1f942`, `cbf6b8b`, `5862da7` present.
- `git status --short` clean before this summary.
