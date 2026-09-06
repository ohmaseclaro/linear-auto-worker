/**
 * The composition root for one run's execution. AGNT-*, DELV-*.
 *
 * Everything Phase 4 does for a single Linear issue happens here, in order, by calling
 * out to one module per step. The decomposition — which module owns which step and what
 * each one's exported signature is — is the contract plans 02-06 build against, so those
 * five can be developed simultaneously without ever editing this file.
 *
 * Scope of the tracer: one issue, one repo, one happy path. No collision suffixing
 * (plan 02), no boot reconcile (plan 02), no kill escalation (plan 05), no secret scan
 * (plan 06), no Q&A resume (Phase 6).
 */
import { randomUUID } from 'node:crypto';
import { execa } from 'execa';
import type { RunId, SessionId } from '../domain/types.js';
import type { Logger } from '../infra/logger.js';
import { AGENT_RESULT_JSON_SCHEMA, buildClaudeArgs } from './agent-args.js';
import { buildChildEnv } from './agent-env.js';
import { buildAgentPrompt } from './prompt.js';
import { prepareWorktree } from './worktree.js';
import { runAgent } from './supervisor.js';
import type { AgentSpawn } from './supervisor.js';

export interface RunCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RunCommandOptions {
  cwd?: string;
  /** Default true. A non-zero exit REJECTS unless this is explicitly false. */
  reject?: boolean;
}

/**
 * An injectable, execa-shaped one-shot command runner.
 *
 * Injecting it is what makes this whole path testable with no `git`, no `gh` and no
 * `claude` installed — which under RUSH mode is the only kind of test that can exist.
 * `execa` is imported in exactly two places in this phase: here, as this default, and in
 * `supervisor.ts` for the agent spawn. Both are injectable; nothing else in
 * `src/execution/` imports it.
 */
export type RunCommand = (
  file: string,
  args: readonly string[],
  options?: RunCommandOptions
) => Promise<RunCommandResult>;

const defaultRunCommand: RunCommand = async (file, args, options) => {
  const result = await execa(file, [...args], {
    cwd: options?.cwd,
    reject: options?.reject ?? true,
  });
  return {
    exitCode: result.exitCode ?? 0,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
  };
};

/** The Linear fields this phase consumes. Named exactly as `Issue` exposes them. */
export interface ExecuteRunIssue {
  identifier: string;
  title: string;
  description: string;
  /** Linear's suggested branch name. Used verbatim — never slugified. */
  branchName: string;
  url: string;
}

export interface ExecuteRunMapping {
  /** The operator's clone of the mapped repository. */
  repoPath: string;
  /** `owner/repo`, as `gh -R` wants it. */
  ownerRepo: string;
  defaultBranch: string;
  draftPr: boolean;
  maxRunMs: number;
}

export interface ExecuteRunInput {
  runId: RunId;
  issue: ExecuteRunIssue;
  mapping: ExecuteRunMapping;
  /** `~/.linear-auto-worker` — worktrees live under here, never inside the repo. */
  daemonDir: string;
}

/**
 * The subset of the Phase 1 `Store` port this phase touches. Declared structurally here
 * rather than imported, because `src/domain/ports.ts` does not exist on this branch and
 * RUSH rule 3 forbids creating it. See `Contract additions requested` in 04-01-SUMMARY.md.
 */
export interface ExecutionStore {
  updateRun(
    runId: RunId,
    patch: {
      sessionId?: SessionId;
      branch?: string;
      worktreePath?: string;
      prUrl?: string;
      updatedAt?: number;
    }
  ): void | Promise<void>;
}

export interface ExecuteRunDeps {
  store: ExecutionStore;
  log: Logger;
  runCommand?: RunCommand;
  spawn?: AgentSpawn;
}

export type ExecutionVerdict = 'delivered' | 'partial' | 'failed' | 'needs_input';

export interface ExecutionOutcome {
  verdict: ExecutionVerdict;
  prUrl?: string;
  branch: string;
  worktreePath: string;
  sessionId: SessionId;
  costUsd: number;
  numTurns: number;
  /** Present only on `needs_input`. Phase 6 owns what happens next. */
  question?: string;
  assumption?: string;
}

export async function executeRun(
  input: ExecuteRunInput,
  deps: ExecuteRunDeps
): Promise<ExecutionOutcome> {
  const runCommand = deps.runCommand ?? defaultRunCommand;
  const log = deps.log.child({ runId: input.runId, issue: input.issue.identifier });

  // 1. Mint the session ID and persist it BEFORE anything is spawned (D-04, AGNT-04, T4).
  //    The ordering is the point: 16 hook events precede `system/init` on this machine,
  //    so scanning the stream for the ID is a race. Persisting after the spawn is the
  //    same race with a smaller window — if the daemon dies between spawn and write, the
  //    run row points at no session and the child cannot be resumed or attributed.
  const sessionId: SessionId = randomUUID();
  await deps.store.updateRun(input.runId, { sessionId, updatedAt: Date.now() });
  log.info({ sessionId }, 'session id assigned');

  // 2. Isolate the work.
  const worktree = await prepareWorktree({
    runCommand,
    repoPath: input.mapping.repoPath,
    repoSlug: input.mapping.ownerRepo.replace('/', '-'),
    daemonDir: input.daemonDir,
    branchName: input.issue.branchName,
    base: input.mapping.defaultBranch,
  });
  await deps.store.updateRun(input.runId, {
    branch: worktree.branch,
    worktreePath: worktree.path,
    updatedAt: Date.now(),
  });
  log.info({ branch: worktree.branch, worktreePath: worktree.path }, 'worktree prepared');

  // 3. Cross the trust boundary exactly once (D-14).
  const prompt = buildAgentPrompt({
    identifier: input.issue.identifier,
    title: input.issue.title,
    description: input.issue.description,
    url: input.issue.url,
    branch: worktree.branch,
  });

  // 4. Run the agent under supervision.
  const agent = await runAgent({
    cwd: worktree.path,
    args: buildClaudeArgs({ sessionId, prompt, schema: AGENT_RESULT_JSON_SCHEMA }),
    env: buildChildEnv(input.runId),
    sessionId,
    maxRunMs: input.mapping.maxRunMs,
    log,
    spawn: deps.spawn,
  });
  log.info(
    { exitCode: agent.exitCode, denials: agent.denials.length, badLines: agent.badLines.length },
    'agent exited'
  );

  // 5-7. Verdict, delivery and cleanup are appended by task 2.
  return {
    verdict: 'failed',
    branch: worktree.branch,
    worktreePath: worktree.path,
    sessionId,
    costUsd: agent.resultEvent?.total_cost_usd ?? 0,
    numTurns: agent.resultEvent?.num_turns ?? 0,
  };
}
