---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
current_phase: 8
current_phase_name: Setup Wizard & Safety Pass
status: milestone_complete
stopped_at: v1.0 shipped, published, and live-verified end to end
last_updated: "2026-09-11T16:30:00.000Z"
last_activity: 2026-09-11
last_activity_desc: "Quick task 260911-i3p: the poll is O(1) in issue count; dead twin poll.ts deleted (T129)"
progress:
  total_phases: 8
  completed_phases: 8
  total_plans: 35
  completed_plans: 35
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-09-06)

**Core value:** An issue assigned to the bot in Linear becomes a reviewable pull request, with no manual step in between.
**Current focus:** Phase 1 — Domain Contract, State Machine & Schema

## Current Position

Phase: 8 of 8 (Setup Wizard & Safety Pass) — milestone complete
Plan: 35 of 35 complete
Status: Shipped. Published at ohmaseclaro/linear-auto-worker (MIT, public), CI green on Node 22/24 x Ubuntu/macOS.
Last activity: 2026-09-11 — Quick task 260911-i3p: the reconciliation poll costs 1 request per tick instead of 48 (T129)

Progress: [██████████] 100%

## Performance Metrics

**Velocity:**

- Total plans completed: 0
- Average duration: —
- Total execution time: —

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| - | - | - | - |

**Recent Trend:**

- Last 5 plans: —
- Trend: —

*Updated after each plan completion*
**Per-Plan Metrics:**

| Plan | Duration | Tasks | Files |
|------|----------|-------|-------|
| Phase 02 P01 | 25min | 2 tasks | 7 files |
| Phase 02 P02 | 8min | 2 tasks | 4 files |

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- Roadmap: horizontal layers with one serialization point — Phase 1 (domain contract + state machine + SQL schema) blocks everything; Phases 2-6 then run fully parallel with zero sibling imports
- Roadmap: Phase 3's four-layer self-event filter (HOOK-07) is a merge gate for Phase 5's live Linear writes — integrating notifications without it loops the first end-to-end test
- Roadmap: within Phase 7, router→engine is wired before engine→execution, so ingress bugs do not cost a Claude session each to reproduce
- Roadmap: the wizard ships last (Phase 8) but the config shape it writes is fixed in Phases 1-2, because four layers read it
- [Phase ?]: Split config.ts into a tracer-minimal Task 1 version and a fully-validated Task 2 version (02-01)
- [Phase ?]: 02-02: SqliteStore CRUD is a generic patch-based repository with zero transition validation; findActiveRunByIssue treats delivered/partial/failed/cancelled as terminal (plan text omitted partial, corrected as Rule 1 fix)

### Pending Todos

Operator actions, not code work:

- Rotate the Slack incoming-webhook URL in `~/.linear-auto-worker/config.json` — it was exposed in a working session on 2026-09-07.
- Repoint the Instantchat mapping away from the throwaway `~/law-uat-sandbox` to the real repos (`law setup` then edit repos).
- Delete the `ohmaseclaro/law-uat-sandbox` GitHub repo and its local clone once the UAT record is no longer wanted.

### Blockers/Concerns

All five research corrections below were applied during their phases and are closed; kept for provenance.

Research corrections applied (research/SUMMARY.md "Corrections to PROJECT.md"):

- ngrok free accounts have a **permanent static domain** — PROJECT.md's "random domain per boot" is wrong. The webhook URL is configuration, not a per-boot value. Affects Phase 3.
- `@linear/sdk` v93 removed `LinearWebhooks`; use `LinearWebhookClient.createHandler()` on `node:http` with no framework. Invalid signature returns **400**, not 401. Affects Phase 3.
- `claude -p` starts in Manual permission mode and `--bare` strips the global GSD install — both fail silently with exit 0. Affects Phase 4.
- An MCP long-poll `ask_human` tool does not block the agent (backgrounded after ~2 min); only exit-and-`--resume` works. Affects Phases 4 and 6.
- Linear signals rate limiting with HTTP 400 + `extensions.code === "RATELIMITED"` — any `status === 429` check is dead code. Affects Phase 5.

Open verifications flagged for phase planning: ngrok static-domain pinning via the in-process SDK and `webhookTimestamp` units (Phase 3); `--session-id` with `-p` and `--json-schema` surviving `--resume` (Phase 4).

## Deferred Items

Items acknowledged and carried forward from previous milestone close:

| Category | Item | Status | Deferred At |
|----------|------|--------|-------------|
| Resume semantics | An interrupted run resumes as a fresh attempt on a new branch (`-2` suffix) rather than continuing the original branch; the spent `--session-id` cannot be reused. Abandoned worktree and local branch are pruned at the next boot, verified live. | Accepted as designed | 2026-09-07 |
| Cleanup timing | Worktree pruning is deferred to the next boot rather than running at delivery, so a long-lived daemon accumulates delivered worktrees until restart. | Open, low priority | 2026-09-07 |

## Quick Tasks Completed

| ID | Task | Severity | Commits | Completed |
|----|------|----------|---------|-----------|
| 260907-szl | Worktree base must be the remote-tracking ref, not the local branch | P1 | `acf02b2`, `8891a3f`, `dcd047c` | 2026-09-07 |
| 260907-voh | `law watch` and `law say` — live run observability and mid-flight interaction | P2 | `24bf09c`, `9712297`, `7e97c67`, `5ffc811`, `22c857d` | 2026-09-07 |
| 260908-bms | `ALLOWED_TOOLS` under-grants (Skill, Read) and the probe that would prove it crashes | P1 | `c81df58`, `2c0b700`, `988b037` | 2026-09-08 |
| 260908-crx | The disambiguation listing prints a field that is not a target, so ambiguity is a dead end | P1 | `e51a388`, `4691669`, `527d325` | 2026-09-08 |
| 260909-lvl | Wire the dead PR body, the issue key in the PR title, and the leaked bot marker | P1 | `f8debdf`, `78f4116`, `48f3eff`, `2fddf6d` | 2026-09-09 |
| 260909-nh6 | A second, silent, poll-only daemon instance for the Lahzo workspace | P2 | `24d05a7`, `b04973c`, `e8cf1f6`, `6f07bf8` | 2026-09-09 |
| 260909-tfm | Parent-directory multi-repo mode: one agent session, one PR per repo | P2 | `02258c4`, `f625ecd`, `862563e`, `d0d3fa5`, `95ef561` | 2026-09-09 |
| 260910-sm5 | The PR body named the tool and printed the operator's local paths, on every PR a silent instance opens | P1 | `82c85fb`, `500d011`, `315b0dd` | 2026-09-10 |
| 260911-i3p | The reconciliation poll cost 3.9 requests per issue for two fields, exceeding Linear's 2500/hour cap by construction | P0 | `bcae21e`, `26d4950`, `61863d8` | 2026-09-11 |

## Session Continuity

Last session: 2026-09-11T16:30:00.000Z
Stopped at: Completed quick task 260911-i3p (poll cost 48 req -> 1 req, measured live; 768/768 + both smokes)
Resume file: None
