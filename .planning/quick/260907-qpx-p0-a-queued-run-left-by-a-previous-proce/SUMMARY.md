---
task: qpx — P0, a run left `queued` by a previous process is never dispatched
status: complete
gate: npm run verify — 594/594 green (590 at start, +4), boot smoke green with 4 new checks
commits:
  - ed1c776 fix(engine): dispatch runs left queued by a previous process
  - fe4c1e1 test(engine): pin the drain's boundaries — terminal, FIFO, no double-drive
  - 8b04af4 chore(domain): delete the dead resumable field; name attempt vestigial
---

# A Ctrl-C no longer costs a re-assignment — and the plan was wrong twice, measured both times

`npm run verify`: **590/590 -> 594/594**, boot smoke green including a second boot.
`Store.nextQueued` is called by something for the first time since it was written.

Two of the plan's own claims did not survive contact with execution. Both are recorded
below rather than quietly worked around, and one of them (§4.2) means the `driving` guard
is **not** proved on the live path — only at unit level.

---

## 1. The mandatory RED, verbatim

Task 1 appended a **second boot** to `scripts/boot-smoke.ts` and ran it against unmodified
`src/`:

```
SMOKE FAILED
Error: timed out after 2000ms waiting for the requeued run to be dispatched on the next boot
    at until (/Users/augustoclaro/ohmaseclaro/linear-auto-worker/src/cli/daemon-fixture.ts:300:13)
    at async main (/Users/augustoclaro/ohmaseclaro/linear-auto-worker/scripts/boot-smoke.ts:329:5)
```

Failing on check 1, at the `until` label the plan named, not on a boot error and not on a
setup timeout. This exact text is in `ed1c776`'s commit body.

**GREEN, after `ed1c776`:**

```
{"runIds":["2a66caf1-…"],"msg":"dispatched runs left queued by a previous process"}
{"runId":"2a66caf1-…","from":"queued","to":"preparing","msg":"run transitioned"}
  ok  the requeued run left `queued` on the next boot, by its OWN id
  ok  it was RESUMED, not re-created — one run row for the issue (got 1)
  ok  the redriven run got a FRESH session id (a spent --session-id is a hard CLI error)
  ok  the shutdown note was cleared when the run resumed
```

### 1.1 The first RED was VACUOUS, and the plan is what caught it

The first version of the assertion read the run's whole `run_events` history for a
`queued -> preparing` row — and **passed against unmodified `src/`**:

```
  ok  the requeued run left `queued` on the next boot, by its OWN id
  ok  it was RESUMED, not re-created — one run row for the issue (got 1)
SMOKE FAILED
Error: the redriven run got a FRESH session id (a spent --session-id is a hard CLI error)
```

The run *already had* that edge: the shutdown case above manufactures the in-flight run by
transitioning it `queued -> preparing -> running` by hand. The plan's `eventsBefore`
watermark — which I had dropped as an unused variable — is precisely the fix. It is now
read from `reopened` before the connection closes, and the assertion slices from it. Had
the vacuous version shipped, the drain could have been deleted entirely and this check
would still have been green.

---

## 2. The three non-vacuity results the plan demanded

| # | Claim | Result |
|---|---|---|
| 1 | The assertion is on a `run_events` row written **in the same transaction** as the state write | Holds. `transition()` is the single writer of `runs.state` and `store.transaction(() => { updateRun; appendRunEvent })` is one call (Phase 1 D-03). The event cannot be emitted-away without the state write disappearing with it. |
| 2 | `findRunsByIssue(ISSUE_ID) === 1`, so the reconciliation poll is not the actor being credited | Holds, **and the poll genuinely ran**: `{"issueId":"issue-uuid","msg":"a run is already live for this issue; ignoring"}` in the second boot's log. T107's guard refused it, so the drain is the only possible actor. Both halves of this check flip together if that ever stops being true. |
| 3 | **T99: wired, not merely implemented.** Delete the one `daemon.ts` call line | **Measured.** `npm test` stays **590/590 GREEN**; `npm run smoke` goes **RED** on the same 2000ms timeout. The unit suite cannot see the wire; the smoke can. Line restored, verify re-run green. |

---

## 3. Falsification, per case, measured

Every break was applied, compiled through `tsc`, run, and reverted.

### 3.1 Task 2 — the wire

