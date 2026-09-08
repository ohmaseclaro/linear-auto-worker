# How the agent is invoked

For the operator, not for the compiler. Everything below is decided in exactly one place —
`src/execution/agent-args.ts` — and asserted in `src/execution/agent-args.test.ts`.

The thing to understand before anything else: **every way this can be misconfigured exits
0 and reports success.** A run that is denied every tool, a run that never loaded the GSD
install, a run that produced nothing at all — all of them look identical from outside to a
run that worked. That is why the flag list is one module with three long comments, and why
`src/execution/verdict.ts` classifies on what is in the worktree rather than on the exit
code.

## The flags, and why each one is there

| Flag | Why |
|---|---|
| `-p` (bare, LAST) | Non-interactive. It carries **no value** and it is the **last** argv entry. Both halves are load-bearing — see "The prompt travels on stdin" below. |
| `--permission-mode dontAsk` | `claude` starts in **Manual** mode and denies every edit while still exiting 0. An explicit mode is mandatory. |
| `--allowedTools Write Edit Bash` | **Not optional.** Measured on CLI 2.1.259: `dontAsk` *alone* denies `Write` with `decision_reason_type: "mode"`, creates nothing, and exits 0 with `is_error: false`. The mode and the allowlist ship together or the product silently produces nothing. |
| `--output-format stream-json` | Structured progress events, so the worker can report to Linear as the run proceeds. |
| `--input-format stream-json` | The prompt (and anything `law say` adds later) arrives on the child's **stdin** as NDJSON, not in argv. This is what makes it possible to speak to a session that is already working. |
| `--replay-user-messages` | Every message written to stdin is echoed back as a `user` event. Two jobs: it is the daemon's only positive receipt that a message was consumed, and it is what puts the operator's own words into `law watch` beside the agent's reply. |
| `--verbose` | Mandatory with `stream-json`. Omitting it is a hard startup error, not a warning. |
| `--session-id <uuid>` | Pre-assigned by the worker and persisted to the run row **before** the spawn, so an answered question can resume the right session. Never parsed back out of the stream — 16 hook events precede `system/init`. |
| `--json-schema <schema>` | The final turn must be a JSON object matching `src/domain/agent-result.ts`. The parsed value arrives on `result.structured_output`. |
| `--permission-prompts none` | Nobody is present to answer a prompt. Redundant with the mode today; it guards a future change of default. |

The resume path (`buildResumeArgs`, used when a human answers a question) keeps the bare
`-p` and drops `--session-id`. Both halves matter: without `--print` the input format does
not apply at all, and reusing a spent session id is a hard error — `Session ID <uuid> is
already in use.`, exit 1. The answer itself travels on stdin, like every other message.

## The prompt travels on stdin

The prompt is **not in argv**. It is written to the child's stdin, synchronously and before
anything is read, as one NDJSON line:

```json
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"…"}]}}
```

`src/execution/agent-args.ts` defines that envelope once (`userMessageLine`) and both the
supervisor and `law say` import it.

**Why `-p` is still passed, bare, and last.** `--input-format` only works alongside
`--print`, so the flag stays. It carries no value because a value there is **silently
discarded and the session then hangs forever** — measured on CLI 2.1.263 as eight hook
events in 0.7 seconds followed by ninety seconds of complete silence. It is last because an
option following a bare `-p` can be eaten as its optional value.

This strengthens rather than weakens the containment claim the old `-p <prompt>` row made.
Hostile ticket text used to be one argv entry that no shell ever saw; now it does not reach
the argument array at all. It crosses into the child as a JSON string inside the envelope
above, so there is no quoting boundary in either direction.

## When stdin closes, and what that decides

**On the first `result` event, the daemon closes the child's stdin. That is the only thing
a `result` decides.**

The run itself ends when the **process exits**, exactly as it always has. A `result` is per
user message, not per run: a session the operator talks to emits one per message, and
`routed.result` is last-wins, so the operator's correction governs the verdict.

