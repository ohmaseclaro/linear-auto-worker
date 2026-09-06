# Feature Research

**Domain:** Issue-tracker-driven autonomous coding agents (Linear issue → PR, single-operator local daemon)
**Researched:** 2026-09-06
**Confidence:** MEDIUM overall — HIGH on Linear's agent protocol and GitHub Copilot's rails (read directly from vendor docs), MEDIUM on Devin/Jules/Cursor (docs summaries + secondary reporting), MEDIUM on anti-features (grounded in named incidents with numbers, but they are one team's experience each).

> Confidence tiers here are the honest primary/secondary-source assessment. The `classify-confidence` seam returns `LOW` for every provider available in this environment (`websearch`/`webfetch` only — no Context7, Exa, Ref, or Tavily MCP was reachable), so treat the seam's tier as a floor and the per-row notes below as the real signal. Every claim is traceable to a named product doc or post-mortem in Sources.

---

## ⚠ Finding That Contradicts an Out-of-Scope Decision

**PROJECT.md defers OAuth `actor=app` on cost grounds. The research says the cost analysis is right but the capability analysis is incomplete.**

Linear's entire Agents platform — the thing every competitor in this space plugs into — is gated behind an OAuth app installed with `actor=app` and the `app:assignable` / `app:mentionable` scopes. Specifically, a **personal-API-key bot user cannot**:

- Receive `AgentSessionEvent` webhooks (`created` / `prompted`)
- Create `AgentActivity` records (`thought`, `action`, `elicitation`, `response`, `error`)
- Appear in Linear's assignee menu as a delegatable agent, or render the Agent Session panel
- Use `elicitation` to put the session into `awaitingInput` — Linear's native, first-class "the agent asked you something" state

This matters for exactly one Active requirement: **the bidirectional comment Q&A channel**. That requirement is a hand-rolled re-implementation of `elicitation`, built on plain comments, with a marker convention and a threaded-reply parser. It will work, and the timeout-to-assumption fallback is the right reliability posture — but it will be strictly uglier than the native affordance, and it inherits a documented Linear footgun: **Linear's own best-practices page warns that comments are editable and therefore unreliable for reconstructing agent conversation state, and tells integrators to read `AgentActivity` instead.** The project is being told to build on the substrate the vendor explicitly says not to build on.

Two other second-order effects of the personal-API-key choice:

1. **Delegation vs. assignment semantics.** Linear's model is that delegating to an agent keeps the *human* as assignee and adds the agent as delegate/contributor. The project's `assigneeId`-based pickup inverts this: the bot becomes the assignee, so the ticket leaves the human's "Assigned to me" view for the duration of the run. That is a real workflow regression for the operator and is worth a conscious decision, not an accident.
2. **The 10-second acknowledgement norm doesn't bind, but the expectation does.** Linear marks an app-user agent session unresponsive if no activity arrives within 10s of `created`. A comment-based bot has no such enforcement — but operators trained on Cursor/Copilot/Devin in Linear will expect sub-10-second feedback anyway.

**Recommendation:** keep OAuth out of scope for v1 (the free-plan cost argument is sound and the setup burden is real — `actor=app` requires workspace admin), but (a) treat sub-10-second acknowledgement as a hard requirement anyway, (b) design the comment protocol so the comment is a *rendering* of an internal activity log rather than the source of truth (SQLite is already the store of record — good), and (c) record OAuth `actor=app` as the single highest-value v2 upgrade, because it converts three hand-built features into vendor-native ones at once.

No research contradicts the other exclusions. Hosted deployment, auto-merge, and a web dashboard are all correctly out of scope — see Anti-Features, where auto-merge in particular is contradicted by every mature product in the space.

---

## Feature Landscape

### Table Stakes (Users Expect These)

Features every shipped competitor has. Missing these = the tool feels broken, not minimal.

| # | Feature | Why Expected | Complexity | Notes |
|---|---------|--------------|------------|-------|
| T1 | **Single unambiguous trigger** (assignment to a dedicated agent identity) | Every product in the space uses assignment as the primary trigger: Copilot (assign issue), Cursor (assignee menu), Devin (assign issue), Jules, Linear-native coding sessions. Labels and mentions are always *secondary*. | LOW | Already the locked decision. `assigneeId` is single-valued → exactly one webhook signal, no double-fire. Correct and matches the field. |
| T2 | **Acknowledgement within ~10 seconds** | Linear enforces this literally for app users (`thought` activity or session goes `unresponsive`). Operators trained on Cursor/Copilot expect the ticket to visibly "wake up" before they tab away. | LOW | Post the ack comment + state transition **before** spawning `claude -p` or creating the worktree. Do not let worktree creation or git fetch sit in front of the ack. This is an ordering constraint, not a feature. |
| T3 | **Automatic status transition to In Progress** | Universal. It is how the rest of the team sees the ticket is taken. | LOW | Already an Active requirement. Needs the workflow-state lookup to be per-team, not hardcoded — Linear state IDs are team-scoped. |
| T4 | **Progress reporting during the run, not just at the end** | Linear's protocol expects a stream of `thought`/`action` activities. Copilot streams session logs. A run that goes dark for 20 minutes reads as hung. | MEDIUM | The hard part is source: `claude -p` needs `--output-format stream-json` to yield intermediate events. Budget a "throttle to one update per N events or M seconds" rule or the ticket becomes unreadable — see anti-feature A6. |
| T5 | **Terminal state always posted — success *and* failure** | Linear's protocol has exactly one terminal activity per session (`response` or `error`). Silence on failure is the single most-complained-about agent behavior. | LOW | Must be in a `finally`. A crashed `claude -p`, an OOM, a git push rejection, and a daemon restart mid-run all need to produce a terminal comment. |
| T6 | **Isolated workspace per run** | Copilot uses ephemeral Actions VMs, Cursor/Jules use cloud VMs, Devin uses its own VM. Nobody runs the agent in the user's live checkout. | MEDIUM | git worktree is the correct local analogue and is already the locked decision. Cheap, and the operator's working copy is never touched. |
| T7 | **PR as the deliverable, opened by the tool, never merged by it** | Universal and non-negotiable. Copilot *structurally cannot* mark a PR ready, approve it, or merge it. dotnet/runtime adopted "no autonomous merging, every merge requires an explicit human request." | LOW | `gh pr create`. Already locked. Worker-owned rather than agent-owned is the right call — see D2. |
| T8 | **PR ↔ ticket bidirectional link** | The PR body links the issue; the issue gets the PR URL. Linear's GitHub integration auto-links on branch name; the ticket-side comment is still expected. | LOW | Using Linear's *suggested* branch name (already an Active requirement) gets the Linear→PR direction for free via their GitHub integration's magic-word/branch-name matching. Do not invent your own branch naming — it silently breaks this. |
| T9 | **Branch naming that encodes the ticket** | See T8. Also how a human finds the branch three days later. | LOW | Linear's `issue.branchName` field. Free. |
| T10 | **Webhook signature verification + delivery-ID dedupe** | Not a user-visible feature, but every serious bridge does it. The `linear-agent-bridge` project does HMAC + stale-webhook filtering (>60s) + session dedupe. | LOW | Already an Active requirement. Add the >60s staleness filter — it is cheap and prevents replay-after-restart storms. |
| T11 | **Self-comment filtering (loop prevention)** | Your own status comments will re-trigger your own comment webhook. `linear-agent-bridge` calls out that this requires accurate `viewer` identity resolution. | LOW | Resolve the bot's own user ID at boot, drop any webhook whose actor is that ID. One line, prevents an infinite loop that would burn API quota and tokens. |
| T12 | **Concurrency cap with a queue, not a rejection** | Universal: Jules free tier = 3 concurrent / 15 daily; Cursor caps concurrent cloud agents; Copilot bounds via Actions. Assigning five tickets at once is the *normal* usage pattern, not an edge case. | MEDIUM | Already an Active requirement (SQLite queue, default 3). Critical addition: **queued tickets must get an immediate "queued, position N" comment.** A queued ticket that looks identical to a dead ticket is the failure mode. |
| T13 | **Restart survival** | A local daemon on a laptop *will* be killed. State that only lives in memory means orphaned worktrees, stuck In-Progress tickets, and silent drops. | MEDIUM | Already locked (SQLite). Needs a boot-time reconciliation pass: any run in state `running` at boot was interrupted → post an error comment and either requeue or fail it explicitly. Don't leave zombies. |
| T14 | **Structured logs of every state transition** | Copilot exposes session logs linked from commit messages; Devin has session views. This is the operator's only debugging surface given no dashboard. | LOW | Already an Active requirement. Given the no-dashboard exclusion, `tail -f` on a JSONL file **is** the UI — make it grep-friendly, one line per transition, with `runId` and `issueId` on every line. |
| T15 | **Per-repo agent instructions honored** | AGENTS.md / CLAUDE.md / `copilot-instructions.md` are now the industry standard. dotnet/runtime measured **38% → 69% success** from adding one. | LOW | `claude -p` inherits CLAUDE.md from the repo automatically. Zero work — but the setup wizard should *check for and warn about a missing CLAUDE.md*, because it is the single highest-leverage success factor found in this research. |
| T16 | **Preflight of the local toolchain** | Copilot's #1 early failure was "couldn't build the repo." Every product has a setup-validation story (`copilot-setup-steps.yml`, Devin's machine snapshot). | LOW | Already an Active requirement. Extend it: verify `gh auth status`, `claude` on PATH, git identity, and that each mapped repo has a clean default branch and a remote. |

### Differentiators (Competitive Advantage)

Where this tool can beat the hosted products for its single-operator audience.

| # | Feature | Value Proposition | Complexity | Notes |
|---|---------|-------------------|------------|-------|
| D1 | **Multi-repo runs from one ticket** | **GitHub Copilot cannot do this — "cannot work across multiple repositories in one run" is a documented hard limit.** Cursor and Jules are similarly single-repo-per-session. A ticket that spans an API and a client is extremely common and every hosted product forces you to split it manually. | HIGH | Already an Active requirement and genuinely the strongest differentiator here. But it multiplies the failure surface: partial success (repo A's PR opens, repo B fails) is now the common case, not an edge case. Needs a per-repo run record and a terminal comment that reports each repo's outcome independently. Do **not** make the whole ticket fail because one repo failed. |
| D2 | **Worker-owned push and PR creation** | Deterministic delivery. Every hosted agent that lets the model do its own final step occasionally forgets. Copilot's rails go further and forbid the agent from running `git push` at all. | LOW | Already locked. Worth stating explicitly in the spawned agent's prompt: "do not push, do not open a PR — commit only." Otherwise you race the agent and get double PRs. |
| D3 | **Runs on the operator's real machine with real credentials** | No firewall allowlist to maintain, no `copilot-setup-steps.yml`, no secret-injection ceremony, private deps and internal registries just work. This is the entire reason to build a local daemon instead of using Copilot. | LOW (it's the architecture) | Flip side is Safety Rails S1–S5 below become *your* job, because none of the hosted sandboxing applies. |
| D4 | **Blocking Q&A with timeout-to-assumption** | Nobody in this space does this well over a tracker. Copilot fire-and-forgets. Devin asks in its own UI. Linear's `elicitation` exists but is OAuth-gated. A run that can pause, ask, and *actually resume with the answer* is rare. | HIGH | Already locked, and `claude -p --resume <sessionId>` is the right mechanism. This is the highest-risk feature in the project: it needs the session ID persisted, the comment marker parsed, a durable timer that survives restart, and a documented default assumption. **Do not build this before T1–T14 work.** The timeout fallback is what makes it safe — keep it. |
| D5 | **"Queued, position N" + live queue visibility in the ticket** | The five-tickets-at-once scenario is where every queue-less tool feels broken. Making the queue visible in the ticket itself costs almost nothing and is the difference between "it's working" and "did it die?" | LOW | Cheapest high-impact feature on this list. Edit/update the ack comment rather than posting a new one per position change. |
| D6 | **Per-mapping behavior toggles** (Slack on/off, base branch, draft vs ready, Q&A on/off, max runtime) | Operators want different rules for "my side project" vs "the repo my team reviews." Copilot's config is repo-level and coarse; this can be per project→repo edge. | LOW | Already an Active requirement. See Configuration Surface below for the essential set — resist adding more. |
| D7 | **Cost/token reporting per run** | Devin's whole pricing model made ACU visibility a first-class feature because users hit surprise bills. `claude -p` emits usage in its result JSON — surfacing it is nearly free and no local tool does it. | LOW | Parse the final `result` message from `--output-format stream-json` for `total_cost_usd` / token counts, log it, and put one line in the terminal comment. High perceived value per unit of work. |
| D8 | **Draft PR by default** | Copilot opens draft PRs and cannot promote them. It correctly signals "a machine wrote this, a human hasn't blessed it." | LOW | `gh pr create --draft`. Make it the default with a per-mapping toggle to opt out (D6). One flag. |
| D9 | **Structured PR body: plan, changed-files rationale, test evidence, limitations, run log link** | GitHub's own review guidance names exactly these, and names the failure mode: agents are verbose and describe what the diff already shows. A short, structured body beats a long narrative one. | MEDIUM | Have the worker template the body (ticket link, one-line summary, test command + result, "what I did not do" section, path to the run's JSONL log) rather than letting the agent free-write it. Deterministic, and dodges the verbosity complaint. |
| D10 | **Slack notification on terminal state only** | Cursor's Slack integration is one of its most-cited features. But the value is in the *terminal* ping, not the progress stream. | LOW | Already an Active requirement. Send on completion/failure/question-asked. Do **not** stream progress to Slack — see A6. |