| Break | Expected | Measured |
|---|---|---|
| (a) delete `engine.dispatchQueued();` from `daemon.ts` step 8b | unit GREEN, smoke RED | **`# pass 590 / # fail 0`**, smoke `Error: timed out after 2000ms waiting for the requeued run to be dispatched on the next boot` ✅ |
| (b1) move the call to BEFORE `scheduler.start()` | still passes (drivers park, `start()` admits) | **SMOKE PASSED** ✅ |
| (b2) (b1) **plus** delete the `!driving.has(r.id)` filter | smoke RED on check 2, or two `worktree.create` | **SMOKE PASSED — did not go red.** See §4.2. ❌ |

### 3.2 Task 3 — the rules (`run-engine.test.ts`, 16 subtests)

| Break | Expected | Measured |
|---|---|---|
| 1. drop `sessionId: randomUUID()` from the drain's `updateRun` | test 1 red on the session id | `not ok 13 - a run left queued by a previous process is dispatched with a FRESH session id` — **15 pass / 1 fail** ✅ |
| 2. widen the read to `listByState('queued', 'failed')` | test 2 red | `not ok 14 - the drain never touches a terminal run (OPS-04 / T17)` **and** `not ok 16 - …oldest-first…` as collateral — **14 pass / 2 fail** ✅ |
| 3. delete the `!driving.has(r.id)` filter | test 3 red, double-drive | `not ok 15 - the drain does not double-drive a run that already has a driver`, `actual ['e61ce1f5-…'] / expected []` — **15 pass / 1 fail** ✅ |
| 4. swap `nextQueued(DRAIN_LIMIT)` for `listByState('queued')` | test 4 red on order | `not ok 16 - the drain admits oldest-first across a restart` — **15 pass / 1 fail** ✅ |

Break 2 taking FIFO down with it is the honest reading: `listByState` loses the
`ORDER BY created_at ASC` at the same time it widens the state set. Break 4 isolates the
ordering half on its own, which is why both exist.

### 3.3 Task 4 — `resumable`

Expected: re-add the field, write it through `store.updateRun`, `tsc` fails on `RunRow`.
**Measured: `tsc` passes clean.** See §4.1.

---

## 4. Deviations from the plan

### 4.1 `resumable` was dead by DISUSE, not structurally — the plan's proof does not exist

The plan (and the diagnosis it rests on) says `resumable` "is not in `sqlite-store.ts`'s
`RunRow`, so it is unreachable from both directions", and asks for that to be proved by
re-adding the field and watching `tsc` fail.

`tsc` does not fail. `domain-store.ts`'s `toRow` is a generic `Object.entries` key-copier
and `toRun` is a `{...row}` spread, both behind `as unknown as` casts, so `RunRow`'s
omission is erased on the way in and on the way out. Probed against a real SQLite file
through `asDomainStore(createSqliteStore(openStore(...)))` — the exact composition
`daemon.ts:494` builds:

```
resumable read back as: 1
keys include resumable: true
```

So the write lands in the column and reads back. The field was empty because **nothing
wrote it**, and for no stronger reason. Deleted anyway — the reason to delete stands, since
D-6 chose a fresh session id and nothing will ever write it — but the migration comment now
records the measured claim instead of the stronger false one, because the stronger one
would have been believed by the next reader.

**The column is LEFT IN PLACE.** `001-init.ts` gains a comment only; the SQL DDL is
unchanged and no migration 002 was written. Dropping a shipped column for zero behaviour
change is not worth a migration, and editing the shipped one to remove it is worse than a
labelled vestige.

### 4.2 Falsification (b2) does not go red, and the `driving` guard is therefore unproved on the live path

The plan expects that removing the `driving` filter makes the smoke double-drive. It does
not, and the reason is specific: the smoke's second boot has **no swept run**. Its only
issue is `SMK-1`, which already has a run row, so `sweepMissedWork` is correctly refused by
T107 (`'a run is already live for this issue; ignoring'`). With exactly one `queued` row and
exactly one drain call, there is no second driver for the filter to suppress — regardless of
where the drain sits or whether the filter exists.

The guard is real and load-bearing on a **real** boot, where the sweep does enqueue
newly-assigned tickets: `scheduler.pause()` at `daemon.ts:529` means those drivers genuinely
park, `scheduler.start()` at `:700` resolves their slot promises as microtasks, and step 8b
at `:705` runs in the very next synchronous statement with the rows still at `queued`.

It is proved by **`run-engine.test.ts` test 3** instead (§3.2 break 3), which constructs
that window deterministically and measures the double-drive as
`actual ['e61ce1f5-…'] / expected []`.

