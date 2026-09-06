# Roadmap: linear-auto-worker

## Overview

The project is built as horizontal layers, deliberately, at the operator's direction. Phase 1 is the
only true serialization point: the shared domain contract — types, the nine-state run machine, the
port interfaces, an in-memory fake per port, and the SQL schema — because every other layer imports
it and changing it later reworks all of them at once. Phases 2 through 6 then build in parallel with
zero sibling imports: Foundation (config, store, logger), Ingress (tunnel, webhook, loop
prevention, router), Execution (worktree, `claude -p` supervisor, deliverer), Outbound (Linear
facade, notifier), and Orchestration (scheduler, run engine, Q&A) — the last of which is the
highest bug-density component in the project and is fully testable against Phase 1's fakes with no
network and no Claude process. Phase 7 assembles them in a specific order, wiring
ingress→orchestration before orchestration→execution so ingress bugs are found without burning a
Claude session per reproduction. Phase 8 builds the setup wizard last, once the config shape it
writes has been fixed by Phases 1 and 2.

Two ordering constraints survive the parallelism and are load-bearing. The ingress self-event
filter (Phase 3, HOOK-07) gates the outbound layer (Phase 5) — integrate notifications without it
and the first end-to-end test loops until the API budget is gone. And the SQLite schema is a shared
dependency of delivery dedupe, the run queue, session IDs, and pending questions, which is why it
lives in Phase 1 with the domain contract rather than inside whichever layer touches it first.

## Phases

**Phase Numbering:**

- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [ ] **Phase 1: Domain Contract, State Machine & Schema** - The one serialization point: shared types, transition table, ports, fakes, SQL migration
- [ ] **Phase 2: Foundation** - Validated config loading, the real SQLite store, and structured logging
- [ ] **Phase 3: Ingress** - Tunnel, webhook reconciliation, signature verification, dedupe, four-layer loop prevention, event routing
- [ ] **Phase 4: Execution** - Git worktree per run, supervised `claude -p` session, worker-owned push and PR
- [ ] **Phase 5: Outbound** - Linear client facade and the fan-out notifier whose log channel cannot be disabled
- [ ] **Phase 6: Orchestration** - Scheduler semaphore, run engine state machine, question correlation, restart recovery
- [ ] **Phase 7: Integration & Daemon Lifecycle** - Wire the layers in dependency order and prove assignment→PR hands off
- [ ] **Phase 8: Setup Wizard & Safety Pass** - One command takes a fresh machine to a working, webhook-registered daemon

## Phase Details

### Phase 1: Domain Contract, State Machine & Schema

**Goal**: Every layer can be built and unit-tested independently, against one agreed vocabulary that nobody has to renegotiate
**Depends on**: Nothing (first phase)
**Runs in parallel with**: Nothing — this is the single serialization point; no other phase starts until it merges
**Requirements**: CONF-01, CONF-02
**Success Criteria** (what must be TRUE):

  1. A developer can build and unit-test any one layer with no sibling layer existing, using only the in-memory fake of each port it depends on
  2. Every legal run-state transition is accepted and a representative set of illegal ones is rejected, proven by a table-driven test over the nine states
  3. The state table records, for each state, whether it holds a concurrency slot and whether it has a live child — with `awaiting_answer` holding neither
  4. Running the migration on an empty database produces the full schema, and running it again is a no-op
  5. The project→repo map and its per-mapping toggles have exactly one definition, which the wizard writes and four layers read

**Plans**: 4 plans

- [ ] 01-01-PLAN.md — Repo skeleton, the canonical `verify` script, the nine-state vocabulary and its transition table (wave 1)
- [ ] 01-02-PLAN.md — Run and question records, the config shape (CONF-01/CONF-02), agent-result contract, and every port interface (wave 2)
- [ ] 01-03-PLAN.md — An in-memory fake for all fourteen ports, plus a constructibility smoke test (wave 3)
- [ ] 01-04-PLAN.md — The five-table schema and the `PRAGMA user_version` migration runner (wave 3)

### Phase 2: Foundation