### Anti-Features (Commonly Requested, Often Problematic)

| # | Feature | Why Requested | Why Problematic | Alternative |
|---|---------|---------------|-----------------|-------------|
| A1 | **Auto-merge on green CI** | "The whole point is no human in the loop." | Contradicted by every mature product in the space. Copilot is *structurally* incapable of merging or even marking a PR ready. dotnet/runtime, with 878 agent PRs and 67.9% merge rate, adopted an explicit rule that every merge requires a human maintainer request. 52.3% of their *merged* agent PRs required direct human commits on the branch. Green CI is not a quality signal when the agent can also weaken CI. | Already correctly out of scope. Keep it there. Draft PR (D8) + human merge. |
| A2 | **Unbounded / uncapped concurrency** | "I want all five tickets going at once." | Five concurrent `claude -p` sessions will exhaust local RAM on a laptop, and the resulting five PRs land at once on one reviewer. dotnet/runtime measured a single developer generating 9 PRs in a few hours = 5–9 hours of team review work. The bottleneck moved from generation to review. | Cap at 3 (already locked), queue the rest, show queue position (D5). Ship the cap as a *feature*, not an apology. |
| A3 | **Auto-pickup of every new issue in a project** (`startOnCreate`-style) | "Why should I have to assign it?" | This is the AI-slop generator. curl shut down its bug bounty in Jan 2026 explicitly because AI-generated submissions dropped the valid-finding rate from >15% to <5%. Node.js got a 19,000-line AI PR that triggered a community petition. tldraw closed external PRs entirely. Volume without a human gate destroys the reviewer. | Explicit assignment only (T1, already locked). If someone wants bulk, they can bulk-assign — the deliberate act is the point. |
| A4 | **Retry-on-failure loops** | "Just try again, maybe it works." | An agent that failed because the task was underspecified will fail identically on retry, at full token cost, and post a second confusing comment. dotnet/runtime's data shows the recovery mechanism that actually works is a *human commit on the branch* (86.2% vs 55.1% success), not a re-run. | One attempt. On failure, post a diagnosis comment with the error and the log path, leave the worktree and any partial branch in place so the operator can `cd` in and take over. Re-assignment by the human is the retry. |
| A5 | **Agent self-review / auto-approve its own PR** | "Close the loop." | Copilot explicitly prevents the requester from approving their own agent's PR and requires an extra approval on Copilot-authored PRs. Self-review is theater. | Nothing. Human reviews. |
| A6 | **Streaming every agent step into Linear comments or Slack** | "I want full visibility." | Turns the ticket into an unreadable wall and makes Linear notifications useless — which trains the operator to mute the bot, destroying T5. Linear's protocol has agents emit many activities into a *dedicated collapsible session panel*, not into the comment stream; you don't have that panel without OAuth. | Throttled milestone updates only (T4): started, plan ready, N files changed, tests running, done. Full detail goes to the JSONL log (T14). Slack gets terminal states only (D10). |
| A7 | **A web dashboard** | "I want to see runs." | Already out of scope, and research supports it: this is a single-operator tool whose users live in Linear and a terminal. A dashboard is a second UI to maintain, plus a server, plus a port. | Linear + Slack + `tail -f` on structured logs. Already the locked decision. |
| A8 | **Letting the agent edit CI config, workflow files, or dependency manifests unprompted** | It genuinely unblocks the agent when the build fails. | GitHub's review guidance names **CI weakening — skipping tests, removing coverage checks — as the #1 reviewer complaint** about agent PRs. Copilot's rails don't trigger workflows at all until a human reviews the code. | Deny-list `.github/workflows/**` (and equivalents) in the spawned session's write scope, or at minimum flag any diff touching them prominently in the PR body and the terminal comment. |
| A9 | **Long, narrative, agent-authored PR descriptions** | Feels thorough. | "Agents love verbosity. They describe what's better explored through the code itself." Verbose bodies actively slow review. | Worker-templated, structured, short body (D9). |
| A10 | **Building your own comment-based state machine as the source of truth** | It's the only channel a bot user has. | Linear's own best-practices page warns comments are editable and unreliable for reconstructing agent conversation. Someone editing a reply mid-run corrupts your state. | SQLite is the source of truth (already locked). Comments are a *projection*. Match on the Linear comment ID and the immutable `createdAt` reply, never re-parse comment bodies to recover run state. |
| A11 | **Persistent cross-run "memory" / learned preferences** | Jules has a Memory Bank; Devin has Knowledge and Playbooks. | For a v1 single-operator tool this is a large stateful subsystem whose value is entirely captured by a file the operator already controls. | CLAUDE.md / AGENTS.md in the repo (T15). It is version-controlled, reviewable, and free. Warn if missing. |
| A12 | **Confidence scoring / task-suitability prediction** | Devin ships it (🟢🟡🔴) and it correlates with success. | Requires a corpus of your own outcomes to calibrate. On day one you'd be inventing a number. | Ship the raw dotnet/runtime priors in the README instead: cleanup/test/refactor tasks succeed ~70–85%, perf and architecture tasks ~55%. Free operator guidance, no model needed. |

