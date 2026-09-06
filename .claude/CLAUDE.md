<!-- GSD:project-start source:PROJECT.md -->
## Project

**linear-auto-worker**

A local TypeScript daemon that turns Linear issues into pull requests without a human in the loop. It opens its own ngrok tunnel at boot, registers that URL as a Linear webhook, and watches for issues assigned to a dedicated bot user. When one arrives it moves the issue to In Progress, creates a git worktree in the mapped repo, spawns a local `claude -p` session that runs the GSD workflow against the ticket, then pushes the branch and opens a PR — reporting progress to Linear comments, Slack, and logs the whole way.

It is a single-operator tool: it runs on the developer's own machine, uses the `gh` and `claude` CLIs that are already authenticated there, and is configured through one guided setup wizard.

**Core Value:** An issue assigned to the bot in Linear becomes a reviewable pull request, with no manual step in between.

### Constraints

- **Tech stack**: TypeScript on Node — chosen by the operator; the Linear SDK, ngrok SDK, and `better-sqlite3` all have first-class Node support
- **Build strategy**: Horizontal layers, full parallelism — the operator wants every layer built at once rather than a thin vertical slice first. One genuine serialization point survives: domain types, the run state machine, and the SQL schema are imported by every layer and must land before them
- **Agent invocation**: `claude -p` must always pass an explicit `--permission-mode` (it starts in Manual and would otherwise be denied every edit while still exiting 0) and `--verbose` (mandatory with `stream-json`). `--bare` is forbidden — it skips `~/.claude` and would kill the global GSD install this project depends on
- **Reliability posture**: Best effort, never fragile. Any coordination that cannot be made reliable (notably comment-driven Q&A) must degrade to a documented assumption rather than hang or silently drop work
- **Tunnel singleton**: exactly one tunnel per worker process, enforced structurally by the in-process SDK rather than by lockfiles
- **Concurrency**: global cap on simultaneous spawned Claude sessions, default 3, to stay within local RAM
- **Secrets**: only `LINEAR_API_KEY` and `NGROK_AUTHTOKEN` are ever prompted; everything else is detected or generated
<!-- GSD:project-end -->

<!-- GSD:stack-start source:research/STACK.md -->
## Technology Stack

