/**
 * The state machine (06-CONTEXT D-01). The only writer of `runs.state`
 * (research invariant 6): `transition()` below is the single choke point, and
 * there is deliberately no other exported path to that column.
 *
 * Contains no SQL. Every read and write goes through the `Store` port; raw
 * statements live in Phase 2's store implementation.
 */
import { randomUUID } from 'node:crypto';
import { canTransition } from '../domain/state-machine.js';
import { IllegalTransitionError } from '../domain/errors.js';
import type { Run, RunId, RunState } from '../domain/types.js';
import type {
  AgentResult,
  AgentRunner,
  Config,
  Deliverer,
  DomainEvent,
  LinearClient,
  LinearIssue,
  Logger,
  Store,
  WorktreeManager,
} from '../domain/ports.js';
import type { Scheduler } from './scheduler.js';
import type { Questions } from './questions.js';

export interface RunEngine {
  /**
   * The sole writer of `runs.state`. Validates the move against the domain
   * transition table, then writes the state and appends the matching
   * `run_events` row in one transaction (Phase 1 D-03), so a transition that
   * was not recorded is a missing row rather than a missing log line. An
   * illegal move throws and writes nothing.
   */
  transition(runId: RunId, to: RunState, detail?: string): Promise<Run>;
  handle(event: DomainEvent): Promise<void>;
  /** Resolves once every run this engine is driving has settled. */
  settle(): Promise<void>;
}

export interface RunEngineDeps {
  store: Store;
  scheduler: Scheduler;
  agent: AgentRunner;
  worktrees: WorktreeManager;
  deliverer: Deliverer;
  linear: LinearClient;
  config: Config;
  log: Logger;
  /** Late-bound: questions calls back into the engine, so this breaks the cycle. */
  questions: () => Questions;
  now?: () => number;
}