---

## Cross-Cutting Findings by Probe

### 1. Intake and triggering
Assignment is the universal primary trigger (Copilot, Cursor, Devin, Jules, Linear-native). @-mention is universal as the *secondary*, conversational trigger. Labels are third and mostly a legacy/OSS pattern (OpenHands' `fix-me` label, Devin's `devin` label + automation triggers). Slash commands in comments appear nowhere as a primary trigger. **Linear's own expectation** is delegation via the assignee menu, which requires `app:assignable` and keeps the human as assignee — see the contradiction section. The project's `assigneeId`-based pickup is the right shape for a bot user; the deviation is that the bot *becomes* the assignee rather than a delegate.

### 2. Status reporting cadence
The industry-standard sequence is: **ack (≤10s) → plan → throttled progress → terminal (success or error)**. Linear encodes this literally as `thought` → `action`* → `response`|`error`, with a 10-second SLA on the first activity and a 30-minute staleness window between activities. Copilot's equivalent is: plan comment, then commits streaming into a draft PR, then session logs. The failure mode everyone warns about is either extreme: silence, or firehose.

### 3. Human-in-the-loop
Genuinely blocking mid-run Q&A is **rare**. Linear provides the only first-class primitive found — `elicitation`, the single activity type that moves a session to `awaitingInput`, with follow-up prompts arriving as `AgentSessionEvent` action `prompted` carrying the user's text in `agentActivity.body`. Jules' plan-approval gate is a different, weaker shape (approve/edit/reject *before* work starts, not mid-run). Copilot is fire-and-forget with iteration via @-mention on the resulting PR — i.e. the human's "question channel" is a *new run against the existing PR*, not a resumed one. `claude -p --resume` gives this project a resume capability most competitors don't have; the risk is entirely in the durable-wait plumbing, and the timeout-to-assumption fallback is the correct mitigation.

