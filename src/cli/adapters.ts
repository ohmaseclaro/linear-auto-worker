/**
 * The three execution ports, expressed over Phase 4's functions.
 *
 * Phase 4 shipped `prepareWorktree` / `runAgent` / `deliver` as free functions with
 * injectable process runners, which is the right shape for testing them and the wrong
 * shape for `RunEngineDeps`, which takes objects. This module is that translation and
 * nothing else: no policy, no I/O at construction time, no state beyond the run→worktree
 * map the port's `remove(runId)` / `exists(runId)` signatures require.
 *
 * **Nothing here may touch the filesystem, `git`, or PATH from a constructor.** The boot
 * smoke composes all three offline, in a directory with no git repository and no `claude`
 * binary reachable, and a constructor that probed for either would turn it red. That is
 * deliberate: the smoke's whole value is that it can run everywhere, every time.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { parseAgentResult } from '../domain/agent-result.js';
import { resolveToggles } from '../domain/types.js';
import { AGENT_RESULT_JSON_SCHEMA, buildClaudeArgs, buildResumeArgs } from '../execution/agent-args.js';
import { buildChildEnv } from '../execution/agent-env.js';
import { deliver as deliverPullRequest } from '../execution/deliver.js';
import { defaultRunCommand, type RunCommand } from '../execution/execute-run.js';
import type { ProgressUpdate } from '../execution/event-router.js';
import { runAgent, type AgentRunOutcome, type AgentSpawn } from '../execution/supervisor.js';
import { prepareWorktree, reconcileWorktrees, removeWorktree } from '../execution/worktree.js';
import type {
  AgentResult,
  AgentRunner,
  AgentSpawnRequest,
  Config,
  Deliverer,
  Logger,
  MappingToggles,
  PullRequest,
  RepoMapping,
  RunId,
  Store,
  Worktree,
  WorktreeManager,
} from '../domain/ports.js';

/**
 * `repoSlug -> the config mapping key that owns it`, built once at boot.
 *
 * A `RepoRun` records its repo but not which mapping produced it, and three separate
 * consumers need the mapping back: the per-mapping toggles the agent runner and the
 * deliverer read, and the Slack webhook lookup the notifier does. Re-deriving it from the
 * issue would mean a Linear round-trip per lookup; this is one pass over config at boot.
 */
export function mappingIndex(config: Config): ReadonlyMap<string, string> {
  const index = new Map<string, string>();
  for (const [mappingId, mapping] of Object.entries(config.mappings)) {
    for (const repo of mapping.repos) index.set(repo.repoSlug, mappingId);
  }
  return index;
}

/** The resolved toggles for whichever mapping owns `repoSlug`, or the bare defaults. */
export function togglesFor(
  config: Config,
  index: ReadonlyMap<string, string>,
  repoSlug: string | null,
): MappingToggles {
  const mappingId = repoSlug === null ? undefined : index.get(repoSlug);
  return resolveToggles(config.defaults, mappingId ? config.mappings[mappingId] : undefined);
}

export interface ExecutionAdapterDeps {
  store: Store;
  config: Config;
  log: Logger;
  index: ReadonlyMap<string, string>;
  /** Injected so a test can drive `git` / `gh` without either installed. */
  runCommand?: RunCommand;
}

/**
 * `${daemonDir}/worktrees/${repoSlug}/${branch}` is what `prepareWorktree` builds, so the
 * daemon dir it must be handed is the PARENT of the configured worktree root. Deriving it
 * rather than passing the config root separately is what keeps the two from drifting: a
 * worktree root moved in `config.json` moves the worktrees with it.
 */
function daemonDirOf(config: Config): string {
  return path.dirname(config.worktreeRoot);
}

