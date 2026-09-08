---
task: "`law watch` and `law say` — live run observability and mid-flight interaction"
id: 260907-voh
type: quick
severity: P2
created: 2026-09-07
files_modified:
  - src/execution/run-log.ts            # new
  - src/execution/run-log.test.ts       # new
  - src/execution/inject.ts             # new
  - src/execution/inject.test.ts        # new
  - src/execution/agent-args.ts
  - src/execution/agent-args.test.ts
  - src/execution/event-router.ts
  - src/execution/event-router.test.ts
  - src/execution/supervisor.ts
  - src/execution/supervisor.test.ts
  - src/cli/resolve-run.ts              # new
  - src/cli/resolve-run.test.ts         # new
  - src/cli/watch.ts                    # new
  - src/cli/watch.test.ts               # new
  - src/cli/say.ts                      # new
  - src/cli/adapters.ts
  - src/cli/adapters.inject.test.ts     # new
  - src/cli/usage.test.ts
  - src/cli/status.ts
  - src/cli/index.ts
  - src/cli/daemon.ts
  - scripts/boot-smoke.ts
  - scripts/probe-stream-input.ts       # new
  - scripts/probe-gsd-allowlist.ts
  - .planning/TRAPS.md
  - docs/TRAPS.md
  - docs/agent-invocation.md
  - README.md
gate: npm run verify   # 598/598 + boot smoke green before; must stay green after
---

<objective>
Two new commands so a spawned agent run stops being a black box between pickup and PR:

- `law watch [target]` — follow a run's activity live off a durable per-run event log, and
  read it back after the run ends.
- `law say <target> <text…>` — speak to a running agent mid-flight, over a filesystem-gated
  local socket that the public ngrok tunnel cannot reach.

Both run as SEPARATE processes from the daemon, like `law status`.

`law say` requires the spawn to switch from `-p "<prompt>"` to `--input-format stream-json`
with the prompt written on stdin. That switch is the risky half of this task and it changes
the shape of a `claude` session; the terminal condition it implies is made explicit and
defended by a falsifiable test.
</objective>

<measured_facts>
Everything below was measured on **CLI 2.1.263** during planning on 2026-09-07, with three
live probe runs against the real binary. Nothing here is recalled or inferred. Task 2 ships
`scripts/probe-stream-input.ts` so every one of these is re-runnable on demand.

**M1 — `--remote-control` is a no-op for `-p`. Do not use it.**
`--remote-control <name>` "starts an INTERACTIVE session". Passed alongside `-p
--output-format stream-json --verbose` it exits 0 and does nothing observable: no `remote`
substring in the stream, no remote-control key in `system/init`, no state under
`~/.claude`, no session registered at account level. Trap T1's shape exactly — accepts the
flag, exits 0, does nothing.

**M2 — under `--input-format stream-json`, `-p "<prompt>"` is SILENTLY IGNORED and the
session hangs forever.**
Measured: `claude -p 'Reply APPLE' --input-format stream-json --output-format stream-json
--verbose --permission-mode dontAsk --max-turns 4`, stdin held open, nothing written. Eight
`system/hook_started` and eight `system/hook_response` events arrived in the first 0.7s and
then **nothing for 90 seconds** — no `system/init`, no assistant, no result — until it was
SIGKILLed. The prompt was discarded. This is the single most dangerous fact in this task:
get the stdin write wrong and every run burns its full 45-minute `maxRunMs` producing
absolutely nothing, with a healthy-looking log.

**M3 — the prompt must be sent on stdin; bare `-p` (no value) is how the flag is kept.**
`--input-format` only works with `--print`, so `-p` must still be passed — with no value,
and as the LAST argv element (that is the ordering that was measured working; do not let an
option follow it and get eaten as its optional value). One NDJSON line per message:
`{"type":"user","message":{"role":"user","content":[{"type":"text","text":"…"}]}}`

