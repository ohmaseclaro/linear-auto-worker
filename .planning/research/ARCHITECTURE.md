# Architecture Research

**Domain:** Webhook-driven local job runner / coding-agent orchestrator (single-operator daemon)
**Researched:** 2026-09-06
**Confidence:** MEDIUM-HIGH on the external contracts (Linear webhooks, `claude -p` flags, ngrok SDK — all read from first-party vendor docs); MEDIUM on the internal decomposition (judgement, not citation)

> **On the confidence tags below:** the GSD `classify-confidence` seam tags `webfetch`/`websearch` as `LOW` regardless of what was fetched. Every external claim in this document was read directly from the vendor's own documentation (`linear.app/developers`, `code.claude.com/docs`, `ngrok.github.io`) and cross-checked against independent write-ups. Where the seam tier and the source authority disagree, both are stated. Two claims are flagged `VERIFY` — they change a design decision and should be smoke-tested in Phase 1.

---

## Standard Architecture

### System Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│  L5  ENTRY                                                            │
│   ┌──────────────┐              ┌──────────────────────────────────┐ │
│   │ Setup Wizard │              │  Daemon (composition root)       │ │
│   └──────┬───────┘              └──────────────┬───────────────────┘ │
├──────────┴─────────────────────────────────────┴─────────────────────┤
│  L1  INGRESS                          │  L2  ORCHESTRATION            │
│  ┌──────────┐ ┌────────────┐          │  ┌───────────┐ ┌──────────┐  │
│  │ Tunnel   │→│ Registrar  │          │  │ Scheduler │→│RunEngine │  │
│  │ Manager  │ │ (webhook)  │          │  │ (slots)   │ │ (FSM)    │  │
│  └────┬─────┘ └────────────┘          │  └─────┬─────┘ └────┬─────┘  │
│  ┌────┴─────┐ ┌────────────┐          │        │            │        │
│  │ Receiver │→│ EventRouter│──enqueue─┼────────┘            │        │
│  │ (+HMAC)  │ │(normalize) │          │                     │        │
│  └──────────┘ └────────────┘          │                     │        │
├───────────────────────────────────────┴─────────────────────┼────────┤
│  L3  EXECUTION                                              ▼        │
│   ┌───────────────┐  ┌───────────────┐  ┌───────────────────────┐   │
│   │WorktreeManager│  │ AgentRunner   │  │ Deliverer (git + gh)  │   │
│   │ (git worktree)│  │ (claude -p)   │  │ push → PR → url       │   │
│   └───────────────┘  └───────────────┘  └───────────────────────┘   │
├──────────────────────────────────────────────────────────────────────┤
│  L4  OUTBOUND                                                         │
│   ┌────────────────────┐        ┌────────────────────────────────┐   │
│   │ LinearClient       │◄───────│ Notifier (fan-out)             │   │
│   │ (facade: issues,   │        │  ├ LinearCommentChannel        │   │
│   │  comments, states, │        │  ├ SlackChannel (webhook URL)  │   │
│   │  webhooks)         │        │  └ LogChannel (always on)      │   │
│   └────────────────────┘        └────────────────────────────────┘   │
├──────────────────────────────────────────────────────────────────────┤
│  L0  FOUNDATION  (zero internal deps — everything imports these)      │
│   ┌──────────┐ ┌──────────────────────────┐ ┌──────────────────┐    │
│   │ Config   │ │ Store (better-sqlite3)   │ │ Logger (pino)    │    │
│   │ (zod)    │ │ runs · questions ·       │ │ structured, run- │    │
│   │          │ │ deliveries · kv          │ │ scoped child     │    │
│   └──────────┘ └──────────────────────────┘ └──────────────────┘    │
└──────────────────────────────────────────────────────────────────────┘

Control flows DOWN (L5→L1→L2→L3). Data flows OUT via L4. Nothing in L0–L3
imports anything above it. RunEngine is the only component that writes run state.
```

### Component Responsibilities

Twelve components. The suggested list was close; three changes are recommended and justified below the table.

| # | Component | Owns | Never does | Layer |
|---|-----------|------|------------|-------|
| 1 | **Config** | Loading + zod-validating `~/.linear-auto-worker/config.json`, resolving the project→repos map, env secret lookup | Network, disk writes (wizard writes) | L0 |
| 2 | **Store** | The SQLite file, migrations, all SQL. Tables: `runs`, `questions`, `deliveries`, `kv` | Business rules; it is a dumb typed repository | L0 |
| 3 | **Logger** | Structured JSON log lines, run-scoped child loggers | Deciding what is worth logging | L0 |
| 4 | **TunnelManager** | One `@ngrok/ngrok` listener bound to the local server's port; `url()`; close on shutdown | Know anything about Linear | L1 |
| 5 | **WebhookRegistrar** | Idempotent reconcile of the Linear webhook to the current tunnel URL; persisting the signing secret | Serve HTTP | L1 |
| 6 | **Receiver** | Raw-body HTTP server, HMAC verify, timestamp skew check, delivery-ID dedupe, ACK **within 5s** | Business logic; it hands off and returns 200 | L1 |
| 7 | **EventRouter** | Normalising a verified delivery into a `DomainEvent`; re-fetching canonical issue state; deciding enqueue / cancel / answer / ignore | Spawn anything, touch git | L1 |
| 8 | **Scheduler** | The concurrency semaphore (default 3) and the "what runs next" pick; draining the queue | Know what a run *is* beyond its state | L2 |
| 9 | **RunEngine** | **The state machine.** The only writer of `runs.state`. Drives claimed→worktree→agent→deliver. Owns the pending-question lifecycle and its deadline | Do git or process work itself (delegates) | L2 |
| 10 | **WorktreeManager** | `git worktree add/remove`, branch naming, fetch/base-ref resolution, stale-worktree GC | Commit or push | L3 |
| 11 | **AgentRunner** | Spawning + supervising `claude -p`; session-ID assignment; parsing structured output; resume; SIGTERM | Interpret the *meaning* of a result (RunEngine does) | L3 |
| 12 | **Deliverer** | `git push`, `gh pr create`, returning the PR URL | Post notifications | L3 |
| 13 | **LinearClient** | Thin typed facade over `@linear/sdk`: issue fetch, state transition, comment create/read, webhook CRUD, `viewer` preflight | Retry policy decisions above its own transport retries | L4 |
| 14 | **Notifier** | Fan-out of one `RunEvent` to Linear comment + Slack + log, per config toggles; **never throws upward** | Own transport (uses LinearClient / fetch) | L4 |
| 15 | **SetupWizard** | Preflight, prompting, writing config, verifying by registering the webhook | Run the daemon | L5 |

**Refinements to the suggested component list:**

- **Split `RunEngine` out of the scheduler.** The original list had "run queue + scheduler" as one thing. Keep the *semaphore* (Scheduler) separate from the *state machine* (RunEngine). Scheduler answers "may another run start?"; RunEngine answers "what happens to run X next?". A run in `awaiting_answer` is owned by RunEngine but holds **no** Scheduler slot — that separation is the whole reason the blocking-Q&A design is affordable, and it only reads cleanly if the two are distinct.
- **Split `Deliverer` out of `AgentRunner`.** PROJECT.md locks "worker owns push and PR creation". Making delivery its own component means it is testable against a scratch repo with no Claude process anywhere, which matters a lot for parallel construction.
- **Merge "logs" into `Notifier` as a channel, not a peer.** Requirement: "structured logging of every state transition regardless of Slack or Linear comment settings." Model the log as a non-disableable channel inside Notifier rather than a separate call site, so it is structurally impossible to add a notification path that forgets to log.

---

## Boot Sequence

### The ordered startup

**The HTTP server must bind before the tunnel opens.** `ngrok.forward({ addr })` / `ngrok.listen(server)` points a public URL at a local port; if the tunnel is live and nothing is listening, ngrok answers `ngrok gateway error` (502) — which Linear counts as a failed delivery and burns one of its **three** retries. Binding first makes that window zero-width.

```
 1. loadConfig()                 pure, no I/O beyond one read.  FAIL FAST
 2. openStore() + migrate()      WAL, synchronous=NORMAL, busy_timeout.  FAIL FAST
 3. recoverInFlightRuns()        pure-DB sweep. See below.  MUST precede ingress
 4. preflight()                  gh auth status · claude --version · git --version
                                 · linear.viewer (validates API key + bot identity)
 5. server.listen(127.0.0.1, 0)  ephemeral port, loopback only
 6. tunnel.open(port)            → public URL
 7. registrar.reconcile(url)     create-or-update, idempotent. See below
 8. missedWorkSweep()            query Linear for open issues assigned to the bot
                                 that have no non-terminal run.  Enqueue them
 9. scheduler.start()            only now may a claude process be spawned