**Not fixed by extending the smoke, deliberately.** Manufacturing a swept run means adding
a second bot-assigned issue whose run then fails on T87's branch-resolution exhaustion, and
the harm a double-drive causes there is a *timing-dependent* second `transition` throwing
`IllegalTransitionError` — a fragile assertion for a guard the unit test already pins with
a crisp one. Recorded rather than papered over.

### 4.3 Two smaller ones

- `agent: { run: … }` in the smoke's second boot needed `onProgress: () => {}` too —
  `AgentRunner` has two members and `daemon.ts:549` calls the second one.
- The plan's `eventsBefore` variable is not optional bookkeeping; it is the whole
  non-vacuity of check 1 (§1.1).

---

## 5. Two things `tsc` was green for and execution was not

Both found inside this task, both worth the same note as T108's own lesson.

1. **A backtick inside the migration's SQL comment.** `001-init.ts`'s DDL is a template
   literal. A comment containing `` `RunRow` `` closes it. First occurrence produced nine
   `TS1005` parse errors — loud. The second occurrence, `` `as unknown as` ``, **compiled
   clean** and truncated the SQL, which surfaced only when a test opened a database:
   `migration 1 (init) failed: SqliteError: incomplete input`, 62 tests down. The comment
   now says so and carries no backticks.
2. The first RED was vacuous (§1.1) and only a *count* — not a type, not a shape — could
   tell the difference.

---

## 6. What shipped

**`src/orchestration/run-engine.ts`**
- `dispatchQueued(): RunId[]` on the interface and in the implementation. Reads
  `store.nextQueued(DRAIN_LIMIT)` — the dead query, wired — narrows to `kind === 'repo'`,
  filters out `driving`, mints a fresh `sessionId` and clears `failureReason` in one
  `updateRun`, then `track(drive(run.id, null, scheduler.acquire(run.id)))`.
  `DRAIN_LIMIT = 1000` with a `ponytail:` comment naming the ceiling.
- A `driving: Set<RunId>`, added in `drive()` **before** `await slot` and removed in the
  existing `finally`. Not `aborts`: `stop()` depends on `aborts` holding only runs that
  already have a slot, and widening it would make Ctrl-C on an idle daemon wait out the
  full child-reap budget.

**`src/cli/daemon.ts`** — step 8b, one call, immediately after `scheduler.start()`.

**`src/orchestration/recovery.ts`** — the `queued: 'leave'` comment no longer names a
mechanism that does not exist.

**`scripts/boot-smoke.ts`** — a second boot on the same workspace, +4 checks.

**`src/orchestration/run-engine.test.ts`** — 4 tests, each with a named break;
`spyWorktrees` gains `requireAck` (default `true`, every existing call site unchanged) so a
deliberately-not-re-acknowledging redrive is not failed for being correct.

**`src/domain/types.ts`** — `resumable` deleted; `attempt` labelled vestigial.

**`.planning/TRAPS.md`** — T108.

---

## 7. Success criteria

- [x] `npm run verify` green: **594/594**, boot smoke passing including the second boot.
- [x] A run requeued by Ctrl-C runs on the next `law start`, with no manual re-assignment.
- [x] The redriven run is the SAME run row — one row per issue, no second PR (T107 intact,
      and re-measured live: the second boot's poll fires and is refused).
- [x] The exact Task 1 red output is in Task 2's commit body.
- [ ] **Every one of the eight named falsifications ran and reverted** — seven did.
      (b2) ran and did **not** go red (§4.2); Task 4's `tsc` falsification ran and the
      claim it tests is false (§4.1). Neither is unproved work: both are replaced by a
      measurement that IS true, and both are written up rather than restated.

## 8. Known follow-ups (none blocking)

- `attempt` is still write-only-always-zero at the migration, `RunRow`, `fanout.ts` ×2 and
  five fixtures. Kept deliberately (D-4); deleting it is a separate no-behaviour-change
  chore.
- The `resumable` COLUMN survives as a labelled vestige. A migration 002 dropping it buys
  nothing today.
- `refreshQueuePositions()` is not called from the drain. `drive`'s `finally` already
  refreshes on every completion, so the first run to finish corrects everyone's comment.
  Add it when a stale "position 3" after a restart actually annoys someone.

---

## Self-Check: PASSED

All eight touched files present on disk; all three commits (`ed1c776`, `fe4c1e1`,
`8b04af4`) present in `git log`. Final `npm run verify` re-run from clean at
**594/594 + smoke green**. WINDOWS ledger entry 9 records §4.2 as an open deviation.
