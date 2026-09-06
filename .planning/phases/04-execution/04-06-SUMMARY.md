---
phase: 04-execution
plan: 06
subsystem: execution
tags: [delivery, security-gates, github, pr]
requires: ["04-01"]
provides:
  - "gates.runPrePushGates / findSecrets / touchesCiPaths / assertPushAllowed"
  - "pr-body.renderPrBody"
  - "deliver.deliver (gates -> push -> gh pr list -> gh pr create)"
affects: ["04-01 (deliver call site)", "05 (terminal comment consumes ciPaths)", "07 (integration)"]
tech-stack:
  added: []
  patterns: ["pure-function gates over text", "injected argv-array command runner", "idempotent create via pre-check"]
key-files:
  created:
    - src/execution/gates.test.ts
    - src/execution/pr-body.ts
    - src/execution/deliver.test.ts
  modified:
    - src/execution/gates.ts
    - src/execution/deliver.ts
decisions:
  - "Gates are pure functions over text and run no git commands — that is what makes it structurally impossible for a gate to end up downstream of the push."
  - "The PR body is rendered INSIDE deliver, after the gates, because the CI flag does not exist until the gates have run."
  - "The existing-PR URL is constructed from owner/repo + number rather than read back, because the only gh flag that returns a URL is the machine-readable flag T13 forbids in this file."
metrics:
  duration: ~25m
  completed: 2026-09-06
status: complete
---

# Phase 04 Plan 06: Pre-push gates and worker-owned PR Summary

Three blocking pre-push gates as pure functions over diff text, a five-section worker-owned
PR body that opens with a CI-touch warning, and a `deliver()` that runs gates → push →
`gh pr list` → `gh pr create` with the URL read off stdout.

## What was built

### `src/execution/gates.ts` (DELV-04, DELV-08, DELV-09)

Every gate is a pure function over text. None runs git; the caller collects the diff and the
changed-file list and passes them in. This is the safety property, not a testability
nicety — a function that cannot execute a command cannot be reordered below the push.

| Export | Disposition | Notes |
|---|---|---|
| `assertPushAllowed({branch, defaultBranch})` | **refuse** | Exact string compare, throws `DeliveryError`. `main-something` is an ordinary branch. |
| `findSecrets(diff): SecretHit[]` | **block** | Eight credential shapes + environment files by path. |
| `touchesCiPaths(files): string[]` | **flag** | Segment-matched. Returns paths, never a boolean. |
| `runPrePushGates(o)` | composes all three | `{refusal?, block?, hits, ciPaths}` — one thing for the caller to check. |

Secret patterns: `ghp_`, `github_pat_`, `sk-ant-`, `lin_api_`, `xoxb-`, `AKIA`, PEM private
key header, and a broad `sk-` last so a hit reports the narrowest name that matched.

Three properties that mattered more than the pattern list:
- **Only added lines are scanned.** A diff *removing* a secret is the agent cleaning up;
  blocking it would make the guardrail punish the fix.
- **The report locates the hit and never echoes the value.** `SecretHit` has no field for
  the matched text — a report that carries the secret writes it to a second place (a log, a
  Linear comment, the PR body) and makes the disclosure worse than the commit did.
- **Flag and block are different dispositions.** Conflating them either blocks legitimate CI
  work or invites someone to relax the secret block to unblock it. `.env.example` is
  likewise not blocked; the deliberately-checked-in shape is not the leak.

`.claude/**` is in the CI set: a diff that edits the agent's own settings deserves the same
prominence as one that edits a workflow.

The honest limit is stated in the file: this is a guardrail against an agent committing a
fixture, not a defence against an adversary. A fixed regex set misses anything base64'd,
split across lines, or from a provider not listed.

### `src/execution/pr-body.ts` (DELV-03, DELV-08)

`renderPrBody(o): string`, pure. Five sections, none optional and none ever empty: Ticket,
Summary, Tests, What I did not do, Run log. When `ciPaths` is non-empty the body **opens**
with a `> [!WARNING]` block naming every path — prominent means first, not present.

- *Tests* renders `Result: **not run**` rather than a blank. Under rush constraints that is
  usually the true answer, and a reviewer told plainly is better off than one reading a
  blank as "passed".
