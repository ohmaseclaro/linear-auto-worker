# Phase 5: Outbound - Context

**Gathered:** 2026-09-06
**Status:** Ready for planning

<domain>
## Phase Boundary

One typed facade through which every Linear call passes, plus a fan-out notifier whose log
channel cannot be disabled. Nothing that happens goes unlogged.

**Merge gate:** Phase 3's self-event filter (HOOK-07) must be in place before this layer
writes to Linear in a live daemon. Without it the first end-to-end test loops until the
API budget is gone.
</domain>

<decisions>
## Implementation Decisions

- **D-01:** Linear progress is **milestones only, roughly 4-6 per run** — picked up,
  worktree ready, agent started, question asked, PR opened, terminal. Not a stream of
  steps. Every comment the bot posts is itself an event the four loop guards must filter,
  so comment volume is not free.
- **D-02:** Slack fires on **terminal states and on a question being asked** (NOTF-03).
  Slack is the channel that reaches the operator when they are not looking at Linear, so
  it fires exactly when action is needed.
- **D-03:** A failing notification channel **retries with backoff, then continues**. It
  never fails the run and the notifier never throws upward (NOTF-06). Chosen over
  log-and-continue by the operator. Constraint: backoff must be bounded so a run does not
  appear stalled while retrying a notification whose content is already in the log.
- **D-04:** The **log channel is non-disableable** — structurally a channel in the fan-out
  rather than a peer call site, so it is impossible to add a notification path that
  forgets to log. Every state transition produces one structured, greppable line carrying
  run ID and issue ID, including when Linear comments and Slack are both off for that
  mapping.
- **D-05:** Terminal state is emitted from a `finally`, so a crash, timeout, or mid-run
  restart still produces exactly one. It carries the run's cost and token usage.
- **D-06:** The In Progress workflow state is resolved **by `WorkflowState.type ==
  'started'`, cached per team at boot** — never by name (teams rename it to "Doing",
  "Active") and never a hardcoded UUID.
- **D-07:** Rate limiting is detected by `errors[].extensions.code === "RATELIMITED"` on
  an **HTTP 400**, never by status 429 — any `status === 429` branch is dead code that
  never executes. Honour `X-RateLimit-Requests-Reset` (UTC epoch **milliseconds**); log
  `X-Complexity` per response. Budgets: 2,500 req/hr and an independent 3M complexity
  points/hr with a 10,000-point per-query ceiling.
- **D-08:** Personal API key auth header carries **no `Bearer` prefix`** —
  `Authorization: <KEY>`.
- **D-09:** The self-event marker prefix is imported from the single shared module Phase 3
  owns (03-CONTEXT D-07). Do not define a second copy.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Binding contract (read first)
- `.planning/phases/01-domain-contract-state-machine-schema/01-CONTEXT.md` — **binding**.
  Its ADDENDUM fixes the exact state literals, table names, config shape and module paths.
  All eight phases were fanned out simultaneously under rush mode, so this text — not the
  code, which may not exist on your branch yet — is the contract. Import from
  `src/domain/`; do not define your own copy of anything it names. If you need a port
  method that does not exist, record it in your SUMMARY under `Contract additions
  requested` rather than editing `src/domain/`.
- `.planning/TRAPS.md` — running ledger of verified footguns. Read every row.

### Project
- `.planning/PROJECT.md` — Key Decisions table and Constraints
- `.planning/REQUIREMENTS.md` — this phase's mapped requirement IDs
- `.planning/ROADMAP.md` — this phase's goal and success criteria

### Research
- `.planning/research/SUMMARY.md` — § Corrections to PROJECT.md, § Non-Negotiable
  Invariants, § Build Order Constraints
- `.planning/research/PITFALLS.md` — the failure modes this phase must avoid
- `.planning/research/STACK.md` — pinned versions and library idioms
- `.planning/research/ARCHITECTURE.md` — five-layer decomposition

</canonical_refs>

<code_context>
## Existing Code Insights

Greenfield. All eight phases are being built simultaneously in isolated worktrees under
rush mode, so no sibling phase's code is on your branch and none of it can be imported.
Build against the binding contract text in `01-CONTEXT.md` and against the in-memory
fakes it specifies. Do not attempt to read or import another phase's files.

</code_context>

<specifics>
## Specific Ideas

Given no dashboard, the structured log **is** the UI. Treat log line quality as a
deliverable, not a debugging aid.

</specifics>

<deferred>
## Deferred Ideas

- **Editable in-place status comment** with live detail. Rejected for now: Linear's own
  best-practices page says comments are editable and therefore unreliable for
  reconstructing agent conversation state.

</deferred>

---

*Phase: 5-Outbound*
*Context gathered: 2026-09-06*
