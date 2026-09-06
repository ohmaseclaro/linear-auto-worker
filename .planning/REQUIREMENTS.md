# Requirements: linear-auto-worker

**Defined:** 2026-09-06
**Core Value:** An issue assigned to the bot in Linear becomes a reviewable pull request, with no manual step in between.

## v1 Requirements

### Setup

- [ ] **SETUP-01**: Operator runs one command that preflights the local toolchain — Node version, git, git identity, `gh auth status`, `claude` on PATH, global GSD install — and reports each check with an actionable fix on failure
- [ ] **SETUP-02**: Wizard prompts for the Linear API key only when one is not already present, and validates it with a live API call before continuing
- [ ] **SETUP-03**: Wizard probes that the Linear key has workspace-admin permission via a `webhooks()` read, and fails with a message naming the exact fix when it does not
- [ ] **SETUP-04**: Wizard obtains the ngrok authtoken — reusing one found in `~/.config/ngrok/ngrok.yml` when present, otherwise prompting — and persists it
- [ ] **SETUP-05**: Wizard lists Linear teams and projects and discovers local git repos, letting the operator build the project→repo map interactively rather than by hand-editing JSON
- [ ] **SETUP-06**: Wizard captures an optional Slack incoming-webhook URL and the behavior toggles for each mapping
- [ ] **SETUP-07**: Wizard warns for every mapped repo that has no `CLAUDE.md` or `AGENTS.md`, naming it as the highest-leverage success factor
- [ ] **SETUP-08**: Wizard verifies each mapped repo has a remote and a resolvable default branch, and records that base branch in the mapping
- [ ] **SETUP-09**: Wizard registers the Linear webhook end to end, so setup finishes with a system that is already working
- [ ] **SETUP-10**: Config is validated against a schema at load time, with errors naming the offending field and expected shape

### Tunnel

- [ ] **TUN-01**: Worker opens exactly one ngrok tunnel per process at boot through the in-process SDK and exposes its public URL to the rest of the system
- [ ] **TUN-02**: Tunnel lifetime is bound to the worker process — no orphaned tunnel survives a normal shutdown, a crash, or a restart
- [ ] **TUN-03**: Worker refuses to start with a clear message when the ngrok authtoken is missing, invalid, or rejected

### Webhook Plumbing

- [ ] **HOOK-01**: HTTP server is bound and serving before the tunnel opens, so no delivery ever hits a live URL backed by nothing
- [ ] **HOOK-02**: Worker reconciles the Linear webhook at every boot by updating the existing registration's URL rather than creating a new one, so restarts never accumulate duplicate webhooks
- [ ] **HOOK-03**: Webhook signing secret is generated locally and persisted before registration, then supplied to Linear rather than read back from the API
- [ ] **HOOK-04**: Every inbound delivery has its HMAC verified against the raw request body before any JSON parsing; invalid signatures are rejected without side effects
- [ ] **HOOK-05**: Deliveries whose timestamp falls outside the staleness window are rejected, preventing replay storms after a restart
- [ ] **HOOK-06**: Duplicate deliveries are dropped idempotently via a uniqueness constraint on the delivery ID
- [ ] **HOOK-07**: Events authored by the bot itself are dropped through four independent layers — actor ID match, invisible comment marker, post-write suppression window, and delivery-ID uniqueness — with a null actor treated as untrusted rather than as not-the-bot
- [ ] **HOOK-08**: Worker acknowledges every delivery with 200 inside the delivery timeout and performs all real work asynchronously
- [ ] **HOOK-09**: Webhooks registered against tunnel URLs that are no longer live are pruned rather than left to fail deliveries

### Intake

- [ ] **INTK-01**: An issue assigned to the bot user creates a run record
- [ ] **INTK-02**: Acknowledgement comment and the In Progress transition are posted within ten seconds of delivery, before worktree creation or any git operation
- [ ] **INTK-03**: Operator is added as a subscriber on pickup, so the ticket stays in their Inbox despite leaving their assigned view
- [ ] **INTK-04**: The In Progress workflow state is resolved per team at runtime, never hardcoded
- [ ] **INTK-05**: No decision is ever made from the webhook payload body — the payload is a hint that an issue changed, and the issue is re-fetched before acting
- [ ] **INTK-06**: Runs are queued against a configurable global concurrency cap defaulting to three, and a queued ticket receives a "queued, position N" acknowledgement that is edited in place rather than re-posted
- [ ] **INTK-07**: A boot-time and periodic reconciliation poll finds bot-assigned issues with no run record, recovering work whose delivery was lost while the daemon was down or its tunnel URL was stale
- [ ] **INTK-08**: Unassigning the bot cancels a queued run and requests cancellation of a running one

