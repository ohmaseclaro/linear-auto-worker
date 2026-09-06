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

## Discovered during execution

*(appended as waves hit them)*
