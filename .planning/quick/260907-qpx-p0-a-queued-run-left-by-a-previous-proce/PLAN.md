---
task: P0 — a run left `queued` by a previous process is never dispatched
type: quick
severity: P0
created: 2026-09-07
files_modified:
  - src/orchestration/run-engine.ts
  - src/orchestration/run-engine.test.ts
  - src/cli/daemon.ts
  - src/orchestration/recovery.ts
  - scripts/boot-smoke.ts
  - src/domain/types.ts
  - src/infra/store/migrations/001-init.ts
  - .planning/TRAPS.md
gate: npm run verify   # 590/590 green before, 594/594 + 4 new smoke checks after
---

<objective>
Make a `queued` row left behind by a previous process actually run on the next boot.

Measured 20 minutes ago: a clean Ctrl-C requeued an in-flight run; the next boot logged
`boot recovery complete {left: 1}`; `law status` showed it active; capacity 3, in use 0;
four one-minute tick cycles passed with zero agent spawns. It sits there forever.

Two writes exist solely to be picked up later and both are therefore no-ops today:
`markInFlight` (shutdown, `running` → `queued`) and `recoverAtBoot` (`preparing` →
`queued`). `daemon.ts:857`'s own comment says the first is what stops "every Ctrl-C costing
a manual re-assignment of every live ticket (T18, T26)". It costs one anyway — silently,
while `law status` reports the run as active.
</objective>

<diagnosis>
`scheduler.pump()` (`src/orchestration/scheduler.ts:82`) drains an **in-memory** `waiting`
array populated only by `acquire()` calls this process made. A `queued` row in SQLite is
not in it. Nothing at boot reads the queue from the store.

`Store.nextQueued(limit)` — `SELECT * FROM runs WHERE state = 'queued' ORDER BY created_at
ASC LIMIT ?`, the exact query — is **dead code**. Defined in `ports.ts:72`,
`sqlite-store.ts:105,239`, `domain-store.ts:79`, `fakes.ts:117`; tested in
`sqlite-store.test.ts:160`; called by nothing. Seventh dead export of this shape
(T72, T73, T92, T96, T99, T102).

`recovery.ts:72` carries the lie in one line:

```
  // Already correct. It will be picked up by the normal queue drain.
  queued: 'leave',
```

There is no normal queue drain.

**`RepoRun.resumable` is the eighth.** `migrations/001-init.ts:53`
(`resumable INTEGER NOT NULL DEFAULT 0`) and `types.ts:102` (`resumable?: boolean`). It is
not in `sqlite-store.ts`'s `RunRow` at all, so it is unreachable from both directions: no
code writes it, no code reads it, and the column can never be populated even by accident.
Confirmed by grep across `src/`, `scripts/`, `test/` — four hits, two of which are the
declarations and two of which are unrelated prose about `--resume`. It was the
place a SIGINT-killed-but-resumable session was going to be marked. Deleted in Task 4.

`attempt` is a ninth of a slightly different kind: declared in the migration
(`001-init.ts:54`), in `RunRow` (`sqlite-store.ts:35`) and in `RunBase`
(`types.ts:75`), **written as `0` by `fanout.ts:144,174` and never incremented and never
read**. Write-only, always zero. See D-4 for why it must stay that way.
</diagnosis>

<decisions>

**D-1 — Re-driving a `queued` run is resumption, not retry, and the QUERY is what says so.**

OPS-04 / T17: a run is attempted exactly once. A `queued` row is an attempt that was
**interrupted before it finished**, not one that finished badly. So driving it is
resumption.

Stating that in a comment is not enough — the operator is right that a future reader will
"fix" it back into a retry. It is enforced by the selection instead: the drain selects
`state = 'queued'` and nothing else, and `queued` is unreachable from every terminal state
(`canTransition('failed', 'queued') === false`, pinned by `state-machine.test.ts`). The day
someone widens that query to a terminal state, it becomes the bounded `failed → queued`
auto-retry T17 forbids — and Task 3's test goes red at exactly that edit.

**D-2 — Do NOT route through `run.requested`. It would be refused, and adding a trigger
value to make it pass re-opens T107.**

`run-engine.ts:834` refuses any `run.requested` whose issue has a live run, and a `queued`
run is live (`findActiveRunByIssue` includes it). `trigger: 'reconcile'` is refused harder
(`:856`, any prior run at all). A third trigger value meaning "redrive" would be a producer
whose evidence class is neither an act nor an observed state, and the first thing it would
have to do is bypass the liveness guard T78 installed — i.e. re-open the loop T107 just
closed, through a new door.