export function createRunEngine(deps: RunEngineDeps): RunEngine {
  const { store, scheduler, agent, worktrees, deliverer, linear, config, log } = deps;
  const now = deps.now ?? Date.now;

  /** Live child handles, keyed by run. Plan 02's cancel path reaches in here. */
  const aborts = new Map<RunId, AbortController>();
  const inFlight = new Set<Promise<void>>();

  function track(p: Promise<void>): void {
    const wrapped = p.catch((err) => log.error({ err: String(err) }, 'run driver threw'));
    inFlight.add(wrapped);
    void wrapped.finally(() => inFlight.delete(wrapped));
  }

  async function transition(runId: RunId, to: RunState, detail?: string): Promise<Run> {
    const run = store.getRun(runId);
    if (!run) throw new Error(`no such run: ${runId}`);
    if (!canTransition(run.state, to)) throw new IllegalTransitionError(run.state, to);

    const at = now();
    store.transaction(() => {
      store.updateRun(runId, { state: to, updatedAt: at });
      store.appendRunEvent({ runId, from: run.state, to, at, detail: detail ?? null });
    });
    log.info({ runId, from: run.state, to }, 'run transitioned');
    return { ...run, state: to, updatedAt: at };
  }

  /**
   * Creation, not transition: a run's first state arrives with the INSERT, so
   * it cannot go through `transition()` (there is nothing to move from). Its
   * genesis `run_events` row is appended in the same transaction so the event
   * log still mirrors the state sequence exactly.
   */
  function createRun(issue: LinearIssue, repo: { repoDir: string; repoSlug: string }): Run {
    const at = now();
    const run: Run = {
      id: randomUUID(),
      parentRunId: null,
      kind: 'repo',
      issueId: issue.id,
      issueKey: issue.identifier,
      issueTitle: issue.title,
      issueUrl: issue.url,
      repoDir: repo.repoDir,
      repoSlug: repo.repoSlug,
      branch: issue.branchName,
      worktreePath: null,
      // T4: pre-assigned and persisted before any spawn, never parsed out of
      // the event stream.
      sessionId: randomUUID(),
      pid: null,
      state: 'queued',
      attempt: 0,
      questionRound: 0,
      prUrl: null,
      failureReason: null,
      createdAt: at,
      updatedAt: at,
    };
    store.transaction(() => {
      store.insertRun(run);
      store.appendRunEvent({ runId: run.id, from: null, to: 'queued', at, detail: issue.identifier });
    });
    return run;
  }

  /** D-07: project-keyed with a team-level fallback, so a project-less issue
   *  is not silently dropped. */
  function resolveMapping(issue: LinearIssue) {
    const byProject = issue.projectId ? config.mappings[issue.projectId] : undefined;
    return byProject ?? (issue.teamId ? config.mappings[issue.teamId] : undefined);
  }

  async function fail(runId: RunId, reason: string): Promise<void> {
    // T17 / D-13: a failed run is attempted exactly once. No retry loop, no
    // requeue. The branch and worktree are left for the operator.
    store.updateRun(runId, { failureReason: reason, updatedAt: now() });
    await transition(runId, 'failed', reason);
  }

  async function dispatch(runId: RunId, result: AgentResult, release: () => void): Promise<void> {
    switch (result.status) {
      case 'needs_input': {
        // The ordering that matters. Releasing after the write leaves a window
        // in which a blocked run is still counted against the cap, and that
        // window is the bug this phase exists to prevent. Per T11 / D-04 the
        // mechanism is exit-and-resume: the child is already gone, so there is
        // nothing resident to keep alive while the human thinks.
        release();
        await deps.questions().openQuestion(runId, result.question, result.assumptionIfUnanswered);
        return;
      }
      case 'complete': {
        await transition(runId, 'delivering', result.summary);
        const run = store.getRun(runId)!;
        const pr = await deliverer.deliver(worktreeOf(run), repoOf(run), {
          title: result.prTitle,
          body: result.prBody,
        });
        store.updateRun(runId, { prUrl: pr.url, updatedAt: now() });
        await transition(runId, 'delivered', pr.url);
        release();
        return;
      }
      default:
        release();
        await fail(runId, 'failureReason' in result ? result.failureReason : result.status);
    }
  }

  /**
   * The repo this run owns. Recorded on the run row at creation, so recovering
   * it never has to re-resolve config -- a mapping edited mid-run cannot move
   * a live run to a different repository.
   */
  function repoOf(run: Run) {
    return {
      repoDir: run.repoDir!,
      repoSlug: run.repoSlug!,
      baseBranch: config.defaults.baseBranch,
      enabled: true,
    };
  }

  function worktreeOf(run: Run) {
    return {
      runId: run.id,
      repoDir: run.repoDir!,
      path: run.worktreePath!,
      branch: run.branch!,
      baseBranch: config.defaults.baseBranch,
    };
  }

  function spawnRequest(run: Run, prompt: string, resume: boolean) {
    return {
      runId: run.id,
      sessionId: run.sessionId!,
      cwd: run.worktreePath!,
      prompt,
      resume,
      env: { LAW_RUN_ID: run.id, LAW_ISSUE_KEY: run.issueKey, LAW_REPO: run.repoSlug ?? '' },
    };
  }

  async function drive(runId: RunId): Promise<void> {
    // Parks here with no slot held until one is free. `awaiting_answer` runs
    // are not in the admitted set, so they cannot starve this.
    const release = await scheduler.acquire(runId);
    const ac = new AbortController();
    aborts.set(runId, ac);
    try {
      await transition(runId, 'preparing', 'slot acquired');
      const queued = store.getRun(runId)!;
      const wt = await worktrees.create(runId, repoOf(queued), queued.branch!);
      store.updateRun(runId, { worktreePath: wt.path, updatedAt: now() });
      const prepared = await transition(runId, 'running', wt.path);
      // ponytail: the real brief (issue body, acceptance criteria, repo list)
      // is composed in execution/prompt.ts -- Phase 4 owns it.
      const result = await agent.run(spawnRequest(prepared, prepared.issueTitle, false), ac.signal);
      await dispatch(runId, result, release);
    } catch (err) {
      await fail(runId, String(err));
    } finally {
      aborts.delete(runId);
      release();
    }
  }

  async function resumeAfterAnswer(questionId: string, runId: RunId, answer: string): Promise<void> {
    // Slot re-acquired BEFORE the run is put back into a running state, so the
    // semaphore is never behind the state table.
    const release = await scheduler.acquire(runId);
    const ac = new AbortController();
    aborts.set(runId, ac);
    try {
      await deps.questions().applyAnswer(questionId, answer);
      const run = store.getRun(runId)!;
      const result = await agent.run(spawnRequest(run, answer, true), ac.signal);
      await dispatch(runId, result, release);
    } catch (err) {
      await fail(runId, String(err));
    } finally {
      aborts.delete(runId);
      release();
    }
  }

  return {
    transition,

    async handle(event: DomainEvent): Promise<void> {
      switch (event.kind) {
        case 'run.requested': {
          // Invariant 2: decide from the canonical issue, never from webhook body.
          const issue = await linear.getIssue(event.issueId);
          const mapping = resolveMapping(issue);
          if (!mapping) {
            log.warn({ issueId: issue.id }, 'no repo mapping for issue; ignoring');
            return;
          }
          // ponytail: one repo here. Plan 05 fans a ticket into one child run
          // per repo; each child is already a first-class run to this engine.
          const run = createRun(issue, mapping.repos[0]);
          track(drive(run.id));
          return;
        }
        case 'question.answered': {
          const q = store.getQuestion(event.questionId);
          if (!q || q.status !== 'open') {
            log.warn({ questionId: event.questionId }, 'answer for a question that is not open');
            return;
          }
          track(resumeAfterAnswer(q.id, q.runId, event.answer));
          return;
        }
        default:
          return;
      }
    },

    async settle(): Promise<void> {
      while (inFlight.size > 0) await Promise.all([...inFlight]);
    },
  };
}