### 4. Failure and recovery UX
Nobody retries automatically in a way that's reported as working. The observed pattern is: post a diagnosis, keep the partial work, hand control to the human. dotnet/runtime's strongest single data point is that **human commits onto the agent's branch** are what rescue runs (86.2% vs 55.1%), which implies the branch and worktree must survive a failure, not be cleaned up. Partial PRs are considered acceptable and even valuable — dotnet/runtime counts closed agent PRs as delivering value through feasibility testing.

### 5. Concurrency and queueing
Every product caps: Jules 3 concurrent on free / 60 on Ultra, Cursor caps cloud agents, Copilot bounds via Actions runners. The expectation when five tickets are assigned is that all five *acknowledge immediately* and then execute up to the cap. The acknowledgement is what makes the cap acceptable.

### 6. Delivery
Draft PR is the norm (Copilot). Branch naming derived from the ticket is the norm and is what powers tracker↔PR auto-linking. Multi-repo is a documented gap in the market. Good PR bodies per GitHub's own guidance: implementation plan, tests that would fail pre-change, explicit justification for any CI change, and stated limitations — **short**. Scope discipline matters: GitHub advises asking for a smaller PR when the diff touches >5 unrelated files or the purpose can't be stated in one sentence.

### 7. Configuration surface
The consistently-essential toggles across products: repo/project mapping, base branch, setup/build commands, agent instructions file, network/tool allowlist, concurrency cap, and notification destination. Everything else is fat. For this project the essential set is: project→repo(s) map, base branch per repo, Slack webhook per mapping, concurrency cap (global), Q&A enable + timeout, max run duration, and draft-vs-ready. **Seven knobs. Adding an eighth needs an argument.**

