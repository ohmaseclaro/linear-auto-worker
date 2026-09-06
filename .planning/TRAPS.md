# Known Traps Ledger

Running list of framework/tool footguns discovered during the milestone. Passed into every
planning and execution brief so no two waves rediscover the same trap independently.

Seeded 2026-09-06 from `.planning/research/SUMMARY.md` "Corrections to PROJECT.md" — these were
verified against live tools/registries during project research, not recalled from training data.

## Seeded (verified before any code existed)

| # | Trap | Failure mode | Correct move | Phase |
|---|------|--------------|--------------|-------|
| T1 | `claude -p` starts in **Manual** permission mode | Every edit denied, process still **exits 0** — looks like success, produces nothing | Always pass an explicit `--permission-mode` | 4 |
| T2 | `claude -p --bare` skips `~/.claude` | Kills the global GSD install the spawned agent depends on; fails silently | `--bare` is forbidden, no exceptions | 4 |
| T3 | `--output-format stream-json` without `--verbose` | Hard startup error, not a warning: "requires --verbose" | Always pair the two flags | 4 |
| T4 | Parsing session id out of the stream | Race-prone — many `hook_started` events precede `system/init` | Pre-assign `--session-id <crypto.randomUUID()>`, persist before spawn | 4 |
| T5 | `@linear/sdk` v93 **removed** the `LinearWebhooks` class | Any code written against the old class does not compile | `LinearWebhookClient` + `createHandler()` from `@linear/sdk/webhooks` | 3 |
| T6 | Invalid webhook signature returns **400**, not 401 | A 401 assertion in tests never fires | Assert 400 | 3 |
| T7 | Linear rate limiting is **HTTP 400** + `errors[].extensions.code === "RATELIMITED"` | Any `status === 429` branch is dead code that never runs | Match on the extension code, back off per the reset header | 5 |
| T8 | `@linear/sdk` ships a new **major roughly weekly** (86 to 93 in 15 weeks) | `^93` or `~93` guarantees an eventual silent breaking bump | Pin exact `93.0.1`, bump deliberately | all |
| T9 | Personal API key auth header has **no `Bearer` prefix** | 401 on every call | `Authorization: <KEY>` | 5 |
| T10 | `@ngrok/ngrok` does **not** read `NGROK_AUTHTOKEN` automatically, nor `~/.config/ngrok/ngrok.yml` | Tunnel fails to open with an auth error despite the env var being set | Pass `authtoken_from_env: true`; wizard lifts the token out of the YAML | 3, 8 |
| T11 | An MCP long-poll `ask_human` tool **does not block** the agent | Claude Code backgrounds a main-conversation MCP call past ~2 min; agent proceeds without the answer | Exit-and-`--resume` is the only reliable Q&A mechanism | 4, 6 |
| T12 | `typescript@latest` is now **7.0.2** (the Go-native `tsgo` rewrite) | Type-checking behaviour gaps against `@linear/sdk`'s ~74k-line `.d.ts` | Pin `~5.9` | 1 |
| T13 | `gh pr create` has **no `--json` flag** | Command errors out | Read the URL from stdout; `gh pr view --json` afterwards | 4 |
| T14 | Body-parsing before HMAC verification destroys the byte-exact raw body | Re-stringifying a parsed body produces signature mismatches (key order, unicode escaping) | No HTTP framework; let the SDK handler consume the raw stream | 3 |
| T15 | This machine runs **Node v22.23.1**; STACK.md recommends Node 24 (Active LTS) | Not fatal — `better-sqlite3@13` and `execa@10` both require only `>=22` — but the wizard's own preflight will flag the operator's box | Build against >=22; decide in Phase 8 whether the preflight hard-fails or warns on <24 | 1, 8 |

## Verified clean (do not "fix" these)

- **2026-09-06 — the entire pinned dependency set installs cleanly.** Verified by a real
  `npm install` in a scratch directory: 87 packages, 11 s, every pin resolving exactly as
  written in STACK.md. `typescript@~5.9` resolves to **5.9.3** (correctly not the TS7
  `tsgo` rewrite), `@linear/sdk@93.0.1`, `better-sqlite3@13.0.3` shipping a prebuilt
  `darwin-arm64.node` (no node-gyp, no Xcode CLT needed), and `@ngrok/ngrok-darwin-arm64`
  present via optionalDependencies. **Do not bump any pin.** If an install fails, the
  cause is local, not the version.

## Discovered during execution

