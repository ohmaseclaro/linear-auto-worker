---
phase: 04-execution
plan: 03
subsystem: execution
tags: [agent, flags, prompt-injection, secrets, allowlist, probe]
requires:
  - src/domain/agent-result.ts (AgentResultSchema)
  - src/execution/event-router.ts (REQUIRED_GSD_SKILLS)
  - src/execution/stream-parser.ts (makeLineParser)
provides:
  - src/execution/agent-args.ts (PERMISSION_MODE, ALLOWED_TOOLS, OUTPUT_FORMAT, PERMISSION_PROMPTS, AGENT_RESULT_JSON_SCHEMA, buildClaudeArgs, buildResumeArgs)
  - src/execution/agent-env.ts (buildChildEnv)
  - src/execution/prompt.ts (sanitizeUntrustedText, UNTRUSTED_OPEN, UNTRUSTED_CLOSE, buildAgentPrompt)
  - scripts/probe-gsd-allowlist.ts (the milestone integration-gate probe)
  - docs/agent-invocation.md (operator trust document)
affects:
  - Phase 6 (buildResumeArgs is the resume path; the prompt states the result contract)
  - Phase 7 (AgentResult reconciliation — see Contract additions requested)
tech-stack:
  added: []
  patterns:
    - one shared `commonArgs()` so the fresh and resumed sessions cannot be granted differently
    - hostile characters in tests built from codepoints, never pasted
    - the probe imports the product's own builders rather than copying the flag list
key-files:
  created:
    - src/execution/agent-args.test.ts
    - src/execution/agent-env.test.ts
    - src/execution/prompt.test.ts
    - scripts/probe-gsd-allowlist.ts
    - docs/agent-invocation.md
  modified:
    - src/execution/agent-args.ts
    - src/execution/agent-env.ts
    - src/execution/prompt.ts
decisions:
  - "The --json-schema payload now aliases AgentResultSchema from src/domain/, per the plan's binding key_link. That moves the contested AgentResult shape onto the domain's side (complete/failed/assumptionIfUnanswered), which agrees with src/orchestration/run-engine.ts and with parseAgentResult. One consumer still disagrees on one field name and is filed below."
  - "Both argument lists are built from a single commonArgs(), so a resumed session cannot be granted a narrower tool set than the session it resumes."
  - "The untrusted delimiter is defanged in the body AFTER stripping, not before — stripping afterwards could reassemble a closing tag out of a form split by an invisible character."
metrics:
  duration: ~35m
  completed: 2026-09-06
status: complete
---

# Phase 4 Plan 03: Agent Invocation Surface Summary

The flag list, the child environment and the prompt trust boundary are complete, and each
of the three `claude -p` misconfigurations that fail with exit 0 now has a named test that
goes red if anyone reintroduces it.

## What was built

| File | What it now guarantees |
|---|---|
| `agent-args.ts` | Four named flag constants; one `commonArgs()` feeding both the fresh and the resume path; the `--json-schema` payload taken from `src/domain/agent-result.ts`; three load-bearing comments (T27 allowlist, T3 verbose pairing, T2 `--bare`). |
| `agent-args.test.ts` | Nine tests. T1/T27 asserts the mode **and** its allowlist in one test; T2 asserts on the array while the source keeps the comment; T3 is written as an implication; T57 covers the resume path; one test asserts a hostile prompt is a single argv entry. |
| `agent-env.ts` | Unchanged behaviour, plus the comment naming T56 — this function is only half the boundary, `extendEnv: false` at the spawn is the other half. |
| `agent-env.test.ts` | Pollutes `process.env` with both secrets and four `CLAUDE*` variables (one invented) before asserting, and asserts by key prefix rather than by name. |
| `prompt.ts` | `UNTRUSTED_OPEN`/`UNTRUSTED_CLOSE` exported; the body is defanged so it cannot close the block; the result paragraph now names the domain schema's own fields. |
| `prompt.test.ts` | One assertion per stripped class (all built from codepoints), tab/newline/CR asserted to survive, delimiter balance, and a test showing stripping alone is insufficient. |
| `scripts/probe-gsd-allowlist.ts` | The open question made runnable, importing `buildClaudeArgs`, `buildChildEnv`, `REQUIRED_GSD_SKILLS` and `makeLineParser` from the product. |
| `docs/agent-invocation.md` | The flag table, the forbidden flag, the probe command, both accepted risks, and how to read the cost. |

## Contract additions requested

**1. `AgentResult` — `assumption` vs `assumptionIfUnanswered`. One field name, and it is
the whole Q&A path.** (TRAPS T58; highest priority item here.)

`src/execution/agent-args.ts` now carries the domain's schema, as the plan's `key_link`
requires. `src/domain/agent-result.ts` names the field `assumptionIfUnanswered`;
`src/execution/verdict.ts:79` reads `structured.assumption`. With the domain schema in
force, `additionalProperties: false` means the agent **cannot** return `assumption`, so
`verdict.ts` will hand Phase 6 a `needs_input` classification with `assumption: undefined`
on every question the agent ever asks.