## Methodology note (read this before trusting the confidence column)
- Versions come from the **npm registry** (`registry.npmjs.org/<pkg>/latest`), not training data.
- API surfaces come from **inspecting the published `.d.ts` of the installed package**, not prose docs.
- The `claude` CLI and `gh` CLI surfaces were verified by **running them on this machine**.
- The Linear webhook receiver was verified by **standing up a real `node:http` server and POSTing a signed payload**.
## Recommended Stack
### Core Technologies
| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| **Node.js** | **24.x (Active LTS)** | Runtime | Node 24 is Active LTS as of Sept 2026; Node 22 is already in *Maintenance*. `better-sqlite3@13` requires `>=22`, `execa@10` requires `>=22`. **This machine currently runs v22.23.1 — the setup wizard should preflight for `>=24` and tell the operator to upgrade.** |
| **TypeScript** | **5.9.x — pin, do NOT take `latest`** | Types + build | `latest` on npm is now **7.0.2** (the Go-native `tsgo` rewrite, released 2026-07-08). TS7 is a compiler rewrite with known type-checking behaviour gaps vs 5.x. For a greenfield daemon with heavy `.d.ts` dependencies (`@linear/sdk` ships a ~74k-line declaration file), stay on the mature 5.9 line. Revisit TS7 once `@linear/sdk` publishes a compatibility statement. |
| **ESM** (`"type": "module"`) | — | Module system | Non-negotiable: `@linear/sdk` is `"type": "module"`, and `zod`, `hono`, `@inquirer/prompts`, `execa`, `tsx` are all ESM-first. `better-sqlite3` and `@ngrok/ngrok` are CJS but import cleanly into ESM via default interop. |
| **`@linear/sdk`** | **`93.0.1` — pin EXACT, no caret** | Linear GraphQL client + webhook receiver | See landmine #1: this package ships a **new major roughly every week** (auto-generated from the GraphQL schema — 86.0.0 → 93.0.1 in 15 weeks). `^93` is meaningless and `~93` still drifts. Pin exact and bump deliberately. |
| **`@ngrok/ngrok`** | **`1.7.0`** | In-process tunnel | Already locked in PROJECT.md. Ships **prebuilt napi binaries** via `optionalDependencies` for 13 platform triples — no compile step. Tunnel lifetime is bound to the process, which is exactly the "structurally impossible to orphan" property the project wants. |
| **`node:http`** (built-in) | — | Webhook HTTP server | **Use no HTTP framework.** See landmine #2 — `@linear/sdk/webhooks` ships a handler that is *itself* a `node:http` request listener and reads the raw body internally. Adding Hono/Fastify/Express buys nothing and reintroduces the raw-body problem you'd otherwise not have. |
| **`better-sqlite3`** | **`13.0.3`** | Run queue, pending questions, delivery-ID dedupe, webhook secret | Synchronous API (no async ceremony around a queue), WAL mode, battle-tested. v13 moved to **prebuildify** — verified: 2-second install, 8 platform prebuilds, **zero node-gyp / Xcode CLT requirement**. That kills the historical objection and keeps the setup wizard's preflight simple. |
| **`zod`** | **`4.5.4`** | Config schema validation | Validates `config.json` and the project→repo map at load. v4 idioms differ from v3 — see the section below. |
### Supporting Libraries
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| **`execa`** | `10.0.1` | Spawning `claude`, `git`, `gh` | Promise-based `child_process` with sane defaults, no shell interpolation by default (argv array → no injection from Linear issue titles), `.kill()` + timeout support, and streaming stdout for `stream-json` parsing. Requires Node `>=22`. |
| **`@inquirer/prompts`** | `8.7.1` | Setup wizard | Modular (`input`, `password`, `select`, `confirm`, `checkbox` — import only what you use), actively maintained, first-class TS types. Requires Node `>=20.17`. |
| **`pino`** | `10.3.1` | Structured logging | PROJECT.md requires "structured logging of every state transition". Pino is JSON-first, fastest in class, and its child-logger pattern (`log.child({ runId, issueId })`) is exactly right for correlating a run across worktree/agent/PR stages. Add `pino-pretty` as a **dev-only** dep for human-readable local output. |
| **`node:crypto`** (built-in) | — | Webhook secret generation, delivery dedupe | `crypto.randomBytes(32).toString('hex')` for the webhook secret (see landmine #3), `crypto.randomUUID()` for pre-assigned Claude session IDs. |
### Development Tools
| Tool | Purpose | Notes |
|------|---------|-------|
| **`tsx`** `4.23.13` | Run TS directly in dev | `tsx watch src/index.ts`. No build step during development. |
| **`tsc`** (5.9.x) | Type-check + emit for the shipped daemon | `tsc --noEmit` in CI/precommit; plain `tsc` for the dist build. **Do not add `tsup`/`esbuild`/`rollup`** — this is a locally-run daemon, not a published library. Bundling a package with a native `.node` binary (`better-sqlite3`, `@ngrok/ngrok`) is actively painful and buys nothing. |
| **`node:test`** (built-in) | Test runner | Built in, zero deps, `node --test`, has mocking + coverage. For a single-operator daemon this is sufficient. Vitest 5.0.0 is fine if the team wants watch-mode ergonomics, but it's an extra ~30MB of dev dep for no capability you need here. |
## Installation
# Core
# Dev
## Landmines — read before planning
### 1. `@linear/sdk` ships a new MAJOR version roughly weekly
### 2. The old `LinearWebhooks` class is GONE — and its replacement solves the raw-body problem for you
### 3. Linear's own docs contradict the schema on the webhook secret — generate it yourself and sidestep the question
- [linear.app/developers/webhooks](https://linear.app/developers/webhooks) states the secret is **not** returned at creation and must be copied from the settings UI.
- The **shipped GraphQL schema disagrees**: `WebhookFragment` (what the SDK actually selects) includes `secret`, and the schema doc comment on `Webhook.secret` reads *"Automatically generated if not provided during creation."*
### 4. Creating a webhook requires WORKSPACE ADMIN — this may block the bot-account design
### 5. Personal API key auth header has NO `Bearer` prefix
### 6. `@ngrok/ngrok` does NOT read `NGROK_AUTHTOKEN` automatically
### 7. `claude -p`: pre-assign the session ID, don't parse it out
| Detail | Verified behaviour |
|---|---|
| `--output-format stream-json` without `--verbose` | **Hard error**: `Error: When using --print, --output-format=stream-json requires --verbose` |
| Final event | `{type:"result", subtype:"success"\|"error_max_turns"\|..., is_error, num_turns, result, session_id}` |
| Exit code, success | `0` (`is_error: false`) |
| Exit code, failure | `1` (verified with `error_max_turns`, `is_error: true`) |
| `--permission-mode` choices | `acceptEdits` · `auto` · `bypassPermissions` · `manual` · `dontAsk` · `plan` |
### 8. `gh pr create` has no `--json` — it prints the URL on stdout
## Zod 4 idioms (v3 habits will mislead you)
- Top-level format validators exist and are preferred: `z.url()`, `z.email()`, `z.uuid()`. The `z.string().url()` chain still works but is deprecated.
- `z.prettifyError()` and `z.treeifyError()` replace v3's `.format()` / `.flatten()`. Confirmed output: `✖ Too big: expected number to be <=10`.
- New subpath exports: `zod/mini` (smaller runtime), `zod/compile`, `zod/v3` (compat shim).
## Alternatives Considered
| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| `node:http` + `@linear/sdk/webhooks` handler | **Hono 4.13.7** | Only if the daemon later grows a real HTTP surface (status API, local dashboard). Hono exposes raw body via `c.req.raw.arrayBuffer()` (a Fetch `Request`), which pairs with the handler's *Fetch* signature — so migration is one line. Explicitly deferred: PROJECT.md rules out a web UI. |
| `node:http` | **Fastify 5.12.3** | Only for a multi-tenant hosted variant — out of scope. Raw body needs `fastify-raw-body` or a custom content-type parser; strictly more work than the built-in path. |
| `better-sqlite3` 13.0.3 | **`node:sqlite`** (built-in) | If zero native deps ever becomes a hard constraint. Currently: still emits `ExperimentalWarning` on Node 22/24 (verified locally) and only reached Stability 1.2 "release candidate" in Node 25.7+. Its `DatabaseSync`/`StatementSync` API is near-identical, so a later swap is mechanical. Not worth the instability today. |
| `execa` 10.0.1 | `node:child_process` | Viable — this is ~5 spawn sites. Take `execa` anyway for automatic argv-array safety, timeouts, and clean `AbortSignal` support, all of which you'd otherwise hand-roll for the concurrency cap and run cancellation. |
| Shelling out to `git` | **`simple-git` 3.36.0** | Not worth it. `simple-git`'s worktree support is thin, and the operations here are `git worktree add`, `git worktree remove`, `git push -u`. Shelling out via `execa` is more transparent and one less dependency. |
| `fetch` for Slack | `@slack/webhook` 8.0.2 | Not worth it. Posting to an Incoming Webhook is one `fetch` POST with a JSON body. The library adds retry/backoff — replicate in ~10 lines if you want it, or accept that a dropped Slack notification is non-fatal (PROJECT.md already mandates structured logging independent of Slack). |
| `@inquirer/prompts` 8.7.1 | `@clack/prompts` 1.7.0 | If you want the prettier grouped-wizard aesthetic. Genuinely nicer visuals and a first-class `group()` API for multi-step flows. Either is defensible; `@inquirer` wins on ecosystem maturity and breadth of prompt types. |
| `node:test` | `vitest` 5.0.0 | If the project grows enough tests that watch-mode and rich diffing pay for themselves. |
| `pino` 10.3.1 | `consola` 3.4.2 | `consola` is nicer for *wizard* output (pretty, human-facing). Reasonable split: `consola` in the wizard, `pino` in the daemon. Or just use `pino` + `pino-pretty` and skip the second dep. |
## What NOT to Use
| Avoid | Why | Use Instead |
|-------|-----|-------------|
| **`typescript@latest` (7.0.2)** | `latest` is now the Go-native `tsgo` rewrite. Compiler-behaviour differences against a 74k-line generated `.d.ts` (`@linear/sdk`) are an unforced risk on a greenfield project. | `typescript@~5.9` |
| **`@linear/sdk` with a `^` or `~` range** | New **major** ~weekly. A range guarantees an eventual silent breaking bump. | Exact pin `93.0.1` |
| **`LinearWebhooks` class / hand-rolled HMAC verification** | The class was removed; hand-rolling means re-solving the raw-body problem you don't otherwise have, and inviting a timing-unsafe `===` compare. | `LinearWebhookClient` + `createHandler()` from `@linear/sdk/webhooks` |
| **Express 5.2.1** | Needs `express.raw({type:'application/json'})` on the webhook route *specifically*, and a `express.json()` ordering mistake silently breaks signature verification. Pure downside here. | `node:http` |
| **`body-parser` / `express.json()` on the webhook route** | Parsing before verifying destroys byte-exact raw body. Re-stringifying a parsed body **will** produce signature mismatches (key ordering, unicode escaping). Linear's docs call this out explicitly. | Let the SDK handler consume the stream |
| **ngrok CLI as a child process** | Reintroduces orphan tunnels, PID tracking, and lockfiles — the exact class of problem the in-process SDK eliminates. Already rejected in PROJECT.md. | `@ngrok/ngrok` in-process |
| **`ngrok` (the old npm package)** | Unmaintained wrapper around the CLI binary; different package from `@ngrok/ngrok`. | `@ngrok/ngrok@1.7.0` |
| **`@anthropic-ai/claude-agent-sdk` (0.3.263)** | Wrong fit *for this project*: it wants you to host the agent **in-process**, which forfeits the crash isolation PROJECT.md explicitly chose, and it does **not** inherit the operator's globally-installed GSD skills and CLI auth the way a `claude` subprocess does. It also puts the concurrency cap inside your own heap rather than across OS processes. | `claude -p` child process via `execa` |
| **`tsup` / bundling the daemon** | Bundling native `.node` addons (`better-sqlite3`, `@ngrok/ngrok`) is fiddly and gains nothing for a locally-run daemon. | plain `tsc`, or `tsx` in dev |
| **`prompts@2.4.2`** | Effectively unmaintained (last release 2021), CJS-only. | `@inquirer/prompts@8.7.1` |
| **Parsing the session id out of `stream-json`** | Unnecessary and race-prone — many `hook_started` events precede `system/init`. | `--session-id <crypto.randomUUID()>` |
| **`--output-format stream-json` without `--verbose`** | Hard startup error, not a warning. | Always pass `--verbose` |
| **`gh pr create --json`** | The flag does not exist on `create`. | Read the URL from stdout; `gh pr view --json` afterwards |
## Version Compatibility
| Package | Compatible With | Notes |
|---------|-----------------|-------|
| `better-sqlite3@13.0.3` | Node `>=22` | `prebuilds/` ships 8 platform binaries — **no node-gyp, no Xcode CLT**. Verified: 2s install. |
| `execa@10.0.1` | Node `>=22` | ESM-only. |
| `@inquirer/prompts@8.7.1` | Node `>=20.17` | ESM. |
| `@ngrok/ngrok@1.7.0` | Node `>=10` | 13 platform prebuilds via `optionalDependencies`. `darwin-arm64` present. |
| `@linear/sdk@93.0.1` | Node `>=18` | `"type": "module"`, dual CJS/ESM exports, plus the `./webhooks` subpath. |
| `zod@4.5.4` | any modern Node | ESM-first; `zod/v3` subpath available for compat. |
| `vitest@5.0.0` (if used) | Node `^22.12` \|\| `^24` \|\| `>=26` | Note the gap — 24.0–24.x is fine, but check odd versions. |
## Stack Patterns by Variant
- Wizard prompts for a *second*, admin-scoped Linear key used **only** for `webhookCreate` / `webhooks()`.
- Bot key still owns all comments and state transitions, so Linear attribution is unchanged.
- Costs one extra prompt, violating the "only two secrets" constraint — prefer making the bot an admin.
- Swap `node:http` → **Hono 4.13.7** and switch the Linear handler to its **Fetch** signature (`handler(c.req.raw)`), which the same `createHandler()` already supports. One-line migration, no re-architecture.
- `better-sqlite3` → `node:sqlite` (`DatabaseSync`, near-identical sync API).
- `@ngrok/ngrok` cannot be replaced — it is inherently native. This variant is incompatible with the tunnel design.
## Sources
- `registry.npmjs.org/<pkg>/latest` — every version number in this document
- `node_modules/@linear/sdk/dist/index-267_t0Tf.d.mts` (v93.0.1) — `WebhookCreateInput`, `Webhook`, `WebhookFragment`, `LinearWebhookHandler`, `LinearWebhookEventType`, `CommentCreateInput.parentId`, `Issue.branchName`, `WorkflowState.{name,type,position}`
- `node_modules/@ngrok/ngrok/index.d.ts` + `README.md` (v1.7.0) — `connect`/`forward`/`Listener`/`authtoken_from_env`
- Live `node:http` + `@linear/sdk/webhooks` signature-verification test — 200 on valid HMAC, 400 on invalid
- `claude --help` and 4 live `claude -p` invocations (v2.1.259) — `--session-id`, `--verbose` requirement, result-event shape, exit codes 0/1
- `gh pr create --help` (v2.98.0) — no `--json`, URL on stdout
- `zod@4.5.4` executed — top-level validators, `prettifyError`, `treeifyError`
- `better-sqlite3@13.0.3` installed + loaded — prebuilds present, WAL works, no compile
- `node:sqlite` on Node 22.23.1 — `ExperimentalWarning` reproduced
- [linear.app/developers/webhooks](https://linear.app/developers/webhooks) — admin requirement, `Linear-Delivery` dedupe header, retry schedule (1min/1hr/6hr, max 3), replay-window guidance. **Contradicts the shipped schema on secret return — see landmine #3.**
- [linear.app/developers/graphql](https://linear.app/developers/graphql) — `Authorization: <KEY>`, no `Bearer`
- [linear.app/developers/rate-limiting](https://linear.app/developers/rate-limiting) — 2,500 req/hr, 3M complexity points/hr
- [nodejs.org/api/sqlite.html](https://nodejs.org/api/sqlite.html) — `node:sqlite` stability
- [nodejs.org/en/blog/announcements/evolving-the-nodejs-release-schedule](https://nodejs.org/en/blog/announcements/evolving-the-nodejs-release-schedule) — Node 24 Active LTS, Node 22 Maintenance
<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->
## Conventions

Conventions not yet established. Will populate as patterns emerge during development.
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->
## Architecture

Architecture not yet mapped. Follow existing patterns found in the codebase.
<!-- GSD:architecture-end -->

<!-- GSD:skills-start source:skills/ -->
## Project Skills

No project skills found. Add skills to any of: `.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, `.github/skills/`, or `.codex/skills/` with a `SKILL.md` index file.
<!-- GSD:skills-end -->

<!-- GSD:workflow-start source:GSD defaults -->
## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:
- `/gsd-quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd-debug` for investigation and bug fixing
- `/gsd-execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->



<!-- GSD:profile-start -->
## Developer Profile

> Profile not yet configured. Run `/gsd-profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
