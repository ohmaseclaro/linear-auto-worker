# Stack Research

**Domain:** Local single-operator TypeScript daemon — Linear webhooks → queued `claude -p` agent runs in git worktrees → GitHub PRs
**Researched:** 2026-09-06
**Confidence:** HIGH

## Methodology note (read this before trusting the confidence column)

Most claims here were **verified by execution, not by reading docs**:

- Versions come from the **npm registry** (`registry.npmjs.org/<pkg>/latest`), not training data.
- API surfaces come from **inspecting the published `.d.ts` of the installed package**, not prose docs.
- The `claude` CLI and `gh` CLI surfaces were verified by **running them on this machine**.
- The Linear webhook receiver was verified by **standing up a real `node:http` server and POSTing a signed payload**.

Where a claim rests only on web docs it is marked and the doc URL is given. Two published Linear doc statements were found to be **wrong or misleading** and are called out in "Landmines" below — do not skip that section.

---

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

```bash
# Core
npm install @linear/sdk@93.0.1 @ngrok/ngrok@1.7.0 better-sqlite3@13.0.3 zod@4.5.4 execa@10.0.1 pino@10.3.1 @inquirer/prompts@8.7.1

# Dev
npm install -D typescript@~5.9 tsx@4.23.13 @types/node@^24 @types/better-sqlite3 pino-pretty
```

Note the **exact pin** (no `^`) on `@linear/sdk`.

---

## Landmines — read before planning

### 1. `@linear/sdk` ships a new MAJOR version roughly weekly

Observed from the registry publish log:

```
86.0.0  2026-05-22      90.0.0  2026-08-13
87.0.0  2026-06-23      91.0.0  2026-08-21
88.0.0  2026-07-01      92.0.0  2026-08-27
89.0.0  2026-07-30      93.0.0  2026-09-03  → 93.0.1  2026-09-04
```

These are schema-generated majors, so most are harmless — but **`^` or `~` ranges are useless here** and a stale lockfile is the only thing standing between you and a surprise breaking change. **Pin exact; bump as a deliberate, tested step.**

*Confidence: HIGH — read directly from the npm registry publish timestamps.*

### 2. The old `LinearWebhooks` class is GONE — and its replacement solves the raw-body problem for you

The question brief asks about `LinearWebhooks` / `LINEAR_WEBHOOK_SIGNATURE_HEADER`. As of v93 **`LinearWebhooks` no longer exists**. The replacement lives on a subpath export:

```ts
import {
  LinearWebhookClient,
  LINEAR_WEBHOOK_SIGNATURE_HEADER, // "linear-signature"
  LINEAR_WEBHOOK_TS_HEADER,        // "linear-timestamp"
  LINEAR_WEBHOOK_TS_FIELD,         // "webhookTimestamp"
} from "@linear/sdk/webhooks";
```

The decisive detail — `createHandler()` returns a **dual-signature** callable:

```ts
interface LinearWebhookHandler {
  (request: Request): Promise<Response>;                          // Fetch runtimes
  (request: IncomingMessage, response: ServerResponse): Promise<void>; // node:http
  on<T extends LinearWebhookEventType>(eventType: T, handler): void;
  on(eventType: "*", handler): void;
  off(...): void;
  removeAllListeners(eventType?: string): void;
}
```

The Node adapter **consumes the raw body stream itself** and HMACs it before any JSON parsing. That means **the raw-body-for-signature-verification problem does not exist if you use `node:http` + this handler.** No `express.raw()`, no Fastify `rawBody` plugin, no Hono `c.req.raw.clone().arrayBuffer()` dance.

**Verified end-to-end on this machine** — real `node:http` server, real HMAC-SHA256 signed POST:

```
valid sig -> status 200 | handler fired: Issue  aug/lin-123-hello
bad sig   -> status 400
```

Wiring it up is this small:

```ts
const client = new LinearWebhookClient(secret);
const handler = client.createHandler();
handler.on("Issue", async (payload) => { /* payload.data.branchName, payload.updatedFrom */ });

http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/webhook") return handler(req, res);
  res.writeHead(404).end();
}).listen(port);
```

Invalid signature → **400** (not 401). Handle accordingly if you alert on status codes.

*Confidence: HIGH — read from the installed `.d.ts` and confirmed by executing it.*

