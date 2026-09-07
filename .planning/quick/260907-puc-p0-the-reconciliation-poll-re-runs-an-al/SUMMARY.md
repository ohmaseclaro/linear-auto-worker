---
task: puc — P0, the reconciliation poll re-runs an already-delivered ticket, forever
status: complete
gate: npm run verify — 590/590 green (584 at start, +6)
commits:
  - f3ef8ce feat(store): add findRunsByIssue across all four store seams
  - c6b4c83 refactor(engine): run.requested carries a required trigger
  - 2cd3908 fix(engine): the reconciliation poll never re-requests an attempted issue
  - 210584b test(recovery): boot requeue survives the poll; record T107
---

# The loop is closed, and every new check was falsified

`npm run verify`: **584/584 -> 590/590**, 20 suites, smoke green. Green at every commit
boundary. Exactly one site now decides whether a `run.requested` is honoured
(`run-engine.ts:835` liveness + `:856` history); `reconcile`'s private copy is gone.

---

## The mandatory test: RED before the fix, GREEN after

`src/orchestration/qa-roundtrip.test.ts` — `'a delivered run is never re-run by the
reconciliation poll (T107)'`, real `createRunEngine` + real scheduler + real questions +
real `reconcile` over `InMemoryStore` / `FakeLinearClient`.

Written and run **before** the guard existed. Tasks 1 and 2 were already committed at that
point, but both are behaviour-neutral by construction — Task 1 only *adds* a store method
nothing yet called, Task 2 only adds a type field the engine still ignored — and no
existing test's meaning moved across either (584 -> 586 is exactly the two new parity
tests). So this is today's behaviour.

**RED, verbatim:**

```
not ok 3 - a delivered run is never re-run by the reconciliation poll (T107)
  ---
  location: '.../dist/src/orchestration/qa-roundtrip.test.js:180:1'
  failureType: 'testCodeFailure'
  error: |-
    pass one started no second run on the delivered ticket

    2 !== 1

  code: 'ERR_ASSERTION'
```

`2 !== 1` **is the COD-2 loop**: one assignment produced one delivered run, and a single
reconciliation tick started a second one on the same ticket. Suite: 2 pass / 1 fail.

**GREEN after `2cd3908`:** qa-roundtrip 3/3, whole gate 589/589 (590 after Task 4).

### How I confirmed it is not vacuous

The failure mode the plan warns about (T71) is the seeded issue sitting *below* the
watermark, so `reconcile` skips it on the `continue` and the test passes against broken
code without ever reaching the guard. Three explicit checks, all inside the test and all
load-bearing:

1. `assert.equal(h.store.kvGet(POLL_WATERMARK_KEY), undefined, 'watermark starts unset')`
   — pass one runs against EPOCH, and `ISSUE.updatedAt` is `2026-01-01`, so the issue
   clears it.
2. `assert.equal((await h.linear.listAssignedOpenIssues(CONFIG.botUserId)).length, 1)`
   — the delivered ticket is genuinely still listed by the poll. If the fake had dropped
   it, the test would prove nothing about the guard.
3. Pass **two** would otherwise be vacuous: pass one advances the watermark to
   `2026-01-01`. So the test reproduces the actual production mechanism — the bot's own
   writes bumping `updatedAt` — with
   `h.linear.putIssue({ ...ISSUE, updatedAt: '2026-03-01T00:00:00.000Z' })`, then asserts
   `bumped.updatedAt > h.store.kvGet(POLL_WATERMARK_KEY)!` before calling `reconcile`
   again. **That assertion is the anti-vacuity check, in the test, permanently.**

The negative control is F1 below: with the guard deleted the test fails at the first
assertion, which is only reachable if the watermark check was cleared.

---

## Falsification — measured, per case

Each performed for real: edit production source, rebuild through `tsc`, run, observe the
named case go red, restore, observe green.

