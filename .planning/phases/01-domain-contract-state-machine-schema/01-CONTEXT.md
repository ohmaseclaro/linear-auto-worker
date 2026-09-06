# Phase 1: Domain Contract, State Machine & Schema - Context

**Gathered:** 2026-09-06
**Status:** Ready for planning

<domain>
## Phase Boundary

Delivers the shared vocabulary that every other layer imports: `src/domain/` (types,
the nine-state run machine with its transition table, port interfaces, `AgentResultSchema`,
errors, and an in-memory fake per port) plus the SQLite schema and its migration runner.

This is the project's single serialization point. Phases 2-6 build in parallel against
this contract and against its fakes; none of them starts until this merges. Changing any
of it later reworks all five parallel layers simultaneously.

In scope: CONF-01, CONF-02 (the config type definition — not the loader, which is Phase 2).
Out of scope: any behavior. No network, no child processes, no real SQLite I/O beyond the
migration runner itself.
</domain>

<decisions>
## Implementation Decisions

### Run State Vocabulary

- **D-01:** The nine states are `queued`, `preparing`, `running`, `awaiting_answer`,
  `delivering`, `delivered`, `partial`, `failed`, `cancelled`. The agent-outcome
  classification research calls for (`delivered` / `partial` / `barren`) is expressed
  as state rather than as a separate column; `barren` — the agent produced no evidence
  in the worktree — folds into `failed`. Chosen so "which runs shipped something" is one
  indexed query and the terminal Linear comment falls straight out of the state, with no
  consumer needing to read two fields to answer whether a run shipped.
  — **Reversibility:** one-way — these strings appear in the SQL schema, in every log
  line, in Linear comment bodies, and in all five parallel layers. Renaming one after
  Phase 1 merges is a database migration plus a simultaneous edit to every layer.

- **D-02:** The state table records, per state, whether it holds a concurrency slot and
  whether it has a live child process. `awaiting_answer` holds **neither** — this is
  load-bearing for the whole scheduler and is why hours-long human waits are affordable
  on a three-slot laptop.
  — **Reversibility:** one-way — the scheduler's semaphore, the Q&A layer, and restart
  recovery all encode this.

- **D-03:** Every transition mutates `runs.state` **and** appends a row to a `run_events`
  table (`run_id`, `from`, `to`, `at`, `detail`). Restart recovery, the terminal comment's
  timeline, and cost/duration reporting all reconstruct from it, and a transition that
  failed to log becomes a missing row rather than a missing log line nobody greps for.
  **Note:** this makes five tables, not the four (`runs`, `questions`, `deliveries`, `kv`)
  named in research/SUMMARY.md. `run_events` is additive.
  — **Reversibility:** costly — dropping it later is easy; adding it later means every
  transition site in five layers has to be revisited.

- **D-04:** For a multi-repo ticket, the parent run row carries **no stored state**. Its
  status is derived from its children. Chosen specifically so parent and children cannot
  disagree — the disagreement is the exact bug that would let one repo's failure discard
  another repo's already-shipped PR (DELV-07).
  — **Reversibility:** costly — adding a stored parent state later means writing and
  testing the reconciliation logic this decision exists to avoid.

- **D-05:** A cancel request (bot unassigned, INTK-08) is accepted from **every**
  non-terminal state. `queued`, `preparing` and `awaiting_answer` transition to
  `cancelled` immediately. `running` and `delivering` set a cancel-requested flag that
  the supervisor honors at its next checkpoint rather than transitioning instantly —
  a pushed branch cannot be un-pushed, so an instant transition would lie about what
  happened.

### Configuration Shape (CONF-01, CONF-02)

- **D-06:** Config lives at `~/.linear-auto-worker/`, holding `config.json`, the SQLite
  database, and logs together. The daemon can then be run from any working directory,
  nothing can be committed to a repo by accident, and a `git clean` cannot destroy state.

- **D-07:** An issue is matched to a mapping by **Linear project, with a team-level
  fallback**. CONF-01 specifies project keying; the fallback exists because an issue
  filed directly on a team with no project would otherwise match nothing and be silently
  dropped — a failure that looks identical to the bot ignoring you.

- **D-08:** The two secrets (`LINEAR_API_KEY`, `NGROK_AUTHTOKEN`) live in a separate
  `.env` beside `config.json`, mode 0600 — never inside `config.json`. Keeps the file an
  operator would naturally paste when asking for help free of credentials, and matches
  the shape `@ngrok/ngrok` already wants (`authtoken_from_env: true` reads the process
  environment; it does not read `~/.config/ngrok/ngrok.yml`).
  — **Reversibility:** reversible, but note the wizard (Phase 8) and the logger's
  redaction list (Phase 2) both encode it.

- **D-09:** The six CONF-02 toggles (Linear comments, Slack, base branch, draft vs ready
  PR, question flow, max run time) come from a **global defaults block with sparse
  per-mapping override**. A mapping names only what it changes. Adding a seventh toggle
  later must not require rewriting every existing mapping.

