# Phase 4: Execution - Research

**Researched:** 2026-09-06
**Domain:** Supervised child-process orchestration — git worktree isolation, `claude -p` agent supervision, worker-owned GitHub PR delivery
**Confidence:** HIGH (every load-bearing claim below was produced by running the real `claude` v2.1.259 and `gh` v2.98.0 binaries on this machine during this session, not recalled)

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Agent invocation**

- **D-01:** `--permission-mode dontAsk`. Verified present on the installed CLI v2.1.259
  (choices: acceptEdits, auto, bypassPermissions, manual, dontAsk, plan). Chosen so a run
  never stalls waiting on a permission prompt with no human present, without the blanket
  grant of `bypassPermissions`.
  **Planning must verify** how `dontAsk` composes with `--permission-prompts none` on
  this CLI version — the two overlap and their interaction is unconfirmed.
- **D-02:** `--bare` is **forbidden**, and the code must carry a comment saying why.
  Vendor docs recommend it for scripted use and say it will become the `-p` default; it
  skips `~/.claude` auto-discovery and would strip the global GSD install this entire
  project depends on. Without the comment a future contributor adds it back by following
  the docs, and the product breaks silently.
- **D-03:** `--verbose` is mandatory alongside `--output-format stream-json` — omitting
  it is a hard startup error, not a warning.
- **D-04:** Session ID is **pre-assigned** (`--session-id <crypto.randomUUID()>`) and
  persisted to the run row **before** spawn. Never parsed out of the stream: hook and
  plugin events routinely precede `system/init`, and this operator's setup is hook-heavy.
- **D-05:** Assert on the `system/init` event that GSD skills are present. Fail the run
  **loudly** if absent — this is the difference between "GSD did not run" and "GSD ran and
  found nothing to do", which are indistinguishable from the outcome alone.

**Judging success**

- **D-06:** Success is judged by **evidence in the worktree, never by exit code**.
  `claude -p` exits 0 having been denied every edit, and that is the single most likely
  failure mode for this project. Classify: commits/diff present → `delivered`; some work
  but incomplete → `partial` (still ships a **draft PR**); nothing → `barren`, which maps
  to the `failed` state.

**Process supervision**

- **D-07:** Drain **both** stdout and stderr. Undrained stdout deadlocks at ~64 KB, which
  a real run reaches within its first minute.
- **D-08:** Line-buffer the `stream-json` parse with a carry for partial lines. A naive
  `split("\n").map(JSON.parse)` breaks on chunk boundaries.
- **D-09:** Spawn `detached: true` and kill via `process.kill(-pid)` on the process
  group. A plain `child.kill()` orphans the agent's own Bash subprocesses.
- **D-10:** Escalate **SIGINT → SIGTERM → SIGKILL**. SIGINT first keeps the session
  resumable, so an overrun run can be continued rather than only killed. A timed-out run
  leaves its worktree intact.

**Worktree**

