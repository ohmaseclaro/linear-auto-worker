/**
 * The state machine (06-CONTEXT D-01). The only writer of `runs.state`
 * (research invariant 6): `transition()` below is the single choke point, and
 * there is deliberately no other exported path to that column.
 *
 * Contains no SQL. Every read and write goes through the `Store` port; raw
 * statements live in Phase 2's store implementation.
 */
import { randomUUID } from 'node:crypto';
import { rmdir } from 'node:fs/promises';
import { basename } from 'node:path';

import { canTransition, RUN_STATE_TABLE } from '../domain/state-machine.js';
import { IllegalTransitionError } from '../domain/errors.js';
// T32: the self-event marker is declared once, in the domain barrel. Every
// comment this daemon posts carries it, or the ingress loop-prevention filter
// cannot tell the bot's own comments from a human's and the bot answers itself.
import { BOT_COMMENT_MARKER } from '../domain/index.js';
import type { RepoRun, Run, RunId, RunState } from '../domain/types.js';
import { daemonDirOf, repoMappingFor } from '../domain/types.js';
import { runLogPath } from '../execution/run-log.js';
import type {
  AgentResult,
  AgentRunner,
  Config,
  Deliverer,
  EngineEvent,
  LinearClient,
  LinearIssue,
  Logger,
  PrBodySource,
  Store,
  WorktreeManager,
} from '../domain/ports.js';
import { buildAgentPrompt, buildAnswerPrompt } from '../execution/prompt.js';
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
   * Drive every run this process finds sitting at `queued` with no driver behind it —
   * the queue a PREVIOUS process left in the database. Returns the ids it started.
   *
   * **This is resumption, not retry.** A `queued` row is an attempt that was interrupted
   * before it finished, not one that finished badly, so driving it does not violate
   * OPS-04/T17 ("a run is attempted exactly once"). And the guarantee is not this
   * sentence — it is the SELECTION. The drain reads `state = 'queued'` and nothing else,
   * and `queued` is unreachable from every terminal state
   * (`canTransition('failed', 'queued') === false`, pinned by `state-machine.test.ts`).
   * Widen this query to a terminal state and it becomes the bounded `failed -> queued`
   * auto-retry T17 forbids — at which point `run-engine.test.ts`'s "the drain never
   * touches a terminal run" goes red at exactly that edit. Do not bound it by `attempt`
   * either: that counter IS the vestige of the forbidden retry (see `types.ts`).
   *
   * **Boot only, and that is a claim about the writers.** Exactly three sites write
   * `queued`: `insertPlan` (ingress and poll — `handle` calls `drive()` in the same turn,
   * so the row is never driverless), `recoverAtBoot` (`preparing -> queued` at boot), and
   * `markInFlight` (`running -> queued` at shutdown, after which the process exits). Only
   * the last two leave a driverless row, and both are bounded by an operator action —
   * a Ctrl-C or a re-boot. So there is no tick case to guard today. If a fourth writer is
   * ever added, calling this from the tick is one line and the `driving` filter below is
   * already what makes that safe.
   */
  dispatchQueued(): RunId[];
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
  /**
   * Runs this process has a driver for, INCLUDING the ones still parked for a slot.
   *
   * Deliberately not `aborts`: `stop()` depends on `aborts` holding only runs that already
   * have a slot and can therefore have a child process behind them, and widening it would
   * make Ctrl-C on an idle daemon wait out the full child-reap budget for a driver that
   * holds nothing. This set answers a different question — "is anyone already driving this
   * row?" — and `dispatchQueued` is its only reader.
   */
  const driving = new Set<RunId>();
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

  /**
   * Narrow a mapping's repositories to the ones a ticket actually needs.
   *
   * **The operator's mapping is the privilege boundary.** It is his declaration of which
   * repositories this bot may write to, and nothing here can add to it. The intersection
   * below is the ENFORCEMENT of that boundary: a discovery session reads attacker-authorable
   * ticket text, so an unvalidated name from it would be a Linear user choosing which
   * repository the daemon writes into. It can only ever make the set SMALLER.
   *
   * Every arm of the fallback lands on the mapping's own list, which is why fail-open is
   * not an escalation here: the worst case is the wasteful-but-correct shape the ticket
   * path already ships. The alternative — refusing to run — would let a flaky classifier
   * silently kill every ticket, which is the failure this product category is judged on.
   *
   * Each arm is logged distinctly. A fallback that cannot be told from a success in the log
   * is a fallback nobody will ever notice firing.
   */
  async function narrowRepos(
    issue: LinearIssue,
    repos: readonly Config['mappings'][string]['repos'][number][],
  ): Promise<Config['mappings'][string]['repos']> {
    // Nothing to narrow, and no session to pay for. `planSubRuns` does not fan out below
    // two repos anyway, so a discovery session here would buy a classification nobody
    // could act on.
    if (repos.length < 2) return [...repos];

    const slugs = repos.map((r) => r.repoSlug);
    let answer: string[] | undefined;
    try {
      answer = await agent.discoverRepos({
        issueId: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description ?? '',
        url: issue.url,
        repoSlugs: slugs,
      });
    } catch (err) {
      // The adapter already swallows a session that failed; this catches the rest — a
      // crash in the adapter itself must not be able to kill a ticket either.
      log.warn(
        { issueId: issue.id, err: String(err) },
        'repo discovery threw; using every mapped repository',
      );
      return [...repos];
    }

    if (answer === undefined) {
      log.warn(
        { issueId: issue.id, repos: slugs },
        'repo discovery could not answer; using every mapped repository',
      );
      return [...repos];
    }

    // THE PRIVILEGE BOUNDARY'S ENFORCEMENT. `slugs` is the operator's own list; anything
    // the session named that is not on it is discarded, by name, loudly.
    const mapped = new Set(slugs);
    const invented = answer.filter((name) => !mapped.has(name));
    if (invented.length > 0) {
      log.warn(
        { issueId: issue.id, invented, mapped: slugs },
        'repo discovery named repositories that are not in this mapping; dropping them',
      );
    }
    const kept = repos.filter((r) => answer.includes(r.repoSlug));
    if (kept.length === 0) {
      log.warn(
        { issueId: issue.id, answered: answer, mapped: slugs },
        'repo discovery narrowed to nothing; using every mapped repository',
      );
      return [...repos];
    }
    log.info(
      { issueId: issue.id, kept: kept.map((r) => r.repoSlug), mapped: slugs },
      'repo discovery narrowed the ticket',
    );
    return kept;
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

  /**
   * T32: never re-derive the marker, never post a comment without it. T119: the `\n\n` is
   * behaviour — the marker is a CommonMark link reference definition and is only invisible
   * in block position.
   */
  function botBody(text: string): string {
    return `${BOT_COMMENT_MARKER}\n\n${text}`;
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
   * ponytail: 1000 is a ceiling, not a page size. A three-slot single-operator daemon with
   * a thousand-deep queue has a different problem than this function solves.
   */
  const DRAIN_LIMIT = 1000;

  /** See the `RunEngine` interface for why this is resumption and why it is boot-only. */
  function dispatchQueued(): RunId[] {
    const runs = store
      // `nextQueued`, NOT `listByState('queued')`. The difference is the
      // `ORDER BY created_at ASC` this one carries, and that ordering is what makes
      // admission FIFO across a restart rather than whatever order SQLite hands back.
      .nextQueued(DRAIN_LIMIT)
      // A ticket parent can never be `queued` — the migration's CHECK constraint gives it
      // a NULL state — so this is the type narrowing and the invariant at once, the same
      // way `recoverAtBoot` does it.
      .filter((r): r is RepoRun => r.kind === 'repo')
      // D-5. Boot order is sweep -> `scheduler.start()` -> this, and a run the sweep just
      // enqueued has a driver parked on `acquire`. `start()` resolved its slot promise but
      // the continuation is a microtask, so the row is STILL `queued` here and reads as
      // stranded when it is not.
      .filter((r) => !driving.has(r.id));
    if (runs.length === 0) return [];

    for (const run of runs) {
      store.updateRun(run.id, {
        // Unconditionally fresh (D-6). A run requeued out of `running` by `markInFlight`
        // has SPENT its id, and `claude` answers a reused one with
        // `Session ID <uuid> is already in use` — a hard error no fake agent can see, so
        // without this the fix is green in tests and 0% correct in production. See
        // `docs/agent-invocation.md` and `agent-args.ts`. For a never-spawned run the
        // replacement costs nothing, which is why there is no "was it spent" bookkeeping.
        sessionId: randomUUID(),
        // A run carrying the shutdown note while it is running again is a lie `law status`
        // would repeat.
        failureReason: null,
        updatedAt: now(),
      });
      // `null` ack (D-7): this run was acknowledged, moved to In Progress and subscribed by
      // the process that first picked it up, and its ack entry is still in kv for
      // `refreshQueuePositions` to edit. Re-running that sequence posts a SECOND pickup
      // comment on the ticket — T72's double-post through a new door.
      track(drive(run.id, null, scheduler.acquire(run.id)));
    }

    const runIds = runs.map((r) => r.id);
    log.info({ runIds }, 'dispatched runs left queued by a previous process');
    return runIds;
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

  /**
   * The file `openRunLog` actually writes — one derivation, shared with `adapters.ts`.
   * This used to build `${LOG_DIR}/${runId}.log`, a directory nothing ever creates, so the
   * failure comment below quoted the operator a path that could not exist (T120).
   */
  function logPathFor(runId: RunId): string {
    return runLogPath(daemonDirOf(config), runId);
  }

  /**
   * The PR body both `dispatch` arms hand the deliverer, built from the run row and the
   * agent's result. One source for the ticket, so the `## Ticket` section and the title's
   * identifier prefix cannot name different tickets.
   *
   * `testCommand`, `testResult` and `didNotDo` are OMITTED, not blanked. `present()` treats
   * the two the same, but omission is the honest statement: nothing in this repository runs
   * a test command — `runPrePushGates` reads the diff and runs nothing, and `MappingToggles`
   * has no test-command field — and `AgentResult` carries no did-not-do field. Those three
   * sections keep rendering their explicit "not recorded" branches on purpose. Do not
   * fabricate a value here to make the body look fuller (T120).
   */
  function prBodyFor(
    run: RepoRun,
    summary: string,
    verdict: 'delivered' | 'partial',
  ): PrBodySource {
    return {
      ticketIdentifier: run.issueKey,
      ticketUrl: run.issueUrl,
      summary,
      runLogPath: logPathFor(run.id),
      verdict,
    };
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
    // Widened from `state === 'failed'` (M13): a `cancelled` child used to render as a bare
    // state with no explanation, and under the shared-session path that is the NORMAL
    // outcome for a repository the agent chose not to touch. `failureReason` is set on
    // every state that has one, so reading it unconditionally improves every row rather
    // than special-casing the new one.
    const detail = child.prUrl ?? child.failureReason ?? '';
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
    // The reason on the ROW, not only in `run_events`. It was already this function's
    // parameter and already went into the event log, so a cancelled run's explanation
    // existed and was simply unreadable from anywhere an operator looks: `rollupLine` and
    // `law watch` both read `failureReason`, so a cancelled child rendered as a bare state
    // (M13). Written here, at the one choke point every cancel routes through, rather than
    // at the new caller that noticed — the alternative is one caller that explains itself
    // and three that do not.
    store.updateRun(runId, { failureReason: reason, updatedAt: now() });
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

  /**
   * Every run the one `claude` session covers, the caller's own first.
   *
   * A single-repo run is one run. A child of a multi-repo ticket shares ONE session with
   * its siblings (`driveTicket` below), so the session's single result decides all of
   * them — which repositories got a pull request is then judged per repository from git,
   * inside `deliver`. Terminal siblings are excluded: a child whose worktree could not be
   * prepared already `failed` and must not be resurrected by its siblings' success.
   *
   * The caller first, and that is load-bearing: it is the session OWNER, so it is the run
   * a question is opened against and the run whose session a resume continues.
   */
  function sessionRuns(runId: RunId): RunId[] {
    const run = repoRun(runId);
    if (run.parentRunId === null) return [runId];
    const siblings = store
      .childRuns(run.parentRunId)
      .filter(
        (c): c is RepoRun =>
          c.kind === 'repo' && c.id !== runId && !RUN_STATE_TABLE[c.state].terminal,
      )
      .map((c) => c.id);
    return [runId, ...siblings];
  }

  /**
   * Deliver ONE repository, or record honestly that there was nothing to deliver.
   *
   * `deliverer.deliver` returns `null` when `git diff <base>..HEAD` is empty — the agent
   * left no commits in this repository. That judgement is made from git and never from the
   * agent's own account of what it changed: `AgentResultSchema` used to carry a
   * `changedRepos` field for exactly this and it was deleted rather than wired up, because
   * trusting the agent's claim is the one thing `verdict.ts` exists to refuse.
   *
   * `cancelled` is the least-wrong of the nine states for that outcome: it is terminal, it
   * is not a failure, and `deriveParentStatus` already maps "some shipped, some not" to
   * `partial` and "nothing shipped, all cancelled" to `cancelled`.
   */
  async function deliverOne(
    runId: RunId,
    result: Extract<AgentResult, { status: 'complete' | 'partial' }>,
  ): Promise<void> {
    await transition(runId, 'delivering', result.summary);
    const run = repoRun(runId);
    const partial = result.status === 'partial';
    const uncommitted =
      partial && result.uncommittedPaths?.length
        ? `\n\n> **Uncommitted when the turn ended:** ${result.uncommittedPaths.join(', ')}`
        : '';
    const pr = await deliverer.deliver(worktreeOf(run), repoOf(run), {
      title: result.prTitle,
      prBody: prBodyFor(
        run,
        partial
          ? `> ⚠️ **Partial run.** The agent's turn ended before it reported completion, ` +
              `but it left commits behind. Review before merging.${uncommitted}\n\n` +
              result.prBody
          : result.prBody,
        partial ? 'partial' : 'delivered',
      ),
      // Forced, never the mapping's toggle: a truncated branch is not something the
      // operator opted into shipping ready-for-review. This is the ONLY input to the
      // draft decision -- `DeliverInput.verdict` is deliberately not set.
      ...(partial ? { draft: true } : {}),
    });
    if (pr === null) {
      await finishCancel(runId, 'the agent left no commits in this repository');
      return;
    }
    store.updateRun(runId, { prUrl: pr.url, updatedAt: now() });
    await transition(runId, partial ? 'partial' : 'delivered', pr.url);
  }

  async function dispatch(runId: RunId, result: AgentResult, release: () => void): Promise<void> {
    // The daemon is shutting down and this child was reaped by `stop()`, not by the
    // operator. Writing anything here would turn a lossless stop into an abandoned run.
    if (stopping) {
      release();
      return;
    }
    // ONE session, N repositories (`driveTicket`). Resolved once, here, rather than at
    // each arm: a second resolution is a second answer to "who did this session cover".
    const runs = sessionRuns(runId);
    switch (result.status) {
      case 'needs_input': {
        // The ordering that matters. Releasing after the write leaves a window
        // in which a blocked run is still counted against the cap, and that
        // window is the bug this phase exists to prevent. Per T11 / D-04 the
        // mechanism is exit-and-resume: the child is already gone, so there is
        // nothing resident to keep alive while the human thinks.
        release();
        // The siblings park with it, BEFORE the question is opened. One session asked one
        // question; its siblings have no session of their own to answer into, and leaving
        // them at `running` would leave three rows looking live with no process behind any
        // of them — and holding slots (`HOLDS_SLOT`) that nothing will ever release.
        // `resumeAfterAnswer` brings them back together.
        for (const id of runs.slice(1)) await transition(id, 'awaiting_answer', 'shared session asked');
        await deps.questions().openQuestion(runId, result.question, result.assumption);
        return;
      }
      case 'complete': {
        // One repository per iteration, and a repository that fails to deliver does not
        // stop its siblings: repo A's pull request is already open by the time repo B's
        // push is refused, and reclassifying it would be DELV-07's defect exactly. For a
        // single-repo run this loop runs once and behaves as it always did.
        for (const id of runs) {
          try {
            await deliverOne(id, result);
          } catch (err) {
            if (runs.length === 1) throw err;
            await fail(id, classify(err), err);
          }
        }
        release();
        return;
      }
      case 'partial': {
        // TRAPS T73. The agent claimed `complete`; the worktree said otherwise -- commits
        // exist but the turn was truncated. This ships, because discarding real work is
        // the worse error, but it ships as a DRAFT and says so, so the operator is never
        // handed a truncated branch described as finished (Phase 1 D-01, Pitfall 3).
        //
        // Reaching `default` here instead would have posted a failure diagnosis over work
        // that is on disk and pushable -- which is exactly what happened for the whole of
        // this milestone, because nothing ever produced a `partial`.
        for (const id of runs) {
          try {
            await deliverOne(id, result);
          } catch (err) {
            if (runs.length === 1) throw err;
            await fail(id, classify(err), err);
          }
        }
        release();
        return;
      }
      case 'cancelled': {
        // The child honored the abort. This is a cancellation, not a failure --
        // routing it to `failed` would post a diagnosis for work the operator
        // deliberately stopped. One session, so every repository it covered stops.
        release();
        for (const id of runs) await finishCancel(id, 'agent reported cancelled');
        return;
      }
      default: {
        release();
        const reason = 'failureReason' in result ? result.failureReason : result.status;
        for (const id of runs) await fail(id, reason);
      }
    }
  }

  /**
   * The repo this run owns. Recorded on the run row at creation, so recovering
   * it never has to re-resolve config -- a mapping edited mid-run cannot move
   * a live run to a different repository.
   *
   * T125: `baseBranch` comes from `repoMappingFor` — the ONE lookup — and not from
   * `config.defaults.baseBranch`. This function and `worktreeOf` below both hardcoded the
   * default, discarding the mapped repository's own value, while `adapters.gatherEvidence`
   * read that value. So a repo whose default branch is `master` was branched from `main`
   * and had its commits counted against `master`. The fallback is for a slug the config no
   * longer names: a mapping edited mid-run must not strand a live run.
   */
  function repoOf(run: RepoRun) {
    return {
      repoDir: run.repoDir,
      repoSlug: run.repoSlug,
      baseBranch: repoMappingFor(config, run.repoSlug)?.baseBranch ?? config.defaults.baseBranch,
      enabled: true,
    };
  }

  function worktreeOf(run: RepoRun) {
    return {
      runId: run.id,
      repoDir: run.repoDir,
      path: run.worktreePath!,
      branch: run.branch,
      // T125, and this one is the live bug rather than the latent one. `baseBranch` here is
      // the LEFT SIDE OF THE DIFF RANGE `deliver.ts` computes, so it must be the ref the
      // branch was actually cut from — `run.baseRef`, written by the driver from the value
      // `prepareWorktree` returned. Re-deriving it from config gives the bare local name,
      // which T112 measured sitting 18 commits behind its own origin: the pull request's
      // diff, its file list and the secret scan's input all widen to include upstream
      // commits the run never made. The `??` arm is only for a row that predates
      // migration 003.
      baseBranch:
        run.baseRef ??
        repoMappingFor(config, run.repoSlug)?.baseBranch ??
        config.defaults.baseBranch,
    };
  }

  /**
   * The brief the agent actually receives.
   *
   * This used to be `prepared.issueTitle` — the raw ticket title and NOTHING else — under a
   * comment saying the real brief "is composed in execution/prompt.ts, Phase 4 owns it".
   * `buildAgentPrompt` was there the whole time and nothing called it. Three things were
   * missing from every run this project has ever made:
   *
   *   1. **The task.** No description, no acceptance criteria, no URL, no branch, and no
   *      instruction to run GSD. The agent was asked to implement a one-line title.
   *   2. **The delivery contract.** "Commit, do NOT push, do NOT open a PR." The worker
   *      pushes after the child exits, precisely so every push passes `gates.ts` — the
   *      secret scan, the default-branch refusal, the CI-file flag. An agent never told
   *      this can push on its own and bypass all of them.
   *   3. **The prompt-injection containment.** `sanitizeUntrustedText` + `defangDelimiter`
   *      + the DATA/instruction delimiter live in `buildAgentPrompt`. The live path passed
   *      Linear-authored text straight through. The two injection tests that "PASS" in the
   *      Phase 7 runtime evidence were exercising a function no run ever reached.
   *
   * The issue is re-fetched rather than read off the run row: the row stores the title and
   * url but not the description, and re-fetching is what the ingress does everywhere else
   * on purpose — it decides from fresh state, never from a payload.
   *
   * A failed fetch degrades to a title-only brief WITH the trusted framing and the
   * delimiter still in place, rather than to no brief. Losing the description is bad; losing
   * the delivery contract and the injection containment because Linear had a bad minute is
   * worse.
   */
  async function briefFor(
    run: RepoRun,
    branch: string,
    /** The repositories ONE shared session covers, as directory names under its cwd. */
    repoDirs?: readonly string[],
  ): Promise<string> {
    let issue: LinearIssue | undefined;
    try {
      issue = await linear.getIssue(run.issueId);
    } catch (err) {
      log.warn(
        { runId: run.id, err: String(err) },
        'could not re-fetch the issue for the brief; sending a title-only brief',
      );
    }
    // Sibling repos, when this ticket fanned out to more than one. Read off the parent's
    // children rather than off the config, so it reflects what was actually dispatched.
    const siblings = run.parentRunId
      ? store
          .childRuns(run.parentRunId)
          .filter((c): c is RepoRun => c.kind === 'repo' && c.id !== run.id)
          .map((c) => c.repoSlug)
      : [];

    return buildAgentPrompt({
      identifier: issue?.identifier ?? run.issueKey,
      title: issue?.title ?? run.issueTitle,
      description: issue?.description ?? '',
      url: issue?.url ?? run.issueUrl,
      branch,
      // `repoDirs` and `siblingRepos` are exclusive, and the choice is the shape of the
      // run: a shared session HAS the other repositories in its working directory, so
      // warning it that it cannot reach them would be false.
      ...(repoDirs && repoDirs.length > 0
        ? { repoDirs }
        : siblings.length > 0
          ? { siblingRepos: siblings }
          : {}),
    });
  }

  /**
   * The daemon-owned directory ONE ticket's worktrees live in, and the cwd its single
   * `claude` session is started in. Keyed by the parent run id, so it holds exactly that
   * ticket's repositories and nothing else — which is the literal statement of the
   * isolation property, and the reason it is not `${daemonDir}/worktrees`.
   */
  function ticketDirOf(parentRunId: RunId): string {
    return `${daemonDirOf(config)}/tickets/${parentRunId}`;
  }

  function spawnRequest(run: RepoRun, prompt: string, resume: boolean) {
    // A child of a multi-repo ticket is worked by a session whose cwd is the SHARED
    // parent, not its own worktree — including on a resume, which is why this is derived
    // here rather than passed in by each caller.
    const cwd = run.parentRunId ? ticketDirOf(run.parentRunId) : run.worktreePath!;
    // `LAW_REPO` names the repository this session is working in. For a shared session
    // there are several, so it carries all of them: a single slug would be a label that
    // is wrong for every repository but one, which is worse than a list.
    const repo = run.parentRunId
      ? store
          .childRuns(run.parentRunId)
          .filter((c): c is RepoRun => c.kind === 'repo' && c.worktreePath !== null)
          .map((c) => c.repoSlug)
          .join(',')
      : run.repoSlug;
    return {
      runId: run.id,
      sessionId: run.sessionId!,
      cwd,
      prompt,
      resume,
      env: { LAW_RUN_ID: run.id, LAW_ISSUE_KEY: run.issueKey, LAW_REPO: repo },
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
    // BEFORE `await slot`, which is the whole point (D-5). `scheduler.start()` resolves a
    // parked driver's slot promise, but the continuation is a microtask — it has not run
    // when the next SYNCHRONOUS statement executes, so a drain there reads this row still
    // at `queued` and would drive it a second time: two worktrees, two `claude` sessions
    // and two pull requests for one ticket. `acquire()` never rejects, so the only way
    // past this line without reaching the `finally` is a slot that never resolves — in
    // which case the run does still have a driver and belongs in the set.
    driving.add(runId);
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
      // T125: `baseRef` rides along with the resolved branch and path, for the same
      // reason and at the same moment. It is the ref `prepareWorktree` actually checked
      // out from, and the row is how it reaches `deliver.ts`'s diff range and
      // `gatherEvidence`'s commit count — two readers, one string, no second derivation.
      store.updateRun(runId, {
        branch: wt.branch,
        worktreePath: wt.path,
        baseRef: wt.baseBranch,
        updatedAt: now(),
      });
      checkpoint(runId);
      const prepared = await transition(runId, 'running', wt.path);
      const result = await agent.run(
        spawnRequest(prepared, await briefFor(prepared, wt.branch), false),
        ac.signal,
      );
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
      driving.delete(runId);
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
   * The work path for a multi-repo ticket: ONE slot, N worktrees under one daemon-owned
   * parent, ONE `claude` session, one pull request per repository it left commits in.
   *
   * The children survive unchanged, and that is what makes this affordable — every
   * per-repo column the product already has (repo, slug, branch, worktree path, state,
   * `prUrl`, `failureReason`, cost, tokens) keeps meaning exactly what it meant, so
   * `deriveParentStatus`, `announceTicketRollup`, `law status` and the notifier need no
   * new concept. What changed is who spawns the agent, not what a run is.
   *
   * Deliberately NOT `drive` with a flag: the two differ in their slot arity, their spawn
   * arity and their cwd, and the single-repo path is every run the live instance makes
   * (its four mappings hold one repo each, so `planSubRuns` returns no parent and this
   * function is unreachable there). One `if` in `handle` keeps that path untouched.
   */
  async function driveTicket(
    parentRunId: RunId,
    childIds: readonly RunId[],
    ackCommentId: string | null,
    slot: Promise<() => void>,
  ): Promise<void> {
    // Every CHILD, not the parent: `dispatchQueued` reads this set to answer "is anyone
    // already driving this row?", and the rows sitting at `queued` are the children. See
    // the same comment in `drive` for why it is before `await slot`.
    for (const id of childIds) driving.add(id);
    const release = await slot;
    const ac = new AbortController();
    // ONE controller, registered under EVERY child id. `cancel(childId)` reaps through
    // `aborts.get(runId)?.abort()`, so an operator who unassigns the ticket — or names any
    // one of its N rows — must reach the one session. A single registration on the lead
    // would leave `law` able to cancel a sibling into a state with a live process behind
    // it that nothing ever reaps.
    for (const id of childIds) aborts.set(id, ac);
    const parentDir = ticketDirOf(parentRunId);
    const prepared: RunId[] = [];
    try {
      for (const id of childIds) {
        try {
          checkpoint(id);
          await transition(id, 'preparing', ackCommentId ?? 'slot acquired');
          const queued = repoRun(id);
          const wt = await worktrees.create(id, repoOf(queued), queued.branch, parentDir);
          // The RESOLVED branch, path and base ref — same three, same reason as `drive`.
          store.updateRun(id, {
            branch: wt.branch,
            worktreePath: wt.path,
            baseRef: wt.baseBranch,
            updatedAt: now(),
          });
          prepared.push(id);
        } catch (err) {
          if (err instanceof CancelledSignal) throw err;
          // One repository failing to prepare does not stop the others (D-10). It fails
          // with its own diagnosis and the ticket settles `partial` through
          // `deriveParentStatus`, which is the property `fanout.ts` was written for.
          if (!stopping) await fail(id, classify(err), err);
        }
      }
      if (prepared.length === 0) {
        throw new Error('no repository of this ticket could be prepared');
      }
      // M10: `preparing -> delivering` is not in the transition table, and `running` is
      // the only route to it. That is honest rather than a workaround — a live `claude`
      // process really is working in every one of these worktrees.
      for (const id of prepared) await transition(id, 'running', repoRun(id).worktreePath!);
      // The session OWNER: the one child `planSubRuns` gave a `sessionId` to. A MARK and
      // not a position, because `childRuns` has no ORDER BY (M5) — "the first child" is
      // not a stable notion.
      const owner = prepared.find((id) => repoRun(id).sessionId !== null) ?? prepared[0]!;
      const lead = repoRun(owner);
      const repoDirs = prepared.map((id) => basename(repoRun(id).worktreePath!));
      const result = await agent.run(
        spawnRequest(lead, await briefFor(lead, lead.branch, repoDirs), false),
        ac.signal,
      );
      checkpoint(owner);
      // Fans out over every non-terminal child (`sessionRuns`), judging each repository
      // from git inside `deliver`.
      await dispatch(owner, result, release);
    } catch (err) {
      if (stopping) return;
      for (const id of childIds) {
        if (err instanceof CancelledSignal) await finishCancel(id, 'cancel requested');
        else await fail(id, classify(err), err);
      }
    } finally {
      for (const id of childIds) {
        driving.delete(id);
        aborts.delete(id);
      }
      release();
      if (!stopping) {
        // One rollup for the ticket, posted by `announceTerminal` on whichever child
        // settles last and kv-guarded, so N children do not post N comments (M14).
        for (const id of childIds) await announceTerminal(id);
        await refreshQueuePositions();
        // NON-recursive, and failure swallowed. A directory still holding a retained
        // worktree from a failed run MUST survive — `finishWorktree`'s retention policy is
        // what decides that, and it keeps the only artefact the operator can take over in.
        await rmdir(parentDir).catch(() => undefined);
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
      // The siblings parked with this run when the shared session asked (`dispatch`'s
      // `needs_input` arm) and come back with it. `questions.ts` moved THIS run back to
      // `running`; nothing else knows the other rows exist.
      if (run.parentRunId !== null) {
        const parked = store
          .childRuns(run.parentRunId)
          .filter((c): c is RepoRun => c.kind === 'repo' && c.state === 'awaiting_answer');
        for (const sibling of parked) {
          aborts.set(sibling.id, ac);
          await transition(sibling.id, 'running', `answer to ${questionId ?? 'resume'}`);
        }
      }
      // Framed, never raw. The answer is a Linear comment — see `buildAnswerPrompt`. This
      // was `answer` verbatim, which put the most likely injection vector in the product
      // through the only path with no delimiter around it.
      const result = await agent.run(
        spawnRequest(run, buildAnswerPrompt(answer), true),
        ac.signal,
      );
      checkpoint(runId);
      await dispatch(runId, result, release);
    } catch (err) {
      if (stopping) return;
      if (err instanceof CancelledSignal) await finishCancel(runId, 'cancel requested');
      else await fail(runId, classify(err), err);
    } finally {
      // Every id this resume registered, not just the one it was named with.
      for (const [id, controller] of [...aborts]) if (controller === ac) aborts.delete(id);
      release();
      if (!stopping) {
        for (const id of sessionRunsSettled(runId)) await announceTerminal(id);
        await refreshQueuePositions();
      }
    }
  }

  /**
   * Every run of the resumed session, terminal ones included — `sessionRuns` excludes
   * terminal rows because a dispatch must not resurrect a failed sibling, and an announce
   * has to reach precisely the rows that just became terminal.
   */
  function sessionRunsSettled(runId: RunId): RunId[] {
    const run = store.getRun(runId);
    if (!run || run.kind !== 'repo' || run.parentRunId === null) return [runId];
    return store
      .childRuns(run.parentRunId)
      .filter((c): c is RepoRun => c.kind === 'repo')
      .map((c) => c.id);
  }

  return {
    transition,
    refreshQueuePositions,
    dispatchQueued,
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
      // Resolves when the aborted drivers have finished unwinding, which is when the
      // supervisor's escalation has finished — a driver removes itself from `aborts` in
      // its `finally`, and it only gets there after `agent.run` returns, which only
      // happens once the process group has actually been reaped.
      //
      // `aborts` and NOT `settle()`, and the difference is the whole fix. `settle()` waits
      // for every driver, including one parked on `scheduler.acquire` for a slot the
      // shutdown just stopped admitting — that driver holds no child, can never proceed,
      // and its run is already sitting at `queued`, which is exactly the state the next
      // boot wants. Waiting for it made Ctrl-C on an idle daemon burn the full child-reap
      // budget. A driver appears in `aborts` only AFTER it has its slot, so this waits for
      // precisely the runs that can have a process behind them.
      //
      // The caller still bounds it: the full SIGINT+SIGTERM ladder is 25 seconds, and an
      // operator pressing Ctrl-C twice must not be made to wait it out.
      while (aborts.size > 0) await new Promise((r) => setTimeout(r, 25));
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
          // This is the ONLY site that decides whether a `run.requested` is honoured.
          // `reconcile()` used to carry a private copy of this check as an early-out; it
          // was deleted rather than extended, because two implementations of one rule is
          // this repo's most repeated defect and the copy saved nothing (this guard
          // already runs before the `getIssue` below).
          if (store.findActiveRunByIssue(event.issueId).length > 0) {
            log.info({ issueId: event.issueId }, 'a run is already live for this issue; ignoring');
            return;
          }
          // T107, and the reason `trigger` exists. The poll observes a STATE, not an act:
          // "still assigned, still open" stays true forever, and the bot's own In Progress
          // transition and Done comment bump `issue.updatedAt`, so the watermark cannot
          // bound it either. A `delivered` run is terminal, so the liveness check above
          // does not stop it — the poll re-requested a delivered ticket once a minute,
          // opening a pull request and burning a paid session each time (observed on
          // COD-2). For the poll, therefore, ANY prior run is disqualifying.
          //
          // OPS-04: one attempt per assignment. The operator's retry gesture is unassign
          // then re-assign, which arrives on a webhook as `trigger: 'assignment'` — an ACT,
          // with an actor, deduped by `Linear-Delivery` — and is deliberately still
          // honoured against a terminal run.
          //
          // ponytail: if the daemon is DOWN across the whole unassign→reassign, both
          // webhooks are lost and the next poll sees the prior run and skips. Recovery is
          // to re-assign once with the daemon up. Losing one re-request while down is a
          // missed action; the alternative opens a PR and spends money every minute.
          if (event.trigger === 'reconcile' && store.findRunsByIssue(event.issueId).length > 0) {
            log.info(
              { issueId: event.issueId },
              'poll observed an issue that has already been attempted; ignoring',
            );
            return;
          }
          // Invariant 2: decide from the canonical issue, never from webhook body.
          const issue = await linear.getIssue(event.issueId);
          const mapping = resolveMapping(issue);
          if (!mapping) {
            log.warn({ issueId: issue.id }, 'no repo mapping for issue; ignoring');
            return;
          }
          // The pickup filter, and it sits HERE because here is where the two producers
          // meet — the same reason the two guards above do. The webhook path arrives via
          // `daemon.ts`'s router `onEvent` -> `createIngressMapper`; the poll arrives via
          // `recovery.ts:275`. One check covers both doors; a second copy at the poll is
          // this repo's most repeated defect.
          //
          // Absent list means NO filter, which is every config written before today.
          // Matched by state TYPE or by state ID, never by name (`ProjectMapping`).
          const pickupStates = mapping.pickupStates;
          if (
            pickupStates &&
            !pickupStates.includes(issue.stateType) &&
            !pickupStates.includes(issue.stateId)
          ) {
            // Logged, with both state fields AND the configured list: a filter that drops
            // silently is the same defect as a filter that never matches — from the
            // operator's chair both look like a bot that is ignoring them.
            log.info(
              {
                issueId: issue.id,
                stateType: issue.stateType,
                stateId: issue.stateId,
                pickupStates,
              },
              'issue is not in a pickup state for its mapping; ignoring',
            );
            return;
          }
          // Phase one of a multi-repo ticket: a cheap read-only session reads the ticket
          // and names which of the mapped repositories it needs. HERE, after the pickup
          // filter and before any worktree exists, and only for a mapping that has
          // something to narrow.
          const narrowed = await narrowRepos(issue, mapping.repos);

          // D-12 / DELV-06. Fan-out happens HERE, at the engine, and never
          // inside an agent session: one child run per mapped repo, each with
          // its own worktree, branch, session and state. One repo stays one run
          // with no parent, exactly as before.
          const plan = planSubRuns(issue, { repos: narrowed }, { now });
          if (plan.children.length === 0) {
            log.warn({ issueId: issue.id }, 'mapping has no repos; ignoring');
            return;
          }
          insertPlan(plan);
          // D-09, in order and before the worktree port is reachable at all:
          // insert at `queued` (above), acknowledge, In Progress, subscribe.
          //
          // Once per TICKET, not once per child. Three children must not
          // produce three ack comments, three In Progress transitions and three
          // subscriptions. The lead child owns the single ack comment, so it is
          // also the only one whose queue position edits it -- the others have
          // no ack entry and `refreshQueuePositions` already no-ops on that.
          const repos = plan.children.map((c) => c.repoSlug);

          // THE branch, and this is the one site both producers reach: ingress requests a
          // run on an assignment webhook, the boot sweep requests one for every
          // bot-assigned open issue. Both arrive here, so the decision "one session or N"
          // is made once. A plan with a parent has two or more mapped repositories
          // (`planSubRuns` returns `parent: null` for one), and the live instance's four
          // mappings hold one repo each — so the single-repo path below is what it runs,
          // unchanged, and this branch is unreachable there. That is also why there is no
          // toggle: a switch that protects an instance which structurally cannot reach the
          // thing it switches off would exist only to be set to one value.
          if (plan.parent) {
            // ONE slot for the whole ticket, on the PARENT's id. N children, one `claude`
            // process, one slot — the cap bounds local RAM and there is one process to
            // bound. Parking holds nothing and returns immediately; it exists only so the
            // acknowledgement below can carry a real `positionOf()`.
            const slot = scheduler.acquire(plan.parent.id);
            const ackCommentId = await acknowledge(plan.children[0], repos);
            track(
              driveTicket(
                plan.parent.id,
                plan.children.map((c) => c.id),
                ackCommentId,
                slot,
              ),
            );
            return;
          }

          // Single repo: one run, its own slot, its own worktree, its own session.
          const slots = plan.children.map((child) => scheduler.acquire(child.id));
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