Phase 7 picks one name and applies it in **one** of two one-line places:

```ts
// EITHER — src/execution/verdict.ts (not owned by this plan, deliberately not edited)
assumption: structured.assumptionIfUnanswered,
// and src/execution/verdict.ts's AgentStructuredOutput gains the field.

// OR — src/domain/agent-result.ts renames the schema property and the parser field
// to `assumption`, matching Phase 4's live-verified probe against CLI 2.1.259.
```

Recommendation: **rename the domain field to `assumption`.** It is what the CLI was
actually observed returning, it is shorter in a prompt the agent must follow precisely, and
`verdict.ts` + `prompt.ts` + the research transcript already use it. If instead the domain
name wins, `prompt.ts`'s closing paragraph is already written to it and needs no change —
only `verdict.ts` does.

Related but already settled by this plan: `status`. The domain's
`complete | needs_input | failed` is now what ships. `verdict.ts` never read `'delivered'`
(it derives that verdict from commit evidence, not from the agent's word), so nothing
breaks there.

**2. `AgentResultSchema` is `as const`, so it is deeply `readonly`.** `agent-args.ts`
widens it to `object` at the re-export (`AGENT_RESULT_JSON_SCHEMA: object`) because
`ClaudeArgsInput.schema` is `object`. If Phase 7 wants a stronger type on the seam, the
suggested addition is a plain structural type in `src/domain/agent-result.ts`:

```ts
export type JsonSchemaDocument = Readonly<Record<string, unknown>>;
```

No other contract additions. Nothing under `src/domain/` was created or edited (RUSH rule 3).

## Deviations from Plan

### Auto-fixed issues

**1. [Rule 1 — bug] The prompt told the agent to return a status the schema forbids.**
- **Found during:** Task 2, after Task 1 switched `--json-schema` to the domain schema.
- **Issue:** `prompt.ts` instructed the agent to end with status `"delivered"`. The domain
  schema enumerates `complete | needs_input | failed` and sets
  `additionalProperties: false`, so the agent would have been asked for a value it cannot
  emit — producing either a schema violation or a silently wrong status, on every run.
- **Fix:** the closing paragraph now names the domain's own field set exactly, including
  `prTitle`/`prBody` on `complete` and `question`/`assumptionIfUnanswered` on
  `needs_input`, with a comment saying where the names come from and why inventing one is
  impossible.
- **Commit:** 815d4ac

**2. [Rule 2 — missing critical functionality] The untrusted delimiter was not defanged.**
- **Issue:** `buildAgentPrompt` wrapped the sanitized body in `<untrusted-ticket-data>`
  but did nothing about a body that contains the closing form. A ticket that emits
  `</untrusted-ticket-data>` closes the quotation, and everything after it is read as
  trusted instruction — which defeats D-14's entire second layer while the first layer
  still looks intact.
- **Fix:** `defangDelimiter()` rewrites both forms to a square-bracket variant, applied
  **after** stripping. `prompt.test.ts` asserts exactly one balanced pair given a body
  containing both forms.
- **Commit:** 815d4ac

### Deliberate scope decisions

**3. `src/execution/verdict.ts` was NOT edited**, although item 1 of
`Contract additions requested` is a one-line fix there. It belongs to plan 04-01 and four
siblings are running in parallel; a cross-plan edit is how a merge becomes unmergeable
under rush mode. It is filed instead, with both fixes written out.

**4. STATE.md / ROADMAP.md / REQUIREMENTS.md were not updated.** Five executors are running
in parallel worktrees off the same base commit; concurrent `state.advance-plan` calls
produce a garbage merge. The orchestrator owns these files for this milestone.

**5. Hostile characters in `prompt.test.ts` are built with `String.fromCodePoint(0x…)`
rather than written as `\u` escapes**, and each row is labelled with its codepoint in
prose (`'u200B zero-width space'`). Same guarantee the plan asked for — no literal
invisible character in source — reached by a route that cannot be corrupted by a tool that
normalises escape sequences on the way to disk. The plan's own verify grep (`u0000` present
in the test file) passes.

## TDD Gate Compliance

Both TDD tasks show RED then GREEN in the log:

- Task 1 — RED `0451e2c test(04-03): one failing test per quiet claude -p misconfiguration`
  (`OUTPUT_FORMAT` and `PERMISSION_PROMPTS` did not exist), GREEN `7a91eec feat(04-03)`.
- Task 2 — RED `63990c6 test(04-03): child-env allowlist …` (`UNTRUSTED_OPEN`/`_CLOSE` were
  not exported), GREEN `815d4ac feat(04-03)`.
- No REFACTOR commit was needed.

**Warning: neither gate was executed.** RUSH rule 2 forbids `npm install`, `tsc` and
`node --test`. The milestone's single integration gate
(`tsc && node --test "dist/**/*.test.js"`) is the first run of these three test files.

## Known Stubs

None. Every module ships a real implementation.