- *What I did not do* is never empty; a `partial` run says it was cut short.
- The agent-authored summary is fenced with a run **one backtick longer than the longest run
  in the content**, so "just close the fence" does not work. Test asserts the forged
  `## Tests` / `Result: passed` inside the summary does not become a template heading and
  does not displace the template's own `Result: **not run**`.

### `src/execution/deliver.ts` (DELV-01, DELV-02, D-12, D-13)

Sequence, all through the injected `runCommand` (no `execa` import):

1. `git diff --name-only <base>..HEAD` and `git diff <base>..HEAD` — the only commands
   upstream of the gates, both read-only.
2. `runPrePushGates` → a refusal or a block throws `DeliveryError` here. No push, no PR.
3. `git -C <wt> push -u <remote> refs/heads/<branch>` — one fully-qualified ref (an
   ambiguous ref can resolve to a tag of the same name). No forcing flag exists in the file
   in any spelling.
4. `gh pr list --head <branch> -R <owner/repo> --state open` — existing PR returned,
   nothing created.
5. Body rendered, written to a real file (`--body-file` needs a path), then
   `gh pr create -R … --base … --head … --title … --body-file …` plus `--draft` unless the
   mapping toggle says ready and the verdict is not `partial`.
6. PR URL = last non-empty stdout line. **`gh pr create` has no machine-readable flag on
   2.98.0** (T13) — commented in the file, because it is the obvious thing to reach for.

The title goes through `sanitizeUntrustedText` (reused from `prompt.ts`, not reimplemented)
before it becomes an argv entry and a page heading.

Returns `{prUrl, ciPaths, ciTouched, draft, alreadyExisted}` — a superset of the tracer's
`{prUrl, ciTouched}`, so `execute-run.ts` compiles **unchanged**.

## Deviations from Plan

**1. [Rule 3 — blocking] `touchesCiPaths` return type changed `boolean` → `string[]`**
- The plan requires the paths in both the PR body and the terminal comment. The tracer's
  boolean cannot carry them. `deliver.ts` was the only caller.
- `CI_PATH_PREFIXES` is renamed `CI_PATH_DIRS` (segment-matched, no trailing slash) and
  `CI_PATH_FILES` now matches on basename at any depth.
- Commit: `902a78e`

**2. [Rule 3 — blocking] `DeliverInput.body` kept as an optional fallback**
- The plan has `deliver` render the body (it must, since the CI flag does not exist until
  the gates run), but `execute-run.ts` — which this plan may not edit — passes a
  pre-rendered `body: string`. Making `prBody` required would not compile.
- `body?: string` is retained and documented as superseded; when `prBody` is absent it is
  rendered as the summary, so the CI flag still reaches the top of the body. See
  *Contract additions requested* below for the one-line fix Phase 7 should apply.
- Commit: `7ed9b1a`

**3. [Rule 1 — bug] Diff line-number counting**
- `\ No newline at end of file` markers were incrementing the new-side line counter,
  shifting every subsequent located hit by one. A located report that points at the wrong
  line is worse than no line at all.
- Commit: `7ed9b1a`

## Contract additions requested

Phase 7 (or whoever reconciles `execute-run.ts`) should apply these. Nothing here blocks the
current branch — it compiles and behaves correctly without them, it just delivers the tracer's
minimal body instead of the DELV-03 template.

**1. `execute-run.ts` — pass `prBody` and `verdict` instead of `body`.** Exact replacement
for the current `deliver({...})` call at `execute-run.ts:230`:

```ts
const delivery = await deliver({
  runCommand,
  worktreePath: worktree.path,
  branch: worktree.branch,
  base,
  ownerRepo: input.mapping.ownerRepo,
  defaultBranch: input.mapping.defaultBranch,
  title: `${input.issue.identifier}: ${sanitizeUntrustedText(input.issue.title)}`,
  prBody: {
    ticketIdentifier: input.issue.identifier,
    ticketUrl: input.issue.url,
    summary: classification.summary,
    runLogPath: /* the per-run log path — see item 2 */ undefined,
    verdict: classification.verdict === 'partial' ? 'partial' : 'delivered',
  },
  draft: input.mapping.draftPr,
  verdict: classification.verdict === 'partial' ? 'partial' : 'delivered',
});
```