### Agent Execution

- [ ] **AGNT-01**: Each run gets its own git worktree off the mapped repo, on the branch name Linear suggests for the issue
- [ ] **AGNT-02**: Worktree is removed after a successful delivery and deliberately left in place after a failure so the operator can take over in it
- [ ] **AGNT-03**: Worktrees orphaned by a crashed run are detected and pruned at boot
- [ ] **AGNT-04**: The Claude session ID is generated and persisted to the run record before the process is spawned, never parsed out of the output stream
- [ ] **AGNT-05**: Every invocation passes an explicit permission mode and verbose streaming; `--bare` is never used, with a comment recording that it would skip the global GSD install
- [ ] **AGNT-06**: The streamed JSON output is parsed incrementally, tolerating partial lines and events that arrive before session initialization
- [ ] **AGNT-07**: The run asserts that GSD skills are present in the spawned session and fails loudly rather than silently producing unstructured work
- [ ] **AGNT-08**: A per-run hard timeout kills the whole process tree, posts an error, and leaves the worktree intact
- [ ] **AGNT-09**: The agent prompt instructs commit-only work — the agent never pushes and never opens a pull request
- [ ] **AGNT-10**: Ticket and comment text is stripped of control and zero-width characters before it enters the agent prompt
- [ ] **AGNT-11**: Worker secrets are never passed into the spawned child's environment

### Question and Answer

- [ ] **QA-01**: The agent can end its turn with a schema-constrained result declaring it needs input, carrying the question and the assumption it would otherwise make
- [ ] **QA-02**: The question is posted to Linear as a marked comment and the run moves to an awaiting-answer state
- [ ] **QA-03**: A run awaiting an answer holds no concurrency slot, so a blocked run can never starve the queue
- [ ] **QA-04**: A threaded reply is correlated to its pending question by comment ID and resumes the same Claude session with the answer
- [ ] **QA-05**: When the deadline expires the run resumes with its stated assumption, and that assumption is posted to Linear so the record shows what was decided
- [ ] **QA-06**: Pending questions and their deadlines survive a worker restart
- [ ] **QA-07**: The question flow can be disabled per mapping, in which case the agent always proceeds on its stated assumption

### Delivery

- [ ] **DELV-01**: The worker, not the agent, pushes the branch and opens the pull request
- [ ] **DELV-02**: Pull requests are opened as drafts by default, with a per-mapping toggle to open them ready for review
- [ ] **DELV-03**: The pull request body is templated by the worker — ticket link, one-line summary, test command and result, an explicit "what I did not do" section, and the path to the run log
- [ ] **DELV-04**: A push is refused and no pull request is opened when the working branch is the repository's default branch
- [ ] **DELV-05**: The pull request URL is reported to Linear, to Slack, and to the logs
- [ ] **DELV-06**: A single ticket can produce pull requests across several mapped repos, as one sub-run per repo
- [ ] **DELV-07**: Per-repo outcomes are reported independently, and one repo failing never discards another repo's completed pull request
- [ ] **DELV-08**: Any diff touching CI or workflow files is flagged prominently in the pull request body and the terminal comment
- [ ] **DELV-09**: The diff is scanned for secrets and environment files before push, and the push is blocked on a hit

### Notification

- [ ] **NOTF-01**: Every run state transition is written as one structured log line carrying the run ID and issue ID, greppable without a dashboard
- [ ] **NOTF-02**: A terminal state is always posted to Linear on both success and failure, emitted from a finally so a crash, timeout, or restart still produces one
- [ ] **NOTF-03**: Progress updates are throttled to milestones rather than streamed step by step
- [ ] **NOTF-04**: Slack is notified on terminal states and on a question being asked, never on progress
- [ ] **NOTF-05**: Linear comment posting can be disabled per mapping without any loss of logging
- [ ] **NOTF-06**: Run cost and token usage are logged and included in the terminal comment

### Operations

