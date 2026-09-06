# 07-GATE-REPORT — the milestone's first test execution

Thirty-five plans across eight phases wrote **513 tests** and none of them had ever been run.
This is what happened when they were.

```
BEFORE   tests 506 · pass 449 · fail 56 · cancelled 1 (a hung file)
AFTER    tests 513 · pass 513 · fail 0
         tsc exit 0 · boot smoke PASSED · npm run verify exit 0
```

**Nothing was deleted to get here.** No test file was removed, no assertion was relaxed to
fit a broken implementation, and the type-escape counts went *down*:

| escape | at plan start | now |
|---|---|---|
| `@ts-ignore` | 0 | **0** |
| `@ts-expect-error` | 0 | **0** |
| `as any` | 11 | **3** |
| `: any` | 8 | **5** |
| `as unknown as` | 51 | 51 |

## Headline: an 88% first-time pass rate, and 4 of the 56 were real product bugs

Fifty-two of the fifty-six failures were **stale tests or stale fixtures against correct
implementations** — which is what 07-RUNTIME-EVIDENCE.md predicted, having verified twelve
subsystems by execution before this plan started. Four were genuine defects in shipped code,
and three of those four could only ever have been found by *running* something:

| # | defect | how it would have shown up in production |
|---|---|---|
| 1 | **The escalation ladder checked the wrong liveness.** `escalate()` asked `isAlive(pid)` — the group LEADER. A backgrounded grandchild is POSIX-required to ignore SIGINT, so the leader died, the check said "gone", the ladder stopped at SIGINT and never escalated. | The exact T29/D-09 failure the escalation exists to prevent: an orphaned `claude` subtree surviving the daemon, holding the stdout pipe, accumulating across a week and eating the RAM the concurrency cap is meant to bound. Every other assertion in the reap test still passed. |
| 2 | **`shutdown()` was `async`, so it returned a fresh promise wrapping its own memo.** `shutdown('a') !== shutdown('b')`. | Benign today (only one body ever runs), but the idempotence contract was unobservable from outside — and it is the contract a SIGTERM arriving behind a SIGINT depends on. |
| 3 | **T48: `redact()` had no cycle guard** and `value.map(redact)` passed the array index as a second argument. | A circular payload overflows the stack **in the log sink** — the one call every layer makes on every path. Filed by 02-02 as a known gap; closed here. |
| 4 | **T75: OPS-02's WAL requirement had never actually been verified.** The assertion ran against `:memory:`, where SQLite reports `journal_mode = 'memory'` by definition. | The test could not pass, so the requirement was never checked. It now runs against a temp file — **and it passes. WAL is real.** |

## Priority 1 — boot smoke

Green on the first run and every run since. No wiring break to fix. It is also the only step
that catches a whole class of defect: see the falsification section, where deleting the
SIGTERM handler is caught here and nowhere else.

## Priority 2 — integration tests (10 failures + 1 hung file)

`07-run-path.test.ts` (7 cases) passed on the first run. The other two files had never
executed at all.

### `07-lifecycle.test.ts` — 3 failures, then a 180s hang

One fixture bug hid two real ones.

The fixture's `okTools` returned `{exitCode: 0}` for *everything*, on the belief that
`runCommand` is preflight-only. It is not — `BootOptions.runCommand` also reaches the
worktree manager, where `git show-ref --verify refs/heads/<b>` exiting 0 means **the branch
already exists**. Every candidate read as taken, `prepareWorktree` died after 50 suffixes,
and no agent was ever spawned — so the three process-group cases timed out waiting for a
grandchild that could not exist, and the orphaned `sleep 600` processes then kept the test
process alive forever. `git` now runs for real against the fixture's real repository, which
is what the file's own rule 3 already said.

With that fixed, defects 1 and 2 above surfaced. All 8 cases pass.

### `07-ingress-seam.test.ts` — 7 failures, one cause

`smokeIssue()` defaults to bot-assigned, and boot's missed-work sweep lists exactly the
bot-assigned open issues and enqueues them. So a run existed before any delivery arrived,
and "no run was written" could not be told from "the sweep wrote one". 07-05's
`scheduler.start()` then drove that run out of `queued`, which is where every assertion in
the file reads.

Fixed on the fixture side, in the order reality has: seed the issue **unassigned**, boot,
pause the driver (this file is about ingress reaching persistence — `07-run-path` and
`07-lifecycle` own what happens after `queued`), then assign. `FakeLinearClient` gained
`putIssue()` because assignment is an event in time and no fixture could express it.

## Priority 3 — unit failures where the test was right (4)

Defects 1–4 above, plus the two blind-probe fixtures below. All fixed in `src/`.