**M4 — one `result` per USER MESSAGE, not per internal turn.**
Three messages produced three `result` events with `num_turns` 3, 2, 2 — the tool-using
turns inside one message do NOT each emit a result. A run that sends exactly one message
(today's every run) therefore still gets exactly one `result`, and today's terminal
semantics survive unchanged.

**M5 — `--max-turns` is PER MESSAGE, not per session.** `--max-turns 4` with three messages
consuming 3 + 2 + 2 = 7 turns did not error. An injected message gets a fresh turn budget.

**M6 — `total_cost_usd` is CUMULATIVE for the session; `usage` is PER MESSAGE.**
Measured across three results in one session: cost `0.5398 → 0.5693 → 0.5991` (monotonic,
small deltas) while `input_tokens` went `4 → 2 → 2` and `cache_read_input_tokens` climbed
`51165 → 51211 → 51394`. So the LAST result's `total_cost_usd` is the session total and must
never be summed across results (that is T95 pointed the other way), while `usage` MUST be
summed across results or a session the operator talked to under-reports its tokens.

**M7 — injection works BETWEEN turns, not only during one.** A message written to stdin
after `result` #1 was accepted and answered. The session stays alive on an open stdin.

**M8 — stdin EOF is what ends the session.** `stdin.end()` after the last result → clean
`exit code 0` within 0.6s. Nothing else terminated it in 90 seconds of probe A.

**M9 — a SECOND `system/init` is emitted for every subsequent user message**, carrying the
same `session_id`, `permissionMode` and 116 skills. `assertSessionUsable` therefore runs
once per message. Harmless (the values are identical), but any code assuming one init per
session is wrong.

**M10 — `--session-id` and `--json-schema` both survive streaming input.** The requested
uuid was echoed on all three inits and all three results. Every result carried its own
`structured_output` conforming to the schema, so the LAST result's `structured_output` is
the one that governs the verdict — which is the correct outcome when the operator has
injected a course correction.

**M11 — `--replay-user-messages` echoes each stdin message back as a `user` event** with the
exact content that was written, immediately before the assistant's reply. `event-router.ts`
already ignores `user` events, so this costs nothing there — and it is what puts the
operator's own words into the run log, so `law watch` shows what was said rather than only
the agent's unexplained change of direction.
</measured_facts>

<design>
## The terminal condition, stated explicitly (this is the trap)

`result` is **not** the terminal event and must never become one. The run ends when the
CHILD PROCESS EXITS — which is already how `supervisor.ts` works (`Promise.race([completed,
reaped])`, with `routed.result` read only after the stream is exhausted). Nothing in the
current code reacts to a `result` mid-stream, and nothing added here may.

What the daemon owns instead is **when stdin closes**:

> On the FIRST `result` event, close the child's stdin.

That single rule is the whole terminal design, and it is why today's semantics survive:

- Today's run sends one message and gets one `result` (M4). stdin closes, the child hits
  EOF (M8), exits, `runAgent` returns. Identical to today.
- The injection window is spawn → first `result`, i.e. the entire time the agent is
  working. That is exactly the window the operator asked for.
- A message written before the close is delivered: pipe bytes precede EOF, so the child
  reads the message, does another turn, emits `result` #2, then exits at EOF. `routed.result`
  is last-wins, so the operator's correction governs the verdict (M10). Correct by
  construction, no queue, no timer, no grace period.
- A `law say` that loses the race prints one clear line and changes nothing.

The falsification for this is mandatory and specified in Task 2: a scripted stream emitting
`result`#1 → assistant → `result`#2 must return **`result`#2**. Make `result` terminal and
that test goes red at `'turn one'`.

## Unconditional streaming input — and why, against the trap

Rejected: a per-run opt-in. The operator decides to talk to a run *after* it starts; there
is nothing to declare in advance.

Rejected: a global config toggle or `LAW_*` env kill switch defaulting off. It ships the
feature off, and worse it creates a SECOND spawn shape that only ever runs on the day the
operator first needs it — the untested-path failure this repo has now filed nine times
(T72/T73/T92/T96/T99/T101/T102/T107/T108). A path exercised on every run fails loudly on
day one; a path behind a flag fails quietly on the worst day.

Rollback, if it is ever needed, is `git revert` of Task 2's commit. This is a
single-operator daemon on `main`.

The residual risk from M2 is real and is bought down by three things, not by a flag:
1. the prompt write happens synchronously immediately after spawn, before any await;
2. `--replay-user-messages` means a delivered prompt is provable — the router tallies user
   echoes, and a run that ends with no result AND no echo reports "the agent never
   acknowledged the prompt (stdin delivery failed)" instead of a mystery;
3. `scripts/probe-stream-input.ts` re-measures the whole contract against the real binary.

## `law say` coexists with the Linear Q&A path; it does not replace it

They are disjoint **in time, by construction** — not by convention:

| | existing Q&A (`questionsEnabled`, `maxQuestionRounds: 3`) | `law say` |
|---|---|---|
| initiated by | the AGENT returning `needs_input` | the OPERATOR, unprompted |
| channel | Linear comment → correlate → exit-and-`--resume` | local Unix socket → child stdin |
| durable | yes, a `questions` row with a deadline, survives restart | no, ephemeral |
| when it is possible | only AFTER the agent's turn ended | only BEFORE the agent's turn ends |

An agent question IS a `result` event with `status: needs_input`. stdin closes on that
result, so by the time a question exists `law say` already refuses. Conversely, while `law
say` is possible there is no open question to answer. Neither channel can be used for the
other's job, and neither consumes the other's budget: `law say` never touches
`questionRound` and never parks the run.

`law say` against a run in `awaiting_answer` therefore prints the actionable redirect:
`run is parked awaiting an answer — reply to the bot's comment on LAW-123 in Linear`.

## The run log

`~/.linear-auto-worker/runs/<runId>.jsonl` — every parsed stream event, one JSON object per
line, appended as it arrives. Written from `runAgent`'s existing parser tap, BEFORE
`router.route(event)`, so a session the router rejects still leaves its `system/init` in the
log — which is precisely the run whose evidence an operator needs.

The daemon dir is derived the way `adapters.ts` already derives it
(`path.dirname(config.worktreeRoot)`); no new config field.

**Size** (a 45-minute GSD run emits a lot): a per-run byte cap of 64 MiB, after which one
`{"type":"law.truncated"}` line is written and appending stops. The stream parser's existing
8 MiB `CARRY_CEILING_BYTES` already bounds a single line.

**Cleanup**: at boot, beside the existing stale-worktree collection, delete `runs/*.jsonl`
older than 7 days. Never fatal.

## Reuse, not new machinery

- `law watch` parses the log with the existing `makeLineParser` — it already handles a read
  that lands mid-line, which is the entire difficulty of tailing an appending file.
- `status.ts`'s local `ACTIVE` array MOVES to `resolve-run.ts` and is imported back. A third
  copy of the non-terminal state list is not created.
- The stdin wire envelope (`userMessageLine`) is defined ONCE, in `agent-args.ts` — the
  module whose header already claims to be the single source of truth for everything on the
  `claude` wire — and imported by both `supervisor.ts` and `inject.ts`.
- `usageTokens` MOVES from `adapters.ts` into `event-router.ts` so the per-message tally has
  one implementation, not two.
</design>

<threat_model>
`security_enforcement` applies: the daemon publishes an HTTP receiver to the internet
through the ngrok tunnel, and the agent it spawns runs `--permission-mode dontAsk` with
`Write`/`Edit`/`Bash` inside the operator's real clones — which now include private client
repositories (`dzfweb/miracle-shop`, `lgabrielneves/kardun`).

| Threat ID | Category | Component | Severity | Disposition | Mitigation |
|---|---|---|---|---|---|
| T-VOH-01 | Tampering / Elevation | the `law say` injection channel | **critical** | mitigate | **NO HTTP route may be added to `src/ingress/receiver.ts` or anything the tunnel fronts.** A Unix domain socket at `<root>/say.sock`, chmod 0600, inside a 0700 directory. An injection endpoint on the public tunnel is unauthenticated arbitrary prompt injection into an agent with write access to private repos. Verified by a grep gate over `receiver.ts` and a test asserting the socket's mode. |
| T-VOH-02 | Information disclosure | `runs/<runId>.jsonl` | high | mitigate | The log holds raw agent output — anything the agent read, including a `.env` it happened to `cat`. It bypasses pino's `SecretScrubbingStream` by design (a redacted trace is not a trace). Controls: file 0600 in a 0700 dir, never transmitted anywhere, age-pruned. It must NEVER be attached to a PR body, a Linear comment, or a Slack message; `law watch` prints to the operator's own terminal only. |
| T-VOH-03 | Denial of service | run log growth | medium | mitigate | 64 MiB per-run cap + 7-day boot prune. |
| T-VOH-04 | Tampering | the say payload | medium | mitigate | 8 KiB cap, rejected above it. The text crosses into the child as a JSON string inside an NDJSON envelope — never argv, never a shell, so there is no quoting boundary to break. One line, one reply, connection closed. |
| T-VOH-05 | Spoofing | a stale `say.sock` from a crashed daemon | low | mitigate | Before listening: connect-probe the path. ECONNREFUSED → unlink and listen. A successful connect → another daemon owns this root; refuse to boot with that diagnosis rather than stealing the socket. |
| T-VOH-06 | Tampering | injected text is NOT sanitized | low | accept | Deliberate, and the opposite of `sanitizeUntrustedText`/`UNTRUSTED_OPEN` on ticket text (T99). Ticket text is attacker-controlled; `law say` text comes from the operator at a 0600 socket on their own machine — the same trust level as the config file. Wrapping the operator's own instruction in `<untrusted-ticket-data>` would make it inert, which is the whole point of the feature. State this in the code comment so it is not "fixed" later. |
</threat_model>

<constraints>
- `npm run verify` is the gate: currently **598/598 plus the boot smoke**. Green before,
  green after.
- The gate must never spawn a real `claude` (`scripts/boot-smoke.ts:317` overrides `agent`
  precisely to prevent it). Every in-suite check scripts the spawn; the real binary is
  exercised only by the human-run `scripts/`.
- Never `mock.method` (T88).
- Tests colocated in `src/` as `*.test.ts`, compiled to `dist/`, run by `node --test`.
- `erasableSyntaxOnly` is on: no enums, no namespaces, no constructor parameter properties.
- Falsify every new check (T71/T76): break it deliberately, observe RED, then trust it. A
  check that has never failed is not known to work.
- **`scripts/` is NOT in `tsconfig.json`'s `include`.** A signature change there is a silent
  break — the compiler will not catch it. `scripts/probe-gsd-allowlist.ts:92` calls
  `buildClaudeArgs({sessionId, prompt, schema})` and must be updated by hand.
- Do not duplicate `assistant`/`user` routing into `event-router.ts`. Its header
  (`event-router.ts:9-12`) says a run-log consumer should read them "straight off the
  parser's `onEvent`", and that is exactly what Task 1 does. Obey it.
- `supervisor.ts:17-32`'s `AgentSubprocess` is deliberately narrow — `kill` is omitted so
  calling it is a compile error (T29). Adding `stdin` is required by this task; adding
  anything else is not.
- Stay on `main`. `commit_docs` is true, so this PLAN.md ships with commit 1.
</constraints>

<tasks>

<task type="tracer">
  <name>Task 1: The run log, and `law watch` reading it end to end</name>
  <files>src/execution/run-log.ts, src/execution/run-log.test.ts, src/execution/supervisor.ts, src/cli/adapters.ts, src/cli/resolve-run.ts, src/cli/resolve-run.test.ts, src/cli/watch.ts, src/cli/watch.test.ts, src/cli/status.ts, src/cli/index.ts, src/cli/daemon.ts</files>
  <read_first>
    `src/execution/supervisor.ts:243-263` — `runAgent`'s head: the parser is built at :252
    with `(event) => router.route(event)`, the child spawns at :260, `o.onSpawn?.(child.pid)`
    at :263 fires "before the first await below". That comment names the exact placement
    rule this task follows for its own hooks.

    `src/execution/stream-parser.ts:24-68` — `makeLineParser(onEvent, onBad)`. Reused
    verbatim by `law watch` to tail an appending file; `push()` already carries a partial
    line across reads, which is the whole difficulty of following a file.

    `src/cli/status.ts:1-30` and `:97-153` — the precedent for a subcommand reading state in
    its OWN process: `defaultRoot()`, `existsSync(store.db)` → exit 1 with an actionable
    line, `openStore` (migrates on open — the header explains why that is safe from here),
    injected `print`/`now` so tests do not write to the shared stdout of a `node --test`
    child. `ACTIVE` at :22 is the array this task MOVES.

    `src/cli/adapters.ts:79-92` — `daemonDirOf(config) = path.dirname(config.worktreeRoot)`,
    the established derivation of the daemon dir, and `createWorktreeManager`'s deps shape.
    `:411-419` — `createAgentRunner`, where the per-run sink is opened.

    `src/cli/daemon.ts:539-549` — where the adapters are constructed and `onProgress` is
    wired. `:592-604` — the stale-worktree collection, `AFTER` the recovery sweep, wrapped in
    a `.catch` that logs and continues; the prune added here follows that same never-fatal
    shape and sits beside it.

    `src/cli/index.ts:7-27` (USAGE) and `:54-85` (dispatch). Note `parseArgs` THROWS on an
    unknown option (T88) — the try/catch at :36-52 is why `law --help` does not stack-trace.

    `src/infra/store/sqlite-store.ts:19-52` — `RunRow`: `id`, `issueKey`, `issueTitle`,
    `state`, `updatedAt` are the fields target resolution and the watch footer read.
  </read_first>
  <action>
    **`src/execution/run-log.ts`** (new). Three exports, no class, no state beyond the open
    stream:

    - `runLogDir(root)` → `<root>/runs`; `runLogPath(root, runId)` → `<dir>/<runId>.jsonl`.
    - `openRunLog(root, runId)` → `{ write(event: unknown): void; close(): void }`.
      `mkdirSync(dir, {recursive: true})` then `chmodSync(dir, 0o700)` — chmod separately
      because mkdir's mode is masked by umask and because the directory may already exist
      with looser permissions. `createWriteStream(file, {flags: 'a', mode: 0o600})`. `write`
      serialises with `JSON.stringify(event)` plus a newline and counts bytes; past
      `MAX_RUN_LOG_BYTES` (64 MiB, exported) it writes one
      `{"type":"law.truncated","bytes":<n>}` line and becomes a no-op — idempotent, so the
      marker is written exactly once. `write` must never throw: a failed sink is a lost
      trace, not a lost run. Wrap the stream in an `error` listener that disables the sink.
    - `pruneRunLogs(root, ttlMs, now)` → the list of deleted filenames. Only files matching
      `*.jsonl` whose `mtimeMs` is older than `now - ttlMs`. A missing directory is an empty
      list, not an error. Export `RUN_LOG_TTL_MS = 7 * 24 * 60 * 60 * 1000`.

    **`src/execution/supervisor.ts`.** Add ONE optional field to `RunAgentInput`:
    `onEvent?: (event: unknown) => void`. Call it from the parser callback BEFORE
    `router.route(event)` — stated in a comment as load-bearing, because `route` throws on a
    rejected session (`assertSessionUsable`) and the rejected session is exactly the one
    whose `system/init` the operator needs to see. Also feed the `onBad` path a
    `{type:'law.badline', line}` record through the same hook, so an unparseable line is
    visible in `law watch` and not only in pino.

    **`src/cli/adapters.ts`.** In `createAgentRunner.run`, open the run log against
    `daemonDirOf(deps.config)` and `req.runId` before `runAgent`, pass
    `onEvent: (e) => runLog.write(e)`, and `close()` it in a `finally` so a throwing run
    still flushes. This is the wiring the T109 falsification in the `<verify>` block targets.

    **`src/cli/resolve-run.ts`** (new). Owns the shared target resolution for both new
    commands, and now owns `ACTIVE`:

    - `export const ACTIVE = [...]` — moved verbatim from `status.ts:22` WITH its comment;
      delete it there and import it. Do not leave two copies.
    - `resolveRunTarget(store, target?: string): { run: RunRow } | { error: string }`.
      No target → the ACTIVE runs; exactly one → that run; none → `no active run — try
      \`law status\``; several → an error listing each candidate as `<issueKey or id8>
      <repoSlug> <state>` so the next command can be typed straight off it.
      With a target → match, in order: exact `id`; case-insensitive exact `issueKey`; `id`
      prefix of 4+ characters. Search ACTIVE first, then terminal runs, so a live run always
      wins over a finished one sharing a ticket. Several matches → the same listing error.
      Never guess, never pick "the newest" — `questions.ts:88-91` records what recency-based
      matching costs the day two runs share a ticket.

    **`src/cli/watch.ts`** (new). Two exports; the rendering is pure so the tests are pure.

    - `renderEvent(event: unknown): string | null` — `null` means "not worth a line".
      `system/init` → `session <id8> · <n> skills · <mode>`. `assistant` → one line per
      content block: `text` → the text; `tool_use` → `⚙ <name> <a one-line digest of the
      input>`. `user` → a `tool_result` block renders `↳ <first line>`, a plain `text` block
      renders `» <text>` (that is a replayed `law say`, i.e. the operator's own words — M11).
      `system/task_summary` and `system/post_turn_summary` → `· <detail>`.
      `system/permission_denied` → `✗ denied <tool_name>`. `result` → `── result <subtype>
      turns=<n> $<total_cost_usd>`. `law.truncated` / `law.badline` → their own line.
      Everything else → `null`. Collapse whitespace and truncate to a `MAX_LINE` constant,
      the way `status.ts:51-57` truncates its label.
    - `runWatch(deps: { root?, target?, print?, now?, pollMs? }): Promise<number>`.
      Resolve the target through the store (open it exactly as `status.ts:102-111` does,
      including the "no store → exit 1" line). Read `runLogPath` from offset 0 through a
      `makeLineParser`, printing each rendered line, then poll every `pollMs` (default 200):
      re-`stat`, read the delta from the last offset, push it into the SAME parser instance.
      Stop when the run's state is in `TERMINAL` **and** the offset has caught up to the file
      size; print a one-line footer (state, PR url or first line of `failureReason`) and
      return 0. If the log does not exist yet and the run is non-terminal, print `waiting for
      the agent to start…` once and keep polling; if it does not exist and the run IS
      terminal, print `no activity log for <run> — it predates \`law watch\`, or no agent was
      ever spawned` and return 1. `SIGINT` exits 0 quietly.

    **`src/cli/index.ts`.** Add `watch` to the dispatch and to `USAGE`. Positionals only
    (`law watch [target]`). In the USAGE text say the log is plain NDJSON at
    `~/.linear-auto-worker/runs/<runId>.jsonl` — an operator with `jq` should not have to ask.

    **`src/cli/daemon.ts`.** Beside the stale-worktree collection (`:592-604`), and in the
    same never-fatal `.catch(...)` shape, call `pruneRunLogs(root, RUN_LOG_TTL_MS,
    Date.now())` and log the count when non-zero.
  </action>
  <verify>
    <automated>npm run verify</automated>

    Unit coverage to write, each one falsified before it is trusted:
    `run-log.test.ts` — a written event round-trips as one JSON line; the directory is 0700
    and the file 0600 (`statSync(...).mode & 0o777`); the cap writes exactly one
    `law.truncated` line and then nothing; `pruneRunLogs` deletes only files older than the
    ttl and returns them; a missing directory is an empty list.
    `resolve-run.test.ts` — each of the five resolution paths, against a real SQLite file
    seeded like `usage.test.ts` does; the ambiguous cases return an error that NAMES the
    candidates.
    `watch.test.ts` — `renderEvent` for every branch above, including `null` for an unknown
    type; and `runWatch` end to end against a real temp root: seed a run row, write a JSONL
    file, assert the printed lines through the injected `print`.

    Then the **T109 wiring procedure**, which is the point of the whole task. Delete the
    `onEvent: (e) => runLog.write(e)` line in `adapters.ts` and run:

    <automated>node --test "dist/src/execution/run-log.test.js" "dist/src/cli/watch.test.js"</automated>
    must stay GREEN (they target the modules), while a run driven through
    `createAgentRunner` produces no log file. If no check goes red on that deletion, the
    wiring is untested — add the assertion to `adapters.inject.test.ts` in Task 3, which
    already drives a scripted spawn through `createAgentRunner`, and re-run the deletion.
    Restore the line and confirm `git status` shows `adapters.ts` back to its intended state.
  </verify>
  <done>
    A run driven through `createAgentRunner` writes `<root>/runs/<runId>.jsonl` at 0600
    inside a 0700 directory. `law watch` with no argument follows the single active run;
    with `LAW-123` or an id prefix it follows that one; on a finished run it prints the whole
    log and exits 0; on a nonexistent one it prints one actionable line and exits 1. `law
    watch` is in `USAGE`. Logs older than 7 days are gone after a boot. `npm run verify` is
    green and `status.ts` has no `ACTIVE` array of its own.
  </done>
</task>

<task type="auto">
  <name>Task 2: Streaming input — the prompt on stdin, stdin closed on the first `result`</name>
  <files>src/execution/agent-args.ts, src/execution/agent-args.test.ts, src/execution/event-router.ts, src/execution/event-router.test.ts, src/execution/supervisor.ts, src/execution/supervisor.test.ts, src/cli/adapters.ts, src/cli/usage.test.ts, scripts/probe-stream-input.ts, scripts/probe-gsd-allowlist.ts</files>
  <read_first>
    `src/execution/agent-args.ts:103-179` — `commonArgs`, `buildClaudeArgs`,
    `buildResumeArgs`. Read the T57 comment at `:166-176` in full before touching
    `buildResumeArgs`: it records that "replace `-p` with `--resume`", taken literally,
    resumes a session and then says nothing to it, so the answer never arrives and the whole
    Q&A feature is inert while every log line looks healthy. That failure mode is EXACTLY
    what M2 reproduces through a different door, and the comment must be rewritten to say so
    rather than deleted.

    `src/execution/agent-args.test.ts:130-160` — two assertions that are about to move, NOT
    to be deleted: the argv-array containment test (`after(nasty,'-p') === hostile`, T99's
    live-path control) and T57's `after(args,'-p') === answer`. Both currently assert at the
    argv seam; the prompt is leaving argv, so both must be re-pointed at the stdin seam or
    the controls silently stop being checked.

    `src/execution/supervisor.ts:147-162` — `defaultSpawn`, already
    `stdio: ['pipe','pipe','pipe']` and `detached: true`. `:17-32` — why `AgentSubprocess` is
    deliberately narrow. `:306-323` — the both-streams drain and why an undrained stdout
    deadlocks the child.

    `src/cli/adapters.ts:233-257` (`usageTokens`, moving) and `:496-516` (the cost/token
    accumulation and the T95 comment explaining per-session-value-on-a-per-run-quantity).

    `src/cli/usage.test.ts:1-215` — `runOnce`, its scripted spawn, and the four D6 cases.
    `D6: a resumed run ACCUMULATES cost across its sessions` is about cost across SEPARATE
    `runner.run()` calls and stays correct; the new case is about multiple results WITHIN
    one call.

    `scripts/probe-gsd-allowlist.ts:85-100` — the other `buildClaudeArgs` caller. Not
    type-checked (see constraints).
  </read_first>
  <action>
    **`src/execution/agent-args.ts`.**
    - `export const INPUT_FORMAT = 'stream-json';` beside `OUTPUT_FORMAT`.
    - `commonArgs` gains `'--input-format', INPUT_FORMAT` and `'--replay-user-messages'`.
      Comment the replay flag with its two reasons: it is the daemon's only positive receipt
      that a written message was consumed, and it is what puts the operator's own words in
      the run log so `law watch` shows both halves of the conversation (M11).
    - `buildClaudeArgs` → `['--session-id', o.sessionId, ...commonArgs(o), '-p']`.
      `buildResumeArgs` → `['--resume', o.sessionId, ...commonArgs(o), '-p']`.
      `-p` LAST and with NO value, per M3. Comment both: `--input-format` only works with
      `--print`, so the flag stays; a value there is silently discarded and the session then
      hangs for the full `maxRunMs` producing nothing (M2) — the single most expensive
      failure this file can cause.
    - REMOVE `prompt` from `ClaudeArgsInput`. Removing it is the enforcement: every stale
      caller becomes a compile error rather than a silently-ignored argument. Update the
      module header's promise accordingly.
    - Add `export function userMessageLine(text: string): string` returning the exact
      envelope from M3 plus a trailing newline. It lives here, not in `inject.ts`, because
      this module is already the single source of truth for everything on the `claude` wire,
      and Task 3 imports it rather than writing a second copy.

    **`src/execution/event-router.ts`.**
    - MOVE `usageTokens` here from `adapters.ts` (one implementation, not two) and have the
      router keep a running `tokensUsed`, summed over EVERY result event. Expose it on
      `EventRouter` beside `denials`. Comment it with M6: cost is cumulative and must be
      taken from the last result; usage is per message and must be summed. Getting these two
      backwards is T95 in both directions at once.
    - Tally replayed `user` events (`userEchoes`) — count only, nothing stored. It is the
      evidence for the "the agent never acknowledged the prompt" diagnosis below.
    - Extend the `type === 'result'` comment to state that this handler RECORDS and never
      terminates: under streaming input a result arrives per user message (M4), the last one
      wins, and the run ends when the process exits.
    - Note M9 on the `system/init` branch: a second init per subsequent message is normal and
      `assertSessionUsable` re-running on it is intended.

    **`src/execution/supervisor.ts`.**
    - `AgentSubprocess` gains `stdin: NodeJS.WritableStream | null`, with a comment saying
      why it is now on an interface whose whole point is narrowness, and that `kill` is still
      absent on purpose.
    - `RunAgentInput` gains `prompt: string` (required — it no longer travels in argv) and
      `onInput?: (send: (text: string) => boolean) => void`.
    - Immediately after the spawn, in the same before-the-first-await block as
      `o.onSpawn?.(child.pid)`: write `userMessageLine(o.prompt)` to `child.stdin`. If stdin
      is null or the write throws, that is a hard failure of the run — log it at error and
      let the existing no-result path report it; do not continue silently.
    - Then call `o.onInput?.(send)` where `send(text)` writes `userMessageLine(text)` and
      returns `false` on any throw or after stdin has been ended. `send` never throws.
    - In the parser tap, after the run-log hook and before/around `router.route`: on the
      FIRST event with `type === 'result'`, end stdin exactly once. Comment it as the
      terminal-condition rule from `<design>` — including why closing here is safe (a message
      written before the close is delivered ahead of EOF) and why the run still ends on
      process exit and not on this event.
    - `AgentRunOutcome` gains `tokensUsed: number` from the router's tally.
    - When there is no result event, extend the crashed diagnosis with `and never echoed the
      prompt back — the stdin delivery failed` when `userEchoes === 0`. That one clause turns
      M2 from a 45-minute mystery into a sentence.

    **`src/cli/adapters.ts`.** Delete the local `usageTokens` and use `outcome.tokensUsed`.
    Stop passing `prompt` to the arg builders; pass it to `runAgent` instead. Leave the
    cost accumulation exactly as it is — the last result's `total_cost_usd` IS the session
    total (M6), so `prior.costUsd + …` stays correct; add one line to that comment saying so,
    because the next reader will otherwise "fix" it into summing every result.

    **`scripts/probe-stream-input.ts`** (new, human-run, in the style of
    `probe-gsd-allowlist.ts` and out of the gate). Spawns the real binary through the SHIPPED
    `buildClaudeArgs` and re-measures M2 through M11: a bare `-p` run with a prompt on stdin;
    a message injected after result #1; stdin closed after the last result; and a printed
    table of `num_turns` / `total_cost_usd` / `usage` per result so the per-message vs
    cumulative asymmetry is visible rather than asserted. Its header must state that it costs
    real money (~$0.30/run measured) and is never run by `npm run verify`.

    **`scripts/probe-gsd-allowlist.ts`.** Drop `prompt` from the `buildClaudeArgs` call and
    write `userMessageLine(PROBE_PROMPT)` to the child's stdin instead. The compiler will not
    tell you if you miss this.
  </action>
  <verify>
    <automated>npm run verify</automated>

    The checks that matter, all falsified before trusted:

    `agent-args.test.ts` — `-p` is the LAST element and carries no value, on BOTH builders;
    `--input-format stream-json` and `--replay-user-messages` are on both; the existing
    "fresh and resumed agree on every shared flag" case is extended to cover them. The
    argv-containment case becomes the STRONGER claim: a hostile prompt appears NOWHERE in
    argv (`assert.ok(!args.some(a => a.includes(hostile)))`).

    `supervisor.test.ts` — the moved controls plus the anti-trap case. Script a spawn whose
    `stdin` is a real `PassThrough` and whose stdout emits, in order: `system/init`,
    `assistant`, `result`#1 (`structured_output.summary: 'turn one'`, `total_cost_usd: 0.5`,
    `usage.input_tokens: 10`), `assistant`, `result`#2 (`summary: 'turn two'`,
    `total_cost_usd: 0.6`, `usage.input_tokens: 7`), then end. Assert:
      1. the PassThrough received exactly one line before any output, and it parses to the
         M3 envelope carrying the prompt verbatim — the relocated T99/T57 control;
      2. a hostile prompt survives as exactly one JSON string in that envelope;
      3. `outcome.resultEvent.structured_output.summary === 'turn two'` — **this is the test
         that must fail if `result` is treated as terminal under streaming input**;
      4. `outcome.resultEvent.total_cost_usd === 0.6`, explicitly `!== 1.1` (cumulative,
         never summed — M6);
      5. `outcome.tokensUsed === 17` (per-message, summed — M6);
      6. stdin was ended exactly once, and after `result`#1, not before.

    Falsify #3 by making the supervisor resolve on the first `result`: it must go RED at
    `'turn one'`. Falsify #1 by deleting the stdin write: RED. Record both failure texts —
    they go into the TRAPS row in Task 4.

    `usage.test.ts` — one new case: a single `runner.run()` whose session emits two results
    stores the LAST cost and the SUM of the tokens. The four existing D6 cases must pass
    unchanged; if one needed editing to stay green, say why in the commit body.

    Finally, run the real-binary probe once by hand and paste its output into the commit
    body — this is the only thing that can see M2:
    <automated>npx tsx scripts/probe-stream-input.ts</automated>
  </verify>
  <done>
    Every `claude` session is spawned with `--input-format stream-json
    --replay-user-messages` and a bare trailing `-p`; the prompt reaches the agent over
    stdin and appears nowhere in argv; stdin closes on the first `result` and the run still
    ends on process exit; the last result governs the verdict; cost is taken and tokens are
    summed; a prompt that never lands is reported as such. `npm run verify` green,
    `probe-stream-input.ts` run once against the real binary with its output recorded.
  </done>