Note `draft` no longer needs the `|| verdict === 'partial'` clause — `deliver` enforces it,
so the invariant lives in one place instead of two. `buildPrBody()` in `execute-run.ts`
becomes dead and should be deleted.

**2. A per-run log path on `ExecutionOutcome` / `ExecuteRunInput`.** DELV-03 requires the run
log path in the PR body and nothing currently exposes one. Requested signature:

```ts
// src/execution/execute-run.ts
export interface ExecuteRunInput {
  // ...existing
  /** Absolute path to this run's log file. Rendered into the PR body (DELV-03). */
  runLogPath?: string;
}
```

**3. `testCommand` / `testResult` on the agent result, or a worker-run test step.** DELV-03's
"test command and its result" has no source. `renderPrBody` renders `**not run**` when both
are absent, which is honest but permanent. Requested addition to whichever `AgentResult`
shape wins T58's reconciliation:

```ts
testCommand?: string;   // what was run, verbatim
testResult?: string;    // what happened
didNotDo?: string;      // the agent's own account of what it left alone
```

`renderPrBody` already accepts all three.

## Known Stubs

| Stub | File / line | Reason |
|---|---|---|
| PR URL for an existing PR is **constructed** as `https://github.com/<owner/repo>/pull/<n>` | `deliver.ts` `findOpenPrUrl` | The only `gh` flag that returns a real URL is the machine-readable flag T13 forbids elsewhere in this file. Correct on github.com; a GitHub Enterprise host needs the field read back. Marked `ponytail:` in the source with the upgrade path. |
| `testCommand` / `testResult` / `didNotDo` / `runLogPath` are never populated | `pr-body.ts` inputs | No caller supplies them yet — see *Contract additions requested* 2 and 3. Renders as explicit "not run" / "recorded nothing", never as a blank. |
| `gh pr list` output parsed as "first integer of the first non-empty line" | `deliver.ts` `findOpenPrUrl` | Non-TTY `gh pr list` emits TSV with the PR number first. Could not be verified live — rush mode forbids `gh` calls. **Confirm at the integration gate.** |

## Threat Flags

None. No new security surface beyond what the plan's `<threat_model>` already registers
(T-04-33 … T-04-39, all `mitigate`, all implemented).

## Rush-mode compliance

- No `npm install`, no `tsc`, no `node --test`.
- **No push, no `gh` invocation, no pull request created.** The only git commands run were
  `status`, `add`, `commit -n`, `log`, `diff` and `rev-parse` inside this worktree.
- `src/execution/execute-run.ts` is byte-identical to the branch point (verified:
  `git diff ac43208 -- src/execution/execute-run.ts` is empty).
- `src/domain/` untouched.
- Tests written, not run. Both test files live inside `src/` (T41).
- No enums, namespaces or constructor parameter properties (T35).

## Verification

All of the plan's `<verify>` grep gates were run and pass:

- must-be-zero: `--force` 0, `force-with-lease` 0, `--json` 0, `from 'execa'` 0 in
  `deliver.ts` non-comment lines; `runCommand` 0 and `await ` 0 in `pr-body.ts`;
  `runCommand` 0 and `execa` 0 in `gates.ts`.
- must-be-nonzero: all seven secret patterns and all five CI paths present in `gates.ts`;
  all four gate exports present; `--base`/`--head`/`--body-file`/`--draft`/`refs/heads/`/
  `runPrePushGates`/`sanitizeUntrustedText`/`pr…list` present in `deliver.ts`; all five
  DELV-03 section words present in `pr-body.ts`; `alreadyExisted`/`draft`/`gates` present
  in `deliver.test.ts`.

## Self-Check: PASSED

- `src/execution/gates.ts` — FOUND
- `src/execution/gates.test.ts` — FOUND
- `src/execution/pr-body.ts` — FOUND
- `src/execution/deliver.ts` — FOUND
- `src/execution/deliver.test.ts` — FOUND
- commit `902a78e` — FOUND
- commit `7ed9b1a` — FOUND