**Goal**: Configuration, persistence, and logging behave correctly enough that no other layer has to defend against them
**Depends on**: Phase 1
**Runs in parallel with**: Phases 3, 4, 5, 6 (no sibling imports)
**Requirements**: SETUP-10, OPS-02
**Success Criteria** (what must be TRUE):

  1. A config file with a wrong or missing field is rejected at load with a message naming that field and the shape expected, rather than failing later as a runtime error
  2. Three concurrent runs read and write run state without the daemon's event loop stalling, with the database in WAL mode and a busy timeout set
  3. Every log line is structured JSON carrying the run ID, and no line anywhere in the output contains an API key or authtoken

**Plans**: 1/2 plans executed

- [x] 02-01-PLAN.md — Tracer: loadFoundation() wiring config to store to logger, plus full config validation (six toggles, project/team fallback, secrets) (wave 1)
- [ ] 02-02-PLAN.md — SqliteStore's typed CRUD over all five tables, and the written proof that redaction survives a secret born after boot (wave 2)

### Phase 3: Ingress

**Goal**: A Linear delivery reaches the system safely, exactly once, and never as an echo of the bot's own writes
**Depends on**: Phase 1
**Runs in parallel with**: Phases 2, 4, 5, 6 (no sibling imports). Its self-event filter is a merge gate for Phase 5
**Requirements**: TUN-01, TUN-02, TUN-03, HOOK-02, HOOK-03, HOOK-04, HOOK-05, HOOK-06, HOOK-07, HOOK-08, HOOK-09, INTK-01, INTK-05
**Success Criteria** (what must be TRUE):

  1. Restarting the worker ten times leaves exactly one ngrok tunnel and exactly one Linear webhook registration, with no orphan tunnel surviving a crash and no duplicate webhook accumulating
  2. A delivery with a valid signature is accepted and acknowledged in well under the five-second budget; tampered, stale-timestamp, and non-ASCII-body deliveries are each handled correctly, and a replayed delivery ID is dropped without side effects
  3. An event the bot itself caused is dropped by four independent guards — actor identity, invisible comment marker, a short self-write suppression window, and delivery-ID uniqueness — and an event with a null actor is treated as untrusted rather than as not-the-bot
  4. A counter of dropped self-events climbs while the bot is commenting, so a filter that is not wired in is visible rather than silent
  5. Assigning the bot to an issue produces exactly one pickup, decided from a fresh fetch of the issue rather than from the webhook payload, and a later unrelated edit to that same issue produces none
**Plans**: 5 plans across 2 waves

Plans:
- [ ] 03-01-PLAN.md — ngrok tunnel: checked URL, singleton assertion, sanitised auth failure (TUN-01/02/03)
- [ ] 03-02-PLAN.md — Webhook reconciler: persist-then-register, correct pagination, re-enable, prune (HOOK-02/03/09)
- [ ] 03-03-PLAN.md — Loop-prevention layers 1-3 as named pure predicates (HOOK-07)
- [ ] 03-04-PLAN.md — Event router (edge-detect then re-fetch) and the reconciliation-poll query (INTK-01/05)
- [ ] 03-05-PLAN.md — ACK-first `node:http` receiver, guard chain, dedupe, live-UAT item (HOOK-04/05/06/08)

### Phase 4: Execution

**Goal**: A ticket's work happens in an isolated worktree, under a supervised agent process, and ships as a pull request the worker opened
**Depends on**: Phase 1
**Runs in parallel with**: Phases 2, 3, 5, 6 (no sibling imports)
**Requirements**: AGNT-01, AGNT-02, AGNT-03, AGNT-04, AGNT-05, AGNT-06, AGNT-07, AGNT-08, AGNT-09, AGNT-10, AGNT-11, QA-01, DELV-01, DELV-02, DELV-03, DELV-04, DELV-08, DELV-09
**Success Criteria** (what must be TRUE):

  1. Two runs against the same repository proceed simultaneously in separate worktrees without touching each other or the operator's working copy; a successful run cleans its worktree up, a failed run leaves it in place, and a worktree orphaned by a crash is pruned at the next boot
  2. Every agent invocation passes an explicit permission mode and verbose streaming, never `--bare`, with the session ID generated and written to the run record before the process is spawned — and the run fails loudly rather than silently when GSD skills are absent from the spawned session
  3. A session that produces megabytes of output never deadlocks, a partial line in the stream never crashes the parser, and a timed-out run has its entire process tree killed with the worktree left intact
  4. The agent can end its turn with a schema-constrained result declaring it needs input and carrying both the question and the assumption it would otherwise make
  5. The worker — never the agent — pushes the branch and opens a draft pull request with a templated body; a push is refused outright on the default branch, blocked on a secret detected in the diff, and flagged prominently when the diff touches CI or workflow files
  6. Secrets held by the worker are absent from the spawned child's environment, and ticket text is stripped of control and zero-width characters before entering the prompt

