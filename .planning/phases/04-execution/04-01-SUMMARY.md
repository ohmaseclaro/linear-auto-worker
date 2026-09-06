---
phase: 04-execution
plan: 01
subsystem: execution
tags: [agent, worktree, supervision, delivery, tracer]
requires:
  - src/domain/types.ts (RunId, SessionId)
  - src/domain/errors.ts (LawError, WorktreeError, DeliveryError)
  - src/infra/logger.ts (Logger)
provides:
  - src/execution/execute-run.ts (executeRun — the composition root for one run)
  - src/execution/agent-args.ts (the single source of every claude flag)
  - src/execution/agent-env.ts (buildChildEnv — allowlist)
  - src/execution/prompt.ts (the trust boundary)
  - src/execution/stream-parser.ts (carry-buffer NDJSON)
  - src/execution/event-router.ts (init assertion, result capture)
  - src/execution/supervisor.ts (spawn + drain)
  - src/execution/worktree.ts (prepare/remove)
  - src/execution/verdict.ts (evidence-based classification)
  - src/execution/gates.ts (pre-push gates)
  - src/execution/deliver.ts (push + gh pr create)
affects:
  - plans 04-02 … 04-06 (build against these signatures without editing execute-run.ts)
  - Phase 6 orchestration (calls executeRun and buildResumeArgs)
tech-stack:
  added: []
  patterns:
    - dependency injection of `runCommand` and `spawn` so the whole path is testable with no git/gh/claude
    - type-only back-edges (`import type { RunCommand } from './execute-run.js'`) to keep one home per type with no runtime cycle
key-files:
  created:
    - src/execution/execute-run.ts
    - src/execution/worktree.ts
    - src/execution/agent-args.ts
    - src/execution/agent-env.ts
    - src/execution/prompt.ts
    - src/execution/stream-parser.ts
    - src/execution/event-router.ts
    - src/execution/supervisor.ts
    - src/execution/verdict.ts
    - src/execution/gates.ts
    - src/execution/deliver.ts
    - src/execution/execute-run.test.ts
  modified: []
decisions:
  - "The agent result JSON schema lives in agent-args.ts, not src/domain/ — the domain module the plan named does not exist and src/orchestration/ has independently assumed a differently-shaped AgentResult. Reconciling is Phase 7's; a second copy under src/domain/ is what RUSH rule 3 forbids."
  - "buildResumeArgs keeps -p alongside --resume (it is how the human's answer reaches the new turn) and drops --session-id (a spent id is a hard error)."
  - "execa is spawned with extendEnv: false — without it execa merges the given env over process.env and the allowlist withholds nothing."
metrics:
  duration: ~45m
  completed: 2026-09-06
status: complete
---

# Phase 4 Plan 01: Execution Tracer Summary

One Linear issue travels the whole execution path — daemon-owned worktree, supervised
`claude -p`, evidence-based verdict, gated worker-owned push, open PR — through eleven
modules whose exported signatures are now fixed for plans 02-06.

## What was built

| Module | Responsibility this plan fixed |
|---|---|
| `execute-run.ts` | Composition root. Steps 1-7 in order, `execa` default for `runCommand`. |
| `worktree.ts` | Daemon-owned root, Linear `branchName` verbatim, detached-HEAD assertion. |
| `agent-args.ts` | Every claude flag. Mode + allowlist in one array. `--bare` documented, unemitted. |
| `agent-env.ts` | Child env from `{}` by allowlist. |
| `prompt.ts` | Sanitize + delimit + state the commit-only contract. |
| `stream-parser.ts` | Carry-buffer NDJSON. Pure. |
| `event-router.ts` | `system/init` assertion (GSD skills + echoed permissionMode); `result` capture. |
| `supervisor.ts` | Detached spawn, both streams drained, no kill (plan 05 owns it). |
| `verdict.ts` | Pure classification. Exit code is not passed in at all. |
| `gates.ts` | `assertPushAllowed` + `touchesCiPaths`. |
| `deliver.ts` | Gate → push one named ref → `gh pr create` → URL from stdout. |

## Exported signatures

Plans 02-06 can code against this section without reading the source.

### `execute-run.ts`

