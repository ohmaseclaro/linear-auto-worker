/**
 * Gap D4 — the periodic tick.
 *
 * Both sweeps this exercises existed from Phase 6 and were called exactly once, at boot.
 * `questions.ts`'s own header said `sweep(now)` is "driven by the tick"; no tick was ever
 * built, because no plan owned a timer. The operator-visible consequence was that a
 * four-hour question deadline did nothing on a daemon that stays up — the assumption was
 * posted at the next *restart*, which for a daemon meant possibly never.
 *
 * These cases fail against a daemon with no ticker: the first two time out waiting for a
 * sweep that never runs, and the third leaves a live interval that keeps the Node event
 * loop alive after shutdown.
 */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { bootDaemon, TICK_INTERVAL_MS } from '../../src/cli/daemon.js';
import {
  BOT_USER_ID,
  ISSUE_ID,
  makeScratchRepo,
  makeWorkspace,
  okTools,
  probingTunnel,
  RecordingLinear,
  smokeIssue,
  until,
} from '../../src/cli/daemon-fixture.js';
import type { DaemonHandle } from '../../src/cli/daemon.js';
import type { QuestionRow, RunRow } from '../../src/infra/store/sqlite-store.js';

const SECRET = 'tick-webhook-secret-0123456789abcdef0';

/** A tick every 25ms. The production value is a minute; a test cannot wait one. */
const FAST_TICK = 25;

const open: DaemonHandle[] = [];
after(async () => {
  for (const d of open) await d.shutdown('test cleanup').catch(() => undefined);
});

async function boot(tickMs = FAST_TICK): Promise<DaemonHandle> {
  const workspace = await makeWorkspace(SECRET);
  await makeScratchRepo(workspace.dir);
  // No assignee: the boot sweep must find nothing to dispatch, so the only thing moving
  // in these tests is the tick itself.
  const linear = new RecordingLinear({ issues: [smokeIssue({ assigneeId: 'someone-else' })] });
  const daemon = await bootDaemon({
    configDir: workspace.dir,
    linear,
    tunnel: probingTunnel(),
    runCommand: okTools,
    tickMs,
  });
  open.push(daemon);
  return daemon;
}

/** A parked run with one question already past its deadline — what a restart used to be
 *  required to notice. */
function parkedRunWithOverdueQuestion(daemon: DaemonHandle, at: number): { runId: string; questionId: string } {
  const runId = 'run-parked';
  const questionId = 'q-overdue';
  const run: RunRow = {
    id: runId,
    parentRunId: null,
    kind: 'repo',
    issueId: ISSUE_ID,
    issueKey: 'SMK-1',
    issueTitle: 'a parked ticket',
    issueUrl: 'https://linear.app/smoke/issue/SMK-1',
    repoDir: '/tmp/repo',
    repoSlug: 'smoke/repo',
    branch: 'smk-1',
    worktreePath: null,
    sessionId: null,
    pid: null,
    state: 'awaiting_answer',
    attempt: 0,
    questionRound: 1,
    prUrl: null,
    failureReason: null,
    createdAt: at - 10_000,
    updatedAt: at - 10_000,
  };
  const question: QuestionRow = {
    id: questionId,
    runId,
    text: 'Which timeout?',
    assumption: 'thirty seconds',
    linearCommentId: null,
    askedAt: at - 10_000,
    // Already past. On a daemon with no tick this row stays `open` forever.
    deadlineAt: at - 1,
    status: 'open',
    answer: null,
    answeredBy: null,
  };
  const store = daemon.store as unknown as {
    insertRun(r: RunRow): void;
    insertQuestion(q: QuestionRow): void;
  };
  store.insertRun(run);
  store.insertQuestion(question);
  return { runId, questionId };
}

test('D4: an overdue question expires WITHOUT a restart', async () => {
  const daemon = await boot();
  const { questionId } = parkedRunWithOverdueQuestion(daemon, Date.now());

  const store = daemon.store as unknown as { getQuestion(id: string): QuestionRow | undefined };
  const settled = await until(
    () => {
      const q = store.getQuestion(questionId);
      return q && q.status !== 'open' ? q : undefined;
    },
    { label: 'the tick to expire an overdue question', timeoutMs: 5_000 },
  );

  assert.equal(settled.status, 'timed_out', 'expiry must be recorded as a timeout, not an answer');
  assert.equal(settled.answeredBy, null, 'a deadline has no author');
});

