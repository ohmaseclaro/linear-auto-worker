---
phase: 06-orchestration
plan: 02
subsystem: orchestration
tags: [pickup, cancellation, failure, notifications, state-machine]
requires:
  - src/domain/types.ts
  - src/domain/state-machine.ts
  - src/domain/ports.ts
  - src/domain/errors.ts
  - src/domain/fakes.ts
  - src/domain/index.ts
  - src/orchestration/scheduler.ts (06-01)
  - src/orchestration/questions.ts (06-01)
provides:
  - "RunEngine.cancel / isCancelRequested / refreshQueuePositions (src/orchestration/run-engine.ts)"
  - "the acknowledgement sequence and the kv-resident ack comment id"
  - "the terminal emission point every later phase reports through"
affects:
  - "04 (the supervisor checkpoint reads isCancelRequested)"
  - "03 (routes run.cancelled; owns cancel authenticity)"
  - "05 (the Notifier subsumes the direct linear.createComment calls here)"
  - "07 (shutdown drain and boot recovery both read the cancel flag)"
tech-stack:
  added: []
  patterns:
    - "Ordering expressed structurally: drive() takes the ack comment id as a parameter, so work cannot start before the acknowledgement"
    - "Two-tier cancel driven by RUN_STATE_TABLE[state].hasLiveChild, never by a state-name list"
    - "Per-run notification state lives in `kv`, not in new `runs` columns"
key-files:
  created:
    - src/orchestration/run-engine.test.ts
  modified:
    - src/orchestration/run-engine.ts
decisions:
  - "The ack comment id lives in kv (`ack:<runId>`) as `{commentId, position}` rather than a new `runs` column — restart-safe, no schema change on a table five layers already agree on"
  - "The run parks for its slot BEFORE the acknowledgement, so the ack can carry a real positionOf(); parking holds nothing and spends nothing, so it is not 'work' under D-09"
  - "The cancel-requested flag is kv (`cancel:<runId>`), so it survives a restart and needs no `runs` column"
  - "run.cancelled is issue-scoped and fans out over findActiveRunByIssue, so a multi-repo ticket's N children all stop; engine.cancel(runId) is the per-run primitive underneath"
  - "The published failure reason is `classify(err)` (first line, 200 chars); the raw error only ever reaches the log, whose PATH is what the comment carries"
metrics:
  duration: ~40m
  completed: 2026-09-06
status: complete
---

# Phase 6 Plan 02: Pickup, Cancellation and Terminal Failure Summary

The run engine's non-happy paths are now as deliberate as its happy path: the ticket is
acknowledged, moved to In Progress and subscribed before the worktree port is reachable at
all; a queued run's position is edited into one comment rather than re-posted; cancel is
accepted from every non-terminal state with the two-tier split D-11 specifies; and a failed
run is attempted exactly once, posting a diagnosis and keeping its branch and worktree.

## What was built

| Area | Shape |
|---|---|
| Pickup (D-09, INTK-02/03) | `acknowledge(run)` runs `createComment` → `setIssueState('started')` → `addSubscriber(operator)` and returns the comment id. `drive(runId, ackCommentId, slot)` **takes that id as a parameter** — the work path cannot start without the acknowledgement, because there would be nothing to pass it. |
| Queue position (D-10, INTK-06) | `refreshQueuePositions()` iterates `store.listByState('queued')` and **edits** each run's ack comment when `positionOf()` changed. Called from every driver's `finally`, right after the release that moved everyone up. Never posts a second comment. |
| Cancellation (D-11, INTK-08) | `cancel(runId, reason)` reads `RUN_STATE_TABLE[state]`. Terminal → no-op. `hasLiveChild` → idempotent kv flag + a `run_events` row + `AbortController.abort()`. Otherwise → `finishCancel()` now, closing any open question. `isCancelRequested(runId)` is the read; `checkpoint(runId)` is where the work path honors it. |
| Terminal failure (D-13, OPS-04) | `fail()` writes a classified reason and transitions once. `announceTerminal()` posts the diagnosis with the error and the log path from the `finally`, kv-guarded so it fires exactly once. The worktree cleanup port is **not** called. |

