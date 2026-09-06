# Phase 4: Execution - Context

**Gathered:** 2026-09-06
**Status:** Ready for planning

<domain>
## Phase Boundary

A ticket's work happens in an isolated worktree, under a supervised agent process, and
ships as a pull request **the worker opened** — never the agent. 18 requirements, the
largest phase.

Out of scope: deciding *when* to run (Phase 6) and reporting the result to Linear/Slack
(Phase 5). Execution ends at "a PR exists and its URL is returned".
</domain>

<decisions>
## Implementation Decisions

### Agent invocation

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

### Judging success

- **D-06:** Success is judged by **evidence in the worktree, never by exit code**.
  `claude -p` exits 0 having been denied every edit, and that is the single most likely
  failure mode for this project. Classify: commits/diff present → `delivered`; some work
  but incomplete → `partial` (still ships a **draft PR**); nothing → `barren`, which maps
  to the `failed` state.

### Process supervision

- **D-07:** Drain **both** stdout and stderr. Undrained stdout deadlocks at ~64 KB, which
  a real run reaches within its first minute.
- **D-08:** Line-buffer the `stream-json` parse with a carry for partial lines. A naive
  `split("\\n").map(JSON.parse)` breaks on chunk boundaries.
- **D-09:** Spawn `detached: true` and kill via `process.kill(-pid)` on the process
  group. A plain `child.kill()` orphans the agent's own Bash subprocesses.
- **D-10:** Escalate **SIGINT → SIGTERM → SIGKILL**. SIGINT first keeps the session
  resumable, so an overrun run can be continued rather than only killed. A timed-out run
  leaves its worktree intact.

### Worktree

- **D-11:** One worktree per run, using Linear's suggested `branchName`. **Never `git
  worktree add -B`** — it destroys the previous attempt's commits. Suffix a colliding
  branch name instead. Successful run cleans up; failed run leaves the worktree in place
  for the operator; a worktree orphaned by a crash is pruned at next boot.

### Delivery

- **D-12:** The **worker** pushes and opens the PR, never the agent — delivery must not
  depend on the agent remembering a final step. Push explicitly before invoking `gh`
  (which has no TTY). Always pass `--base` and `-R OWNER/REPO`. `gh pr create` has **no
  `--json` flag**; read the URL from stdout.
- **D-13:** Push is refused outright on the default branch, blocked on a secret detected
  in the diff, and never uses `--force`. A diff touching CI or workflow files is flagged
  prominently in both the PR body and the terminal comment.

### Security

- **D-14:** Untrusted ticket text gets **both** layers: strip control and zero-width
  characters, **and** wrap the body in an explicit untrusted-data delimiter. Neither alone
  suffices — stripping does not stop a plainly-worded "ignore previous instructions", and
  delimiting does not stop invisible-character smuggling.
- **D-15:** Sanitize the child environment. The agent has no business calling Linear —
  withhold `LINEAR_API_KEY` and `NGROK_AUTHTOKEN` from the spawned process entirely.

### Q&A hand-off

- **D-16:** The agent ends its turn with a schema-constrained result (`--json-schema`)
  declaring `needs_input`, carrying **both** the question and the assumption it would
  otherwise make. Never regex a magic string out of prose.

### Needs verification during planning
`--session-id` alongside `-p`; whether `--json-schema` survives `--resume`; the exact
`stream-json` event shape for progress and `total_cost_usd`.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Binding contract (read first)
- `.planning/phases/01-domain-contract-state-machine-schema/01-CONTEXT.md` — **binding**.
  Its ADDENDUM fixes the exact state literals, table names, config shape and module paths.
  All eight phases were fanned out simultaneously under rush mode, so this text — not the
  code, which may not exist on your branch yet — is the contract. Import from
  `src/domain/`; do not define your own copy of anything it names. If you need a port
  method that does not exist, record it in your SUMMARY under `Contract additions
  requested` rather than editing `src/domain/`.
- `.planning/TRAPS.md` — running ledger of verified footguns. Read every row.

### Project
- `.planning/PROJECT.md` — Key Decisions table and Constraints
- `.planning/REQUIREMENTS.md` — this phase's mapped requirement IDs
- `.planning/ROADMAP.md` — this phase's goal and success criteria

### Research
- `.planning/research/SUMMARY.md` — § Corrections to PROJECT.md, § Non-Negotiable
  Invariants, § Build Order Constraints
- `.planning/research/PITFALLS.md` — the failure modes this phase must avoid
- `.planning/research/STACK.md` — pinned versions and library idioms
- `.planning/research/ARCHITECTURE.md` — five-layer decomposition

</canonical_refs>

<code_context>
## Existing Code Insights

Greenfield. All eight phases are being built simultaneously in isolated worktrees under
rush mode, so no sibling phase's code is on your branch and none of it can be imported.
Build against the binding contract text in `01-CONTEXT.md` and against the in-memory
fakes it specifies. Do not attempt to read or import another phase's files.

</code_context>

<specifics>
## Specific Ideas

Research is emphatic that all three `claude -p` misconfigurations (Manual mode, `--bare`,
missing permission-prompt target) fail **quietly with exit 0**. Every one needs a test
that would catch it.

</specifics>

<deferred>
## Deferred Ideas

None — phase scope is already the largest in the milestone.

</deferred>

---

*Phase: 4-Execution*
*Context gathered: 2026-09-06*