The run row **already exists**, already at `queued`, already acknowledged, already In
Progress, already subscribed. There is nothing to request. The engine gains a direct
entry point instead: `dispatchQueued(): RunId[]`.

**D-3 — Boot only. The tick case does not exist.**

Exactly four sites write `queued` (`grep -E "to: 'queued'|state: 'queued'|transition\(.*'queued'"`):

| site | when | leaves a driverless `queued` row? |
|---|---|---|
| `fanout.ts:143` + `run-engine.ts:190` (`insertPlan`) | ingress / poll | No — `handle` calls `drive()` in the same turn |
| `recovery.ts:159` (`recoverAtBoot`) | boot, step 3 | Yes — this is the boot case |
| `daemon.ts:867` (`markInFlight`) | shutdown | Yes, and the process exits immediately after |

There is no fourth. A run requeued *while the daemon keeps running* cannot happen, so a
tick drain would guard nothing today. It is one line away if a fifth site is ever added
(and D-5's `driving` set makes it safe to add), and `dispatchQueued`'s doc-comment says so.

**Not bounded by a repeating-crash argument either.** The only crash that could re-feed the
drain is one inside the sub-second `preparing` window — `recoverAtBoot` **fails** a
`running`/`delivering` row at an unclean exit (`BOOT_ACTION`, D-07), it does not requeue it.
Every other route in requires an operator Ctrl-C or an operator re-boot. That is a person
choosing, not a loop.

**D-4 — `attempt` must NOT bound this, and that is the point of asking.**

`attempt` is the vestigial counter of the bounded `failed → queued` auto-retry that T17
explicitly forbids building. Bounding the drain by it would *be* that retry machinery,
arriving through the resumption door. Given D-3 there is no loop for it to bound anyway.

It is left in place (deleting it touches the migration, `RunRow`, `fanout.ts` ×2 and five
test fixtures for no behaviour change) with a comment naming it vestigial. `resumable` is
deleted, because deleting it is one line and it is not even reachable.

**D-5 — The drain must skip runs this process is already driving, or boot double-drives.**

Boot order is: step 7 `sweepMissedWork` → step 8 `scheduler.start()` → step 8b drain.
`sweepMissedWork` can enqueue a run via `engine.handle`, which inserts at `queued` and calls
`track(drive(...))`; that driver then **parks** on `scheduler.acquire`. `scheduler.start()`
resolves its slot promise, but the continuation is a microtask — it has not run when the
next synchronous statement executes. So a naive drain at step 8b reads that row **still at
`queued`** and drives it a second time: two worktrees, two `claude` sessions, two PRs for
one ticket. Guaranteed, on every boot where the poll finds anything.

`aborts` cannot serve as the guard: `run-engine.ts:806` documents that a driver enters
`aborts` only **after** it has its slot, and shutdown depends on that. So `drive()` gains a
separate `driving: Set<RunId>`, added on entry (before `await slot`) and removed in
`finally`. Three lines, and it is also what would make a future tick drain safe.

`resumeAfterAnswer` needs no entry: it drives runs out of `awaiting_answer`/`running`,
never out of `queued`, so the drain cannot see them.

**D-6 — Every redriven run gets a FRESH session id. Without it the fix is 0% correct in
production and 100% green in tests.**

`drive()` calls `spawnRequest(..., resume: false)` → `buildFreshArgs` → `--session-id
<run.sessionId>`. A run requeued out of `running` by `markInFlight` has **spent** that id,
and `docs/agent-invocation.md:28` + `agent-args.ts:174` both record that reusing a spent id
is a **hard error**: `Session ID <uuid> is already in use`. That is the single most common
case this fix exists to serve.

So the drain mints a new `sessionId` unconditionally before driving. For a never-spawned
run (requeued from `preparing`) replacing it costs nothing — the id is pre-assigned
precisely so it can be persisted before the spawn. No branching, no "was it spent"
bookkeeping, no need for the `resumable` column.

Not `--resume`: that needs a "carry on where you left off" prompt that does not exist, and
its resumability depends on whether the supervisor's ladder got past SIGINT. A fresh
session on a fresh suffixed branch is what D-11 already designed for ("a retry never
destroys a previous attempt's commits" — `worktree.ts:5`); the interrupted attempt's branch
and commits survive untouched.

`failureReason` is cleared in the same write: a run carrying `SHUTDOWN_NOTE` while it is
running again is a lie `law status` will repeat.

**D-7 — No re-acknowledgement. `ackCommentId` is `null`.**

The run was already acknowledged, moved to In Progress and subscribed by the process that
first picked it up; its ack entry is still in kv and `refreshQueuePositions` edits that
comment. Re-running the ack sequence posts a **second** pickup comment on the ticket —
T72's double-post through a new door — plus two redundant Linear writes.

Consequence for tests: `spyWorktrees` throws unless `comment.create / issue.state /
issue.subscribe` were recorded first, so Task 3's harness needs that assertion relaxed for
the redrive cases. That is a fixture change, not a product change.

**Skipped:** calling `refreshQueuePositions()` from the drain. `drive`'s `finally` already
refreshes on every completion, so the first run to finish corrects everyone's comment. Add
it when a stale "position 3" line after a restart actually annoys someone.
</decisions>

<falsification_protocol>
Three named checks, because the last two P0 tests here both needed one and both needed a
different one.

1. **Red at HEAD, for the right reason.** Task 1 adds the smoke reproduction and runs it
   *before any product change*. It must fail on `the run the previous process requeued was
   dispatched (no queued→preparing event)`, not on a boot error, not on a timeout in
   setup. The exact stderr goes in Task 2's commit body.

2. **Not the watermark.** The known vacuity mode here is the reconciliation poll doing the
   work and the test crediting the drain. The second boot's `sweepMissedWork` *will* see
   `SMK-1` still assigned and still open, and T107's `trigger: 'reconcile'` guard *should*
   refuse it. So the smoke asserts **two** things in one block: the ORIGINAL run id gained a
   `queued → preparing` event, **and** `findRunsByIssue(ISSUE_ID).length === 1`. If the poll
   were the actor there would be a second row and the original would still be `queued` —
   both halves flip. This doubles as a live regression test for T107.

3. **Not an event the new code stopped emitting.** The assertion is on a `run_events` row
   with `from: 'queued', to: 'preparing'`. `transition()` is the single writer of
   `runs.state` and appends that row **in the same transaction** as the state write
   (Phase 1 D-03). It cannot be emitted-away without the state write disappearing too.

4. **T99/T102: wired, not merely implemented.** After Task 2 is green, delete the single
   `engine.dispatchQueued()` line from `daemon.ts` step 8b, leaving the engine method and
   all four unit tests intact. `npm test` must stay **green** and `npm run smoke` must go
   **red**. If the smoke stays green, it is not testing the live path — stop and fix it.
   Restore the line.
</falsification_protocol>

<tasks>

<task n="1" commit="none — reproduction step, run against unmodified src/">
  <files>scripts/boot-smoke.ts</files>
  <action>
    Reproduce the strand on the live path, before touching `src/`.

    The smoke already ends at exactly the right place: it Ctrl-Cs the daemon, reopens
    `store.db` through a fresh connection and asserts `the in-flight run was requeued for
    the next boot` (`boot-smoke.ts:277-287`). Then it stops. **That missing next boot is the
    bug.**

    After the `reopened.close()` at `:288`, before `daemon = undefined`, add a second boot
    against the SAME workspace:

      - `const eventsBefore = <count of run_events rows for run.id>` read from `reopened`
        before closing it.
      - `const tunnel2 = probingTunnel();`
      - `daemon = await bootDaemon({ configDir: workspace.dir, linear, tunnel: tunnel2,
        runCommand, agent: { run: () => Promise.reject(new Error('smoke: no agent')) } });`
        The `agent` slot is belt-and-braces: `runCommand` returns exitCode 0 for
        `git show-ref`, so `resolveBranchName` will exhaust its 50 candidates and throw
        (T87) long before the agent is reached — but a future change to `runCommand` must
        not be able to make `npm run verify` spawn a real `claude`.
      - `await until(() => daemon.store.listRunEvents(run.id).some(e => e.from === 'queued'
        && e.to === 'preparing') || undefined, { label: 'the requeued run to be dispatched
        on the next boot' });`

    Then four `check()`s:
      1. the requeued run left `queued` on the next boot, by its OWN id
         (`run_events` gained `from: 'queued', to: 'preparing'`)
      2. `store.findRunsByIssue(ISSUE_ID).length === 1` — it was RESUMED, not re-created;
         the reconciliation poll did not do this (T107 still holds)
      3. `store.getRun(run.id).sessionId !== <the id read back before the second boot>` —
         a fresh session id, because `--session-id` hard-errors on a spent one (D-6)
      4. `store.getRun(run.id).failureReason !== SHUTDOWN_NOTE` — the shutdown note was
         cleared when the run resumed

    Update the trailing `SMOKE PASSED` line to name the second boot.
  </action>
  <verify>
    `npm run smoke` — MUST FAIL, on check 1, at the `until` timeout with the label
    `the requeued run to be dispatched on the next boot`. Paste the exact stderr into the
    scratchpad; it goes in Task 2's commit body.
  </verify>
  <falsify>
    This task IS the falsification. If it passes against unmodified `src/`, the diagnosis is
    wrong — stop and re-diagnose before writing any fix.
  </falsify>
  <done>A recorded red run naming the missing dispatch. Nothing committed; the gate is red.</done>
</task>

<task n="2" commit="fix(engine): dispatch runs left queued by a previous process">
  <files>
    src/orchestration/run-engine.ts
    src/cli/daemon.ts
    src/orchestration/recovery.ts
    scripts/boot-smoke.ts
  </files>
  <action>
    Engine and wire in ONE commit. A `dispatchQueued` committed alone is a dead export, which
    is T96/T102's exact shape and would be the eighth in this repo rather than a fix for the
    seventh.

    **1. `src/orchestration/run-engine.ts` — the driver-identity set (D-5).**
       Beside `const aborts = new Map<RunId, AbortController>()` (~`:122`), add
       `const driving = new Set<RunId>()`. In `drive()` (~`:692`), `driving.add(runId)` as
       the FIRST statement — **before** `await slot`, which is the whole point — and
       `driving.delete(runId)` in the existing `finally`. Comment: this is deliberately not
       `aborts`, because `stop()` at `:806` depends on `aborts` holding only runs that
       already have a slot.

    **2. `src/orchestration/run-engine.ts` — `dispatchQueued()`.**
       Add to the `RunEngine` interface after `refreshQueuePositions()` (~`:52`):

         dispatchQueued(): RunId[];

       Doc-comment carrying D-1 verbatim: a `queued` row is an INTERRUPTED attempt, not a
       finished-badly one; driving it is resumption and NOT the bounded `failed → queued`
       retry OPS-04/T17 forbid; the guarantee is the selection, not this sentence —
       `queued` is unreachable from every terminal state, and widening this query to one
       makes it a retry. Plus D-3: boot only, and the enumeration of the four `queued`
       writers that makes a tick drain unnecessary today.

       Implementation, near `refreshQueuePositions`:

         - `store.nextQueued(DRAIN_LIMIT)` — the dead query, wired. NOT
           `listByState('queued')`: `nextQueued` carries `ORDER BY created_at ASC`, which is
           what makes admission FIFO across a restart. `DRAIN_LIMIT = 1000` with a
           `// ponytail:` comment naming the ceiling — far past any real backlog on a
           3-slot single-operator daemon; a longer queue means something else is wrong.
         - `.filter((r): r is RepoRun => r.kind === 'repo')` — a ticket parent cannot be
           `queued` (the migration's CHECK constraint forbids it), so this is the type
           narrowing and the invariant at once, same as `recoverAtBoot:143`.
         - `.filter((r) => !driving.has(r.id))` — D-5. Comment the microtask window
           explicitly: `scheduler.start()` resolves the parked driver's slot promise but its
           continuation has not run when this synchronous statement executes, so the row is
           still `queued` and reads as strandable when it is not.
         - per run: `store.updateRun(run.id, { sessionId: randomUUID(), failureReason: null,
           updatedAt: now() })` — D-6, with the `Session ID <uuid> is already in use` quote
           and the `docs/agent-invocation.md` pointer in the comment.
         - `track(drive(run.id, null, scheduler.acquire(run.id)))` — `null` ack per D-7,
           with the T72 double-post reason.
         - one `log.info({ runIds }, 'dispatched runs left queued by a previous process')`
           when non-empty; return the ids.

       Add `import { randomUUID } from 'node:crypto';`.

    **3. `src/cli/daemon.ts` — step 8b.** Immediately after `scheduler.start()` (`:699`):

         // ── 8b. drain the queue the LAST process left behind ──────────────────────
         engine.dispatchQueued();

       with the comment: after `start()` and not before, because a drain that runs while the
       scheduler is not admitting silently does nothing — which is this bug's own failure
       mode. No log line here; the engine already logs, and `recoverAtBoot`'s neighbour at
       `:576` already establishes that convention.

    **4. `src/orchestration/recovery.ts:71-72` — delete the lie.** Replace
       `// Already correct. It will be picked up by the normal queue drain.` with a pointer
       to the drain that now exists: `daemon.ts` step 8b calls `engine.dispatchQueued()`
       after the scheduler starts. Until 2026-09-07 this comment named a mechanism that did
       not exist and the run sat forever.

    **5. `scripts/boot-smoke.ts`** — Task 1's block, unchanged, committed here.
  </action>
  <verify>
    `npm run verify` green: 590/590 tests (unchanged — no unit test added in this commit)
    plus the smoke's four new checks passing.
  </verify>
  <falsify>
    Two breaks, both required, in this order:
      a) Delete the `engine.dispatchQueued();` line from `daemon.ts` step 8b, keep everything
         else. `npm test` must stay GREEN and `npm run smoke` must go RED on check 1. If the
         smoke stays green it is not on the live path (T99). Restore.
      b) Move the `engine.dispatchQueued();` line to just BEFORE `scheduler.start()`. It must
         still pass — the drivers park and are admitted by `start()` — but then also delete
         the `driving.has` filter and re-run: the smoke must go red on check 2
         (`findRunsByIssue === 1`) or produce two `worktree.create` calls for one run.
         This is D-5 measured rather than argued. Restore both.
  </falsify>
  <done>
    A run left `queued` by a previous process runs on the next boot, on the real path,
    against a real SQLite file, with a fresh session id.
  </done>
</task>

<task n="3" commit="test(engine): pin the drain's boundaries — terminal, FIFO, no double-drive">
  <files>
    src/orchestration/run-engine.test.ts
  </files>
  <action>
    The smoke proves the wire. These prove the rules, and each one names the edit it catches.

    First, a fixture change (D-7): `spyWorktrees(order)` at `:148` throws unless the ack
    sequence was recorded, and a redriven run deliberately does not re-acknowledge. Give it
    `spyWorktrees(order, opts: { requireAck?: boolean } = {})` defaulting to `true`, and
    thread `harness({ preAcked?: boolean })` through to it. Every existing call site keeps
    today's behaviour.

    Reuse `recovery.test.ts:210`'s `seedRun` shape to insert a `queued` row directly — that
    IS "left by a previous process": a row with no driver in this heap.

    Four tests:

    1. `a run left queued by a previous process is dispatched with a FRESH session id`
       Seed one `queued` run (`sessionId: 's-spent'`) and its issue. `engine.dispatchQueued()`
       returns `[run.id]`; `await engine.settle()`; assert state `delivered`, assert
       `store.getRun(run.id).sessionId !== 's-spent'`, assert
       `store.findRunsByIssue(issueId).length === 1` (resumed, not re-created), assert
       `linear.created.length === 0` (no second pickup comment — D-7 / T72).

    2. `the drain never touches a terminal run (OPS-04 / T17)`
       Seed one run in each of `delivered`, `partial`, `failed`, `cancelled` plus one
       `queued`. Assert `dispatchQueued()` returns exactly the queued id and `spy.created`
       contains exactly that id after `settle()`.

    3. `the drain does not double-drive a run that already has a driver`
       `concurrency: 1`; hold the slot with `scheduler.acquire('outsider')`;
       `engine.handle({ kind: 'run.requested', trigger: 'assignment', issueId: 'issue-1' })`
       — the run is now `queued` with a live parked driver. Assert `dispatchQueued()` returns
       `[]`. Release the outsider, `settle()`, assert `spy.created` has exactly ONE entry for
       that run.

    4. `the drain admits oldest-first across a restart`
       Seed three `queued` runs with `createdAt` 3, 1, 2 inserted in that order;
       `concurrency: 1`; `dispatchQueued()`; `settle()`; assert `spy.created` is
       `[r-createdAt-1, r-createdAt-2, r-createdAt-3]`.
  </action>
  <verify>`npm run verify` green at 594/594.</verify>
  <falsify>
    One named break per test, each run and reverted:
      1. Drop the `sessionId: randomUUID()` from the drain's `updateRun` → test 1 red on the
         session-id assertion. (This is the break that would ship a fix which is green
         against `FakeAgentRunner` and hard-errors on every real spawn.)
      2. Widen the drain's read to `store.listByState('queued', 'failed')` → test 2 red at
         `2 !== 1`. This is the exact edit that turns resumption into the retry T17 forbids,
         and it is now a red test rather than a comment.
      3. Delete the `!driving.has(r.id)` filter → test 3 red with two `worktree.create` calls
         for one run.
      4. Swap `store.nextQueued(DRAIN_LIMIT)` for `store.listByState('queued')` → test 4 red
         on insertion order (3, 1, 2). This is what makes wiring `nextQueued` specifically —
         rather than the more obvious `listByState` — load-bearing instead of incidental.
  </falsify>
  <done>The four rules that make the drain safe are each held by a test with a known break.</done>
</task>

<task n="4" commit="chore(domain): delete the dead resumable field; name attempt vestigial">
  <files>
    src/domain/types.ts
    src/infra/store/migrations/001-init.ts
    .planning/TRAPS.md
  </files>
  <action>
    **`resumable` — delete.** Remove `resumable?: boolean;` from `RepoRun`
    (`types.ts:102`). It is not in `sqlite-store.ts`'s `RunRow`, so nothing can read or
    write it through either seam — confirmed by grep across `src/`, `scripts/` and `test/`
    (four hits: the migration, this declaration, and two unrelated `--resume` prose lines).
    Leave the SQL column in place — dropping it needs migration 002 for zero behaviour
    change — and comment it in `001-init.ts:53` as reserved-and-unused, naming what it was
    for (marking a SIGINT-killed session as `--resume`-able) and why D-6 chose a fresh
    session id instead.

    **`attempt` — keep, comment.** Add to `types.ts:75`: vestigial, always 0, never
    incremented and never read; it is the counter of the bounded `failed → queued` auto-retry
    T17 forbids, and bounding anything by it would build that retry. Do not delete it in this
    P0 (migration + `RunRow` + `fanout.ts` ×2 + five fixtures for no behaviour change); do
    not use it.

    **TRAPS T108.** Trap: *a state written to be picked up later, with nothing that picks it
    up*. Symptom: two writes (`markInFlight`, `recoverAtBoot`) whose only purpose is a later
    read that does not exist; `boot recovery complete {left: 1}` and `law status` both report
    the run as active while nothing will ever run it. Root: `Store.nextQueued` dead —
    seventh dead export of this shape after T72/T73/T92/T96/T99/T102, with `resumable` the
    eighth and `attempt` a write-only ninth. Fix: `engine.dispatchQueued()` wired at
    `daemon.ts` step 8b, proved by a SECOND BOOT in the boot smoke rather than by a unit
    test. Record the two findings that a unit test could not have produced: `--session-id`
    hard-errors on a spent id, so the naive `drive()` is 0% correct in production while
    green against a fake agent (D-6); and `scheduler.start()` resolves parked slot promises
    as microtasks, so a drain in the next synchronous statement double-drives every run the
    boot poll just enqueued (D-5). Generalise: **grep for CALLERS of the write, not just the
    write** — "requeued for the next boot" is a claim about code that must exist somewhere
    else, and this repo has now shipped that claim wrong three times.
  </action>
  <verify>
    `npm run verify` green at 594/594.
    `grep -rn "resumable" src/ scripts/ test/` returns only the migration comment and the
    two unrelated `--resume` prose lines.
  </verify>
  <falsify>
    Re-add `resumable?: boolean` and try to set it through `store.updateRun` — `tsc` must
    fail on `RunRow`. That is the proof it was never reachable, rather than the assumption.
  </falsify>
  <done>The dead field is gone, the write-only one is labelled, and T108 records both.</done>
</task>

</tasks>

<success_criteria>
- `npm run verify` green: 594/594 tests, boot smoke passing including the second boot.
- A run requeued by Ctrl-C runs on the next `law start`, with no manual re-assignment.
- The redriven run is the SAME run row — one row per issue, no second PR (T107 intact).
- Every one of the eight named falsifications was run and reverted, and the exact red
  output from Task 1 is in Task 2's commit body.
</success_criteria>
