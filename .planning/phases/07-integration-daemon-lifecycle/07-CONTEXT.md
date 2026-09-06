# Phase 7: Integration & Daemon Lifecycle - Context

**Gathered:** 2026-09-06
**Status:** Ready for planning
**Note:** Not separately discussed — derived from locked decisions. This phase also owns
the milestone's integration burden, which rush mode concentrated here.

<domain>
## Phase Boundary

Wire the layers in dependency order and prove the core value hands-off: an issue assigned
to the bot becomes a reviewable pull request. HOOK-01 and OPS-05.

**Wiring order is fixed:** store→engine, then **router→engine before engine→execution**,
then engine→worktree/agent, engine→deliverer, engine→notifier, then the daemon boot
sequence.
</domain>

<decisions>
## Implementation Decisions

- **D-01:** `router→engine` is wired **before** `engine→execution`. A real signed webhook
  producing a `queued` run with execution still faked proves the whole ingress seam while
  the expensive half is still cheap to iterate on. Wiring execution first means every
  ingress bug costs a full Claude session to reproduce.
- **D-02:** The local HTTP server is bound and serving **before** the tunnel opens, so no
  delivery ever hits a live URL backed by nothing.
- **D-03:** SIGINT and SIGTERM shut down in **reverse boot order**: spawned children
  killed (process group, per 04-CONTEXT D-09), tunnel closed, in-flight runs marked. The
  next boot recovers those runs per 06-CONTEXT D-07 rather than stranding them.
- **D-04:** **This phase extends the canonical verify command with a boot smoke test.**
  Phase 1 established `tsc --noEmit && node --test`; from here the same command must also
  boot the daemon far enough to compose the real module graph. This is the only mechanism
  in the milestone that can catch a wiring break — unit tests instantiate against fakes
  and typecheck only checks types, so a module that never wires up what it depends on
  passes both.
