# linear-auto-worker

## What This Is

A local TypeScript daemon that turns Linear issues into pull requests without a human in the loop. It opens its own ngrok tunnel at boot, registers that URL as a Linear webhook, and watches for issues assigned to a dedicated bot user. When one arrives it moves the issue to In Progress, creates a git worktree in the mapped repo, spawns a local `claude -p` session that runs the GSD workflow against the ticket, then pushes the branch and opens a PR — reporting progress to Linear comments, Slack, and logs the whole way.

It is a single-operator tool: it runs on the developer's own machine, uses the `gh` and `claude` CLIs that are already authenticated there, and is configured through one guided setup wizard.

## Core Value

An issue assigned to the bot in Linear becomes a reviewable pull request, with no manual step in between.

## Requirements

### Validated

(None yet — ship to validate)

### Active

- [ ] One-line guided setup wizard that preflights the local toolchain, prompts only for missing secrets, builds the project→repo map interactively, and verifies by registering the Linear webhook
- [ ] Self-managed ngrok tunnel via the `@ngrok/ngrok` in-process SDK — random ephemeral free domain, no orphan tunnels possible
- [ ] Idempotent Linear webhook reconciliation against the freshly created tunnel URL each boot — update the existing webhook rather than create a new one, with client-supplied signing secret, signature verification, and delivery-ID dedupe
- [ ] Boot-time and periodic reconciliation poll for bot-assigned issues with no run record — recovers work whose webhook delivery was lost while the daemon was down or its tunnel URL was stale
- [ ] Config map from Linear project → one or more local repo directories, with optional Slack incoming-webhook URL and per-entry behavior toggles
- [ ] Issue pickup triggered by assignment to a dedicated Linear bot user, with acknowledgement and transition to In Progress emitted before any slower work, and the operator added as a subscriber so the ticket stays in their Inbox
- [ ] Four-layer webhook feedback-loop prevention so the bot never reacts to its own comments, transitions, or updates
- [ ] Per-ticket git worktree using Linear's suggested branch name, isolated from the operator's working copy
- [ ] Spawned local `claude -p` session running the GSD workflow against the ticket body
- [ ] SQLite-backed run queue with a configurable global concurrency cap (default 3), surviving process restart
- [ ] Bidirectional Linear comment channel via exit-and-resume: the agent ends its turn with a schema-constrained `needs_input` result, the process exits and releases its concurrency slot, the worker persists the question with a deadline and resumes the session with `--resume` on a threaded reply — or on timeout, with a stated assumption posted back
- [ ] Worker-owned delivery: push the branch, open the PR with `gh`, and report the PR URL to Linear, Slack, and logs
- [ ] Multi-repo runs — one ticket may produce PRs across several mapped repos
- [ ] Structured logging of every state transition regardless of Slack or Linear comment settings

### Out of Scope

- Hosted/multi-tenant deployment — this is a single-operator local daemon; no auth layer, no user model
- OAuth `actor=app` Linear identity — evaluated and deferred on cost grounds. Research later showed the capability cost is larger than assumed: assignable/mentionable app users, `AgentSessionEvent`, and the native `elicitation` activity type (which is exactly the blocking-Q&A requirement) are all gated behind it. Still out of scope for v1, but recorded as the single highest-value v2 upgrade — it converts three hand-built features into vendor-native ones at once. Revisit the moment the workspace leaves Free or a second person uses the tool
- Automatic merging of PRs — the human reviews and merges; the bot's output is always a PR
- Provisioning or authenticating GitHub and Claude — both are detected from the operator's existing local CLI auth, never prompted for
- A web UI or dashboard — logs, Linear, and Slack are the interface

## Context

- Runs on macOS on the operator's own machine, alongside an already-configured `gh` CLI, `claude` CLI, and a global GSD install
- GSD (`~/.claude/skills/gsd-*`) is the workflow the spawned agent runs; the agent inherits it from the global install rather than shipping its own copy
- Linear plan matters for identity cost: Free gives unlimited members (2 teams, 250 issues), so a bot account is free; Basic/Business bill per user at $10/$16 per month
- ngrok requires a verified account and authtoken for all tunnels including free ones. The `@ngrok/ngrok` SDK requires `authtoken_from_env: true` to read `NGROK_AUTHTOKEN` and does not read `~/.config/ngrok/ngrok.yml`, so the wizard lifts an existing token out of that YAML when present
- The webhook signing secret is generated locally and supplied via `WebhookCreateInput.secret`, never read back from the API — Linear's docs and shipped schema disagree on whether creation returns it
- `webhookCreate` requires workspace-admin permission, so the bot account must be a workspace admin (free on Linear Free). The wizard probes this with a `webhooks()` read and fails loudly with an actionable message
- Linear signals rate limiting with HTTP 400 and `errors[].extensions.code === "RATELIMITED"`, not 429. Budgets are 2,500 requests/hour and an independent 3M complexity-points/hour with a 10,000-point per-query ceiling

