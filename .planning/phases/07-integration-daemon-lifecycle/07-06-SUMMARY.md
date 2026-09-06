---
phase: 07-integration-daemon-lifecycle
plan: 06
subsystem: testing
tags: [node-test, gate, dependency-injection, esm, sqlite-wal, process-groups, live-uat]

requires:
  - phase: 01-domain-contract-state-machine-schema
    provides: the canonical `verify` script, the nine-state table, the five-table migration
  - phase: 07-integration-daemon-lifecycle
    provides: 07-03's boot smoke, 07-04's wired engine, 07-05's ordered boot and reverse shutdown
provides:
  - "`npm run verify` extended to typecheck → assets → all unit AND integration tests → boot smoke, exiting 0"
  - "The milestone's first test execution: 449/56 → 513/513, with every failure fixed or named"
  - "Four real product bugs found and fixed — the escalation ladder's liveness check, shutdown's promise identity, T48's redaction cycle guard, and T75's never-verifiable WAL assertion"
  - "Dependency injection for the wizard's two host boundaries, replacing 22 impossible ESM namespace mocks"
  - "07-HUMAN-UAT.md — one consolidated live checklist absorbing 03-HUMAN-UAT and 08-HUMAN-UAT"
  - "07-GATE-REPORT.md — every one of the 56 failures triaged with its cause"
  - "T71/T76 discharged: five deliberate mutants proved 07-lifecycle, registrar.test and the boot smoke all go red"
affects: [08-setup-wizard-safety-pass, milestone-completion, any future phase adding a gate]

tech-stack:
  added: []
  patterns:
    - "Default-parameter injection at host boundaries (child processes, terminal prompts) — reusing the existing RunCommand port rather than inventing a second one"
    - "A build `assets` step so tsc's .ts-only emit stops silently dropping fixtures"
    - "Falsify every gate before trusting it: break the thing it guards, confirm red, revert"

key-files:
  created:
    - src/cli/wizard/deps.ts
    - .planning/phases/07-integration-daemon-lifecycle/07-GATE-REPORT.md
    - .planning/phases/07-integration-daemon-lifecycle/07-HUMAN-UAT.md
  modified:
    - package.json
    - src/execution/supervisor.ts
    - src/cli/daemon.ts
    - src/infra/logger.ts
    - src/cli/wizard/{preflight,repo-safety,mapping}.ts
    - src/domain/fakes.ts
    - test/integration/07-lifecycle.test.ts
    - test/integration/07-ingress-seam.test.ts
    - .planning/TRAPS.md

key-decisions:
  - "Dependency injection over `mock.module` for the 22 ESM-mock failures: `mock.module` is undefined on Node 22 without --experimental-test-module-mocks, and that flag would live in the canonical gate forever"
  - "Reused execute-run.ts's existing `RunCommand` port for the wizard rather than defining a second command-runner type"
  - "Inverted the sqlite-store round-trip assertion to match Phase 1's CHECK constraint rather than relaxing the schema — the constraint is the better contract"
  - "Split run-engine's `nothing moves a run out of failed` into automatic vs deliberate: D-13/OPS-04 forbids an automatic retry, but a re-assignment is the operator's only retry gesture and produces a new row, never a resurrection"
  - "Paused the scheduler in the ingress-seam fixture: that file is about ingress reaching persistence, and 07-run-path/07-lifecycle own what happens after `queued`"

patterns-established:
  - "A command double must distinguish probes from commands: `git show-ref --verify` exiting 0 means the branch EXISTS, so a blanket-success fake answers yes to everything (T79)"
  - "Assert on error codes and behaviour, never on prose — a wording gate goes red on a reword and green on a regression (T71/T76)"
  - "Build fixtures as real domain objects; 45 of this repo's 51 `as unknown as` are in test files, and that is where the drift hides (T74)"

metrics:
  duration: ~3h
  completed: 2026-09-06
  tests-before: "506 total · 449 pass · 56 fail · 1 hung file"
  tests-after: "513 total · 513 pass · 0 fail"
  commits: 9

status: complete
---

# Phase 7 Plan 06: The First Gate Run Summary

Ran the milestone's 513 tests for the first time — 35 plans across 8 phases had written them
and nothing had executed any of them — and took the gate from 56 failures to zero without
deleting a test, weakening an assertion, or adding a single type escape.

