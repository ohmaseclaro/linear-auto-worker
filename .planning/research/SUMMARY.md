# Project Research Summary

**Project:** linear-auto-worker
**Domain:** Single-operator local daemon — Linear webhook → queued `claude -p` run in a git worktree → GitHub draft PR
**Researched:** 2026-09-06
**Confidence:** HIGH on stack and external contracts · MEDIUM-HIGH on pitfalls · MEDIUM on internal decomposition and competitive feature set

## Executive Summary

This is an issue-tracker-driven autonomous coding agent, built as a local daemon rather than a hosted service. Every shipped competitor (GitHub Copilot coding agent, Cursor cloud agents, Devin, Jules, Linear-native coding sessions) converges on the same shape: assignment to a dedicated agent identity is the trigger, an acknowledgement lands within ~10 seconds, work happens in an isolated workspace, progress is reported at throttled milestones, and the deliverable is a **draft PR that the tool never merges**. PROJECT.md already matches that shape on every axis. The two places this project genuinely beats the hosted products are **multi-repo runs from one ticket** (Copilot documents this as a hard limitation) and **running on the operator's real machine with real credentials** — no firewall allowlist, no secret-injection ceremony, private registries just work.

The recommended build is deliberately boring: Node 24 + TypeScript 5.9 (pinned — `typescript@latest` is now the Go-native TS7 rewrite), `@linear/sdk` pinned **exactly** (it ships a new major roughly weekly), `node:http` with **no HTTP framework at all** (the SDK's `createHandler()` is itself a `node:http` request listener that consumes the raw body and verifies the HMAC for you), `better-sqlite3` as the single source of truth, `execa` for the ~5 spawn sites, `pino` for the structured log that — given no dashboard — *is* the UI. The architecture decomposes into ~14 components across five layers with `src/domain/` (types, state machine, ports, fakes, SQL schema) as a zero-dependency contract that everything else imports.

The risk is concentrated in three places, and research changed the answer in all three. (1) The **webhook feedback loop**: Linear does not suppress self-caused events, the bot must post comments, and the naive implementation loops until the API budget is gone — this needs four independent guard layers, not one `if`. (2) The **blocking Q&A channel**: the obvious design (an MCP `ask_human` tool that long-polls) is ruled out by first-party documentation — Claude Code backgrounds any main-conversation MCP call still running after ~2 minutes, so the agent silently proceeds *without* the answer and ships a confidently wrong PR. The viable design is exit-and-`--resume <sessionId>`, which also releases the concurrency slot for free. (3) **`claude -p` misconfiguration that silently produces nothing**: `-p` starts in Manual permission mode and will exit 0 having been denied every edit, and `--bare` — which the vendor docs recommend for scripted use — would strip the global GSD install this entire project is built on.

## Corrections to PROJECT.md

**Read this section before writing the roadmap.** Nine research findings contradict assumptions currently written into PROJECT.md. Each has a concrete consequence for phase content.

| # | PROJECT.md says | Research says | Consequence for the roadmap |
|---|---|---|---|
| 1 | "Self-managed ngrok tunnel — **random free domain**"; re-register against the freshly created tunnel URL each boot | **ngrok free accounts have had one permanent static dev domain since 2023.** It does not change across restarts. ([ngrok blog](https://ngrok.com/blog/free-static-domains-ngrok-users), [free plan limits](https://ngrok.com/docs/pricing-limits/free-plan-limits)) | The webhook URL is **configuration**, discovered once by the wizard, not a per-boot value. Registration collapses to one-time create plus a cheap boot-time reconcile. Delete the "URL changed" notification path, the secret-rotation path, and the re-register-every-boot logic — that machinery is what *causes* stale-webhook accumulation. `VERIFY` in the tunnel phase: that `@ngrok/ngrok`'s in-process SDK exposes the same domain pinning as the CLI's `--url`. |
| 2 | A bot account with a personal API key is sufficient | **`webhookCreate` requires workspace-admin permission.** A plain-Member bot key fails. | Either make the bot account a workspace admin (free on Linear Free, preserves the two-secrets constraint — **preferred**) or have the wizard accept a second admin-scoped key used *only* for webhook CRUD. The wizard must probe this at runtime with a `webhooks()` read and fail loudly with an actionable message. |
| 3 | (implied) use `LinearWebhooks` / hand-rolled HMAC over a framework's raw body | **`@linear/sdk` v93 removed `LinearWebhooks`.** The replacement `LinearWebhookClient.createHandler()` is itself a `node:http` request listener that consumes the raw body stream and HMACs it before any JSON parsing. Verified end-to-end: 200 on valid signature, **400** (not 401) on invalid. | **Use no HTTP framework.** Express/Fastify/Hono each reintroduce the raw-body problem you would otherwise not have. Import from the `@linear/sdk/webhooks` subpath. Note the 400 if you alert on status codes. |
| 4 | "Linear returns the webhook signing secret at `webhookCreate` time — persisted by the worker" | Linear's published docs say the secret is **not** returned and must be copied from the UI; the shipped GraphQL schema disagrees. The contradiction is unresolved. But `WebhookCreateInput.secret` accepts a **client-supplied** secret. | Generate `crypto.randomBytes(32).toString('hex')`, persist it to SQLite *before* calling `webhookCreate`, pass it as `secret`. Correct under either reading of the docs, and the client-supplied `id` field gives idempotent registration for free. |
| 5 | Agent host is `claude -p`; GSD inherited from the global install | `-p` **starts in Manual permission mode on every plan** — without an explicit `--permission-mode` the agent is denied its edits and exits 0 having written nothing. And `--bare`, which the vendor docs recommend for scripted use and say will become the `-p` default, **skips auto-discovery of hooks, skills, commands, subagents, plugins, and CLAUDE.md** and never reads OAuth credentials. | `--bare` is **forbidden** and needs a comment saying why, or a future contributor will add it following the docs and break the product silently. Always pass an explicit `--permission-mode`, `--permission-prompts none` (version-gated), and `--verbose` (mandatory with `stream-json`, hard error otherwise). Assert on the `system/init` event that GSD skills are present; fail the run loudly if not. |
| 6 | "`--resume <sessionId>` provides mid-run continuation" (implying the ID is captured from the stream) | **`--session-id <uuid>` lets the caller pre-assign the ID.** Verified: the pre-generated UUID is echoed on every emitted event. | Generate the UUID and persist it to the run row *before* spawning. This deletes an entire class of race and parse bugs — hook/plugin events routinely precede `system/init`, so "read the first line" breaks on exactly this operator's hook-heavy setup. |
| 7 | "Blocking Q&A ... blocks a run on a threaded reply" | An MCP `ask_human` long-poll tool **does not block the agent.** Claude Code moves any main-conversation MCP call still running after ~2 minutes to a background task; the agent receives a task ID and **keeps coding without the answer**. | The only viable design is **exit and `--resume`**: the agent ends its turn with a structured `needs_input` result, the process exits, the slot is released, the worker persists the question with an absolute deadline, and resumes on answer or timeout. Use `--json-schema` to constrain the result shape — never regex a magic string out of prose. |
| 8 | (implied) standard `429` rate-limit handling | Linear returns **HTTP 400** with `errors[].extensions.code === "RATELIMITED"`. Budgets: 2,500 req/hr *and* an independent 3,000,000 complexity-points/hr, with a hard 10,000-point ceiling on any single query. | Any `if (status === 429)` is dead code. Detect on `extensions.code`; honour `X-RateLimit-Requests-Reset` (UTC epoch **milliseconds**); log `X-Complexity` per response. |
| 9 | OAuth `actor=app` deferred purely on cost grounds | The cost analysis is right; the **capability** analysis is incomplete. Assignable/mentionable app users, `AgentSessionEvent`, and the `elicitation` activity type — which is *exactly* the blocking-Q&A requirement, natively — are all gated behind OAuth `actor=app`. A personal-API-key bot cannot use any of them. Worse, Linear's own best-practices page says comments are editable and therefore **unreliable** for reconstructing agent conversation state. | Keep OAuth out of scope for v1 (the free-plan argument holds), but record it as the single highest-value v2 upgrade — it converts three hand-built features into vendor-native ones at once. Revisit the moment the workspace leaves Free or a second person uses the tool. |

**Two further deviations worth a conscious decision:**

- **Assignee vs delegate semantics.** Linear's model is that delegating to an agent keeps the *human* as assignee. `assigneeId`-based pickup inverts this: the ticket leaves the operator's "Assigned to me" view for the duration of the run. That is a real workflow regression, and it should be an accepted trade-off rather than an accident.
- **The 10-second acknowledgement norm does not bind a bot user, but the expectation does.** Operators trained on Cursor/Copilot expect the ticket to visibly wake up. Treat sub-10-second ack as a hard requirement anyway — which makes it an *ordering* constraint: ack and state transition happen **before** worktree creation, not after.

**Inter-document note:** ARCHITECTURE.md was written against the old "random domain per boot" premise (see its Integration Points table and Scaling section). Where it and PITFALLS.md disagree on the tunnel, **PITFALLS.md is correct** — the domain is static.

## Key Findings

### Recommended Stack

Verified by execution, not by reading docs: versions from the npm registry, API surfaces from the installed `.d.ts`, CLI behaviour from actually running `claude` and `gh` on this machine, and the webhook receiver proven with a real `node:http` server and a signed POST.

**Core technologies:**
- **Node 24.x (Active LTS)** — Node 22 is already Maintenance; the wizard should preflight `>= 24` (this machine currently runs 22.23.1).
- **TypeScript `~5.9` — pinned** — `latest` is now 7.0.2, the Go-native `tsgo` rewrite. Do not take it against `@linear/sdk`'s 74k-line generated `.d.ts`.
- **`@linear/sdk@93.0.1` — exact pin, no caret** — a new major roughly weekly (86 → 93 in 15 weeks). Ranges are meaningless here.
- **`node:http` + `@linear/sdk/webhooks`** — no framework. `createHandler()` handles raw body and HMAC.
- **`better-sqlite3@13.0.3`** — synchronous, WAL, and v13 moved to prebuildify: 2-second install, **no node-gyp, no Xcode CLT**. That kills the historical objection.
- **`@ngrok/ngrok@1.7.0`** — in-process; tunnel lifetime bound to the process. Note it does **not** read `NGROK_AUTHTOKEN` automatically — pass `authtoken_from_env: true`.
- **`execa@10`, `zod@4.5.4`, `pino@10`, `@inquirer/prompts@8`** — spawning, config validation, structured logs, wizard.
- **Testing/build:** `node:test` and plain `tsc`/`tsx`. **No bundler** — bundling native `.node` addons is painful and buys nothing for a local daemon.

Explicitly rejected: `@anthropic-ai/claude-agent-sdk` (wants in-process hosting, forfeiting the crash isolation and the inherited global GSD install), Express (`express.json()` ordering silently breaks signature verification), the ngrok CLI as a child process, and `gh pr create --json` (the flag does not exist — the URL is printed on stdout).

### Expected Features

**Must have (table stakes — missing these makes the tool feel broken, not minimal):**
- Single unambiguous trigger: assignment to a dedicated bot identity
- Acknowledgement within ~10s, **before** worktree creation, then transition to In Progress
- Isolated workspace per run (git worktree)
- Throttled progress updates — 3–4 milestones, not a stream
- Terminal state **always** posted, in a `finally` — success and failure both
- Draft PR opened by the worker on Linear's suggested `branchName`, never merged
- Webhook signature verification + delivery-ID dedupe + self-comment filtering
- Concurrency cap **with a queue and a visible "queued, position N" comment** — a queued ticket that looks like a dead ticket is the failure mode
- Restart survival with boot-time reconciliation of interrupted runs
- Structured per-run JSONL logs (given no dashboard, `tail -f` *is* the UI)
- Toolchain preflight — including warning on a **missing CLAUDE.md**, which dotnet/runtime measured at 38% → 69% success across 878 PRs. Best evidence-to-effort ratio in the whole research set.

**Should have (differentiators):**
- **Multi-repo runs from one ticket** — the strongest differentiator; Copilot documents this as impossible
- **Worker-owned push and PR creation** — deterministic; also tell the agent "commit only, do not push"
- **Blocking Q&A with timeout-to-assumption** — genuinely rare in this space, and the highest-risk feature here
- Draft-by-default, worker-templated structured PR body, per-run cost/token line from the result JSON, Slack on terminal states only, ~7 per-mapping toggles (an eighth needs an argument)

**Defer (v2+):** OAuth `actor=app` migration, @-mention as a secondary trigger, per-run replay, cross-run memory, confidence scoring.

**Anti-features, all evidence-backed:** auto-merge (contradicted by every mature product; dotnet/runtime requires an explicit human merge request, and 52.3% of their *merged* agent PRs needed direct human commits); auto-pickup of every new issue (this is the AI-slop generator — curl shut down its bug bounty as valid-finding rates fell >15% → <5%); retry-on-failure loops (the recovery that actually works is a human commit on the branch, 86.2% vs 55.1%); streaming every step into comments or Slack; agent-authored narrative PR bodies; letting the agent edit CI/workflow files unprompted.

### Architecture Approach

A five-layer decomposition (L0 foundation → L1 ingress → L2 orchestration → L3 execution → L4 outbound → L5 entry) around a zero-dependency `src/domain/` contract. Ingress verifies, dedupes, and ACKs in under 200 ms, then hands a normalised `DomainEvent` to the orchestrator. The state machine is the centre of gravity: nine states, with `awaiting_answer` as the load-bearing one — it holds **no** concurrency slot and has **no** live child, which is what makes hours-long human waits affordable on a laptop with three slots.

**Major components:**
1. **Store / Config / Logger (L0)** — SQLite (`runs`, `questions`, `deliveries`, `kv`), zod-validated config, run-scoped child loggers. Store is a dumb typed repository with no business rules.
2. **TunnelManager + WebhookRegistrar + Receiver + EventRouter (L1)** — one ngrok listener, idempotent webhook *reconcile*, raw-body HMAC + timestamp-skew + delivery-ID dedupe with a sub-5s ACK, and a router that re-fetches canonical issue state before deciding anything.
3. **Scheduler + RunEngine (L2)** — deliberately split. Scheduler owns only the semaphore ("may another run start?"); RunEngine owns the state machine and is the **only** writer of `runs.state`.
4. **WorktreeManager + AgentRunner + Deliverer (L3)** — git worktree lifecycle; `claude -p` spawn/supervise/resume with a caller-assigned session ID; push + `gh pr create` as its own component so it is testable against a scratch repo with no Claude process anywhere.
5. **LinearClient + Notifier (L4)** — one typed facade through which *every* Linear call passes, and a fan-out notifier where the log is a non-disableable channel rather than a peer call site, so it is structurally impossible to add a notification path that forgets to log. Notifier never throws upward.

Multi-repo is modelled as one parent `runs` row per ticket and N children (one per repo), each with its own worktree, session, and state — not one session with `--add-dir`. Partial success then becomes the normal, well-handled case: repo A ships its PR even when repo B fails.

### Critical Pitfalls

1. **The webhook self-trigger feedback loop.** The bot comments → Linear fires `Comment/create` → the Q&A channel must listen to comments → loop until the 2,500 req/hr budget or the 20,000/month ngrok request cap is gone. Three distinct loop surfaces (comment, state, assignment) plus a cross-instance variant. Prevention is **four layers**, not one guard — see Non-Negotiable Invariants.
2. **`claude -p` that silently produces nothing.** Manual permission mode by default, `--bare` stripping the global GSD install, missing `--permission-prompts none` leaving the agent waiting on a permission host. All three fail *quietly* with exit 0. Assert GSD skills on `system/init`.
3. **Agent process hazards.** Undrained stdout deadlocks at ~64 KB of output (within the first minute of any real run); `child.kill()` orphans the agent's own Bash subprocesses; chunk-boundaried `stream-json` breaks naive `split("\n").map(JSON.parse)`. Prevention: drain **both** pipes, line-buffer with a carry, `detached: true` + `process.kill(-pid)`, escalating SIGINT → SIGTERM → SIGKILL (SIGINT first keeps the run resumable). **Judge success by evidence in the worktree, never by exit code** — classify `delivered` / `partial` / `barren` and ship a draft PR for `partial`.
4. **Blocked runs holding slots.** Three open questions deadlock a three-slot daemon, and the operator's natural diagnosis ("it's hung") is wrong, which is what makes it expensive. `awaiting_answer` must hold no slot, and the deadline must be **data in SQLite**, not a `setTimeout` that a restart erases.
5. **Secrets and an agent with write access on the operator's real machine.** Untrusted ticket text becomes instructions for a process with the operator's shell. Sanitize the child env (the agent has no business calling Linear — withhold the key), delimit the issue body as untrusted data, scan the diff for credential patterns before pushing, never `--force`, never push the base branch, and — highest leverage because it is server-side and out of the agent's reach — **branch protection on `main`**, which the wizard should check for and warn about.

Also load-bearing: webhook registration multiplied across restarts (reconcile, never recreate; paginate `webhooks()`; handle the auto-disabled case), git worktree hazards (suffix colliding branches, **never `-B`** — it destroys the previous attempt's commits), per-team workflow-state UUIDs (resolve by state `type`, not `name`), and `gh` delivery landing in the wrong place (always `--base` and `-R OWNER/REPO`; push explicitly before invoking `gh`, which has no TTY).

## Build Order Constraints

PROJECT.md locks "horizontal layers, full parallelism." That is mostly achievable — but three constraints force serialization, and the research is emphatic that ignoring them costs a rework cycle.

**1. Wave 0 is a genuine serialization point.** `src/domain/` — `types.ts`, `state-machine.ts`, `ports.ts`, `agent-result.ts`, `errors.ts`, `fakes.ts` — plus the SQL schema in `migrations/001_init.sql`, because table shapes are part of the contract. One owner, one phase, nothing else starts until it merges. Exit gate: a table-driven test covering every legal transition and rejecting a sample of illegal ones, and a compiling fake for every port. `domain/state-machine.ts` is the one thing that must be right before anything else — every layer encodes assumptions about which states exist; changing it later reworks all four parallel layers at once.

**2. Ingress loop prevention gates notifications.** The ingress self-event filter (actor identity + delivery-ID dedupe) must land **before** the notification layer is allowed to write anything to Linear. Built in parallel and integrated without the filter, the first end-to-end test loops. Make "ingress drops self-events" a merge gate for the outbound layer, and put the marker-prefix constant in a **single shared module** imported by both — it cannot be duplicated in two layers built by two owners.

**3. The SQLite schema is a shared dependency of four components.** Delivery dedupe (ingress), the run queue (scheduler), session IDs (agent runner), and pending questions (Q&A) all read and write the same tables. This is why the schema belongs in Wave 0 with the domain contract, not inside whichever layer happens to touch it first.

**Secondary ordering that costs little and saves a lot:**
- **Wizard preflight *outputs* are inputs to four layers** (`ngrokDomain`, per-repo `remoteName`/`ownerRepo`/`defaultBranch`, `claude --version`, RAM and fd limits). Fix the *config shape* early; the wizard's implementation can come last.
- **Wire ingress→orchestration before orchestration→execution.** A real signed webhook producing a `queued` run, with execution still faked, proves the whole ingress seam while the expensive half is cheap to iterate on. Wiring execution first means every ingress bug costs a full Claude session to reproduce.
- **Orchestration is testable in complete isolation** against `domain/fakes.ts` — a `FakeAgentRunner` scripted to return `needs_input` then `complete` exercises the entire Q&A round trip with no Claude process and no network. It has the highest bug density in the project and the cheapest test loop. Give it the strongest owner.
- **Feature sequencing caveat (advisory, not a scope objection):** both FEATURES.md and the architecture flag blocking Q&A and multi-repo as the two highest-complexity items. Both are Active requirements, so both ship — but building them on *unproven* single-repo delivery doubles the terminal-state logic before the basics are known good.

## Non-Negotiable Invariants

Rules every phase must respect. Each is a one-line distinction whose violation produces an expensive, hard-to-diagnose failure.

1. **A run in `awaiting_answer` holds NO concurrency slot and has NO live child.** Count only actively-running agent processes against the cap. Violating this turns "three open questions" into "the daemon is dead" — and the operator's diagnosis will be wrong. This belongs in the *scheduler's* definition of done, not the Q&A layer's; it is exactly the kind of rule that gets lost between two components.
2. **Never make a decision from `payload.data`.** The webhook is a *signal that issue X changed*; re-fetch the issue from the Linear API and decide from that. This single rule dissolves out-of-order events, missing computed fields (`branchName` may not ride along), and duplicate deliveries at once — the action becomes a function of current state, not of event history.
3. **Four-layer webhook feedback-loop prevention**, because each layer alone has a known failure mode:
   - **L1 — actor identity filter**, resolved once at boot from `viewer { id }`, applied at the very top of ingress before any entity-type switch. Write it as a **positive** drop test: `payload.actor?.id === BOT`. Never `payload.actor.id !== BOT` — `actor` is documented as nullable and a null actor makes that expression true.
   - **L2 — marker prefix** on every bot-authored comment (an HTML comment Linear renders invisibly); ingress drops matching comments regardless of actor. Survives null actors, stale cached bot IDs, and a re-created bot user.
   - **L3 — short self-write suppression window** (60–120s, in-memory) covering the race where the webhook beats the mutation's own HTTP response. A hint for interpretation only — correctness must never depend on it.
   - **L4 — delivery-ID dedupe with a `UNIQUE` constraint** (`INSERT OR IGNORE`, then check `changes()` — never `SELECT` then `INSERT`, which races), plus a per-issue reaction circuit breaker that quarantines an issue and alerts if a loop defeats the first three layers.
   - Instrument L1 with a `selfEventsDropped` counter. A **healthy** system shows it climbing; stuck at zero while the bot is commenting means the filter is not wired in.
4. **Pickup fires on the transition, not the state:** `action === "update" && "assigneeId" in updatedFrom && data.assignee.id === BOT`. "Issue updated and assignee is bot" matches every subsequent edit forever, including the bot's own.
5. **Ingress ACKs within the 5000 ms budget** — verify, dedupe, filter, enqueue, `200`, target p99 under 200 ms. No git, no spawn, no Linear API call inside the request handler. Return **200** even for events you ignore; a non-200 burns Linear's 3-retry budget and moves you toward auto-disable.
6. **Only `RunEngine.transition()` writes `runs.state`.** Enforce it by not exporting the update statement.
7. **Every `agent_running` row found at boot is a crash artefact** — no live handle can exist across a restart. Requeue with `resumable = true`; never trust the row.
8. **Question deadlines are absolute epoch timestamps in SQLite**, swept by a scheduler tick. A `setTimeout` does not survive a restart, and the timeout fallback is the mechanism the entire "never fragile" reliability posture depends on.
9. **The agent never pushes and never opens a PR** — the worker does, and the spawned prompt says so explicitly, or you race the agent and get double PRs. The worker pushes exactly one named ref (`git push -u <remote> refs/heads/<branch>`), never a bare `git push`, never `--force`, and asserts `branch !== defaultBranch` first.
10. **The child process never receives daemon secrets.** Build its env explicitly; `LINEAR_API_KEY` and `NGROK_AUTHTOKEN` are withheld by construction, because the worker owns all Linear I/O by design.
11. **A terminal state is always posted, from a `finally`** — crash, OOM, push rejection, and daemon restart mid-run all produce a terminal comment. Silence on failure is the single most-complained-about agent behaviour in this space.
12. **Ack before work.** The acknowledgement comment and the In Progress transition happen before worktree creation or `git fetch`, both of which can take seconds on a cold repo.
13. **SQLite is the source of truth; Linear comments are a projection.** Never re-parse comment bodies to recover run state — Linear's own docs warn comments are editable. Correlate replies by `parentId` against the stored comment ID, never by recency (which breaks the moment two runs are open on one ticket — normal, not exotic, once multi-repo lands).
14. **Never `--bare`.** Codify the `claude` invocation in one module with a comment explaining why, or a future contributor will add it following the vendor's own recommendation.

## Implications for Roadmap

Based on research, suggested phase structure:

### Phase 1: Domain Contract + Schema (Wave 0)
**Rationale:** The only true serialization point. Four parallel layers and the orchestrator all import it; changing it later reworks everything.
**Delivers:** `src/domain/` (types, nine-state machine with the transition table, ports, `AgentResultSchema`, errors, fakes) + `migrations/001_init.sql`.
**Avoids:** the shared-schema and state-vocabulary rework that "full parallelism" otherwise guarantees.
**Exit gate:** table-driven transition test (legal accepted, illegal rejected); every port has a compiling fake.

### Phase 2a: Foundation (parallel)
**Rationale:** Zero sibling dependencies; everything else needs config and store.
**Delivers:** `infra/config` (zod 4, `z.prettifyError` for wizard messages), `infra/store` (real SQLite, WAL, indexes on `delivery_id` / `run.status` / `deadline_at`), `infra/logger` (pino with a **global redacting serializer at the sink** — per-call-site redaction is forgotten exactly once).

### Phase 2b: Ingress (parallel)
**Rationale:** Owns the highest-severity pitfall in the project and gates the outbound layer.
**Delivers:** TunnelManager with a **pinned static domain**, WebhookRegistrar that **reconciles** (paginated, re-enables auto-disabled webhooks, client-supplied secret and id), `node:http` Receiver on `@linear/sdk/webhooks`, EventRouter with re-fetch-then-decide.
**Avoids:** Pitfalls 1–4 (feedback loop, registration multiplication, ngrok assumptions, signature verification).
**Definition of done includes:** actor filter (positive test), marker constant in a shared module, delivery-ID `UNIQUE` dedupe, sub-200 ms ACK, and four signature tests — valid, tampered, stale timestamp, **unicode body** (the ASCII-only test passes while real tickets with emoji fail).

### Phase 2c: Execution (parallel)
**Rationale:** Fully testable against scratch git repos, a trivial `claude -p` prompt, and a throwaway GitHub repo — no siblings needed.
**Delivers:** WorktreeManager (prune-on-boot, branch suffixing, never `--detach`, per-repo git mutex, daemon-owned worktree root), AgentRunner (pre-assigned `--session-id`, both pipes drained, carry-buffer line parsing, `detached` + group kill, SIGINT→SIGTERM→SIGKILL, evidence-based outcome classification), Deliverer (explicit push then `gh pr create -R … --base … --draft`, URL from stdout, idempotent via `gh pr list --head`).
**Avoids:** Pitfalls 5, 6, 12.

### Phase 2d: Outbound (parallel)
**Rationale:** Provable against a real Linear scratch team and a real Slack webhook.
**Delivers:** LinearClient facade (rate-limit detection on `extensions.code` not status, header logging, per-team state resolution by `type` with TTL cache, explicit pagination, `parentId` threading) and Notifier (Linear + Slack + non-disableable log channel; never throws upward).
**Merge gate:** ingress self-event filtering must already be in place.

### Phase 3: Orchestration
**Rationale:** Highest bug density, cheapest test loop — buildable entirely against `domain/fakes.ts`, so it can start alongside Phase 2.
**Delivers:** Scheduler (semaphore, admission control on free RAM, **blocked runs excluded from the count**), RunEngine (the only writer of `runs.state`), question correlation and the durable deadline sweep, boot reconciliation, and the periodic missed-work poll against Linear.
**Avoids:** Pitfalls 7, 8.

### Phase 4: Integration
**Rationale:** Ordering matters more than speed here.
**Delivers:** in order — store→engine (verify a run survives restart mid-`awaiting_answer`), **router→engine before engine→execution**, engine→worktree/agent, engine→deliverer, engine→notifier, then the daemon boot sequence end to end.

### Phase 5: Setup Wizard + Safety Pass
**Rationale:** Implemented last, but its *config shape* was fixed in Phase 1. It is also where most preflight-shaped pitfall mitigations land.
**Delivers:** toolchain preflight (`node >= 24`, `claude --version`, `gh auth status` incl. `workflow` scope and SAML, git identity, `ulimit -n`, RAM-derived concurrency default), Linear admin-permission probe, per-repo capture of `remoteName`/`ownerRepo`/`defaultBranch`, submodule and missing-CLAUDE.md warnings, branch-protection check, a `--doctor` webhook cleanup path, and the stated accepted risk that a mapped repo's `.claude/settings.json` hooks execute with no trust prompt under `-p`.

### Phase Ordering Rationale

- Wave 0 first because the state machine and SQL schema are imported by literally everything.
- Ingress before outbound writes, because the loop bug and the ngrok quota exhaustion are the same incident.
- Ingress→orchestration wired before orchestration→execution, because ingress bugs should not cost a Claude session each to reproduce.
- Wizard last but its config contract first — its outputs are four other layers' inputs.
- Q&A and multi-repo, though both Active requirements, are the two highest-complexity items and benefit from riding on a proven single-repo path.

### Research Flags

Phases likely needing deeper research during planning:
- **Phase 2b (Ingress):** the tunnel-domain pinning API for the in-process SDK is unverified, `webhookTimestamp` units (ms vs s) are unconfirmed, and the webhook-secret doc contradiction needs a live check.
- **Phase 2c (Execution):** `--session-id` alongside `-p`, `--json-schema` surviving `--resume`, and the exact `stream-json` event shape for progress and `total_cost_usd` all need verification against the installed CLI.
- **Phase 3 (Orchestration):** no external unknowns, but the highest design density — worth a plan review even without new research.

Phases with standard patterns (skip research-phase):
- **Phase 2a (Foundation):** SQLite + zod + pino are fully specified in STACK.md, down to v4 idioms.
- **Phase 2d (Outbound):** Linear client behaviour is exhaustively documented in PITFALLS.md Pitfall 11.
- **Phase 5 (Wizard):** an assembly of already-enumerated preflight checks.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | Versions from the npm registry; API surfaces from installed `.d.ts`; `claude`/`gh`/`zod`/`better-sqlite3` executed on this machine; the webhook receiver proven with a real signed POST. |
| Features | MEDIUM | HIGH on Linear's agent protocol and Copilot's rails (vendor docs); MEDIUM on Devin/Jules/Cursor (doc summaries and secondary reporting). Field data is strong but single-team (dotnet/runtime, 878 PRs). |
| Architecture | MEDIUM-HIGH | External contracts read from first-party vendor docs; the internal decomposition is judgement, not citation. Two items tagged `VERIFY`. Its ngrok assumptions are superseded by PITFALLS.md. |
| Pitfalls | MEDIUM-HIGH | Every load-bearing claim traces to first-party vendor documentation. Two items explicitly unconfirmed (Linear's per-workspace webhook limit and its auto-disable threshold — the docs are silent). |

**Overall confidence:** HIGH — high enough to write the roadmap without further research, provided the Corrections section is applied.

### Gaps to Address

- **ngrok static-domain pinning through the in-process SDK.** The static domain is confirmed for the account; that `@ngrok/ngrok` exposes the CLI's `--url` equivalent is not. → Smoke-test in the tunnel phase; fall back to reconcile-on-boot if absent.
- **`webhookTimestamp` units (ms vs s).** Off by 1000 makes the replay check either always-pass or always-fail — and always-pass is the silent one. → Confirm against one real delivery before shipping the check.
- **Webhook secret returned at create time.** Docs and schema contradict each other. → Made moot by supplying the secret yourself; no action beyond doing that.
- **`--session-id` with `-p`, and `--json-schema` surviving `--resume`.** Both flags documented independently; the combinations are inferred. → Verify early in the execution phase; fallbacks are known (parse `session_id` from any event; pass `--json-schema` on every invocation including resumes).
- **Whether Linear's GitHub integration auto-links a PR opened on `issue.branchName` when the actor is a plain bot user.** Assumed yes (branch-name matching is actor-independent), but the "free bidirectional link" claim rests on it. → One real PR settles it.
- **No public precedent for a comment-based (non-OAuth) Linear agent at any scale.** Every documented integration uses the app-user path. → Treat the Q&A comment protocol as genuinely novel; the timeout-to-assumption fallback is what makes that acceptable.
- **`claude -p` progress-event granularity.** If the stream is coarser than assumed, throttled progress degrades to "started / finished" and the cost line needs another source. → Verify in the execution phase.

## Sources

### Primary (HIGH confidence — executed, or read from first-party vendor docs)
- npm registry (`registry.npmjs.org/<pkg>/latest`); installed `.d.ts` for `@linear/sdk@93.0.1` and `@ngrok/ngrok@1.7.0`; a live `node:http` + `@linear/sdk/webhooks` signature test; `claude --help` plus 4 live `claude -p` runs (v2.1.259); `gh pr create --help` (v2.98.0); `zod@4.5.4` and `better-sqlite3@13.0.3` executed locally
- [linear.app/developers/webhooks](https://linear.app/developers/webhooks) — actor nullability, `updatedFrom`, `Linear-Delivery`, raw-body HMAC, timestamp check, 5000 ms budget, 3-retry backoff, admin requirement
- [linear.app/developers/rate-limiting](https://linear.app/developers/rate-limiting) — 2,500 req/hr, 3M complexity pts/hr, 10,000-pt query ceiling, HTTP 400 + `RATELIMITED`
- [linear.app/developers/agents](https://linear.app/developers/agents) · [agent-best-practices](https://linear.app/developers/agent-best-practices) · [agent-interaction](https://linear.app/developers/agent-interaction) · [oauth-actor-authorization](https://linear.app/developers/oauth-actor-authorization) — `elicitation`, 10s ack, "comments are editable and unreliable", `actor=app` gating
- [code.claude.com/docs/en/headless](https://code.claude.com/docs/en/headless) · [cli-reference](https://code.claude.com/docs/en/cli-reference) · [agent-sdk/mcp](https://code.claude.com/docs/en/agent-sdk/mcp) — `--bare` semantics, Manual default mode, `--permission-prompts none`, SIGINT vs SIGTERM, `--session-id`, and the **2-minute MCP backgrounding behaviour** that rules out the long-poll design
- [ngrok free static domains](https://ngrok.com/blog/free-static-domains-ngrok-users) · [free plan limits](https://ngrok.com/docs/pricing-limits/free-plan-limits) — permanent dev domain; 1 GB/mo, 20,000 req/mo, 3 endpoints
- [docs.github.com — Copilot coding agent](https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent) · [risks and mitigations](https://docs.github.com/en/copilot/concepts/agents/cloud-agent/risks-and-mitigations) — cannot work across repos, 59-min cap, full rail list
- [git-worktree(1)](https://git-scm.com/docs/git-worktree) · [gh pr create](https://cli.github.com/manual/gh_pr_create) · [nodejs.org/api/sqlite.html](https://nodejs.org/api/sqlite.html)

### Secondary (MEDIUM confidence)
- [dotnet/runtime — ten months with the coding agent](https://devblogs.microsoft.com/dotnet/ten-months-with-cca-in-dotnet-runtime/) — 878 PRs / 67.9% merged; 38%→69% from instructions; 52.3% needed human commits (86.2% vs 55.1%); review capacity as the real bottleneck
- [github.blog — reviewing agent PRs](https://github.blog/ai-and-ml/generative-ai/agent-pull-requests-are-everywhere-heres-how-to-review-them/) — CI weakening as the top reviewer complaint; verbosity; >5-unrelated-files heuristic
- [curl ends bug bounty](https://www.theregister.com/2026/01/21/curl_ends_bug_bounty/) — >15% → <5% valid-finding rate; the Node.js 19k-line PR petition
- [tokezooo/linear-agent-bridge](https://github.com/tokezooo/linear-agent-bridge) — closest existing Linear→agent bridge; HMAC, >60s stale filter, `viewer`-based self-filtering. No queue, no worktree, no PR creation — the gaps this project fills
- Cursor / Devin / Jules product docs; Hookdeck Linear webhook guide; GitLab webhook recursion detection; better-sqlite3 performance docs

### Tertiary (LOW confidence — not relied on)
- OpenHands resolver docs (404'd through two paths); nothing above depends on them

---
*Research completed: 2026-09-06*
*Ready for roadmap: yes*
