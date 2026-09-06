---
phase: 06-orchestration
plan: 03
subsystem: orchestration
tags: [questions, correlation, deadline, sweep, qa, security]
requires:
  - src/domain/types.ts
  - src/domain/ports.ts
  - src/domain/index.ts
  - src/orchestration/run-engine.ts
provides:
  - correlate (pure, reused verbatim by 06-04's boot recovery)
  - createQuestions.ingestComment / sweep / openQuestion / applyAnswer
  - AnswerComment / Correlation types
affects:
  - 06-04 (boot recovery imports correlate and feeds it API-listed comments)
  - 03 (ingress builds AnswerComment and calls ingestComment)
  - 04 (owns delimiting and sanitising the answer text in the resume prompt)
  - 07 (composition root drives sweep() from the daemon tick)
tech-stack:
  added: []
  patterns:
    - "The deadline is a column and expiry is a query -- no process-local timer anywhere"
    - "Correlation is a pure function with two tiers, so one entry point cannot diverge from the other"
    - "The bot-author drop lives inside correlate(), not at the ingress boundary"
key-files:
  created:
    - src/orchestration/questions.test.ts
  modified:
    - src/orchestration/questions.ts
decisions:
  - "The bot-author drop is inside correlate() and tests both the author id and BOT_COMMENT_MARKER_PREFIX, because boot recovery never passes ingress's four guards and a cached bot id goes stale when the bot user is re-created"
  - "A threaded comment whose parentId matches no open question returns 'unknown_thread' and does NOT fall through to tier 2 -- it is a reply in somebody else's thread, not a top-level reply"
  - "openQuestion posts the question comment itself and stores the returned id, because without linearCommentId tier 1 can never fire"
  - "Toggles are resolved from the run row's repoDir, not by re-fetching the issue, so a mapping edited mid-run cannot change a live run's settings"
  - "The expiry claim is the question row's own status plus a small in-process map; the map carries the answering author and the terminal status that applyAnswer's engine-fixed two-argument signature cannot"
metrics:
  duration: ~40m
  completed: 2026-09-06
status: complete
---

# Phase 6 Plan 03: Question Correlation and the Durable Deadline Summary

Answer correlation is threaded-first with a guarded top-level fallback, and the
four-hour deadline is an absolute epoch-millisecond column swept by a tick — so a
question opened by one module instance still expires under a different instance
over the same store, which is the assertion that proves the deadline is data and
not a timer.

## What was built

| Symbol | Role |
|---|---|
| `correlate(comment, openQuestions, botUserId)` | **Pure.** Returns `matched` (with the tier), `ambiguous`, or `none` (with a reason). Never a guess. Exported for 06-04's boot recovery. |
| `AnswerComment` | The structural shape correlation needs from a Linear comment: `id`, `issueId`, `parentId`, `body`, `authorId`, `authorName`. |
| `ingestComment(comment)` | The impure wrapper: loads the issue's open questions, correlates, and on a match resumes the run. |
| `openQuestion(runId, text, assumption)` | Posts the question, stores the comment id, writes `deadlineAt`, transitions to `awaiting_answer`. Returns `null` when the mapping has the flow off. |
| `applyAnswer(questionId, answer)` | Called back by the engine once it holds a slot. Writes `answered` or `expired`, records the author, transitions to `running`. |
| `sweep(now)` | Expires every `open` question whose stored deadline has passed. Driven by Phase 7's tick. |

## The load-bearing bits

**No `setTimeout` or `setInterval` appears in `questions.ts`.** The deadline is
`deadlineAt`, an absolute instant resolved at open time and written to the row.
Expiry is `store.expiredQuestions(now)`. The restart test constructs a module,
opens a question, throws that module away, constructs a fresh one over the same
`InMemoryStore`, and sweeps past the deadline — it still expires, and the
discarded instance does nothing. A timer implementation fails that test, which is
the entire reason it is written that way.

**Correlation consults no ordering.** There is no sort, no `mostRecent`, no
`createdAt` comparison anywhere in the module. The order-independence test passes
the same two questions in both argument orders and asserts that a threaded reply
to the *older* one resolves the older one — recency-based correlation resolves the
newer and passes only one of the two orderings.

**The bot-author drop is at the top of `correlate`, not at ingress.** Two
independent tests (author id, and `isBotAuthoredBody` on the body) because the
actor can be null on a comment posted through the API, and a cached bot id goes
stale the day the bot user is re-created. Phase 3's four ingress guards are real
but boot recovery is a second entry point that skips every one of them.

**Tier 1 does not fall through to tier 2.** A comment carrying a `parentId` that
matches no open question is a reply in an unrelated thread; letting it reach the
exactly-one-open-question fallback would make the fallback absorb comments it has
no business absorbing (T-06-12).

## Traps honoured

- **T11 / D-04** — no in-process wait of any kind. `openQuestion` returns as soon
  as the row is written; the child is already gone. Nothing here polls or blocks.
- **T32** — `BOT_COMMENT_MARKER_PREFIX`, `QUESTION_MARKER_PREFIX`,
  `isBotAuthoredBody` and `resolveToggles` are all imported from the
  `src/domain/index.js` barrel. Nothing is declared, re-exported or re-derived
  locally.
- **T31** — this plan reads no agent result, so `structured_output` versus
  `result` does not arise here. Recorded for Phase 4 below: the resume path this
  module triggers produces a session whose `stop_reason` is `"tool_use"`, so any
  `end_turn` check on the resumed spawn fires on every answered question.
- **T16** — only the binding nine `RunState` literals appear (`awaiting_answer`,
  `running`). No `agent_running` / `worktree_ready` vocabulary.
- **T17** — no retry machinery. An expired question resumes once, on the
  assumption, and never re-asks.

## Security obligations transferred (do not let these fall between phases)

**T-06-11 — the answer text is untrusted input to a process running with the
operator's shell.** This module treats it as opaque data: the body goes into the
`question.answered` event and the `questions.answer` column byte-for-byte, is
never interpolated into anything the orchestrator itself interprets, and is never
re-parsed to recover which question it belongs to. A test asserts the round trip
preserves a hostile string including a zero-width character.

> **Phase 4 owns the rest.** The resume-prompt composition in
> `src/execution/prompt.ts` must delimit the answer as untrusted data and strip
> control and zero-width characters before it reaches `claude -p` (AGNT security
> criterion 6). Deliberately **not** built here: stripping at this layer would
> corrupt the stored audit record of what the human actually wrote, and would
> leave the *expiry* path (whose text is the agent's own assumption) sanitised by
> a different code path than the answer path.

**T-06-13** — correlation reads the stored `linearCommentId` and never the comment
body, so editing a comment after the fact cannot re-target an answer. Research's
tier-2 short-code-in-the-body matcher was deliberately **not** built for this
reason; `QUESTION_MARKER_PREFIX` is written into the question footer as operator
UX only, and nothing reads it back.

## Contract additions requested

Nothing under `src/domain/` was created or edited, and `run-engine.ts` was not
touched. Everything below is a name this plan calls that the ADDENDUM does not fix
by text.

### `src/domain/ports.ts` — `DomainEvent` (**the one that needs a decision**)

```ts
/**
 * NEW. Resume a run with an input that is not an answer to a stored question.
 * QA-07's disabled-question-flow branch has no question row by construction, so
 * it cannot key off `question.answered` (whose engine handler looks the row up
 * and requires status 'open'). The engine handler is the same body as
 * `question.answered` minus the question lookup: acquire a slot, spawn with
 * `--resume` and `input` as the prompt, dispatch the result.
 */
| { kind: 'run.resumed'; runId: RunId; input: string;
    reason: 'question_flow_disabled' }
```

> **Phase 7 / whoever owns `run-engine.ts` at the gate:** this is the only new
> engine capability this plan needs. The alternative considered and rejected was
> writing a throwaway question row for the disabled path purely to satisfy the
> existing event — that reintroduces the row QA-07 exists to avoid, and makes
> "never enters `awaiting_answer`" true only by accident of ordering.

### `src/domain/types.ts` — `PendingQuestion`

```ts
answeredBy: string | null;   // NEW -- the display name of the human whose comment
                             // was correlated. Null for an expiry.
```

### `src/domain/ports.ts` — `Store`

```ts
/**
 * Rows with status = 'open' AND deadline_at <= now. The name is research's;
 * the semantics matter -- it must filter on status, or a swept row comes back
 * on the next tick. (`sweep()` re-checks the status defensively regardless.)
 */
expiredQuestions(now: number): PendingQuestion[];
openQuestionsForIssue(issueId: string): PendingQuestion[];   // as research sketches
getQuestion(id: string): PendingQuestion | undefined;        // already requested by 06-01
updateQuestion(id: string, patch: Partial<PendingQuestion>): void;
insertQuestion(q: PendingQuestion): void;
getRun(id: RunId): Run | undefined;
```

### `src/domain/ports.ts` — `LinearClient`

```ts
createComment(issueId: string, body: string,
              parentId?: string): Promise<{ id: string }>;   // as research sketches
```

`QuestionsDeps` now takes `linear: LinearClient`. **Phase 7's composition root
must wire it**, or `openQuestion` cannot store a `linearCommentId` and tier 1
silently never fires — the worst failure shape available to this module, because
tier 2 would keep working for single-question tickets and hide it.

### `src/domain/ports.ts` — `Config` / `MappingToggles`

```ts
config.botUserId: string;                 // top level, as ARCHITECTURE.md has it
config.defaults: MappingToggles;
config.mappings: ProjectMapping[] | Record<string, ProjectMapping>;
```

`MappingToggles` must carry both:

```ts
questionTimeoutMs?: number;   // D-05, per-mapping override of the 4h default
questionFlow: boolean;        // QA-07 -- one of the six CONF-02 toggles
```

`questionFlow` is the CONF-02 toggle listed as "the question flow" in D-09; this
plan needs a concrete field name and picked that one. Rename at the gate if
Phase 1 chose differently — it is read in exactly one place (`togglesFor`).

### `src/domain/types.ts` — `resolveToggles`

```ts
resolveToggles(defaults: MappingToggles,
               mapping: ProjectMapping): MappingToggles;
```

Called as `resolveToggles(config.defaults, mapping)`; an unmapped run falls back
to `config.defaults` directly rather than passing `undefined`.

### Should `AnswerComment` move to `src/domain/`?

Probably yes, as `LinearComment`, because **Phase 3's ingress constructs it** and
06-04's recovery constructs it too. It is defined and exported from
`questions.ts` for now so this plan is self-contained and 06-04 can import it
without waiting on the domain. If Phase 1 promotes it, `questions.ts` should
`import type { LinearComment }` and delete the local copy — the field set must
stay `{ id, issueId, parentId, body, authorId, authorName }`.

## Deviations from Plan

**1. [Rule 2 - missing critical functionality] `openQuestion` posts the question comment**

- **Found during:** Task 1
- **Issue:** Tier 1 correlation matches `comment.parentId` against
  `questions.linear_comment_id`, but nothing in the codebase ever set that column
  — 06-01 left it `null`, and no other 06-* plan or Phase 5 plan claims the
  write. Tier 1 would have been dead code that grep-verifies fine and fails only
  in production, with tier 2 masking it on every single-question ticket.
- **Fix:** `openQuestion` calls `linear.createComment(issueId, body)` and stores
  the returned id. The body carries `BOT_COMMENT_MARKER_PREFIX` (the loop guard)
  and a `QUESTION_MARKER_PREFIX` short code as operator UX.
- **Seam:** Phase 5's `LinearCommentChannel` is specified to "return the posted
  comment id" for `question_asked` emissions. If Phase 7 wires the notifier
  through here instead, the change is the one `post()` call — the stored column
  and every correlation path are unaffected.
- **Files modified:** `src/orchestration/questions.ts`
- **Commit:** 18c7202

**2. [Rule 2] The whole module landed in Task 1's commit; Task 2's commit is its tests**

- `sweep`, the toggle branch and the `resolutions` map are all reachable from
  `openQuestion`, so shipping the blocking branch without the non-blocking one
  would have been a fictional intermediate state. Task 2's commit adds the
  deadline, restart, idempotence and QA-07 tests plus the defensive
  `q.status !== 'open'` guard in `sweep`.

**3. [Rule 2] The assumption comment is posted unconditionally, not gated on `postLinearComments`**

- An expiry comment is not a notification, it is the audit record for a decision
  the bot made on its own (T-06-15, D-05). Gating it on the comments toggle would
  make the one autonomous decision in the system the one thing invisible on the
  ticket. Flagging it here so the gate can overrule if the operator disagrees.

No architectural deviations (Rule 4). No auth gates. No packages installed
(T-06-SC holds: imports are `src/domain/`, `./run-engine.js`, and `node:crypto`).

## Known Stubs

| Stub | File | Why / who resolves it |
|---|---|---|
| An ambiguous top-level reply is logged, not answered on the ticket | `questions.ts` `ingestComment` | Telling the human "two questions are open, reply in the thread" is genuinely useful and genuinely out of scope for this plan's behavior block. One `post()` call whenever someone wants it. |
| The expiry claim is partly in-process (`resolutions`) | `questions.ts` | Durable half is the row's own status; the map only covers the window before the engine calls back, and losing it to a restart costs one repeated expiry of a row that is still open and still overdue — the correct action anyway. Marked with a `ponytail:` comment naming the upgrade path (a claim column) if a second sweeper ever exists. |
| `maxQuestionRounds` is not enforced | `questions.ts` | Research caps question rounds at 5; `run.questionRound` is never incremented here. Not in this plan's requirements (QA-02/04/05/06/07). Flagging it for the gate — without it a stuck agent can ask indefinitely. |

None prevents the plan's goal: correlation, the deadline, the restart guarantee
and the QA-07 toggle are all fully implemented and asserted.

## Threat Flags

None. No new network surface, no new trust boundary beyond the one the threat
model already names, and no packages installed. The `LinearClient.createComment`
call is outbound to an already-trusted, already-authenticated endpoint.

## Not verified (rush mode)

Per RUSH.md, **no test was executed and no typecheck was run** — there is no
`package.json` and no `node_modules` on this branch. The 24 tests in
`questions.test.ts` are written, not run. First execution is the milestone
integration gate. Every plan-specified `<verify>` grep was executed and passed:

```
FILES_OK
parentId in questions.ts (non-comment):        5   (>= 1)
recency-based correlation:                     0   (== 0)
tier/ambiguity coverage in the test file:      10  (>= 3)
deadlineAt in questions.ts (non-comment):      3   (>= 1)
setTimeout / setInterval in questions.ts:      0   (== 0)
four-hour default:                             1   (>= 1)
restart durability test:                       2   (>= 1)
```

## Self-Check: PASSED

`src/orchestration/questions.ts` and `src/orchestration/questions.test.ts` both
exist on disk; both task commits (`18c7202`, `c5c2e5a`) are present in `git log`.
`git diff --name-only` against the branch point shows only those two files plus
this summary — `run-engine.ts`, `scheduler.ts` and everything under `src/domain/`
are untouched.
