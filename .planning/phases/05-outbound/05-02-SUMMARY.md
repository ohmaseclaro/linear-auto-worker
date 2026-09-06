---
phase: 05-outbound
plan: 2
subsystem: outbound
tags: [notifier, fan-out, logging, slack, linear-comments, retry]
requires:
  - "src/outbound/linear-client.ts (05-01) — LinearClient, LogFn"
  - "src/domain/index.ts — BOT_COMMENT_MARKER_PREFIX (Phase 1 plan 01-02, NOT on this branch yet)"
  - "src/ingress/guards.ts — noteSelfWrite (Phase 3, NOT on this branch yet)"
provides:
  - "src/outbound/notify/notifier.ts — RunEvent, NotifyChannel, Notifier, withBoundedRetry, createNotifier"
  - "src/outbound/notify/log-channel.ts — LogChannel, the non-disableable channel"
  - "src/outbound/notify/linear-channel.ts — LinearCommentChannel, composeBody"
  - "src/outbound/notify/slack-channel.ts — SlackChannel, maskWebhookUrl"
affects:
  - "06-orchestration (RunEngine emits RunEvents; terminal from a finally)"
  - "06-orchestration (Q&A correlation consumes emit()'s linearCommentId)"
  - "03-ingress (suppression:self-write guard is fed by this notifier's noteSelfWrite calls)"
  - "07-integration (wires the real logger, config toggles, and Slack webhook lookup)"
tech-stack:
  added: []
  patterns:
    - "The log channel is a field the constructor builds, not an array entry a caller supplies"
    - "Kind-based gating lives in each channel's enabled(); the fan-out loop is kind-agnostic"
    - "Bounded retry with an injectable delay function — real backoff arithmetic, no real waiting in tests"
    - "Secrets masked at the throw site, not at the log site"
key-files:
  created:
    - src/outbound/notify/notifier.ts
    - src/outbound/notify/notifier.test.ts
    - src/outbound/notify/log-channel.ts
    - src/outbound/notify/linear-channel.ts
    - src/outbound/notify/linear-channel.test.ts
    - src/outbound/notify/slack-channel.ts
    - src/outbound/notify/slack-channel.test.ts
  modified: []
decisions:
  - "Notifier constructs its own LogChannel and accepts only additional channels — D-04 becomes a property of the type rather than a convention a caller must honour"
  - "RunEvent carries mappingId; both toggleable channels gate on it and neither could resolve its own config without it"
  - "composeBody() is exported from linear-channel and reused by slack-channel — one curated template, not two that drift"
  - "The Slack webhook URL is scrubbed inside SlackChannel's own thrown errors, because the notifier logs error strings and a fetch failure quotes the request URL"
metrics:
  duration: ~40m
  completed: 2026-09-06
status: complete
requirements: [DELV-05, NOTF-01, NOTF-02, NOTF-03, NOTF-04, NOTF-05, NOTF-06]
---

# Phase 5 Plan 2: Fan-out Notifier Summary

A `Notifier` whose log channel is a constructor-built field rather than an array entry, so
no construction path omits logging — wrapped around bounded retry that makes `emit()`
structurally incapable of rejecting, which is the precondition for emitting terminal state
from a `finally`.

## What Was Built

| File | Lines | Contents |
|---|---|---|
| `src/outbound/notify/notifier.ts` | 255 | `RunEvent` union, `RunEventKind`, `NotifyChannel`, `NotifyResult`, `RetryOptions`, `withBoundedRetry`, `Notifier`, `createNotifier` |
| `src/outbound/notify/notifier.test.ts` | 322 | 14 tests: backoff arithmetic, log-always, never-rejects, the finally pattern |
| `src/outbound/notify/log-channel.ts` | 64 | `LogChannel` — no config, no toggle, no false path |
| `src/outbound/notify/linear-channel.ts` | 128 | `LinearCommentChannel`, `composeBody` |
| `src/outbound/notify/linear-channel.test.ts` | 197 | 11 tests: marker on every kind, toggle, terminal content, question id |
| `src/outbound/notify/slack-channel.ts` | 98 | `SlackChannel`, `maskWebhookUrl` |
| `src/outbound/notify/slack-channel.test.ts` | 152 | 12 tests: kind gating, the POST, four URL-leak assertions |

