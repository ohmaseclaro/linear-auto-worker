/**
 * Restart recovery: the boot sweep (OPS-01, D-07/D-08) and the reconciliation
 * poll (INTK-07, 03-CONTEXT D-04/D-05).
 *
 * Two rules carry this module.
 *
 * 1. **Recovery is per-state, not uniform** (06-CONTEXT D-07). `queued` and
 *    `preparing` requeue -- nothing was spent. `running` and `delivering`
 *    **fail with a diagnosis**: an agent session and a partial push cannot be
 *    resumed blind, and replaying one produces a second pull request for work
 *    that was already pushed. `awaiting_answer` persists untouched, because its
 *    deadline is a column rather than a timer and there is nothing to re-arm.
 *
 *    `research/SUMMARY.md` invariant 7 says the opposite ("requeue every
 *    `running` row"), and D-07 supersedes it for the boot path. The two
 *    reconcile: Phase 7's *clean* shutdown transitions in-flight runs to
 *    `queued` **before** exiting, so that path stays lossless. A `running` row
 *    that survives to boot therefore means an **unclean** exit -- crash, kill,
 *    power loss -- and in exactly that case the worktree contents and the push
 *    status are both unknowable. See TRAPS T18 and T26.
 *
 * 2. **The comment half of the poll is the one people leave out**
 *    (03-CONTEXT D-05). An issue-level `updatedAt` diff tells you an issue
 *    changed; it does not tell you a threaded reply landed on a comment, and a
 *    reply is not an issue field. Without listing comments on issues holding an
 *    open question, a run answered thirty seconds after the daemon died still
 *    burns its full four-hour deadline and then proceeds on an assumption the
 *    operator had already overruled in writing.
 *
 * Boundary: this module never writes `runs.state`. Every transition goes
 * through `engine.transition()` (06-CONTEXT D-01, research invariant 6), which
 * is also what gets the `run_events` audit row for free (T-06-20). It contains
 * no SQL and no correlation logic of its own.
 *
 * Ordering, which is Phase 7's to wire but this module's to state: the boot
 * sweep must complete **before the HTTP server binds**. A delivery landing
 * while the database still shows a phantom `running` row makes the router treat
 * the ticket as already in flight and drop the event.
 */
import { RUN_STATE_TABLE } from '../domain/state-machine.js';
import type { IssueId, Run, RunId, RunState } from '../domain/types.js';
import type { Config, LinearClient, Logger, Store } from '../domain/ports.js';
import type { RunEngine } from './run-engine.js';
import type { Scheduler } from './scheduler.js';
import type { AnswerComment, Questions } from './questions.js';

/**
 * The `kv` key holding the last-seen poll watermark. **Shared with Phase 3's
 * `pollForMissedWork()`** (03-CONTEXT D-04, plan 03-04) -- the two halves of
 * this obligation must read and write the same key or each will re-cover the
 * other's window forever. Exported so the integration gate can assert one
 * string, not two spellings.
 */
export const POLL_WATERMARK_KEY = 'poll_watermark';

/** No watermark yet: query from the beginning of time and take everything. */
const EPOCH = new Date(0).toISOString();

/** What the boot sweep does with a run found in a given state. */
export type BootAction = 'leave' | 'requeue' | 'fail';

/**
 * D-07, as data. Typed `Record<RunState, ...>` on purpose: a tenth state added
 * to the contract makes this object fail to typecheck, so it cannot slip
 * through unhandled. The runtime backstop below covers the rush-mode window in
 * which nothing typechecks.
 *
 * Terminal states are listed for exhaustiveness only -- they are never loaded.
 */
export const BOOT_ACTION: Readonly<Record<RunState, BootAction>> = {
  // Already correct. It will be picked up by the normal queue drain.
  queued: 'leave',
  // Nothing was spent -- no agent had been spawned. A partial worktree is
  // Phase 4's boot GC to prune; the worktree port is deliberately not a
  // dependency of this module, so it structurally cannot be called from here.
  preparing: 'requeue',
  // D-07. Unclean exit, unknowable push status. Requeueing is what produces the
  // second PR (T-06-18).
  running: 'fail',
  delivering: 'fail',
  // Its deadline is a column and its question row is intact; plan 03's sweep
  // picks it up on the first tick. Re-arming something that was never disarmed
  // is the mistake here.
  awaiting_answer: 'leave',
  delivered: 'leave',
  partial: 'leave',
  failed: 'leave',
  cancelled: 'leave',
};

