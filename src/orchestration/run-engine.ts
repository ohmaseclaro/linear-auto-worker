/**
 * The state machine (06-CONTEXT D-01). The only writer of `runs.state`
 * (research invariant 6): `transition()` below is the single choke point, and
 * there is deliberately no other exported path to that column.
 *
 * Contains no SQL. Every read and write goes through the `Store` port; raw
 * statements live in Phase 2's store implementation.
 */
import { randomUUID } from 'node:crypto';
import { canTransition, RUN_STATE_TABLE } from '../domain/state-machine.js';
import { IllegalTransitionError } from '../domain/errors.js';
// T32: the self-event marker is declared once, in the domain barrel. Every
// comment this daemon posts carries it, or the ingress loop-prevention filter
// cannot tell the bot's own comments from a human's and the bot answers itself.
import { BOT_COMMENT_MARKER_PREFIX } from '../domain/index.js';
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
  /**
   * D-11 / INTK-08. Accepted from every non-terminal state; a no-op from a
   * terminal one. States with no live child move to `cancelled` now; states
   * with one record a cancel-requested flag instead.
   */
  cancel(runId: RunId, reason?: string): Promise<void>;
  /** The read the supervisor checkpoint consults (D-11). */
  isCancelRequested(runId: RunId): boolean;
  /** D-10: re-edit the queue-position comment of every still-queued run. */
  refreshQueuePositions(): Promise<void>;
  /** Resolves once every run this engine is driving has settled. */
  settle(): Promise<void>;
}

/**
 * Thrown by `checkpoint()` to unwind the work path when a cancel has been
 * requested. Local on purpose: it is control flow inside this module, not a
 * domain error anyone else catches.
 */
class CancelledSignal extends Error {
  constructor() {
    super('cancel requested');
  }
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

  // --- notification plumbing ------------------------------------------------
  //
  // The ack comment id lives in `kv` rather than in a new `runs` column: it is
  // one string per run, it survives a restart (so a restarted daemon still
  // EDITS the position comment instead of posting a second one, D-10), and it
  // costs no schema change on a table five layers already agree on.

  const ackKey = (runId: RunId) => `ack:${runId}`;
  const cancelKey = (runId: RunId) => `cancel:${runId}`;
  const terminalKey = (runId: RunId) => `terminal:${runId}`;

  interface Ack {
    commentId: string;
    /** Last position published, so an unchanged position edits nothing. */
    position: number;
  }

  function readAck(runId: RunId): Ack | null {
    const raw = store.kvGet(ackKey(runId));
    return raw ? (JSON.parse(raw) as Ack) : null;
  }

  function writeAck(runId: RunId, ack: Ack): void {
    store.kvSet(ackKey(runId), JSON.stringify(ack));
  }

  /** T32: never re-derive the marker, never post a comment without it. */
  function botBody(text: string): string {
    return `${BOT_COMMENT_MARKER_PREFIX}\n\n${text}`;
  }

  /**
   * A notification channel must never fail a run (T-06-08). A Linear outage
   * degrades ticket visibility; it does not stall the queue. Resolves to `null`
   * when the call threw, and to the call's own value otherwise -- which for a
   * void call is `undefined`, so `!== null` is the success test.
   */
  async function attempt<T>(what: string, runId: RunId, fn: () => Promise<T>): Promise<T | null> {
    try {
      return await fn();
    } catch (err) {
      log.warn({ runId, what, err: String(err) }, 'notification failed; run continues');
      return null;
    }
  }

  function ackText(run: Run, position: number): string {
    return position > 0
      ? `Picked up **${run.issueKey}** — queued, position ${position}. Starting as soon as a slot frees up.`
      : `Picked up **${run.issueKey}** — starting work in \`${run.repoSlug}\`.`;
  }

  /**
   * D-09 / INTK-02 / INTK-03 / invariant 12. The run row is already at `queued`
   * when we get here; these three Linear calls are everything else that must
   * happen before any worktree or git work.
   *
   * Ten seconds is the budget and the ordering is what makes it achievable:
   * three API calls are fast, a cold `git fetch` is not. Returned as an id that
   * `drive()` takes as a parameter, so the work path cannot start without this
   * having run — there would be nothing to pass it.
   */
  async function acknowledge(run: Run): Promise<string | null> {
    const position = scheduler.positionOf(run.id);
    const created = await attempt('ack', run.id, () =>
      linear.createComment(run.issueId, botBody(ackText(run, position))),
    );
    if (created) writeAck(run.id, { commentId: created.id, position });

    await attempt('in-progress', run.id, () => linear.setIssueState(run.issueId, 'started'));

    // INTK-03: assignee-based pickup takes the ticket out of the operator's
    // "Assigned to me" view for the whole run. Without the subscription they
    // lose sight of their own ticket.
    await attempt('subscriber', run.id, () =>
      linear.addSubscriber(run.issueId, config.operatorUserId),
    );

    return created?.id ?? null;
  }