### How each load-bearing property is actually enforced

**D-04 — the log channel is structurally non-disableable.** `Notifier` does not accept a
channel array containing a `LogChannel`; it accepts `channels?: NotifyChannel[]` meaning
*additional* channels, and builds `this.logChannel = new LogChannel(opts.log)` itself.
`emit()` awaits it directly, first, ungated and unretried, before the fan-out loop runs.
The consequence the brief asked for: someone adding a fifth channel cannot forget the log
line, because there is no log line to forget — there is no argument, config key, or array
mutation that removes it. Deleting both entries from `createNotifier()`'s array still logs
every event. A test asserts exactly this (`still logs when every other channel is
disabled`), and it is what makes NOTF-05 free: turning `postLinearComments` off for a
mapping costs zero logging by construction, not by a reviewer noticing.

**D-03 — bounded retry, then continue.** `withBoundedRetry(fn, opts, delay)` runs
`opts.attempts` tries with `min(base * 2^(n-1), maxDelayMs)` between them. Default budget
is 3 attempts / 500ms base / 4s cap → **worst case 1.5s of waiting per channel per event**.
That bound is the point: the content being retried is already in the log, so a longer
retry only makes a healthy run look stalled (threat T-05-07). `Promise.allSettled` means
one dead channel cannot starve a healthy sibling, and a permanently-failed channel produces
exactly one `notify.channel_failed` line naming it. `emit()` has no rejecting path — a
channel whose `enabled()` itself throws is caught and skipped too.

**D-05 — terminal from a `finally`.** Not a thing this plan calls, but the thing it makes
safe. Two tests encode the caller contract: work in the `try`, `notifier.emit(terminal)` in
the matching `finally`. Both assert exactly one terminal notification when the `try` throws,
and that the original error still propagates unchanged — a notifier that rejected from
inside a `finally` would silently replace the run's real failure with its own.

**T32 — the marker is imported.** `import { BOT_COMMENT_MARKER_PREFIX } from
'../../domain/index.js'`. Not declared, not re-exported, not re-derived. `QUESTION_MARKER_PREFIX`
appears nowhere in this plan's output — it is Phase 6's correlation concern and an unused
import would be noise. A test loops all five kinds and asserts each posted body starts with
the imported constant.

**Threat T-05-06 — the Slack webhook URL is the posting credential.** Masked to `***` plus
four characters everywhere it appears. The non-obvious half: `SlackChannel` scrubs the URL
out of its *own thrown* messages, not just its log lines, because `Notifier` logs
`err.message` and Node's `fetch` quotes the request URL in some transport failures. Four
tests cover it, including one that simulates exactly that message shape.

## Deviations from Plan

Three, all small.

**1. `RunEvent` gained `mappingId: string` (Rule 3 — blocking).** The plan's field list is
`runId, issueId, issueIdentifier, issueUrl, at`, but it also specifies
`postLinearComments(mappingId)` and `webhookUrl(mappingId)` as the two gates. Neither
`enabled()` could resolve its own config without the mapping on the event. Recorded below
as a contract addition.

**2. `Notifier` builds its own `LogChannel` instead of taking it as the array's first
entry.** The plan says "a fixed channel array whose first entry is always a `LogChannel`
instance". That is a convention a caller can violate — the array is a constructor argument.
Making the log channel a private field the constructor creates is the same guarantee with
no way to opt out, which is what D-04's wording ("structurally", "impossible to add a
notification path that forgets to log") actually asks for.

**3. `composeBody()` is exported from `linear-channel.ts` and imported by
`slack-channel.ts`.** The plan asks Slack for "the same style of content as the Linear
channel's message". Two independent templates would eventually disagree about what a run
just did. Slack wraps the shared summary with the issue identifier and URL, which Slack
lacks the context to supply and Linear does not need.