- **D-11:** One worktree per run, using Linear's suggested `branchName`. **Never `git
  worktree add -B`** — it destroys the previous attempt's commits. Suffix a colliding
  branch name instead. Successful run cleans up; failed run leaves the worktree in place
  for the operator; a worktree orphaned by a crash is pruned at next boot.

**Delivery**

- **D-12:** The **worker** pushes and opens the PR, never the agent — delivery must not
  depend on the agent remembering a final step. Push explicitly before invoking `gh`
  (which has no TTY). Always pass `--base` and `-R OWNER/REPO`. `gh pr create` has **no
  `--json` flag**; read the URL from stdout.
- **D-13:** Push is refused outright on the default branch, blocked on a secret detected
  in the diff, and never uses `--force`. A diff touching CI or workflow files is flagged
  prominently in both the PR body and the terminal comment.

**Security**

- **D-14:** Untrusted ticket text gets **both** layers: strip control and zero-width
  characters, **and** wrap the body in an explicit untrusted-data delimiter. Neither alone
  suffices — stripping does not stop a plainly-worded "ignore previous instructions", and
  delimiting does not stop invisible-character smuggling.
- **D-15:** Sanitize the child environment. The agent has no business calling Linear —
  withhold `LINEAR_API_KEY` and `NGROK_AUTHTOKEN` from the spawned process entirely.

**Q&A hand-off**

- **D-16:** The agent ends its turn with a schema-constrained result (`--json-schema`)
  declaring `needs_input`, carrying **both** the question and the assumption it would
  otherwise make. Never regex a magic string out of prose.

### Claude's Discretion

CONTEXT.md declares no explicit discretion section for this phase. Discretion is therefore
limited to implementation shape (module decomposition, function signatures, test layout)
within the locked decisions above.

### Deferred Ideas (OUT OF SCOPE)

None — phase scope is already the largest in the milestone.

### Binding run constraints (from RUSH.md)

- No sibling phase's code exists on this branch. No `package.json`, no `node_modules`, no `src/`.
- The contract is TEXT: `.planning/phases/01-domain-contract-state-machine-schema/01-CONTEXT.md` ADDENDUM.
- Do not edit `src/domain/`. Needed-but-missing port methods go in `04-SUMMARY.md` under `Contract additions requested`.
- **No typecheck, no tests, no build, by anyone.** Write test files; never make a plan task's verification `npm test` or `tsc`.
- Commit with `git commit -n`, one commit per coherent chunk.

</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| AGNT-01 | Worktree per run on Linear's suggested `branchName` | Pattern 1 (worktree lifecycle); Pitfall 6 |
| AGNT-02 | Worktree removed on success, left in place on failure | Pattern 1; `git worktree remove --force` required |
| AGNT-03 | Crash-orphaned worktrees pruned at boot | Pattern 1 (boot reconcile: `prune` + `list --porcelain`) |
| AGNT-04 | Session ID generated + persisted before spawn, never parsed from stream | **Finding 1** — verified: pre-assigned UUID echoed on event #0, 16 events before `system/init` |
| AGNT-05 | Explicit permission mode + verbose streaming; never `--bare`, with a comment | **Finding 2** — verified: `dontAsk` alone silently produces nothing; `--allowedTools` is mandatory |
| AGNT-06 | Incremental stream parse tolerating partial lines and pre-init events | Pattern 3 (carry-buffer parser); event inventory in Finding 5 |
| AGNT-07 | Assert GSD skills present, fail loudly | **Finding 6** — `system/init.skills` is a flat `string[]`; exact assertion given |
| AGNT-08 | Per-run hard timeout kills whole process tree, worktree intact | **Finding 7** — verified: only `process.kill(-pid)` reaps the tree; SIGINT does **not** |
| AGNT-09 | Prompt instructs commit-only work; agent never pushes or opens a PR | Pattern 5 (prompt assembly); Anti-pattern 4 |
| AGNT-10 | Ticket text stripped of control and zero-width characters | Pattern 6 (`sanitizeUntrustedText`); Security Domain V5 |
| AGNT-11 | Worker secrets never in the spawned child's environment | **Finding 3** — env scrubbing must be an allowlist and must also strip `CLAUDE*` |
| QA-01 | Schema-constrained `needs_input` result carrying question + assumption | **Finding 4** — verified: `--json-schema` survives `--resume`; read `structured_output` |
| DELV-01 | Worker, not agent, pushes and opens the PR | Pattern 7 (delivery sequence) |
| DELV-02 | Draft by default, per-mapping toggle for ready | `gh pr create -d/--draft` verified present |
| DELV-03 | Templated PR body | Pattern 8 (body template, `--body-file`) |
| DELV-04 | Push refused when branch is the repo default branch | Pattern 7 precondition gate |
| DELV-08 | CI/workflow-touching diffs flagged prominently | Pattern 9 (path classifier) |
| DELV-09 | Diff scanned for secrets before push, push blocked on hit | Pattern 9 (secret scan) |

</phase_requirements>

---

## Summary

Every question CONTEXT.md flagged as "needs verification during planning" was answered by running the real binaries this session. Three answers change the plan, and one of them **invalidates a locked decision as written**.

The headline: **`--permission-mode dontAsk` on its own reproduces trap T1 exactly.** In a clean-environment probe, `dontAsk` denied the `Write` tool with `decision_reason_type: "mode"`, produced no file, and exited **0** with `is_error: false`, `subtype: "success"`, `terminal_reason: "completed"`. That is the precise silent-nothing signature D-01 was chosen to avoid. The identical prompt under `acceptEdits` wrote the file with zero denials. `dontAsk` **is** salvageable — adding `--allowedTools "Write" "Edit" "Bash"` produced zero denials and a real git commit — but it is only safe *with* an explicit allowlist. D-01 must be amended, not discarded: `dontAsk` + `--allowedTools`, never `dontAsk` alone.

Second: the child environment needs a stricter scrub than D-15 specifies. Running the same `acceptEdits` probe from *inside* a Claude Code session (inheriting `CLAUDECODE`, `CLAUDE_CODE_MESSAGING_SOCKET`, `CLAUDE_CODE_CHILD_SESSION`, and 19 more) flipped the result: `Write` was denied with `decision_reason_type: "asyncAgent"` — "this session has no approval surface". The same command with those variables stripped succeeded. If the operator ever launches this daemon from a terminal inside a Claude session, permission behaviour silently changes. The child env must be built by **allowlist**, not by deleting two known keys.

Third, the good news: the remaining CONTEXT.md unknowns all resolved in the design's favour. The pre-assigned `--session-id` is echoed on *every* event including event #0 (sixteen events before `system/init`), vindicating D-04 completely. `--json-schema` survives `--resume` — a resumed session returned a schema-valid object *and* correctly recalled the prior turn — so the entire D-16 Q&A design holds. And `system/init` carries `skills` as a flat `string[]` (116 entries on this machine), making D-05's assertion a one-line `includes()` check.

**Primary recommendation:** Build the agent invocation as a single `buildClaudeArgs()` function that always emits `--permission-mode dontAsk` **plus** `--allowedTools`, `--verbose`, `--output-format stream-json`, `--session-id`, and `--permission-prompts none`; assert `init.skills` contains the GSD commands; supervise with `detached: true` + `process.kill(-pid)` escalation; and treat `permission_denials.length > 0` on the result event as a first-class failure signal alongside the worktree-evidence verdict.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Worktree create / prune / remove | Worker process (`git` subprocess) | — | Filesystem + git plumbing; no other tier can hold the repo lock |
| Agent process supervision | Worker process (`execa` child) | OS process group | Kill semantics are an OS-group concern, not a library concern |
| `stream-json` parsing | Worker process (in-memory) | — | Pure transform over a byte stream |
| Permission policy | `claude` CLI flags | Operator `~/.claude/settings.json` | Ambient settings **do** participate (no `--bare`); flags must be explicit so behaviour is machine-independent |
| Code authorship | Spawned agent | — | The whole point of the phase |
| Commit creation | Spawned agent (in worktree) | — | Agent commits; worker never authors code |
| Branch push | **Worker** (`git` subprocess) | — | DELV-01 — delivery must not depend on agent memory |
| PR creation | **Worker** (`gh` subprocess) | GitHub API | `gh` inherits operator auth; no TTY available |
| Secret / CI-path diff scanning | Worker, pre-push | — | Must gate the push, so it cannot live downstream of it |
| Untrusted-text sanitization | Worker, pre-prompt | — | Trust boundary is prompt assembly, before the agent sees anything |
| Env sanitization | Worker, at spawn | — | Only the spawning tier can control child env |
| Run state persistence | Phase 1 `src/domain/` ports | SQLite (Phase 2) | Not this phase's tier — call the port |
| Linear/Slack reporting | **Phase 5** | — | Out of scope; Phase 4 ends at "a PR URL exists" |
| Scheduling / concurrency cap | **Phase 6** | — | Out of scope |

---

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `execa` | `10.0.1` | Spawning `claude`, `git`, `gh` | argv-array by default (no shell interpolation from Linear issue titles), `detached` support, promise-based. Already pinned in STACK.md. [VERIFIED: npm registry — 169M weekly downloads, no postinstall, `sindresorhus/execa`] |
| `node:child_process` | built-in | — | Not needed directly; `execa` wraps it. Do **not** mix the two APIs (see Finding 7). |
| `node:crypto` | built-in | `randomUUID()` for the pre-assigned session ID | D-04. Zero deps. [VERIFIED: used in probe] |
| `node:fs/promises` | built-in | PR body file, run-log paths, diff archiving | `gh --body-file` needs a real path |
| `claude` CLI | `2.1.259` | The agent | [VERIFIED: `claude --version` on this machine] |
| `gh` CLI | `2.98.0` (2026-08-20) | PR creation | [VERIFIED: `gh --version` on this machine] |
| `git` CLI | system | Worktrees, push, diff | Shelling out beats `simple-git` for worktrees (STACK.md) |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `pino` | `10.3.1` | Structured per-run logging | `log.child({ runId, sessionId })` per run. Phase 2 owns the logger; Phase 4 calls the port. |
| `zod` | `4.5.4` | Validating `structured_output` against `AgentResultSchema` | Phase 1 owns `agent-result.ts`; Phase 4 imports it |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `execa` | `node:child_process.spawn` | `spawn` returns a real `EventEmitter` with `.on("exit")`, which execa 10 does **not** expose (Finding 7). If the team prefers the Pitfall-5 sample code verbatim, `spawn` is the honest choice. `execa` still wins on argv safety and is already pinned — but the plan must not paste `.on("exit")` onto an execa handle. |
| Shelling to `git` | `simple-git` 3.36.0 | Rejected in STACK.md: thin worktree support, one more dep, less transparent |
| `gh pr create` | GitHub REST via `fetch` | `gh` inherits operator auth for free; REST would need a token the two-secrets rule forbids |
| `--json-schema` | Regex over prose | Explicitly rejected by D-16, and verified unnecessary — schema output works on resume |

**Installation:** No new dependencies. `execa@10.0.1` is already pinned in STACK.md and TRAPS.md records a verified clean install of the full pinned set.

**Version verification:**
```bash
npm view execa version   # -> 10.0.1  [VERIFIED this session]
claude --version         # -> 2.1.259 (Claude Code)  [VERIFIED this session]
gh --version             # -> gh version 2.98.0 (2026-08-20)  [VERIFIED this session]
```

---

## Package Legitimacy Audit

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| `execa` | npm | published 2026-07-31 | 169,105,266/wk | github.com/sindresorhus/execa | **OK** | Approved |

`postinstall`: `null` — no install-time script. `deprecated`: false.

**Packages removed due to [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none

Phase 4 adds **no new dependencies**. `execa` was already pinned by prior research; it is re-audited here only because this phase is its primary consumer. [VERIFIED: `gsd-tools query package-legitimacy check --ecosystem npm execa` → `OK`, plus `npm view execa version` → `10.0.1`]

---

## Architecture Patterns

### System Architecture Diagram

```
              Phase 6 (Scheduler) calls executeRun(runId, mapping, issue)
                                    │
                                    ▼
                      ┌──────────────────────────┐
                      │  1. WORKTREE PREPARE     │
                      │  per-repo async mutex    │
                      └──────────────────────────┘
                       fetch → resolve branchName → collision? suffix -2,-3
                       git worktree add <daemonDir>/worktrees/<repo>/<branch>
                       assert symbolic-ref HEAD succeeds (never detached)
                                    │
                       state: preparing ──► running
                                    ▼
        ┌───────────────────────────────────────────────────────┐
        │  2. PROMPT ASSEMBLY  (trust boundary — untrusted in)   │
        └───────────────────────────────────────────────────────┘
         issue.title + issue.description ──► sanitizeUntrustedText()
                       strip C0/C1 + zero-width  ──►  wrap in
                       <untrusted-ticket-data> … </untrusted-ticket-data>
                       + "never push, never open a PR" instruction
                                    │
                                    ▼
        ┌───────────────────────────────────────────────────────┐
        │  3. SPAWN   sessionId persisted to runs row FIRST      │
        └───────────────────────────────────────────────────────┘
         execa("claude", buildClaudeArgs(...), {
            cwd: worktreePath, detached: true,
            stdio: ["pipe","pipe","pipe"], env: buildChildEnv() })
                                    │
              ┌─────────────────────┼─────────────────────┐
              ▼                     ▼                     ▼
        stdout (drain)        stderr (drain)        timeout timer
        carry-buffer          → log.debug           SIGINT ─15s→
        line parser                                 SIGTERM ─10s→
              │                                     SIGKILL
              ▼                                     (all to -pid)
    ┌─────────────────────────────┐
    │ 4. EVENT ROUTER             │
    ├─────────────────────────────┤
    │ system/init      → ASSERT GSD skills present, else fail loudly
    │ system/task_summary        → progress heartbeat (.detail)
    │ system/post_turn_summary   → status_category / needs_action
    │ system/permission_denied   → count; a nonzero count is a red flag
    │ assistant / user           → tool-use trace to the run log
    │ result                     → structured_output, usage, total_cost_usd
    └─────────────────────────────┘
                                    │
                                    ▼
        ┌───────────────────────────────────────────────────────┐
        │  5. VERDICT  — evidence in the worktree, NOT exit code │
        └───────────────────────────────────────────────────────┘
          git log <base>..HEAD  +  git status --porcelain
          structured_output.status === "needs_input" ─► awaiting_answer
                                                        (Phase 6 owns)
          commits > 0 & completed  ─► delivered
          commits > 0 & truncated  ─► partial  (draft PR anyway)
          commits == 0             ─► failed   ("barren")
                                    │
                       state: running ──► delivering
                                    ▼
        ┌───────────────────────────────────────────────────────┐
        │  6. PRE-PUSH GATES  (any failure ⇒ no push, no PR)     │
        └───────────────────────────────────────────────────────┘
          branch !== defaultBranch ?  ──── no ──► REFUSE (DELV-04)
          secret regex over diff   ?  ──── hit ─► BLOCK  (DELV-09)
          CI/workflow paths touched?  ──── yes ─► FLAG   (DELV-08)
                                    │
                                    ▼
          git -C <wt> push -u <remote> refs/heads/<branch>   (never --force)
          gh pr create -R OWNER/REPO --base <default> --head <branch>
                       --title … --body-file … [--draft]
                                    │
                       PR URL parsed from STDOUT (no --json)
                                    ▼
        ┌───────────────────────────────────────────────────────┐
        │  7. CLEANUP                                            │
        └───────────────────────────────────────────────────────┘
          delivered ─► git worktree remove --force
          partial/failed ─► LEAVE worktree in place (AGNT-02)
                                    │
                                    ▼
                    return { prUrl, verdict, cost, usage }
                       ──► Phase 5 reports it