  /**
   * D-10 / INTK-06. The position is shown by EDITING the acknowledgement
   * comment. A queue that moves three times must leave exactly one comment on
   * the ticket, not four — one ticket turning into a wall of bot noise is how
   * an operator learns to mute the bot.
   */
  async function refreshQueuePositions(): Promise<void> {
    for (const run of store.listByState('queued')) {
      const ack = readAck(run.id);
      // A swallowed acknowledgement leaves no edit target. Posting a fresh
      // comment here would defeat the whole point, so this no-ops instead.
      if (!ack) continue;
      const position = scheduler.positionOf(run.id);
      if (position === 0 || position === ack.position) continue;
      const updated = await attempt('position', run.id, () =>
        linear.updateComment(ack.commentId, botBody(ackText(run, position))),
      );
      if (updated !== null) writeAck(run.id, { ...ack, position });
    }
  }

  /**
   * T-06-06: what reaches the ticket is a short classification. The raw error
   * only ever reaches the log file, whose PATH is what the comment carries —
   * a serialized SDK error routinely carries request headers, and therefore the
   * API key, into a comment everyone in the workspace can read.
   */
  function classify(err: unknown): string {
    const msg = err instanceof Error ? err.message : String(err);
    return msg.split('\n')[0].slice(0, 200);
  }

  function logPathFor(runId: RunId): string {
    return `${config.logDir}/${runId}.log`;
  }

  function diagnosis(run: Run): string {
    return [
      `Run failed: ${run.failureReason ?? 'unknown failure'}`,
      `Log: \`${logPathFor(run.id)}\``,
      `Branch \`${run.branch}\` and worktree \`${run.worktreePath ?? '(never created)'}\` are left in place for you to inspect.`,
      `This run will not be re-attempted. Re-assign the ticket to run it again.`,
    ].join('\n');
  }

  function terminalText(run: Run): string {
    switch (run.state) {
      case 'delivered':
        return `Done — ${run.prUrl}`;
      case 'partial':
        return `Partially delivered${run.prUrl ? ` — ${run.prUrl}` : ''}. See the child runs for what did not ship.`;
      case 'cancelled':
        return `Cancelled. Branch \`${run.branch}\` and its worktree are left in place.`;
      default:
        return diagnosis(run);
    }
  }

  /**
   * Invariant 11: the terminal state is always reported, from a `finally`, and
   * reported exactly once. A crash, a throw in the delivering path or a
   * rejected push all still produce one comment — silence on failure is the
   * loudest complaint in this product category.
   */
  async function announceTerminal(runId: RunId): Promise<void> {
    const run = store.getRun(runId);
    if (!run || !RUN_STATE_TABLE[run.state].terminal) return;
    // The guard is written before the call, not after: a second attempt is
    // worse than a missing one here, and the call itself cannot throw.
    if (store.kvGet(terminalKey(runId))) return;
    store.kvSet(terminalKey(runId), run.state);
    await attempt('terminal', runId, () =>
      linear.createComment(run.issueId, botBody(terminalText(run))),
    );
  }

  // --- cancellation (D-11, INTK-08) -----------------------------------------

  function isCancelRequested(runId: RunId): boolean {
    return store.kvGet(cancelKey(runId)) !== undefined;
  }

  /**
   * The supervisor checkpoint D-11 names. Called between the awaits of the work
   * path: a cancel arriving while a child is live is honored HERE, not at
   * request time.
   */
  function checkpoint(runId: RunId): void {
    if (isCancelRequested(runId)) throw new CancelledSignal();
    if (store.getRun(runId)?.state === 'cancelled') throw new CancelledSignal();
  }

  async function finishCancel(runId: RunId, reason: string): Promise<void> {
    const run = store.getRun(runId);
    // Idempotent: a run cancelled while parked reaches here a second time when
    // its turn in the queue finally comes up.
    if (!run || RUN_STATE_TABLE[run.state].terminal) return;
    for (const q of store.openQuestionsForIssue(run.issueId)) {
      if (q.runId === runId) store.updateQuestion(q.id, { status: 'cancelled' });
    }
    await transition(runId, 'cancelled', reason);
    // An `awaiting_answer` run has no driver in flight -- it exited and is
    // waiting on a human -- so there is no `finally` to report its terminal
    // state. Report it here. The emission is kv-guarded, so the driver's
    // `finally` on the other cancel paths does not double it (invariant 11).
    await announceTerminal(runId);
  }