```ts
export interface RunCommandResult { exitCode: number; stdout: string; stderr: string }
export interface RunCommandOptions { cwd?: string; reject?: boolean }   // reject defaults true
export type RunCommand = (
  file: string, args: readonly string[], options?: RunCommandOptions
) => Promise<RunCommandResult>;

export interface ExecuteRunIssue {
  identifier: string; title: string; description: string; branchName: string; url: string;
}
export interface ExecuteRunMapping {
  repoPath: string; ownerRepo: string; defaultBranch: string; draftPr: boolean; maxRunMs: number;
}
export interface ExecuteRunInput {
  runId: RunId; issue: ExecuteRunIssue; mapping: ExecuteRunMapping; daemonDir: string;
}
export interface ExecutionStore {
  updateRun(runId: RunId, patch: {
    sessionId?: SessionId; branch?: string; worktreePath?: string; prUrl?: string; updatedAt?: number;
  }): void | Promise<void>;
}
export interface ExecuteRunDeps {
  store: ExecutionStore; log: Logger; runCommand?: RunCommand; spawn?: AgentSpawn;
}
export type ExecutionVerdict = 'delivered' | 'partial' | 'failed' | 'needs_input';
export interface ExecutionOutcome {
  verdict: ExecutionVerdict; prUrl?: string; branch: string; worktreePath: string;
  sessionId: SessionId; costUsd: number; numTurns: number; question?: string; assumption?: string;
}

export function executeRun(input: ExecuteRunInput, deps: ExecuteRunDeps): Promise<ExecutionOutcome>;
```

`ExecutionVerdict` lives here rather than in `verdict.ts` so that `verdict.ts` stays a leaf.

### `worktree.ts`

```ts
export interface PreparedWorktree { branch: string; path: string }
export interface PrepareWorktreeInput {
  runCommand: RunCommand; repoPath: string; repoSlug: string;
  daemonDir: string; branchName: string; base: string;
}
export function prepareWorktree(o: PrepareWorktreeInput): Promise<PreparedWorktree>;

export interface RemoveWorktreeInput { runCommand: RunCommand; repoPath: string; path: string }
export function removeWorktree(o: RemoveWorktreeInput): Promise<void>;
```

Worktree path is `${daemonDir}/worktrees/${repoSlug}/${branch}`; `repoSlug` is supplied by
the caller (`execute-run.ts` passes `ownerRepo.replace('/', '-')`).
**Plan 02** adds collision suffixing inside `prepareWorktree` (its return value already
carries `branch`, so callers need no change) and the boot reconcile as new exports.

### `agent-args.ts`

```ts
export const PERMISSION_MODE = 'dontAsk';
export const ALLOWED_TOOLS: readonly string[];              // ['Write','Edit','Bash']
export const AGENT_RESULT_JSON_SCHEMA: object;
export interface ClaudeArgsInput { sessionId: string; prompt: string; schema: object }
export function buildClaudeArgs(o: ClaudeArgsInput): string[];
export function buildResumeArgs(o: ClaudeArgsInput): string[];
```

### `agent-env.ts`

```ts
export function buildChildEnv(runId: string): NodeJS.ProcessEnv;
```

### `prompt.ts`

```ts
export function sanitizeUntrustedText(s: string): string;
export interface AgentPromptInput {
  identifier: string; title: string; description: string; url: string; branch: string;
}
export function buildAgentPrompt(o: AgentPromptInput): string;
```

### `stream-parser.ts`

```ts
export interface LineParser { push(chunk: string): void; flush(): void }
export function makeLineParser(
  onEvent: (event: unknown) => void, onBad: (line: string) => void
): LineParser;
```

### `event-router.ts`

```ts
export const REQUIRED_GSD_SKILLS: readonly string[];
export interface PermissionDenial { tool_name: string; tool_use_id: string; tool_input: unknown }
export interface SystemInitEvent {
  session_id?: string; cwd?: string; skills?: string[]; permissionMode?: string;
}
export interface AgentResultEvent {
  type: 'result'; subtype: string; is_error: boolean; session_id: string;
  result?: string;                 // do NOT read — structured_output is the parsed value
  structured_output?: unknown; stop_reason?: string; terminal_reason?: string;
  num_turns?: number; duration_ms?: number; total_cost_usd?: number;
  permission_denials?: PermissionDenial[]; usage?: Record<string, unknown>;
}
export interface RoutedRun { init?: SystemInitEvent; result?: AgentResultEvent }
export interface EventRouter { route(event: unknown): void; readonly routed: RoutedRun }
export function assertSessionUsable(init: SystemInitEvent): void;   // throws LawError('AGENT_ENV')
export function makeEventRouter(o: { log: Logger }): EventRouter;
```

**Plan 04** adds `task_summary` / `post_turn_summary` / `permission_denied` / `assistant` /
`user` handling. Extend `RoutedRun` and add optional callbacks to `makeEventRouter`'s
argument object; do not change `route`'s signature.