**Plans**: TBD

### Phase 5: Outbound

**Goal**: Everything the system says to the outside world goes through one facade, and nothing that happens goes unlogged
**Depends on**: Phase 1
**Runs in parallel with**: Phases 2, 3, 4, 6. **Merge gate**: Phase 3's self-event filter (HOOK-07) must be in place before this layer is allowed to write to Linear in a live daemon — without it, the first end-to-end test loops
**Requirements**: INTK-04, OPS-03, DELV-05, NOTF-01, NOTF-02, NOTF-03, NOTF-04, NOTF-05, NOTF-06
**Success Criteria** (what must be TRUE):

  1. Every run state transition produces one structured, greppable log line carrying the run ID and issue ID — including when Linear comments and Slack are both disabled for that mapping
  2. A terminal state is posted on both success and failure, emitted from a `finally` so a crash, timeout, or mid-run restart still produces one, and the terminal comment carries the run's cost and token usage
  3. Progress reaches Linear as a handful of milestones rather than a stream of steps, and Slack fires only on terminal states and on a question being asked
  4. The In Progress state is resolved per team at runtime with no hardcoded UUID anywhere, and a Linear rate limit is recognized by its error extension code — not an HTTP status — and backed off according to the reset header
  5. The pull request URL reaches Linear, Slack, and the logs
  6. A notification channel failing never fails the run

**Plans**: 2 plans

- [ ] 05-01-PLAN.md — Linear client facade: rate-limit-aware call wrapper, per-team In Progress resolution, comment threading, paginated webhook CRUD (wave 1)
- [ ] 05-02-PLAN.md — Fan-out notifier: non-disableable log channel, per-mapping Linear comment channel with the self-event marker, terminal/question-only Slack channel, bounded retry (wave 2)

### Phase 6: Orchestration

**Goal**: Runs are queued, driven through the state machine, blocked on humans without cost, and recovered after a restart
**Depends on**: Phase 1 (builds entirely against the fakes — no sibling imports)
**Runs in parallel with**: Phases 2, 3, 4, 5
**Requirements**: INTK-02, INTK-03, INTK-06, INTK-07, INTK-08, QA-02, QA-03, QA-04, QA-05, QA-06, QA-07, DELV-06, DELV-07, OPS-01, OPS-04
**Success Criteria** (what must be TRUE):

  1. A run in `awaiting_answer` holds no concurrency slot — three simultaneously blocked questions leave all three slots free, so a human who never replies cannot starve the queue
  2. Acknowledgement and the In Progress transition are emitted within ten seconds of pickup and strictly before any worktree or git work, with the operator added as a subscriber and a queued ticket showing its position in a comment that is edited in place rather than re-posted
  3. A question is posted to Linear, a threaded reply is correlated to it by comment ID and resumes the same session with the answer, and a deadline that expires resumes with the stated assumption and posts that assumption to the ticket
  4. Pending questions and their deadlines survive a worker restart, and every run found mid-flight at boot is explicitly requeued or failed rather than left as a zombie with a stuck In Progress ticket
  5. Boot-time and periodic polling finds bot-assigned issues with no run record, and unassigning the bot cancels a queued run and requests cancellation of a running one
  6. One ticket mapped to several repos produces one sub-run per repo whose outcomes are reported independently, so a repo that fails never discards another repo's completed pull request
  7. A failed run is attempted exactly once — it posts a diagnosis with the error and log path and leaves the branch and worktree for the operator instead of retrying

