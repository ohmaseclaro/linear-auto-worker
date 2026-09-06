/**
 * The state machine (06-CONTEXT D-01). The only writer of `runs.state`
 * (research invariant 6): `transition()` below is the single choke point, and
 * there is deliberately no other exported path to that column.
 *
 * Contains no SQL. Every read and write goes through the `Store` port; raw
 * statements live in Phase 2's store implementation.
 */
import { canTransition, RUN_STATE_TABLE } from '../domain/state-machine.js';
import { IllegalTransitionError } from '../domain/errors.js';
// T32: the self-event marker is declared once, in the domain barrel. Every
// comment this daemon posts carries it, or the ingress loop-prevention filter
// cannot tell the bot's own comments from a human's and the bot answers itself.
import { BOT_COMMENT_MARKER_PREFIX } from '../domain/index.js';
import type { RepoRun, Run, RunId, RunState } from '../domain/types.js';
import { LOG_DIR } from '../domain/types.js';
import type {
  AgentResult,
  AgentRunner,
  Config,
  Deliverer,
  EngineEvent,
  LinearClient,
  LinearIssue,
  Logger,
  Store,
  WorktreeManager,
} from '../domain/ports.js';
import type { Scheduler } from './scheduler.js';
import type { Questions } from './questions.js';
import { deriveParentStatus, planSubRuns, type FanoutPlan } from './fanout.js';

export interface RunEngine {
  /**
   * The sole writer of `runs.state`. Validates the move against the domain
   * transition table, then writes the state and appends the matching
   * `run_events` row in one transaction (Phase 1 D-03), so a transition that
   * was not recorded is a missing row rather than a missing log line. An
   * illegal move throws and writes nothing.
   */
  transition(runId: RunId, to: RunState, detail?: string): Promise<RepoRun>;
  handle(event: EngineEvent): Promise<void>;
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
  /**
   * Post the terminal comment for an ALREADY-terminal run, guarded so it happens once.
   *
   * T50 / R24. The driver calls this from its `finally`, which covers every run this
   * process drove — and covers nothing else. A run failed by BOOT RECOVERY has no driver
   * by construction (its driver died with the previous process), so before this was on
   * the interface a recovered run was correctly `failed` in the database and in
   * `run_events` while the ticket sat In Progress with no explanation on it. That is the
   * exact silence 06-CONTEXT D-08 exists to forbid, and `recovery.ts` now calls this.
   *
   * Safe to call on a non-terminal run: it returns without writing.
   */
  announceTerminal(runId: RunId): Promise<void>;
  /**
   * Stop driving. Aborts every live child — which reaps its process GROUP through the
   * supervisor's escalation — and tells every driver to stop writing run state.
   *
   * The second half is what makes a clean shutdown lossless (07-CONTEXT D-06). Without
   * it, aborting a live child makes `agent.run` return `cancelled`, the driver
   * transitions the run to `cancelled` (terminal) and posts a terminal comment to the
   * ticket — so Ctrl-C would silently abandon every in-flight run and say so in Linear.
   * With it, the driver unwinds without touching the run, and the daemon's shutdown is
   * free to requeue what is safely requeueable.
   */
  stop(): Promise<void>;
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
  /**
   * Called from `transition()` — the single writer of `runs.state` — with the run as it
   * now is. One call site, deliberately: a notification emitted from a peer site beside
   * the write is how a path that forgets to log gets added later, and with no dashboard
   * the log IS the UI (05-CONTEXT D-04). The composition root owns the fan-out and the
   * vocabulary translation; the engine knows nothing about channels.
   *
   * Synchronous and return-less on purpose. The notifier's own contract is that `emit`
   * never rejects, and a transition must not be able to fail because Slack is down.
   */
  notify?: (run: RepoRun, detail?: string) => void;
  now?: () => number;
}