### `supervisor.ts`

```ts
export interface AgentSubprocess extends PromiseLike<{ exitCode?: number | undefined }> {
  pid?: number | undefined;
  stdout: AsyncIterable<unknown> | null;
  stderr: AsyncIterable<unknown> | null;
}
export type AgentSpawn = (
  file: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv }
) => AgentSubprocess;
export interface RunAgentInput {
  cwd: string; args: readonly string[]; env: NodeJS.ProcessEnv;
  sessionId: string; maxRunMs: number; log: Logger; spawn?: AgentSpawn;
}
export interface AgentRunOutcome {
  exitCode: number | undefined; sessionId: string;
  resultEvent: AgentResultEvent | undefined;
  denials: PermissionDenial[]; badLines: string[];
}
export function runAgent(o: RunAgentInput): Promise<AgentRunOutcome>;
```

`maxRunMs` is accepted and deliberately unused — **plan 05** implements the timer and the
`SIGINT → SIGTERM → SIGKILL` escalation against `-pid` without changing this signature.
The handle is typed to the six members execa 10 actually exposes, so `.on(...)` (T30) is a
compile error rather than a runtime crash.

### `verdict.ts`

```ts
export interface WorktreeEvidence { commitCount: number; dirty: boolean }
export interface AgentStructuredOutput {
  status?: string; question?: string; assumption?: string; summary?: string;
}
export interface Classification {
  verdict: ExecutionVerdict; question?: string; assumption?: string; summary?: string;
  denialCause?: string; costUsd: number; numTurns: number;
}
export function classifyOutcome(o: {
  evidence: WorktreeEvidence; result: AgentResultEvent | undefined;
}): Classification;
```

The exit code is not merely unread — it is not a parameter.

### `gates.ts`

```ts
export function assertPushAllowed(o: { branch: string; defaultBranch: string }): void; // throws DeliveryError
export const CI_PATH_PREFIXES: readonly string[];
export const CI_PATH_FILES: readonly string[];
export function touchesCiPaths(files: readonly string[]): boolean;
```

**Plan 06** adds the secret scan here (suggested: `findSecrets(diff: string): string[]` and
`assertNoSecrets(diff: string): void`) and calls it from `deliver()` between the
default-branch gate and the push.

### `deliver.ts`

```ts
export interface DeliverInput {
  runCommand: RunCommand; worktreePath: string; branch: string; base: string;
  ownerRepo: string; defaultBranch: string; remote?: string;   // remote defaults to 'origin'
  title: string; body: string; draft: boolean;
}
export interface DeliveryResult { prUrl: string; ciTouched: boolean }
export function deliver(o: DeliverInput): Promise<DeliveryResult>;
```

## Contract additions requested

Phase 7 reconciles. Nothing under `src/domain/` was created or edited (RUSH rule 3).

**1. `Store.updateRun` must accept these fields.** `src/execution/execute-run.ts` declares
the subset it needs as a local structural interface (`ExecutionStore`). It is intentionally
call-compatible with the shape `src/orchestration/run-engine.ts` already uses.

```ts
// src/domain/ports.ts
updateRun(runId: RunId, patch: {
  sessionId?: SessionId;
  branch?: string;
  worktreePath?: string;
  prUrl?: string;
  updatedAt?: number;
}): void;
```

**2. `AgentResult` is CONTESTED and must be reconciled — this is the highest-value item
in this list.** Two phases have written incompatible shapes:

| Source | `status` values | Question fields | PR fields |
|---|---|---|---|
| `src/orchestration/run-engine.ts` + its tests (assumed) | `complete` / `needs_input` / `cancelled` | `question`, `assumptionIfUnanswered` | `prTitle`, `prBody` |
| Phase 4 research, **verified live against CLI 2.1.259** | `delivered` / `needs_input` | `question`, `assumption` | none — the worker composes the PR |

The verified schema is the one the agent actually returned end to end (fresh and
`--resume`d). Recommended reconciliation for `src/domain/agent-result.ts`:

```ts
export const AGENT_RESULT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['delivered', 'needs_input'] },
    question: { type: 'string' },
    assumption: { type: 'string' },
    summary: { type: 'string' },
  },
  required: ['status'],
  additionalProperties: false,
};
export interface AgentResult {
  status: 'delivered' | 'needs_input';
  question?: string;
  assumption?: string;
  summary?: string;
}
```