10. installSignalHandlers()      SIGINT/SIGTERM → shutdown in reverse
```

**Why recovery (3) precedes ingress (5–7):** if a webhook lands while the DB still shows a phantom `agent_running` row from a crashed process, the router will treat the ticket as already running and drop the event. Sweeping first makes the queue coherent before the first byte arrives.

**Why the missed-work sweep (8) exists — this is the non-obvious one.** The tunnel URL changes on every restart (free ngrok, random domain). Between the daemon dying and step 7 completing, Linear is delivering to a dead URL. Those deliveries retry at 1 min / 1 h / 6 h against a URL that will never come back, and are then lost — at-least-once only helps if the endpoint is the same endpoint. The only correct recovery is to **poll Linear once at boot** for the ground truth: issues assigned to the bot, not in a terminal workflow state, with no non-terminal local run. Without this the daemon silently drops every ticket assigned while it was down. Treat it as a first-class boot step, not a nicety.

### Idempotent webhook reconciliation

The trap: **`webhookCreate` returns the signing `secret` exactly once, at creation.** Naive delete-and-recreate every boot works but rotates the secret each time and leaves a trail of webhook rows if a crash lands between delete and create. Naive create-only duplicates the webhook on every restart, so every event is delivered N times.

Reconcile by a stable `label`:

```
existing = linear.webhooks().find(w => w.label === "linear-auto-worker")
storedSecret = store.kv.get("webhook_secret")

if (!existing)                    → webhookCreate({label, url, resourceTypes, teamId})
                                    persist {webhookId, secret} atomically
else if (!storedSecret)           → webhookDelete(existing.id) then webhookCreate(...)
                                    (fresh DB / lost secret: we cannot recover it)
else if (existing.url !== url
      || !existing.enabled
      || resourceTypes differ)    → webhookUpdate({id, url, enabled:true, resourceTypes})
                                    secret preserved, no rotation
else                              → no-op
```

`resourceTypes` is `["Issue", "Comment"]`. Persist `{webhookId, secret}` in **one** transaction so a crash can never leave a webhook whose secret you do not have.

### Failure modes by step

| Step | Failure | Correct response |
|------|---------|------------------|
| 1 Config | missing/invalid | exit 1, print the zod path and `run the wizard` |
| 2 Store | locked / corrupt / migration fail | exit 1. Never auto-delete the DB |
| 3 Recovery | rows reference gone worktrees | mark `failed(reason: worktree_missing)`, do not crash |
| 4 Preflight | `gh` unauthenticated | exit 1 with `gh auth login` — do **not** prompt for a token (out of scope per PROJECT.md) |
| 4 Preflight | Linear 401 | exit 1, key is invalid |
| 5 Listen | port in use | ephemeral port (`0`) makes this unreachable — that is why to use it |
| 6 Tunnel | no `NGROK_AUTHTOKEN` / account unverified | exit 1 with the verification URL. ngrok requires a verified account even on free |
| 6 Tunnel | transient network | bounded retry (3× exponential), then exit 1 |
| 7 Registrar | 403 not-admin | exit 1: the API key's user must be a workspace admin |
| 7 Registrar | partial (created, secret unpersisted) | prevented by the single transaction above |
| 8 Sweep | Linear slow/down | log a warning and continue — the daemon is still useful, just missing backlog |
| 9 Scheduler | — | after this point nothing is fatal; degrade and log |

### Shutdown (reverse, and it matters)

```
scheduler.pause()            stop claiming new work
registrar.disable()          webhookUpdate({enabled:false}) — optional but polite:
                             stops Linear burning retries against a dying URL
tunnel.close()               public URL goes away
server.close()
runEngine.drain(graceMs)     SIGTERM each claude child. Exit code 143 leaves the
                             turn unfinished BUT the session is resumable, so
                             persist state=queued + resumable=true, not failed
store.close()
```

`claude -p` under SIGTERM exits 143, runs `SessionEnd` hooks, kills its bash subtree, and — critically — **the session remains resumable and continues the unfinished turn on `--resume`**. That is what makes a clean restart lossless.

---

## Webhook Idempotency and Delivery Semantics

### The facts (linear.app/developers/webhooks — first-party; seam tier `LOW` for `webfetch`, source authority high)

| Property | Value |
|----------|-------|
| Signature | `Linear-Signature`: hex HMAC-SHA256 over the **raw** body, **no** `sha256=` prefix |
| Delivery ID | `Linear-Delivery`: UUID, per delivery attempt |
| Event type | `Linear-Event`: entity type |
| Timestamp | `Linear-Timestamp`: unix ms; docs recommend rejecting >~1 min skew |
| Guarantee | **at-least-once**, explicitly not exactly-once |
| Failure def. | unreachable, non-200, **or slower than 5 seconds** |
| Retries | max 3, at 1 min / 1 h / 6 h; webhook may be auto-disabled after sustained failure |
| Ordering | not guaranteed |

Two hard design consequences:

1. **The 5-second budget is a real architectural constraint.** The receiver must verify, dedupe, persist, respond 200, and only *then* do anything. Never hold the response open across a Linear API call, a `git` invocation, or a process spawn.
2. **Re-stringifying the parsed JSON breaks the signature.** The body must be captured as a `Buffer` before any JSON middleware touches it.

### The receiver pipeline

```ts
// order is load-bearing
1. raw = await readRawBody(req)              // Buffer, cap at ~1MB
2. timingSafeEqual(hmac(raw, secret), header) // else 401
3. |now - Linear-Timestamp| < 60_000          // else 401 (replay)
4. INSERT OR IGNORE INTO deliveries(id)       // changes()===0 → duplicate
5. res.writeHead(200).end()                   // ACK — always before work
6. if (!duplicate) queueMicrotask(() => router.handle(evt))
```

Dedupe on `Linear-Delivery` with `INSERT OR IGNORE ... ; if (changes() === 0) drop`. That is one atomic statement, no read-then-write race. Prune `deliveries` rows older than 7 days (retries end at 6 h, so 7 days is generous).

Note that dedupe alone is **not** idempotency: retry #2 arrives an hour later with a *different* `Linear-Delivery` only if Linear regenerates it — assume it may. The router must also be idempotent by construction, which the next rule provides for free.

### The rule that makes ordering irrelevant

**Never make a decision from `payload.data`. Use the webhook only as a signal that issue X changed, then re-fetch the issue from the Linear API and decide from that.**

This one rule dissolves three separate problems at once:

- **Out-of-order events** — the re-fetch always returns the newest state, so a stale event and a fresh event reach the same conclusion. The action becomes a function of current state, not of event history.
- **Missing fields** — webhook `data` is a serialised entity, not necessarily the full GraphQL object. `Issue.branchName` (the suggested branch name PROJECT.md depends on) is a computed field; do not assume it rides along. `VERIFY` in Phase 1: confirm whether `branchName` appears in the Issue webhook payload. Either way the re-fetch makes it moot.
- **Duplicate delivery** — a re-delivered "assigned to bot" event re-derives "should be running", sees a non-terminal run already exists, and no-ops.

Cost: one Linear API call per accepted event. At single-operator volume that is nothing. Add a cheap pre-filter — a per-issue `last_webhook_ts` watermark — to drop obviously stale events before spending the call.

### Decision table: an event arrives for issue X

| Current run state for X | Event (after re-fetch) | Action |
|---|---|---|
| none | assignee == bot, state not terminal | **enqueue** new run; transition issue → In Progress |
| none | assignee != bot | ignore |
| `queued` / `claimed` | assignee != bot | `abandoned`; remove worktree if any |
| `queued` | re-assigned to bot | no-op (idempotent) |
| `agent_running` | assignee != bot | **request cancel** → SIGTERM child → `abandoned` |
| `agent_running` | issue moved to Done/Canceled by a human | request cancel → `abandoned` |
| `agent_running` | title/description edited | **do not restart.** Log it, post one comment: *"Noted a description change mid-run; unassign and reassign to restart against the new text."* |
| `agent_running` | still assigned to bot, other change | ignore |
| `awaiting_answer` | Comment create, author != bot, correlates to open question | **resolve the question**, resume the agent |
| `awaiting_answer` | Comment create authored by bot | ignore (loop guard — always check `data.user.id !== botUserId` first) |
| any | anything, run is terminal | ignore |

"Do not restart on description edit" is the deliberately lazy correct choice: a mid-flight restart means killing a session, discarding a worktree with real commits, and re-running from scratch — expensive, surprising, and racy. Unassign/reassign is an explicit, cheap, already-supported restart gesture.

---

## Run State Machine

This is the contract every layer codes against. Build it first, in `src/domain/`, with zero dependencies, so all layers can import it on day one.

### States

| State | Holds a slot? | Has a live child? | Meaning |
|---|---|---|---|
| `queued` | no | no | accepted, waiting for a concurrency slot |
| `claimed` | **yes** | no | slot taken; preparing (worktree being created) |
| `worktree_ready` | **yes** | no | worktree + branch exist; about to spawn |
| `agent_running` | **yes** | **yes** | `claude -p` child is live |
| `awaiting_answer` | **no** ← | no ← | question posted to Linear; **child has exited**, session resumable |
| `delivering` | **yes** | no | pushing branch, opening PR |
| `done` | — | — | terminal: PR URL recorded |
| `failed` | — | — | terminal: `failure_reason` recorded, retryable |
| `abandoned` | — | — | terminal: cancelled (unassigned, issue closed, operator stop) |

**The two arrows are the whole design.** Because `awaiting_answer` releases the slot and kills the process, a ticket can wait hours on a human without occupying RAM or blocking the other two slots. This is only possible because the chosen Q&A mechanism (below) is resume-based rather than block-based.

### Legal transitions

```
                    ┌──────────────────────────────────────┐
                    ▼                                      │ (bounded retry)
   [new] ──────► queued ──claim(slot)──► claimed ──ok──► worktree_ready
                  │  │                     │  │                │
       cancel ────┤  │                     │  └──err──► failed ┤
                  │  └◄──requeue(recovery)─┘                   │ err
                  ▼                                            ▼
              abandoned ◄──cancel───────────────────── agent_running ◄──┐
                  ▲                                       │  │  │       │
                  │                                       │  │  └─err──►failed
                  │                        needs_input ───┘  └─complete─┐
                  │                                │                    │
                  └──────cancel──────────── awaiting_answer             ▼
                                                   │              delivering
                                     answer / timeout-assumption   │      │
                                                   └───────────────┘   ok │
                                                   (resume)              ▼
                                                                       done