## The load-bearing bits

**Ordering is structural, not documented.** `drive()`'s signature is the enforcement. The
test's worktree port is a spy that **throws** if it is reached before all three Linear calls
are recorded, so an executor that later reorders `handle()` gets a failing test rather than
a ticket that sits visibly untouched while `git fetch` warms a cold repo.

**Parking is not work.** The run calls `scheduler.acquire()` before `acknowledge()` so the
acknowledgement can read a real `positionOf()`. Parking holds no slot, spawns nothing and
touches no repository — it is precisely the thing D-09 is not talking about. Acknowledging
first and parking after would mean the ack could only say "queued" without saying where.

**No state-name special case anywhere.** `cancel()` reads `terminal` and `hasLiveChild` off
the domain table, exactly as `scheduler.ts` reads `holdsSlot`. `run-engine.test.ts` asserts
the rule by iterating `Object.keys(RUN_STATE_TABLE)`, so a tenth state added in Phase 1
cannot escape it — the same shape 06-01 established for slot accounting.

**One comment per queued ticket, proven by arity.** The position test runs five tickets
against a one-slot scheduler with the slot held by an outsider. The fifth ticket's ack is
created once at position 5, then edited to 3, 2 and 1 as the queue drains. The assertions
count creates against updates rather than reading the final body, because "it says position
1" is also true of four separate comments.

## Traps honoured

- **T16** — only the binding nine state literals appear. No `claimed`, `worktree_ready`,
  `agent_running`, `done`, `abandoned` anywhere.
- **T17** — no retry machinery. `grep -icE 'maxAttempts|retryCount|backoff'` over
  non-comment lines returns **0**. `ARCHITECTURE.md`'s `failed → queued` row is not built.
  A test drives a run to `failed`, then fires a fresh `run.requested`, a
  `refreshQueuePositions()`, a `scheduler.syncFromStore()` and a `cancel()` at it, and
  asserts the state is unchanged and the diagnosis was emitted exactly once.
- **T18** — no boot recovery here (06-04 owns it); nothing requeues a `running` row.
- **T32** — `BOT_COMMENT_MARKER_PREFIX` is imported from the `src/domain/index.ts` barrel
  and prefixed onto **every** comment this module posts (ack, position edit, terminal).
  It is not re-declared, re-exported or re-derived. Without it, the bot's own comments
  would look like human answers to Phase 3's correlation tiers and the bot would answer
  itself.

## Threat register dispositions

| Threat | How it landed |
|---|---|
| **T-06-06** (info disclosure, failure path) | The comment carries `classify(err)` — first line, 200 chars — plus the log **path** (`config.logDir/<runId>.log`). Never the log body, never a serialized SDK error. A test asserts a multi-line push error's `headers:` line does not reach the ticket. |
| **T-06-07** (spoofing, cancel path) | **Transferred to Phase 3, as planned.** `handle('run.cancelled')` trusts the routed event by design. Signature verification, actor identity and delivery-ID uniqueness are what must gate `handle()`. Recorded here as the reliance the register asks for: **if Phase 3's gate is weak, a replayed unassignment cancels live work.** |
| **T-06-08** (DoS, pickup path) | Every Linear call in this module goes through `attempt()`, which logs and swallows. A Linear outage degrades ticket visibility; the queue keeps moving. A test drives a full run to `delivered` with `createComment` throwing on every call. |
| **T-06-09** (tampering, terminal path) | `cancel()` returns early on `RUN_STATE_TABLE[state].terminal`, and no transition anywhere targets a state from `failed`. |
| **T-06-10** (repudiation, cancel path) | The flag write appends a `run_events` row (`from === to`, `detail: "cancel requested: …"`), and the eventual transition appends its own. |
| **T-06-SC** | No packages installed. Imports are `src/domain/`, `src/orchestration/` and `node:crypto` only. |

## Contract additions requested

