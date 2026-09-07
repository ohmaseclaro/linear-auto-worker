---
task: P0 — the reconciliation poll re-runs an already-delivered ticket, forever
type: quick
severity: P0
created: 2026-09-07
files_modified:
  - src/domain/ports.ts
  - src/domain/fakes.ts
  - src/domain/fakes.test.ts
  - src/infra/store/sqlite-store.ts
  - src/infra/store/sqlite-store.test.ts
  - src/infra/store/domain-store.ts
  - src/orchestration/run-engine.ts
  - src/orchestration/run-engine.test.ts
  - src/orchestration/recovery.ts
  - src/orchestration/recovery.test.ts
  - src/orchestration/qa-roundtrip.test.ts
  - src/orchestration/fanout.test.ts
  - src/cli/daemon.ts
  - .planning/TRAPS.md
gate: npm run verify   # 584/584 green before, ≥589 green after
---

<objective>
Stop the daemon re-running a ticket it has already delivered.

COD-2 was delivered (PR #1, run `delivered`) and 60 seconds later the reconciliation
poll started a second run on `…-cod-2-…-2`. Left running it opens a new PR and burns a
new `claude` session (~$0.51 / 193k tokens) every minute, forever. The operator cannot
run the daemon at all until this ships.
</objective>

<diagnosis>
`src/orchestration/recovery.ts:262-265`:

```
if (issue.updatedAt <= watermark) continue;
if (store.findActiveRunByIssue(issue.id).length > 0) continue;
await engine.handle({ kind: 'run.requested', issueId: issue.id });
```

Two independent faults, either of which alone is survivable:

1. **The guard is the wrong guard.** `findActiveRunByIssue` filters on
   `state NOT IN ('delivered','partial','failed','cancelled')` (`sqlite-store.ts:212`).
   A `delivered` run is terminal, so it blocks nothing. The issue is still assigned to
   the bot and still open, so it re-qualifies on every tick.
2. **The watermark cannot save it, because the bot poisons its own watermark.** The In
   Progress transition and the "Done" comment are writes by the bot that bump
   `issue.updatedAt`. This is the self-event problem on the POLLING path. The webhook
   path has loop guard L1 (delivery `actor` vs `botUserId`); a poll observes a *state*,
   not an *act*, so it has no actor to compare and nothing equivalent.

Latent until today: `reconcile` used to run only at boot, so it took a restart to bite.
Gap D4 added the periodic tick and turned it into a loop.

Same defect as T78 (one ticket, two runs) reached through the other door. T78's fix put
the live-run guard in the engine "where both producers meet"; it was the right place and
the wrong predicate for this producer.

The comment at `run-engine.test.ts:472-476` states the rule that is now known false —
"the guard against an automatic retry loop is the reconciliation watermark, not this
check". The watermark is not a guard. That comment is corrected in Task 3.
</diagnosis>

<decisions>
**D-1 — What an explicit operator re-request is: an unassign→reassign, and it keeps working.**

OPS-04 / T17 says a run is attempted exactly once. So the mere continued existence of the
assignment must never re-request. A *deliberate* re-request is the operator unassigning and
re-assigning: that produces `issue.unassigned` → `run.cancelled` (a no-op against a
terminal run — "cancel for an issue with no active run") and then `issue.assigned` →
`run.requested`, which is an ACT with an actor, carried on a webhook.

The rule is therefore not "terminal run blocks" — that rule would block the legitimate
reassignment. The rule is **the producer's evidence class**:

| producer | evidence | rule |
|---|---|---|
| webhook `issue.assigned` | an act, with an actor, deduped by `Linear-Delivery` | blocked only by a LIVE run (T78, unchanged) |
| reconciliation poll | a state, self-bumped by the bot's own writes | blocked by ANY run, live or terminal |

Known limitation, accepted and documented in code: if the daemon is DOWN for the whole
unassign→reassign, both webhooks are lost and the next poll sees a prior run and skips.
The operator re-assigns once with the daemon up. Losing one re-request while the daemon is
down is a missed action; the alternative loses money and opens a PR every minute.

**D-2 — One guard, in the engine, keyed on a required field of the event.**

Both rules above are one sentence — *do not start a run for an issue that already has one,
unless the operator deliberately asked again* — with one producer-supplied input. So it is
ONE rule and it lives in ONE place: the engine's `run.requested` arm, where both producers
already meet. `run.requested` gains a required `trigger: 'assignment' | 'reconcile'`.

`reconcile`'s private copy of the live check is **deleted**, not extended. It exists today
only as an early-out avoiding a `getIssue` round-trip, and the engine's guard already runs
before `getIssue` — it saves nothing and it is a second implementation of one rule. Net
change is one guard site, down from two. This repo's most repeated defect is two
implementations of one rule (T72/T73/T92/T96/T99/T101); this closes one rather than adding
a seventh.

`trigger` is **required, not optional-with-a-default**. An optional field's default is
either permissive (a future producer that forgets it silently reintroduces this loop) or
strict (a future producer that forgets it silently breaks reassignment). Both are silent,
and silent-unwired is this repo's signature failure. Required means a compile error. Cost
is 27 mechanical call-site edits, done by one `sed`.

**D-3 — `recoverAtBoot` is untouched and cannot be stranded.**

It never emits `run.requested`. It calls `engine.transition(run.id, 'queued', …)` on the
EXISTING row, so the new rule is not on its path at all. A run it requeues sits at `queued`
— non-terminal — so the unchanged live-run check keeps the poll off it. Pinned by a test in
Task 4 rather than by assertion.

Bonus closed by the same rule: `recoverAtBoot` FAILS a `running`/`delivering` run (D-07).
Today, that ticket is still assigned, so the very next poll tick resurrects it — the same
loop through a third door, and directly against OPS-04. The `trigger: 'reconcile'` rule
stops that too.
</decisions>

<tasks>

<task n="1" commit="feat(store): add findRunsByIssue across all four store seams">
  <files>
    src/domain/ports.ts
    src/domain/fakes.ts
    src/infra/store/sqlite-store.ts
    src/infra/store/domain-store.ts
    src/domain/fakes.test.ts
    src/infra/store/sqlite-store.test.ts
  </files>
  <action>
    Only `findActiveRunByIssue` exists and it filters terminals out. Add `findRunsByIssue(issueId): Run[]`
    — every run row for the issue, no state filter, no kind filter (a ticket parent counts:
    its presence means children were created). `ORDER BY created_at DESC` to match its sibling.

    Add it in all four places IN ONE COMMIT, per T70 — a port method implemented in the fake
    and missing from the real store has already been committed once in this repo:
      - `src/domain/ports.ts` — the domain `Store` interface, next to `findActiveRunByIssue` (~line 58).
      - `src/infra/store/sqlite-store.ts` — the `RowStore` interface (~line 100) and the impl (~line 212).
      - `src/infra/store/domain-store.ts` — the `asDomainStore` mapping (~line 76), `.map(toRun)`.
      - `src/domain/fakes.ts` — `InMemoryStore` (~line 102), `this.allRuns().filter(r => r.issueId === issueId)`.

    Document on the port that this is the *history* question ("has this issue ever been
    attempted") against `findActiveRunByIssue`'s *liveness* question ("is a session running
    on it right now") — the two are not interchangeable and confusing them is this P0.
  </action>
  <verify>
    Parity test in BOTH `src/domain/fakes.test.ts` and `src/infra/store/sqlite-store.test.ts`,
    beside the existing `findActiveRunByIssue` tests (fakes.test.ts:91, sqlite-store.test.ts:126):
    seed two runs for one issue, one `delivered` and one `queued`, plus one run for a different
    issue. Assert `findRunsByIssue` returns 2 while `findActiveRunByIssue` returns 1, and that
    the other issue's run is not in either.
  </verify>
  <falsify>
    Give the sqlite impl the terminal filter its sibling has
    (`AND state NOT IN ('delivered', …)`) — the sqlite parity test must go red on
    `2 !== 1` while the fake's stays green. That is T70's exact shape, reproduced on purpose.
  </falsify>
  <done>`npm run verify` green. Both stores answer the history question identically.</done>
</task>

<task n="2" commit="refactor(engine): run.requested carries a required trigger">
  <files>
    src/domain/ports.ts
    src/cli/daemon.ts
    src/orchestration/recovery.ts
    (27 construction sites across src/, mechanically)
  </files>
  <action>
    Pure type change, zero behaviour change — the engine ignores the new field until Task 3.

    1. `src/domain/ports.ts:168` — `| { kind: 'run.requested'; issueId: IssueId }` becomes
       `| { kind: 'run.requested'; trigger: 'assignment' | 'reconcile'; issueId: IssueId }`.
       Doc-comment it with D-1's evidence table: `assignment` is an act with an actor,
       deduped by `Linear-Delivery`; `reconcile` is an observed state the bot's own writes
       keep refreshing. Extend the ingress→engine mapping table above it (~line 156).
    2. All 27 value sites take `trigger: 'assignment'`:
       `sed -i '' "s/kind: 'run\.requested', issueId:/kind: 'run.requested', trigger: 'assignment', issueId:/g"`
       over `src/`. Verified: 27 of 29 occurrences match this pattern; the two that do not
       are the type declaration (step 1) and the `case` label in `run-engine.ts:821`.
       This correctly sets `daemon.ts:260` (the webhook producer) at the same time.
    3. Hand-fix the one site the sed gets wrong: `src/orchestration/recovery.ts:264` is the
       poll and takes `trigger: 'reconcile'`.
  </action>
  <verify>
    `npm run verify` green and unchanged at 584/584 — no test's meaning moves in this commit.
    `grep -rn "trigger: 'reconcile'" src/` returns exactly one line, in `recovery.ts`.
  </verify>
  <falsify>
    Drop `trigger` from `daemon.ts:260` — `tsc` must fail. That IS the guarantee being
    bought: a future producer cannot omit it and inherit a silent default.
  </falsify>
  <done>Every producer declares its evidence class, checked by the compiler.</done>
</task>

<task n="3" commit="fix(engine): the reconciliation poll never re-requests an attempted issue">
  <files>
    src/orchestration/run-engine.ts
    src/orchestration/recovery.ts
    src/orchestration/qa-roundtrip.test.ts
    src/orchestration/recovery.test.ts
    src/orchestration/run-engine.test.ts
  </files>
  <action>
    **The fix.** `run-engine.ts`, the `run.requested` arm (~line 833), immediately after the
    existing live-run early-out, which is UNCHANGED — T78 stays exactly as it is:

    ```
    if (event.trigger === 'reconcile' && store.findRunsByIssue(event.issueId).length > 0) {
      log.info({ issueId: event.issueId }, 'poll observed an issue that has already been attempted; ignoring');
      return;
    }
    ```

    Comment it with D-1: the poll observes a state, not an act, and the bot's own In Progress
    transition and Done comment bump `issue.updatedAt`, so the watermark cannot bound it.
    OPS-04 — one attempt per assignment; the operator's retry gesture is unassign then
    re-assign, which arrives as `trigger: 'assignment'` and is deliberately still honoured.
    Note the accepted limitation from D-1 (daemon down across the whole reassignment) as a
    `ponytail:` line naming re-assign-with-the-daemon-up as the recovery.

    **The deletion.** `recovery.ts` — remove its private `findActiveRunByIssue` early-out
    (line 263). One rule, one site. Its `report.enqueued` bookkeeping must stop assuming the
    call enqueued, without re-deriving the rule:

    ```
    const before = store.findRunsByIssue(issue.id).length;
    await engine.handle({ kind: 'run.requested', trigger: 'reconcile', issueId: issue.id });
    if (store.findRunsByIssue(issue.id).length > before) report.enqueued.push(issue.id);
    ```

    That is an observation of what the engine did, not a second copy of why.

    **The correction.** `run-engine.test.ts:472-476` claims "the guard against an automatic
    retry loop is the reconciliation watermark, not this check". The watermark is bumped by
    the bot's own writes and guards nothing. Rewrite it to point at the `trigger` rule. The
    test itself is unchanged and must stay green — it is D-1's deliberate re-request case.
  </action>
  <verify>
    **MANDATORY, and it must be shown RED against today's code before the fix lands.**
    End-to-end in `src/orchestration/qa-roundtrip.test.ts`, which already composes a REAL
    `createRunEngine` + real scheduler + real questions over `InMemoryStore` /
    `FakeLinearClient` (harness at line 89 — add `questions` to its return; `CONFIG.botUserId`
    is `'bot'` and `ISSUE.assigneeId` is `'bot'`, so `listAssignedOpenIssues` already returns it):

      test: 'a delivered run is never re-run by the reconciliation poll'
        - `engine.handle({ kind: 'run.requested', trigger: 'assignment', issueId: ISSUE.id })`,
          `await engine.settle()`; assert exactly one run and `listByState('delivered').length === 1`.
        - Build `RecoveryDeps` from the harness and call `reconcile(deps, Date.parse('2026-06-01T00:00:00.000Z'))`
          twice, `settle()` between. The watermark starts unset (EPOCH) and `ISSUE.updatedAt`
          is `2026-01-01`, so the issue passes the watermark on the first pass exactly as a
          bot-bumped `updatedAt` does in production — the test MUST clear the watermark check,
          or it passes vacuously against today's code and proves nothing (T71).
        - Assert `store.findRunsByIssue(ISSUE.id).length === 1` — still one run, no second
          worktree, no second PR — and `report.enqueued` is empty on both passes.

    Plus, in `recovery.test.ts`, the poll's half of the seam: a `delivered` run for a listed
    still-assigned issue past the watermark makes `reconcile` emit
    `{ kind: 'run.requested', trigger: 'reconcile', issueId }` — the poll still DELEGATES and
    does not re-grow a filter of its own — while `report.enqueued` stays empty (that harness's
    fake engine only records events, so it cannot and must not reproduce the guard).
  </verify>
  <falsify>
    Three breaks, each run and reverted:
    1. Delete the new guard (i.e. today's code): the qa-roundtrip test goes red with two runs
       for one issue — the observed COD-2 loop, reproduced.
    2. Change the guard's condition to `findActiveRunByIssue`: red the same way. Pins that the
       predicate, not just the placement, is what fixes it.
    3. Change the guard to fire on `trigger === 'assignment'` too: `run-engine.test.ts:477`'s
       deliberate re-request goes red on `listByState('failed').length` 1 ≠ 2. Pins that
       unassign→reassign is not collateral damage.
  </falsify>
  <done>
    A delivered, still-assigned, still-open issue produces no second run on any number of
    poll ticks. An operator reassignment still produces one. `npm run verify` green.
  </done>
</task>

<task n="4" commit="test(recovery): boot requeue survives the poll; record T107">
  <files>
    src/orchestration/recovery.test.ts
    .planning/TRAPS.md
  </files>
  <action>
    Pin D-3 rather than asserting it, and record the trap.

    TRAPS entry T107 (next free number; T106 is last), phases 3/6/7:
    *"The reconciliation poll had no self-event guard, so the bot's own writes re-triggered
    its own delivered ticket once a minute."* — `findActiveRunByIssue` excludes terminal
    states, and the bot's In Progress transition and Done comment bump `issue.updatedAt`, so
    the watermark cannot bound the poll either. Impact: a new PR and a new paid `claude`
    session per tick, forever, observed live on COD-2. Fix: the evidence class belongs on the
    event (`trigger`), the rule belongs in the engine where both producers meet, and the
    poll's private copy is deleted rather than extended. Cross-reference T78 — same defect,
    other door, and its fix's own comment ("the guard is the reconciliation watermark") was
    the wrong theory.
  </action>
  <verify>
    `recovery.test.ts`: seed a `preparing` run whose issue is also listed as assigned and past
    the watermark. `recoverAtBoot` requeues it to `queued`; then `reconcile` on the same issue
    must (a) leave that run at `queued` — not stranded, not failed, not duplicated — and
    (b) emit no `run.requested` for it, because the live-run check already covers a
    non-terminal row.
  </verify>
  <falsify>
    Seed the run `delivered` instead of `preparing`: `recoverAtBoot` leaves it and the
    assertion "still `queued`" goes red — proving the test reads the boot action rather than
    passing on any seed.
  </falsify>
  <done>The crash-resume path is pinned as unaffected. `npm run verify` green.</done>
</task>

</tasks>

<out_of_scope>
- Retry/backoff machinery. OPS-04 / T17: one attempt, then a diagnosis and the branch left
  for the operator. This plan makes that true; it does not soften it.
- Server-side `updatedAt >` predicate on `listAssignedOpenIssues` (the existing `ponytail:`
  note at `recovery.ts:255`). Unrelated to the loop, and the loop is why it looked cheap.
- The fake/store divergence noticed in passing: `InMemoryStore.findActiveRunByIssue` treats
  `kind: 'ticket'` as always active, while the SQL excludes parent rows via `state IS NOT NULL`.
  Not touched here — `findRunsByIssue` returns every row in both, so it does not inherit the
  split. Worth its own ticket.
</out_of_scope>

<success_criteria>
- [ ] `npm run verify` green, ≥589 tests, zero regressions from 584.
- [ ] The qa-roundtrip loop test was observed RED against today's code before the fix.
- [ ] All three falsifications in Task 3 were run and reverted (T71/T76).
- [ ] Exactly one site decides whether a `run.requested` is honoured.
- [ ] The operator can start the daemon on a workspace containing COD-2 without it re-running.
</success_criteria>
