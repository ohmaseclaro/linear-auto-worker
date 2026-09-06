---
phase: 07-integration-daemon-lifecycle
plan: 02
subsystem: domain-contract-reconciliation
tags: [contract, typecheck, integration-debt, domain, reconciliation]
status: complete
requires:
  - "07-01: installed dependency set and the 68-error triage"
provides:
  - "src/domain/ reconciled — one definition of every shared name across six layers"
  - "npx tsc --noEmit exits 0 over the whole tree, from 68 errors"
  - "07-CONTRACT-RECONCILIATION.md — 26 requests dispositioned ADD/MAP/REJECT"
  - "DomainEvent split into IngressEvent | EngineEvent, making T45's silent hole a compile error"
affects:
  - "07-03 (must now write the ingress→engine mapping; it no longer compiles without one)"
  - "07-04 (meets the outbound LinearClient/port divergence at its own seam)"
  - "07-05 (owns R24: a boot-swept run posts nothing on its ticket)"
  - "07-06 (T53 column drift and the first node --test run are still owed)"
tech-stack:
  added: []
  patterns:
    - "Union split as a forcing function: two vocabularies that must not be confused are two types, not one union with a mapping nobody wrote"
    - "Narrow on run.kind at the call site; never widen RunState and never give TicketRun a state column"
    - "A port method lands with its fake AND its real implementation, or it is a trap wearing a contract's clothes"
key-files:
  created:
    - .planning/phases/07-integration-daemon-lifecycle/07-CONTRACT-RECONCILIATION.md
  modified:
    - src/domain/ports.ts
    - src/domain/types.ts
    - src/domain/agent-result.ts
    - src/domain/fakes.ts
    - src/infra/config.ts
    - src/infra/store/migrations/001-init.ts
    - src/ingress/receiver.ts
    - src/ingress/registrar.ts
    - src/orchestration/run-engine.ts
    - src/orchestration/questions.ts
    - src/orchestration/fanout.ts
    - src/outbound/linear-client.ts
decisions:
  - "DomainEvent split into IngressEvent | EngineEvent rather than left as one union — handing an ingress event to the engine is now a compile error, not a silent no-op"
  - "S1/S3 fixed by narrowing on run.kind at 14 call sites; RunState not widened, TicketRun given no state column (D-04 / DELV-07)"
  - "listRunsByParent MAPPED to the existing childRuns rather than added — a second name for one query is the drift this plan removes"
  - "Config.operatorUserId landed optional with a skip-and-warn, because the daemon authenticates as the bot and nothing can write it yet"
  - "AgentResultSchema field renamed assumptionIfUnanswered → assumption (T64); the domain's status vocabulary wins (T58)"
  - "The outbound LinearClient facade was NOT widened to fit the port — four of the five differences are 07-04's design decisions and are named, not papered over"
metrics:
  duration: ~75min
  tasks: 3
  files: 32
  completed: 2026-09-06
---

# Phase 7 Plan 02: Contract Reconciliation and a Clean Typecheck Summary

Six phases' worth of accumulated contract debt folded into `src/domain/`, and
`npx tsc --noEmit` taken from **68 errors to 0** with **zero suppression comments** and six
*fewer* type escapes than it started with.

## The count

