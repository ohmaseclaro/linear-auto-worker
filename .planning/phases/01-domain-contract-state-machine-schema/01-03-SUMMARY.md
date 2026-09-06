---
phase: 01-domain-contract-state-machine-schema
plan: 03
subsystem: domain
tags: [fakes, testing, ports]
requires: [01-02]
provides:
  - src/domain/fakes.ts (14 in-memory fakes, one per port in ports.ts)
  - src/domain/fakes.test.ts (constructibility + one-behaviour-each smoke test)
affects: [02, 03, 04, 05, 06]
tech-stack:
  added: []
  patterns:
    - "insertion-order arrays alongside id-keyed Maps, so queue/question reads mirror ORDER BY"
    - "snapshot-and-restore transactions (cheap enough at unit-test data volume)"
    - "AbortSignal handled as an outcome (cancelled), never a throw, via a queueMicrotask pending window instead of a timer"
    - "idempotent fakes where the real port documents idempotency (Deliverer, WebhookRegistrar) — a fake that double-acts hides the bug it exists to surface"
key-files:
  created:
    - src/domain/fakes.ts
    - src/domain/fakes.test.ts
decisions:
  - "InMemoryStore exposes both `tryInsertDelivery` (ports.ts's declared Store method) and `recordDelivery` (TRAPS T46's settled name, matching what sqlite-store.ts actually implements) as aliases of the same logic, rather than picking one and failing to compile against whichever ports.ts says at merge time"
  - "findActiveRunByIssue treats every TicketRun as active (its status is derived from children, never itself terminal — D-04) and filters RepoRun by isTerminal(state), so a tenth RunState cannot silently escape the filter"
  - "FakeScheduler is a real counting semaphore (queue of pending grants), not a boolean gate, because Phase 6's slot-leak test needs a doubled release to provably not hand out a phantom slot"
  - "FakeAgentRunner's pending window is one queueMicrotask tick, not a setTimeout — satisfies the naming_contract's 'nothing here touches a timer' while still giving a synchronous controller.abort() something real to race"
  - "FakeLinearClient.getIssue returns Promise.reject(...) on a miss rather than throwing synchronously, so both `await` and `.then/.catch` callers see the same LinearApiError"
metrics:
  duration: ~30m
  completed: 2026-09-06
status: complete
---

# Phase 1 Plan 03: In-Memory Fakes Summary

One in-memory fake for every one of the 21 interfaces in `ports.ts` (14 of them get their
own class; the other 7 — `WebhookDelivery`, `DomainEvent`, `Worktree`, `AgentSpawnRequest`,
`PullRequest`, `LinearIssue`, `RunEvent` — are plain data shapes with no behavior to fake, so
they are used directly as literals in the fakes and the test). Nothing touches the
filesystem, network, a child process, or a timer. This is the artifact Phases 2-6 build and
unit-test against with no sibling layer in existence.

## What Was Built

| File | Contents |
|------|----------|
| `src/domain/fakes.ts` | 14 classes: `InMemoryStore`, `FakeConfigLoader`, `RecordingLogger` (L0); `FakeTunnel`, `FakeWebhookRegistrar`, `FakeReceiver`, `FakeEventRouter` (L1); `FakeScheduler`, `FakeRunEngine` (L2); `FakeWorktreeManager`, `FakeAgentRunner`, `FakeDeliverer` (L3); `FakeLinearClient`, `RecordingNotifier` (L4) |
| `src/domain/fakes.test.ts` | `node:test`, co-located per T41. Constructs all 14 with no arguments, then one behavioral assertion per fake (two for the ones the plan called out by name: `InMemoryStore`, `FakeScheduler`, `FakeAgentRunner`). Written; not run — rush mode. |

Three commits, one per plan task: `ebfae03` (L0 fakes), `17444f2` (L1/L2 fakes), `b549513`
(L3/L4 fakes + the test file).

## Notable implementation choices

- **`InMemoryStore.recordDelivery`/`tryInsertDelivery`** — see Contract additions below;
  both names exist on the class so the fake compiles against whichever name `ports.ts`
  settles on.
- **`FakeScheduler`** is a genuine queue-based counting semaphore: `acquire` either grants
  immediately (under capacity) or parks a grant closure keyed loosely by `runId` in a wait
  array; `positionOf` reads that array's index; `syncFromStore` recomputes `inUse()` from
  `holdsSlot(state)` over a snapshot of runs, matching D-02's "awaiting_answer holds no
  slot" invariant directly rather than re-deriving it.
- **`FakeAgentRunner`** scripts an `AgentResult[]`, replaying in order and repeating the
  last. The `AbortSignal` handling registers an `abort` listener synchronously inside the
  `Promise` executor, then races it against a `queueMicrotask` that resolves with the
  scripted result — so a signal aborted before `run()` is called resolves immediately, and
  one aborted synchronously right after (before any `await`) still wins the race, with no
  timer anywhere.
- **`FakeDeliverer`** and **`FakeWebhookRegistrar`** are keyed on their idempotency contract
  (by worktree path, and by a single fixed id, respectively) rather than incrementing a
  counter per call — a fake that minted a fresh id/PR per call would make an idempotency
  test pass for the wrong reason.

## Contract additions requested

Every fake's constructor signature and public inspection surface, for Phase 7's integration
gate to reconcile against what Phases 2-6 actually imported.

