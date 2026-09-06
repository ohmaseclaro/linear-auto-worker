# Phase 6: Orchestration - Context

**Gathered:** 2026-09-06
**Status:** Ready for planning

<domain>
## Phase Boundary

Runs are queued, driven through the state machine, blocked on humans without cost, and
recovered after a restart. Scheduler semaphore, run engine, question correlation,
restart recovery, multi-repo sub-runs.

Highest bug density in the project, and fully testable against Phase 1's fakes — no
network, no Claude process. A `FakeAgentRunner` scripted to return `needs_input` then
`complete` exercises the entire Q&A round trip.
</domain>

<decisions>
## Implementation Decisions

### Scheduler

- **D-01:** Scheduler and RunEngine are **deliberately split**. Scheduler owns only the
  semaphore ("may another run start?"); RunEngine owns the state machine and is the
  **only** writer of `runs.state`.
- **D-02:** A run in `awaiting_answer` holds **no concurrency slot and has no live
  child**. Count only actively-running agent processes against the cap. This belongs in
  the *scheduler's* definition of done, not the Q&A layer's — it is exactly the rule that
  gets lost between two components. Violating it turns "three open questions" into "the
  daemon is dead", and the operator's natural diagnosis will be wrong, which is what makes
  it expensive.
- **D-03:** A ticket mapped to N repos consumes **N slots** — each sub-run is a
  first-class run with its own worktree, session and state, so each is a real Claude
  process and must count against the cap that exists to bound local RAM.

### Q&A

- **D-04:** Mechanism is **exit-and-`--resume`**, never a blocking in-process wait. An
  MCP long-poll does not block: Claude Code backgrounds any main-conversation MCP call
  still running past ~2 minutes and the agent proceeds **without** the answer, shipping a
  confidently wrong PR. Exiting instead frees the slot, costs zero RAM while waiting, and
  survives a worker restart.
- **D-05:** Deadline is **4 hours, configurable per mapping**. It is **data in SQLite**,
  never a `setTimeout` — a restart erases a timer. On expiry the run resumes with the
  stated assumption and posts that assumption to the ticket.
- **D-06:** Answer correlation is **threaded reply first, with a top-level fallback**:
  match `parentId == ` the question comment id; failing that, accept a non-bot top-level
  comment on an issue holding **exactly one** open question. Replying in the main box
  rather than the thread is the mistake everyone makes, and silently ignoring it looks
  like the bot is broken. *(Boot recovery must also list comments since the watermark on
  issues with open questions — see 03-CONTEXT D-05. Without it an already-answered run
  waits out its full 4 hours.)*

### Recovery

- **D-07:** At boot, runs found mid-flight are handled by state, not uniformly:
  `queued` and `preparing` **requeue** (nothing was spent); `running` and `delivering`
  **fail** with a diagnosis, because an agent session and a partial push cannot be safely
  resumed blind and re-running risks a second PR for work already pushed;
  `awaiting_answer` simply persists, since its deadline is in SQLite.
- **D-08:** Nothing is left as a zombie with a stuck In Progress ticket — every mid-flight
  run is explicitly requeued or failed (OPS-01).

### Pickup and cancellation

- **D-09:** Acknowledgement and the In Progress transition are emitted within **10 seconds**
  of pickup and strictly **before** any worktree or git work. This is an ordering
  constraint, not a performance target. The operator is added as a subscriber at pickup,
  because assignee-based pickup otherwise takes the ticket out of their "Assigned to me"
  view for the duration of the run.
- **D-10:** A queued ticket shows its position in a comment **edited in place**, not
  re-posted.
- **D-11:** Cancel (bot unassigned) is accepted from every non-terminal state.
  `queued`/`preparing`/`awaiting_answer` transition immediately; `running`/`delivering`
  set a cancel-requested flag honored at the next supervisor checkpoint — a pushed branch
  cannot be un-pushed, so an instant transition would lie.

### Multi-repo and failure

- **D-12:** One parent run per ticket, N children (one per repo), each with its own
  worktree, session and state — **not** one session with `--add-dir`. The parent's status
  is **derived** from its children and never stored (Phase 1 D-04), so parent and children
  cannot disagree. Partial success is the normal case: repo A ships its PR even when
  repo B fails.
- **D-13:** A failed run is attempted **exactly once**. It posts a diagnosis with the
  error and log path and leaves the branch and worktree for the operator. No retry loop.

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

This phase has the highest bug density and the cheapest test loop in the project. Test
volume here is worth more than anywhere else, and none of it needs network or a Claude
process.

</specifics>

<deferred>
## Deferred Ideas

None — phase scope is already dense.

</deferred>

---

*Phase: 6-Orchestration*
*Context gathered: 2026-09-06*