```

### Recommended Project Structure

```
src/execution/
├── worktree.ts          # AGNT-01/02/03: create, collision-suffix, boot reconcile, remove
├── agent-args.ts        # AGNT-05: buildClaudeArgs() — the ONE place flags are decided
├── agent-env.ts         # AGNT-11: buildChildEnv() — allowlist, not denylist
├── prompt.ts            # AGNT-09/10: sanitizeUntrustedText() + prompt assembly
├── stream-parser.ts     # AGNT-06: carry-buffer NDJSON parser (pure, trivially testable)
├── event-router.ts      # AGNT-07: init assertion, progress, denial tally, result capture
├── supervisor.ts        # AGNT-08: spawn, drain, escalating group kill, verdict
├── verdict.ts           # D-06: evidence-based classification
├── gates.ts             # DELV-04/08/09: default-branch, secret scan, CI-path flag
├── deliver.ts           # DELV-01/02/03: push then gh pr create, parse URL from stdout
└── pr-body.ts           # DELV-03: body template
```

Splitting `stream-parser.ts` and `verdict.ts` out as **pure functions** is what makes this phase testable at all under RUSH mode — they need no child process, no git, and no network.

### Pattern 1: Worktree lifecycle with collision suffixing

**What:** Create under a daemon-owned root, never `-B`, never `--detach`, assert the branch afterwards.
**When to use:** AGNT-01, AGNT-02, AGNT-03.

```ts
// Source: .planning/research/PITFALLS.md Pitfall 6 [CITED] + git-scm worktree docs
const root = `${daemonDir}/worktrees/${repoSlug}`;      // NEVER inside the operator's repo
let branch = issue.branchName;                          // Linear-provided; do not slugify
for (let n = 2; await branchExists(repoPath, branch); n++) branch = `${issue.branchName}-${n}`;

await execa("git", ["-C", repoPath, "worktree", "add", "-b", branch, `${root}/${branch}`, base]);
// assert we are NOT detached — a detached HEAD means the agent's commits land nowhere
await execa("git", ["-C", `${root}/${branch}`, "symbolic-ref", "-q", "HEAD"]);  // throws if detached