**Plans**: 5 plans across 3 waves

- [ ] 06-01-PLAN.md — Tracer: one run end to end through the Q&A detour, plus the semaphore whose slot rule reads the domain state table (wave 1)
- [ ] 06-02-PLAN.md — Run engine: ack-before-work pickup, edit-in-place queue position, cancellation from every non-terminal state, failure attempted exactly once (wave 2)
- [ ] 06-03-PLAN.md — Questions: threaded-first correlation with a top-level fallback, and the durable deadline sweep (wave 2)
- [ ] 06-04-PLAN.md — Restart recovery per state, and the reconciliation poll including the missed-answer comment listing (wave 3)
- [ ] 06-05-PLAN.md — Multi-repo fan-out with a parent status that is derived and never stored (wave 3)

### Phase 7: Integration & Daemon Lifecycle

**Goal**: The core value works hands-off — an issue assigned to the bot becomes a reviewable pull request
**Depends on**: Phases 2, 3, 4, 5, 6
**Runs in parallel with**: Nothing. Wiring order within the phase is fixed: store→engine, then **router→engine before engine→execution**, then engine→worktree/agent, engine→deliverer, engine→notifier, then the daemon boot sequence
**Requirements**: HOOK-01, OPS-05
**Success Criteria** (what must be TRUE):

  1. Assigning a real Linear issue to the bot produces a draft pull request with no manual step in between, and the pull request URL appears in Linear, Slack, and the logs
  2. The local HTTP server is bound and serving before the tunnel opens, so no delivery ever hits a live URL backed by nothing
  3. Interrupt and terminate shut the daemon down cleanly in reverse boot order — spawned children killed, tunnel closed, in-flight runs marked — and the next boot recovers those runs rather than stranding them
  4. A real signed webhook produces a queued run while the execution layer is still faked, proving the ingress seam before any Claude session is spent on it
  5. A run that asks a question survives a full daemon restart and resumes on the operator's threaded reply

**Plans**: 6 plans

Plans:

- [ ] 07-01-PLAN.md — Make the merged eight-branch tree installable; reconcile package.json/tsconfig, gate the dependency set, take the first full-tree typecheck
- [ ] 07-02-PLAN.md — Fold every `Contract additions requested` into src/domain/ and drive the whole tree to a clean compile
- [ ] 07-03-PLAN.md — Tracer: composition root + boot smoke; a signed webhook becomes a queued run with execution still faked
- [ ] 07-04-PLAN.md — Wire the real worktree/agent, deliverer and notifier into the engine
- [ ] 07-05-PLAN.md — Complete the ordered boot (bind before tunnel) and the reverse-order shutdown
- [ ] 07-06-PLAN.md — Extend the canonical verify with the boot smoke, run the first full gate, write the live-gated human checklist

**Live-gated:** success criteria 1 and 5 require a real Linear workspace, a live ngrok tunnel and real `gh`. They are built in this phase and verified manually via `07-HUMAN-UAT.md`; no plan task blocks on them.

### Phase 8: Setup Wizard & Safety Pass

**Goal**: A fresh machine reaches a working daemon in one command, and the preflight catches the things that quietly ruin runs
**Depends on**: Phase 2 (config shape) and Phase 3 (webhook registrar); may start once those merge, but its end-to-end verification step (SETUP-09) requires Phase 7
**Runs in parallel with**: Phase 7, partially — implementation can overlap, final verification cannot
**Requirements**: SETUP-01, SETUP-02, SETUP-03, SETUP-04, SETUP-05, SETUP-06, SETUP-07, SETUP-08, SETUP-09
**Success Criteria** (what must be TRUE):

  1. One command checks the local toolchain — Node version, git and git identity, `gh auth status`, `claude` on PATH, the global GSD install — and reports each check with an actionable fix rather than a stack trace
  2. Only the Linear API key and the ngrok authtoken are ever prompted for, each skipped when already present, with the ngrok token lifted out of the existing ngrok config file when it is there; the Linear key is validated with a live call and its workspace-admin permission probed, failing with a message naming the exact fix
  3. The operator builds the project→repo map by picking from listed Linear teams and projects and discovered local repos, never by hand-editing JSON, and captures the optional Slack webhook and per-mapping toggles in the same flow
  4. Every mapped repo is checked for a remote and a resolvable default branch — which is recorded in the mapping — and the operator is warned about any repo missing a `CLAUDE.md` or `AGENTS.md`, named as the highest-leverage success factor
  5. The wizard finishes by registering the Linear webhook, so setup ends with a system that is already working rather than one that is merely configured
