/**
 * The pickup, cancellation and terminal-failure surface of the run engine.
 *
 * Three of the claims here are ordering or arity claims rather than value
 * claims, and a final-state assertion cannot make any of them:
 *
 *  - the worktree port is a spy that FAILS THE TEST if it is reached before the
 *    acknowledgement sequence has finished (D-09, INTK-02, invariant 12);
 *  - a queue that moves three times leaves exactly one comment on the ticket,
 *    proven by counting creates against updates, not by reading the last body
 *    (D-10, INTK-06);
 *  - a run that reaches `failed` stays there across every subsequent tick,
 *    poll and scheduler pass (D-13, OPS-04).
 *
 * The Linear client is a local recorder rather than `FakeLinearClient` because
 * these tests assert on the call SEQUENCE, and the sequence is the deliverable.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeAgentRunner, FakeDeliverer, InMemoryStore } from '../domain/fakes.js';
import { RUN_STATE_TABLE } from '../domain/state-machine.js';
import type { AgentResult, Config, LinearClient, Logger, WorktreeManager } from '../domain/ports.js';
import type { Run, RunState } from '../domain/types.js';
import { createScheduler } from './scheduler.js';
import { createRunEngine } from './run-engine.js';
import { createQuestions } from './questions.js';

const silent: Logger = {
  child: () => silent,
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

function issue(n: number) {
  return {
    id: `issue-${n}`,
    identifier: `ENG-${n}`,
    title: `Ticket ${n}`,
    description: null,
    url: `https://linear.app/x/issue/ENG-${n}`,
    branchName: `eng-${n}-ticket`,
    assigneeId: 'bot',
    projectId: 'proj-1',
    teamId: 'team-1',
    stateId: 'state-todo',
    stateType: 'unstarted',
  };
}

// Shaped against the ADDENDUM; cast because the exact field set lands with
// Phase 1 and these tests must not pin it.
function configWith(concurrency: number): Config {
  return {
    operatorUserId: 'operator-1',
    logDir: '/home/op/.linear-auto-worker/logs',
    // TOP LEVEL, not under `defaults`. The cap bounds local RAM across every run on this
    // machine, so types.ts rules out a per-mapping override; nested here it was never read
    // and `concurrency: 1` silently ran as the default 3, which is why the queue-position
    // and cancellation cases saw runs that should have been parked.
    concurrency,
    defaults: {
      questionTimeoutMs: 4 * 60 * 60 * 1000,
      baseBranch: 'main',
      postLinearComments: true,
      draftPr: true,
      questionsEnabled: true,
      maxRunMs: 60 * 60 * 1000,
    },
    mappings: {
      'proj-1': {
        repos: [{ repoDir: '/repo/api', repoSlug: 'org/api', baseBranch: 'main', enabled: true }],
      },
    },
  } as unknown as Config;
}

const COMPLETE: AgentResult = {
  status: 'complete',
  summary: 'Shipped it.',
  prTitle: 'ENG: do the thing',
  prBody: 'Does the thing.',
};

const NEEDS_INPUT: AgentResult = {
  status: 'needs_input',
  summary: 'Blocked on a product judgement.',
  question: 'Which timezone?',
  assumption: 'UTC.',
};

interface Created {
  id: string;
  issueId: string;
  body: string;
}

/** Records the call sequence. `failCreate` exercises the swallowed-ack path. */
function recordingLinear(issues: Array<ReturnType<typeof issue>>, opts: { failCreate?: boolean } = {}) {
  const order: string[] = [];
  const created: Created[] = [];
  const updated: Array<{ commentId: string; body: string }> = [];
  const subscribed: Array<{ issueId: string; userId: string }> = [];
  const states: Array<{ issueId: string; stateType: string }> = [];
  let n = 0;

  const client = {
    async getIssue(id: string) {
      const found = issues.find((i) => i.id === id);
      if (!found) throw new Error(`no such issue: ${id}`);
      return found;
    },
    async createComment(issueId: string, body: string) {
      // Recorded BEFORE the simulated outage, because the call really was made. The
      // worktree spy refuses to run until it sees `comment.create` in `order`, so a fake
      // that threw without recording turned "Linear is down" into "the run failed because
      // the worktree ran too early" — the run died of the fixture, not of the outage the
      // case is about.
      order.push('comment.create');
      if (opts.failCreate) throw new Error('linear is down');
      const c = { id: `comment-${++n}`, issueId, body };
      created.push(c);
      return { id: c.id };
    },
    async updateComment(commentId: string, body: string) {
      order.push('comment.update');
      updated.push({ commentId, body });
    },
    async setIssueState(issueId: string, stateType: string) {
      order.push('issue.state');
      states.push({ issueId, stateType });
    },
    async addSubscriber(issueId: string, userId: string) {
      order.push('issue.subscribe');
      subscribed.push({ issueId, userId });
    },
  };

  return { client: client as unknown as LinearClient, order, created, updated, subscribed, states };
}