</task>

<task type="auto">
  <name>Task 3: `law say` — a 0600 Unix socket, the injector, and the T109 wiring proof</name>
  <files>src/execution/inject.ts, src/execution/inject.test.ts, src/cli/adapters.ts, src/cli/adapters.inject.test.ts, src/cli/say.ts, src/cli/index.ts, src/cli/daemon.ts, scripts/boot-smoke.ts</files>
  <read_first>
    `src/cli/daemon.ts:1-20` — the injection-seam rule: a port is overridable only if it
    crosses a boundary this machine cannot cross in a test. The injector and its socket cross
    NEITHER, so they are constructed real in every caller including the smoke, and
    `BootOptions` gains no fifth slot.
    `src/cli/daemon.ts:746-796` — reverse-order shutdown. The socket closes with the server
    (step 5), before the store; it must also unlink its path.
    `src/cli/adapters.ts:411-419` and `:474-494` — `createAgentRunner` and the `runAgent`
    call where `onInput` is wired and unwound.
    `src/ingress/receiver.ts` — read it once and add NOTHING. T-VOH-01: this is what the
    public tunnel fronts.
    `scripts/boot-smoke.ts:300-320` — the second boot and its `agent` override; and the file
    header's list of what the smoke proves, which gains an item.
    `src/orchestration/questions.ts:1-20, 109-116` — the durable Q&A path `law say` must
    coexist with, not replace.
  </read_first>
  <action>
    **`src/execution/inject.ts`** (new). The wire, the registry and both ends of the socket
    in one module — deliberately, so the envelope and the reply shape cannot drift into two
    copies (T72/T92/T96 are all that defect).

    - `SOCKET_NAME = 'say.sock'`; `socketPath(root)`; `MAX_SAY_BYTES = 8 * 1024`.
    - `type SayOutcome = { ok: true } | { ok: false; error: string }`.
    - `createInjector()` → `{ register(runId, send): () => void; send(runId, text):
      SayOutcome }`. `register` returns its own unregister. `send` on an unknown run →
      `{ok:false, error:'…'}`; on a `send` that returns false → an error saying the agent has
      finished its turn and is no longer accepting input. In-memory `Map`, nothing more.
    - `serveInjections({ injector, root, log })` → `{ close(): Promise<void> }`.
      A `net.createServer`. Per connection: read up to `MAX_SAY_BYTES + 1` bytes, take the
      first line, `JSON.parse` it, reject anything larger or malformed with a
      `{ok:false,error}` reply, otherwise `injector.send(runId, text)` and reply with the
      outcome; `end()` either way. Never let a bad client throw into the daemon.
      Before listening, the T-VOH-05 stale-socket dance: if the path exists, connect to it —
      ECONNREFUSED means a dead daemon's leftover, so unlink and listen; a successful connect
      means another daemon owns this root, so throw with that diagnosis. On `listening`,
      `chmodSync(path, 0o600)` and `chmodSync(root, 0o700)`. `close()` closes the server and
      unlinks the path.
    - `sendInjection({ root, runId, text })` → `Promise<SayOutcome>`. Connects, writes one
      line, reads one line, resolves. ENOENT/ECONNREFUSED → `{ok:false, error:'the daemon is
      not running — start it with \`law start\`'}`. A 2-second timeout resolves as a failure,
      never hangs.
    - The `userMessageLine` import comes from `agent-args.ts`. Do not redefine it here.
    - Carry the T-VOH-06 comment: this text is deliberately NOT run through
      `sanitizeUntrustedText`, and why.

    **`src/cli/adapters.ts`.** `AgentRunnerDeps` gains an optional `injector`. In `run`, pass
    `onInput: (send) => { unregister = deps.injector?.register(req.runId, send); }` and call
    `unregister?.()` in the same `finally` that closes the run log.

    **`src/cli/say.ts`** (new). `runSay({ root?, target?, text, print? }): Promise<number>`.
    Open the store as `status.ts` does, `resolveRunTarget`, then:
    - state in `TERMINAL` → `run <label> already finished (<state>) — nothing to say to`,
      exit 1.
    - state `awaiting_answer` → `run <label> is parked awaiting an answer — reply to the
      bot's comment on <issueKey> in Linear instead`, exit 1. This is the Q&A boundary from
      `<design>`, made visible at the only place an operator would hit it.
    - otherwise `sendInjection`; print `sent to <label>` or the returned error verbatim.
      Exit 0 only on `{ok:true}`.
    Never hang, never exit 0 on a message that was not delivered.

    **`src/cli/index.ts`.** `law say <target> <text…>`: join `positionals.slice(2)` with
    spaces so an unquoted sentence works, and document `--` in USAGE for text that starts
    with a dash (`parseArgs` throws on an unknown option — T88). Empty text → the usage line,
    exit 1. Add both commands' one-liners to `USAGE`.

    **`src/cli/daemon.ts`.** Construct `createInjector()` beside the other adapters, pass it
    into `createAgentRunner`'s deps, `await serveInjections(...)` after the HTTP server binds,
    and close it in shutdown step 5 beside `server.close()`. Log the socket path once at
    `daemon ready`, so the operator can see where it is.

    **`scripts/boot-smoke.ts`.** Add one item to the header list and two assertions after
    boot: `say.sock` exists with `mode & 0o777 === 0o600` and its directory is `0o700`; and
    `sendInjection({root, runId: 'no-such-run', text: 'hi'})` resolves `{ok:false}` with a
    non-empty error — which proves the daemon is SERVING, not merely that a file exists.
  </action>
  <verify>
    <automated>npm run verify</automated>

    `inject.test.ts` — the registry (register/send/unregister/unknown-run/dead-send); a real
    server on a `mkdtemp` root answering a real `sendInjection` for both outcomes; the
    oversize payload rejected at `MAX_SAY_BYTES + 1`; the malformed line rejected without
    throwing; `sendInjection` against a root with no socket resolving the "daemon is not
    running" failure rather than hanging; the stale-socket path (create a plain file at
    `say.sock`, then `serveInjections` succeeds and replaces it).

    `adapters.inject.test.ts` — the integration check, and the T109 target. Drive
    `createAgentRunner` with a scripted `AgentSpawn` whose `stdin` is a real `PassThrough`
    and whose stdout is held open; while `run()` is in flight, call `injector.send(runId,
    'stop and run the tests')`; assert the M3 envelope carrying that exact text arrived on
    the PassThrough. Then emit `result` and assert a subsequent `send` fails — the terminal
    rule from Task 2, observed from the outside.

    **T109 wiring procedure — required, on the `law say` path.** Delete the `onInput: …` line
    in `adapters.ts` and run the two suites separately:
    <automated>node --test "dist/src/execution/inject.test.js"</automated>
    must stay GREEN (the registry and the socket still work in isolation), and
    <automated>node --test "dist/src/cli/adapters.inject.test.js"</automated>
    must go RED. Both red means the integration test is targeting the module rather than the
    wiring and must be rewritten to go through `createAgentRunner`; neither red means it is
    targeting nothing. Repeat once for the socket half: delete the `serveInjections(...)` call
    in `daemon.ts` — the unit suite must stay green while `npm run smoke` goes RED. Record
    both results; they go into the TRAPS row in Task 4. Restore both lines and confirm
    `git status` shows no leftover edit before committing.

    Grep gate for T-VOH-01, run and recorded:
    <automated>grep -v '^\s*[/*]' src/ingress/receiver.ts | grep -c -i -E 'say|inject|sock'</automated>
    Must be `0`. Comment lines are stripped first because this plan's own prose would
    otherwise satisfy the grep — the vacuous-gate failure recorded at the end of
    `docs/TRAPS.md`.
  </verify>
  <done>
    `law say LAW-123 stop and run the tests` reaches a live agent's stdin and the agent's
    reply shows up in `law watch`. The channel is a 0600 socket in a 0700 directory with no
    HTTP route anywhere near the tunnel. A finished run, a parked run, and a dead daemon each
    produce one clear actionable line and a non-zero exit — never a hang, never a silent
    drop. Deleting either call site turns an integration check red while the unit suites stay
    green. `npm run verify` green.
  </done>