### 3. Linear's own docs contradict the schema on the webhook secret — generate it yourself and sidestep the question

- [linear.app/developers/webhooks](https://linear.app/developers/webhooks) states the secret is **not** returned at creation and must be copied from the settings UI.
- The **shipped GraphQL schema disagrees**: `WebhookFragment` (what the SDK actually selects) includes `secret`, and the schema doc comment on `Webhook.secret` reads *"Automatically generated if not provided during creation."*

PROJECT.md's assumption ("Linear returns the webhook signing secret at `webhookCreate` time") is **probably right but rests on a contested doc**. Don't gamble on it. `WebhookCreateInput` accepts an optional client-supplied secret:

```ts
type WebhookCreateInput = {
  url: Scalars["String"];                    // required
  resourceTypes: Array<Scalars["String"]>;   // required
  secret?: InputMaybe<Scalars["String"]>;    // ← supply your own
  teamId?: InputMaybe<Scalars["String"]>;
  allPublicTeams?: InputMaybe<Scalars["Boolean"]>;
  enabled?: InputMaybe<Scalars["Boolean"]>;
  label?: InputMaybe<Scalars["String"]>;
  id?: InputMaybe<Scalars["String"]>;        // client-supplied UUID → idempotency
};
```

**Prescription:** the worker generates `crypto.randomBytes(32).toString('hex')`, persists it to SQLite *before* calling `webhookCreate`, and passes it as `secret`. The outcome PROJECT.md wants (never prompted for) is preserved, and it works whether or not the read-back returns the value. Bonus: the client-supplied `id` field gives you **idempotent webhook registration** for free — exactly the requirement in PROJECT.md.

*Confidence: HIGH on the schema (read from `.d.ts`); the recommendation is robust to either doc being correct.*

### 4. Creating a webhook requires WORKSPACE ADMIN — this may block the bot-account design

Linear's docs: *"Only workspace admins, or OAuth applications with the `admin` scope, can create or read webhooks."*

PROJECT.md's plan is a **dedicated bot account with a personal API key**. If that bot account is a plain Member, **`webhookCreate` will fail**. Two resolutions, both cheap:

1. Make the bot account a workspace admin (free on Linear Free — unlimited members), or
2. Have the wizard accept **two** keys: the operator's admin key for one-time webhook registration, and the bot's key for comments/transitions (which preserves bot attribution on all visible actions).

**Option 1 is simpler and preserves the "only two secrets prompted" constraint.** The wizard should preflight this by attempting a `webhooks()` read and failing loudly with an actionable message.

*Confidence: MEDIUM (web docs, LOW-tier provider per the seam) — but the failure mode is severe enough that the wizard must probe for it at runtime regardless.*
Source: [linear.app/developers/webhooks](https://linear.app/developers/webhooks)

### 5. Personal API key auth header has NO `Bearer` prefix

`Authorization: <API_KEY>` — **not** `Bearer <API_KEY>`. (OAuth tokens *do* use `Bearer`.) The SDK handles this when constructed as `new LinearClient({ apiKey })`; it matters only if you ever hand-roll a `fetch`.

Rate limits for personal API keys: **2,500 requests/hour** and **3,000,000 complexity points/hour**, reported via `X-RateLimit-Requests-Remaining` / `X-RateLimit-Complexity-Remaining`. Comfortably above this workload, but the worker should log the remaining-quota headers.

*Confidence: MEDIUM.* Source: [linear.app/developers/graphql](https://linear.app/developers/graphql), [linear.app/developers/rate-limiting](https://linear.app/developers/rate-limiting)

### 6. `@ngrok/ngrok` does NOT read `NGROK_AUTHTOKEN` automatically

PROJECT.md says the SDK "reads `NGROK_AUTHTOKEN` from the environment". That is **only true if you opt in**. From the installed `.d.ts`:

```ts
/** Shortcut for calling [SessionBuilder::authtoken] with the value of the NGROK_AUTHTOKEN environment variable. */
authtoken_from_env?: boolean
```

```ts
const listener = await ngrok.forward({ addr: port, authtoken_from_env: true });
const publicUrl = listener.url();   // string | null  ← null-check this
```

The rest of PROJECT.md's claim is correct: the SDK does **not** read `~/.config/ngrok/ngrok.yml`, so the wizard lifting the token out of that YAML into the environment is the right move.

API surface: `connect(config)` and `forward(config)` are **aliases** — both `Promise<Listener>`. `Listener`: `.url()`, `.id()`, `.proto()`, `.close()`. Module-level: `disconnect(url?)`, `kill()`, `listeners()`, `getListenerByUrl(url)`, `authtoken(token)`, `loggingCallback(cb, level)`.

Free-tier caveats: random `*.ngrok-free.app` domain on every restart (hence idempotent webhook re-registration on each boot — already a PROJECT.md requirement), one online agent session, and a monthly request cap. Route `loggingCallback` into pino so tunnel failures aren't silent.

*Confidence: HIGH — read from the installed `.d.ts` and README.*

### 7. `claude -p`: pre-assign the session ID, don't parse it out

The brief asks how to obtain the session id from stream output. **You don't need to.** `--session-id <uuid>` lets the *caller* choose it:

```ts
const sessionId = crypto.randomUUID();
await execa("claude", [
  "-p", prompt,
  "--session-id", sessionId,
  "--output-format", "stream-json",
  "--verbose",                       // ← MANDATORY, see below
  "--permission-mode", "bypassPermissions",
  "--add-dir", worktreePath,
  "--model", "sonnet",
], { cwd: worktreePath });
// later, to answer a question:
await execa("claude", ["-p", answer, "--resume", sessionId, /* ... */]);
```

Verified: the pre-generated UUID is echoed as `session_id` on **every** emitted event. This removes an entire class of parsing/race bugs from the blocking Q&A flow — persist `sessionId` into SQLite *before* spawning.

**Hard requirements and semantics, all verified by running the CLI (v2.1.259):**

| Detail | Verified behaviour |
|---|---|
| `--output-format stream-json` without `--verbose` | **Hard error**: `Error: When using --print, --output-format=stream-json requires --verbose` |
| Final event | `{type:"result", subtype:"success"\|"error_max_turns"\|..., is_error, num_turns, result, session_id}` |
| Exit code, success | `0` (`is_error: false`) |
| Exit code, failure | `1` (verified with `error_max_turns`, `is_error: true`) |
| `--permission-mode` choices | `acceptEdits` · `auto` · `bypassPermissions` · `manual` · `dontAsk` · `plan` |

**Exit code is trustworthy** — but still parse the final `result` event, because it tells you *why* (`error_max_turns` vs a real crash) and that distinction should drive the Linear comment the worker posts.

Other flags worth knowing: `--add-dir`, `--max-turns`, `--max-budget-usd` (a cheap circuit-breaker for a runaway ticket), `--fork-session`, `--model`, `--append-system-prompt`.

Event stream is noisier than the docs suggest — expect many `{type:"system", subtype:"hook_started"|"hook_response"}` events before `system/init`. **Filter on `type`/`subtype`; never assume ordering or that `system/init` is first.**

*Confidence: HIGH — every row above was produced by executing the CLI on this machine.*

### 8. `gh pr create` has no `--json` — it prints the URL on stdout

Verified against `gh 2.98.0`. From its own help: *"Upon success, the URL of the created pull request will be printed."* There is no `--json` flag on `create`.

```ts
const { stdout } = await execa("gh", [
  "pr", "create",
  "--title", title,
  "--body", body,
  "--head", branchName,
  "--base", baseBranch,     // else falls back to repo default
], { cwd: worktreePath });
const prUrl = stdout.trim();          // ← this is the PR URL
```

If you need structured data afterwards: `gh pr view <url> --json url,number,state,isDraft`.

Useful flags: `--draft`, `--body-file -` (read body from stdin — **use this**, it avoids argv length limits and shell quoting hazards with agent-generated bodies), `--label`, `--assignee`, `--reviewer`, `--dry-run` (great for the wizard's preflight).

*Confidence: HIGH — read from `gh pr create --help` on this machine.*

---

## Zod 4 idioms (v3 habits will mislead you)

Verified by executing `zod@4.5.4`:

```ts
import * as z from "zod";        // ← namespace import is the v4 idiom

const Config = z.object({
  linearApiKey: z.string().min(1),
  slackWebhookUrl: z.url().optional(),   // ← top-level z.url(), not z.string().url()
  concurrency: z.number().int().min(1).max(10).default(3),
});

const result = Config.safeParse(raw);
if (!result.success) {
  console.error(z.prettifyError(result.error));   // ← new in v4, human-readable
  // z.treeifyError(result.error) for structured/nested form errors
}
```

- Top-level format validators exist and are preferred: `z.url()`, `z.email()`, `z.uuid()`. The `z.string().url()` chain still works but is deprecated.
- `z.prettifyError()` and `z.treeifyError()` replace v3's `.format()` / `.flatten()`. Confirmed output: `✖ Too big: expected number to be <=10`.
- New subpath exports: `zod/mini` (smaller runtime), `zod/compile`, `zod/v3` (compat shim).

Use `z.prettifyError` for the wizard's config-validation messages — it's the single highest-value v4 feature for this project.

---

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

**Local environment gap:** this machine has **Node v22.23.1**, npm 10.9.8, git 2.50.1, gh 2.98.0, claude 2.1.259. Node 22 satisfies every `engines` field above, but it is **Maintenance LTS** and makes `node:sqlite` noisier. Recommend the wizard preflight `node >= 24`.

## Stack Patterns by Variant

**If the bot account cannot be made a workspace admin:**
- Wizard prompts for a *second*, admin-scoped Linear key used **only** for `webhookCreate` / `webhooks()`.
- Bot key still owns all comments and state transitions, so Linear attribution is unchanged.
- Costs one extra prompt, violating the "only two secrets" constraint — prefer making the bot an admin.

**If a local status dashboard is ever added (currently out of scope):**
- Swap `node:http` → **Hono 4.13.7** and switch the Linear handler to its **Fetch** signature (`handler(c.req.raw)`), which the same `createHandler()` already supports. One-line migration, no re-architecture.

**If native modules ever become unacceptable (e.g. a `--experimental-strip-types` single-file deploy):**
- `better-sqlite3` → `node:sqlite` (`DatabaseSync`, near-identical sync API).
- `@ngrok/ngrok` cannot be replaced — it is inherently native. This variant is incompatible with the tunnel design.

## Sources

**Directly executed / inspected on this machine (HIGH confidence):**
- `registry.npmjs.org/<pkg>/latest` — every version number in this document
- `node_modules/@linear/sdk/dist/index-267_t0Tf.d.mts` (v93.0.1) — `WebhookCreateInput`, `Webhook`, `WebhookFragment`, `LinearWebhookHandler`, `LinearWebhookEventType`, `CommentCreateInput.parentId`, `Issue.branchName`, `WorkflowState.{name,type,position}`
- `node_modules/@ngrok/ngrok/index.d.ts` + `README.md` (v1.7.0) — `connect`/`forward`/`Listener`/`authtoken_from_env`
- Live `node:http` + `@linear/sdk/webhooks` signature-verification test — 200 on valid HMAC, 400 on invalid
- `claude --help` and 4 live `claude -p` invocations (v2.1.259) — `--session-id`, `--verbose` requirement, result-event shape, exit codes 0/1
- `gh pr create --help` (v2.98.0) — no `--json`, URL on stdout
- `zod@4.5.4` executed — top-level validators, `prettifyError`, `treeifyError`
- `better-sqlite3@13.0.3` installed + loaded — prebuilds present, WAL works, no compile
- `node:sqlite` on Node 22.23.1 — `ExperimentalWarning` reproduced

**Web documentation (MEDIUM/LOW confidence — flagged inline):**
- [linear.app/developers/webhooks](https://linear.app/developers/webhooks) — admin requirement, `Linear-Delivery` dedupe header, retry schedule (1min/1hr/6hr, max 3), replay-window guidance. **Contradicts the shipped schema on secret return — see landmine #3.**
- [linear.app/developers/graphql](https://linear.app/developers/graphql) — `Authorization: <KEY>`, no `Bearer`
- [linear.app/developers/rate-limiting](https://linear.app/developers/rate-limiting) — 2,500 req/hr, 3M complexity points/hr
- [nodejs.org/api/sqlite.html](https://nodejs.org/api/sqlite.html) — `node:sqlite` stability
- [nodejs.org/en/blog/announcements/evolving-the-nodejs-release-schedule](https://nodejs.org/en/blog/announcements/evolving-the-nodejs-release-schedule) — Node 24 Active LTS, Node 22 Maintenance

---
*Stack research for: local Linear→PR automation daemon*
*Researched: 2026-09-06*