## What was built

**The canonical verify command now composes the real module graph.**

```
tsc && npm run assets && node --test "dist/**/*.test.js" && npm run smoke
```

07-CONTEXT D-04 is the point: the typecheck checks types and the unit suite instantiates
against fakes, and T53 already proved both can be green over a store that dies on first boot.
The smoke is the only step that can see a wiring break. One script, one name — split it in
three and two of them stop being run. `dist/**/*.test.js` reaches `test/integration/**`,
confirmed by execution rather than inspection.

**The gate is green.** `513 tests · 513 pass · 0 fail`, `tsc` exit 0, smoke PASSED,
`npm run verify` exit 0. Cost: ~75 seconds.

## The result that matters

**An 88% first-time pass rate on code written by ~20 agents in parallel with no test
execution** — and 52 of the 56 failures were *stale tests against correct implementations*,
exactly as `07-RUNTIME-EVIDENCE.md` predicted after verifying twelve subsystems by execution.

**Four were real product bugs, and three could only have been found by running something:**

1. **The escalation ladder checked the wrong thing.** `escalate()` asked `isAlive(pid)` — the
   process-group *leader*. A backgrounded grandchild is POSIX-*required* to ignore SIGINT, so
   the leader died, the check said "gone", and the ladder stopped at SIGINT and never
   escalated. That is precisely the T29/D-09 orphan the escalation exists to prevent, reached
   through the check meant to prevent it. Every other assertion in the reap test still passed.
   Now `isAlive(-pid)`: *is anything in the group alive*.

2. **`shutdown()` was `async`**, so it returned a fresh promise wrapping its own memo and
   `shutdown('a') !== shutdown('b')`. The behaviour was right and the contract unobservable —
   which means a later refactor could break idempotence with nothing able to notice. Dropped
   the keyword; the body was already an IIFE.

3. **T48 closed.** `redact()` had no cycle guard, so a circular payload overflowed the stack
   **in the log sink** — the one call every layer makes on every path. (`value.map(redact)`
   was also passing the array index as a second argument.) Filed by 02-02 as out of scope,
   fixed here.

4. **T75 closed, and it was worse than a failing test.** The WAL assertion ran against
   `:memory:`, where SQLite reports `journal_mode = 'memory'` by definition — so it *could not
   pass*, and OPS-02's WAL requirement had never been checked at all. Against a temp file it
   passes. **WAL is real.**

## Falsification — T71/T76 discharged

07-05 recorded that its own grep gates were vacuous: `SIGTERM` appears in a *comment* in
`daemon.ts`, so deleting the signal handler still passed. Neither `07-lifecycle.test.ts` nor
the rewritten `registrar.test.ts` had ever been shown to go red. Five deliberate mutants:

| mutant | gate | result |
|---|---|---|
| `escalate()` back to leader-only liveness | `07-lifecycle.test.ts` | **RED**, 2 cases, naming the grandchild by pid |
| SIGTERM handler deleted, the word left in three comments | boot smoke | **RED**, exit 1 — the grep gate would still have passed |
| `reconcile()` stops matching webhooks by label | `registrar.test.ts` | **RED**, 3 cases |
| D-02's unconditional `enabled: true` made conditional | `registrar.test.ts` | **RED**, 1 case |
| HOOK-09 prune scope widened past our own label | `registrar.test.ts` | **RED**, 1 case |

All reverted; `verify` re-run to exit 0.

## The 22-failure cluster, and why injection

Three wizard suites failed 22/22 with `Cannot redefine property: execa` / `: select`. An ESM
namespace binding is non-configurable **by specification** — that mock could never have
worked. `mock.module` is the other exit and is `undefined` on Node 22 without
`--experimental-test-module-mocks`, which would put an experimental flag in the canonical gate
forever.

New `src/cli/wizard/deps.ts` re-exports the **existing** `RunCommand` port from
`execute-run.ts` (already "run a child process, throw on non-zero", already the daemon's
`BootOptions.runCommand` seam) and adds a narrow `WizardPrompts`. Both arrive as default
parameters — the shape 03-01 already uses for the ngrok SDK — so **every production call site
in `wizard/index.ts` is untouched**.

## Deviations from Plan

All auto-fixed under Rules 1–3; none needed a decision.

