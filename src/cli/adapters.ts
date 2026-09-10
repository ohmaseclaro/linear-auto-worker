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
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { parseAgentResult, parseRepoDiscovery } from '../domain/agent-result.js';
import { daemonDirOf, repoMappingFor, resolveToggles } from '../domain/types.js';
import {
  AGENT_RESULT_JSON_SCHEMA,
  DISCOVERY_MAX_TURNS,
  DISCOVERY_TIMEOUT_MS,
  REPO_DISCOVERY_JSON_SCHEMA,
  buildClaudeArgs,
  buildDiscoveryArgs,
  buildResumeArgs,
} from '../execution/agent-args.js';
import { buildChildEnv } from '../execution/agent-env.js';
import { buildRepoDiscoveryPrompt } from '../execution/prompt.js';
import { deliver as deliverPullRequest } from '../execution/deliver.js';
import { defaultRunCommand, type RunCommand } from '../execution/execute-run.js';
import type { ProgressUpdate } from '../execution/event-router.js';
import type { Injector } from '../execution/inject.js';
import { openRunLog } from '../execution/run-log.js';
import { runAgent, type AgentRunOutcome, type AgentSpawn } from '../execution/supervisor.js';
import { classifyOutcome, type WorktreeEvidence } from '../execution/verdict.js';
import { prepareWorktree, reconcileWorktrees, removeWorktree } from '../execution/worktree.js';
import type {
  AgentResult,
  AgentRunner,
  AgentSpawnRequest,
  Config,
  Deliverer,
  Logger,
  MappingToggles,
  PrBodySource,
  PullRequest,
  RepoDiscoveryRequest,
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

export function createWorktreeManager(deps: ExecutionAdapterDeps): WorktreeManager {
  const runCommand = deps.runCommand ?? defaultRunCommand;
  const daemonDir = daemonDirOf(deps.config);
  const byRun = new Map<RunId, Worktree>();

  return {
    async create(
      runId: RunId,
      repo: RepoMapping,
      branch: string,
      parentDir?: string,
    ): Promise<Worktree> {
      const prepared = await prepareWorktree({
        runCommand,
        repoPath: repo.repoDir,
        // The slug is a path segment here, and `org/name` would silently nest one
        // directory deeper than the containment check below expects.
        repoSlug: repo.repoSlug.replace(/\//g, '-'),
        daemonDir,
        branchName: branch,
        base: repo.baseBranch,
        ...(parentDir ? { parentDir } : {}),
      });
      // `prepared.branch` may carry a collision suffix (D-11): the requested name is used
      // verbatim when free and suffixed when taken, precisely so a retry cannot reset a
      // previous attempt's branch. The caller must record the RESOLVED name or the push
      // later goes to a ref that does not exist.
      // T125: `prepared.base`, not `repo.baseBranch`. This field is what `deliver.ts`
      // builds `<base>..HEAD` from, so it must be the ref the branch was cut from and not
      // the bare config name — the local `refs/heads/<base>` can sit arbitrarily far
      // behind its own origin, and it does. `RepoMapping.baseBranch` stays plain, because
      // `gh pr create --base` names a GitHub branch (see `createDeliverer` below).
      const worktree: Worktree = {
        runId,
        repoDir: repo.repoDir,
        path: prepared.path,
        branch: prepared.branch,
        baseBranch: prepared.base,
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
    // T125. The RECORDED ref first: this is the recovery shape, where the worktree that
    // knew the answer is long gone. `togglesFor(...).baseBranch` was a THIRD answer to the
    // fork-point question — resolved from the toggles rather than from the ref the
    // checkout used — reachable only through `exists()`/`gc()`, which read `.path` alone.
    // Fixed here anyway rather than reported: leaving a known-wrong third answer in place
    // is how the next reader reaches for it.
    baseBranch:
      run.baseRef ??
      repoMappingFor(deps.config, run.repoSlug)?.baseBranch ??
      deps.config.defaults.baseBranch,
  };
}

export interface AgentRunnerDeps extends ExecutionAdapterDeps {
  /** Injected so the run-path test can script a session with no `claude` on PATH. */
  spawn?: AgentSpawn;
  /**
   * `law say`'s registry. Optional because the two adapter tests that predate it construct
   * this without one; the daemon always passes the real thing (`daemon.ts`'s injection-seam
   * rule — it crosses no boundary this machine cannot cross, so it is never a double).
   */
  injector?: Injector;
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
/**
 * What the worktree actually contains, read with the same two commands `execute-run.ts`
 * uses. `baseBranch` comes from the repo's own mapping, so the commit count is "commits
 * this run added", not "commits on the branch".
 *
 * Failure here is not fatal and must not be: if `git` cannot answer, the caller falls back
 * to trusting the agent, which is exactly the old behaviour and strictly no worse.
 */
async function gatherEvidence(
  deps: AgentRunnerDeps,
  worktreePath: string,
  repoSlug: string | null,
  /**
   * T125. The ref the run's branch was cut from, off the run row. Passed in rather than
   * looked up here: this function had its OWN copy of the mapping lookup, which is how it
   * came to measure a different range than `deliver.ts`. Absent only for a row that
   * predates migration 003, which falls back below.
   */
  baseRef?: string | null,
): Promise<WorktreeEvidence | undefined> {
  const runCommand = deps.runCommand ?? defaultRunCommand;
  // One lookup, shared with `run-engine.repoOf`/`worktreeOf` — see `repoMappingFor`.
  const base = baseRef ?? repoMappingFor(deps.config, repoSlug)?.baseBranch;
  if (!base) return undefined;
  try {
    const committed = await runCommand('git', [
      '-C',
      worktreePath,
      'log',
      '--oneline',
      `${base}..HEAD`,
    ]);
    const dirty = await runCommand('git', ['-C', worktreePath, 'status', '--porcelain']);
    const paths = dirty.stdout
      .split('\n')
      .map((line) => line.slice(3).trim())
      .filter((p) => p.length > 0);
    return {
      commitCount: committed.stdout.split('\n').filter((l) => l.trim().length > 0).length,
      dirty: paths.length > 0,
      ...(paths.length > 0 ? { uncommittedPaths: paths } : {}),
    };
  } catch {
    return undefined;
  }
}

/** Exported for `adapters.verdict.test.ts`: the timeout branch is only reachable
 *  through a real 15s escalation ladder, which is not worth paying on every gate run. */
/**
 * A run stopped by one of its limits rather than by the agent.
 *
 * Two limits reach this: the supervisor's `maxRunMs` reap, and an exhausted run budget.
 * They are the same decision — commits on the branch are real, pushable work, and
 * discarding them because a limit fired is the same error as trusting a barren `complete`,
 * pointed the other way (T73). Shared so the two cannot drift into different answers for
 * the same situation, which is the defect shape this codebase has produced four times.
 */
function cutShort(
  what: string,
  detail: string,
  prTitle: string,
  evidence: WorktreeEvidence | undefined,
): AgentResult {
  if (evidence && evidence.commitCount > 0) {
    return {
      status: 'partial',
      summary: `${what}; ${evidence.commitCount} commit(s) were left on the branch`,
      prTitle,
      prBody:
        `${detail} The commits below are what the agent finished before that point; the ` +
        `work is incomplete by definition.`,
      ...(evidence.uncommittedPaths ? { uncommittedPaths: evidence.uncommittedPaths } : {}),
    };
  }
  return {
    status: 'failed',
    summary: what,
    failureReason: `${detail} The worktree is left in place.`,
  };
}

export function toAgentResult(
  outcome: AgentRunOutcome,
  evidence?: WorktreeEvidence,
): AgentResult {
  if (outcome.timedOut) {
    const reaped =
      `killed at the configured maxRunMs deadline` +
      (outcome.killedBy ? ` (reaped by ${outcome.killedBy})` : '');

    // T73, and the subtle half. A reap is the ONLY way `classifyOutcome` produces
    // `partial`, so returning `failed` here unconditionally — as this did — left `partial`
    // unreachable no matter what the classifier decided downstream.
    return cutShort(
      `the session was ${reaped}`,
      `The agent's session was ${reaped}.${denialPhrase(outcome)}`,
      'WIP: agent run reached its deadline',
      evidence,
    );
  }
  const event = outcome.resultEvent;
  if (!event) {
    // T113. No result AND no replayed echo is the M2 signature exactly: the prompt was
    // written and never consumed, so the session sat there producing nothing. That one
    // clause is the difference between a diagnosis and a 45-minute mystery — and it is
    // what the `no-agent-ack` deadline in `supervisor.ts` surfaces after 60 seconds
    // instead of 45 minutes.
    const undelivered =
      outcome.userEchoes === 0
        ? ' and never echoed the prompt back — the stdin delivery failed'
        : '';
    return {
      status: 'crashed',
      exitCode: outcome.exitCode ?? -1,
      stderrTail: `the agent produced no result event${undelivered}${denialPhrase(outcome)}`,
    };
  }

  // T31: the PARSED object beside the JSON string, never the string.
  let claimed: AgentResult;
  try {
    claimed = parseAgentResult(event.structured_output);
  } catch (err) {
    return {
      status: 'failed',
      summary: 'the agent returned no usable result object',
      failureReason:
        (err instanceof Error ? err.message : String(err)) + denialPhrase(outcome),
    };
  }

  // A question is a claim about the turn, not about the tree — evidence cannot contradict
  // it, and second-guessing it would strand the Q&A round trip. Same for an agent that
  // reports its own failure: it is already telling the truth.
  if (claimed.status !== 'complete') return claimed;

  // Without evidence, the old behaviour: trust the claim. Strictly no worse than before.
  if (!evidence) return claimed;

  // TRAPS T73 / research Pitfall 3. `classifyOutcome` is the Phase 4 verdict that judges
  // by what is on disk. `delivered` confirms the claim; `partial` means the turn was
  // truncated but real work exists, so it ships as a DRAFT rather than being rounded away;
  // `failed` is the barren case — the agent said `complete` and produced nothing, which is
  // precisely what `claude -p` does when it is denied every edit and still exits 0.
  const classification = classifyOutcome({
    evidence,
    result: event,
    timedOut: outcome.timedOut,
  });

  if (classification.verdict === 'delivered') return claimed;

  if (classification.verdict === 'partial') {
    return {
      status: 'partial',
      summary: classification.summary ?? claimed.summary,
      prTitle: claimed.prTitle,
      prBody: claimed.prBody,
      ...(classification.uncommittedPaths
        ? { uncommittedPaths: classification.uncommittedPaths }
        : {}),
    };
  }

  return {
    status: 'failed',
    summary: claimed.summary,
    failureReason:
      `the agent reported "complete" but the worktree contains no commits` +
      `${classification.denialCause ? ` — ${classification.denialCause}` : ''}` +
      denialPhrase(outcome),
  };
}

export function createAgentRunner(deps: AgentRunnerDeps): AgentRunner {
  let onProgress: ((runId: RunId, line: string) => void) | null = null;

  return {
    onProgress(cb: (runId: RunId, line: string) => void): void {
      onProgress = cb;
    },

    /**
     * The read-only triage session (phase one of a multi-repo ticket).
     *
     * It NEVER throws for a session that failed: the caller's fallback is the operator's
     * whole mapping, and a throw here would make a flaky classifier able to kill a ticket.
     * Every failure arm returns `undefined` and says why in the log.
     */
    async discoverRepos(req: RepoDiscoveryRequest): Promise<string[] | undefined> {
      const daemonDir = daemonDirOf(deps.config);
      // A daemon-owned SCRATCH directory: never a repository, never the operator's parent
      // directory, and empty. The session is granted no tools, so there is nothing for it
      // to do here — this is the second layer, so that a future widening of the allowlist
      // does not silently hand it someone's source tree.
      const cwd = path.join(daemonDir, 'discovery');
      await fs.mkdir(cwd, { recursive: true });

      const sessionId = randomUUID();
      // Its own id, so it gets its own run log. A discovery that went wrong is then
      // inspectable rather than a black box — and it cannot overwrite a real run's trace.
      const logId = `discovery-${sessionId}`;
      const runLog = openRunLog(daemonDir, logId);
      try {
        const outcome = await runAgent({
          cwd,
          args: buildDiscoveryArgs({
            sessionId,
            schema: REPO_DISCOVERY_JSON_SCHEMA,
            maxTurns: DISCOVERY_MAX_TURNS,
          }),
          env: buildChildEnv(logId),
          sessionId,
          prompt: buildRepoDiscoveryPrompt({
            identifier: req.identifier,
            title: req.title,
            description: req.description,
            url: req.url,
            repoSlugs: req.repoSlugs,
          }),
          // Its OWN deadline. `toggles.maxRunMs` is the WORK session's budget — see
          // `DISCOVERY_TIMEOUT_MS`.
          maxRunMs: DISCOVERY_TIMEOUT_MS,
          log: deps.log.child({ issueId: req.issueId, sessionId, phase: 'discovery' }),
          spawn: deps.spawn,
          signal: new AbortController().signal,
          onEvent: (e) => runLog.write(e),
        });

        if (outcome.timedOut || !outcome.resultEvent) {
          deps.log.warn(
            { issueId: req.issueId, timedOut: outcome.timedOut, exitCode: outcome.exitCode },
            'repo discovery session produced no result',
          );
          return undefined;
        }
        return parseRepoDiscovery(outcome.resultEvent.structured_output);
      } catch (err) {
        deps.log.warn(
          { issueId: req.issueId, err: String(err) },
          'repo discovery session failed or returned garbage',
        );
        return undefined;
      } finally {
        runLog.close();
      }
    },

    async run(req: AgentSpawnRequest, signal: AbortSignal): Promise<AgentResult> {
      if (signal.aborted) return { status: 'cancelled' };

      const run = deps.store.getRun(req.runId);
      const repoSlug = run?.kind === 'repo' ? run.repoSlug : null;
      // T125: the same string `deliver.ts` measures against, read off the row the driver
      // wrote it to. Two answers to "which ref did this fork from" is what shipped.
      const baseRef = run?.kind === 'repo' ? run.baseRef : undefined;
      const toggles = togglesFor(deps.config, deps.index, repoSlug);
      // What is LEFT of the run's budget, not the configured total (see `ClaudeArgsInput`).
      // `run.costUsd` is what gap D6 records; before D6 there was no way to compute this at
      // all, which is part of why the knob stayed unwired.
      const spent = run?.kind === 'repo' ? (run.costUsd ?? 0) : 0;
      const budget = deps.config.maxBudgetUsd;
      const remaining = budget === undefined ? undefined : budget - spent;

      // The CLI refuses a non-positive budget outright, so an exhausted run cannot simply
      // be spawned with what is left. Stopping here is also the correct behaviour rather
      // than a workaround: the point of a budget is not to start work it cannot pay for.
      //
      // Routed through the same evidence-based verdict as every other ending, so a run that
      // already produced commits ships them as a draft `partial` instead of being thrown
      // away for running out of money (T73's rule, reused rather than restated).
      if (remaining !== undefined && remaining <= 0) {
        deps.log.warn(
          { runId: req.runId, spent, maxBudgetUsd: budget },
          'run has exhausted its budget; not spawning',
        );
        // Decided here rather than by synthesising a result event and handing it to
        // `toAgentResult`: no session ran, and a fake event with no `structured_output`
        // parses as "the agent returned no usable result object" — which is a different,
        // and wrong, diagnosis. `cutShort` is the same decision the deadline reap makes.
        const evidence = await gatherEvidence(deps, req.cwd, repoSlug, baseRef);
        return cutShort(
          `the run reached its $${budget} budget`,
          `This run had spent $${spent.toFixed(4)} of its $${budget} budget, so no further ` +
            `agent session was started.`,
          'WIP: agent run reached its budget',
          evidence,
        );
      }

      const args = req.resume
        ? buildResumeArgs({
            sessionId: req.sessionId,
            schema: AGENT_RESULT_JSON_SCHEMA,
            maxTurns: deps.config.maxTurns,
            ...(remaining !== undefined ? { maxBudgetUsd: remaining } : {}),
          })
        : buildClaudeArgs({
            sessionId: req.sessionId,
            schema: AGENT_RESULT_JSON_SCHEMA,
            maxTurns: deps.config.maxTurns,
            ...(remaining !== undefined ? { maxBudgetUsd: remaining } : {}),
          });

      // T-VOH-02. The per-run activity trace `law watch` reads. Opened before the spawn so
      // even a session the router refuses on its first event leaves its `system/init`
      // behind — that is the run whose evidence an operator actually needs.
      const runLog = openRunLog(daemonDirOf(deps.config), req.runId);
      let unregister: (() => void) | undefined;
      try {
        const outcome = await runAgent({
          cwd: req.cwd,
          args,
          // The allowlist FIRST (D-15 / T28 / AGNT-11), then the run's own `LAW_*` labels.
          // `buildChildEnv` starts from an empty object, so neither `LINEAR_API_KEY` nor
          // `NGROK_AUTHTOKEN` can reach the child by omission — and `req.env` carries only
          // run metadata, never a credential.
          env: { ...buildChildEnv(req.runId), ...req.env },
          sessionId: req.sessionId,
          // T113: the brief no longer travels in argv. `runAgent` writes it to the child's
          // stdin as an NDJSON `user` message immediately after the spawn.
          prompt: req.prompt,
          // `law say`. Registered synchronously, inside `runAgent`, immediately after the
          // prompt is written — so the window an operator can speak into is the whole time
          // the agent is working and not a moment less.
          onInput: (send) => {
            unregister = deps.injector?.register(req.runId, send);
          },
          maxRunMs: toggles.maxRunMs,
          log: deps.log.child({ runId: req.runId, sessionId: req.sessionId }),
          spawn: deps.spawn,
          signal,
          onProgress: (update) => onProgress?.(req.runId, progressLine(update)),
          // Gap D7. Persisted immediately rather than after the run, because the case the
          // column exists for is the daemon dying mid-run — at which point "after" never
          // happens.
          onSpawn: (pid) => {
            if (pid !== undefined) deps.store.updateRun(req.runId, { pid });
          },
          onEvent: (e) => runLog.write(e),
        });

        // Gap D6. `classifyOutcome` has read `total_cost_usd` since Phase 4 and the terminal
        // notification threw it away, reporting `$0.0000` on every run because there was no
        // column to read. Written here, on the way past, so it survives even for a run that
        // is about to be classified `failed`: a run that burned twenty dollars and produced
        // nothing is precisely the one an operator needs the number for.
        //
        // ACCUMULATED, not assigned. One run is one row but can be several `claude`
        // sessions: every answered question resumes the run through this same function, and
        // `total_cost_usd` is that SESSION's cost, not the run's. Assigning would silently
        // report only the last session, so a run that asked three questions would under-report
        // by however much the first three sessions cost — the runs that cost the most being
        // exactly the ones it would under-report the worst.
        const priorRun = deps.store.getRun(req.runId);
        const prior =
          priorRun?.kind === 'repo'
            ? { costUsd: priorRun.costUsd ?? 0, tokensUsed: priorRun.tokensUsed ?? 0 }
            : { costUsd: 0, tokensUsed: 0 };
        deps.store.updateRun(req.runId, {
          // The LAST result's `total_cost_usd` IS the session total (M6) — it is cumulative
          // across the results WITHIN one session. So `prior.costUsd + ...` is correct and
          // must NOT be "fixed" into summing every result: that double-counts the session.
          costUsd: prior.costUsd + (outcome.resultEvent?.total_cost_usd ?? 0),
          // The opposite for tokens, and both additions are needed because they add
          // different things. `outcome.tokensUsed` is already summed ACROSS the results in
          // one session (usage is per message, M6); `prior.tokensUsed +` accumulates that
          // across the several SESSIONS one run can have. `usage.test.ts`'s `a resumed run
          // ACCUMULATES` case asserts the outer addition at 300 — do not drop it.
          tokensUsed: prior.tokensUsed + outcome.tokensUsed,
        });

        // The abort may have won the race inside `runAgent`, which reports the reap rather
        // than a verdict. A cancelled run is not a failed one.
        if (signal.aborted) return { status: 'cancelled' };

        // TRAPS T73. `toAgentResult` alone trusts `result.structured_output` verbatim, so an
        // agent that says `complete` having written nothing IS complete as far as the engine
        // can tell — the single silent failure research is most emphatic about (Pitfall 3:
        // judge by evidence in the worktree, never by exit code or self-report). The
        // evidence-based classifier existed in `verdict.ts` from Phase 4 and nothing on the
        // live path called it. Gather the worktree facts and let it decide.
        const evidence = await gatherEvidence(deps, req.cwd, repoSlug, baseRef);
        return toAgentResult(outcome, evidence);
      } finally {
        // In a `finally` so a throwing run still flushes what it managed to say.
        runLog.close();
        // The registry entry goes too. This is the outer half of FLAG-C(b): `runAgent`
        // already closed stdin the moment the run ended, so a `send` between there and
        // here fails honestly rather than lying; this just stops the map growing.
        unregister?.();
      }
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
      pr: { title: string; prBody: PrBodySource; draft?: boolean },
    ): Promise<PullRequest | null> {
      const toggles = togglesFor(deps.config, deps.index, repo.repoSlug);
      const result = await deliverPullRequest({
        runCommand,
        worktreePath: wt.path,
        branch: wt.branch,
        base: wt.baseBranch,
        ownerRepo: repo.repoSlug,
        defaultBranch: repo.baseBranch,
        title: pr.title,
        prBody: pr.prBody,
        // A caller-forced draft wins over the mapping's toggle; it is only ever set to
        // `true`, for a `partial` run (T73). Normal deliveries omit it and get the toggle.
        draft: pr.draft ?? toggles.draftPr,
      });
      // Nothing was pushed and no pull request was opened — the run left no commits in
      // this repository. Passed straight through rather than dressed up as a failure: the
      // caller is the only place that knows whether that is expected.
      if (result === null) return null;
      return { url: result.prUrl, number: prNumberOf(result.prUrl) };
    },
  };
}