/**
 * A worktree port that fails the test on early invocation rather than merely
 * documenting the rule. Nothing in the acknowledgement sequence may reach it.
 */
function spyWorktrees(order: string[], opts: { requireAck?: boolean } = {}) {
  const ACK_SEQUENCE = ['comment.create', 'issue.state', 'issue.subscribe'];
  // A REDRIVEN run deliberately does not re-acknowledge (D-7): it was acknowledged, moved
  // to In Progress and subscribed by the process that first picked it up, and re-running
  // that sequence posts a second pickup comment on the ticket (T72 through a new door).
  // So for those cases the guard below would fail the test for the product being correct.
  // Defaulted `true`, so every existing call site keeps today's behaviour.
  const requireAck = opts.requireAck ?? true;
  const removed: string[] = [];
  const created: string[] = [];

  const wt = {
    async create(runId: string, repo: { repoDir: string }, branch: string) {
      const missing = requireAck ? ACK_SEQUENCE.filter((s) => !order.includes(s)) : [];
      if (missing.length > 0) {
        throw new Error(`worktree reached before the acknowledgement sequence: missing ${missing.join(', ')}`);
      }
      order.push('worktree.create');
      created.push(runId);
      return { runId, repoDir: repo.repoDir, path: `/wt/${runId}`, branch, baseBranch: 'main' };
    },
    async remove(runId: string) {
      removed.push(runId);
    },
    async exists() {
      return true;
    },
    async gc() {
      return [];
    },
  };

  return { worktrees: wt as unknown as WorktreeManager, removed, created };
}

function harness(opts: {
  script: AgentResult[];
  issues: Array<ReturnType<typeof issue>>;
  concurrency?: number;
  failCreate?: boolean;
  /** The run was acknowledged by a PREVIOUS process; this one must not re-acknowledge. */
  preAcked?: boolean;
}) {
  const config = configWith(opts.concurrency ?? 3);
  const store = new InMemoryStore();
  const scheduler = createScheduler({ config, log: silent });
  const agent = new FakeAgentRunner(opts.script);
  const deliverer = new FakeDeliverer();
  const linear = recordingLinear(opts.issues, { failCreate: opts.failCreate });
  const spy = spyWorktrees(linear.order, { requireAck: !opts.preAcked });

  let questions: ReturnType<typeof createQuestions>;
  const engine = createRunEngine({
    store,
    scheduler,
    agent,
    worktrees: spy.worktrees,
    deliverer,
    linear: linear.client,
    config,
    log: silent,
    questions: () => questions,
  });
  questions = createQuestions({ store, engine, config, linear: linear.client, log: silent });

  return { store, scheduler, agent, deliverer, linear, spy, engine, config };
}

// ---------------------------------------------------------------------------
// Task 1 — pickup ordering (D-09, INTK-02, INTK-03)
// ---------------------------------------------------------------------------

