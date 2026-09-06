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
- [ ] Self-managed ngrok tunnel via the `@ngrok/ngrok` in-process SDK — random free domain, no orphan tunnels possible
- [ ] Idempotent Linear webhook registration against the freshly created tunnel URL, with signature verification and delivery-ID dedupe
- [ ] Config map from Linear project → one or more local repo directories, with optional Slack incoming-webhook URL and per-entry behavior toggles
- [ ] Issue pickup triggered by assignment to a dedicated Linear bot user, with automatic transition to In Progress
- [ ] Per-ticket git worktree using Linear's suggested branch name, isolated from the operator's working copy
- [ ] Spawned local `claude -p` session running the GSD workflow against the ticket body
- [ ] SQLite-backed run queue with a configurable global concurrency cap (default 3), surviving process restart
- [ ] Bidirectional Linear comment channel: bot posts marked status and question comments, and blocks a run on a threaded reply with a timeout fallback to a stated assumption
- [ ] Worker-owned delivery: push the branch, open the PR with `gh`, and report the PR URL to Linear, Slack, and logs
- [ ] Multi-repo runs — one ticket may produce PRs across several mapped repos
- [ ] Structured logging of every state transition regardless of Slack or Linear comment settings

### Out of Scope

- Hosted/multi-tenant deployment — this is a single-operator local daemon; no auth layer, no user model
- OAuth `actor=app` Linear identity — evaluated and deferred; a bot account with a personal API key is free on Linear Free and needs no OAuth flow or token refresh. Revisit if the workspace moves to a paid plan where a bot seat is billable
- Automatic merging of PRs — the human reviews and merges; the bot's output is always a PR
- Provisioning or authenticating GitHub and Claude — both are detected from the operator's existing local CLI auth, never prompted for
- A web UI or dashboard — logs, Linear, and Slack are the interface

## Context

- Runs on macOS on the operator's own machine, alongside an already-configured `gh` CLI, `claude` CLI, and a global GSD install
- GSD (`~/.claude/skills/gsd-*`) is the workflow the spawned agent runs; the agent inherits it from the global install rather than shipping its own copy
- Linear plan matters for identity cost: Free gives unlimited members (2 teams, 250 issues), so a bot account is free; Basic/Business bill per user at $10/$16 per month
- ngrok requires a verified account and authtoken for all tunnels including free ones. The `@ngrok/ngrok` SDK reads `NGROK_AUTHTOKEN` from the environment rather than `~/.config/ngrok/ngrok.yml`, so the wizard lifts an existing token out of that YAML when present
- Linear returns the webhook signing secret at `webhookCreate` time — it is persisted by the worker, never prompted for

## Constraints

- **Tech stack**: TypeScript on Node — chosen by the operator; the Linear SDK, ngrok SDK, and `better-sqlite3` all have first-class Node support
- **Build strategy**: Horizontal layers, full parallelism — the operator wants every layer built at once rather than a thin vertical slice first
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
| Blocking Q&A with timeout fallback | The only shape that actually gets answers back into the run; the timeout removes any deadlock risk by converting an unanswered question into a stated assumption | — Pending |
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
*Last updated: 2026-09-06 after initialization*