```

| From | To | Trigger | Side effect |
|---|---|---|---|
| — | `queued` | router accepts assignment | insert run; issue → In Progress; notify `run.queued` |
| `queued` | `claimed` | Scheduler has a free slot | acquire semaphore |
| `queued` | `abandoned` | cancel | release nothing |
| `claimed` | `worktree_ready` | worktree created, branch checked out | — |
| `claimed` | `failed` | git error | release slot; remove partial worktree |
| `claimed` | `queued` | restart recovery | release slot |
| `worktree_ready` | `agent_running` | child spawned with pre-assigned `sessionId` | record `pid`, `session_id`, `started_at` |
| `worktree_ready` | `failed` | spawn error (`claude` not on PATH) | release slot |
| `agent_running` | `awaiting_answer` | result `status: "needs_input"` | **release slot**; insert `questions` row; post Linear comment; set `deadline_at` |
| `agent_running` | `delivering` | result `status: "complete"` | keep slot |
| `agent_running` | `failed` | non-zero exit, `error_max_turns`, budget cap, or `status:"failed"` | release slot; keep worktree for post-mortem |
| `agent_running` | `abandoned` | cancel | SIGTERM; release slot; remove worktree |
| `agent_running` | `queued` | worker restart (child died with worker) | release slot; set `resumable = true` |
| `awaiting_answer` | `agent_running` | answer correlated **or** deadline elapsed | acquire slot; `--resume` with answer *or* stated assumption |
| `awaiting_answer` | `abandoned` | cancel | close question |
| `awaiting_answer` | `failed` | `question_round > maxRounds` (default 5) or past hard expiry | — |
| `delivering` | `done` | PR created | release slot; notify PR URL to all channels; issue → In Review |
| `delivering` | `failed` | push/PR error | release slot; **keep the branch pushed** if push succeeded |
| `failed` | `queued` | bounded auto-retry (transient class only) or operator retry | `attempt++`, cap 2 |

### Invariants worth asserting in code

1. `state ∈ {claimed, worktree_ready, agent_running, delivering}` ⟺ this run holds exactly one semaphore slot.
2. `state === 'agent_running'` ⟺ a child pid is recorded and `runEngine` has a live handle. On boot no handle can exist, so **every** `agent_running` row is a crash artefact → `queued, resumable=true`.
3. `awaiting_answer` implies exactly one `questions` row with `status='open'` for this run.
4. Terminal states never transition, except `failed → queued` under an explicit retry.
5. Only `RunEngine.transition()` writes `runs.state`. Enforce with a lint rule or by not exporting the update statement.

---

## The Blocking Q&A Mechanism

This is the hard part and the research produced a decisive answer.

### Design (c) — MCP `ask_human` tool that long-polls: **rejected, and not on taste grounds**

From the Claude Code MCP documentation:

> An MCP tool call in the main conversation that is still running after two minutes **moves to a background task instead of blocking the session**. Claude receives the task ID immediately and keeps working, and the result arrives as a task notification when the call settles. (Claude Code v2.1.212+)

That is a direct, first-party contradiction of the design's core premise. A human answering a Linear comment takes minutes to hours; at the two-minute mark the agent is handed a task ID and **carries on coding without the answer** — the single worst possible failure mode, because the run does not hang (visible) but silently proceeds on an un-made decision (invisible) and produces a confidently wrong PR. On top of that the call is still bounded by a wall-clock `MCP_TOOL_TIMEOUT` and an idle `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`, and this whole area has a long tail of open bugs. It also costs a resident `claude` process (one of three RAM slots) for the entire human latency. Reject.

### Design (b) — keep the process alive, feed stdin via `--input-format stream-json`: **rejected, second best**

Mechanically sound: `claude -p --input-format stream-json --output-format stream-json` is a long-lived process that accepts further NDJSON user messages, and this is the vendor's *recommended* mode for interactive hosts. But:

- The agent must still **end its turn** to ask, so the "keep alive" gains nothing semantically over resume — it is the same conversational shape with a process left running.
- It holds full `claude` RSS for the whole human wait. With `concurrency = 3` on one laptop, two pending questions leave one working slot. This directly violates the stated RAM constraint.
- It does not survive a worker restart. The child dies with the parent and the pending question is stranded.
- More moving parts: NDJSON framing, backpressure, `--replay-user-messages` acknowledgement, stdin lifetime.

Keep it in the back pocket if a future need for true mid-turn interruption appears.

### Design (a) — exit and `--resume <sessionId>`: **recommended**

The agent ends its turn with a structured "I need input" result; the process exits; the worker persists the question and posts it to Linear; the slot is freed. When the answer (or the timeout) arrives, the worker re-spawns `claude -p --resume <sessionId>` with the answer as the new prompt.

Why it wins:

| | (a) resume | (b) stdin | (c) MCP long-poll |
|---|---|---|---|
| Blocks reliably for hours | **yes** | yes | **no — backgrounds at 2 min** |
| RAM while waiting | **zero** | full session | full session |
| Survives worker restart | **yes** (transcript on disk) | no | no |
| Survives machine reboot | **yes** | no | no |
| Moving parts | process spawn only | + NDJSON stdin plumbing | + MCP server, tool schema, timeouts |
| Timeout fallback | trivial (resume with the assumption) | trivial | fights the background-task machinery |
| Vendor-supported | documented `-p` + `--resume` example | documented | documented as *not* blocking |

Two documented details make it clean:

- **`--session-id <uuid>` lets the caller pre-assign the session ID.** The worker generates the UUID, writes it to the `runs` row *before* spawning, and passes it in. No parsing the ID out of `system/init`, no race where the process dies before the ID is captured. `VERIFY` in Phase 1: confirm `--session-id` is accepted together with `-p` (documented independently; the combination is the assumption).
- **`--resume <id>` finds the session in any project on the machine** (v2.1.223+), so the resume does not have to run from the same cwd — though it should anyway, since the worktree is the point.

### The elicitation contract: `--json-schema`, not prose parsing

Do not ask the agent to emit a magic string and regex for it. `claude -p --output-format json --json-schema <schema>` constrains the final result and surfaces it in `structured_output`. Every agent turn ends in exactly one of three shapes:

```ts
// src/domain/agent-result.ts — the contract between AgentRunner and RunEngine
export const AgentResultSchema = {
  type: "object",
  required: ["status", "summary"],
  properties: {
    status:  { enum: ["complete", "needs_input", "failed"] },
    summary: { type: "string", description: "One paragraph of what happened this turn." },
    // present iff status === "needs_input"
    question: { type: "string",
      description: "One specific question only the human can answer." },
    assumptionIfUnanswered: { type: "string",
      description: "The reasonable default you will proceed with if nobody answers." },
    // present iff status === "complete"
    changedRepos: { type: "array", items: { type: "string" } },
    prTitle: { type: "string" },
    prBody:  { type: "string" },
    // present iff status === "failed"
    failureReason: { type: "string" },
  },
} as const;
```

Paired with `--append-system-prompt`:

> You are running unattended. Never ask for confirmation of anything you can reasonably decide. When you hit a decision only the human can make — a product judgement, an ambiguous requirement, a missing credential — stop and return `status: "needs_input"` with one specific `question` and the `assumptionIfUnanswered` you would otherwise proceed with. Do not commit a guess. When you finish, return `status: "complete"`. Do not push or open a PR; the worker does that.

Forcing `assumptionIfUnanswered` at ask-time is what makes the timeout fallback honest rather than invented — the assumption is the agent's own, stated before it knew whether anyone would answer.

Also pass `--permission-prompts none`, which removes `AskUserQuestion` from the toolset entirely. That closes the one path by which the agent could try to ask a human through a channel nobody is watching.

### Correlation: how a reply maps to the right pending question

Three-tier matching, exact first:

```
Tier 1 (primary, exact) — threading
  Bot posts the question via commentCreate(issueId, body) → returns commentId.
  Store it as questions.linear_comment_id.
  Comment webhook: data.parentId === questions.linear_comment_id  → exact match.
  Linear supports threaded replies via parentId on both Comment and
  CommentCreateInput, so no body parsing is needed for a threaded reply.