test('acknowledgement, In Progress and the subscription all happen before any worktree work', async () => {
  const { engine, linear, spy, store } = harness({ script: [COMPLETE], issues: [issue(1)] });

  await engine.handle({ kind: 'run.requested', trigger: 'assignment', issueId: 'issue-1' });

  // The three Linear calls are already done when `handle` returns. The claim
  // that nothing reached the worktree first is enforced by the spy itself,
  // which throws on early invocation rather than being asserted after the fact.
  assert.deepEqual(
    linear.order.slice(0, 3),
    ['comment.create', 'issue.state', 'issue.subscribe'],
    'acknowledge, In Progress, subscribe -- in that order, at pickup',
  );

  await engine.settle();

  assert.deepEqual(
    linear.order.slice(0, 4),
    ['comment.create', 'issue.state', 'issue.subscribe', 'worktree.create'],
    'the ordering holds through the whole run, not just at pickup',
  );
  assert.deepEqual(linear.states, [{ issueId: 'issue-1', stateType: 'started' }]);
  assert.deepEqual(linear.subscribed, [{ issueId: 'issue-1', userId: 'operator-1' }]);

  const [run] = store.listByState('delivered');
  assert.ok(run, 'the run still completes');
});

test('the ack comment id is persisted, so a restart edits rather than re-posts', async () => {
  const { engine, store, linear } = harness({ script: [COMPLETE], issues: [issue(1)] });

  await engine.handle({ kind: 'run.requested', trigger: 'assignment', issueId: 'issue-1' });

  const [run] = store.findActiveRunByIssue('issue-1');
  const saved = JSON.parse(store.kvGet(`ack:${run.id}`)!);
  assert.equal(saved.commentId, linear.created[0].id, 'the edit target survives being read back');
  assert.equal(saved.position, 0, 'a run that started immediately was never queued');
});

test('a queued run is acknowledged with its position, and three position changes edit one comment', async () => {
  // One slot, held by an outsider, so all five runs park in arrival order.
  const h = harness({
    script: [COMPLETE, COMPLETE, COMPLETE, COMPLETE, COMPLETE],
    issues: [issue(1), issue(2), issue(3), issue(4), issue(5)],
    concurrency: 1,
  });
  const releaseHolder = await h.scheduler.acquire('outsider');

  for (let i = 1; i <= 5; i++) {
    await h.engine.handle({ kind: 'run.requested', trigger: 'assignment', issueId: `issue-${i}` });
  }

  const [last] = h.store.findActiveRunByIssue('issue-5');
  assert.equal(h.scheduler.positionOf(last.id), 5, 'the fifth arrival is fifth in line');

  const ackOf5 = h.linear.created.filter((c) => c.issueId === 'issue-5');
  assert.equal(ackOf5.length, 1, 'exactly one acknowledgement comment');
  assert.match(ackOf5[0].body, /position 5/, 'the acknowledgement carries the queue position');

  // Drain. Each completion releases a slot, everyone behind moves up, and every
  // move is an EDIT of the comment above.
  releaseHolder();
  await h.engine.settle();

  const updatesTo5 = h.linear.updated.filter((u) => u.commentId === ackOf5[0].id);
  assert.equal(updatesTo5.length, 3, 'positions 5 -> 3 -> 2 -> 1 are three edits');
  assert.deepEqual(
    updatesTo5.map((u) => /position (\d)/.exec(u.body)![1]),
    ['3', '2', '1'],
    'each edit carries the new position',
  );
  assert.equal(
    h.linear.created.filter((c) => c.issueId === 'issue-5' && /position/.test(c.body)).length,
    1,
    'never a second position comment -- one ticket, one queued comment',
  );
  assert.equal(
    h.linear.created.filter((c) => c.issueId === 'issue-5').length,
    2,
    'only the acknowledgement and the terminal comment are ever created',
  );
});