</task>

<task type="auto">
  <name>Task 4: File T113–T115 in both ledgers, and document both commands</name>
  <files>.planning/TRAPS.md, docs/TRAPS.md, docs/agent-invocation.md, README.md</files>
  <read_first>
    `.planning/TRAPS.md:124-127` — `## Discovered at open-source release` and its five-column
    header. `:149` (T109) and `:152` (T112) are the rows to match — all five columns filled.
    T110 and T111 stop after three columns; that is pre-existing and NOT this task's subject.
    Leave them alone.
    `docs/TRAPS.md:24-77` — `## Driving \`claude -p\` from a program`, where the prose rows
    for T1–T4 live; the new prose belongs there, in that section's voice.
    `docs/agent-invocation.md` — the record of what is passed to `claude` and why, including
    the trade `--bare` being forbidden forces.
    `README.md:53-62` (the command list) and `:127-160` (`## Known limitations`, `## The traps
    ledger`).
  </read_first>
  <action>
    **`.planning/TRAPS.md`** — three new five-column rows, `Phase` = `quick 260907-voh`:

    - **T113 — `-p "<prompt>"` is SILENTLY DISCARDED under `--input-format stream-json`, and
      the session then hangs forever.** Give the measurement from M2 verbatim: eight
      hook_started + eight hook_response inside 0.7s, then 90 seconds of nothing — no
      `system/init`, no result — until SIGKILL. Failure mode: every run burns its full
      45-minute `maxRunMs` producing nothing while the log looks healthy, which is T1's shape
      reached through the flag pair chosen to avoid it. Correct move: keep `-p` (required by
      `--input-format`, which only works with `--print`), pass it LAST and with no value, and
      write the prompt as an NDJSON `user` message on stdin; `--replay-user-messages` is the
      receipt that it landed. Record the falsification: deleting the stdin write turns
      `supervisor.test.ts` RED, with the actual text.
    - **T114 — under streaming input a `result` event arrives PER USER MESSAGE, so `result` is
      not the terminal event.** State the measurement (three messages → three results,
      `num_turns` 3/2/2 with `--max-turns 4`, so the turn budget is per message too), and the
      asymmetry that comes with it: `total_cost_usd` is CUMULATIVE for the session while
      `usage` is per message — take the last cost, sum the tokens, and getting it backwards
      is T95 in both directions at once. TWO DIFFERENT failure modes, and the plan
      originally conflated them. (a) If OUR code makes `result` terminal, it delivers a pull
      request after turn one while the agent is still working — that is what the anti-trap
      test guards. (b) If **M4 itself** is false (a CLI that emits a result per INTERNAL
      turn), the daemon is immune to (a) — `routed.result` is last-wins and nothing resolves
      early — but it would close stdin on an internal-turn result, EOF the child mid-work,
      and truncate the run into a `partial`. No unit test can see (b), because the suite
      scripts the stream; `scripts/probe-stream-input.ts` is its only instrument.
      [Corrected during execution — FLAG-B.]
      Correct move: the run ends when the PROCESS EXITS; the daemon closes stdin on the first
      result and that is the only thing `result` decides. Record the anti-trap test and its
      RED text at `'turn one'`. Add M9 (a second `system/init` per message) in the same row.
    - **T115 — `--remote-control` accepts the flag, exits 0, and does nothing.** M1 in full,
      including the exact `system/init` key list that does NOT contain a remote-control field,
      so nobody re-tries it. Correct move: `--input-format stream-json` is the real channel;
      `--remote-control` starts an INTERACTIVE session and has no meaning under `--print`.

    Also append the T109 wiring results from Tasks 1 and 3 to whichever row they belong to,
    with the actual green/red pairs rather than a claim that the procedure was followed.

    **`docs/TRAPS.md`** — one prose block appended to `## Driving \`claude -p\` from a
    program`, in that section's voice: declarative sentences, real numbers, a bolded lesson
    leading each paragraph. Cover the same three findings. The `result`-per-message one is the
    one that matters most; give it the most space and state the delivery-after-turn-one
    failure explicitly.

    **`docs/agent-invocation.md`** — update the argv record: the new flags, the bare trailing
    `-p`, the prompt travelling on stdin, and the stdin-closes-on-first-result rule with its
    consequence (the injection window is spawn → first result). Note that the prompt no longer
    appears in argv at all, which strengthens rather than weakens the T99 containment claim.

    **`README.md`** — add `law watch` and `law say` to the command list at `:56-59` with
    one-line descriptions; a short subsection under `## Usage` covering the two of them, the
    NDJSON log path, and the `--` escape for text starting with a dash. Under `## Known
    limitations`, state plainly: the say channel is a local 0600 socket and is deliberately
    NOT reachable from the tunnel; `law say` only works while the agent's turn is still
    running — once it has answered, use the Linear comment path; run logs are kept 7 days and
    capped at 64 MiB per run; they contain raw agent output and are readable by the operator's
    user only.
  </action>
  <verify>
    <automated>awk -F'|' '/^\| T11[345] /{print NF-2}' .planning/TRAPS.md</automated>
    Must print `5` three times, matching the header at `.planning/TRAPS.md:127`.
    <automated>grep -c -E 'law watch|law say' README.md</automated>
    Must be at least 4.
    Then read every claim back against what Tasks 1–3 actually measured. A ledger row that
    overstates is worse than no row — the ledger is loaded into every future planning brief.
  </verify>
  <done>
    T113, T114 and T115 are well-formed five-column rows in `.planning/TRAPS.md`; the prose
    versions are in `docs/TRAPS.md` under the `claude -p` section; `docs/agent-invocation.md`
    describes the argv and stdin contract that actually ships; `README.md` documents both
    commands and their three real limitations.
  </done>