## Priority 4 — unit failures where the test encoded a superseded expectation (42)

Each one has its reason recorded, per the plan's instruction that a test rewritten to match
broken code is worse than a failing test.

| n | cluster | why the test was wrong |
|---|---|---|
| 22 | wizard: preflight, repo-safety, mapping | `mock.method` on an ESM namespace binding — **non-configurable by specification**, so it could never have worked. Replaced with default-parameter injection, the shape 03-01 already uses for the ngrok SDK. Production call sites unchanged. `mock.module` was rejected: it is `undefined` on Node 22 without `--experimental-test-module-mocks`, which would put an experimental flag in the canonical gate forever. |
| 7 | `scheduler` | Fixtures built as `({id, state}) as unknown as Run` with no `kind`, so `syncFromStore` skipped every one of them — it skips non-`repo` runs by construction (D-04). And `configWith` nested `concurrency` under `defaults`, where `Config` puts it at top level. **This is TRAPS T74 in full: the cast bought convenience and paid in silent drift.** |
| 4 | `event-router`, `stream-parser` | Not a test bug at all — a missing **build** step. `tsc` emits `.ts` only, so `src/execution/fixtures/stream-events.jsonl` never reached `dist/`. Added an `assets` script (`fs.cpSync` with a `!.ts` filter, so the next fixture is covered too) and wired it into `build`, `test` and `verify`. |
| 3 | `execute-run` | Same blind-probe bug as the lifecycle fixture: the fake's `ok('')` fallthrough answered exit 0 to `git show-ref`, so all 50 suffixes read as taken and `prepareWorktree` threw before any of the three cases ran. **Third instance of this exact shape this milestone.** |
| 3 | `questions` | Stale vocabulary: the toggle is `questionsEnabled` (not `questionFlow`) and the terminal status is `timed_out` (not `expired`) — both fixed by `domain/types.ts` and the migration's CHECK constraint. One of these cases had been *passing for the wrong reason*, because a toggle that does not exist reads as undefined. |
| 5 | `run-engine` | Same `concurrency` nesting bug (3 cases). Plus: the fake threw from `createComment` **without recording the attempt**, and the worktree spy refuses to run until it sees `comment.create` — so "Linear is down" failed the run as "worktree reached before the acknowledgement sequence". The run died of the fixture. Plus the `failed`-run case below. |
| 1 | `fanout` | `runsOf()` was built from `listByState`, which structurally cannot return the stateless ticket parent — D-12 gives it no state, which is the entire point of the row. Parents are now recovered via the children's `parentRunId`. |
| 1 | `supervisor` | Two problems in one case. The rejection handler was attached **after** the push that causes it, and `push()` ends on a `setImmediate`, so Node reported an `unhandledRejection` carrying the very error the case was asserting on. And the assertion matched the prose `/GSD skills absent/` against a message that has read "GSD skills missing from the spawned session" since plan 04 — replaced with the `LawError` code `AGENT_ENV` plus the named missing skill. **T71/T76: assert behaviour, not text.** |
| 1 | `linear-client` (T49) | **Not a wiring gap.** `noteSelfWrite` is registered at `linear-client.ts:295`, exactly where the code comment says. The suppression map is module-level with a 90-second window, and three earlier cases in the same file had already stamped `Issue:issue-1` — so the case's own falsification line read `true`. Gave it a distinct issue id. |
| 1 | `sqlite-store` round-trip | Asserted "any string round-trips, the store performs no validation". Phase 1's migration carries a `CHECK` constraint on the nine states. **Inverted the assertion rather than relaxing the schema** — the constraint is the better contract, and the store still applies no *transition-legality* check, which is what the case was really about. |

### The one judgment call worth reading twice

`run-engine`'s **"nothing moves a run out of failed"** listed `run.requested` among the levers
that may not restart a failed run, then asserted one diagnosis while producing two.

The engine's guard is `findActiveRunByIssue`, which is about not running two sessions on one
ticket **at once** — a terminal row is not a live one. D-13/OPS-04 says the daemon never
*automatically* retries a failed run, and it does not. But a deliberate re-assignment is the
operator's only retry gesture, and the guard against a restart loop is the reconciliation
watermark, not this check.

Split into two properties: nothing **automatic** revives a failed run (the original OPS-04
assertion, intact), and a deliberate re-request produces a **new row**, never a resurrection
of the old one. Renamed to `nothing AUTOMATIC moves a run out of failed` so the file does not
claim more than it proves.

## Falsification (T71/T76) — every gate this plan relied on was broken on purpose first

