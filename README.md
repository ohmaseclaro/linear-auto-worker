# linear-auto-worker

[![CI](https://github.com/ohmaseclaro/linear-auto-worker/actions/workflows/ci.yml/badge.svg)](https://github.com/ohmaseclaro/linear-auto-worker/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](package.json)

Assign a Linear issue to your bot user. Get a draft pull request.

A local TypeScript daemon that watches Linear for issues assigned to a dedicated bot
account, moves each one to In Progress, creates a git worktree in the mapped repo, runs a
local `claude -p` session against the ticket, then pushes the branch and opens a PR —
reporting progress to Linear comments, Slack and structured logs the whole way.

It runs on your own machine and uses the `gh` and `claude` CLIs you have already
authenticated. It is a single-operator tool: no hosted service, no auth layer, no user
model.

---

## Requirements

| | |
|---|---|
| Node | **>= 22** (the wizard warns below 24, fails below 22) |
| `git` | with `user.name` and `user.email` configured |
| `gh` | authenticated (`gh auth status`) |
| `claude` | on `PATH`, authenticated, with the global GSD install present |
| Linear | a **workspace-admin** bot account — `webhookCreate` requires admin |
| ngrok | a free account (an authtoken; a verified account is required even on free) |

Only two secrets are ever prompted for: **`LINEAR_API_KEY`** and **`NGROK_AUTHTOKEN`**.
Everything else is detected or generated. If ngrok's own config already holds a token, the
wizard lifts it for you.

## Install

```bash
git clone https://github.com/ohmaseclaro/linear-auto-worker.git
cd linear-auto-worker
npm install
npm run build
npm link          # makes `law` available on your PATH
law setup
```

`law setup` is safe to re-run. It edits in place and skips whatever is already valid, so
it is also how you add a repo mapping later — you never hand-edit JSON.

There is no npm package: this is installed from a clone, so `package.json` keeps
`"private": true` as a publish guard. That is unrelated to the licence, which is
[MIT](LICENSE).

## Usage

```bash
law setup            # guided setup, ending with the webhook registered and working
law setup --doctor   # inspect/repair webhook registrations (per-item confirmation to delete)
law start            # run the daemon until interrupted
law status           # queued and in-flight runs
law watch [target]   # follow a run's activity live, or replay a finished one
law say <target> …   # speak to a running agent mid-flight
law --help
```

### Watching a run, and talking to it

A spawned run is otherwise a black box for up to 45 minutes between pickup and pull request.

```bash
law watch                       # the single active run
law watch LAW-123               # by issue key, or by the first 4+ characters of a run id
law say LAW-123 stop and run the tests before you commit
law say LAW-123 -- --draft is fine, keep going
```

`law watch` follows a durable per-run event log at
`~/.linear-auto-worker/runs/<runId>.jsonl` — plain NDJSON, one parsed stream event per
line, so `jq` reads it too. It shows the agent's text and tool calls, and it shows your own
words back (prefixed `»`) once the agent has consumed them, which is how you know a
`law say` landed.

`law say` needs no quotes: everything after the target is joined with spaces. Text that
*starts* with a dash needs `--` first, because the argument parser rejects unknown options.

## Configuration

Everything lives in `~/.linear-auto-worker/`:

```
config.json     the project→repo map and behaviour toggles, mode 0600
                (a mapping's Slack webhook URL is a posting credential)
.env            LINEAR_API_KEY and NGROK_AUTHTOKEN, mode 0600
*.db            SQLite: run queue, pending questions, delivery dedupe, kv
logs/
```

Mappings are keyed by **Linear project, with a team-level fallback** — without the
fallback an issue filed straight onto a team would match nothing and be silently dropped.
Six toggles come from a global `defaults` block that a mapping overrides sparsely: Linear
comments, Slack, base branch, draft-vs-ready PR, the question flow, and max run time.
`concurrency` is global (it bounds local RAM) and deliberately not per-mapping.

## How a run works

1. **Pickup** — assignment to the bot fires a webhook. Ingress verifies the HMAC, dedupes
   by delivery id, and drops anything the bot itself caused. It never decides from the
   payload; it re-fetches the issue and decides from fresh state.
2. **Acknowledge** — In Progress plus a comment, within ten seconds and *before* any git
   work. You are added as a subscriber, since assignee-based pickup would otherwise take
   the ticket out of your own view.
3. **Work** — a git worktree on Linear's suggested branch name, then a supervised
   `claude -p` session running GSD against the ticket body.
4. **Questions** — the agent can end its turn declaring it needs input. The process
   **exits**, freeing its concurrency slot, and the worker persists the question with a
   deadline (4h default). A threaded reply resumes the same session; a timeout resumes
   with a stated assumption, posted to the ticket.
5. **Deliver** — the *worker* pushes and opens the PR, never the agent. Push is refused on
   the default branch, blocked on a secret in the diff, and flags any change to CI files.

One ticket mapped to several repos produces one sub-run per repo, reported independently —
a repo that fails never discards another repo's finished PR.

Success is judged by **evidence in the worktree** — commits on the branch, files on disk —
never by the agent's exit code or its own self-report. Every way `claude -p` can be
misconfigured exits 0 and looks like success, so a run claiming `complete` with no commits
is recorded as *failed*, and a run killed at its deadline *with* commits is recorded as
*partial* and still ships its draft PR.
[`docs/agent-invocation.md`](docs/agent-invocation.md) documents every flag and why it is
there.

## Development

```bash
npm run verify     # tsc + the full suite + the boot smoke — the canonical gate
npm run typecheck
npm run test
npm run smoke      # boots the daemon against fakes and shuts it down
npm run uat:ingress  # the same chain against a REAL ngrok tunnel (see below)
```

`npm run uat:ingress` is the one live test that needs no Linear workspace. It opens a real
tunnel with your own ngrok authtoken and drives a signed delivery from the public internet
back into the receiver — proving what a fake tunnel structurally cannot. Linear stays faked,
so it cannot reach a real workspace: no key is read, no webhook is registered.

`npm run verify` compiles first and runs `dist/**/*.test.js`, because `node --test` cannot
resolve `.js` specifiers inside `.ts` files and would otherwise run **zero tests**.

## Known limitations

Honest list:

- **End-to-end has not been run against a live Linear workspace.** Everything below the
  network boundary is covered by 511 tests and a boot smoke that drives a signed webhook
  through to a persisted run, but the credential-gated path — a real ticket, a real agent,
  a real PR — is verified only by
  [45 manual checks](.planning/phases/07-integration-daemon-lifecycle/07-HUMAN-UAT.md) that
  have not all been executed. Treat 0.1.0 accordingly.
- **`law status` reads the store, not the daemon.** It is accurate about what is persisted;
  a run's progress *within* the current agent turn is only in the logs.
- **Questions rely on Linear comment webhooks arriving.** If one is missed, the run resumes
  at its deadline with a stated assumption rather than hanging — best effort by design, not
  guaranteed delivery. Deadlines and the missed-work re-poll run on a one-minute tick.
- **A run's spend cap is per run, its turn cap per session.** `maxBudgetUsd` is enforced
  against everything the run has already spent across all its sessions; `maxTurns` is a
  fresh budget for each session, because answering a question is new work. Hitting either
  ships whatever is committed as a draft PR rather than discarding it.
- **`law say` only works while the agent's turn is still running.** The window is spawn →
  the agent's first result. Once it has answered — including when it has answered with a
  question — the channel refuses with one clear line and points you at the Linear comment
  path, which is the durable one. `law say` prints `queued to …`, not "sent": it can tell
  you the message was accepted by the pipe, not that the agent read it. `law watch` is what
  shows you it landed.
- **The say channel is a local Unix socket, deliberately not reachable from the tunnel.**
  `~/.linear-auto-worker/say.sock`, mode 0600 in a 0700 directory. It is never an HTTP route
  and must never become one: the receiver is published to the open internet through ngrok,
  and this channel writes straight into an agent running with write access to your private
  clones.
- **Run activity logs are kept 7 days and capped at 64 MiB per run.** They contain **raw
  agent output** — anything the agent read, including a `.env` it happened to `cat` — and
  deliberately bypass the log redaction, because a redacted trace is not a trace. They are
  mode 0600, readable by your user only, never transmitted anywhere, and never attached to a
  PR body, a Linear comment or a Slack message. `law watch` prints to your terminal and
  nowhere else.
- **macOS-first.** CI runs Ubuntu and macOS on Node 22 and 24, but the ngrok config path and
  the SIGINT process-group behaviour were both measured on macOS only.

### Trust boundary you are accepting

`--bare` is forbidden, because it would strip the global GSD install this tool depends on.
The consequence is that **a mapped repo's own `.claude/settings.json` hooks execute
unprompted** in the spawned session. Every repo you map is implicitly fully trusted. Map
only repos you would run arbitrary code from. Branch protection on the default branch is
the one guard a prompt-injected agent cannot reach — the wizard warns when it is missing.

[`SECURITY.md`](SECURITY.md) has the full picture, including the guards that *are* in place
and what is explicitly out of scope.

## The traps ledger

[`docs/TRAPS.md`](docs/TRAPS.md) holds the **115 verified footguns** found building this —
each one measured against the real tool, not recalled. A sample:

- `claude -p --permission-mode dontAsk` alone **denies every edit and exits 0** with
  `is_error: false`. It needs `--allowedTools`.
- Inherited `CLAUDE*` environment variables break the spawned agent, so behaviour depends
  on how you launched the daemon.
- `@linear/sdk`'s `createHandler()` `JSON.parse`s **unverified bytes before** HMAC-ing.
- `fetchNext()` mutates and returns `this`, so the intuitive pagination loop makes a
  webhook reconciler **delete its own live webhook**.
- An MCP long-poll tool does **not** block the agent — Claude Code backgrounds it after
  ~2 minutes and the agent proceeds without the answer.
- `node --test dist` runs **zero tests** on Node 22.
- A backtick inside a SQL comment closed a TypeScript template literal, and the resulting
  syntax error **suppressed 53 downstream type errors**.

If you take one thing from this repository, take that file. The raw internal ledger, with
per-phase attribution and the evidence for each row, is in
[`.planning/TRAPS.md`](.planning/TRAPS.md).

## How this was built

`.planning/` is the complete record: requirements, per-phase context, 35 plans, verification
reports, and the runtime evidence behind each claim. It is kept deliberately — the traps
ledger is only readable because the reasoning around it survived.

## Contributing

[`CONTRIBUTING.md`](CONTRIBUTING.md) — the gate is `npm run verify`, and it needs no
credentials, no network and no Linear workspace. Security issues:
[`SECURITY.md`](SECURITY.md). Conduct: [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

## Licence

[MIT](LICENSE).