  /**
   * D-11 / INTK-08 / Phase 1 D-05. Two tiers, split on the state table's own
   * `hasLiveChild` rather than on a hand-written list of state names — the list
   * is the thing that goes stale when a tenth state lands.
   */
  async function cancel(runId: RunId, reason = 'bot unassigned'): Promise<void> {
    const run = store.getRun(runId);
    if (!run) return;
    const info = RUN_STATE_TABLE[run.state];

    // Terminal is terminal (T-06-09). No transition, no throw: a replayed
    // unassignment must not disturb a run that already shipped.
    if (info.terminal) {
      log.info({ runId, state: run.state }, 'cancel ignored; run is already terminal');
      return;
    }

    if (info.hasLiveChild) {
      // Setting the flag is idempotent, so cancelling twice leaves one flag and
      // produces one eventual transition.
      if (isCancelRequested(runId)) return;
      store.kvSet(cancelKey(runId), String(now()));
      // T-06-10: the request and the eventual transition are both rows, so a
      // cancel that was asked for and never honored is visible after the fact.
      store.appendRunEvent({
        runId,
        from: run.state,
        to: run.state,
        at: now(),
        detail: `cancel requested: ${reason}`,
      });
      aborts.get(runId)?.abort();
      log.info({ runId, state: run.state }, 'cancel requested; honored at the next checkpoint');
      return;
    }

    // No live child: nothing has been pushed, so stopping now claims nothing
    // that did not happen.
    await finishCancel(runId, reason);
  }

  async function fail(runId: RunId, reason: string, raw?: unknown): Promise<void> {
    // T17 / D-13 / OPS-04: a failed run is attempted exactly once. No retry
    // loop, no requeue, no threshold. The branch and worktree are deliberately
    // left in place — the worktree cleanup port is NOT called on this path.
    // `ARCHITECTURE.md`'s bounded `failed -> queued` row is superseded: a second
    // attempt on a run whose branch is already pushed produces a second PR for
    // work that already shipped.
    if (raw !== undefined) log.error({ runId, err: String(raw) }, 'run failed');
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
      case 'cancelled': {
        // The child honored the abort. This is a cancellation, not a failure --
        // routing it to `failed` would post a diagnosis for work the operator
        // deliberately stopped.
        release();
        await finishCancel(runId, 'agent reported cancelled');
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

  /**
   * The work path. It takes the acknowledgement comment id as a parameter
   * rather than looking it up, so work structurally cannot start before the
   * acknowledgement has happened (D-09) — there would be nothing to pass.
   *
   * It also takes the slot as an unawaited promise: the run parked for its slot
   * before `acknowledge()` ran, so the acknowledgement could carry a real queue
   * position. Parking holds nothing and costs nothing, so it is not "work".
   */
  async function drive(
    runId: RunId,
    ackCommentId: string | null,
    slot: Promise<() => void>,
  ): Promise<void> {
    // Parks here with no slot held until one is free. `awaiting_answer` runs
    // are not in the admitted set, so they cannot starve this.
    const release = await slot;
    const ac = new AbortController();
    aborts.set(runId, ac);
    try {
      // Cancelled while parked: the run took its turn in the queue only to
      // find it had already stopped.
      checkpoint(runId);
      await transition(runId, 'preparing', ackCommentId ?? 'slot acquired');
      const queued = store.getRun(runId)!;
      const wt = await worktrees.create(runId, repoOf(queued), queued.branch!);
      store.updateRun(runId, { worktreePath: wt.path, updatedAt: now() });
      checkpoint(runId);
      const prepared = await transition(runId, 'running', wt.path);
      // ponytail: the real brief (issue body, acceptance criteria, repo list)
      // is composed in execution/prompt.ts -- Phase 4 owns it.
      const result = await agent.run(spawnRequest(prepared, prepared.issueTitle, false), ac.signal);
      // The supervisor checkpoint a `running` cancel waits for.
      checkpoint(runId);
      await dispatch(runId, result, release);
    } catch (err) {
      if (err instanceof CancelledSignal) await finishCancel(runId, 'cancel requested');
      else await fail(runId, classify(err), err);
    } finally {
      aborts.delete(runId);
      release();
      await announceTerminal(runId);
      // The release above admitted the next waiter, so everyone behind it moved
      // up. Edit their comments; do not post new ones.
      await refreshQueuePositions();
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
      checkpoint(runId);
      await dispatch(runId, result, release);
    } catch (err) {
      if (err instanceof CancelledSignal) await finishCancel(runId, 'cancel requested');
      else await fail(runId, classify(err), err);
    } finally {
      aborts.delete(runId);
      release();
      await announceTerminal(runId);
      await refreshQueuePositions();
    }
  }

  return {
    transition,
    refreshQueuePositions,
    cancel,
    isCancelRequested,

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
          // Park for a slot first. This holds nothing, spends nothing and
          // returns immediately -- it exists only so the acknowledgement below
          // can carry a real `positionOf()` rather than guessing.
          const slot = scheduler.acquire(run.id);
          // D-09, in order and before the worktree port is reachable at all:
          // insert at `queued` (above), acknowledge, In Progress, subscribe.
          const ackCommentId = await acknowledge(run);
          track(drive(run.id, ackCommentId, slot));
          return;
        }
        case 'run.cancelled': {
          // Unassignment is an issue-level event. A multi-repo ticket has one
          // child run per repo (D-03/D-12) and all of them stop.
          const active = store.findActiveRunByIssue(event.issueId);
          if (active.length === 0) {
            log.info({ issueId: event.issueId }, 'cancel for an issue with no active run');
            return;
          }
          for (const run of active) await cancel(run.id, event.reason);
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