test('D4: the tick keeps running — a question that comes due LATER is also swept', async () => {
  const daemon = await boot();
  const at = Date.now();
  const { questionId } = parkedRunWithOverdueQuestion(daemon, at);
  const store = daemon.store as unknown as {
    getQuestion(id: string): QuestionRow | undefined;
    updateQuestion(id: string, patch: Partial<QuestionRow>): void;
  };

  // Push it into the future first, so the first few ticks must decline to expire it. A
  // one-shot sweep dressed up as a tick would pass the previous case and fail this one.
  store.updateQuestion(questionId, { deadlineAt: at + 400 });
  await until(
    () => (Date.now() > at + 100 ? true : undefined),
    { label: 'several ticks to pass while the question is not yet due', timeoutMs: 5_000 },
  );
  assert.equal(store.getQuestion(questionId)?.status, 'open', 'expired before its deadline');

  const settled = await until(
    () => {
      const q = store.getQuestion(questionId);
      return q && q.status !== 'open' ? q : undefined;
    },
    { label: 'the later deadline to be swept by a subsequent tick', timeoutMs: 5_000 },
  );
  assert.equal(settled.status, 'timed_out');
});

test('D4: a slow tick does not overlap itself', async () => {
  // The property the `ticking` guard exists for. `reconcile` talks to Linear, so a slow or
  // rate-limited call can outlast the interval; two passes running against the same
  // watermark re-dispatch the same backlog, which is duplicate worktrees and duplicate
  // pull requests. A skipped tick costs a minute — a doubled one costs a second PR.
  //
  // This case replaced one asserting "no sweep runs after shutdown", which was VACUOUS:
  // it still passed with both `clearInterval` and the `shuttingDown` guard deleted,
  // because the store is closed by then and the sweep throws before reaching Linear.
  // A check that cannot go red is not a check (TRAPS T71/T76).
  const workspace = await makeWorkspace(`${SECRET}4`);
  await makeScratchRepo(workspace.dir);
  let entered = 0;
  let peak = 0;
  let inside = 0;
  // Armed only AFTER boot. `bootDaemon` step 7 runs the same sweep once, synchronously
  // with boot — blocking from the constructor deadlocks `await bootDaemon(...)` itself,
  // and `release()` below is then never reached.
  let blocking = false;
  let release = (): void => undefined;
  const held = new Promise<void>((r) => {
    release = r;
  });
  class SlowLinear extends RecordingLinear {
    override async listAssignedOpenIssues(userId: string) {
      if (!blocking) return super.listAssignedOpenIssues(userId);
      entered += 1;
      inside += 1;
      peak = Math.max(peak, inside);
      await held;
      inside -= 1;
      return super.listAssignedOpenIssues(userId);
    }
  }
  const daemon = await bootDaemon({
    configDir: workspace.dir,
    linear: new SlowLinear({ issues: [smokeIssue({ assigneeId: 'someone-else' })] }),
    tunnel: probingTunnel(),
    runCommand: okTools,
    tickMs: FAST_TICK,
  });
  open.push(daemon);
  blocking = true;

  // Long enough for roughly a dozen intervals to fire while the first pass is still stuck.
  await new Promise((r) => setTimeout(r, FAST_TICK * 12));
  const enteredWhileHeld = entered;
  release();

  assert.equal(
    peak,
    1,
    `${peak} sweeps ran concurrently — a second pass reads the same watermark as the first ` +
      'and re-dispatches the whole backlog',
  );
  assert.equal(
    enteredWhileHeld,
    1,
    `${enteredWhileHeld} sweeps started while one was still awaiting Linear; the guard did not hold`,
  );
});

test('D4: shutdown clears the interval HANDLE, so the process can exit', async () => {
  // Distinct from the case above, which the `shuttingDown` guard satisfies on its own. A
  // leaked interval keeps the Node event loop alive forever: `law start` would never exit
  // after Ctrl-C, and this suite would hang instead of failing.
  //
  // A slow tick on purpose — no tick fires during this test and no `until` poll is running
  // at the assert, so the count is exact rather than approximate. Measured both ways:
  // 1 -> 0 with `clearInterval`, 1 -> 1 without.
  const workspace = await makeWorkspace(`${SECRET}3`);
  await makeScratchRepo(workspace.dir);
  const daemon = await bootDaemon({
    configDir: workspace.dir,
    linear: new RecordingLinear({ issues: [smokeIssue({ assigneeId: 'someone-else' })] }),
    tunnel: probingTunnel(),
    runCommand: okTools,
    tickMs: 5 * 60_000,
  });
  open.push(daemon);

  // A DELTA, not an absolute: the cases above leave their own daemons open until `after()`,
  // so several intervals are armed by the time this runs. Only this daemon's own handle is
  // being asked about.
  const timers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
  const before = timers();
  await daemon.shutdown('test');
  assert.equal(
    timers(),
    before - 1,
    'shutdown left the tick interval armed; the process cannot exit',
  );
});

test('D4: the production interval is a minute, not the test value', () => {
  // Cheap, but it is the one thing the fast-tick cases above structurally cannot see:
  // every case runs at 25ms, so a typo turning the default into 25ms ships silently.
  assert.equal(TICK_INTERVAL_MS, 60_000);
});