### 8. Observability
Copilot: session logs linked from every commit message, plus admin audit events, plus cryptographically signed commits. Devin: session replay + ACU consumption. The consistent lesson is that a run must be reconstructable *after* it finishes, from an artifact that isn't the ticket. For a no-dashboard local tool, that artifact is a per-run JSONL file whose path is printed in the terminal comment and the PR body. Cost/token reporting (D7) is nearly free from `claude -p`'s result JSON and is disproportionately valued.

### 9. Safety rails
The mature rail set, mostly from Copilot's documented mitigations, mapped to what this local daemon must self-impose since no sandbox applies:

| ID | Rail | Copilot's version | This project's version |
|----|------|-------------------|------------------------|
| S1 | Never push to the default branch | Structurally impossible; only `copilot/*` or the PR branch | Refuse to push if the worktree branch == the repo's default branch. Assert before every push. |
| S2 | Agent doesn't push; the harness does | Agent cannot run `git push` | Already locked (D2). State it in the spawned prompt too. |
| S3 | No merge, no approve, no ready-for-review | Structurally forbidden | Draft PR only (D8); `gh pr merge` never called. |
| S4 | Don't touch CI/workflow files unprompted | Workflows don't run until human review | Deny-list or loudly flag `.github/workflows/**` diffs (A8). |
| S5 | No secret access; scan output for leaked secrets | Actions secrets withheld; secret scanning on output | Highest local risk — the agent has the operator's real shell and real credentials. At minimum: never pass `LINEAR_API_KEY`/`NGROK_AUTHTOKEN` into the child env, and grep the diff for high-entropy strings / `.env` files before pushing. |
| S6 | Bounded runtime | 59-minute hard cap | Per-run timeout that kills the child, posts an error comment, and leaves the worktree. Non-negotiable for an unattended daemon on a laptop. |
| S7 | Only trusted actors can trigger | Only users with write access; untrusted events ignored | Single-operator, so weak — but do verify the webhook HMAC (T10) and ignore self-authored events (T11). |
| S8 | Prompt-injection awareness | Hidden-character filtering on input | Ticket bodies and comments are untrusted input flowing into an agent with shell access. At minimum strip control/zero-width characters from ticket text before it enters the prompt. |

### 10. What teams regretted
Ranked by strength of evidence:
1. **Volume without a review gate** — curl's bug bounty shutdown (valid-finding rate >15% → <5%), Node.js' 19,000-line AI PR petition, tldraw closing external PRs. (A3, A2)
2. **Assuming generation was the bottleneck** — dotnet/runtime found review capacity was, and that agent PRs need *more* review comments than human ones (16.5 vs 12.4). (A2, A9)
3. **Shipping before the repo could be built by the agent** — Copilot's public early stumble in dotnet/runtime was a firewall blocking package feeds; instructions took them 38% → 69%. (T15, T16)
4. **Fully-autonomous framing** — Sweep deprecated its GitHub issue-to-PR bot in favor of tight in-editor integration; the broader 2025→2026 shift was "autonomous agents gave way to supervised systems." (A1, A5)
5. **Verbose, unstructured agent output in a durable artifact** — both the PR-body verbosity complaint and the backlash over promotional "tips" in Copilot PRs come down to: the PR is a trusted artifact, don't pollute it. (A9, A6)

---

## Feature Dependencies