### Schema and Migrations

- **D-10:** Schema evolution uses SQLite's built-in `PRAGMA user_version` plus numbered
  migration modules — no `schema_version` table. Read `user_version`, apply every
  migration above it inside a transaction, bump it. Satisfies the "run twice, second is
  a no-op" success criterion, and means upgrading the daemon on an existing database does
  not discard run history or a question still waiting on the operator's reply.

- **D-11:** Migrations are **TypeScript modules exporting SQL as template literals**
  (`migrations/001-init.ts`), not `.sql` files. `tsc` does not copy non-TS assets, so
  `.sql` files would need both a build copy step and a path resolved off
  `import.meta.url` — two things that work under `tsx` in development and fail with
  ENOENT once built. The SQL stays one readable blob per file either way.

### Tooling and the Verification Gate

- **D-12:** Test runner is the built-in `node:test`. Zero dependencies, built-in mocking
  and coverage, and one less package to keep on a version compatible with the native deps.

- **D-13:** The canonical full-verify command is `tsc --noEmit && node --test`, exposed as
  a single npm script. **Phase 1 must create this script** — it is the end-of-phase gate
  for all eight phases and it does not exist yet. Phase 7 extends the same command with a
  boot smoke test, so that from Phase 7 onward the gate composes the real module graph.
  This matters because typecheck and unit tests structurally cannot see a wiring break:
  unit tests instantiate with fakes and `tsc` only checks types, so a module that never
  wires up what it depends on passes both and fails only when something actually boots.
  — **Reversibility:** reversible — but every phase gate in this milestone runs it.

### Claude's Discretion

- The exact port set and its granularity. Research names the components
  (Store, Config, Logger, TunnelManager, WebhookRegistrar, Receiver, EventRouter,
  Scheduler, RunEngine, WorktreeManager, AgentRunner, Deliverer, LinearClient, Notifier);
  the planner decides which of them get a port interface plus fake versus a direct import.
  Constraint: every port named in `ports.ts` must have a compiling fake in the same phase,
  because Phases 2-6 are built and tested against those fakes alone.
- Whether the transition table is a const data structure or a function, and the exact
  shape of `AgentResultSchema` beyond its `needs_input` requirement (AGNT/QA-01).
- Error class hierarchy in `errors.ts`.
- TypeScript compiler options, beyond the pinned `~5.9` and ESM (`"type": "module"`).

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project contract
- `.planning/PROJECT.md` — Key Decisions table; the Constraints section fixes the tech
  stack, the tunnel singleton rule, the concurrency cap, and the two-secrets rule
- `.planning/REQUIREMENTS.md` — CONF-01 and CONF-02 are this phase's mapped requirements;
  the rest of the file is what the contract has to be able to express
- `.planning/ROADMAP.md` § Phase 1 — the five success criteria this phase is verified against

### Research (read before designing the contract)
- `.planning/research/SUMMARY.md` § Build Order Constraints — states plainly why the
  domain contract and the SQL schema are one phase and not two
- `.planning/research/SUMMARY.md` § Non-Negotiable Invariants — invariant 1 is the
  `awaiting_answer` slot rule this phase encodes into the state table
- `.planning/research/SUMMARY.md` § Corrections to PROJECT.md — nine findings that
  contradict PROJECT.md; item 7 (Q&A must be exit-and-resume) shapes what states exist
- `.planning/research/ARCHITECTURE.md` — the five-layer decomposition and the
  parent/child multi-repo model
- `.planning/research/STACK.md` — pinned versions; `typescript@~5.9` (not `latest`),
  `@linear/sdk@93.0.1` exact, `better-sqlite3@13.0.3`, zod 4 idioms

### Traps
- `.planning/TRAPS.md` — the running ledger. T12 (TypeScript 7 is the `tsgo` rewrite —
  pin `~5.9`) and T15 (this machine runs Node v22.23.1) both bite in this phase.

### Milestone-run decisions (not GSD artifacts, but binding on this run)
- This milestone runs under `/auto-run-gsd` with worktrees on, concurrency 10, Claude-only
  agents (Opus 5 + Sonnet 5). Phase 1 runs alone — it is the serialization point.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
None. The repository contains `.planning/` and `.claude/` only — no `package.json`, no
`src/`, no `node_modules`. This phase writes the first line of source in the project.

### Established Patterns
None yet. Phase 1 *is* the pattern every later phase follows, which is the whole reason
it is serialized.

### Integration Points
Every subsequent phase imports from `src/domain/`. Phase 2 additionally consumes the
config type (D-06 through D-09) and the migration runner (D-10, D-11). Nothing in this
phase imports anything outside it — `src/domain/` must stay a zero-dependency module.

</code_context>

<specifics>
## Specific Ideas