- **D-06 (NEW, resolves the planner's open question):** Clean shutdown **transitions**
  in-flight `running`/`delivering` runs to `queued` before exit — it does not merely log
  that they were in flight. With that write in place, 06-CONTEXT D-07's fail-on-`running`
  applies only to an unclean exit, which is the case where push status is unknowable.
  Without it, Ctrl-C costs a manual restart of every live run. See TRAPS T18 and T26.
  Plan 07-05 owns this.
- **D-05:** **Rush-mode integration debt lands here.** All eight phases were built in
  parallel with no typecheck and no tests run, against the binding contract text in
  `01-CONTEXT.md` rather than against compiled code. Expect signature mismatches at the
  merge. Every phase records unmet needs in its SUMMARY under `Contract additions
  requested`; this phase reconciles them into `src/domain/` and fixes the call sites.
  Budget real time for this — it is the deferred cost of the fan-out, not a surprise.

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

Success criteria 1 and 5 need a real Linear workspace, a real ngrok tunnel and a real
`gh` — they are **live-gated**. Build them and defer verification to a HUMAN-UAT
checklist rather than blocking the run.

</specifics>

<deferred>
## Deferred Ideas

None.

</deferred>

---

*Phase: 7-Integration & Daemon Lifecycle*
*Context gathered: 2026-09-06*


---

## HARD DELIVERABLES DISCOVERED DURING THE PARALLEL BUILD

These are not notes. Each is a break that **typechecks clean** and fails silently, so nothing
in the gate will surface them. Phase 7 must do each one explicitly.

1. **Wire the ingress→engine `DomainEvent` mapping** (TRAPS T45). Plan 01-02 unioned both
   producers' kind sets into `ports.ts`, which is correct — and which means the mismatch now
   compiles clean. Ingress emits `issue.assigned` / `issue.unassigned` / `comment.created`;
   the engine switches on `run.requested` / `question.answered` / `run.cancelled` / `ignored`.
   **Unwired, the daemon boots, verifies, and processes nothing.** The five-case mapping table
   is in `01-02-SUMMARY.md`. This is the single highest-risk item in the milestone.
2. **Add `noteSelfWrite('Issue', issueId)` at the `setIssueState` call site** (T49). The
   notifier covers comment writes; nothing covers state transitions. No phase's plan owns
   this seam.
3. **Wire `QuestionsDeps.linear`** (T43). `openQuestion` posts the question comment and stores
   its id — tier-1 answer correlation is dead without it, and the tier-2 fallback masks that
   on every single-question ticket.
4. **Wire `LinearClient`'s `log`** — it defaults to a no-op, so every `linear.ratelimited` and
   budget line is silently dropped. Under D-04 ("the log is the UI") that is a regression.
5. **Apply the 11 reconciliation items R1–R11** listed in `01-02-SUMMARY.md`, including
   `config.defaults.concurrency` → `config.concurrency` and Phase 2's renamed toggles.
6. **Rename the three `kvPut` call sites to `kvSet`** and `tryInsertDelivery` to
   `recordDelivery`, matching the implementation (T46).
7. **Decide `maxQuestionRounds`** (T44) — currently unbounded; an agent can ask forever.
9. **Rewrite `sqlite-store.ts`'s column references against `001-init.ts`** (T53) — four
   divergences that `tsc` structurally cannot detect, because TypeScript does not know SQL
   column names. A green typecheck proves nothing here; the gate must execute a real store
   round-trip.
8. **Expect `logger.test.ts`'s cycle-guard test to FAIL** on the first gate run (T48). It is a
   known gap, not a regression — fix `redact()` or delete the test deliberately.


---

## PRE-RESOLVED RECONCILIATION ITEMS (orchestrator, verified on main 2026-09-06)

Located precisely so Phase 7 does not re-derive them. Each was confirmed by reading the
merged tree, not inferred from a SUMMARY.

| # | Item | Evidence on main | Resolution |
|---|------|------------------|------------|
| P1 | **Two `AgentResult` schemas exist.** | `src/domain/agent-result.ts` (written by 01-02) **and** `src/execution/agent-args.ts` (written by 04-01, which deliberately avoided creating the domain file so as not to hard-code the losing side — 01-02 had already created it). | Pick one. Phase 4's is the **live-verified** shape (`status: 'delivered' \| 'needs_input'`, `question`/`assumption`/`summary`); Phase 6's assumes `'complete' \| 'needs_input' \| 'cancelled'` with `prTitle`/`prBody`. Note `additionalProperties: false` — any surviving field must be added explicitly or the agent physically cannot return it (T58). |
| P2 | **Delivery dedupe is a runtime TypeError, not a type error.** | `ports.ts:83` declares `tryInsertDelivery(deliveryId, receivedAt)`. `sqlite-store.ts:260` implements **`recordDelivery`**. `receiver.ts:201` calls `store.tryInsertDelivery(deliveryId)` — a method the real store does not have, **and with one argument where the interface takes two**. `fakes.ts:155-167` carries both as an alias, which is why nothing has surfaced. | T46 settles the name as **`recordDelivery`**. Rename in `ports.ts` and `receiver.ts`, fix the arity at the call site, drop the alias from `fakes.ts`. The fake's alias is currently masking this. |
| P3 | **The `DomainEvent` union landed correctly** — all seven kinds present: `issue.assigned`, `issue.unassigned`, `comment.created` (ingress) and `run.requested`, `question.answered`, `run.cancelled`, `ignored` (engine). | Verified in `src/domain/ports.ts`. | Confirms T45's contract half is done and **the mapping half is still owed**. Without it the union typechecks and the daemon processes nothing. |
| P4 | **Every port has a fake — no gap.** 21 exports in `ports.ts` = 14 behavioural ports (all faked) + 7 data shapes. `FakeTunnel implements TunnelManager`; only the name differs. | Verified by diffing exported ports against exported fakes. | No action. Recorded because two SUMMARYs disagree (14 vs 21) and the discrepancy is a naming artifact, not a missing fake. |