Tier 2 (fallback) — short-code marker
  The question comment body ends with a visible footer:
      ---
      _Reply in this thread to answer._  `⟨law-q-3f8a2b1c⟩`
  where the code is questions.id[0..8]. If a human replies at top level
  instead of in-thread, regex /⟨law-q-([0-9a-f]{8})⟩/ against the quoted
  text of their reply (Linear quote-replies carry the original).

Tier 3 (last resort) — single open question
  Exactly one open question on this issue, author != bot → match, and LOG
  that Tier 3 was used. Zero or 2+ open questions → no match, ignore.

Guard, applied before all tiers:
  data.user.id === botUserId  → drop. Without this the bot answers itself.
```

Use a visible footer, not an HTML comment — Linear renders markdown/ProseMirror and an `<!-- -->` may be stripped or displayed rather than hidden. A visible code is also better UX: the operator can see which question they are answering.

### Timeout fallback

`questions.deadline_at = asked_at + config.questionTimeoutMs` (suggest 30 min default). A single interval timer (60 s tick) plus a boot sweep — never `setTimeout` per question, which does not survive restart.

On expiry:

```
1. questions.status = 'timed_out'
2. Post: "No answer after 30m — proceeding with: {assumptionIfUnanswered}"
3. Notify all channels (this is a decision the operator must be able to audit)
4. Resume the agent with the assumption as the answer
```

Resume prompt shape:

```
The human answered your question.

Question: {question}
Answer:   {answer}

# or, on timeout:
No one answered within 30 minutes. Proceed with your stated assumption:
{assumptionIfUnanswered}
Note this assumption explicitly in the PR description.

Continue the work.
```

Cap `question_round` (default 5) — a run that asks six questions is stuck, and `failed` with that reason is more useful than an infinite polite loop. This satisfies the PROJECT.md reliability posture directly: the coordination that cannot be made reliable degrades to a documented assumption rather than hanging.

---

## Data Flow

### End-to-end: assignment → PR

```
Linear UI: assign issue ENG-42 to bot
   │
   ▼ POST /webhook  (Linear-Signature, Linear-Delivery, Linear-Timestamp)
Receiver: raw Buffer → HMAC verify → skew check → INSERT OR IGNORE delivery
   │                                                → res 200 (<5s, always)
   ▼ WebhookDelivery
EventRouter: re-fetch issue from Linear API (ignore payload.data)
   │          assignee === botUserId? existing non-terminal run? → decide
   ▼ DomainEvent{ kind:'run.requested', issueId, identifier:'ENG-42' }
RunEngine: resolve config.projects[issue.project.id] → repos: [~/code/api, ~/code/web]
   │        1 ticket × 2 repos → 1 parent run + 2 child runs (see Multi-repo)
   ▼ INSERT runs(...) state='queued'  +  LinearClient.setState(issue, 'In Progress')
   │                                  +  Notifier.emit('run.queued')
Scheduler: slot free (2/3 used) → claim
   ▼
WorktreeManager: git -C ~/code/api fetch origin
   │  git worktree add ~/.law/wt/<runId> -b <issue.branchName> origin/main
   ▼ Worktree{ path, branch, repoDir }
AgentRunner: write brief.md into the worktree; build argv
   │  claude -p "<prompt>" --session-id <preassigned-uuid>
   │    --output-format json --json-schema <AgentResultSchema>
   │    --permission-mode acceptEdits --permission-prompts none
   │    --allowedTools "Bash(git *),Bash(npm *),Read,Edit,Write,Glob,Grep"
   │    --append-system-prompt-file <unattended-rules.txt>
   │    --max-turns 80 --max-budget-usd <cap>
   │  cwd = worktree.path        (NOT --bare: GSD skills must be inherited)
   │  env = { ...process.env, LAW_RUN_ID, LAW_ISSUE_KEY, LAW_REPO }
   ▼ agent edits + commits inside the worktree
   ▼ stdout: { status:'complete', prTitle, prBody, summary }
RunEngine: state → delivering
   ▼
Deliverer: git -C <worktree> push -u origin <branch>
   │        gh pr create --repo <slug> --head <branch> --base main
   │           --title <prTitle> --body <prBody + trailer "Closes ENG-42">
   ▼ PullRequest{ url, number }
RunEngine: state → done; store pr_url
   ▼ RunEvent{ kind:'run.done', prUrl }
Notifier fan-out (all three, independently, none can throw upward):
   ├ LinearComment: "✅ PR opened: <url>"   (+ optionally issue → In Review)
   ├ Slack:         POST incoming-webhook JSON
   └ Log:           { evt:'run.done', runId, issue:'ENG-42', prUrl, durationMs }
WorktreeManager.remove(runId)   (on success only — keep it on failure)
```

### The Q&A detour

```
AgentRunner → { status:'needs_input', question, assumptionIfUnanswered }
   │  child exits 0
RunEngine: RELEASE SLOT.  state → awaiting_answer
   │  INSERT questions(id, run_id, text, assumption, deadline_at, status='open')
   ▼
LinearClient.commentCreate(issueId, body + footer ⟨law-q-3f8a2b1c⟩)
   │  → commentId  →  UPDATE questions SET linear_comment_id = ?
   ▼  ... hours. Worker may restart. Nothing is resident. ...
Human replies in thread
   ▼ Comment webhook → author != bot → parentId matches → answer
RunEngine: questions.status='answered'; ACQUIRE SLOT; state → agent_running
   ▼
AgentRunner.resume(sessionId, answerPrompt, cwd=worktree.path)
   │  claude -p "<answer>" --resume <uuid> ...same flags...
   ▼ continues where it left off
