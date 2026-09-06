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
| `-p <prompt>` | Non-interactive. The prompt is a single argv entry, so a Linear issue title cannot break out of it — there is no shell anywhere on this path. |
| `--permission-mode dontAsk` | `claude` starts in **Manual** mode and denies every edit while still exiting 0. An explicit mode is mandatory. |
| `--allowedTools Write Edit Bash` | **Not optional.** Measured on CLI 2.1.259: `dontAsk` *alone* denies `Write` with `decision_reason_type: "mode"`, creates nothing, and exits 0 with `is_error: false`. The mode and the allowlist ship together or the product silently produces nothing. |
| `--output-format stream-json` | Structured progress events, so the worker can report to Linear as the run proceeds. |
| `--verbose` | Mandatory with `stream-json`. Omitting it is a hard startup error, not a warning. |
| `--session-id <uuid>` | Pre-assigned by the worker and persisted to the run row **before** the spawn, so an answered question can resume the right session. Never parsed back out of the stream — 16 hook events precede `system/init`. |
| `--json-schema <schema>` | The final turn must be a JSON object matching `src/domain/agent-result.ts`. The parsed value arrives on `result.structured_output`. |
| `--permission-prompts none` | Nobody is present to answer a prompt. Redundant with the mode today; it guards a future change of default. |

The resume path (`buildResumeArgs`, used when a human answers a question) keeps `-p` and
drops `--session-id`. Both halves matter: without `-p` the session resumes and is never
told the answer, and reusing a spent session id is a hard error — `Session ID <uuid> is
already in use.`, exit 1.

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