export function createWorktreeManager(deps: ExecutionAdapterDeps): WorktreeManager {
  const runCommand = deps.runCommand ?? defaultRunCommand;
  const daemonDir = daemonDirOf(deps.config);
  const byRun = new Map<RunId, Worktree>();

  return {
    async create(runId: RunId, repo: RepoMapping, branch: string): Promise<Worktree> {
      const prepared = await prepareWorktree({
        runCommand,
        repoPath: repo.repoDir,
        // The slug is a path segment here, and `org/name` would silently nest one
        // directory deeper than the containment check below expects.
        repoSlug: repo.repoSlug.replace(/\//g, '-'),
        daemonDir,
        branchName: branch,
        base: repo.baseBranch,
      });
      // `prepared.branch` may carry a collision suffix (D-11): the requested name is used
      // verbatim when free and suffixed when taken, precisely so a retry cannot reset a
      // previous attempt's branch. The caller must record the RESOLVED name or the push
      // later goes to a ref that does not exist.
      const worktree: Worktree = {
        runId,
        repoDir: repo.repoDir,
        path: prepared.path,
        branch: prepared.branch,
        baseBranch: repo.baseBranch,
      };
      byRun.set(runId, worktree);
      return worktree;
    },

    async remove(runId: RunId): Promise<void> {
      const worktree = byRun.get(runId);
      if (!worktree) return;
      await removeWorktree({ runCommand, repoPath: worktree.repoDir, path: worktree.path });
      byRun.delete(runId);
    },

    async exists(runId: RunId): Promise<boolean> {
      const worktree = byRun.get(runId) ?? worktreeFromStore(deps, runId);
      if (!worktree) return false;
      // The directory, not the map: a crashed process leaves the row and loses the map,
      // and a `git worktree remove` run by hand leaves the row and loses the directory.
      return fs
        .access(worktree.path)
        .then(() => true)
        .catch(() => false);
    },

    /**
     * Boot GC (04-CONTEXT D-11). Runs AFTER the recovery sweep, never before: recovery is
     * what decides which runs are still alive, and collecting first would delete the
     * worktree of a run recovery was about to requeue.
     */
    async gc(liveRunIds: Set<RunId>): Promise<string[]> {
      const nonTerminalRuns = [...liveRunIds]
        .map((runId) => worktreeFromStore(deps, runId))
        .filter((w): w is Worktree => w !== undefined)
        .map((w) => ({ runId: w.runId, worktreePath: w.path }));

      const repoPaths = [
        ...new Set(
          Object.values(deps.config.mappings).flatMap((m) =>
            m.repos.filter((r) => r.enabled).map((r) => r.repoDir),
          ),
        ),
      ];
      if (repoPaths.length === 0) return [];

      const result = await reconcileWorktrees({
        runCommand,
        daemonDir,
        repoPaths,
        nonTerminalRuns,
      });
      if (result.orphanedRuns.length > 0) {
        // Reported, never acted on here: deciding what a run whose worktree vanished
        // should become is the run engine's call, not this adapter's.
        deps.log.warn(
          { runIds: result.orphanedRuns },
          'runs whose recorded worktree no longer exists',
        );
      }
      return result.pruned;
    },
  };
}

/** The worktree a run row remembers, for the two ports that are given only an id. */
function worktreeFromStore(deps: ExecutionAdapterDeps, runId: RunId): Worktree | undefined {
  const run = deps.store.getRun(runId);
  if (!run || run.kind !== 'repo' || !run.worktreePath) return undefined;
  return {
    runId,
    repoDir: run.repoDir,
    path: run.worktreePath,
    branch: run.branch,
    baseBranch: togglesFor(deps.config, deps.index, run.repoSlug).baseBranch,
  };
}

export interface AgentRunnerDeps extends ExecutionAdapterDeps {
  /** Injected so the run-path test can script a session with no `claude` on PATH. */
  spawn?: AgentSpawn;
}

/** One progress update, flattened to the one line a log record carries. */
function progressLine(update: ProgressUpdate): string {
  if (update.kind === 'task_summary') return update.detail;
  return [update.status_category, update.status_detail, update.needs_action]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join(' — ');
}

/**
 * The denial tally, as a short phrase for a failure reason.
 *
 * Read off the ROUTER's tally rather than the result event's (07-CONTEXT P5): a reaped run
 * has no result event, so the event-only reading reports zero denials for exactly the runs
 * whose denials are the explanation. Tool NAMES only — `tool_input` is agent-influenced
 * text and this string ends up on a Linear comment (T-06-06).
 */
function denialPhrase(outcome: AgentRunOutcome): string {
  if (outcome.denials.length === 0) return '';
  const tools = [...new Set(outcome.denials.map((d) => d.tool_name).filter(Boolean))];
  return ` (${outcome.denials.length} tool call(s) refused: ${tools.join(', ')})`;
}

/**
 * `AgentRunOutcome` → `AgentResult`.
 *
 * The engine's vocabulary is the domain's five-member union; the supervisor's is a
 * transcript summary. The interesting cases are the ones with no result object at all,
 * because they are the ones a naive mapping turns into a silent success.
 */
function toAgentResult(outcome: AgentRunOutcome): AgentResult {
  if (outcome.timedOut) {
    return {
      status: 'failed',
      summary: 'the session was still running when its deadline expired',
      failureReason:
        `killed at the configured maxRunMs deadline` +
        (outcome.killedBy ? ` (reaped by ${outcome.killedBy})` : '') +
        `; the worktree is left in place${denialPhrase(outcome)}`,
    };
  }
  const event = outcome.resultEvent;
  if (!event) {
    return {
      status: 'crashed',
      exitCode: outcome.exitCode ?? -1,
      stderrTail: `the agent produced no result event${denialPhrase(outcome)}`,
    };
  }
  try {
    // T31: the PARSED object beside the JSON string, never the string.
    return parseAgentResult(event.structured_output);
  } catch (err) {
    return {
      status: 'failed',
      summary: 'the agent returned no usable result object',
      failureReason:
        (err instanceof Error ? err.message : String(err)) + denialPhrase(outcome),
    };
  }
}

export function createAgentRunner(deps: AgentRunnerDeps): AgentRunner {
  let onProgress: ((runId: RunId, line: string) => void) | null = null;

  return {
    onProgress(cb: (runId: RunId, line: string) => void): void {
      onProgress = cb;
    },

    async run(req: AgentSpawnRequest, signal: AbortSignal): Promise<AgentResult> {
      if (signal.aborted) return { status: 'cancelled' };

      const run = deps.store.getRun(req.runId);
      const repoSlug = run?.kind === 'repo' ? run.repoSlug : null;
      const toggles = togglesFor(deps.config, deps.index, repoSlug);
      const args = req.resume
        ? buildResumeArgs({
            sessionId: req.sessionId,
            prompt: req.prompt,
            schema: AGENT_RESULT_JSON_SCHEMA,
          })
        : buildClaudeArgs({
            sessionId: req.sessionId,
            prompt: req.prompt,
            schema: AGENT_RESULT_JSON_SCHEMA,
          });

      const outcome = await runAgent({
        cwd: req.cwd,
        args,
        // The allowlist FIRST (D-15 / T28 / AGNT-11), then the run's own `LAW_*` labels.
        // `buildChildEnv` starts from an empty object, so neither `LINEAR_API_KEY` nor
        // `NGROK_AUTHTOKEN` can reach the child by omission — and `req.env` carries only
        // run metadata, never a credential.
        env: { ...buildChildEnv(req.runId), ...req.env },
        sessionId: req.sessionId,
        maxRunMs: toggles.maxRunMs,
        log: deps.log.child({ runId: req.runId, sessionId: req.sessionId }),
        spawn: deps.spawn,
        signal,
        onProgress: (update) => onProgress?.(req.runId, progressLine(update)),
      });

      // The abort may have won the race inside `runAgent`, which reports the reap rather
      // than a verdict. A cancelled run is not a failed one.
      if (signal.aborted) return { status: 'cancelled' };
      return toAgentResult(outcome);
    },
  };
}

/** `https://github.com/o/r/pull/42` → 42. Zero when gh printed something else. */
function prNumberOf(url: string): number {
  return Number(/\/pull\/(\d+)(?:$|[/?#])/.exec(`${url}/`)?.[1] ?? 0);
}

export function createDeliverer(deps: ExecutionAdapterDeps): Deliverer {
  const runCommand = deps.runCommand ?? defaultRunCommand;

  return {
    async deliver(
      wt: Worktree,
      repo: RepoMapping,
      pr: { title: string; body: string },
    ): Promise<PullRequest> {
      const toggles = togglesFor(deps.config, deps.index, repo.repoSlug);
      const result = await deliverPullRequest({
        runCommand,
        worktreePath: wt.path,
        branch: wt.branch,
        base: wt.baseBranch,
        ownerRepo: repo.repoSlug,
        defaultBranch: repo.baseBranch,
        title: pr.title,
        body: pr.body,
        draft: toggles.draftPr,
      });
      return { url: result.prUrl, number: prNumberOf(result.prUrl) };
    },
  };
}