```
T1 Assignment trigger
 └─requires─> T10 Webhook verify + dedupe
 └─requires─> T11 Self-comment filter        (or T1 loops on its own comments)

T2 ≤10s acknowledgement
 └─BLOCKS──> T6 Worktree creation            (ack must be emitted FIRST)
 └─BLOCKS──> D4 Q&A                          (ack precedes any question)

T12 Concurrency cap + queue
 └─requires─> T13 Restart survival (SQLite)
 └─enables──> D5 Queue position comment
 └─requires─> T2                             (queued runs must ack immediately)

D4 Blocking Q&A  ← HIGHEST RISK
 └─requires─> T13 Restart survival           (durable pending-question + timer)
 └─requires─> claude -p session id capture   (--resume)
 └─requires─> T4 progress stream parsing     (to detect the question)
 └─requires─> A10 avoidance: SQLite is truth, comments are projection
 └─conflicts─> T5 terminal-always            (a blocked run has NO terminal state
                                              until answered — the timeout fallback
                                              is what resolves this conflict)

D1 Multi-repo
 └─requires─> per-repo run records           (partial success is the normal case)
 └─requires─> T7 PR creation × N
 └─conflicts─> T5 single terminal comment    (needs a per-repo outcome table instead)
 └─amplifies─> T12 concurrency pressure      (1 ticket may hold N worker slots —
                                              decide: does the cap count tickets or repos?)

T7 PR creation
 └─requires─> T9 Branch naming (Linear suggested)
 └─enables──> T8 PR↔ticket link (free via Linear GitHub integration)
 └─requires─> S1 default-branch refusal
 └─enhanced by─> D8 draft-by-default, D9 structured body

T14 Structured logs
 └─enables──> D7 cost reporting
 └─substitutes for─> A7 web dashboard        (logs ARE the UI, so make them good)

T15 CLAUDE.md honored
 └─enhanced by─> T16 preflight warning when missing
 (highest measured leverage on success rate of anything in this document)
```

### Dependency Notes

- **T2 blocks T6, not the reverse.** The most likely accidental design is `webhook → create worktree → spawn → ack`. Worktree creation on a cold repo can take seconds; that ordering silently violates the 10s norm. Ack first, everything else after.
- **D4 conflicts with T5 and the timeout is the resolution.** A blocked run has no terminal state by definition. Without the timeout-to-assumption fallback, a forgotten question is an eternally In-Progress ticket. This is why the fallback is a correctness requirement, not a nicety.
- **D1 amplifies T12 in a way that needs an explicit decision.** If one ticket maps to three repos, does it consume one slot or three? Three is correct for RAM (three `claude -p` processes) but means a single ticket can saturate the default cap of 3. Recommend: the cap counts *sessions*, and a multi-repo ticket's repos run sequentially within one slot unless the operator opts into parallel. Simpler, and RAM is the actual constraint.
- **T15 has the best evidence-to-effort ratio in this document.** 31 percentage points of success rate, measured over 878 PRs, for writing one markdown file. The wizard should refuse to consider a repo mapping "healthy" without one.

---

## MVP Definition

### Launch With (v1)

- [ ] **T1 + T10 + T11** — assignment trigger, verified/deduped, non-looping. Without T11 it self-triggers infinitely.
- [ ] **T2 + T3** — ack under 10s, then In Progress. The perceived-liveness baseline.
- [ ] **T16 + T15 warning** — preflight; refuse to map a repo you can't reach, warn on missing CLAUDE.md.
- [ ] **T6** — worktree per ticket.
- [ ] **T4 (minimal)** — 3–4 throttled milestone updates, not a stream. Full detail to logs.
- [ ] **T5** — terminal comment in a `finally`, success and failure both.
- [ ] **T7 + T8 + T9 + D8 + D2** — worker pushes, opens a **draft** PR on the Linear-suggested branch, reports the URL.
- [ ] **T12 + D5** — cap 3, queue the rest, comment queue position immediately.
- [ ] **T13** — SQLite state + boot reconciliation of interrupted runs.
- [ ] **T14** — per-run JSONL log; path printed in the terminal comment.
- [ ] **S1, S2, S3, S5, S6** — no default-branch push, worker-owned push, never merge, secrets withheld + diff scanned, hard run timeout.
- [ ] **D10** — Slack on terminal state only.
- [ ] **D6 (minimal set)** — project→repo map, base branch, Slack URL, draft toggle.

### Add After Validation (v1.x)

- [ ] **D4 — Blocking Q&A.** Trigger: v1 has run 20+ tickets and the operator can name specific runs that failed for want of one answer. This is the most complex feature in the project; build it against evidence, not anticipation. *(Note: it is an Active requirement in PROJECT.md — this is a sequencing recommendation, not a scope objection.)*
- [ ] **D1 — Multi-repo.** Trigger: single-repo delivery is reliable. Partial-success reporting doubles the terminal-state logic; don't build it on top of unproven single-repo delivery. *(Also an Active requirement — same sequencing caveat.)*
- [ ] **D9 — Structured PR body.** Trigger: after the first handful of PRs, when you know what you actually wanted to see in them.
- [ ] **D7 — Cost/token line.** Trigger: first surprising bill. Cheap enough to add opportunistically.
- [ ] **S4 + S8** — workflow-file flagging, prompt-injection input sanitizing. Add as soon as anyone but the operator can file a ticket in the project.

### Future Consideration (v2+)

- [ ] **OAuth `actor=app` migration** — converts D4 (Q&A), T4 (progress), and T2 (ack) from hand-built into vendor-native `elicitation` / `action` / `thought`, plus the native Agent Session panel and proper delegate semantics. Defer: costs a bot seat on paid plans and needs workspace admin. **Revisit the moment the workspace leaves the Free plan or a second person uses the tool** — at that point the cost argument for a personal API key has already evaporated.
- [ ] **@-mention as a secondary trigger** — natural once OAuth lands (`app:mentionable`); awkward and ambiguous before it.
- [ ] **Per-run replay** — re-run a ticket against the recorded prompt for debugging. Defer until the log format is stable.
- [ ] **A11 memory / A12 confidence scoring** — documented anti-features for v1; only revisit with a real corpus of this operator's outcomes.