// cleanup, success only:
await execa("git", ["-C", repoPath, "worktree", "remove", "--force", `${root}/${branch}`]);
```

Boot reconcile (AGNT-03): `git worktree prune`, then `git worktree list --porcelain`, then cross-reference against non-terminal run rows. A worktree with no active run → `remove --force`. A run row pointing at a missing worktree → mark failed.

### Pattern 2: The single source of truth for agent flags

**What:** One function, one comment, no flag decided anywhere else.
**When to use:** AGNT-05. This is the module D-02 requires the `--bare` comment to live in.

```ts
// src/execution/agent-args.ts
export function buildClaudeArgs(o: {sessionId: string; prompt: string; schema: object}): string[] {
  return [
    "-p", o.prompt,
    "--output-format", "stream-json",
    "--verbose",                       // D-03: hard startup error without it, not a warning
    "--session-id", o.sessionId,       // D-04: pre-assigned; NEVER parsed from the stream
    "--permission-mode", "dontAsk",    // D-01
    // VERIFIED 2026-09-06 on CLI 2.1.259: `dontAsk` ALONE denies the Write tool
    // (decision_reason_type:"mode") and still exits 0 with is_error:false.
    // The allowlist below is what makes the mode usable. Do not remove it.
    "--allowedTools", "Write", "Edit", "Bash",
    "--permission-prompts", "none",    // nobody answers prompts; deny-and-continue
    "--json-schema", JSON.stringify(o.schema),  // D-16; survives --resume (verified)
    // --bare is FORBIDDEN. The vendor docs recommend it for scripted use and say it will
    // become the -p default. It skips ~/.claude auto-discovery, which is where this
    // operator's global GSD install lives — the entire product depends on it. Adding
    // --bare makes every run silently produce generic, non-GSD work and exit 0.
    // See TRAPS.md T2. Do not add it.
  ];
}
```

Resume variant (Phase 6 calls it, Phase 4 exports it): replace `-p <prompt>` with `--resume <sessionId>` **and drop `--session-id`** — reusing a spent session ID is a hard error (Finding 1).

### Pattern 3: Carry-buffer NDJSON parser

**What:** A pure generator over string chunks. No I/O, so it is unit-testable with no child process.
**When to use:** AGNT-06, D-08.

```ts
// src/execution/stream-parser.ts
export function makeLineParser(onEvent: (e: unknown) => void, onBad: (l: string) => void) {
  let carry = "";
  return {
    push(chunk: string) {
      carry += chunk;
      let nl: number;
      while ((nl = carry.indexOf("\n")) >= 0) {
        const line = carry.slice(0, nl); carry = carry.slice(nl + 1);
        if (!line.trim()) continue;
        try { onEvent(JSON.parse(line)); } catch { onBad(line); }
      }
    },
    flush() { if (carry.trim()) { try { onEvent(JSON.parse(carry)); } catch { onBad(carry); } } carry = ""; },
  };
}
```

Test it by pushing a known event split mid-token across two `push()` calls — that is the exact bug D-08 names, and it needs no `claude` binary to reproduce.

### Pattern 4: Env by allowlist

**What:** Build the child env from scratch. Do not delete keys from `process.env`.
**When to use:** AGNT-11, D-15 — **and Finding 3**.

```ts
// src/execution/agent-env.ts
const PASS = ["PATH","HOME","SHELL","LANG","LC_ALL","TERM","TMPDIR","USER","LOGNAME",
              "SSH_AUTH_SOCK",           // agent may need to talk to git remotes
              "XDG_CONFIG_HOME","XDG_CACHE_HOME"];

export function buildChildEnv(runId: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of PASS) if (process.env[k] !== undefined) env[k] = process.env[k];
  env.LAW_RUN_ID = runId;
  return env;
  // An allowlist — not `const {LINEAR_API_KEY, ...rest} = process.env` — because:
  //  (a) it withholds LINEAR_API_KEY / NGROK_AUTHTOKEN by construction (D-15), and
  //  (b) VERIFIED 2026-09-06: inheriting CLAUDECODE / CLAUDE_CODE_MESSAGING_SOCKET /
  //      CLAUDE_CODE_CHILD_SESSION (set when the daemon is launched from inside a Claude
  //      Code session) changes permission behaviour — acceptEdits denied Write with
  //      decision_reason_type:"asyncAgent" ("no approval surface"). The identical command
  //      with those stripped succeeded. A denylist cannot anticipate 22 such variables.
}
```

### Pattern 5: Prompt assembly across the trust boundary

**What:** Sanitize, delimit, and state the commit-only contract in one place.
**When to use:** AGNT-09, AGNT-10, D-14.

```ts
// src/execution/prompt.ts
export function sanitizeUntrustedText(s: string): string {
  return s
    .replace(/[ ---]/g, "") // C0/C1, keep \t \n \r
    .replace(/[​-‏‪-‮⁠-⁤⁪-⁯﻿]/g, "") // zero-width + bidi
    .replace(/[0-F]/gu, "");                                   // tag chars (invisible smuggling)
}
```

Both layers are required (D-14): stripping does not stop a plainly-worded override, and delimiting does not stop invisible-character smuggling.

The prompt must state the commit-only contract explicitly (AGNT-09), because the worker owns delivery (DELV-01):

> Commit your work in this worktree. **Do not** run `git push`. **Do not** open a pull request. The worker does both after you exit.

### Pattern 6: Escalating process-group kill

**What:** The only kill that reaps the agent's Bash subtree.
**When to use:** AGNT-08, D-09, D-10 — **corrected by Finding 7**.

```ts
// src/execution/supervisor.ts
const child = execa("claude", args, {
  cwd: worktreePath, detached: true, stdio: ["pipe","pipe","pipe"],
  reject: false,     // a signalled process must not throw; the verdict comes from the worktree
});
// detached:true makes the child a process-group LEADER (verified: pgid === pid),
// which is what makes the negative-pid form below legal.

const killGroup = (sig: NodeJS.Signals) => { try { process.kill(-child.pid!, sig); } catch {} };

const timer = setTimeout(async () => {
  killGroup("SIGINT");                      // keeps the session resumable (D-10)
  await sleep(15_000);
  if (stillAlive(child.pid!)) killGroup("SIGTERM");   // this is the one that reaps the tree
  await sleep(10_000);
  if (stillAlive(child.pid!)) killGroup("SIGKILL");
}, cfg.maxRunMs);
```

### Anti-Patterns to Avoid

- **`--permission-mode dontAsk` without `--allowedTools`.** Verified to deny `Write` and exit 0. This is trap T1 wearing a different hat.
- **`child.kill()` on an execa handle, even with `detached: true`.** Verified: kills the child, orphans the grandchild, and the promise **never settles** because the surviving grandchild holds the stdout pipe open.
- **`.on("exit", ...)` on an execa handle.** `execa()` returns a promise-like exposing `pid`, `kill`, `stdout`, `stderr`, `then`, `catch` — `on` is `undefined`. The Pitfall-5 sample code is `node:child_process`, not execa.
- **Gating on `stop_reason === "end_turn"`.** With `--json-schema` the stop reason is `"tool_use"` (verified twice). Any `end_turn` check is a bug.
- **`JSON.parse(result.result)`.** The result event already carries the parsed object as `structured_output`. Parsing the string duplicates work and adds a failure mode.
- **Reusing a session ID for a retry.** Verified hard error: `Session ID <uuid> is already in use.`, exit 1, empty stdout.
- **Treating exit 0 / `is_error: false` as success.** Every silent-failure probe in this session exited 0 with `is_error: false`, `subtype: "success"`, `terminal_reason: "completed"`.
- **`git worktree add -B`** — destroys the previous attempt's commits (D-11).
- **Deleting known-bad keys from `process.env`** instead of building an allowlist (Finding 3).

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Extracting the session ID | Stream scanner keyed on `system/init` | `--session-id <crypto.randomUUID()>` | Verified: 16 events precede `init` on this machine. D-04. |
| Getting structured intent out of the agent | Regex / magic-string over prose | `--json-schema` → `result.structured_output` | Verified working on both fresh and resumed runs. D-16. |
| Continuing a session | Prompt-stuffing prior context | `--resume <sessionId>` | Verified: works from any cwd, preserves session_id and memory |
| Killing the agent's subprocess tree | pid tracking + `pgrep` sweeps | `detached: true` + `process.kill(-pid, sig)` | Verified: group kill reaps the grandchild; nothing else does |
| Branch slug for the worktree | Slugifying the issue title | `Issue.branchName` from Linear | Linear's own branch/PR auto-linking depends on it |
| Getting the PR URL | Screen-scraping / `--json` | Read stdout of `gh pr create` | Verified: `gh pr create --json url` → `unknown flag: --json` (T13) |
| Shell-quoting ticket text into a command | Manual escaping | `execa("claude", argvArray)` | argv array, no shell — injection from an issue title is structurally impossible |
| Secret patterns in the diff | Full entropy analysis | Fixed high-signal regex set | DELV-09 is a guardrail against an agent committing a fixture, not a defence against an adversary |

**Key insight:** Four of the eight rows above are things the CLI already does correctly and that a naive implementation would rebuild badly. The verification work this session was mostly about confirming the built-in path exists — it does, in every case.

---

## Common Pitfalls

### Pitfall 1: `dontAsk` produces nothing, loudly reported as success

**What goes wrong:** The agent is denied `Write`; the run exits 0; the worktree is empty; the verdict logic says `barren`; the operator sees "failed" with no reason.
**Why it happens:** `dontAsk` denies anything not explicitly allowed. `--allowedTools` is what grants it.
**How to avoid:** Always pair the mode with `--allowedTools`. Additionally, treat a non-empty `result.permission_denials[]` as a distinct, reportable failure cause — it names the exact tool and input that was refused.
**Warning signs:** `permission_denials` non-empty; `system/permission_denied` events with `decision_reason_type: "mode"`; runs finishing in under a minute with no commits.

### Pitfall 2: Inherited Claude env changes permission behaviour

**What goes wrong:** The daemon works when launched from a plain shell and silently produces nothing when launched from a terminal inside a Claude Code session.
**Why it happens:** 22 `CLAUDE*` variables are inherited; `CLAUDE_CODE_MESSAGING_SOCKET` / `CLAUDE_CODE_CHILD_SESSION` make the child believe it has an async host, and denials come back as `asyncAgent`.
**How to avoid:** Allowlist the child env (Pattern 4).
**Warning signs:** `decision_reason_type: "asyncAgent"`; behaviour that differs between `npm start` from a terminal and from an editor.

### Pitfall 3: The supervisor promise never settles

**What goes wrong:** A timed-out run's `await` hangs forever even though the `claude` process is dead.
**Why it happens:** A surviving grandchild inherits and holds the stdout pipe open. Verified in three separate probes.
**How to avoid:** Escalate to SIGTERM/SIGKILL on the **group**; never rely on the promise alone as the completion signal — race it against the escalation timer.
**Warning signs:** Runs stuck in `running` with 0% CPU; `pgrep -f "claude -p"` showing more processes than active runs.

### Pitfall 4: SIGINT alone does not reap the tree

**What goes wrong:** D-10's SIGINT-first step kills `claude` but leaves its Bash subtree running, and the run looks reaped when it is not.
**Why it happens:** Verified — `process.kill(-pid, "SIGINT")` killed the group leader but the backgrounded grandchild survived and the promise stayed pending. `SIGTERM` to the same group killed both.
**How to avoid:** Keep D-10's escalation, but **verify liveness between steps** rather than assuming SIGINT sufficed. The escalation is mandatory, not a courtesy.
**Warning signs:** Orphan `node`/`claude` processes accumulating across a week.

### Pitfall 5: Piped Bash commands are decomposed per-part

**What goes wrong:** A command that looks allowed is denied because one segment of a pipe or `&&` chain is not.
**Why it happens:** Verified: `curl -s https://example.com | head -1` denied with `decision_reason_type: "subcommandResults"` and the message "The following part requires approval: curl -s https://example.com".
**How to avoid:** Grant tool-level `Bash` in `--allowedTools` rather than trying to enumerate command patterns; a GSD run issues commands you cannot predict.