test('a Linear outage during acknowledgement is swallowed and the run still ships', async () => {
  const { engine, store, linear } = harness({
    script: [COMPLETE],
    issues: [issue(1)],
    failCreate: true,
  });

  await engine.handle({ kind: 'run.requested', trigger: 'assignment', issueId: 'issue-1' });
  await engine.settle();

  const [run] = store.listByState('delivered');
  assert.ok(run, 'a notification channel never fails a run (T-06-08)');
  assert.equal(store.kvGet(`ack:${run.id}`), undefined, 'no ack means no edit target');

  // And with no edit target the position update must NO-OP rather than fall
  // back to posting -- the fallback would be exactly the wall of comments D-10
  // exists to prevent.
  await engine.refreshQueuePositions();
  assert.equal(linear.updated.length, 0);
});

// ---------------------------------------------------------------------------
// Task 2 — cancellation (D-11, INTK-08) and terminal failure (D-13, OPS-04)
// ---------------------------------------------------------------------------

test('cancel from a state with no live child transitions immediately', async () => {
  const h = harness({ script: [COMPLETE], issues: [issue(1)], concurrency: 1 });
  const releaseHolder = await h.scheduler.acquire('outsider');

  await h.engine.handle({ kind: 'run.requested', trigger: 'assignment', issueId: 'issue-1' });
  const [run] = h.store.findActiveRunByIssue('issue-1');
  assert.equal(h.store.getRun(run.id)!.state, 'queued');

  await h.engine.handle({ kind: 'run.cancelled', issueId: 'issue-1', reason: 'bot unassigned' });

  assert.equal(h.store.getRun(run.id)!.state, 'cancelled', 'a queued run holds nothing, so it stops now');
  assert.equal(h.engine.isCancelRequested(run.id), false, 'no flag needed -- it already happened');

  releaseHolder();
  await h.engine.settle();

  assert.equal(h.store.getRun(run.id)!.state, 'cancelled', 'taking its turn in the queue does not revive it');
  assert.equal(h.spy.created.length, 0, 'a cancelled run never reaches the worktree');
});

test('cancel from awaiting_answer transitions and closes the open question', async () => {
  const h = harness({ script: [NEEDS_INPUT], issues: [issue(1)] });

  await h.engine.handle({ kind: 'run.requested', trigger: 'assignment', issueId: 'issue-1' });
  await h.engine.settle();

  const [run] = h.store.findActiveRunByIssue('issue-1');
  assert.equal(h.store.getRun(run.id)!.state, 'awaiting_answer');
  assert.equal(h.store.openQuestionsForIssue('issue-1').length, 1);

  await h.engine.cancel(run.id, 'bot unassigned');

  assert.equal(h.store.getRun(run.id)!.state, 'cancelled');
  assert.equal(h.store.openQuestionsForIssue('issue-1').length, 0, 'the open question is closed with the run');
});

test('cancel from a state with a live child sets a flag instead of transitioning', async () => {
  // The slot is held by an outsider so the run's own driver stays parked and
  // cannot race the states this test sets by hand.
  const h = harness({ script: [COMPLETE], issues: [issue(1)], concurrency: 1 });
  await h.scheduler.acquire('outsider');

  await h.engine.handle({ kind: 'run.requested', trigger: 'assignment', issueId: 'issue-1' });
  const [run] = h.store.findActiveRunByIssue('issue-1');

  // Fabricate the live-child state directly: the point under test is the
  // engine's response to a cancel from `running`, not how it got there.
  await h.engine.transition(run.id, 'preparing', 'test');
  await h.engine.transition(run.id, 'running', 'test');

  await h.engine.cancel(run.id, 'bot unassigned');
  assert.equal(
    h.store.getRun(run.id)!.state,
    'running',
    'a pushed branch cannot be un-pushed, so an instant transition would lie',
  );
  assert.equal(h.engine.isCancelRequested(run.id), true, 'the supervisor checkpoint reads this');

  // Idempotent: cancelling twice leaves one flag and one eventual transition.
  await h.engine.cancel(run.id, 'bot unassigned again');
  const requests = h.store
    .listRunEvents(run.id)
    .filter((e) => (e.detail ?? '').startsWith('cancel requested'));
  assert.equal(requests.length, 1, 'one flag, one run_events row');
  assert.equal(h.store.getRun(run.id)!.state, 'running');
});