```

### Where secrets live and where they do not

- `LINEAR_API_KEY`, `NGROK_AUTHTOKEN`: process env only, sourced from the OS keychain or a `0600` env file the wizard writes. Never in `config.json`, never in a log line, never in the child's env unless the child needs it (it does not).
- Webhook signing secret: `kv` table in SQLite, obtained from `webhookCreate`, never prompted.
- Redact by allowlist in the logger — serialise only known-safe fields, never `JSON.stringify(err)` on an SDK error, which routinely carries request headers.
- The spawned agent gets `LAW_RUN_ID`, `LAW_ISSUE_KEY`, `LAW_REPO` and nothing else new. It inherits `gh`'s ambient auth from the operator's machine, which is exactly the intended design.

---

## Multi-Repo Runs

**Recommendation: one sub-run per repo. Fan out at the RunEngine, not inside the agent session.**

Model: a `runs` row gains `parent_run_id`. A ticket mapped to N repos creates one parent (`kind='ticket'`) and N children (`kind='repo'`, each with its own `repo_dir`, `worktree`, `session_id`, and state). The parent's state is derived: `done` when all children are `done`; `failed` if any child `failed`; `abandoned` if cancelled.

Why not one session with `--add-dir`:

1. **Concurrency accounting breaks.** The cap is on RAM-per-`claude`-process. One session touching 4 repos is one slot but four repos' worth of context — the cap stops meaning what it says.
2. **Blast radius.** A failure in repo B loses repo A's completed work, because they share a session and a state row. Separate runs means repo A still ships its PR.
3. **Git gets confusing fast.** One process with multiple worktrees invites `cd`-drift, commits to the wrong repo, and `gh pr create` against the wrong `--repo`. Each child run has exactly one cwd and one remote — unambiguous.
4. **Delivery is per-repo anyway.** One branch, one push, one PR per repo. The Deliverer contract stays a clean 1:1.
5. **Retry granularity.** Repo B can be retried alone.

The real cost is lost shared context and N× tokens. Mitigate cheaply: RunEngine writes one **ticket brief** (issue title, description, acceptance criteria, the full repo list, and *which* repo this run owns) into each worktree once, so every child knows it is part of a coordinated change. Do not build cross-run agent messaging — for a single-operator tool that is speculative complexity.

Ordering: run children **in parallel**, subject to the global semaphore. If a config entry ever needs sequencing (migrate the API before the web client), add an optional `dependsOn` on the repo mapping later. Not now.

Notification: notify per-child (`✅ api: PR #123`) and once on parent completion with the full list. Slack gets one message per child plus a rollup; Linear gets a rollup comment to avoid spamming the issue.

---

## Interface Contracts for Parallel Construction

**This is the artefact that makes horizontal-layer construction possible.** Land the whole of `src/domain/` in Wave 0 as types-plus-fakes. Every other layer then builds and unit-tests against these interfaces with no dependency on any sibling layer's progress.

### `src/domain/types.ts` — shared vocabulary

```ts
export type RunId = string;      // uuid v4
export type IssueId = string;    // Linear uuid
export type SessionId = string;  // uuid v4, pre-assigned to claude --session-id

export type RunState =
  | 'queued' | 'claimed' | 'worktree_ready' | 'agent_running'
  | 'awaiting_answer' | 'delivering' | 'done' | 'failed' | 'abandoned';

export const TERMINAL: readonly RunState[] = ['done', 'failed', 'abandoned'];
export const HOLDS_SLOT: readonly RunState[] =
  ['claimed', 'worktree_ready', 'agent_running', 'delivering'];

export interface Run {
  id: RunId;
  parentRunId: RunId | null;      // null for ticket-level and single-repo runs
  kind: 'ticket' | 'repo';
  issueId: IssueId;
  issueKey: string;               // "ENG-42"
  issueTitle: string;
  issueUrl: string;
  repoDir: string | null;         // null on a ticket-level parent
  repoSlug: string | null;        // "org/api", for gh pr create
  branch: string | null;          // from issue.branchName
  worktreePath: string | null;
  sessionId: SessionId | null;    // pre-assigned before the first spawn
  pid: number | null;
  state: RunState;
  attempt: number;
  questionRound: number;
  prUrl: string | null;
  failureReason: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface PendingQuestion {
  id: string;                     // uuid; first 8 chars are the ⟨law-q-…⟩ marker
  runId: RunId;
  text: string;
  assumption: string;             // agent's own assumptionIfUnanswered
  linearCommentId: string | null; // set after the comment is posted
  askedAt: number;
  deadlineAt: number;
  status: 'open' | 'answered' | 'timed_out' | 'cancelled';
  answer: string | null;
}
```

### `src/domain/state-machine.ts` — pure, zero deps, the thing everyone imports

```ts
export type Trigger =
  | 'claim' | 'worktree_ready' | 'spawned' | 'needs_input' | 'answered'
  | 'timed_out' | 'agent_complete' | 'delivered' | 'cancel' | 'error'
  | 'requeue';

/** Single source of truth. Pure. Unit-testable with no I/O whatsoever. */
export function nextState(from: RunState, t: Trigger): RunState | null;

/** Throws IllegalTransitionError. Use at every call site. */
export function assertTransition(from: RunState, t: Trigger): RunState;

export function holdsSlot(s: RunState): boolean;
export function isTerminal(s: RunState): boolean;
```

### `src/domain/ports.ts` — every cross-layer boundary in one file

```ts
// ── L0 ─────────────────────────────────────────────────────────────────
export interface RepoMapping {
  repoDir: string;                    // absolute
  repoSlug: string;                   // "org/name"
  baseBranch: string;                 // default "main"
  enabled: boolean;
}
export interface ProjectMapping {
  linearProjectId: string;
  repos: RepoMapping[];
  slackWebhookUrl?: string;
  postLinearComments: boolean;
  autoTransition: boolean;
}
export interface Config {
  botUserId: string;
  teamId: string;
  concurrency: number;                // default 3
  questionTimeoutMs: number;          // default 1_800_000
  maxQuestionRounds: number;          // default 5
  maxTurns: number;
  maxBudgetUsd?: number;
  worktreeRoot: string;               // ~/.linear-auto-worker/worktrees
  dbPath: string;
  projects: ProjectMapping[];
}
export interface ConfigLoader {
  load(): Promise<Config>;            // throws ConfigError with a zod path
  path(): string;
}

export interface Store {
  // runs
  insertRun(r: Omit<Run, 'createdAt' | 'updatedAt'>): void;
  getRun(id: RunId): Run | undefined;
  updateRun(id: RunId, patch: Partial<Run>): void;
  findActiveRunByIssue(issueId: IssueId): Run[];   // non-terminal
  listByState(...s: RunState[]): Run[];
  nextQueued(limit: number): Run[];                // ORDER BY createdAt
  childRuns(parentId: RunId): Run[];
  // questions
  insertQuestion(q: PendingQuestion): void;
  openQuestionsForIssue(issueId: IssueId): PendingQuestion[];
  findQuestionByCommentId(parentCommentId: string): PendingQuestion | undefined;
  findQuestionByShortCode(code: string): PendingQuestion | undefined;
  updateQuestion(id: string, patch: Partial<PendingQuestion>): void;
  expiredQuestions(now: number): PendingQuestion[];
  // deliveries — returns false if the id was already present
  recordDelivery(deliveryId: string, receivedAt: number): boolean;
  pruneDeliveries(olderThan: number): void;
  // kv
  kvGet(k: string): string | undefined;
  kvSet(k: string, v: string): void;
  transaction<T>(fn: () => T): T;
  close(): void;
}

export interface Logger {
  child(bindings: Record<string, unknown>): Logger;
  info(o: object, msg?: string): void;
  warn(o: object, msg?: string): void;
  error(o: object, msg?: string): void;
  debug(o: object, msg?: string): void;
}

// ── L1 INGRESS ─────────────────────────────────────────────────────────
export interface TunnelManager {
  open(port: number): Promise<string>;   // resolves to the public https URL
  url(): string | null;
  close(): Promise<void>;
}

export interface WebhookRegistrar {
  /** Idempotent create-or-update by label. Returns the signing secret. */
  reconcile(publicUrl: string): Promise<{ webhookId: string; secret: string }>;
  disable(): Promise<void>;              // best-effort, on shutdown
}

export interface WebhookDelivery {
  deliveryId: string;                    // Linear-Delivery
  eventType: string;                     // Linear-Event: "Issue" | "Comment"
  action: 'create' | 'update' | 'remove';
  timestamp: number;                     // Linear-Timestamp (unix ms)
  body: unknown;                         // parsed, but treated as a HINT only
}

export interface Receiver {
  /** Binds 127.0.0.1:0. Resolves with the chosen ephemeral port. */
  listen(onDelivery: (d: WebhookDelivery) => void): Promise<number>;
  setSecret(secret: string): void;       // callable after reconcile()
  close(): Promise<void>;
}

export type DomainEvent =
  | { kind: 'run.requested'; issueId: IssueId }
  | { kind: 'run.cancelled'; issueId: IssueId; reason: string }
  | { kind: 'question.answered'; questionId: string; answer: string;
      authorName: string }
  | { kind: 'ignored'; reason: string };

export interface EventRouter {
  /** Re-fetches canonical issue state; never decides from delivery.body. */
  route(d: WebhookDelivery): Promise<DomainEvent>;
}

// ── L2 ORCHESTRATION ───────────────────────────────────────────────────
export interface Scheduler {
  start(): void;
  pause(): void;
  /** Resolves when a slot is free; the returned fn releases it exactly once. */
  acquire(runId: RunId): Promise<() => void>;
  inUse(): number;
  capacity(): number;
}

export interface RunEngine {
  handle(e: DomainEvent): Promise<void>;
  /** Boot sweep: reconcile every non-terminal row against reality. */
  recover(): Promise<void>;
  /** 60s tick: expire questions past deadline and resume with the assumption. */
  tick(now: number): Promise<void>;
  drain(graceMs: number): Promise<void>;
}

// ── L3 EXECUTION ───────────────────────────────────────────────────────
export interface Worktree {
  runId: RunId; repoDir: string; path: string; branch: string; baseBranch: string;
}
export interface WorktreeManager {
  create(runId: RunId, repo: RepoMapping, branch: string): Promise<Worktree>;
  remove(runId: RunId): Promise<void>;
  exists(runId: RunId): Promise<boolean>;
  /** Boot GC: drop worktrees with no non-terminal run. */
  gc(liveRunIds: Set<RunId>): Promise<string[]>;
}

export interface AgentSpawnRequest {
  runId: RunId;
  sessionId: SessionId;     // pre-assigned; passed as --session-id
  cwd: string;              // worktree path
  prompt: string;
  resume: boolean;          // true → --resume <sessionId>
  env: Record<string, string>;
}
export type AgentResult =
  | { status: 'complete';    summary: string; prTitle: string; prBody: string }
  | { status: 'needs_input'; summary: string; question: string;
      assumptionIfUnanswered: string }
  | { status: 'failed';      summary: string; failureReason: string }
  | { status: 'crashed';     exitCode: number; stderrTail: string }
  | { status: 'cancelled' };

export interface AgentRunner {
  run(req: AgentSpawnRequest, signal: AbortSignal): Promise<AgentResult>;
  onProgress(cb: (runId: RunId, line: string) => void): void;
}

export interface PullRequest { url: string; number: number; }
export interface Deliverer {
  /** push branch, then gh pr create. Idempotent: an existing PR is returned. */
  deliver(wt: Worktree, repo: RepoMapping,
          pr: { title: string; body: string }): Promise<PullRequest>;
}

// ── L4 OUTBOUND ────────────────────────────────────────────────────────
export interface LinearIssue {
  id: IssueId; identifier: string; title: string; description: string | null;
  url: string; branchName: string; assigneeId: string | null;
  projectId: string | null; stateId: string; stateType: string; // "started" | ...
}
export interface LinearClient {
  viewer(): Promise<{ id: string; name: string }>;             // preflight
  getIssue(id: IssueId): Promise<LinearIssue>;                 // the re-fetch
  listAssignedOpenIssues(botUserId: string): Promise<LinearIssue[]>; // boot sweep
  setIssueState(id: IssueId, stateType: 'started' | 'review'): Promise<void>;
  createComment(issueId: IssueId, body: string,
                parentId?: string): Promise<{ id: string }>;
  // webhook CRUD used only by WebhookRegistrar
  listWebhooks(): Promise<Array<{ id: string; label: string | null;
    url: string; enabled: boolean; resourceTypes: string[] }>>;
  createWebhook(i: { label: string; url: string; teamId: string;
    resourceTypes: string[] }): Promise<{ id: string; secret: string }>;
  updateWebhook(id: string, i: { url?: string; enabled?: boolean;
    resourceTypes?: string[] }): Promise<void>;
  deleteWebhook(id: string): Promise<void>;
}

export type RunEvent =
  | { kind: 'run.queued'; run: Run }
  | { kind: 'run.started'; run: Run }
  | { kind: 'run.question'; run: Run; question: PendingQuestion }
  | { kind: 'run.answered'; run: Run; answer: string; viaTimeout: boolean }
  | { kind: 'run.done'; run: Run; prUrl: string }
  | { kind: 'run.failed'; run: Run; reason: string }
  | { kind: 'run.abandoned'; run: Run; reason: string };

export interface Notifier {
  /** Fans out to log (always) + Linear + Slack (per config). NEVER throws. */
  emit(e: RunEvent): Promise<void>;
}
```