- The nine state names are exact and not a suggestion: `queued`, `preparing`, `running`,
  `awaiting_answer`, `delivering`, `delivered`, `partial`, `failed`, `cancelled`.
- "Judge success by evidence in the worktree, never by exit code" (research, Pitfall 3)
  is what makes `partial` a real state rather than a rounding of `failed` — a partial run
  still ships a draft PR.
- The five tables are `runs`, `questions`, `deliveries`, `kv`, `run_events`.

</specifics>

<deferred>
## Deferred Ideas

- **A linter.** Considered as part of the verify command and rejected for now.
  Workspace-graph-dependent lint rules cannot resolve through a symlinked `node_modules`,
  so a linter would have to be a post-merge-only step rather than something an executor
  can run inside its worktree. Revisit at Phase 7 if it earns its place.
- **macOS Keychain for secret storage.** Stronger at rest than a 0600 `.env`, but costs a
  native dependency and a permission prompt, and breaks copying the config directory to
  another machine. Reconsider only if the tool stops being single-operator.
- **Reversible up/down migrations.** Rejected as overkill for a single-operator local
  daemon — down-migrations that never run. The `user_version` approach does not preclude
  adding them later.

</deferred>

---

*Phase: 1-Domain Contract, State Machine & Schema*
*Context gathered: 2026-09-06*

---

## ADDENDUM — Locked contract surface (added after the operator selected rush / full fan-out)

The operator elected to fan out **all eight phases simultaneously** and defer every
typecheck and test to a single integration gate at the end of the milestone.

That removes the one mechanism that would otherwise catch Phases 2-6 disagreeing about
`src/domain/`. The mitigation is this section: the following names are **binding text**,
not suggestions. Every phase's executor reads this file and codes against these exact
identifiers, whether or not `src/domain/` has landed on their branch yet.

**States** (`RunState`), exactly these nine string literals:
`queued` · `preparing` · `running` · `awaiting_answer` · `delivering` · `delivered` ·
`partial` · `failed` · `cancelled`

**Tables**, exactly these five: `runs` · `questions` · `deliveries` · `kv` · `run_events`

**Config root:** `~/.linear-auto-worker/` — `config.json`, `.env` (0600), the SQLite
database, and logs.

**Config type name:** `Config`, with `defaults` (the six CONF-02 toggles) and `mappings`
(project- or team-keyed, each with `repos[]` and optional `slackWebhookUrl` and a sparse
toggle override).

**Module path:** every layer imports from `src/domain/` — `types.ts`, `state-machine.ts`,
`ports.ts`, `agent-result.ts`, `errors.ts`, `fakes.ts`. `src/domain/` imports nothing
outside itself.

**Phase 1's executor owns writing these files.** Every other phase's executor writes
`import` statements against them and does not define its own copy. Where a Phase 2-8
executor needs a port method that does not yet exist, it declares the call site it wants
in its `{NN}-SUMMARY.md` under a heading `Contract additions requested` rather than
editing `src/domain/` itself — the integration gate reconciles those.


---

## CONTRACT ADDITIONS REQUESTED BY DOWNSTREAM PHASES

Appended live as parallel phases discover gaps. **Plan 01-02's executor must fold these in** —
they were found by executors already writing against the contract, so each one is a real
call site, not speculation.

### From plan 06-01 (Orchestration, completed)

- **`LinearIssue.teamId: string | null` — REQUIRED, not optional.** Research's `LinearIssue`
  carries `projectId` only. Without `teamId` the **team-level mapping fallback (Phase 1 D-07)
  is unimplementable**, and that fallback is the whole reason an issue filed directly onto a
  team is not silently dropped. This would have compiled everywhere and failed only as a
  missing feature nobody could trace back to a type.
- **`concurrency` belongs at `Config` top level, NOT in `Config.defaults`.** It is a global
  cap bounding local RAM across all runs; `defaults` holds the six per-mapping-overridable
  CONF-02 toggles, and concurrency is not one of them. Putting it in `defaults` implies a
  per-mapping override that must not exist.
- `Config.defaults.{questionTimeoutMs, baseBranch}` — these two *are* per-mapping toggles.
- `config.mappings` as a `Record` keyed by project id, then team id (matching D-07's
  project-with-team-fallback lookup order).
- `state-machine.ts`: `RunStateInfo`, `RUN_STATE_TABLE` (**must be enumerable** — 06-01's
  slot-accounting test iterates `Object.keys()` so that a tenth state cannot escape it),
  and `canTransition(from, to)` as a **state-to-state** predicate.
- `errors.ts`: `IllegalTransitionError(from, to)`
- `types.ts`: `RunEventRow { runId, from: RunState | null, to, at, detail }`
- `Store`: `appendRunEvent`, `listRunEvents`, `getQuestion(id)` — research sketches question
  lookup by comment id and short code but not by primary key.
- `Scheduler` port: `positionOf`, `syncFromStore`