test('cancel from a terminal state is a no-op, not an error', async () => {
  const h = harness({ script: [COMPLETE], issues: [issue(1)] });

  await h.engine.handle({ kind: 'run.requested', trigger: 'assignment', issueId: 'issue-1' });
  await h.engine.settle();

  const [run] = h.store.listByState('delivered');
  const before = h.store.listRunEvents(run.id).length;

  await h.engine.cancel(run.id, 'a replayed unassignment');

  assert.equal(h.store.getRun(run.id)!.state, 'delivered', 'terminal is terminal (T-06-09)');
  assert.equal(h.store.listRunEvents(run.id).length, before, 'and it writes nothing');
  assert.equal(h.engine.isCancelRequested(run.id), false);
});

test('cancel is accepted from every non-terminal state in the table', async () => {
  // Iterating the domain table rather than a hand-written list, so a tenth
  // state added in Phase 1 cannot silently escape the rule.
  for (const state of Object.keys(RUN_STATE_TABLE) as RunState[]) {
    if (RUN_STATE_TABLE[state].terminal) continue;
    const h = harness({ script: [COMPLETE], issues: [issue(1)], concurrency: 1 });
    await h.scheduler.acquire('outsider');
    await h.engine.handle({ kind: 'run.requested', trigger: 'assignment', issueId: 'issue-1' });
    const [run] = h.store.findActiveRunByIssue('issue-1');

    h.store.updateRun(run.id, { state });
    await h.engine.cancel(run.id, 'bot unassigned');

    const after = h.store.getRun(run.id)!.state;
    const expected = RUN_STATE_TABLE[state].hasLiveChild ? state : 'cancelled';
    assert.equal(after, expected, `cancel from ${state}`);
    assert.equal(h.engine.isCancelRequested(run.id), RUN_STATE_TABLE[state].hasLiveChild);
  }
});

test('a failed run posts one diagnosis with the error and log path, and keeps its worktree', async () => {
  const h = harness({
    script: [{ status: 'failed', summary: 'could not build', failureReason: 'tsc exited 2' }],
    issues: [issue(1)],
  });

  await h.engine.handle({ kind: 'run.requested', trigger: 'assignment', issueId: 'issue-1' });
  await h.engine.settle();

  const [run] = h.store.listByState('failed');
  assert.ok(run, 'the run is failed');

  const diagnoses = h.linear.created.filter((c) => /Run failed/.test(c.body));
  assert.equal(diagnoses.length, 1, 'exactly one diagnosis, from the finally');
  assert.match(diagnoses[0].body, /tsc exited 2/, 'the diagnosis carries the error');
  assert.match(diagnoses[0].body, /logs\/.*\.log/, 'and the log path');
  assert.match(diagnoses[0].body, /left in place/, 'and says the branch and worktree are kept');
  assert.equal(h.spy.removed.length, 0, 'the worktree cleanup port is NOT called on failure');
});