If Phase 6's `prTitle` / `prBody` are kept, add them to the JSON schema too — the agent
cannot return a field the schema forbids (`additionalProperties: false`). Phase 4's
`deliver()` composes both from the ticket today, so it needs no change either way.
Until reconciliation lands, `AGENT_RESULT_JSON_SCHEMA` lives in
`src/execution/agent-args.ts` beside the flag that carries it; move it, do not copy it.

**3. `Logger` port location.** `src/execution/` imports `Logger` from
`src/infra/logger.js`, which exists on this branch and is the real implementation's own
interface. `src/orchestration/` and `src/ingress/` import `Logger` from
`src/domain/ports.js`, which does not exist. Whichever wins, the two must become one type
or every layer boundary needs a cast.

**4. `AgentEnvironmentError`.** `event-router.ts` throws `new LawError('AGENT_ENV', …)`
rather than declaring a new class, since `src/domain/errors.ts` is Phase 1's. Suggested
addition beside the existing eight:

```ts
/** The spawned session is not the session we asked for (missing GSD skills, wrong mode). */
export class AgentEnvironmentError extends LawError {
  constructor(message: string, options?: ErrorOptions) {
    super('AGENT_ENV', message, options);
    this.name = 'AgentEnvironmentError';
  }
}
```

The code string `'AGENT_ENV'` is already what this phase throws, so adopting the class is
a drop-in replacement.

## Deviations from Plan

### Auto-fixed issues

**1. [Rule 2 — missing critical functionality] `extendEnv: false` on the agent spawn.**
- **Found during:** Task 1, writing `supervisor.ts`.
- **Issue:** execa **merges** the supplied `env` over `process.env` by default. The
  allowlist in `agent-env.ts` would have withheld nothing at all — every `CLAUDE*`
  variable and both worker secrets would have reached the child regardless. D-15 amended
  and T28 would both have been defeated silently, and the end-to-end test would still have
  passed if it had only inspected `buildChildEnv()`'s return value.
- **Fix:** `extendEnv: false` in `defaultSpawn`, with a comment naming the reason. The
  test asserts on the env the **spawn** received, not on `buildChildEnv()`'s output, so the
  regression is caught at the real boundary.
- **Commit:** ee4f9f0

**2. [Rule 1 — bug] `buildResumeArgs` keeps `-p <prompt>`.**
- **Issue:** the plan and the research both say "replace `-p <prompt>` with
  `--resume <sessionId>`". Taken literally, the resumed session receives no new turn, so
  the human's answer never reaches the agent — Phase 6's entire Q&A path would resume a
  session and then say nothing to it.
- **Fix:** emit `--resume <sessionId>` **and** `-p <prompt>`, and drop `--session-id`
  (which is the part that is actually a hard error on reuse). Commented in place.
- **Commit:** ee4f9f0

**3. [Rule 3 — blocking] The agent result schema could not be imported from
`src/domain/agent-result.js`.**
- **Issue:** the plan's `key_links` require `execute-run.ts` to import `AgentResultSchema`
  from `src/domain/agent-result.js` and never redefine it. That module does not exist on
  this branch, and `src/orchestration/` has already written a **different** `AgentResult`
  shape (see Contract additions #2). Creating it would violate RUSH rule 3 and would hard-
  code the losing side of a contest Phase 7 has to settle.
- **Fix:** `AGENT_RESULT_JSON_SCHEMA` is exported from `agent-args.ts` — the module that
  owns the flag carrying it — with a comment pointing at this summary, and the conflict is
  filed as the highest-priority contract addition.
- **Commit:** ee4f9f0

**4. [Rule 3 — blocking] `Logger` imported from `src/infra/logger.js`.**
- `src/domain/ports.js` does not exist. `src/infra/logger.ts` does, on this branch, and
  exports a `Logger` interface with exactly the `child`/`info`/`warn`/`error`/`debug`
  surface this phase uses. Filed as contract addition #3.

**5. [Rule 2 — avoiding a stub] `deliver()` computes `ciTouched` for real.**
- The plan assigns the CI-path classifier to plan 06, but `deliver()`'s return type carries
  `ciTouched` from the first commit. Returning a hardcoded `false` would have been a stub,
  which this plan's `done` criteria forbid. `touchesCiPaths()` (7 lines, in `gates.ts`
  where plan 06 will extend it) is computed from `git diff --name-only`. Plan 06 owns the
  prominence of the flag in the PR body and terminal comment, which is the part that was
  actually deferred.

### Process deviations