export interface RecoveryDeps {
  store: Store;
  engine: RunEngine;
  scheduler: Scheduler;
  questions: Questions;
  linear: LinearClient;
  config: Config;
  log: Logger;
  now?: () => number;
}

export interface BootReport {
  requeued: RunId[];
  failed: RunId[];
  left: RunId[];
}

export interface ReconcileReport {
  enqueued: IssueId[];
  /** Comments that correlated to an open question and resumed a run. */
  resumed: number;
  /** The watermark now in `kv`. Unchanged from the previous pass on failure. */
  watermark: string;
  advanced: boolean;
}

/**
 * Non-terminal states, asked of the domain state table rather than written out
 * here. Plan 01 established this for the scheduler and the same reasoning
 * applies: a second list is a second thing to keep in sync, and the sync
 * failure is silent -- a state nobody swept looks exactly like a state nobody
 * created.
 */
export function nonTerminalStates(): RunState[] {
  return (Object.keys(RUN_STATE_TABLE) as RunState[]).filter((s) => !RUN_STATE_TABLE[s].terminal);
}

/**
 * The boot sweep. Every mid-flight run is explicitly requeued or failed; none
 * is left as a zombie holding a slot and a stuck In Progress ticket (D-08,
 * OPS-01).
 *
 * Idempotent: after one pass every non-terminal run is `queued` or
 * `awaiting_answer`, both of which are `leave`, so a second pass writes nothing.
 */
export async function recoverAtBoot(deps: RecoveryDeps): Promise<BootReport> {
  const { store, engine, scheduler, log } = deps;
  const now = deps.now ?? Date.now;

  const nonTerminal = nonTerminalStates();
  const report: BootReport = { requeued: [], failed: [], left: [] };

  for (const run of store.listByState(...nonTerminal)) {
    // The runtime backstop for a state the contract grew and this file did not.
    // Defaulting to `fail` rather than `requeue` is the safe direction: the
    // worst a wrong `fail` costs is a re-assignment, whereas a wrong `requeue`
    // can ship a second pull request for work already pushed.
    const action = BOOT_ACTION[run.state] ?? 'fail';
    if (BOOT_ACTION[run.state] === undefined) {
      log.error({ runId: run.id, state: run.state }, 'no boot action for state; failing it');
    }

    try {
      if (action === 'requeue') {
        await engine.transition(run.id, 'queued', `recovered from ${run.state}`);
        // The ticket is left In Progress on purpose: the run is going to run,
        // so In Progress is still the truth.
        report.requeued.push(run.id);
      } else if (action === 'fail') {
        await failRecovered(deps, run, now());
        report.failed.push(run.id);
      } else {
        report.left.push(run.id);
      }
    } catch (err) {
      // One unrecoverable row must not abandon the rest of the sweep -- D-08 is
      // about *every* run, and aborting here strands the ones behind it.
      log.error({ runId: run.id, state: run.state, err: String(err) }, 'boot recovery failed for run');
    }
  }

  // The semaphore starts the process agreeing with the database instead of at
  // zero. A run left in `awaiting_answer` contributes nothing, because the state
  // table says it holds no slot (01-CONTEXT D-02).
  scheduler.syncFromStore(store.listByState(...nonTerminal));

  log.info(
    { requeued: report.requeued.length, failed: report.failed.length, left: report.left.length },
    'boot recovery complete',
  );
  return report;
}

/**
 * The failure half of D-07. Sets `failureReason` and transitions; the operator-
 * facing wording is composed by `run-engine.ts`'s `diagnosis()` from exactly
 * this reason, so there is one diagnosis format in the daemon rather than two
 * (T-06-21 -- a classified reason and a log path, never a serialized error).
 *
 * ponytail: the terminal Linear comment is NOT posted from here. `run-engine`
 * emits it from its driver's `finally`, and a recovered run has no driver. The
 * upgrade is one line once the engine exposes the kv-guarded announcement --
 * `RunEngine.fail(runId, reason)` / `announceTerminal(runId)`, both requested in
 * 06-04-SUMMARY.md. Until then the run is correctly `failed` in the database and
 * in `run_events`; only the ticket comment is missing.
 */
async function failRecovered(deps: RecoveryDeps, run: Run, at: number): Promise<void> {
  const reason = `daemon restarted while the run was ${run.state}; branch and worktree left in place`;
  deps.store.updateRun(run.id, { failureReason: reason, updatedAt: at });
  // Exactly one diagnosis per run: one `updateRun`, one `transition`, and the
  // worktree cleanup port is not reachable from this module at all.
  await deps.engine.transition(run.id, 'failed', `recovered from ${run.state}`);
}