The consequence to know is the injection window: **spawn → first `result`**. That is the
whole time the agent is working, and it is when `law say` can reach it. A message written
before the close is still delivered — pipe bytes precede EOF — so the agent reads it, takes
another turn, emits another result, and only then exits. Once the turn has ended, `law say`
refuses with one clear line and the Linear comment path takes over.

**If nothing comes back within 60 seconds**, the daemon presumes the delivery failed and
reaps the session rather than waiting out `maxRunMs`. "Nothing" means neither a
`system/init` nor any replayed message — both of which a live session produces within a few
seconds (measured: 2.6s to init, 4.2s to the first echo, cold, with 113 skills).

## The flag that must never be added

**`--bare` is forbidden. No exceptions.**

The vendor documentation recommends it for scripted use and says it will become the default
for `-p`. Do not follow that advice here. `--bare` skips `~/.claude` auto-discovery, which
is exactly where this operator's global GSD install lives — the install this entire product
depends on. With it, every run silently produces generic, non-GSD work and exits 0.

`src/execution/event-router.ts` asserts that the required GSD skills are visible on
`system/init` as the runtime backstop for this rule.

## Running the allowlist probe

The allowlist is verified sufficient for a file write and a four-command git chain. It is
**not** verified against a real GSD phase run, which also reaches for `Task`, `Skill`,
`Glob`, `Grep` and `TodoWrite`. Until the probe below has passed once, `ALLOWED_TOOLS` is
an assumption whose failure mode is a run that produces nothing and reports success.

This is a **milestone integration-gate item**, run by a human, once, after `npm install`:

```
npx tsx scripts/probe-gsd-allowlist.ts
```

It creates a throwaway git repository in a temp directory (never a mapped repo), builds the
arguments and the environment by calling the product's own `buildClaudeArgs` and
`buildChildEnv`, and asks the agent for a small GSD-shaped task.

- **Pass** — exits 0. Zero permission denials, the required GSD skills present in
  `system/init`, `permissionMode` echoed back as `dontAsk`, and at least one new commit in
  the throwaway repository. The temp directory is deleted.
- **Fail** — exits 1 and prints every denied tool with its `decision_reason_type` and
  `tool_input`, followed by a suggested list. **Add those names to `ALLOWED_TOOLS` in
  `src/execution/agent-args.ts` and run it again.** The temp directory is left in place so
  you can look at what the agent did and did not manage to do.

It costs real money and takes minutes, so it is a script rather than a test: it imports
nothing from `node:test`, and it lives outside `src/`, which is the only directory `tsc`
compiles into `dist/`. `npm run verify` cannot fire it by accident.

## Accepted risks

Two, both deliberate, both requiring no action — but both worth knowing before you are
surprised by them.

### Every mapped repository is implicitly fully trusted

Because `--bare` is forbidden, the spawned session loads configuration the same way an
interactive session does. That includes the **mapped repository's own
`.claude/settings.json`**, whose hooks execute unprompted, and `-p` shows no trust dialog to
approve or decline them.

This is the correct trade — the alternative kills the GSD install the product depends on —
but it means **adding a repository to the mapping is a trust decision, not a configuration
change.** Map repositories you would be willing to `git clone` and run.

### The agent runs with the operator's full permissions

`Bash` in the spawned session can read anything you can, including credentials in
directories unrelated to the ticket. This is not fully mitigable for a single-operator tool
that exists to run an agent on your own machine.

What is mitigated: the child environment is built from `{}` by allowlist
(`src/execution/agent-env.ts`), so `LINEAR_API_KEY` and `NGROK_AUTHTOKEN` are withheld by
construction, and no inherited `CLAUDE*` variable reaches the child. And because `--bare` is
not passed, your global `~/.claude/settings.json` denials — including the deny rule on
reading `.env` files — are inherited by the spawned session.

## Reading the cost

The operator asks about this first, so: per-run cost is dominated by **cache creation on
the ~61k-token GSD system prompt**, not by the ticket. A one-word reply measured $0.25. A
long ticket is not meaningfully more expensive than a short one; a run with many turns is.

The two fields to look at, both on the `result` event and both carried through to the run
row: `total_cost_usd` and `num_turns`.