| # | Trap | Failure mode | Correct move | Phase |
|---|------|--------------|--------------|-------|
| T16 | **`research/ARCHITECTURE.md`'s transition table predates the binding contract and uses STALE state names** — `claimed`, `worktree_ready`, `agent_running`, `done`, `abandoned`. None are in the locked nine. | Code written against them compiles in isolation and fails only at the final integration gate, with no attribution to a phase. Under rush mode nothing catches it earlier. | The binding nine in `01-CONTEXT.md`'s ADDENDUM win, always. Translation: `claimed`→`queued`, `worktree_ready`→`preparing`, `agent_running`→`running`, `done`→`delivered`\|`partial`, `abandoned`→`cancelled`\|`failed`. | all |
| T17 | **The same table encodes a bounded `failed → queued` auto-retry.** | Directly contradicts OPS-04 and 06-CONTEXT D-13 — a failed run is attempted exactly once. Building the retry produces duplicate PRs and burns API budget. | No retry machinery anywhere. Failure posts a diagnosis and leaves the branch and worktree for the operator. | 6 |
| T18 | **`research/SUMMARY.md` Invariant 7 says requeue every `running` row found at boot; 06-CONTEXT D-07 says fail it.** | Requeueing blind re-runs a ticket whose push status is unknowable, producing a second PR for work already pushed. | D-07 wins. Phase 7's clean shutdown marks children `queued` before exit, so a `running` row surviving to boot means an *unclean* exit — exactly the case that must not be replayed. | 6, 7 |
| T19 | **`listener.url()` returns `string \| null`** on `@ngrok/ngrok` | Unchecked, the reconciler registers `"null/linear/webhook"`. Daemon boots clean, reports healthy, and receives nothing — the worst failure shape in the project. | Assert non-null before registration; fail boot loudly. | 3 |
| T20 | **`webhookTimestamp` is MILLISECONDS** (proven twice: schema doc comment + live 200/400 test). The ±60s staleness check is **already in the SDK** — do not hand-roll it. | The SDK's check is wrapped in `if (timestamp)`, so an **absent** field silently skips replay protection and returns 200. Always-pass, looks like working code. | Do not reimplement the window; DO assert the field is present. | 3 |
| T21 | **`client.webhookCreate` does not exist** (confirmed by `tsc` TS2339) — those are GraphQL mutation names, not SDK methods. | Compile error at best; hours lost guessing at worst. | `createWebhook` / `updateWebhook` / `deleteWebhook`. D-02's re-enable is one call: `updateWebhook(id, {url, enabled: true})`. | 3 |
| T22 | **`fetchNext()` mutates and returns `this`**, appending into `page.nodes` | The intuitive pagination loop double-counts every page, so the reconciler classifies its own live webhook as a duplicate and **deletes it**. `PITFALLS.md`'s reconcile snippet does not paginate at all, so this gets written fresh with no guard. | Do not accumulate across `fetchNext()` calls — read `page.nodes` once after exhausting. | 3 |
| T23 | **Every `webhooks()` call pulls signing secrets into memory** (`WebhookFragment` selects `secret`, typed `string \| null \| undefined`) | One `log.info({webhooks})` in the reconciler leaks every signing secret to disk. | Never log a webhook object. The logger's global redaction list (02-CONTEXT D-05) must cover it. | 3, 2 |
| T24 | **ngrok's malformed-token error echoes the token back in its message** | `log.error(err)` writes the operator's authtoken to disk. | Never log a raw ngrok error object. Extract and log the code only. | 3 |
| T25 | **All ngrok errors carry `code: "GenericFailure"`** | `switch (err.code)` is dead code that never discriminates. Also: `authtoken_from_env: true` with the var unset fails *identically* to no credential, so TUN-03's "clear message" needs its own pre-check. | Discriminate on `ERR_NGROK_4018` / `ERR_NGROK_105` in the message text. | 3 |
| T26 | **Clean shutdown must mark in-flight runs `queued`, not leave them `running`.** The Phase 7 planner read 07-CONTEXT D-03 ("in-flight runs are marked") together with 06-CONTEXT D-07 ("`running` at boot fails with a diagnosis") and concluded a cleanly-stopped run gets *failed* on the next boot. | That conclusion is right given the two documents alone, and it makes Ctrl-C cost a manual restart of every live run. | Both decisions are correct **once shutdown writes the state**: a clean stop transitions `running`/`delivering` → `queued` before exit, so those rows requeue. D-07's fail-on-`running` then applies only to an **unclean** exit — exactly the case where push status is unknowable and replaying would produce a second PR. This is what T18 already asserts; the Phase 7 planner started before T18 was committed. Plan 07-05 must implement the transition, not just a log line. | 7, 6 |
| T27 | **`--permission-mode dontAsk` ALONE denies the `Write` tool and exits 0.** Measured: `decision_reason_type: "mode"`, nothing created, `is_error: false`, `subtype: "success"`. | Trap T1 verbatim — the exact silent-nothing failure Phase 4 exists to prevent, reached via the flag chosen to avoid it. | `dontAsk` **plus** `--allowedTools "Write" "Edit" "Bash"` — verified zero denials and a real git commit. Never `dontAsk` alone. | 4 |
| T28 | **Inherited `CLAUDE*` env vars break the spawned agent.** The same probe run from *inside* a Claude session (22 inherited vars) denied `Write` with `decision_reason_type: "asyncAgent"` — "no approval surface". | Permission behaviour depends on how the operator launched the daemon. Deleting two known keys is not enough. | Build the child env by **allowlist**, not denylist. This supersedes 04-CONTEXT D-15's two-key scrub. | 4 |
| T29 | **`SIGINT` to the process group kills only the leader.** Empirical matrix: `detached:true` + `process.kill(-pid,"SIGTERM")` reaped child *and* grandchild; SIGINT did not. `child.kill()` even when detached orphans the grandchild **and leaves the promise permanently pending**, because the survivor holds the stdout pipe. | A run that appears hung forever, with an orphaned agent still writing. | Escalation with liveness checks between steps is mandatory, not a courtesy. SIGINT-first is still correct for resumability but must not be relied on to reap. | 4 |
| T30 | **execa 10 has no `.on()`.** `PITFALLS.md`'s Pitfall-5 sample is `node:child_process` code. | Pasting it onto an execa handle crashes. | Use execa's own API surface; do not copy the pitfall snippet verbatim. | 4 |
| T31 | **Read `result.structured_output` (parsed object), not `result.result` (string)** for `--json-schema` output. And a resumed session's `stop_reason` becomes `"tool_use"`. | Any `stop_reason === "end_turn"` check is a bug that fires on every resumed session — i.e. on every answered question. | Verified: `--json-schema` DOES survive `--resume`, and the resumed session correctly recalled the prior turn. The D-16 Q&A design holds. | 4, 6 |

*(appended as waves hit them)*