### Pitfall 6: Worktree hazards

Stale admin files after a crash, branch collisions, `index.lock` contention on concurrent `fetch`, submodules, detached HEAD, and `git worktree remove` refusing a dirty tree. All six are catalogued with remedies in `.planning/research/PITFALLS.md` Pitfall 6 [CITED]; Pattern 1 above implements the fixes. The two that bite hardest here are the **detached-HEAD assertion** (without it the agent's commits land nowhere and the failure surfaces only at push time) and the **per-repo mutex** around `fetch`/branch creation, which is what makes success criterion 1 — two simultaneous runs against one repo — actually hold.

### Pitfall 7: `gh` has no TTY

**What goes wrong:** `gh pr create` prompts for where to push and hangs.
**Why it happens:** It prompts when the branch is not fully pushed.
**How to avoid:** The worker pushes first, explicitly, then calls `gh` with `-R`, `--base`, and `--head` all supplied. Make PR creation idempotent on retry via `gh pr list --head <branch>`.

---

## Code Examples

### Assert the GSD skills are present (D-05 / AGNT-07)

`system/init.skills` is a flat array of skill-name strings — 116 entries on this machine.

```ts
// Source: live `system/init` event, claude 2.1.259, this session [VERIFIED]
const REQUIRED_GSD = ["gsd-execute-phase", "gsd-plan-phase", "gsd-verify-work"] as const;

function assertGsdPresent(init: { skills?: string[]; permissionMode?: string; cwd?: string }) {
  const skills = init.skills ?? [];
  const missing = REQUIRED_GSD.filter(s => !skills.includes(s));
  if (missing.length) {
    throw new AgentEnvironmentError(
      `GSD skills absent from the spawned session: ${missing.join(", ")}. ` +
      `Session saw ${skills.length} skills. This usually means --bare was passed, ` +
      `or ~/.claude is not readable by the daemon user.`
    );
  }
  // free bonus assertion — init echoes the mode back, so T1 is detectable at init time
  if (init.permissionMode !== "dontAsk") {
    throw new AgentEnvironmentError(`permissionMode is ${init.permissionMode}, expected dontAsk`);
  }
}
```

Observed `system/init` keys, verbatim:
`type, subtype, cwd, session_id, tools, mcp_servers, model, permissionMode, slash_commands, terminal_slash_commands, apiKeySource, claude_code_version, output_style, agents, skills, plugins, capabilities, analytics_disabled, product_feedback_disabled, uuid, memory_paths, messaging_socket_path, fast_mode_state, fast_mode_disabled_reason`

`agents` and `slash_commands` are also flat `string[]` and carry the GSD entries too — `skills` is the right one to assert on because it is the mechanism GSD actually ships as.

### Capture cost and usage from the `result` event (04-CONTEXT terminal-comment requirement)

```ts
// Source: live `result` event, claude 2.1.259, this session [VERIFIED]
interface ResultEvent {
  type: "result";
  subtype: "success" | "error_max_turns" | string;
  is_error: boolean;
  session_id: string;
  result: string;                    // the assistant's final text, or the JSON *string* under --json-schema
  structured_output?: unknown;       // the PARSED object under --json-schema — use this one
  stop_reason: "end_turn" | "tool_use" | string;
  terminal_reason: string;           // e.g. "completed"
  num_turns: number;
  duration_ms: number;
  duration_api_ms: number;
  total_cost_usd: number;            // <-- the field the terminal comment reports
  permission_denials: Array<{ tool_name: string; tool_use_id: string; tool_input: unknown }>;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
    service_tier: string;
  };
  modelUsage: Record<string, {       // keyed by model id, e.g. "claude-sonnet-5"
    inputTokens: number; outputTokens: number;
    cacheReadInputTokens: number; cacheCreationInputTokens: number;
    costUSD: number; contextWindow: number; canonicalModel: string;
  }>;
  subagent_stats: { spawned: number; completed: number; failed: number; /* … */ };
}
```

Real values from a trivial one-turn probe:
`total_cost_usd: 0.246124`, `usage.cache_creation_input_tokens: 61520`, `usage.input_tokens: 2`, `usage.output_tokens: 4`, `num_turns: 1`, `duration_ms: 3178`, `permission_denials: []`.

Note the cost is dominated by **cache creation**, not by input/output tokens — a one-word reply cost $0.25 because the GSD system prompt is ~61 k tokens. The terminal comment should report `total_cost_usd` and `num_turns`; reporting raw `input_tokens` would be actively misleading.

### Full observed `stream-json` event inventory

From a run with tool use, in emission order:

```
system/hook_started      × 8   ← ALL of these precede system/init. This is D-04's proof.
system/hook_response     × 8   ← { hook_name:"SessionStart:startup", hook_event, outcome:"success", exit_code:0 }
system/init              × 1   ← the assertion target
assistant                × n   ← { message: { content: [{type:"text"|"tool_use", …}], usage, stop_reason }, … }
system/task_summary      × n   ← { detail: "Writing /path/to/probe.txt" }  ← PROGRESS
user                     × n   ← { message: { content: [{type:"tool_result", is_error, content}] } }
system/permission_denied × n   ← { tool_name, tool_use_id, decision_reason_type, message }
rate_limit_event         × n   ← { rate_limit_info }
system/post_turn_summary × 1   ← { status_category, status_detail, needs_action }  ← PROGRESS
result/success           × 1   ← terminal
```

**Every one of these events carries `session_id` and `uuid`** — including event #0.

For the progress reporting Phase 5 consumes, `system/task_summary.detail` is the human-readable current activity (`"Writing /path/probe.txt"`, sometimes `null`), and `system/post_turn_summary` is the richest single signal:

```json
{"type":"system","subtype":"post_turn_summary",
 "status_category":"blocked",
 "status_detail":"Write + Bash tools denied; cannot create probe.txt",
 "needs_action":"enable Write tool or reconfigure don't-ask mode"}
```

`status_category: "blocked"` is a directly usable machine signal that the run is going nowhere — worth surfacing even though Phase 5 owns the reporting.

### The `needs_input` hand-off (QA-01 / D-16)

Verified end to end. Schema passed as a JSON string to `--json-schema`:

```jsonc
{"type":"object",
 "properties":{
   "status":{"type":"string","enum":["delivered","needs_input"]},
   "question":{"type":"string"},
   "assumption":{"type":"string"},
   "summary":{"type":"string"}},
 "required":["status"],
 "additionalProperties":false}
```

Actual `structured_output` returned by the agent:

```json
{"status":"needs_input",
 "question":"Default timeout value? Ticket silent on it.",
 "assumption":"Without answer, assume default = current hardcoded timeout value (keep behavior same, just expose as config).",
 "summary":"Ticket lack default timeout value. Ask user before pick one."}
```

The same schema on a **resumed** session returned `{"status":"done","prior_word":"OK"}` — schema-valid *and* correctly recalling the prior turn, proving both that the schema survives `--resume` and that the resume genuinely continued the conversation.

### Delivery sequence (DELV-01…04, 08, 09)

```ts
// Source: gh 2.98.0 --help [VERIFIED] + PITFALLS.md Pitfall 12 [CITED]
if (branch === defaultBranch) throw new DeliveryRefused("refusing to push the default branch"); // DELV-04
const diff = await execa("git", ["-C", wt, "diff", `${base}..HEAD`]);
if (findSecrets(diff.stdout).length) throw new DeliveryBlocked("secret detected in diff");      // DELV-09
const ciTouched = touchesCiPaths(await changedFiles(wt, base));                                 // DELV-08

await execa("git", ["-C", wt, "push", "-u", remote, `refs/heads/${branch}`]);   // named ref, never --force
const { stdout } = await execa("gh", [
  "pr", "create", "-R", ownerRepo, "--base", defaultBranch, "--head", branch,
  "--title", title, "--body-file", bodyPath,
  ...(draft ? ["--draft"] : []),
]);
const prUrl = stdout.trim().split("\n").pop()!;   // gh has NO --json on create (T13, verified)
```

Verified `gh pr create` flags on 2.98.0: `-B/--base`, `-H/--head`, `-d/--draft`, `-R/--repo`, `--body-file`, `-r/--reviewer`. Verified absent: `--json` (`unknown flag: --json`).

Secret patterns for DELV-09 (from PITFALLS Pitfall 10 [CITED]): `ghp_`, `github_pat_`, `sk-ant-`, `sk-`, `AKIA`, `xoxb-`, `lin_api_`, `-----BEGIN [A-Z ]*PRIVATE KEY-----`.
CI paths for DELV-08: `.github/workflows/**`, `.github/actions/**`, `.gitlab-ci.yml`, `Jenkinsfile`, `.circleci/**`, plus `.claude/**` (a diff that edits the agent's own settings deserves the same prominence).

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Parse `session_id` out of `system/init` | Pre-assign `--session-id <uuid>` | `--session-id` present on 2.1.259 | Removes the entire race class (D-04) |
| `--resume` requires the original cwd | `--resume <id>` resolves from any directory | ≥ 2.1.223 per PITFALLS [CITED]; **verified from `/tmp`** this session | Q&A resume does not need the worktree to still exist at the same path |
| Regex a sentinel out of agent prose | `--json-schema` → `structured_output` | — | Makes D-16 a typed contract instead of a heuristic |
| `--permission-prompts` did not exist | `host` (default) \| `none` | ≥ 2.1.259 per PITFALLS [CITED] | Explicit deny-and-continue; see Finding 2 for the nuance |
| `LinearWebhooks` class | `LinearWebhookClient` (Phase 3, not this phase) | @linear/sdk v93 | T5 |

**Deprecated / outdated:**
- `--bare`: not deprecated — *actively recommended by vendor docs* and slated to become the `-p` default. It is nonetheless forbidden here (D-02, T2). This is the one place where following the upstream docs breaks the product, which is exactly why D-02 mandates a code comment.

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `["gsd-execute-phase","gsd-plan-phase","gsd-verify-work"]` is the right required-skill set to assert on | Code Examples | Too strict → false failures if GSD renames a command; too loose → a partial GSD install passes. Operator should confirm the list. All three were present in the live `init.skills` array. |
| A2 | `--allowedTools "Write" "Edit" "Bash"` is sufficient for a full GSD run | Pattern 2 | Verified sufficient for write + a 4-command git chain in a scratch repo. **Not** verified against a real GSD phase execution, which also uses Read, Glob, Grep, Task, TodoWrite and Skill. Under-granting reproduces Pitfall 1. |
| A3 | The 45–60 min default run timeout is appropriate | Pattern 6 | Inherited from PITFALLS, not measured. Too short truncates real work into `partial`. |
| A4 | Secret-regex set is adequate for DELV-09 | Delivery | It is a guardrail, not a security boundary — stated as such in PITFALLS. A miss means a credential reaches GitHub. |
| A5 | `SSH_AUTH_SOCK` should be in the env allowlist | Pattern 4 | If the agent never touches a remote it is unnecessary surface; if omitted and the repo uses SSH remotes, the agent's own `git fetch` fails. Worker-owned push is unaffected either way. |
| A6 | `execa`'s `reject: false` is the right posture for the agent spawn | Pattern 6 | If wrong, a signalled process throws and the evidence-based verdict never runs — which would be D-06 violated by accident. |

---

## Open Questions

1. **Is `--allowedTools "Write" "Edit" "Bash"` enough for a real GSD phase run?**
   - What we know: verified sufficient for `Write` + `Bash(git init && git add && git commit && git log)` under `dontAsk`, zero denials. Read-only Bash (`echo hi`) is permitted by `dontAsk` even with no allowlist at all — the operator's `~/.claude/settings.json` contains only 5 allow rules and none of them match `echo`, so this is Claude Code's own built-in safe-command classification, not ambient config.
   - What's unclear: whether Task/Skill/TodoWrite/Glob/Grep need explicit grants, and whether GSD's own subagent spawning is affected.
   - Recommendation: **plan a task that runs one real GSD invocation in a throwaway git repo and asserts `permission_denials` is empty.** This is the single highest-value verification remaining and it cannot be done by reading docs. Under RUSH mode it cannot be *run* as a plan gate — so write it as a test file plus a documented manual command, and flag it for the milestone integration gate.

2. **Should `--permission-prompts none` be passed at all?**
   - What we know: verified that on 2.1.259, with the default `host` and no SDK host present, nothing hangs — the CLI denies and completes (`decision_reason_type: "subcommandResults"` / `"mode"`). So `none` is **redundant today**.
   - What's unclear: whether an inherited `CLAUDE_CODE_MESSAGING_SOCKET` could reintroduce a real host (Pattern 4 strips it, which closes this), and whether a future version changes the default.
   - Recommendation: pass it anyway. It is free, it is explicit, and it documents intent. Answers D-01's "needs verification" item: the two flags are **orthogonal and coherent** — `--permission-mode` decides what needs approval, `--permission-prompts` decides who answers when something does. `dontAsk` denies at the mode layer before the prompt layer is reached, so the pairing is redundant-but-harmless rather than contradictory.

3. **Does the ~61 k-token cached system prompt make per-run cost dominate?**
   - What we know: a one-word reply cost $0.246, almost entirely `cache_creation_input_tokens: 61520`.
   - What's unclear: whether consecutive runs in the same worktree hit the cache (the resumed run showed `cache_read_input_tokens: 31178`, so partially yes).
   - Recommendation: report `total_cost_usd` in the terminal comment as CONTEXT requires, and do not attempt cost optimisation in this phase.

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| `claude` CLI | AGNT-04…08 | ✓ | 2.1.259 | — (hard requirement) |
| `gh` CLI | DELV-01, DELV-02 | ✓ | 2.98.0 (2026-08-20) | — (hard requirement) |
| `git` | AGNT-01…03, DELV | ✓ | system | — |
| Node.js | runtime | ✓ | v22.23.1 | Meets `execa@10`'s `>=22`; T15 notes STACK.md prefers 24 |
| `execa@10.0.1` | all spawn sites | ✓ (registry) | 10.0.1 | `node:child_process` |
| GSD global install | AGNT-07 | ✓ | 116 skills in `~/.claude`, incl. all `gsd-*` | — (the whole product depends on it) |
| Claude auth | agent runs | ✓ | OAuth/keychain (`apiKeySource: "none"`) | — ; note `--bare` would break this (D-02) |

**Missing dependencies with no fallback:** none.
**Missing dependencies with fallback:** none.

Caveat for the planner: `node_modules` does not exist on this branch (RUSH constraint 1), so `execa` is *available in the registry* but **not importable at execution time**. Write the imports; do not write a plan task that runs code importing them.

---

## Validation Architecture

`workflow.nyquist_validation` is `true`, so this section applies — **but RUSH.md constraint 4 forbids running anything.** Tests are written as files this phase and executed only at the milestone integration gate.

### Test Framework

| Property | Value |
|----------|-------|
| Framework | `node:test` (built-in) — Phase 1 D-12 |
| Config file | none (built-in runner) |
| Quick run command | `node --test test/execution/` — **do not run this phase** |
| Full suite command | `tsc --noEmit && node --test` — Phase 1 D-13 creates the script; milestone gate runs it |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| AGNT-04 | Session ID persisted before spawn | unit (fake store) | `node --test test/execution/agent-args.test.ts` | ❌ Wave 0 |
| AGNT-05 | Args always contain mode + verbose + allowlist; **never `--bare`** | unit (pure) | same | ❌ Wave 0 |
| AGNT-06 | Parser survives a JSON object split mid-token across chunks | unit (pure) | `node --test test/execution/stream-parser.test.ts` | ❌ Wave 0 |
| AGNT-06 | Events preceding `system/init` are not dropped | unit (pure) | same | ❌ Wave 0 |
| AGNT-07 | Missing GSD skill in `init.skills` throws | unit (pure) | `node --test test/execution/event-router.test.ts` | ❌ Wave 0 |
| AGNT-08 | Timeout escalates SIGINT→SIGTERM→SIGKILL against `-pid` | unit (fake clock + spy) | `node --test test/execution/supervisor.test.ts` | ❌ Wave 0 |
| AGNT-10 | Zero-width and C0/C1 chars stripped; delimiter present | unit (pure) | `node --test test/execution/prompt.test.ts` | ❌ Wave 0 |
| AGNT-11 | `LINEAR_API_KEY`, `NGROK_AUTHTOKEN`, `CLAUDE*` absent from child env | unit (pure) | `node --test test/execution/agent-env.test.ts` | ❌ Wave 0 |
| QA-01 | `structured_output.status === "needs_input"` parses to the domain type | unit (fixture) | `node --test test/execution/verdict.test.ts` | ❌ Wave 0 |
| D-06 | commits>0 → delivered; truncated → partial; none → failed — **regardless of exit code 0** | unit (pure) | same | ❌ Wave 0 |
| DELV-04 | Push refused when branch === defaultBranch | unit (pure gate) | `node --test test/execution/gates.test.ts` | ❌ Wave 0 |
| DELV-09 | Each secret pattern blocks the push | unit (pure) | same | ❌ Wave 0 |
| DELV-08 | `.github/workflows/**` in the diff sets the flag | unit (pure) | same | ❌ Wave 0 |
| AGNT-01/02/03 | Worktree collision suffixes; success removes, failure keeps | integration (real git, temp repo) | `node --test test/execution/worktree.test.ts` | ❌ Wave 0 — **milestone gate only** |

The three silent-failure modes CONTEXT.md's `<specifics>` demands a test for each map to a **pure** assertion on `buildClaudeArgs()` output — no child process needed:
- Manual mode (T1) → assert `args` contains `--permission-mode` **and** `--allowedTools`
- `--bare` (T2) → assert `args` does not include `--bare`
- missing `--verbose` (T3) → assert `--verbose` present whenever `--output-format stream-json` is

### Sampling Rate

- **Per task commit:** none — RUSH constraint 4. Commit with `git commit -n`.
- **Per wave merge:** none.
- **Phase gate:** none. The milestone integration gate runs `tsc --noEmit && node --test` once, at the end.

### Wave 0 Gaps

- [ ] `test/execution/` directory — does not exist
- [ ] All 9 test files listed above
- [ ] A fixture file of real `stream-json` events. **Capture it from the probe output in this session** rather than hand-writing it — hand-written fixtures encode the author's assumptions, which is exactly what these tests exist to catch.
- [ ] The `tsc --noEmit && node --test` npm script — **Phase 1 owns this**, do not create it here

---

## Security Domain

This phase is the highest-severity surface in the milestone: attacker-influenceable text (any workspace member can file a Linear issue) becomes instructions to an agent with shell and filesystem access on the operator's personal machine.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | Phase 4 mints no credentials; `gh`/`claude` inherit operator auth |
| V3 Session Management | no | No user sessions |
| V4 Access Control | **yes** | `--permission-mode` + `--allowedTools` are the agent's access-control surface; GitHub branch protection is the only server-side control |
| V5 Input Validation | **yes** | `sanitizeUntrustedText()` + explicit untrusted-data delimiter (D-14, both layers) |
| V6 Cryptography | no | None in this phase |
| V7 Error Handling & Logging | **yes** | Never post raw agent output or stack traces outward; redact at the log sink |
| V12 Files & Resources | **yes** | Worktrees under a daemon-owned root, never inside the operator's repo |
| V14 Configuration | **yes** | Child env by allowlist (Pattern 4); no secrets reachable from the worktree |

### Known Threat Patterns

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Prompt injection via ticket body | Tampering / EoP | Strip control + zero-width chars **and** delimit (D-14); withhold all worker secrets from the child |
| Argument injection via issue title | Tampering | `execa` argv array — no shell. Structurally prevented. |
| Agent reads `~/.aws/credentials`, other repos' `.env` | Info Disclosure | **Not fully mitigable** — `claude -p` runs with full user permissions and Bash can read anything the operator can. Accepted risk for a single-operator tool; must be stated in docs. The operator's global settings already deny `Read(.env)`, and those rules are inherited (no `--bare`). |
| Secrets committed by the agent and pushed | Info Disclosure | DELV-09 diff scan blocks the push |
| Agent force-pushes / touches the default branch | Tampering / DoS | DELV-04 hard precondition; never `--force`; push one named ref. GitHub branch protection is the control that actually holds. |
| Agent edits CI workflows | EoP | DELV-08 flags prominently; note `gh` push is separately rejected by GitHub without `workflow` token scope |
| Repo-supplied `.claude/settings.json` hooks execute unprompted | EoP | Documented and **unavoidable** here: `-p` shows no trust dialog and `--bare` (which would prevent it) is forbidden by D-02. Every mapped repo is implicitly fully trusted. Must be a stated, documented accepted risk. |
| Worker secrets leak into the child | Info Disclosure | Pattern 4 allowlist (D-15, extended by Finding 3) |

The `.claude/settings.json` row is the one genuinely unresolvable tension in this phase: D-02 forbids the flag that would mitigate it, for good reasons. The plan should surface it as documentation, not attempt a technical fix.

---

## Project Constraints (from CLAUDE.md)

The project `CLAUDE.md` is a technology-stack document. Directives binding on this phase:

- **ESM only** (`"type": "module"`) — use `node:` prefixed built-ins
- **`typescript@~5.9`** pinned — never `latest` (that is TS 7 `tsgo`)
- **`execa@10.0.1`** for spawning; **do not** add `simple-git`
- **`node:test`** as the test runner; not Vitest
- **`claude -p` must always pass an explicit `--permission-mode`** and `--verbose`; **`--bare` is forbidden**
- **`gh pr create` has no `--json`** — read the URL from stdout
- **Only two secrets** (`LINEAR_API_KEY`, `NGROK_AUTHTOKEN`) are ever prompted
- **`@anthropic-ai/claude-agent-sdk` is explicitly rejected** for this project — use the `claude -p` child process. Do not reach for the SDK when supervision gets awkward.
- **GSD workflow enforcement** — this phase's file changes happen under `/gsd-execute-phase`

Nothing researched above contradicts these. The one amendment proposed (adding `--allowedTools` to the invocation) *strengthens* the CLAUDE.md directive that an explicit permission mode must always be passed.

---

## Sources

### Primary (HIGH confidence — executed on this machine, 2026-09-06)

- `claude --version` → `2.1.259 (Claude Code)`
- `claude --help` → full flag surface: `--session-id <uuid>`, `--json-schema <schema>`, `--permission-mode` (6 choices), `--permission-prompts <host|none>` (default `host`), `--resume`, `--fork-session`, `--allowedTools`, `--include-partial-messages`, `--include-hook-events`
- **Probe 1** — `claude -p --output-format stream-json --verbose --session-id <uuid> --permission-mode dontAsk --permission-prompts none`: 21 events, pre-assigned UUID on all of them, `system/init` at index 16
- **Probe 2** — `claude --resume <uuid> -p --json-schema …`: schema honored on resume, prior turn recalled, same `session_id`, `structured_output` populated
- **Probe 3** — `dontAsk`, tool use, nested env: `Write` and writing-`Bash` denied (`reason: "mode"`), exit 0, `is_error: false`
- **Probe 4** — `acceptEdits` + `none`, nested env: `Write` denied (`reason: "asyncAgent"`)
- **Probe 5** — `acceptEdits` + `none`, **scrubbed env**: `Write` succeeded, zero denials
- **Probe 6** — `dontAsk` + `none`, **scrubbed env**: `Write` denied (`reason: "mode"`), no file, exit 0
- **Probe 7** — `dontAsk` + `--allowedTools "Write" "Edit" "Bash"`, scrubbed env: zero denials, file written, real git commit made
- **Probe 8** — `acceptEdits` + default `--permission-prompts host`, no host: **does not hang**; denies with `reason: "subcommandResults"`, completes in 9.5 s
- **Probe 9** — fresh run with `--json-schema` requiring `needs_input`: valid `structured_output` with question + assumption
- **Probe 10** — reusing a spent `--session-id`: exit 1, stderr `Session ID <uuid> is already in use.`
- **Probe 11** — `--resume` from `/tmp` (session created elsewhere): succeeds, memory intact
- **Probe 12** — `--resume <unknown-uuid>`: exit 1, stderr `No conversation found with session ID: <uuid>`
- **Probe 13** — `execa@10.0.1` process-group matrix (A–D): orphan/reap/promise-settlement behaviour
- `gh --version` → `2.98.0 (2026-08-20)`; `gh pr create --json url` → `unknown flag: --json`
- `npm view execa version` → `10.0.1`; `gsd-tools query package-legitimacy check` → `OK`
- `~/.claude/settings.json` → 5 allow rules (none matching `echo`), 3 deny rules (`Read(.env)`, `Read(.env.*)`, `Read(.secrets)`)

### Secondary (MEDIUM confidence — project research, verified against live tools where possible)

- `.planning/research/PITFALLS.md` Pitfalls 5, 6, 7, 9, 10, 12 — the design this phase implements
- `.planning/research/SUMMARY.md` — invariants and build-order constraints
- `.planning/TRAPS.md` T1, T2, T3, T4, T11, T13 — **T1, T3, T4 and T13 independently re-confirmed this session**
- `.planning/phases/01-…/01-CONTEXT.md` ADDENDUM — binding contract text

### Tertiary (LOW confidence — cited, not re-verified this session)

- Claude Code docs on SIGINT-vs-SIGTERM turn semantics, the 30 s output-drain cap, and the 10-minute background-wait ceiling (`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`) — via PITFALLS.md, not re-read from source
- `--resume` cwd-independence introduced in ≥ 2.1.223 — the *behaviour* is verified; the *version* it landed in is not

---

## Metadata

**Confidence breakdown:**

| Area | Level | Reason |
|------|-------|--------|
| CLI flag surface & semantics | **HIGH** | 13 live probes against the installed binary; every claim reproducible |
| `stream-json` event shape | **HIGH** | Captured from real runs; field names copied verbatim from output |
| Cost/usage field names | **HIGH** | Copied from a real `result` event |
| Process-group kill semantics | **HIGH** | Empirical matrix with a real grandchild process; all three variants observed |
| `gh` delivery surface | **HIGH** | `--help` + a live `unknown flag` error |
| Worktree hazards | **MEDIUM** | Inherited from PITFALLS.md; not re-verified this session (no mapped repo available) |
| Sufficiency of the `--allowedTools` set for a full GSD run | **MEDIUM** | Verified for write + git; not verified against a real GSD phase (Open Question 1) |
| Timeout defaults | **LOW** | Inherited, unmeasured (A3) |

**Research date:** 2026-09-06
**Valid until:** 2026-10-06 for the design; **2026-09-20 for the CLI flag findings** — `claude` ships frequently and `--permission-prompts` is recent enough to still be moving. Re-run Probes 6 and 7 after any `claude` upgrade; they are the two that gate whether the daemon produces work at all.