## Cross-phase obligation accepted mid-plan

The coordinator landed Phase 3's wiring obligation during Task 1: layer 3 of the four-layer
loop prevention (`suppression:self-write`) reads zero until the writer announces its own
writes. `LinearCommentChannel.emit()` now calls `noteSelfWrite('Comment', id)` immediately
after `createComment` resolves.

Two details worth flagging to Phase 7:

- The call is wrapped in try/catch. Not defensive noise — an exception thrown *between* the
  comment landing and `emit()` returning would send the whole emit back through
  `withBoundedRetry` and **post a duplicate comment**. A failure to note the write degrades
  one guard; a duplicate comment feeds the loop those guards exist to stop.
- This notifier performs exactly one kind of Linear write: comment creation. It never edits
  a comment (the editable in-place status comment is a deferred idea in 05-CONTEXT) and
  never transitions issue state — `setIssueState` is called by Phase 6's RunEngine through
  `LinearClient` directly, so **that** write site needs its own `noteSelfWrite('Issue', id)`
  and it is not in this plan's scope.

## Contract additions requested

### 1. `Notifier.emit()` returns `{ linearCommentId?: string }`, not `void`

```ts
export interface NotifyResult { linearCommentId?: string; }
emit(e: RunEvent): Promise<NotifyResult>;
```

Phase 6's Q&A correlation needs the id of the comment carrying the question so an operator
reply can be matched back to the run that asked. The exit-and-`--resume` design (TRAPS T11)
means the asking process is already gone when the answer arrives, so the correlation cannot
live in memory — the id must come back out of the notifier at ask time and be persisted.
`LinearCommentChannel` populates it only for `kind: 'question_asked'`; every other kind
resolves `{}`.

### 2. Final `RunEvent` shape — reconcile against `src/domain/ports.ts`

```ts
export type RunEventKind =
  | 'picked_up' | 'worktree_ready' | 'agent_started' | 'question_asked' | 'terminal';

interface RunEventBase {
  runId: string;
  issueId: string;
  issueIdentifier: string;
  issueUrl: string;
  mappingId: string;   // ADDED — see deviation 1
  at: number;          // epoch ms
}

export type RunEvent =
  | (RunEventBase & { kind: 'picked_up' | 'worktree_ready' | 'agent_started' })
  | (RunEventBase & { kind: 'question_asked'; question: string })
  | (RunEventBase & {
      kind: 'terminal';
      state: 'delivered' | 'partial' | 'failed' | 'cancelled';
      costUsd: number;
      tokensUsed: number;
      prUrl?: string;
      reason?: string;   // a short phrase, never an error object or transcript
    });
```

**Two collision risks the integration gate must settle:**

- **`RunEvent` vs `RunEventRow`.** 01-CONTEXT already records `types.ts: RunEventRow { runId,
  from: RunState | null, to, at, detail }` — the *persisted state-transition row*. This
  plan's `RunEvent` is the *notification* payload. They are different things with names one
  character apart. If `ports.ts` defines a third `RunEvent`, the notifier's must win or be
  renamed (`NotifyEvent` would be the honest name).
- **`kind: 'terminal'` vs `RunState`.** The four terminal literals here are a deliberate
  subset of the locked nine and must stay spelled identically (`cancelled`, two Ls). If
  `ports.ts` exposes a `TerminalRunState`, this file's local one should be deleted in favour
  of it. Note the milestone kinds are *not* states: `worktree_ready` is a notification about
  entering `preparing`, and there is no `awaiting_answer` kind because
  `question_asked` covers it — do not map kinds onto states 1:1.

### 3. `src/domain/index.ts` must export `BOT_COMMENT_MARKER_PREFIX`