test('nothing AUTOMATIC moves a run out of failed', async () => {
  const failed = { status: 'failed' as const, summary: 'nope', failureReason: 'tsc exited 2' };
  const h = harness({ script: [failed, failed], issues: [issue(1)] });

  await h.engine.handle({ kind: 'run.requested', trigger: 'assignment', issueId: 'issue-1' });
  await h.engine.settle();
  const [run] = h.store.listByState('failed');

  // Every AUTOMATIC lever that could plausibly restart it. None may — that is D-13/OPS-04:
  // the daemon never retries a failed run on its own.
  await h.engine.refreshQueuePositions();
  h.scheduler.syncFromStore(h.store.listByState('failed'));
  await h.engine.cancel(run.id, 'unassigned');
  await h.engine.settle();

  assert.equal(h.store.getRun(run.id)!.state, 'failed', 'attempted exactly once (D-13, OPS-04)');
  assert.equal(
    h.store.listRunEvents(run.id).filter((e) => e.from === 'failed').length,
    0,
    'no transition leaves `failed`',
  );
  assert.equal(
    h.linear.created.filter((c) => /Run failed/.test(c.body)).length,
    1,
    'and the diagnosis is emitted exactly once',
  );

  // A DELIBERATE re-request is a different thing, and it is the operator's only retry
  // gesture: unassign, fix the repo, re-assign. That arrives on a webhook as
  // `trigger: 'assignment'`, and for an assignment the guard is `findActiveRunByIssue` —
  // about not running two sessions on one ticket AT ONCE, and a terminal row is not a live
  // one. This case originally listed `run.requested` among the levers that "may not"
  // restart it and asserted one diagnosis while producing two.
  //
  // What guards against an AUTOMATIC retry loop is `trigger`, not the reconciliation
  // watermark: the watermark is bumped by the bot's own writes and guards nothing (T107).
  // A `trigger: 'reconcile'` request against this same failed run is refused; this one is
  // honoured, and that difference is the whole point of the field.
  await h.engine.handle({ kind: 'run.requested', trigger: 'assignment', issueId: 'issue-1' });
  await h.engine.settle();

  assert.equal(h.store.getRun(run.id)!.state, 'failed', 'the ORIGINAL run was never revived');
  assert.equal(
    h.store.listRunEvents(run.id).filter((e) => e.from === 'failed').length,
    0,
    'still no transition out of `failed` — the retry is a NEW row, not a resurrection',
  );
  assert.equal(h.store.listByState('failed').length, 2, 'the retry is its own run');
});

test('a throw in the delivering path still produces exactly one terminal emission', async () => {
  const h = harness({ script: [COMPLETE], issues: [issue(1)] });
  h.deliverer.deliver = async () => {
    throw new Error('git push rejected: non-fast-forward\nheaders: <redacted>');
  };

  await h.engine.handle({ kind: 'run.requested', trigger: 'assignment', issueId: 'issue-1' });
  await h.engine.settle();

  const [run] = h.store.listByState('failed');
  assert.ok(run, 'a rejected push is a failure, not a hang');
  const terminal = h.linear.created.filter((c) => /Run failed/.test(c.body));
  assert.equal(terminal.length, 1, 'invariant 11: emitted from the finally, exactly once');
  assert.doesNotMatch(terminal[0].body, /headers:/, 'T-06-06: the raw error body never reaches the ticket');
  assert.equal(h.scheduler.inUse(), 0, 'and the slot came back');
});


// ---------------------------------------------------------------------------
// Task 3 — the drain (T108). The boot smoke proves the WIRE; these prove the
// RULES, and each one names the edit it catches.
// ---------------------------------------------------------------------------

/**
 * A run row with no driver in this heap — which IS "left by a previous process". Shaped
 * after `recovery.test.ts`'s seed, because that is the same fiction: rows that exist
 * because some earlier process wrote them.
 */
function seedRun(store: InMemoryStore, over: Partial<Run> = {}): Run {
  const run = {
    id: `r-${over.state ?? 'queued'}`,
    parentRunId: null,
    kind: 'repo',
    issueId: 'issue-1',
    issueKey: 'ENG-1',
    issueTitle: 'Ticket 1',
    issueUrl: 'https://linear.app/x/issue/ENG-1',
    repoDir: '/repo/api',
    repoSlug: 'org/api',
    branch: 'bot/eng-1',
    worktreePath: null,
    sessionId: 's-spent',
    pid: null,
    state: 'queued',
    attempt: 0,
    questionRound: 0,
    prUrl: null,
    failureReason: null,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  } as Run;
  store.insertRun(run);
  return run;
}