**[Rule 1 — Bug] The escalation ladder's liveness check** · Task 2 · `supervisor.ts` · `7a6f2c5`
**[Rule 1 — Bug] `shutdown()` returned a fresh promise, not its memo** · Task 2 · `daemon.ts` · `7a6f2c5`
**[Rule 2 — Missing critical] T48 redaction cycle guard** · Task 2 · `logger.ts` · `dac7330`
**[Rule 3 — Blocking] `tsc` never copied `stream-events.jsonl` to `dist/`** · Task 2 · `package.json` · `8386358`
  Four failures across two suites; added an `assets` step so the next fixture is covered too.
**[Rule 3 — Blocking] `node_modules` symlinked from the main checkout** so the worktree could run at all; removed before finishing.

Two judgment calls are written up in full in `07-GATE-REPORT.md`: inverting the sqlite-store
round-trip assertion to match Phase 1's CHECK constraint, and splitting run-engine's
`nothing moves a run out of failed` into automatic versus deliberate.

## Known Stubs

None introduced. **Six carried forward**, each named in `07-GATE-REPORT.md` §Deferred with the
requirement it touches and recorded in `.planning/WINDOWS.md`:

| # | stub | requirement |
|---|---|---|
| **T72** | The notifier's Linear channel is deliberately unwired — the run engine already posts every Linear comment, better; wiring both double-posts every milestone. **Architectural, recorded not fixed.** | NOTF-01 |
| **T73** | `partial` is unreachable from a live run: the engine trusts the agent's self-reported `status`, while `execute-run.ts`'s evidence-based verdict is built and off the live path. **Architectural, recorded not fixed. Highest-value follow-up after this milestone.** | AGNT-08 |
| D4 | Nothing drives a periodic `questions.sweep()` or reconciliation poll — a deadline is only enforced at the next boot. | QA-05 |
| D5 | `maxQuestionRounds` unenforced (T44). | QA-06 |
| D6 | Terminal notifications report `costUsd: 0` / `tokensUsed: 0`. | NOTF-04 |
| D7 | `runs.pid` is never written, so an unclean exit leaves no pid to inspect. | OPS-01 |

**ROADMAP criteria 1 and 5 are UNVERIFIED** pending `07-HUMAN-UAT.md`. Criteria 2, 3 and 4 are
covered automatically by the gate. The roadmap already records 1 and 5 as live-gated, and no
plan task blocked on them.

## Threat Flags

None. No new network endpoint, auth path, file-access pattern or schema change. The security
posture moved in one direction only: `as any` 11 → 3, `: any` 8 → 5, `@ts-ignore` and
`@ts-expect-error` still **0**, `as unknown as` flat at 51, no test deleted, and OPS-02's WAL
requirement verified for the first time.

## New TRAPS rows

T79–T84. The recurring one is **T79**: a fake command runner that answers exit 0 to everything
answers *"yes"* to every `git show-ref` probe. **Three separate files shipped that bug
independently**, and in all three the symptom appeared 50 branch names away from the fixture
that caused it.

## Verification

| check | result |
|---|---|
| `npm run verify` | **exit 0** |
| tests | **513 / 513** (from 449 / 56 + 1 hung file) |
| `tsc --noEmit` | exit 0 |
| T54 syntax mask (`TS1005\|TS1128\|TS1002\|TS1109\|TS1434`) | 0 |
| boot smoke | PASSED, 30 assertions |
| test files deleted this phase | **0** |
| `@ts-ignore` / `@ts-expect-error` | 0 / 0 (unchanged) |
| `as any` / `: any` / `as unknown as` | 3 / 5 / 51 (from 11 / 8 / 51) |
| gates falsified | 5 mutants, all red, all reverted |

## Self-Check: PASSED

- `.planning/phases/07-integration-daemon-lifecycle/07-GATE-REPORT.md` — present
- `.planning/phases/07-integration-daemon-lifecycle/07-HUMAN-UAT.md` — present
- `src/cli/wizard/deps.ts` — present
- Commits `52e6e8d`, `7a6f2c5`, `fb8c10b`, `1adc2b9`, `dac7330`, `8386358`, `e997842`,
  `f26acf6`, `b34e0a3` — all present on `gsd/07-06`
- `git status --short` clean apart from the `node_modules` symlink, removed before finishing