Everything below is a **real call site** in `run-engine.ts`, not speculation. Nothing under
`src/domain/` was created or edited. Where Phase 1 has already chosen a different name,
rename the call sites here — not the domain.

### `src/domain/ports.ts` — `LinearClient`

```ts
/** D-10 / INTK-06: the queue-position comment is EDITED, never re-posted. */
updateComment(commentId: string, body: string): Promise<void>;

/**
 * INTK-03. Assignee-based pickup takes the ticket out of the operator's
 * "Assigned to me" view for the whole run; without the subscription they lose
 * sight of their own ticket.
 */
addSubscriber(issueId: IssueId, userId: string): Promise<void>;
```

Also used, already sketched in research and assumed unchanged:
`getIssue`, `createComment(issueId, body, parentId?)`, `setIssueState(id, 'started' | 'review')`.

### `src/domain/ports.ts` — `Config`

```ts
/** The single operator's Linear user id. Subscribed on every pickup (INTK-03).
 *  The wizard can fill it from `linear.viewer()`. */
operatorUserId: string;

/** Absolute path to the log directory under `~/.linear-auto-worker/`.
 *  The failure diagnosis publishes `${logDir}/${runId}.log` — the PATH only,
 *  never the body (T-06-06). */
logDir: string;
```

Plus everything 06-01 already requested: `concurrency` at the `Config` **top level** (this
plan still reads `config.defaults.concurrency`, matching 06-01's `createScheduler`; if
Phase 1 lands it at the top level, `scheduler.ts` line 51 is the single site to change),
`defaults.{questionTimeoutMs, baseBranch}`, and `mappings` as a `Record`.

### `src/domain/types.ts` — `PendingQuestion`

```ts
/** `cancelled` is NEW: cancelling a run in `awaiting_answer` closes its open
 *  question, and leaving it `open` would let the deadline sweep (06-03) resume
 *  a run that was deliberately stopped. */
status: 'open' | 'answered' | 'expired' | 'cancelled';
```

### `src/domain/ports.ts` — `Store`

```ts
listByState(...states: RunState[]): Run[];   // research sketches it; confirming the call site
kvGet(key: string): string | undefined;      // ditto
kvSet(key: string, value: string): void;     // ditto
```

Three `kv` keys are owned by this module, and **the choice to use `kv` rather than new
`runs` columns is the answer to the plan's "record which" question**:

| Key | Value | Why kv |
|---|---|---|
| `ack:<runId>` | `{"commentId":"…","position":N}` | Survives a restart, so a restarted daemon still **edits** the position comment instead of posting a second one. Costs no migration. |
| `cancel:<runId>` | epoch ms | The cancel-requested flag. Restart-safe; idempotent by construction. |
| `terminal:<runId>` | the terminal state | Guards the terminal emission to exactly once (invariant 11). |

If Phase 1 prefers these as `runs` columns, the change is confined to `readAck` /
`writeAck` / `isCancelRequested` / `announceTerminal`.

### `src/domain/index.ts`

```ts
export const BOT_COMMENT_MARKER_PREFIX: string;   // T32 — the barrel must re-export it
```

### `src/domain/ports.ts` — `DomainEvent`

Used exactly as research sketches it, confirming the shape:

```ts
| { kind: 'run.cancelled'; issueId: IssueId; reason: string }
```

### `src/domain/state-machine.ts` — transitions this plan needs to be legal

```
queued          -> cancelled
preparing       -> cancelled
awaiting_answer -> cancelled
running         -> cancelled     // honored at the checkpoint, not at request time
delivering      -> cancelled
delivering      -> failed        // a rejected push is a failure, not a hang
```

## Deviations from Plan

**1. [Rule 1 - Bug] The agent's own `cancelled` result routed to `failed`**

- **Found during:** Task 2
- **Issue:** 06-01's `dispatch()` sent every non-`complete`, non-`needs_input` result to its
  `default` arm, so `AgentResult { status: 'cancelled' }` — what the runner returns when it
  honors the abort — became a `failed` run with a published diagnosis for work the operator
  deliberately stopped.