</task>

</tasks>

<commits>
Four atomic commits, in task order:

1. `feat(watch): per-run activity log and \`law watch\`` — Task 1, with the T109 result in
   the body. This PLAN.md ships here (`commit_docs` is true).
2. `feat(agent): send the prompt on stdin and close it on the first result` — Task 2, with
   the two falsification texts and the real-binary probe output in the body.
3. `feat(say): inject a message into a live agent over a 0600 local socket` — Task 3, with
   both T109 results and the receiver grep gate in the body.
4. `docs(traps): T113–T115 — streaming input, per-message results, the remote-control no-op`

Stay on `main`.
</commits>

<success_criteria>
- `law watch` follows a live run and replays a finished one, resolving a run by issue key, id
  prefix, or "the one that is active".
- `law say <run> <text>` reaches a live agent's stdin, and the agent's reply is visible in
  `law watch` alongside the operator's own replayed words.
- The say channel is a Unix socket at 0600 inside a 0700 directory. `src/ingress/receiver.ts`
  gains no route; the grep gate over its non-comment lines returns 0.
- The terminal condition is explicit: the run ends on process exit, stdin closes on the first
  `result`, and a test goes RED if `result` is made terminal — observed red, not asserted.
- Cost is taken from the last result and tokens are summed across results; the four existing
  D6 cases still pass.