### The rule that makes this actually work in parallel

Ship a **fake for every port in Wave 0**, in `src/domain/fakes.ts`: `InMemoryStore`, `FakeLinearClient`, `FakeAgentRunner` (returns a scripted `AgentResult[]`), `FakeWorktreeManager` (tmpdir), `FakeDeliverer`, `RecordingNotifier`, `FakeTunnel`. Then the L2 team tests the full state machine end to end on day one without a single real dependency, and the L1/L3/L4 teams test their real implementations against the same interfaces in isolation. Integration becomes wiring, not discovery.

---

## Recommended Project Structure

```
src/
├── domain/                  # WAVE 0. Zero deps. Everyone imports this.
│   ├── types.ts             # Run, PendingQuestion, RunState, ids
│   ├── state-machine.ts     # nextState / assertTransition — pure
│   ├── ports.ts             # every cross-layer interface
│   ├── agent-result.ts      # the --json-schema contract + parser
│   ├── errors.ts            # typed errors: ConfigError, IllegalTransition, …
│   └── fakes.ts             # a fake per port (test-only, shipped in Wave 0)
├── infra/                   # L0 real implementations
│   ├── config.ts            # zod schema, loader, defaults
│   ├── store/
│   │   ├── db.ts            # better-sqlite3 open, WAL, pragmas
│   │   ├── migrations/      # 001_init.sql, …
│   │   └── sqlite-store.ts  # implements Store — ALL SQL lives here
│   └── logger.ts            # pino + allowlist redaction
├── ingress/                 # L1
│   ├── tunnel.ts            # @ngrok/ngrok
│   ├── registrar.ts         # reconcile-by-label
│   ├── receiver.ts          # node:http, raw body, HMAC, dedupe, ACK<5s
│   ├── signature.ts         # verify() — pure, heavily unit-tested
│   └── router.ts            # normalise + re-fetch + decision table
├── orchestration/           # L2
│   ├── scheduler.ts         # semaphore
│   ├── run-engine.ts        # the FSM driver — sole writer of runs.state
│   └── questions.ts         # correlation tiers + deadline sweep
├── execution/               # L3
│   ├── worktree.ts
│   ├── agent-runner.ts      # argv builder + spawn + supervise
│   ├── prompt.ts            # brief.md + system-prompt composition
│   └── deliverer.ts         # git push + gh pr create
├── outbound/                # L4
│   ├── linear-client.ts     # @linear/sdk facade
│   └── notify/
│       ├── notifier.ts      # fan-out, swallows channel errors
│       ├── linear-channel.ts
│       ├── slack-channel.ts
│       └── log-channel.ts   # not disableable
├── cli/                     # L5
│   ├── daemon.ts            # composition root — the boot sequence, in order
│   ├── wizard.ts            # setup
│   └── index.ts             # arg parsing: `law setup` | `law start` | `law status`
└── index.ts
prompts/
└── unattended-rules.md      # --append-system-prompt-file
```

### Structure rationale

- **`domain/` is the seam.** It contains no I/O, so it compiles and tests in milliseconds and can never develop a circular dependency on a layer. It is the only shared surface between the parallel teams.
- **Folders map 1:1 to build waves,** so a phase owns a folder and merge conflicts are near-zero.
- **All SQL confined to `infra/store/`.** A stray `db.prepare()` in `run-engine.ts` is how a state machine quietly grows a second writer.
- **`ingress/signature.ts` is its own pure file** because it is the one security-critical function in the codebase and deserves table-driven tests with real captured payloads.
- **`prompts/` outside `src/`** so the operator can edit agent behaviour without a rebuild.

---

## Architectural Patterns

### Pattern 1: Webhook as a hint, API as the truth

**What:** Never branch on `payload.data`. Extract the entity ID, re-fetch, decide.
**When:** Any at-least-once webhook source with no ordering guarantee — which is all of them.
**Trade-offs:** One extra API call per event; in exchange, out-of-order events, duplicate deliveries, and partial payloads all stop being separate problems.

```ts
async route(d: WebhookDelivery): Promise<DomainEvent> {
  const issueId = extractIssueId(d);                 // the ONLY use of d.body
  const issue = await this.linear.getIssue(issueId); // ground truth
  const active = this.store.findActiveRunByIssue(issueId);

  if (issue.assigneeId !== this.cfg.botUserId) {
    return active.length
      ? { kind: 'run.cancelled', issueId, reason: 'unassigned' }
      : { kind: 'ignored', reason: 'not-assigned-to-bot' };
  }
  if (active.length) return { kind: 'ignored', reason: 'already-running' };
  return { kind: 'run.requested', issueId };
}
```