- **Fix:** an explicit `case 'cancelled'` routing to `finishCancel()`.
- **Files modified:** `src/orchestration/run-engine.ts`
- **Commit:** 5af92c7

**2. [Rule 2 - missing critical functionality] `announceTerminal()` also called from `finishCancel()`**

- **Found during:** Task 2 self-review
- **Issue:** Invariant 11 was satisfied by the drivers' `finally` blocks — but an
  `awaiting_answer` run has **no driver in flight** (that is the whole point of
  exit-and-resume, D-04). Cancelling one would have transitioned it to `cancelled` and
  posted nothing, which is precisely the silence the invariant exists to prevent.
- **Fix:** `finishCancel()` calls `announceTerminal()` after its transition. The emission is
  kv-guarded, so the other cancel paths — where a driver's `finally` also fires — still
  produce exactly one comment.
- **Files modified:** `src/orchestration/run-engine.ts`
- **Commit:** 5af92c7

**3. [Rule 2] `fail()` gained a `raw` parameter**

- The published reason and the logged error are now different values (T-06-06). Passing the
  raw error separately keeps the full text in the log — which is what the diagnosis's log
  path points the operator at — while only the classified first line reaches the ticket.

**4. Commit boundaries**

- `run-engine.test.ts` covers both tasks and landed whole in the Task 2 commit; the Task 1
  commit carries only the pickup implementation. Splitting one new file across two commits
  needs interactive hunk staging, which rush mode forbids. Both commits are complete states.

No architectural deviations (Rule 4). No auth gates.

## Known Stubs

| Stub | File | Why / who resolves it |
|---|---|---|
| Comments are posted through `linear.createComment` directly, not a `Notifier` | `run-engine.ts` | Phase 5 owns the Notifier and its Slack/log fan-out. Every call site here is already funnelled through `attempt()` and `botBody()`, so swapping in `notifier.emit()` is a mechanical replacement of four call sites. |
| A cancelled run parked in the queue still takes its turn before exiting | `run-engine.ts` `drive()` | Marked with a `ponytail:`-grade note in the summary rather than the code. De-parking needs a `scheduler.withdraw(runId)`; the current behaviour is correct, just not instant. Add it only if queue latency ever matters. |
| Terminal comment bodies are plain one-liners | `run-engine.ts` `terminalText()` | Phase 5 owns comment formatting (timeline, duration, cost). The `failed` arm is the one that is fully specified here, because OPS-04 specifies it. |
| `partial` has no producer yet | `run-engine.ts` | 06-05 derives it from child runs (D-12). `terminalText()` already handles the state so the emission does not have to change later. |

None prevents this plan's goal.

## Threat Flags

None. This plan adds no network surface and no new trust boundary. The one new *outbound*
surface — comments the daemon publishes — is covered by T-06-06 above and by T32's marker.

## Not verified (rush mode)

Per RUSH.md and the plan's own constraint, **no test was executed and no typecheck was run**
— there is no `package.json` and no `node_modules` on this branch. Every plan-specified
`<verify>` grep was executed and passed:

```
FILES_OK
updateComment|commentUpdate|editComment:   1   (need >= 1)
subscriber:                                2   (need >= 1)
test 'before'|'order':                    23   (need >= 1)
test positionOf:                           1   (need >= 1)
cancelRequest:                             5   (need >= 2)
finally:                                   3   (need >= 1)
maxAttempts|retryCount|backoff:            0   (need == 0)
test 'cancel':                            27   (need >= 3)
```

The first real execution of these files is the milestone integration gate.

## Self-Check: PASSED

- `src/orchestration/run-engine.ts` and `src/orchestration/run-engine.test.ts` both exist.
- Both commits are in `git log`: `85851bd`, `5af92c7`.
- `git diff --name-only` against the branch point shows changes confined to
  `src/orchestration/run-engine.ts` and `src/orchestration/run-engine.test.ts`. Nothing
  under `src/domain/` was touched, and **`src/orchestration/questions.ts` was not touched**
  — plan 06-03 owns it in a parallel worktree.
