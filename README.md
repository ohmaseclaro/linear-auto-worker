# linear-auto-worker

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
git clone <your-remote> linear-auto-worker && cd linear-auto-worker
npm install
npm run build
npm link          # makes `law` available on your PATH
law setup
```

`law setup` is safe to re-run. It edits in place and skips whatever is already valid, so
it is also how you add a repo mapping later — you never hand-edit JSON.

## Usage

```bash
law setup            # guided setup, ending with the webhook registered and working
law setup --doctor   # inspect/repair webhook registrations (per-item confirmation to delete)
law start            # run the daemon until interrupted
law status           # queued and in-flight runs
law --help
```

## Configuration

Everything lives in `~/.linear-auto-worker/`:

```
config.json     the project→repo map and behaviour toggles
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

## Development

```bash
npm run verify     # tsc + the full suite + the boot smoke — the canonical gate
npm run typecheck
npm run test
npm run smoke      # boots the daemon against fakes and shuts it down
```

`npm run verify` compiles first and runs `dist/**/*.test.js`, because `node --test` cannot
resolve `.js` specifiers inside `.ts` files and would otherwise run **zero tests**.

## Known limitations

Honest list, all recorded in [`.planning/TRAPS.md`](.planning/TRAPS.md):

- **`law status` is a stub.** It prints a placeholder.
- **The evidence-based verdict is built but not on the live path.** The run engine trusts
  the agent's self-reported status, so a truncated run cannot currently classify as
  `partial` and ship its draft PR. This is the highest-value follow-up — research is
  emphatic that trusting self-report is this design's most likely silent failure.
- **Progress comments come from the run engine, not the notifier's Linear channel.** That
  channel exists and is deliberately unwired; wiring both would double-post every
  milestone.
- **End-to-end has not been run against a live workspace.** See
  [`.planning/phases/07-integration-daemon-lifecycle/07-HUMAN-UAT.md`](.planning/phases/07-integration-daemon-lifecycle/07-HUMAN-UAT.md)
  — 45 credential-gated checks.

### Trust boundary you are accepting

`--bare` is forbidden, because it would strip the global GSD install this tool depends on.
The consequence is that **a mapped repo's own `.claude/settings.json` hooks execute
unprompted** in the spawned session. Every repo you map is implicitly fully trusted. Map
only repos you would run arbitrary code from. Branch protection on the default branch is
the one guard a prompt-injected agent cannot reach — the wizard warns when it is missing.

## The traps ledger

[`.planning/TRAPS.md`](.planning/TRAPS.md) holds **89 verified footguns** found building
this — each one measured against the real tool, not recalled. A sample:

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

If you take one thing from this repository, take that file.