- [ ] **OPS-01**: Run state survives a restart — runs interrupted mid-flight are detected at boot and explicitly failed or requeued, never left as zombies with a stuck In Progress ticket
- [ ] **OPS-02**: The SQLite store runs in WAL mode with a busy timeout and does not block the event loop under concurrent runs
- [ ] **OPS-03**: Linear rate limiting is detected by its error extension code rather than an HTTP status, and backed off according to the reset header
- [ ] **OPS-04**: A failed run is attempted once — failure posts a diagnosis with the error and log path, and leaves the branch and worktree for the operator, rather than retrying
- [ ] **OPS-05**: The worker shuts down cleanly on interrupt and terminate — killing spawned children, closing the tunnel, and marking in-flight runs

### Configuration

- [ ] **CONF-01**: A map from Linear project to one or more local repo directories, each with an optional Slack incoming-webhook URL
- [ ] **CONF-02**: Per-mapping behavior toggles covering Linear comments, Slack notification, base branch, draft versus ready pull requests, the question flow, and maximum run time

## v2 Requirements

Deferred to a future release. Tracked but not in the current roadmap.

### Native Linear Agent Identity

- **OAUTH-01**: Authenticate as an OAuth application with `actor=app`, giving the bot its own workspace identity with no user account
- **OAUTH-02**: Use Linear's native agent sessions and the `elicitation` activity type in place of the hand-rolled comment question flow
- **OAUTH-03**: Become assignable and @-mentionable as a Linear agent, with activities rendered in the dedicated session panel instead of the comment stream

### Observability

- **OBS-01**: A CLI to query run history, replay a run's log, and report aggregate cost

## Out of Scope

Explicitly excluded. Documented to prevent scope creep.