### Pattern 2: ACK first, work later

**What:** The HTTP handler verifies, dedupes, ACKs, and only then schedules the work off the response path.
**When:** Any webhook with a response deadline. Linear's is **5 seconds**, and a blown deadline burns one of only three retries.
**Trade-offs:** Work after the ACK can be lost to a crash — which is precisely what the boot-time missed-work sweep exists to cover.

### Pattern 3: Caller-assigned session identity

**What:** Generate the session UUID in the worker, persist it, then pass `--session-id <uuid>` to the child.
**When:** Any time you must resume a child process you spawned.
**Trade-offs:** Depends on `--session-id` working with `-p` (`VERIFY`). The fallback — parse `session_id` from the `system/init` event under `--output-format stream-json` — works but reintroduces the window where the process dies before you have captured the ID and the run becomes unresumable.

```ts
const sessionId = randomUUID();
store.updateRun(runId, { sessionId });          // persist BEFORE spawning
const args = ['-p', prompt,
  resume ? '--resume' : '--session-id', sessionId,
  '--output-format', 'json', '--json-schema', JSON.stringify(AgentResultSchema),
  '--permission-mode', 'acceptEdits', '--permission-prompts', 'none',
  '--allowedTools', ALLOWED.join(','),
  '--append-system-prompt-file', UNATTENDED_RULES,
  '--max-turns', String(cfg.maxTurns)];
// NOTE: no --bare. GSD skills must be inherited from the global install.
```

### Pattern 4: Structured agent output over prose parsing

**What:** `--json-schema` constrains the final result to a discriminated union; the worker `switch`es on `status`.
**When:** Whenever a program, not a human, consumes an agent's output.
**Trade-offs:** The schema is a contract to maintain. Vastly better than regexing for a magic marker, which fails silently the day the model phrases it differently.

### Pattern 5: The slot-releasing wait

**What:** A state that is logically "in progress" but holds no process and no concurrency slot.
**When:** Any orchestrator where a step can block on a human.
**Trade-offs:** Requires the work to be resumable from durable storage — which `--resume` provides. Without it, human-latency steps and a low concurrency cap are fundamentally incompatible.

### Pattern 6: Fan-out notification that cannot fail the run

```ts
async emit(e: RunEvent) {
  this.log.emit(e);                                   // always, first, sync
  const rest = [this.linear, this.slack].filter(c => c.enabled(e));
  const results = await Promise.allSettled(rest.map(c => c.emit(e)));
  for (const r of results)
    if (r.status === 'rejected')
      this.log.warn({ err: r.reason }, 'notify channel failed');
  // never rethrows: a Slack outage must not fail a finished PR
}
```

---

## Anti-Patterns

### Anti-Pattern 1: Delete-and-recreate the webhook on every boot

**What people do:** `webhookDelete` then `webhookCreate` at startup, because it is simpler than reconciling.
**Why it's wrong:** Rotates the signing secret every restart, and a crash between the two calls leaves the workspace with zero webhooks and the operator with no idea why nothing fires. Repeated create-without-delete is worse: N duplicate webhooks means every event delivered N times.
**Instead:** Reconcile by a stable `label` — update the URL on the existing webhook and preserve the secret. Only delete-and-recreate in the one recoverable case where the secret is genuinely lost.

### Anti-Pattern 2: Blocking the webhook response on real work

**What people do:** `await runEngine.handle(event)` inside the request handler.
**Why it's wrong:** Spawning `claude`, creating a worktree, or calling Linear will exceed 5 seconds. Linear marks the delivery failed, retries at 1 min / 1 h / 6 h — so the work runs twice — and after enough failures **disables the webhook**, at which point the daemon looks alive and does nothing.
**Instead:** ACK immediately, hand off, and treat the boot sweep as the safety net.

### Anti-Pattern 3: An `ask_human` MCP tool that long-polls

**What people do:** Expose a tool that blocks until a human answers; it is the most obvious design.
**Why it's wrong:** Documented Claude Code behaviour moves any main-conversation MCP call still running after **two minutes** into a background task. The model receives a task ID and **keeps coding without the answer**. The run does not hang — it silently proceeds on an un-made decision, which is worse than hanging because nothing looks wrong until the PR is reviewed.
**Instead:** End the turn with `status: "needs_input"` and resume with `--resume` once the answer lands.

### Anti-Pattern 4: Re-parsing the body before verifying the signature

**What people do:** `app.use(express.json())` then HMAC over `JSON.stringify(req.body)`.
**Why it's wrong:** Key order, unicode escaping, and whitespace all shift; the signature fails intermittently, which reads as "Linear is flaky" and gets fixed by disabling verification. Linear's own docs call this out explicitly.
**Instead:** Capture the raw `Buffer` first and HMAC that. Parse after verification.

### Anti-Pattern 5: Letting the agent open the PR

**What people do:** "and then open a PR with `gh`" at the end of the prompt.
**Why it's wrong:** Non-deterministic. The agent may run out of turns, forget, use a wrong base branch, or open a PR against a fork. Delivery is the entire product value; it cannot be probabilistic.
**Instead:** The worker owns push and PR creation (already locked in PROJECT.md). The agent's only job is commits in a worktree, and the system prompt says so explicitly.

### Anti-Pattern 6: `setTimeout` for the question deadline

**What people do:** `setTimeout(expire, 30 * 60_000)` when posting the question.
**Why it's wrong:** Dies with the process. A restart during the wait means the question never expires and the run is stuck in `awaiting_answer` forever — a deadlock the timeout was specifically designed to prevent.
**Instead:** Persist `deadline_at` and sweep it on a 60 s tick *and* at boot.

### Anti-Pattern 7: The bot answering its own question

**What people do:** Handle every `Comment` create event.
**Why it's wrong:** The bot's own status comments arrive back as webhooks, correlate to the open question, and resume the agent with its own text — a fast, expensive loop.
**Instead:** Drop `data.user.id === botUserId` before any correlation tier runs. Write the test for this in Wave 0.

### Anti-Pattern 8: Trusting `agent_running` rows at boot

**What people do:** Resume the process handle for rows in `agent_running`.
**Why it's wrong:** The handle died with the parent. The row is a lie, the semaphore leaks a slot, and the ticket never progresses.
**Instead:** Invariant — at boot, `agent_running` rows are *by definition* crash artefacts. Move them to `queued, resumable=true` unconditionally.

---

## Build Order and Integration Points

Horizontal-parallel, four waves. Wave 0 is the only true serialisation point and it is small.

### Wave 0 — the contract (must land first, ~1 phase, one owner)

`src/domain/` in full: `types.ts`, `state-machine.ts`, `ports.ts`, `agent-result.ts`, `errors.ts`, `fakes.ts`. Plus the SQL schema in `infra/store/migrations/001_init.sql`, because the table shapes are part of the contract.

**Exit gate:** `nextState` has a table-driven test covering every legal transition and rejecting a sample of illegal ones; every port has a compiling fake. Nothing else starts until this merges.

### Wave 1 — four independent layers, fully parallel

| Phase | Builds | Tests against | Blocked by |
|---|---|---|---|
| **1a Foundation** | `infra/config`, `infra/store` (real SQLite), `infra/logger` | tmp DB files | Wave 0 |
| **1b Ingress** | `ingress/*` — tunnel, registrar, receiver, signature, router | `FakeLinearClient`, `InMemoryStore`; a real local ngrok tunnel curled by hand | Wave 0 |
| **1c Execution** | `execution/*` — worktree, agent-runner, deliverer | scratch git repos; a real `claude -p` on a trivial prompt; a throwaway GitHub repo | Wave 0 |
| **1d Outbound** | `outbound/*` — LinearClient, Notifier + 3 channels | a real Linear scratch team; a real Slack webhook | Wave 0 |

Nothing in 1a–1d imports anything from a sibling. Each is proven independently.

### Wave 2 — orchestration (needs only the fakes, so it can start with Wave 1)

`orchestration/*` — Scheduler, RunEngine, question correlation and deadlines. Built entirely against `domain/fakes.ts`: `FakeAgentRunner` scripted to return `needs_input` then `complete` exercises the whole Q&A round trip with no Claude process and no network.

**This is the phase with the highest bug density and it is testable in complete isolation.** Give it the strongest owner.

### Wave 3 — integration