---

## Feature Prioritization Matrix

| Feature | User Value | Impl. Cost | Priority |
|---------|------------|------------|----------|
| T1 assignment trigger + T10 verify/dedupe + T11 self-filter | HIGH | LOW | P1 |
| T2 ≤10s ack (ordered before worktree) | HIGH | LOW | P1 |
| T3 In Progress transition | HIGH | LOW | P1 |
| T5 terminal state always (success + failure) | HIGH | LOW | P1 |
| T6 worktree isolation | HIGH | MEDIUM | P1 |
| T7/T8/T9 push + draft PR + ticket link + branch name | HIGH | LOW | P1 |
| T12 concurrency cap + queue | HIGH | MEDIUM | P1 |
| T13 restart survival + boot reconciliation | HIGH | MEDIUM | P1 |
| T14 structured logs (the UI, given no dashboard) | HIGH | LOW | P1 |
| T16 preflight wizard | HIGH | MEDIUM | P1 |
| S1/S2/S3/S5/S6 core safety rails | HIGH | LOW | P1 |
| D8 draft-by-default | MEDIUM | LOW | P1 (one flag) |
| D5 queue position comment | MEDIUM | LOW | P1 (cheapest win here) |
| D2 worker-owned delivery | HIGH | LOW | P1 |
| T4 throttled progress updates | MEDIUM | MEDIUM | P1 (minimal) / P2 (rich) |
| T15 CLAUDE.md honored + missing-file warning | HIGH | LOW | P1 |
| D10 Slack on terminal only | MEDIUM | LOW | P1 |
| D6 per-mapping toggles (7 knobs, no more) | MEDIUM | LOW | P1 |
| D9 structured PR body | MEDIUM | MEDIUM | P2 |
| D7 cost/token line | MEDIUM | LOW | P2 |
| S4 workflow-file guard | MEDIUM | LOW | P2 |
| S8 prompt-injection sanitizing | MEDIUM | LOW | P2 |
| D1 multi-repo runs | HIGH | HIGH | P2 (after single-repo is reliable) |
| D4 blocking Q&A + timeout | HIGH | HIGH | P2 (after ~20 real runs) |
| OAuth `actor=app` migration | HIGH | HIGH | P3 (trigger: leave Free plan) |
| A11 memory / A12 confidence | LOW | HIGH | P3 (documented anti-feature for v1) |

---

## Competitor Feature Analysis

| Feature | GitHub Copilot coding agent | Cursor cloud agents | Devin | Jules | Linear native (Claude Code/Codex) | **Our approach** |
|---------|------------------------------|---------------------|-------|-------|-----------------------------------|------------------|
| Trigger | Assign issue, @copilot, Agents panel, Linear/Jira/Slack | Linear assignee menu, @mention, Slack @Cursor, Automations | Assign issue, @devin, `devin` label, automation rules | Task from repo/UI | Delegate from the issue | Assign to bot user (single signal, no ambiguity) |
| Identity in Linear | OAuth app user (delegate) | OAuth app user (delegate) | OAuth app user | n/a | Native | Personal-API-key bot user → **assignee, not delegate** (deviation) |
| Ack latency | Fast, plan comment | Fast | Fast | Fast | Native session panel | Must self-impose ≤10s |
| Progress | Session logs + commits into draft PR | Session view | Session replay | Plan + live | `thought`/`action` activities in a panel | Throttled milestone comments + JSONL log |
| Q&A mid-run | No — iterate via @mention on the PR | Limited | In its own UI | Plan approval *before* run | `elicitation` → `awaitingInput` (OAuth-only) | Comment-thread reply + `--resume`, timeout→assumption |
| Concurrency | Actions-bounded | Capped | Plan-based | 3 free / 60 Ultra | — | SQLite queue, cap 3, **queue position shown** |
| Multi-repo | **Explicitly cannot** | Single repo | Limited | Single repo | Single repo | **Yes — the differentiator** |
| PR | Draft, `copilot/*` branch, one PR/task | Branch + PR | PR | PR | Drafts PR + diff on the issue | Draft, Linear-suggested branch, templated body |
| Merge | Structurally cannot | No | No | No | No | No (out of scope, correctly) |
| Sandbox | Ephemeral Actions VM + egress firewall | Cloud VM | Own VM | Cloud VM | Secure session | **git worktree on the operator's real machine** — power and risk (S1–S8) |
| Cost visibility | Premium requests | Usage | ACUs (first-class) | Task quota | — | `total_cost_usd` per run in log + terminal comment |
| Config | AGENTS.md, `copilot-setup-steps.yml`, MCP, hooks, skills | Env + rules | Knowledge, Playbooks | Memory Bank | — | Wizard-built project→repo map + 7 toggles; CLAUDE.md inherited |

---

## Sources