```ts
// L0
class InMemoryStore implements Store {
  constructor(seed?: { runs?: Run[]; questions?: PendingQuestion[] })
  // full Store surface, plus:
  recordDelivery(deliveryId: string, receivedAt: number): boolean   // alias of tryInsertDelivery — see note below
}

class FakeConfigLoader implements ConfigLoader {
  constructor(partial?: Partial<Config>)
  // default fixture: one project-keyed mapping (2 repos + slackWebhookUrl),
  // one team-keyed mapping (D-07 fallback) with a one-key `overrides` (D-09: { draftPr: false })
}

class RecordingLogger implements Logger {
  constructor(bindings?: Record<string, unknown>, lines?: RecordedLine[])
  readonly lines: Array<{ level; bindings; objOrMsg; msg? }>   // shared across child()
}

// L1
class FakeTunnel implements TunnelManager {
  constructor()
  openCount: number
}
class FakeWebhookRegistrar implements WebhookRegistrar {
  constructor(seed?: { webhookId?: string; secret?: string })
  reconcileCount: number; disabled: boolean; lastUrl: string | null
}
class FakeReceiver implements Receiver {
  constructor()
  secret: string | null
  deliver(d: WebhookDelivery): void   // test-only: push a delivery through the stored callback
}
class FakeEventRouter implements EventRouter {
  constructor(scripted?: DomainEvent[])
  readonly delivered: WebhookDelivery[]
}

// L2
class FakeScheduler implements Scheduler {
  constructor(capacity?: number)   // default 3
}
class FakeRunEngine implements RunEngine {
  constructor()
  readonly handled: DomainEvent[]; readonly ticks: number[]
  recovered: boolean; drainedGraceMs: number | null
}

// L3
class FakeWorktreeManager implements WorktreeManager {
  constructor(root?: string)   // default '/fake/worktrees'
}
class FakeAgentRunner implements AgentRunner {
  constructor(script?: AgentResult[])   // default [{ status: 'complete', ... }]
  readonly requests: AgentSpawnRequest[]
  emitProgress(runId: RunId, line: string): void   // test-only: drive onProgress
}
class FakeDeliverer implements Deliverer {
  constructor()
  readonly calls: Array<{ wt: Worktree; repo: RepoMapping; pr: { title: string; body: string } }>
}

// L4
class FakeLinearClient implements LinearClient {
  constructor(seed?: { issues?: LinearIssue[]; botUser?: { id: string; name: string } })
  readonly comments: Array<{ issueId; body; parentId?; id: string }>
  readonly stateChanges: Array<{ id; stateType: 'started' | 'review' }>
}
class RecordingNotifier implements Notifier {
  constructor()
  readonly events: RunEvent[]
}
```

### Reconciliation this plan flags but does not fix

**`Store.tryInsertDelivery` vs `Store.recordDelivery` — `ports.ts` and TRAPS.md now
disagree with each other.** 01-02's own summary (item 7 of its "Deviations" section) chose
`tryInsertDelivery` as the name landed in `ports.ts`. TRAPS.md's T46, appended after that,
settles the opposite way: *"Same for `recordDelivery` (implemented) over `tryInsertDelivery`
(requested)"* — i.e. the real `sqlite-store.ts` implements `recordDelivery`, and
`tryInsertDelivery` was only ever a requested name that never got built. `01-03-PLAN.md`'s
own task text is written entirely in terms of `recordDelivery`, consistent with T46, not
with the currently-merged `ports.ts`.

This plan did not edit `ports.ts` (out of scope — `01-04` owns the migration, `01-02` owned
the interface, and rush mode's rule is "declare the call site you want, don't invent it").
Instead `InMemoryStore` implements `tryInsertDelivery` (to compile against `ports.ts` as it
stands today) and exposes `recordDelivery` as a same-behavior alias (to compile against what
every downstream phase's executor was actually told to call, per T46 and this plan's own
text). **Phase 7's integration gate should pick `recordDelivery` per T46 and delete the
`tryInsertDelivery` name from `ports.ts` and this file together** — carrying both forward
indefinitely would let the next reader guess wrong again.

## Known Stubs

None. Every fake implements real, inspectable behavior — no fake returns a hardcoded empty
value or a "not implemented" placeholder for any method its port declares.

## Verification

All automated checks in the plan's three tasks were run and passed:

- Every class name and Store/L1-L2 member the plan's task 1/2 scripts check for is present.
- All 14 fakes exist, each declared `implements <PortName>` for exactly the 14 ports the
  plan's task 3 script enumerates.
- `fakes.test.ts` uses `node:test` and exercises `recordDelivery`, `acquire`, and
  `resolveToggles`.
- `fakes.ts` imports nothing outside `./` (relative, all within `src/domain/`) — the
  zero-dependency grep returned 0 matches.

Per rush mode, `node --test` itself was not run; the test file is written and will be picked
up by the single end-of-milestone integration gate (`tsc && node --test dist`, T34).

`STATE.md` / `ROADMAP.md` were deliberately not touched, matching `01-02-SUMMARY.md`'s
precedent: eight phases are executing in parallel worktrees, and eight branches rewriting
the same progress files is a merge conflict per branch for no information the orchestrator
does not already have.

## Self-Check: PASSED

All 3 commits (`ebfae03`, `17444f2`, `b549513`) are present in `git log`. Both files
(`src/domain/fakes.ts`, `src/domain/fakes.test.ts`) exist on disk. No commit in this plan
deleted a tracked file.