**6. STATE.md / ROADMAP.md / REQUIREMENTS.md were not updated.** Six executors are running
in parallel worktrees off the same base commit under rush mode; six concurrent
`state.advance-plan` calls produce a garbage merge. The orchestrator owns these files for
this milestone.

**7. TDD gates were committed but not run.** RUSH rule 2 forbids `npm install`, `tsc` and
`node --test`. The gate sequence is present in the log — `test(04-01)` (278c919, RED: the
three modules it imports did not exist yet) followed by `feat(04-01)` (b39fe41, GREEN).
Neither was executed. No REFACTOR commit was needed.

## TDD Gate Compliance

- RED gate: `278c919 test(04-01): failing end-to-end tracer test for executeRun` ✅
- GREEN gate: `b39fe41 feat(04-01): close the tracer …` ✅
- REFACTOR: not needed.
- **Warning:** neither gate was *executed* — see deviation 7. The milestone's single
  integration gate (`tsc && node --test dist`) is the first run of this file.

## Known Stubs

None. Every module on the tracer path carries a real implementation of the single path it
claims. Four modules accept a parameter they do not yet use, each commented with the plan
that consumes it:

| Location | Deferred to | Note |
|---|---|---|
| `RunAgentInput.maxRunMs` | plan 05 | shipping the obvious `handle.kill()` is worse than shipping nothing (T29) |
| `WorktreeEvidence.dirty` | plans 02/06 | collected and passed, not yet classified on |
| `RunCommandOptions.reject` | plan 02 | `branchExists` needs the non-throwing form |
| `DeliverInput.remote` | plan 06 | defaults to `origin` |

## Threat Flags

None. No security-relevant surface was introduced beyond what `<threat_model>` already
registers. Notes on the mitigations that landed:

- **T-04-01** (`prompt.ts`): both D-14 layers present. The character-class regexes are
  written with `\u` escapes; no literal invisible character is in the source.
- **T-04-02** (`agent-env.ts`): allowlist from `{}`, plus `extendEnv: false` at the spawn —
  the allowlist alone was not sufficient (see deviation 1).
- **T-04-03** (`agent-args.ts`): argv array throughout; no shell anywhere in
  `src/execution/`.
- **T-04-04** (`gates.ts` / `deliver.ts`): `assertPushAllowed` is the first statement in
  `deliver()`, before the diff is even read. One named ref; no forcing variant.
- **T-04-06** (`worktree.ts`): daemon-owned root; the branch-resetting create variant is
  absent and is documented as forbidden.
- **T-04-SC**: nothing was installed. `src/execution/` imports only Node builtins,
  `src/domain/`, `src/infra/logger.ts`, and `execa@10.0.1`.

## Verification

All `<verify>` blocks from both tasks were run as written and pass:

| Check | Expected | Actual |
|---|---|---|
| all eleven modules + test file exist | `FILES_OK` | `FILES_OK` |
| `dontAsk` / `allowedTools` / `permission-prompts` / `verbose` in `agent-args.ts` | ≥1 each | 2 / 2 / 2 / 3 |
| `--bare` on non-comment lines of `agent-args.ts` | 0 | 0 |
| `--bare` mentioned at all (the D-02 comment) | ≥1 | 3 |
| `process.env)` on non-comment lines of `agent-env.ts` | 0 | 0 |
| `"-B"` on non-comment lines of `worktree.ts` | 0 | 0 |
| `symbolic-ref` in `worktree.ts` | ≥1 | 1 |
| `randomUUID` in `execute-run.ts` | ≥1 | 2 |
| `gsd-execute-phase` / `permissionMode` in `event-router.ts` | ≥1 | 1 / 4 |
| `child.kill(` / `.on("exit"` on non-comment lines of `supervisor.ts` | 0 | 0 / 0 |
| `result.result` / `end_turn` / `exitCode` on non-comment lines of `verdict.ts` | 0 | 0 / 0 / 0 |
| `structured_output` / `needs_input` / `permission_denials` in `verdict.ts` | ≥1 | 1 / 2 / 1 |
| `--force` / `--json` on non-comment lines of `deliver.ts` | 0 | 0 / 0 |
| `assertPushAllowed` in `deliver.ts` | ≥1 | 2 |
| `dontAsk` / `CLAUDE` / `defaultBranch` in the test | ≥1 | 2 / 5 / 1 |

Not run, per RUSH rule 2: `npm install`, `tsc`, `node --test`, and any real `claude`,
`git` or `gh` invocation.

## Self-Check: PASSED

All twelve created files exist on disk. All three commits exist in `git log`:
`ee4f9f0`, `278c919`, `b39fe41`.