test('a run left queued by a previous process is dispatched with a FRESH session id', async () => {
  const h = harness({ script: [COMPLETE], issues: [issue(1)], preAcked: true });
  const run = seedRun(h.store, { id: 'r-stranded', sessionId: 's-spent' });

  assert.deepEqual(h.engine.dispatchQueued(), ['r-stranded'], 'the drain claims it');
  await h.engine.settle();

  assert.equal(h.store.getRun('r-stranded')!.state, 'delivered', 'and it actually runs');
  // D-6, and the assertion that separates a fix which works from one that is green here
  // and hard-errors on every real spawn: `claude` answers a reused --session-id with
  // `Session ID <uuid> is already in use`, which no fake agent can see.
  assert.notEqual(
    (h.store.getRun('r-stranded') as { sessionId: string }).sessionId,
    's-spent',
    'the spent session id was replaced before the spawn',
  );
  assert.equal(h.agent.calls[0]!.sessionId, h.store.getRun('r-stranded')!.sessionId);
  assert.equal(
    h.store.findRunsByIssue('issue-1').length,
    1,
    'RESUMED, not re-created — one row per issue (T107 intact)',
  );
  // D-7 / T72: no second acknowledgement. The pickup comment, the In Progress transition
  // and the subscription all already happened, in the process that first picked it up.
  assert.equal(
    h.linear.created.filter((c) => /Picked up/.test(c.body)).length,
    0,
    'no second pickup comment on the ticket',
  );
  assert.deepEqual(h.linear.states, [], 'no second In Progress transition');
  assert.deepEqual(h.linear.subscribed, [], 'no second subscription');
});

test('the drain never touches a terminal run (OPS-04 / T17)', async () => {
  const h = harness({ script: [COMPLETE], issues: [issue(1)], preAcked: true });
  for (const state of ['delivered', 'partial', 'failed', 'cancelled'] as RunState[]) {
    seedRun(h.store, { id: `r-${state}`, issueId: `issue-${state}`, state });
  }
  seedRun(h.store, { id: 'r-stranded' });

  // A `queued` row is an INTERRUPTED attempt, not a finished-badly one, and the guarantee
  // is the SELECTION rather than a comment: widen the read to a terminal state and this is
  // the bounded `failed -> queued` auto-retry T17 forbids. That edit goes red here.
  assert.deepEqual(h.engine.dispatchQueued(), ['r-stranded']);
  await h.engine.settle();
  assert.deepEqual(h.spy.created, ['r-stranded'], 'exactly one run reached the worktree');
});

test('the drain does not double-drive a run that already has a driver', async () => {
  // The boot window, reproduced: `sweepMissedWork` enqueues a run whose driver parks on
  // `acquire`, `scheduler.start()` resolves that slot promise as a MICROTASK, and step 8b
  // runs in the very next synchronous statement — so the row is still `queued` and reads
  // as stranded when it is not. Without the `driving` guard: two worktrees, two `claude`
  // sessions and two pull requests for one ticket.
  const h = harness({ script: [COMPLETE], issues: [issue(1)], concurrency: 1 });
  const releaseOutsider = await h.scheduler.acquire('outsider');

  await h.engine.handle({ kind: 'run.requested', trigger: 'assignment', issueId: 'issue-1' });
  const [run] = h.store.findActiveRunByIssue('issue-1');
  assert.equal(h.store.getRun(run.id)!.state, 'queued', 'queued, with a live parked driver');

  assert.deepEqual(h.engine.dispatchQueued(), [], 'the drain leaves it to the driver it has');

  releaseOutsider();
  await h.engine.settle();
  assert.deepEqual(h.spy.created, [run.id], 'exactly ONE worktree for one run');
});

test('the drain admits oldest-first across a restart', async () => {
  const h = harness({ script: [COMPLETE], issues: [issue(1)], concurrency: 1, preAcked: true });
  // Inserted 3, 1, 2 — so insertion order and `created_at` order disagree, which is what
  // makes wiring `nextQueued` (ORDER BY created_at ASC) load-bearing rather than
  // incidental. `listByState('queued')` would hand them back 3, 1, 2.
  for (const at of [3, 1, 2]) {
    seedRun(h.store, { id: `r-at-${at}`, issueId: `issue-${at}`, createdAt: at });
  }

  assert.deepEqual(h.engine.dispatchQueued(), ['r-at-1', 'r-at-2', 'r-at-3']);
  await h.engine.settle();
  assert.deepEqual(h.spy.created, ['r-at-1', 'r-at-2', 'r-at-3'], 'FIFO survives the restart');
});