| | |
|---|---|
| Starting errors | **68** |
| Ending errors | **0**, exit 0 |
| T54 syntax-mask check | `grep -cE 'TS1005\|TS1128\|TS1002\|TS1109\|TS1434'` → **0**. Run before trusting the count, because a syntax error aborts parsing and suppresses everything downstream — it once made 56 errors look like 3 |
| `@ts-ignore` / `@ts-expect-error` | **0 / 0** — unchanged |
| `as unknown as` | **56 → 50** |
| `as any` / `: any` | **11 / 7** — unchanged (both trees measured with the same `git grep -o`; the baseline file's "10" for `as any` was 11 on the untouched tree too) |
| Non-null assertions | **81 → 79** |

Nothing was silenced. The six removed `as unknown as` are the three casts in
`src/infra/config.ts` that survived zod validation (07-CONTEXT **P11**'s third item — if a
validated schema's output still needs a cast, the schema and the type have diverged) plus
three test fixtures rebuilt as real `Config` values.

**Scope note:** this plan took all 68, not the 25 the inventory assigned it. 07-03 builds
`daemon.ts` and the boot smoke, and neither runs on a tree with 43 type errors. The clusters
were still worked as classified.

## The three things 07-01 said not to lose

**1. The union was not flattened.** S1+S3's 19 errors were the domain being right and the
consumers being wrong. `RunState` was not widened and `TicketRun` was given no state column.
Instead one `repoRun(runId)` helper in `run-engine.ts` does the narrowing, and `transition`,
`cancel`, `finishCancel`, `announceTerminal`, `diagnosis`, `terminalText`, `rollupLine`,
`repoOf`, `worktreeOf` and `spawnRequest` all take `RepoRun`. `recovery.ts` and
`scheduler.ts` skip ticket parents explicitly. A parent's status stays derived from its
children, which is the only thing stopping one repo's failure from discarding another repo's
already-shipped pull request (DELV-07). The narrowing also deleted eight non-null assertions
as a side effect — `run.repoSlug!` becomes `run.repoSlug` once the type says so.

`fanout.ts`'s local `ParentRun = Omit<Run,'state'> & {state: null}` is **deleted**, not
patched: `Omit` over a union collapses to the keys common to both arms, so it silently lost
`prUrl`/`failureReason` and was assignable to neither arm. `TicketRun` already was exactly
this type.

**2. The `tryInsertDelivery` alias is deleted.** Not renamed around. `ports.ts` now declares
`recordDelivery(deliveryId, receivedAt)` — the name `sqlite-store.ts:260` actually
implements — `receiver.ts:201` passes two arguments, and `fakes.ts` carries one method. This
was a **runtime `TypeError` on the very first webhook delivery** that compiled clean for six
phases because the fake was more permissive than the real store. The two ingress test doubles
that also spelled the dead names (`receiver.test.ts`, `registrar.test.ts`) were fixed too.

**3. `config.ts:69`'s one error was hiding four.** The zod schema is rewritten onto the
domain's names — `slackNotify`→`notifySlack`, `questionFlowEnabled`→`questionsEnabled`,
`maxRunTimeMs`→`maxRunMs`, mappings from an array to a `Record`, plus the eight top-level
fields it never validated at all — and all three casts are gone. `src/cli/wizard/config-writer.ts`
writes this shape; the loader now actually reads it.

## The M7 decision, settled with hard deliverable #1

T67 said `run.resumed` and the ingress→engine mapping are one decision. Both moved:

- `run.resumed` is in the union **and handled** in `run-engine.ts`, routed through the same
  resume path as an answer with a null question id. QA-07's disabled-question-flow branch has
  no question row by construction, so it cannot key off `question.answered`.
- The union is **split**: `EventRouter.route` returns `IngressEvent | null`,
  `RunEngine.handle` takes `EngineEvent`, and they are not assignable.
  `engine.handle(await router.route(d))` — the daemon that boots green, verifies green and
  processes nothing — **is now a compile error at the composition root.** The five-case
  mapping table is written on the doc comment in `ports.ts`.

`null` rather than an eighth ingress kind for "nothing to do": `ignored` is an *engine*
vocabulary word, and ingress reports what Linear did, not what the daemon should do.

07-03 still writes the mapping. What changed is that it can no longer be skipped silently,
which is the only half of T45 a contract can own.

## Also settled

- **`kvPut` → `kvSet`** at all 10 call sites (T46, hard deliverable #6).
- **`assumptionIfUnanswered` → `assumption`** (T64). `verdict.ts:95` read
  `structured.assumption` while the schema said `assumptionIfUnanswered`, and
  `additionalProperties: false` forbids anything not listed — so the agent *physically could
  not return its assumption* and every timed-out question posted nothing. Renamed across the
  schema, the type, the parser and 17 call sites; the name-bridging in `validateNeedsInput`
  is gone.
- **The `AgentResult` contest (T58) had no loser to delete.** `src/execution/agent-args.ts`
  re-exports `AgentResultSchema` and defines nothing — it was already an alias, not a second
  copy. The stale CONTESTED comments there and in `verdict.ts` are replaced with what was
  decided.
- **`QuestionsDeps.linear` is wired** at all three call sites, discharging hard deliverable
  #3 (T43): without it `openQuestion` never posts its comment, tier-1 correlation is dead,
  and the tier-2 fallback hides that on every single-question ticket.
- **`answeredBy` landed with its column.** A domain field with no SQL column is a value that
  silently vanishes on write, so `questions.answered_by` went into `001-init.ts` in the same
  edit.

## Deviations from Plan

**1. [Rule 3] Took all 68 errors, not the 25 assigned.** Task 3 of this plan demands
`tsc --noEmit` exit 0 over the entire tree, which is only satisfiable by fixing every
cluster. The 07-01 hand-off table's 43-error split for 07-03 is superseded by this plan's own
task text; 07-03 builds the daemon and cannot boot-smoke a tree that does not compile.

**2. [Rule 2] `run.resumed` was handled, not just declared.** The plan asked for a contract
decision. Adding the kind and leaving `run-engine.ts`'s `default:` arm to swallow it would
have reproduced T45 inside the module that T45 is about. Two lines.

**3. [Rule 2] `questions.answered_by` column and `Config.operatorUserId`'s skip-and-warn.**
Both are the "do not leave it half-present" rule applied: a field with no column, and a
required field nothing writes, are each a silent `undefined` at runtime.

**4. [Rule 3, scoped] `updatedAt` projected on the real Linear client.** R5 added
`LinearIssue.updatedAt` to the port; leaving the facade without it would have been the
`tryInsertDelivery` trap freshly recreated. Verified first that `Issue.updatedAt` is a `Date`
on `@linear/sdk` 93.0.1 by compiling a probe against the installed `.d.mts`, rather than
assuming the API returns it.

## Known Stubs / Deferred

Both recorded in `.planning/WINDOWS.md` (entries 2 and 3).

| Item | Where | Why deferred | Owner |
|---|---|---|---|
| `Config.operatorUserId` is optional and **nothing writes it** | `src/domain/types.ts`, `run-engine.ts` `acknowledge()` | The daemon authenticates as the BOT, so the wizard's `viewer()` returns the bot, not the operator. The INTK-03 subscribe is **skipped with a warn** rather than sent `undefined`. Needs a wizard prompt. | 07-CONTEXT **P8** |
| `src/outbound/linear-client.ts` declares its own `LinearClient`/`LinearIssue` that do not match the port | that file, now with the five differences listed at the interface | `updateComment`/`addSubscriber`/`listComments` are unimplemented, `setIssueState` has a different arity and state vocabulary (INTK-04 is a real decision, not a rename), `createWebhook` returns no secret — where the **facade is right and the port is wrong** (landmine #3) — and `teamId` nullability differs. Passing `LinearClientImpl` where the port is expected does not compile, so this surfaces at exactly the seam that decides it. | **07-04** |

## Rejected requests — plan 03 and beyond need to know

Three requests were refused, and one layer still wants something it did not get:

- **R23 `AgentEnvironmentError`** (04-01, 04-04) — rejected as unnecessary. Nothing catches
  it by class; every consumer branches on `LawError`'s code. Re-request when something
  catches it.
- **R24 expose `RunEngine.fail` / `announceTerminal`** (06-04) — **deferred to 07-05, not
  refused on merit.** The need is real: a run failed by the boot sweep writes the database
  and `run_events` correctly but **posts nothing on the ticket**, so the operator sees a
  ticket stuck In Progress with no explanation. That is a boot-lifecycle decision and 07-05
  owns boot. Widening the engine's public surface ahead of its caller is the wrong order.
- **R25 `displayName` / `MappingKey.teamId` / `remoteName`** (08-05) — rejected. Cosmetic or
  entirely unconsumed.
- **R26 move the `ack:`/`cancel:`/`terminal:` kv keys to `runs` columns** (06-02) — rejected;
  kv costs no migration and 06-02 offered it as the preferred option anyway.

## Still owed, and invisible to a green typecheck

Reading 68 → 0 as "done" would be the mistake this section exists to prevent:

1. **T53 — `sqlite-store.ts` vs `001-init.ts` column drift.** Four divergences that
   TypeScript structurally cannot see, because it does not know SQL column names. Only a real
   store round-trip catches them. **07-06's gate.**
2. **T45's remaining half — writing the ingress→engine mapping.** The contract half is
   closed; the wiring is **07-03's**.
3. **The first `node --test` run has still never happened.** 32 of the original 68 errors were
   in test files, so those tests have never executed. Expect the gate to be loud — T48 already
   names `logger.test.ts`'s cycle guard as a known failure.

## Self-Check: PASSED

- `npx tsc --noEmit` → exit 0, 0 errors, 0 syntax-mask codes.
- `.planning/phases/07-integration-daemon-lifecycle/07-CONTRACT-RECONCILIATION.md` exists,
  20 dispositioned rows.
- `grep -rnE "from ['\"]\.\./(infra|ingress|orchestration|execution|outbound|cli)" src/domain/`
  → no upward imports.
- No local `RunState` union, table-name constant or duplicate marker prefix anywhere outside
  `src/domain/` (`grep` over all six layers → 0).
- `--permission-mode dontAsk`, the `--verbose`/`stream-json` pairing and the `--bare`
  prohibition comment all still present in `agent-args.ts`; the 429 dead-code comment still
  in `rate-limit.ts`; `HOLDS_SLOT` still excludes `awaiting_answer`.
- All six commits present: `584d365`, `8befc51`, `a2ef601`, `c0f9d07`, `eb1cb17`, `5be9299`.