One thing is deliberately unverified and is the most important line in this summary:

| Item | Why it is open | Who closes it |
|---|---|---|
| `ALLOWED_TOOLS = ['Write','Edit','Bash']` is sufficient for a real GSD run | Verified for a file write and a four-command git chain with zero denials; **not** verified against a GSD phase run, which also uses Task, Skill, Glob, Grep and TodoWrite. Under-granting reproduces the silent-nothing failure exactly. | A human, once, at the milestone integration gate: `npx tsx scripts/probe-gsd-allowlist.ts`. It prints the exact tool names to add. Documented in `docs/agent-invocation.md`. **Never a plan gate** (D-01 amended). |

## Threat Flags

None new. Mitigation notes against the plan's register:

- **T-04-14** (`prompt.ts`): both D-14 layers present, each with its own tests. Seven
  stripped character classes, three kept whitespace characters, and the delimiter is now
  unclosable from inside the body.
- **T-04-15** (`agent-env.ts`): allowlist from `{}`, asserted against a deliberately
  polluted `process.env` including an invented `CLAUDE_FUTURE_VARIABLE`. The `extendEnv:
  false` half of the boundary lives at `supervisor.ts:76` and is now cross-referenced from
  this module so removing it there has a paper trail here.
- **T-04-16** (`agent-args.ts`): mode and allowlist asserted in one test, on purpose — two
  passing tests would both stay green while the pair drifted apart.
- **T-04-17** (`agent-args.ts`): a prompt containing a newline, a quote, a `$(...)` and a
  backtick sequence is asserted to reach the array as exactly one entry, with the array
  length unchanged.
- **T-04-18 / T-04-19** (accepted): both written up in `docs/agent-invocation.md` in terms
  an operator can act on — mapping a repository is a trust decision because `--bare` is
  forbidden, and the agent runs with full user permissions.
- **T-04-20** (probe): `mkdtemp` under `os.tmpdir()`, `git init` there, never a mapped
  repo; spawned with `buildChildEnv()` and `extendEnv: false`.
- **T-04-SC**: nothing installed. The three modules import only Node builtins and
  `src/domain/`; the probe additionally imports `execa@10.0.1`, already pinned.

## Verification

Every `<verify>` block from all three tasks was run as written.

| Check | Expected | Actual |
|---|---|---|
| Task 1 files exist | `FILES_OK` | `FILES_OK` |
| `--bare` on non-comment lines of `agent-args.ts` | 0 | 0 |
| `--bare` mentioned at all (the D-02 comment) | ≥1 | 2 |
| `T27` / `T2` / `T3` in `agent-args.test.ts` | ≥1 each | 2 / 3 / 2 |
| `allowedTools` / `dontAsk` / `verbose` / `buildResumeArgs` | ≥1 each | 4 / 3 / 4 / 5 |
| `session-id` in `agent-args.test.ts` | ≥1 | 5 |
| `agent-result` in `agent-args.ts` | ≥1 | 2 |
| Task 2 files exist | `FILES_OK` | `FILES_OK` |
| `process.env)` / `process.env }` on non-comment lines of `agent-env.ts` | 0 | 0 / 0 |
| `CLAUDE_CODE_MESSAGING_SOCKET` / `LINEAR_API_KEY` / `NGROK_AUTHTOKEN` / `startsWith` | ≥1 each | 1 / 4 / 2 / 1 |
| literal zero-width or bidi codepoint in `prompt.ts` | 0 | 0 |
| `sanitizeUntrustedText` / `u200B` / `E0000` / `untrusted` | ≥1 each | 3 / 1 / 1 / 5 |
| `pull request` / `push` in `prompt.ts` | ≥1 each | 1 / 4 |
| `u0000` / tab-or-newline escape in `prompt.test.ts` | ≥1 each | 1 / 2 |
| Task 3 files exist | `FILES_OK` | `FILES_OK` |
| `agent-args` / `agent-env` / `stream-parser` in the probe | ≥1 each | 3 / 1 / 1 |
| `permission_denials` / `permissionMode` / `skills` | ≥1 each | 1 / 5 / 7 |
| `mkdtemp|tmpdir` / `git` in the probe | ≥1 each | 3 / 10 |
| `from 'node:test'` in the probe | 0 | 0 |
| `accepted risk` / `settings.json` / `probe-gsd-allowlist` / `total_cost_usd` in the doc | ≥1 each | 1 / 2 / 1 / 1 |

Additional check, not required by the plan: `git diff --name-only` against the branch base
returns exactly the eight declared files. No file in `src/execution/` outside the three this
plan owns was touched, and `execute-run.ts` is untouched.

Not run, per RUSH rule 2: `npm install`, `tsc`, `node --test`, and any real `claude`, `git`
or `gh` invocation beyond this worktree's own commits.

## Self-Check: PASSED

All eight files exist on disk. All five commits exist in `git log`: `0451e2c`, `7a91eec`,
`63990c6`, `815d4ac`, `a377d5b`.