Not on this branch — `src/domain/` currently has `types.ts`, `state-machine.ts`,
`errors.ts` and **no `index.ts` barrel at all**. Per T32 and RUSH rule 3 this plan imports
the settled path and did not create the barrel (that is Phase 1 plan 01-02's file).

Required for `src/outbound/notify/linear-channel.ts` to resolve:

```ts
// src/domain/index.ts
export const BOT_COMMENT_MARKER_PREFIX: string;   // typed `string`, prefixes a comment body
```

### 4. `src/ingress/guards.ts` must export `noteSelfWrite`

Also not on this branch (merging in parallel). The exact call site written:

```ts
noteSelfWrite('Comment', commentId);   // entityType, entityId — void return, sync
```

If Phase 3's signature is `async`, the call still compiles (the result is discarded) but the
try/catch stops guarding — an async rejection would become an unhandled rejection rather
than the caught, logged degradation described above. **If `noteSelfWrite` returns a
Promise, this call must become `await`ed inside the same try/catch.** Flag at integration.

### 5. `LogFn` is reused from 05-01, and two messages want `warn` level

`Notifier`, `LogChannel`, `LinearCommentChannel` and `SlackChannel` all take the same
`LogFn = (fields, msg) => void` that `LinearClientImpl` takes, defaulting to a no-op where
optional. `LogFn` carries no level, so failure lines are distinguished by message name plus
a `severity: 'warn'` field (named `severity`, not `level`, so it cannot collide with pino's
own field). Phase 7 should route these two to `logger.warn`:

- `notify.channel_failed` — a channel exhausted its retry budget
- `notify.slack_rejected` — Slack returned non-2xx

The full message vocabulary this module emits, for the log-is-the-UI grep surface:
`run.picked_up`, `run.worktree_ready`, `run.agent_started`, `run.question_asked`,
`run.terminal`, `notify.channel_failed`, `notify.slack_rejected`,
`notify.self_write_note_failed`.

If `ports.ts` defines a `Logger` port, `LogFn` should be replaced by it at integration —
same note 05-01 made, same two shapes.

## Known Stubs

None. Every exported symbol has a working implementation; nothing returns a hardcoded
empty value or placeholder text.

The three unresolvable imports (`../../domain/index.js`, `../ingress/guards.js` via
`../../ingress/guards.js`, and `@linear/sdk` transitively through `linear-client.ts`) are
the rush-mode contract, not stubs — items 3 and 4 above are what closes them.

## Deferred Issues

**No typecheck, no test execution.** Per RUSH.md rule 4 and this plan's own `<verification>`
block, there is no `node_modules` on this branch. All three `<verify>` blocks are structural
greps and all three passed. The 37 tests across three files are written to run at the Phase 7
integration gate (`tsc && node --test dist`, per T34's resolution — note they must run
against `dist`, not `src`, because `node --test` cannot resolve the `.js` specifiers these
files use).

Static review caught one thing a compiler would have: a bare `as Response` assertion on a
two-property object literal in `slack-channel.test.ts` is an invalid conversion. Fixed
(`as unknown as Response`, commit `421a614`). Remaining compile risk is concentrated in the
two unresolvable imports above rather than in this plan's own code.

## Threat Flags

None. No new network endpoint, auth path, or schema surface beyond the one outbound POST
already in the plan's threat register (T-05-06).

## Self-Check: PASSED

- `src/outbound/notify/notifier.ts` — FOUND
- `src/outbound/notify/notifier.test.ts` — FOUND
- `src/outbound/notify/log-channel.ts` — FOUND
- `src/outbound/notify/linear-channel.ts` — FOUND
- `src/outbound/notify/linear-channel.test.ts` — FOUND
- `src/outbound/notify/slack-channel.ts` — FOUND
- `src/outbound/notify/slack-channel.test.ts` — FOUND
- `78beef1` `test(05-02): add failing tests for the fan-out notifier core` — FOUND
- `27e4df8` `feat(05-02): fan-out notifier core with a non-disableable log channel` — FOUND
- `9e6ade0` `feat(05-02): Linear comment channel carrying the imported self-event marker` — FOUND
- `a476852` `feat(05-02): Slack channel for terminal and question events, plus notifier wiring` — FOUND
- `421a614` `fix(05-02): widen the stubbed fetch Response cast so tsc accepts it` — FOUND