## Constraints

- **Tech stack**: TypeScript on Node — chosen by the operator; the Linear SDK, ngrok SDK, and `better-sqlite3` all have first-class Node support
- **Build strategy**: Horizontal layers, full parallelism — the operator wants every layer built at once rather than a thin vertical slice first. One genuine serialization point survives: domain types, the run state machine, and the SQL schema are imported by every layer and must land before them
- **Agent invocation**: `claude -p` must always pass an explicit `--permission-mode` (it starts in Manual and would otherwise be denied every edit while still exiting 0) and `--verbose` (mandatory with `stream-json`). `--bare` is forbidden — it skips `~/.claude` and would kill the global GSD install this project depends on
- **Reliability posture**: Best effort, never fragile. Any coordination that cannot be made reliable (notably comment-driven Q&A) must degrade to a documented assumption rather than hang or silently drop work
- **Tunnel singleton**: exactly one tunnel per worker process, enforced structurally by the in-process SDK rather than by lockfiles
- **Concurrency**: global cap on simultaneous spawned Claude sessions, default 3, to stay within local RAM
- **Secrets**: only `LINEAR_API_KEY` and `NGROK_AUTHTOKEN` are ever prompted; everything else is detected or generated

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Pickup via assignment to a dedicated bot user | `assigneeId` is single-valued, so one unambiguous webhook signal with no double-fire from unrelated label churn; unassigning is a clean stop; visible natively in Linear views | — Pending |
| Bot account with a personal API key, not OAuth `actor=app` | Free on Linear Free (unlimited members); no OAuth registration, browser flow, or token refresh. Comments and transitions still attributed to the bot | — Pending |
| `@ngrok/ngrok` in-process SDK over the ngrok CLI | Tunnel lifetime is bound to the worker process, so a duplicate or orphaned tunnel is structurally impossible — no lockfile or PID tracking needed | — Pending |
| `claude -p` child process as the agent host | GSD is already installed globally so nothing needs wiring; crash-isolated from the worker; `--resume <sessionId>` provides mid-run continuation for the Q&A flow | — Pending |
| git worktree per ticket | Two tickets in the same repo cannot collide, creation is cheap, and the operator's own working copy is never touched | — Pending |
| SQLite (`better-sqlite3`) for run state | Run queue, pending questions, webhook delivery IDs, and the webhook secret must survive a restart for the blocking Q&A flow to be correct; one file, no server | — Pending |
| Q&A via exit-and-`--resume`, not a blocking in-process wait | An MCP long-poll tool does not actually block: Claude Code backgrounds any main-conversation MCP call still running past ~2 minutes and the agent proceeds without the answer. Ending the turn with a schema-constrained `needs_input` result instead frees the concurrency slot, costs zero RAM while waiting, and survives a worker restart | — Pending |
| Runs in `awaiting_answer` hold no concurrency slot | A blocked run holding a slot would starve the queue behind a human who may never reply. Load-bearing for the whole scheduler design | — Pending |
| Never decide from `payload.data` — treat a webhook as a hint and re-fetch the issue | Collapses three separate problems (out-of-order events, duplicate deliveries, fields missing from the payload) into one rule | — Pending |
| Keep the ephemeral random ngrok domain despite the free static domain being available | Operator's explicit preference. Cost: the webhook URL must be reconciled on every boot and a missed-work poll becomes mandatory, since deliveries made while the daemon was down retry against a dead URL and are lost | — Pending |
| Bot account is a workspace admin | `webhookCreate` requires admin; free on Linear Free, and it preserves the two-secrets constraint for the wizard | — Pending |
| Bot subscribes the operator on pickup | Assignee-based pickup takes the ticket out of the operator's "Assigned to me" view, inverting Linear's delegation model. Adding them as a subscriber keeps it in their Inbox for a three-line cost | — Pending |
| No HTTP framework — `LinearWebhookClient.createHandler()` on `node:http` | The handler is itself a `node:http` request listener that consumes the raw body stream and verifies the HMAC before any JSON parsing. Express/Fastify/Hono would each reintroduce the raw-body problem | — Pending |
| Rush mode: all eight phases fanned out at once, one gate at the end | Operator's explicit direction, extending the "full horizontal implementation" constraint to its limit. No per-phase typecheck, test, or build; a single integration gate runs at milestone end. Cost: the eight branches all import `src/domain/`, so every signature mismatch surfaces at the final merge as one pile with no attribution to a phase. Mitigation: the domain surface is fixed as **binding text** in `01-CONTEXT.md`'s ADDENDUM — exact state literals, table names, module paths — so all eight executors code against identical identifiers rather than each inventing their own, and a phase needing a contract addition records it in its SUMMARY instead of editing `src/domain/` | — Pending |
| Worker owns push and PR creation | Deterministic — delivery does not depend on the spawned agent remembering to run a final step | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-09-06 after initialization and domain research*