07-05 recorded that its own grep gates were vacuous: `SIGTERM` appears in a *comment* in
`daemon.ts`, so deleting the signal handler still passed. Neither `07-lifecycle.test.ts` nor
the rewritten `registrar.test.ts` had ever been shown to go red. Discharged here.

| mutant | gate | result |
|---|---|---|
| `escalate()` reverted to `isAlive(pid)` (leader-only) | `07-lifecycle.test.ts` | **RED**, 2 cases, both naming the grandchild by pid |
| `signals = ['SIGINT']` — SIGTERM handler deleted, the word still present in three comments | boot smoke | **RED**, exit 1: `installSignalHandlers registered a handler for SIGINT AND for SIGTERM`. The grep gate 07-05 flagged would still have passed. |
| `reconcile()` stops matching webhooks by label | `registrar.test.ts` | **RED**, 3 cases |
| D-02's unconditional `enabled: true` becomes `enabled: keep.enabled` | `registrar.test.ts` | **RED**, 1 case |
| HOOK-09 prune scope widened past our own label and URL shape | `registrar.test.ts` | **RED**, 1 case |

All five reverted; `npm run verify` re-run to exit 0 afterwards.

## The canonical verify command

```
tsc && npm run assets && node --test "dist/**/*.test.js" && npm run smoke
```

07-CONTEXT D-04: the smoke is the only step that can see a wiring break — the typecheck
checks types and the unit suite instantiates against fakes, and T53 proved both can be green
over a store that dies on first boot. Kept as **one** script under **one** name, because
splitting it into three means two of them stop being run.

`dist/**/*.test.js` already reaches `test/integration/**` — 07-03 put `test` in tsconfig's
`include` for exactly this reason, and it is confirmed by execution here, not by inspection.

**Cost:** ~75 seconds, of which ~45s is three lifecycle cases waiting out `SIGINT_GRACE_MS`
against a fixture that is POSIX-required to ignore SIGINT. That is the honest price of
proving the escalation actually escalates.

## Deferred — named, with the requirement each one touches

Nothing here blocks the phase. Each is a documented degradation rather than an invisible one.

| # | deferred | requirement | why not now |
|---|---|---|---|
| D1 | **ROADMAP criteria 1 and 5 are unverified.** | the core value; QA-04 | Both need a real Linear workspace, a live ngrok tunnel and real `gh`. Procedure written in `07-HUMAN-UAT.md`. The roadmap already records them as live-gated. |
| D2 | **T72 — the Linear notification channel is deliberately unwired.** | NOTF-01 | The run engine already posts every Linear comment, with edit-in-place queue positions, threaded question ids and multi-repo rollups the channel does not have. Wiring both double-posts every milestone, and each bot comment is then an event the four loop guards must filter. Consolidating is a Phase 5/6 redesign. The **log** channel — the half the engine does not do — is wired and structurally unremovable. |
| D3 | **T73 — `partial` is unreachable from a live run.** | AGNT-08 | Two verdict designs exist: the engine trusts the agent's self-reported `status`, while `execute-run.ts` judges by commits present in the worktree. Only the engine's is wired, and research is emphatic that trusting a self-report is this project's most likely silent failure. Reconciling needs `partial` on `AgentResult` plus a draft flag on the `Deliverer` port — architectural. **Highest-value follow-up after this milestone.** |
| D4 | **Nothing drives a periodic `questions.sweep()` or reconciliation poll.** | QA-05 | Carried from 07-05. A question's deadline is only enforced at the next boot, and missed work only swept at boot. Both functions are ready to be called on an interval; no timer is in any plan's scope. |
| D5 | `maxQuestionRounds` is still unenforced (T44). | QA-06 | Carried from 07-05, unchanged. |
| D6 | Terminal notifications report `costUsd: 0` / `tokensUsed: 0`. | NOTF-04 | Carried from 07-04. WINDOWS #5. |
| D7 | The `runs.pid` column is never written. | OPS-01 | Shutdown reaps through the in-process `AbortController` map and does not need it. After an **unclean** exit there is no recorded pid for the operator to inspect. One `onSpawn` callback in the supervisor would fill it. |
| D8 | 45 seconds of the gate is spent waiting out SIGINT grace. | — | Shortening the ladder would cost the resumable-session property SIGINT buys (04-CONTEXT D-10). Not worth trading correctness for gate speed. |

## New TRAPS rows

T79–T84, appended to `.planning/TRAPS.md`. The recurring one is **T79**: a fake command
runner that answers exit 0 to everything answers *"yes"* to every `git show-ref` probe. Three
separate files shipped that bug independently, and in all three the symptom was
`prepareWorktree` dying 50 branch names later — nowhere near the fixture that caused it.