/**
 * The reconciliation poll (INTK-07 + 03-CONTEXT D-05). Phase 7 drives it at
 * boot and on a five-minute interval; this module only exposes it.
 *
 * It is what makes an ephemeral tunnel URL safe. Between the daemon dying and
 * the webhook being re-registered on the next boot, Linear delivers to a URL
 * that never comes back and those deliveries are lost. Polling for ground truth
 * is the only correct recovery -- which is why every decision below is made from
 * a freshly fetched issue and never from a cached payload (invariant 2).
 *
 * `now` bounds the watermark: a Linear clock running ahead of ours must not
 * advance the watermark past our own present, because that skips a window.
 * Re-processing is cheap here (the no-active-run check below absorbs it) and a
 * skipped window is silently lost work.
 */
export async function reconcile(deps: RecoveryDeps, now: number): Promise<ReconcileReport> {
  const { store, engine, questions, linear, config, log } = deps;

  const watermark = store.kvGet(POLL_WATERMARK_KEY) ?? EPOCH;
  const ceiling = new Date(now).toISOString();
  let newest = watermark;
  const seen = (stamp: string): void => {
    if (stamp > newest && stamp <= ceiling) newest = stamp;
  };

  const report: ReconcileReport = { enqueued: [], resumed: 0, watermark, advanced: false };

  try {
    // --- half one: assignments whose webhook never arrived (INTK-07) --------
    //
    // ponytail: filtered client-side rather than with a server-side
    // `updatedAt >` predicate. The bot's open assigned issues are a handful for
    // a single-operator tool, and one filter is one place to be wrong. Push the
    // predicate into the query if that set ever grows past a page or two.
    const issues = await linear.listAssignedOpenIssues(config.botUserId);
    for (const issue of issues) {
      seen(issue.updatedAt);
      if (issue.updatedAt <= watermark) continue;
      // Idempotence: three passes over one issue produce one run. This is also
      // what makes re-covering a window on failure free.
      if (store.findActiveRunByIssue(issue.id).length > 0) continue;
      await engine.handle({ kind: 'run.requested', issueId: issue.id });
      report.enqueued.push(issue.id);
    }

    // --- half two: answers whose webhook never arrived (03-CONTEXT D-05) ----
    //
    // Runs parked in `awaiting_answer` ARE the issues holding an open question,
    // by construction: `openQuestion` transitions the run into that state and
    // `applyAnswer` is the only way out. No second query and no new port method.
    const parked = new Set(store.listByState('awaiting_answer').map((r) => r.issueId));
    for (const issueId of parked) {
      // T-06-22 (accepted): the listing is unbounded in principle. The watermark
      // bounds it in practice -- only comments created since the last clean pass
      // come back. Add a page cap only if a very busy issue ever proves it.
      for (const c of await linear.listComments(issueId, watermark)) {
        seen(c.createdAt);
        const comment: AnswerComment = {
          id: c.id,
          issueId,
          parentId: c.parentId,
          body: c.body,
          authorId: c.authorId,
          authorName: c.authorName,
        };
        // The one correlator (T-06-17). `ingestComment` runs the same pure
        // `correlate()` the webhook path runs -- including the bot-author drop
        // that 06-03 deliberately put *inside* `correlate` rather than at the
        // ingress boundary, precisely so this second entry point gets it for
        // free. These comments came straight off the API and passed none of
        // Phase 3's four ingress guards; a guard that only exists in ingress is
        // a guard boot recovery skips.
        const correlated = await questions.ingestComment(comment);
        if (correlated.outcome === 'matched') report.resumed += 1;
      }
    }
  } catch (err) {
    // Never fragile. A slow or unavailable Linear degrades the daemon to
    // "missing backlog until the next pass", it does not stop it -- and the
    // watermark stays where it was, so that next pass re-covers this window
    // rather than skipping it.
    log.error({ err: String(err), watermark }, 'reconciliation poll failed; watermark not advanced');
    return report;
  }

  // Advanced only after a clean pass, and only ever forward.
  if (newest > watermark) {
    store.kvPut(POLL_WATERMARK_KEY, newest);
    report.watermark = newest;
    report.advanced = true;
  }
  log.info(
    { enqueued: report.enqueued.length, resumed: report.resumed, watermark: report.watermark },
    'reconciliation poll complete',
  );
  return report;
}