| # | Break applied | Predicted red | Measured |
|---|---|---|---|
| T1-F | sqlite `findRunsByIssue` given its sibling's terminal filter | sqlite parity red, fake parity green | sqlite-store **12 pass / 1 fail** (`history: every row … - 'run-done'`), fakes **21/21 green** — T70's exact shape, reproduced |
| T2-F | `trigger` dropped from `daemon.ts:260` | `tsc` fails | `error TS2322 … Property 'trigger' is missing in type '{ kind: "run.requested"; issueId: string; }' but required` |
| T3-F1 | the new guard deleted (= today's code) | qa-roundtrip red, two runs | gate **588 pass / 1 fail**, sole failure `a delivered run is never re-run …` at `2 !== 1` |
| T3-F2 | guard's predicate swapped to `findActiveRunByIssue` | red the same way | gate **588 / 1**, same test, same `2 !== 1` — the predicate, not just the placement, is the fix |
| T3-F3 | guard fires on `assignment` too (`trigger` check removed) | the deliberate re-request breaks | gate **588 / 1**, `nothing AUTOMATIC moves a run out of failed` — `the retry is its own run  1 !== 2`, exactly as predicted |
| T4-F | crashed run seeded `delivered` instead of `preparing` | "still queued" red | qa-roundtrip **4 / 1**, fails at `nothing was spent, so it requeues` — the test reads the boot action, not any seed |

Note on T3-F1: the first attempt used `if (false && event.trigger === …)`, which does not
compile — TS loses the `case` narrowing through the short-circuit and reports
`TS2339: Property 'trigger' does not exist on type 'EngineEvent'`. `tsc` then emits anyway
while `npm run build` stops before `assets`, producing four unrelated red tests (missing
chmod, missing fixtures) with nothing to do with the falsification. Redone by deleting the
block outright; the measurement above is the clean one. Worth remembering: a broken build
in this repo shows up as four *plausible-looking* test failures, not as a build error.

---

## What the plan got wrong against the real code

Four things, all found by the compiler or the suite, none silently papered over.

**1. The `sed` was 27 sites in `src/` — and 7 more in `test/`.** The plan scoped the
mechanical edit to `src/` and asserted 27 matches; that was exactly right for `src/`, but
`test/integration/07-run-path.test.ts` constructs the event 7 more times and is compiled by
the same `tsconfig`. `tsc` named all seven (`TS2345`), which is precisely the guarantee the
required-not-optional field was bought for. No default was added; all seven take
`trigger: 'assignment'` (they are webhook-path tests).

**2. `recovery.test.ts:405` also had to be hand-fixed to `'reconcile'`.** The plan named
only `recovery.ts:264` as the sed's one wrong site. But `:405` asserts the event `reconcile`
*emits*, so the sed's `'assignment'` would have made it fail. Fixed in the same commit;
`grep -rn "trigger: 'reconcile'" src/` returns two lines (the producer and its assertion),
not the one the plan predicted.

**3. Deleting the poll's early-out broke five existing `recovery.test.ts` cases, not
zero.** `report.enqueued` is now derived from a run row appearing, and that harness's fake
engine was a pure recorder — it never inserted anything, so `enqueued` came back empty in
every poll test. Fixed by making the fake engine model the insert a real engine makes
(**not** by weakening any assertion): the four tests that assert `enqueued` keep their
assertions verbatim. The fake deliberately models **no guard** — a second copy of the rule
in a test fake is the defect this whole plan closes.

**4. The plan's Task 4 test could not live where it said.** It specified, in
`recovery.test.ts`, that after `recoverAtBoot` the poll must "emit no `run.requested`". That
was true of the old poll, which filtered; the new poll *delegates* and always emits. The
assertion is only meaningful against the real engine, so the test moved to
`qa-roundtrip.test.ts` and asserts the outcome instead: the requeued run is still `queued`,
`report.enqueued` is empty, and `findRunsByIssue` is still 1. Same claim, at a seam where it
is real. The plan's falsification (seed `delivered`) transferred unchanged and works.

Same reasoning for the plan's `recovery.test.ts` half of Task 3's verify: it is there
(`a DELIVERED run for a still-assigned issue is delegated too, tagged 'reconcile'`), but it
asserts delegation only, with a comment pointing at qa-roundtrip for the guard itself.

---

## Coverage replaced rather than dropped

`recovery.test.ts`'s `'an issue that already has a non-terminal run is not enqueued again —
three passes, one run'` asserted a guarantee the poll no longer makes on its own. Rather
than delete the guarantee, it is now asserted against the **real** engine in
`qa-roundtrip.test.ts`: `'three poll passes over an issue with a live run still produce one
run (T107)'`, which bumps `updatedAt` before each pass and asserts the bump clears the
watermark, so no pass is vacuous. The old unit test kept its seam-level half (the poll
delegates and does not filter). Net: the claim is stronger than before — it used to be
checked against a recorder, now against `createRunEngine`.

That test also bounds F1's scope: with the new guard deleted it still passes, because a
live run is caught by the unchanged T78 check. Only the terminal case was ever broken.

---

## What shipped

- **`findRunsByIssue`** on all four store seams in one commit (port, `RowStore` interface,
  sqlite impl, `asDomainStore`, `InMemoryStore`) with a parity test on both stores — the
  *history* question, documented against `findActiveRunByIssue`'s *liveness* question.
- **`run.requested` carries a required `trigger: 'assignment' | 'reconcile'`**, doc-commented
  with D-1's evidence table. Omitting it is `TS2322`, measured.
- **The guard**, `run-engine.ts:856`, immediately after the unchanged T78 live-run check.
  T78's check is untouched, so the operator's unassign→reassign retry still works — pinned
  by F3 going red on exactly that test.
- **The deletion**: `recovery.ts`'s private `findActiveRunByIssue` early-out is gone;
  `report.enqueued` observes a run row appearing instead of re-deriving why.
- **The correction**: `run-engine.test.ts`'s comment claiming "the guard against an automatic
  retry loop is the reconciliation watermark" now says the watermark guards nothing and
  points at `trigger`. The test itself is unchanged and green.
- **TRAPS T107** recorded, phases 3/6/7, cross-referencing T78.
- The accepted limitation from D-1 (daemon down across the whole unassign→reassign) is a
  `ponytail:` line in the engine naming re-assign-with-the-daemon-up as the recovery.

## Success criteria

- [x] `npm run verify` green, **590** tests (>=589), zero regressions from 584
- [x] The qa-roundtrip loop test was observed RED against today's code before the fix
- [x] All three Task 3 falsifications run and reverted, plus T1/T2/T4's
- [x] Exactly one site decides whether a `run.requested` is honoured
- [x] The operator can start the daemon on a workspace containing COD-2 without it re-running

## Self-Check: PASSED

All four commits present in `git log`; every touched source file and both new test bodies
exist on disk; `npm run verify` re-run at HEAD: 590/590, smoke green.