| Point | Wire | First real test |
|---|---|---|
| **I1** | Store → RunEngine (drop `InMemoryStore`) | a run survives a restart mid-`awaiting_answer` |
| **I2** | Router → RunEngine | a signed synthetic POST creates a `queued` run |
| **I3** | RunEngine → WorktreeManager + AgentRunner | one ticket → real worktree → real `claude` → `complete` |
| **I4** | RunEngine → Deliverer | that run produces a real PR |
| **I5** | RunEngine → Notifier | Linear comment + Slack message appear |
| **I6** | `cli/daemon.ts` boot sequence, in order | cold start → assign in Linear → PR, hands off |
| **I7** | `cli/wizard.ts` | fresh machine → working daemon |

### Integration order matters

Wire **I2 before I3**. A run reaching `queued` from a real signed webhook, with the execution layer still faked, proves the entire ingress→orchestration seam while the expensive half is still cheap to iterate on. Wiring execution first means every ingress bug costs a full Claude session to reproduce.

### The one thing that must be right before anything else

`domain/state-machine.ts`. Every layer encodes assumptions about which states exist and what they mean. Change it in Wave 2 and all four Wave-1 phases need rework. Spend disproportionate care on it, and treat the transition table above as the reviewable artefact.

---

## Scaling Considerations

The relevant axis is runs/day and repos, not users — this is a single-operator daemon by definition.

| Scale | Adjustments |
|---|---|
| 1–20 runs/day, 1–5 repos | The design as written. SQLite, 3 slots, in-process everything. Nothing to change. |
| 20–100 runs/day, 5–20 repos | First real bottleneck is **laptop RAM**, not the architecture. Make `concurrency` per-repo-group. Add worktree GC on a timer, not just at boot. Prune `deliveries` daily. |
| 100+ runs/day, or a second operator | The tunnel becomes the constraint (random free ngrok URL churns on restart). Move to a reserved ngrok domain so registration reconcile becomes a no-op and the missed-work sweep stops mattering. Beyond that this stops being a local daemon — different product. |

### Scaling priorities

1. **First bottleneck: RAM from concurrent `claude` processes.** Already mitigated by the semaphore and, decisively, by `awaiting_answer` releasing its slot.
2. **Second: the boot missed-work sweep** becomes an O(open issues) Linear query. Fine to hundreds; paginate and filter by `updatedAt > lastSeenAt` beyond that.
3. **Not a bottleneck: SQLite.** At single-operator write volume it is unlimited headroom. Do not entertain Postgres.

---

## Integration Points

### External services

| Service | Integration | Gotchas |
|---|---|---|
| **Linear webhooks** | inbound HTTPS via ngrok | 5s response budget; at-least-once; max 3 retries at 1m/1h/6h; auto-disable on sustained failure; HMAC over the **raw** body with no `sha256=` prefix |
| **Linear GraphQL** | `@linear/sdk` with a bot personal API key | webhook CRUD needs workspace **admin**; the signing secret is returned **only** by `webhookCreate`; `branchName` is a computed Issue field (`VERIFY` it is not in the webhook payload) |
| **ngrok** | `@ngrok/ngrok` in-process; `authtoken_from_env` | requires a **verified** account even on free; reads `NGROK_AUTHTOKEN` from env, **not** `~/.config/ngrok/ngrok.yml` — the wizard must lift the token out of that YAML; random domain changes every boot, which is what forces registration reconcile + the missed-work sweep |
| **`claude` CLI** | `child_process.spawn` | print mode starts in **Manual** permission mode, so a mode must be passed explicitly; do **not** pass `--bare` (it skips skill/plugin/CLAUDE.md discovery, which would strip the global GSD install the whole design depends on); SIGTERM → exit 143, session still resumable; `--permission-prompts none` removes `AskUserQuestion` |
| **`gh` CLI** | `child_process.execFile` | inherits the operator's ambient auth; `gh pr create` is not idempotent — check for an existing PR on the head branch first; always pass `--repo` explicitly, never rely on cwd |
| **git** | `execFile` | `worktree add` needs a fetched base ref; never `cd` — always `git -C <dir>`; `worktree prune` before `add` to clear crash residue |
| **Slack** | incoming-webhook `POST` | fire-and-forget; a failure must never fail a run |

### Internal boundaries

| Boundary | Communication | Notes |
|---|---|---|
| Receiver → EventRouter | callback with `WebhookDelivery` | **after** the 200 is sent |
| EventRouter → RunEngine | `DomainEvent`, awaited | router does the re-fetch; engine does the deciding |
| Scheduler ↔ RunEngine | `acquire()` returning a release fn | release must be idempotent — call it in a `finally` |
| RunEngine → Worktree/Agent/Deliverer | direct async calls | engine is the only caller of all three |
| RunEngine → Notifier | `emit(RunEvent)`, awaited but never throwing | swallowing errors here is deliberate, not sloppy |
| RunEngine → Store | via the `Store` port | the **only** writer of `runs.state`, enforced by convention |
| Everything → domain | type-only imports | zero runtime deps, so no cycles are possible |

---

## Sources

All URLs are first-party vendor documentation, fetched directly. The `LOW` confidence tags below are the `classify-confidence` seam's tier for the `webfetch`/`websearch` **provider**, not a judgement on source authority.

- [Linear — Webhooks](https://linear.app/developers/webhooks) — signature/delivery/timestamp headers, at-least-once, 5s + 3-retry policy, payload shape, webhook CRUD. Provider tier: LOW (`webfetch`); source: first-party.
- [Linear — Getting started / GraphQL](https://linear.app/developers/graphql) — `issueUpdate`, state transitions. Provider tier: LOW.
- [Linear API schema — CommentCreateInput](https://studio.apollographql.com/public/Linear-API/variant/current/schema/reference/inputs/CommentCreateInput) — `parentId` threading. Provider tier: LOW (`websearch`).
- [Claude Code — Run Claude Code programmatically (headless)](https://code.claude.com/docs/en/headless) — `-p`, output formats, `--json-schema`, `--resume` with `-p`, `--bare` caveats, SIGTERM/143 resumability, permission modes, `--permission-prompts none`. Provider tier: LOW; source: first-party.
- [Claude Code — CLI reference](https://code.claude.com/docs/en/cli-reference) — `--session-id`, `--fork-session`, `--input-format`, `--max-turns`, `--max-budget-usd`, `--mcp-config`, `--append-system-prompt-file`. Provider tier: LOW; source: first-party.
- [Claude Code — Connect to external tools with MCP](https://code.claude.com/docs/en/agent-sdk/mcp) — **the 2-minute MCP-call backgrounding behaviour** that rules out design (c); `MCP_TIMEOUT`, tool naming, `allowedTools`. Provider tier: LOW; source: first-party. *This is the single most decision-relevant finding in the document.*
- [Claude Code — Streaming input vs single message](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode) — long-lived streaming-input sessions (design b). Provider tier: LOW; source: first-party.
- [Claude Code — Environment variables](https://code.claude.com/docs/en/env-vars) — `BASH_MAX_TIMEOUT_MS`, `API_TIMEOUT_MS`, stall timeouts. Provider tier: LOW; source: first-party.
- [@ngrok/ngrok JS SDK reference](https://ngrok.github.io/ngrok-javascript/) — `forward()`, `listen()`, `Listener.url()/close()`, `disconnect()`, process-bound lifetime. Provider tier: LOW; source: first-party.
- [Hookdeck — Guide to Linear webhooks](https://hookdeck.com/webhooks/platforms/guide-to-linear-webhooks-features-and-best-practices) — independent corroboration of signature format and retry schedule. Provider tier: LOW.
- [GitHub — claude-code issue #47076 / #70441](https://github.com/anthropics/claude-code/issues/47076) — `MCP_TOOL_TIMEOUT` / `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` semantics and the long history of long-running MCP call failures. Provider tier: LOW.

### Open items to verify in Phase 1

1. `--session-id <uuid>` is accepted alongside `-p`. Both flags are documented; the combination is inferred. Fallback: parse `session_id` from the `system/init` event under `--output-format stream-json`.
2. Whether the Linear Issue webhook payload carries `branchName`. Made moot by the re-fetch pattern, but worth knowing so the extra call can be skipped if it is present.
3. That a `-p` session created with `--json-schema` resumes cleanly with `--resume` and re-applies the schema on the resumed turn. Fallback: pass `--json-schema` on every invocation, resume included (which the argv builder above already does).

---
*Architecture research for: webhook-driven local coding-agent orchestrator*
*Researched: 2026-09-06*