export function createRunEngine(deps: RunEngineDeps): RunEngine {
  const { store, scheduler, agent, worktrees, deliverer, linear, config, log } = deps;
  const now = deps.now ?? Date.now;

  /** Live child handles, keyed by run. Plan 02's cancel path reaches in here. */
  const aborts = new Map<RunId, AbortController>();
  const inFlight = new Set<Promise<void>>();
  /**
   * Set by `stop()` and never cleared: this engine is finished for the life of the
   * process. Every driver checks it before writing run state, so a child reaped by
   * shutdown unwinds silently instead of being reported as a cancellation.
   */
  let stopping = false;

  function track(p: Promise<void>): void {
    const wrapped = p.catch((err) => log.error({ err: String(err) }, 'run driver threw'));
    inFlight.add(wrapped);
    void wrapped.finally(() => inFlight.delete(wrapped));
  }

  /**
   * D-04, and the reason every reader below narrows on `kind` instead of reading
   * `run.state` off a `Run`: only a REPO run has a state. A ticket-kind parent's status
   * is derived from its children by `deriveParentStatus` and is never read from a column,
   * because there deliberately is no column — that absence is what makes it impossible for
   * a parent and a child to disagree, and that disagreement is exactly how one repo's
   * failure would discard another repo's already-shipped pull request (DELV-07).
   *
   * So: no widening of `RunState`, no state column on `TicketRun`. Transitioning a parent
   * is a caller bug and throws.
   */
  function repoRun(runId: RunId): RepoRun {
    const run = store.getRun(runId);
    if (!run) throw new Error(`no such run: ${runId}`);
    if (run.kind !== 'repo') throw new Error(`run ${runId} is a ticket parent; it has no state`);
    return run;
  }

  async function transition(runId: RunId, to: RunState, detail?: string): Promise<RepoRun> {
    const run = repoRun(runId);
    if (!canTransition(run.state, to)) throw new IllegalTransitionError(run.state, to);

    const at = now();
    store.transaction(() => {
      store.updateRun(runId, { state: to, updatedAt: at });
      store.appendRunEvent({ runId, from: run.state, to, at, detail: detail ?? null });
    });
    log.info({ runId, from: run.state, to }, 'run transitioned');
    const moved: RepoRun = { ...run, state: to, updatedAt: at };
    deps.notify?.(moved, detail);
    return moved;
  }

  /**
   * Creation, not transition: a run's first state arrives with the INSERT, so
   * it cannot go through `transition()` (there is nothing to move from). Its
   * genesis `run_events` row is appended in the same transaction so the event
   * log still mirrors the state sequence exactly.
   *
   * The parent of a multi-repo ticket gets no genesis event, because it has no
   * state to record (D-12, Phase 1 D-04). Each child appends its own rows, so
   * a per-repo outcome stays individually reconstructable (T-06-27).
   */
  function insertPlan(plan: FanoutPlan): void {
    store.transaction(() => {
      if (plan.parent) store.insertRun(plan.parent);
      for (const child of plan.children) {
        store.insertRun(child);
        store.appendRunEvent({
          runId: child.id,
          from: null,
          to: 'queued',
          at: child.createdAt,
          detail: child.repoSlug ? `${child.issueKey} -> ${child.repoSlug}` : child.issueKey,
        });
      }
    });
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
  const rollupKey = (parentRunId: RunId) => `rollup:${parentRunId}`;

  interface Ack {
    commentId: string;
    /** Last position published, so an unchanged position edits nothing. */
    position: number;
    /**
     * The mapped repo list, for a multi-repo ticket. Carried on the ack rather
     * than re-read from config so a mapping edited mid-run cannot rewrite an
     * acknowledgement that was already posted -- the same reason the repo is
     * recorded on the run row.
     */
    repos?: readonly string[];
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

  function ackText(run: Run, position: number, repos?: readonly string[]): string {
    // D-12: one acknowledgement per TICKET, so a ticket over three repos names
    // all three here rather than posting three comments.
    const where =
      repos && repos.length > 1
        ? `${repos.length} repos (${repos.map((r) => `\`${r}\``).join(', ')})`
        : `\`${run.repoSlug}\``;
    return position > 0
      ? `Picked up **${run.issueKey}** — queued, position ${position}. Starting as soon as a slot frees up.`
      : `Picked up **${run.issueKey}** — starting work in ${where}.`;
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
  async function acknowledge(run: Run, repos?: readonly string[]): Promise<string | null> {
    const position = scheduler.positionOf(run.id);
    const created = await attempt('ack', run.id, () =>
      linear.createComment(run.issueId, botBody(ackText(run, position, repos))),
    );
    if (created) writeAck(run.id, { commentId: created.id, position, repos });

    await attempt('in-progress', run.id, () => linear.setIssueState(run.issueId, 'started'));

    // INTK-03: assignee-based pickup takes the ticket out of the operator's
    // "Assigned to me" view for the whole run. Without the subscription they
    // lose sight of their own ticket.
    const operator = config.operatorUserId;
    if (operator) {
      await attempt('subscriber', run.id, () => linear.addSubscriber(run.issueId, operator));
    } else {
      // No wizard step writes `operatorUserId` yet: the daemon authenticates as the BOT,
      // so `viewer()` returns the bot, not the operator (07-CONTEXT P8). Skipped and
      // logged rather than called with `undefined` — the operator can see why their
      // ticket left "Assigned to me".
      log.warn({ runId: run.id }, 'config.operatorUserId unset; INTK-03 subscribe skipped');
    }

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
        linear.updateComment(ack.commentId, botBody(ackText(run, position, ack.repos))),
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
    return `${LOG_DIR}/${runId}.log`;
  }

  function diagnosis(run: RepoRun): string {
    return [
      `Run failed: ${run.failureReason ?? 'unknown failure'}`,
      `Log: \`${logPathFor(run.id)}\``,
      `Branch \`${run.branch}\` and worktree \`${run.worktreePath ?? '(never created)'}\` are left in place for you to inspect.`,
      `This run will not be re-attempted. Re-assign the ticket to run it again.`,
    ].join('\n');
  }

  function terminalText(run: RepoRun): string {
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
    // A ticket parent is announced by the rollup below, never on its own: it has no
    // state of its own to be terminal (D-04).
    if (!run || run.kind !== 'repo' || !RUN_STATE_TABLE[run.state].terminal) return;
    // The guard is written before the call, not after: a second attempt is
    // worse than a missing one here, and the call itself cannot throw.
    if (store.kvGet(terminalKey(runId))) return;
    store.kvSet(terminalKey(runId), run.state);
    // A child of a multi-repo ticket reports through the ticket rollup below
    // instead of on its own: three children posting three terminal comments
    // plus a rollup is the wall of bot noise D-10 exists to prevent. Slack
    // still gets one message per child -- emitting both shapes is Phase 5's.
    if (run.parentRunId) {
      await announceTicketRollup(run.parentRunId);
      return;
    }
    await attempt('terminal', runId, () =>
      linear.createComment(run.issueId, botBody(terminalText(run))),
    );
  }

  function rollupLine(child: RepoRun): string {
    const detail =
      child.prUrl ?? (child.state === 'failed' ? (child.failureReason ?? 'no diagnosis') : '');
    return `- \`${child.repoSlug}\` — **${child.state}**${detail ? ` — ${detail}` : ''}`;
  }

  /**
   * The ticket-level outcome (D-12, DELV-07). Read through `deriveParentStatus`
   * and written NOWHERE: the parent row has no state column value, so parent
   * and children cannot disagree, and a failing child therefore cannot
   * reclassify a delivered sibling's pull request. If this ever grows a cache
   * of the derived status, that cache is the disagreement D-12 forbids.
   *
   * Posted once, by whichever child happens to settle last. Partial success is
   * the normal case here, not an edge case, so the rollup lists every repo's
   * own outcome rather than collapsing to a single verdict.
   */
  async function announceTicketRollup(parentRunId: RunId): Promise<void> {
    const parent = store.getRun(parentRunId);
    if (!parent) return;
    // `childRuns`, the name the port and `sqlite-store.ts` both carry — 06-05 asked for
    // `listRunsByParent`, which is the same query under a second name. It returns terminal
    // children too, which is the whole point of a rollup.
    const children = store.childRuns(parentRunId).filter((c): c is RepoRun => c.kind === 'repo');
    const status = deriveParentStatus(children);
    // Still in flight: a repo that has not finished is not a ticket that has.
    if (!status.settled) return;
    if (store.kvGet(rollupKey(parentRunId))) return;
    store.kvSet(rollupKey(parentRunId), status.state);
    const body = [
      `**${parent.issueKey}** — ${status.state} across ${children.length} repos.`,
      '',
      ...children.map(rollupLine),
    ].join('\n');
    await attempt('rollup', parentRunId, () =>
      linear.createComment(parent.issueId, botBody(body)),
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
    // its turn in the queue finally comes up. A parent has nothing to cancel — its
    // children are cancelled individually.
    if (!run || run.kind !== 'repo' || RUN_STATE_TABLE[run.state].terminal) return;
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
    if (!run || run.kind !== 'repo') return;
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
    // The daemon is shutting down and this child was reaped by `stop()`, not by the
    // operator. Writing anything here would turn a lossless stop into an abandoned run.
    if (stopping) {
      release();
      return;
    }
    switch (result.status) {
      case 'needs_input': {
        // The ordering that matters. Releasing after the write leaves a window
        // in which a blocked run is still counted against the cap, and that
        // window is the bug this phase exists to prevent. Per T11 / D-04 the
        // mechanism is exit-and-resume: the child is already gone, so there is
        // nothing resident to keep alive while the human thinks.
        release();
        await deps.questions().openQuestion(runId, result.question, result.assumption);
        return;
      }
      case 'complete': {
        await transition(runId, 'delivering', result.summary);
        const run = repoRun(runId);
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
  function repoOf(run: RepoRun) {
    return {
      repoDir: run.repoDir,
      repoSlug: run.repoSlug,
      baseBranch: config.defaults.baseBranch,
      enabled: true,
    };
  }

  function worktreeOf(run: RepoRun) {
    return {
      runId: run.id,
      repoDir: run.repoDir,
      path: run.worktreePath!,
      branch: run.branch,
      baseBranch: config.defaults.baseBranch,
    };
  }

  function spawnRequest(run: RepoRun, prompt: string, resume: boolean) {
    return {
      runId: run.id,
      sessionId: run.sessionId!,
      cwd: run.worktreePath!,
      prompt,
      resume,
      env: { LAW_RUN_ID: run.id, LAW_ISSUE_KEY: run.issueKey, LAW_REPO: run.repoSlug },
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
      const queued = repoRun(runId);
      const wt = await worktrees.create(runId, repoOf(queued), queued.branch);
      // The RESOLVED branch, not the requested one. D-11 suffixes a colliding branch name
      // rather than resetting the existing one, so `wt.branch` and `queued.branch` differ
      // on exactly the retries that matter. Recording only the path leaves the run row
      // naming a ref that was never created, and `worktreeOf()` then hands the deliverer
      // that dead name at push time.
      store.updateRun(runId, { branch: wt.branch, worktreePath: wt.path, updatedAt: now() });
      checkpoint(runId);
      const prepared = await transition(runId, 'running', wt.path);
      // ponytail: the real brief (issue body, acceptance criteria, repo list)
      // is composed in execution/prompt.ts -- Phase 4 owns it.
      const result = await agent.run(spawnRequest(prepared, prepared.issueTitle, false), ac.signal);
      // The supervisor checkpoint a `running` cancel waits for.
      checkpoint(runId);
      await dispatch(runId, result, release);
    } catch (err) {
      // `stopping` first: a shutdown abort surfaces here as an ordinary throw from the
      // agent, and classifying it would write a failure diagnosis for a run the operator
      // never failed.
      if (stopping) return;
      if (err instanceof CancelledSignal) await finishCancel(runId, 'cancel requested');
      else await fail(runId, classify(err), err);
    } finally {
      aborts.delete(runId);
      release();
      if (!stopping) {
        await announceTerminal(runId);
        // The release above admitted the next waiter, so everyone behind it moved
        // up. Edit their comments; do not post new ones.
        await refreshQueuePositions();
      }
    }
  }

  /**
   * `questionId` is null for QA-07's `run.resumed`: the disabled-question-flow branch has
   * no question row by construction, so there is nothing to mark answered. Everything
   * after that is identical, which is why it is this function and not a second one.
   */
  async function resumeAfterAnswer(
    questionId: string | null,
    runId: RunId,
    answer: string,
  ): Promise<void> {
    // Slot re-acquired BEFORE the run is put back into a running state, so the
    // semaphore is never behind the state table.
    const release = await scheduler.acquire(runId);
    const ac = new AbortController();
    aborts.set(runId, ac);
    try {
      if (questionId !== null) await deps.questions().applyAnswer(questionId, answer);
      const run = repoRun(runId);
      const result = await agent.run(spawnRequest(run, answer, true), ac.signal);
      checkpoint(runId);
      await dispatch(runId, result, release);
    } catch (err) {
      if (stopping) return;
      if (err instanceof CancelledSignal) await finishCancel(runId, 'cancel requested');
      else await fail(runId, classify(err), err);
    } finally {
      aborts.delete(runId);
      release();
      if (!stopping) {
        await announceTerminal(runId);
        await refreshQueuePositions();
      }
    }
  }

  return {
    transition,
    refreshQueuePositions,
    cancel,
    isCancelRequested,
    announceTerminal,

    /**
     * OPS-05 step 2. Aborting is what reaps the child's process GROUP: the supervisor
     * listens on this signal and runs the negated-pid escalation (SIGINT -> SIGTERM ->
     * SIGKILL, liveness checked between steps). Signalling the leader alone would orphan
     * the agent's own Bash subprocesses and leave the supervisor's promise permanently
     * pending, which is T29 measured rather than assumed.
     */
    async stop(): Promise<void> {
      stopping = true;
      for (const ac of aborts.values()) ac.abort();
      // Not awaited here: the caller bounds the wait, because a group that needs the full
      // SIGINT+SIGTERM ladder takes 25 seconds and an operator pressing Ctrl-C twice must
      // not be made to wait it out.
      await Promise.resolve();
    },

    async handle(event: EngineEvent): Promise<void> {
      switch (event.kind) {
        case 'run.requested': {
          // One live run per issue, checked HERE because here is where the two producers
          // meet. Ingress requests a run on an assignment webhook; the boot sweep requests
          // one for every bot-assigned open issue it finds. Both are correct on their own
          // and together they double: Linear retries a failed delivery for up to six
          // hours, so a delivery that could not land while the daemon was down arrives
          // moments AFTER the boot sweep has already enqueued the same issue. Two runs is
          // two worktrees, two `claude` sessions and two pull requests for one ticket.
          //
          // `reconcile()` carries its own copy of this check as an early-out that avoids a
          // `getIssue` round-trip. This one is the load-bearing one, because it is the
          // only one on the webhook path.
          if (store.findActiveRunByIssue(event.issueId).length > 0) {
            log.info({ issueId: event.issueId }, 'a run is already live for this issue; ignoring');
            return;
          }
          // Invariant 2: decide from the canonical issue, never from webhook body.
          const issue = await linear.getIssue(event.issueId);
          const mapping = resolveMapping(issue);
          if (!mapping) {
            log.warn({ issueId: issue.id }, 'no repo mapping for issue; ignoring');
            return;
          }
          // D-12 / DELV-06. Fan-out happens HERE, at the engine, and never
          // inside an agent session: one child run per mapped repo, each with
          // its own worktree, branch, session and state. One repo stays one run
          // with no parent, exactly as before.
          const plan = planSubRuns(issue, mapping, { now });
          if (plan.children.length === 0) {
            log.warn({ issueId: issue.id }, 'mapping has no repos; ignoring');
            return;
          }
          insertPlan(plan);
          // Park each child for its OWN slot (D-03). Each is a real `claude`
          // process, so a ticket over three repos legitimately fills a
          // three-slot daemon -- the cap bounds local RAM, and a design where
          // N repos cost one slot would quietly break the thing it is for.
          // The parent is a row, not a runnable thing: it is never enqueued.
          // Parking holds nothing and returns immediately; it exists only so
          // the acknowledgement below can carry a real `positionOf()`.
          const slots = plan.children.map((child) => scheduler.acquire(child.id));
          // D-09, in order and before the worktree port is reachable at all:
          // insert at `queued` (above), acknowledge, In Progress, subscribe.
          //
          // Once per TICKET, not once per child. Three children must not
          // produce three ack comments, three In Progress transitions and three
          // subscriptions. The lead child owns the single ack comment, so it is
          // also the only one whose queue position edits it -- the others have
          // no ack entry and `refreshQueuePositions` already no-ops on that.
          const repos = plan.children.map((c) => c.repoSlug);
          const ackCommentId = await acknowledge(plan.children[0], repos);
          plan.children.forEach((child, i) => {
            // No sequencing between children beyond the global semaphore.
            track(drive(child.id, i === 0 ? ackCommentId : null, slots[i]));
          });
          return;
        }
        case 'run.cancelled': {
          // Unassignment is an issue-level event. A multi-repo ticket has one
          // child run per repo (D-03/D-12) and all of them stop, each under
          // plan 02's per-state cancel rules: a child with no live process
          // transitions now, one with a live process gets the cancel-requested
          // flag, and an already-terminal child is left exactly as it is.
          //
          // The parent needs no cancel handling of its own -- its status is
          // derived from precisely these children. It is filtered out because
          // it has no state to look up in the transition table.
          const active = store
            .findActiveRunByIssue(event.issueId)
            .filter((run) => run.kind !== 'ticket');
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
        case 'run.resumed': {
          // QA-07. The run never parked, so it never entered `awaiting_answer` and there
          // is no question row to close — but it DID release its slot in `dispatch`, so
          // the resume re-acquires one exactly like an answered question does.
          track(resumeAfterAnswer(null, event.runId, event.input));
          return;
        }
        case 'ignored':
          log.debug({ reason: event.reason }, 'event ignored');
          return;
      }
    },

    async settle(): Promise<void> {
      while (inFlight.size > 0) await Promise.all([...inFlight]);
    },
  };
}