- A prompt that never reaches the agent is reported as a stdin delivery failure, not as a
  45-minute silence.
- The Q&A path is untouched: `questionsEnabled`, `maxQuestionRounds` and the
  exit-and-`--resume` flow behave exactly as before, and `law say` against a parked run
  redirects to Linear.
- Deleting either injection call site turns an integration check red while the unit suites
  stay green.
- `npm run verify` green: 598 existing plus the new cases, plus the boot smoke.
- T113–T115 filed in `.planning/TRAPS.md` and `docs/TRAPS.md`; both commands documented in
  `README.md` and `docs/agent-invocation.md`.
</success_criteria>

<open_risks>
Stated rather than planned around:

1. **The blast radius of Task 2 is every run.** If the stdin write regresses, every run
   silently produces nothing for 45 minutes (M2). The plan buys this down with the
   supervisor-level containment test, the `userEchoes` diagnosis, and the real-binary probe —
   not with a feature flag, for the reason given in `<design>`. If the executor finds a
   fourth cheap guard, take it.
2. **Closing stdin mid-turn was not measured.** The design never does it (the close happens on
   `result`, i.e. between turns), so this is out of scope — but if a future change ever wants
   to close stdin early, it must be measured first.
3. **`law watch` polls at 200 ms.** Chosen over `fs.watch` because `fs.watch` semantics differ
   across platforms and a local `stat` is free. If a run log ever grows fast enough for that
   to matter, the log is already past its cap.
4. **A run that spawns no agent has no log.** `law watch` says so and exits 1. Making queued
   runs write a stub log was rejected as machinery for a message.
</open_risks>