**Plans**: 5 plans
Plans:
- [x] 08-01-PLAN.md — CLI entry (`law setup|start|status`) + tracer + full toolchain preflight (D-01/D-08) + local repo discovery (D-02)
- [ ] 08-02-PLAN.md — Linear API key validate+admin-probe and ngrok authtoken acquisition, persisted to `.env` at 0600 (SETUP-02/03/04)
- [ ] 08-03-PLAN.md — Interactive Linear team/project + repo checklist mapping, Slack + toggle capture, re-run-in-place editing (SETUP-05/06)
- [ ] 08-04-PLAN.md — CLAUDE.md/AGENTS.md warning+generate, remote/default-branch/ownerRepo capture, submodule + branch-protection warnings (SETUP-07/08)
- [ ] 08-05-PLAN.md — Config assembly + idempotent write, webhook reconcile-by-label + `--doctor`, full wizard wiring, HUMAN-UAT.md (SETUP-09)

## Requirement Coverage

All 70 v1 requirements are mapped to exactly one phase.

| Category | Count | Phases |
|----------|-------|--------|
| Setup (SETUP-01..10) | 10 | Phase 8 (01-09), Phase 2 (10) |
| Tunnel (TUN-01..03) | 3 | Phase 3 |
| Webhook Plumbing (HOOK-01..09) | 9 | Phase 3 (02-09), Phase 7 (01) |
| Intake (INTK-01..08) | 8 | Phase 3 (01, 05), Phase 5 (04), Phase 6 (02, 03, 06, 07, 08) |
| Agent Execution (AGNT-01..11) | 11 | Phase 4 |
| Question and Answer (QA-01..07) | 7 | Phase 4 (01), Phase 6 (02-07) |
| Delivery (DELV-01..09) | 9 | Phase 4 (01-04, 08, 09), Phase 5 (05), Phase 6 (06, 07) |
| Notification (NOTF-01..06) | 6 | Phase 5 |
| Operations (OPS-01..05) | 5 | Phase 2 (02), Phase 5 (03), Phase 6 (01, 04), Phase 7 (05) |
| Configuration (CONF-01..02) | 2 | Phase 1 |
| **Total** | **70** | **8 phases** |

## Parallelism Map

```
Phase 1  ──────────────────────────────────────────────  (serialization point)
             │
             ├── Phase 2  Foundation     ─┐
             ├── Phase 3  Ingress        ─┤
             ├── Phase 4  Execution      ─┼──►  Phase 7  Integration ──► (core value)
             ├── Phase 5  Outbound       ─┤          │
             └── Phase 6  Orchestration  ─┘          │
                                                     └──► Phase 8  Wizard
                          ▲
        Phase 3's HOOK-07 self-event filter gates Phase 5's live Linear writes
        Phase 8 may start once Phases 2 and 3 merge; its final check needs Phase 7
```

## Progress

**Execution Order:**
Phase 1 first. Phases 2-6 in parallel. Phase 7 after all of them. Phase 8 last.

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Domain Contract, State Machine & Schema | 0/TBD | Not started | - |
| 2. Foundation | 1/2 | In Progress|  |
| 3. Ingress | 0/TBD | Not started | - |
| 4. Execution | 0/TBD | Not started | - |
| 5. Outbound | 0/2 | Not started | - |
| 6. Orchestration | 0/TBD | Not started | - |
| 7. Integration & Daemon Lifecycle | 0/6 | Planned | - |
| 8. Setup Wizard & Safety Pass | 1/5 | In Progress|  |

---
*Roadmap created: 2026-09-06*