| Feature | Reason |
|---------|--------|
| Auto-merge on green CI | Contradicted by every mature product in the space — GitHub Copilot is structurally incapable of merging or marking a PR ready, and dotnet/runtime requires an explicit human request for every merge. Green CI is not a quality signal when the agent can also weaken CI |
| Unbounded concurrency | Five concurrent Claude sessions exhaust laptop RAM, and the resulting PRs land simultaneously on one reviewer. The cap is a feature, not an apology |
| Auto-pickup of every new issue in a project | This is the slop generator. curl shut down its bug bounty over AI-submission volume; the deliberate act of assignment is the point |
| Retry-on-failure loops | A run that failed on an underspecified task fails identically on retry at full token cost. The recovery that actually works is a human commit on the branch |
| Agent self-review or self-approval | Copilot explicitly prevents it. Self-review is theater |
| Streaming every agent step into Linear or Slack | Turns the ticket into an unreadable wall and trains the operator to mute the bot, destroying the terminal-state notification that matters |
| Letting the agent edit CI or workflow files unprompted | CI weakening is the top reviewer complaint about agent PRs. Flag or deny instead |
| Long narrative agent-authored PR descriptions | Verbose bodies actively slow review; the worker templates a short structured body instead |
| Cross-run memory or learned preferences | A large stateful subsystem whose value is already captured by a version-controlled `CLAUDE.md` the operator owns |
| Confidence scoring or task-suitability prediction | Requires a calibration corpus that does not exist on day one. Publish known priors in the README instead |
| Web dashboard | A second UI, a server, and a port to maintain for a single-operator tool whose users live in Linear and a terminal |
| Hosted or multi-tenant deployment | Single-operator local daemon — no auth layer, no user model |
| Provisioning or authenticating GitHub and Claude | Both are detected from the operator's existing local CLI auth, never prompted for |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| SETUP-01 | Phase 8 — Setup Wizard & Safety Pass | Pending |
| SETUP-02 | Phase 8 — Setup Wizard & Safety Pass | Pending |
| SETUP-03 | Phase 8 — Setup Wizard & Safety Pass | Pending |
| SETUP-04 | Phase 8 — Setup Wizard & Safety Pass | Pending |
| SETUP-05 | Phase 8 — Setup Wizard & Safety Pass | Pending |
| SETUP-06 | Phase 8 — Setup Wizard & Safety Pass | Pending |
| SETUP-07 | Phase 8 — Setup Wizard & Safety Pass | Pending |
| SETUP-08 | Phase 8 — Setup Wizard & Safety Pass | Pending |
| SETUP-09 | Phase 8 — Setup Wizard & Safety Pass | Pending |
| SETUP-10 | Phase 2 — Foundation | Pending |
| TUN-01 | Phase 3 — Ingress | Pending |
| TUN-02 | Phase 3 — Ingress | Pending |
| TUN-03 | Phase 3 — Ingress | Pending |
| HOOK-01 | Phase 7 — Integration & Daemon Lifecycle | Pending |
| HOOK-02 | Phase 3 — Ingress | Pending |
| HOOK-03 | Phase 3 — Ingress | Pending |
| HOOK-04 | Phase 3 — Ingress | Pending |
| HOOK-05 | Phase 3 — Ingress | Pending |
| HOOK-06 | Phase 3 — Ingress | Pending |
| HOOK-07 | Phase 3 — Ingress | Pending |
| HOOK-08 | Phase 3 — Ingress | Pending |
| HOOK-09 | Phase 3 — Ingress | Pending |
| INTK-01 | Phase 3 — Ingress | Pending |
| INTK-02 | Phase 6 — Orchestration | Pending |
| INTK-03 | Phase 6 — Orchestration | Pending |
| INTK-04 | Phase 5 — Outbound | Pending |
| INTK-05 | Phase 3 — Ingress | Pending |
| INTK-06 | Phase 6 — Orchestration | Pending |
| INTK-07 | Phase 6 — Orchestration | Pending |
| INTK-08 | Phase 6 — Orchestration | Pending |
| AGNT-01 | Phase 4 — Execution | Pending |
| AGNT-02 | Phase 4 — Execution | Pending |
| AGNT-03 | Phase 4 — Execution | Pending |
| AGNT-04 | Phase 4 — Execution | Pending |
| AGNT-05 | Phase 4 — Execution | Pending |
| AGNT-06 | Phase 4 — Execution | Pending |
| AGNT-07 | Phase 4 — Execution | Pending |
| AGNT-08 | Phase 4 — Execution | Pending |
| AGNT-09 | Phase 4 — Execution | Pending |
| AGNT-10 | Phase 4 — Execution | Pending |
| AGNT-11 | Phase 4 — Execution | Pending |
| QA-01 | Phase 4 — Execution | Pending |
| QA-02 | Phase 6 — Orchestration | Pending |
| QA-03 | Phase 6 — Orchestration | Pending |
| QA-04 | Phase 6 — Orchestration | Pending |
| QA-05 | Phase 6 — Orchestration | Pending |
| QA-06 | Phase 6 — Orchestration | Pending |
| QA-07 | Phase 6 — Orchestration | Pending |
| DELV-01 | Phase 4 — Execution | Pending |
| DELV-02 | Phase 4 — Execution | Pending |
| DELV-03 | Phase 4 — Execution | Pending |
| DELV-04 | Phase 4 — Execution | Pending |
| DELV-05 | Phase 5 — Outbound | Pending |
| DELV-06 | Phase 6 — Orchestration | Pending |
| DELV-07 | Phase 6 — Orchestration | Pending |
| DELV-08 | Phase 4 — Execution | Pending |
| DELV-09 | Phase 4 — Execution | Pending |
| NOTF-01 | Phase 5 — Outbound | Pending |
| NOTF-02 | Phase 5 — Outbound | Pending |
| NOTF-03 | Phase 5 — Outbound | Pending |
| NOTF-04 | Phase 5 — Outbound | Pending |
| NOTF-05 | Phase 5 — Outbound | Pending |
| NOTF-06 | Phase 5 — Outbound | Pending |
| OPS-01 | Phase 6 — Orchestration | Pending |
| OPS-02 | Phase 2 — Foundation | Pending |
| OPS-03 | Phase 5 — Outbound | Pending |
| OPS-04 | Phase 6 — Orchestration | Pending |
| OPS-05 | Phase 7 — Integration & Daemon Lifecycle | Pending |
| CONF-01 | Phase 1 — Domain Contract, State Machine & Schema | Pending |
| CONF-02 | Phase 1 — Domain Contract, State Machine & Schema | Pending |

**Coverage:**
- v1 requirements: 70 total
- Mapped to phases: 70 ✓
- Unmapped: 0

**Per-phase totals:**

| Phase | Requirements |
|-------|--------------|
| Phase 1 — Domain Contract, State Machine & Schema | 2 |
| Phase 2 — Foundation | 2 |
| Phase 3 — Ingress | 13 |
| Phase 4 — Execution | 18 |
| Phase 5 — Outbound | 9 |
| Phase 6 — Orchestration | 15 |
| Phase 7 — Integration & Daemon Lifecycle | 2 |
| Phase 8 — Setup Wizard & Safety Pass | 9 |
| **Total** | **70** |

---
*Requirements defined: 2026-09-06*
*Last updated: 2026-09-06 after roadmap creation — all 70 v1 requirements mapped*