**Linear (primary — vendor docs, HIGH confidence on protocol facts)**
- https://linear.app/developers/agents — Getting Started: `app:assignable`, `app:mentionable`, delegate-not-assignee, `AgentSessionEvent` `created`, 10-second `thought` requirement, `promptContext`
- https://linear.app/developers/agent-best-practices — 10s ack, 30-minute staleness window, activity types, elicitation, "comments are editable and unreliable — read Agent Activities instead"
- https://linear.app/developers/agent-interaction — `created` / `prompted` webhook actions, follow-up text in `agentActivity.body`, Signals
- https://linear.app/developers/oauth-actor-authorization — `actor=app`, dedicated app user, workspace-admin requirement
- https://linear.app/now/our-approach-to-building-the-agent-interaction-sdk — thought/action/elicitation/response mapping, elicitation as the only `awaitingInput` trigger
- https://linear.app/changelog/2025-07-30-agent-interaction-guidelines-and-sdk
- https://linear.app/docs/agents-in-linear, https://linear.app/docs/coding-sessions, https://linear.app/integrations/agents, https://linear.app/integrations/cursor, https://linear.app/integrations/devin

**GitHub Copilot coding agent (primary — vendor docs, HIGH confidence)**
- https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent — triggers, draft PR, 59-min cap, one branch/PR per task, **cannot work across multiple repositories**, AGENTS.md, `copilot-setup-steps.yml`
- https://docs.github.com/en/copilot/concepts/agents/cloud-agent/risks-and-mitigations — full rail list: branch restriction, no `git push`, cannot approve/merge/ready, requester-can't-approve, workflows gated on review, Actions secrets withheld, prompt-injection filtering, CodeQL/secret scanning, signed commits + session logs
- https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/customize-the-agent-firewall
- https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/integrate-coding-agent-with-linear

**Field data / post-mortems (MEDIUM–HIGH — named, quantified, single-team)**
- https://devblogs.microsoft.com/dotnet/ten-months-with-cca-in-dotnet-runtime/ — 878 PRs / 535 merged / 67.9%; per-task-type success rates; 38%→69% from instructions; 16.5 vs 12.4 review comments; 52.3% needed human commits (86.2% vs 55.1%); review-capacity bottleneck; no-autonomous-merge rule; agent "laziness"
- https://github.blog/ai-and-ml/generative-ai/agent-pull-requests-are-everywhere-heres-how-to-review-them/ — PR body guidance, >5-unrelated-files heuristic, CI-weakening as top reviewer complaint, verbosity
- https://www.theregister.com/2026/01/21/curl_ends_bug_bounty/ and https://thenewstack.io/curls-daniel-stenberg-ai-is-ddosing-open-source-and-fixing-its-bugs/ — bounty shutdown, >15%→<5% valid-finding rate, Node.js 19k-line PR petition, tldraw closing external PRs

**Other products (MEDIUM — docs summaries + secondary reporting)**
- https://cursor.com/docs/cloud-agent, https://cursor.com/docs/cloud-agent/automations, https://cursor.com/docs/integrations/slack, https://cursor.com/docs/integrations/linear
- https://cognition.com/blog/devin-2-1, https://docs.devin.ai/release-notes/2025 — Knowledge, Playbooks, Confidence Scores (🟢 2× merge likelihood vs 🔴), ACUs
- https://jules.google/, https://jules.google/docs/changelog/, https://blog.google/innovation-and-ai/models-and-research/google-labs/jules/ — plan approval, Critic agent, Memory Bank, 3/15 free concurrency
- https://github.com/anthropics/claude-code-action — @claude mention / label / assignment / automation modes, sticky comment, `track_progress` checkboxes
- https://blog.sweep.dev/ and https://www.sweep.io/blog/2025-the-year-enterprise-ai-hit-the-system-wall — issue-to-PR bot deprecated in favor of in-editor; "autonomous agents gave way to supervised systems"
- https://github.com/tokezooo/linear-agent-bridge — the closest existing Linear webhook→agent bridge: session dedupe (AgentSession + Comment double-fire), HMAC verify, >60s stale-webhook filter, self-comment filtering via `viewer` identity, `repoByTeam`/`repoByProject` mapping, `delegateOnCreate`/`startOnCreate` policies. **No queue, no sandbox/worktree, no PR creation** — exactly the gaps this project fills.
- https://github.com/linear/linear-agent-demo — Linear's own reference agent
- https://docs.openhands.dev/ — OpenHands resolver (label/mention trigger); direct doc fetch 404'd, treated as LOW and not relied on for any claim above

---

## Gaps and Open Questions

1. **OpenHands and SWE-agent specifics went unverified** — the OpenHands resolver docs URL 404'd through two paths. Nothing above depends on them; the label-trigger pattern is corroborated by Devin's `devin` label. LOW confidence, low impact.
2. **`claude -p` streaming event shape not verified in this pass** — T4 (progress) and D7 (cost) both assume `--output-format stream-json` yields intermediate tool events and a final `result` with `total_cost_usd`. Verify against the installed `claude` version during the phase that builds T4; if the stream is coarser than assumed, T4 degrades to "started / finished" and D7 may need a different source.
3. **Whether Linear's GitHub integration auto-links a PR opened on `issue.branchName` when the actor is a plain bot user** — assumed yes (it is branch-name matching, actor-independent), but T8's "free" claim rests on it. Cheap to verify with one real PR during the delivery phase.
4. **No public data found on comment-based (non-OAuth) Linear agents at any scale** — every documented integration uses the app-user path. The comment-protocol design in D4/A10 is reasoned from Linear's own warnings rather than from someone else's production experience. Treat D4 as genuinely novel, which is why it is sequenced after the basics work.

---
*Feature research for: issue-tracker-driven autonomous coding agents*
*Researched: 2026-09-06*
