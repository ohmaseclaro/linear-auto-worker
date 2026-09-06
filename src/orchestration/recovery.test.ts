/**
 * Written under rush mode, NOT executed: there is no package.json and no
 * node_modules on this branch. First run is the milestone integration gate.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryStore } from '../domain/fakes.js';
import { RUN_STATE_TABLE, canTransition } from '../domain/state-machine.js';
import type { PendingQuestion, RepoRun, Run, RunState } from '../domain/types.js';
import type { Config, DomainEvent, Logger } from '../domain/ports.js';
import { createScheduler } from './scheduler.js';
import type { AnswerComment, Correlation } from './questions.js';
import {
  BOOT_ACTION,
  POLL_WATERMARK_KEY,
  nonTerminalStates,
  recoverAtBoot,
  reconcile,
} from './recovery.js';
import type { RecoveryDeps } from './recovery.js';

const BOT = 'bot-user-id';

/** Narrow, don't assert-non-null: only a repo run carries `failureReason` (D-04). */
function repoRunOf(store: InMemoryStore, id: string): RepoRun {
  const run = store.getRun(id);
  assert.ok(run && run.kind === 'repo', `expected a repo run at ${id}`);
  return run;
}

const silent: Logger = {
  child: () => silent,
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const ALL_STATES: RunState[] = [
  'queued',
  'preparing',
  'running',
  'awaiting_answer',
  'delivering',
  'delivered',
  'partial',
  'failed',
  'cancelled',
];

interface ListedComment {
  id: string;
  parentId: string | null;
  body: string;
  authorId: string | null;
  authorName: string | null;
  createdAt: string;
}

interface ListedIssue {
  id: string;
  identifier: string;
  updatedAt: string;
}

interface Harness {
  deps: RecoveryDeps;
  store: InMemoryStore;
  /** Every `engine.transition()` this sweep made, in order. */
  transitions: Array<{ runId: string; to: RunState; detail?: string }>;
  events: DomainEvent[];
  /** Comments handed to `questions.ingestComment`, i.e. through `correlate()`. */
  ingested: AnswerComment[];
  /** Linear calls that would move the ticket. The sweep must make none. */
  ticketWrites: string[];
  issues: ListedIssue[];
  comments: Map<string, ListedComment[]>;
  /** Set to make the next Linear call throw. */
  failLinear: { on: boolean };
  scheduler: ReturnType<typeof createScheduler>;
}

function harness(): Harness {
  const store = new InMemoryStore();
  const transitions: Harness['transitions'] = [];
  const events: DomainEvent[] = [];
  const ingested: AnswerComment[] = [];
  const ticketWrites: string[] = [];
  const issues: ListedIssue[] = [];
  const comments = new Map<string, ListedComment[]>();
  const failLinear = { on: false };

  const config = {
    botUserId: BOT,
    operatorUserId: 'operator',
    logDir: '/logs',
    defaults: { concurrency: 3, baseBranch: 'main', questionFlow: true },
    mappings: {},
  } as unknown as Config;

  const scheduler = createScheduler({ config, log: silent });

  // Mirrors run-engine.ts's `transition`: validates against the domain table,
  // then writes the state. Recovery itself never writes `runs.state`.
  const engine = {
    async transition(runId: string, to: RunState, detail?: string) {
      const run = store.getRun(runId)!;
      // Only a repo run has a state (D-04); a ticket parent has no transition to make.
      assert.equal(run.kind, 'repo', `transition attempted on a ticket parent: ${runId}`);
      const from = run.kind === 'repo' ? run.state : null;
      assert.ok(from && canTransition(from, to), `illegal recovery transition ${from} -> ${to}`);
      transitions.push({ runId, to, detail });
      store.updateRun(runId, { state: to });
      return store.getRun(runId)!;
    },
    async handle(e: DomainEvent) {
      events.push(e);
    },
    async cancel() {},
    isCancelRequested: () => false,
    async refreshQueuePositions() {},
    async settle() {},
  };

  const questions = {
    async ingestComment(c: AnswerComment): Promise<Correlation> {
      ingested.push(c);
      // The real `correlate()` drops bot-authored comments before either tier;
      // reproduced here only so the fake does not resume on the bot's own
      // question comment. The behaviour under test is that recovery hands
      // every listed comment to this one function.
      if (c.authorId === BOT) return { outcome: 'none', reason: 'bot_authored' };
      const open = store.openQuestionsForIssue(c.issueId).filter((q) => q.status === 'open');
      const q = c.parentId
        ? open.find((o) => o.linearCommentId === c.parentId)
        : open.length === 1
          ? open[0]
          : undefined;
      if (!q) return { outcome: 'none', reason: 'no_open_questions' };
      store.updateQuestion(q.id, { status: 'answered', answer: c.body, answeredBy: c.authorName });
      await engine.transition(q.runId, 'running', `answer to ${q.id}`);
      return { outcome: 'matched', question: store.getQuestion(q.id)!, tier: c.parentId ? 1 : 2 };
    },
    async openQuestion() {
      return null;
    },
    async applyAnswer() {
      return null;
    },
    async sweep() {
      return [];
    },
  };

  const linear = {
    async listAssignedOpenIssues(botUserId: string) {
      if (failLinear.on) throw new Error('linear is down');
      assert.equal(botUserId, BOT);
      return issues;
    },
    async listComments(issueId: string, since?: string) {
      if (failLinear.on) throw new Error('linear is down');
      return (comments.get(issueId) ?? []).filter((c) => !since || c.createdAt > since);
    },
    async setIssueState(issueId: string) {
      ticketWrites.push(`state:${issueId}`);
    },
    async createComment(issueId: string) {
      ticketWrites.push(`comment:${issueId}`);
      return { id: 'c-new' };
    },
  };

  const deps = {
    store,
    engine,
    scheduler,
    questions,
    linear,
    config,
    log: silent,
    now: () => 5_000,
  } as unknown as RecoveryDeps;

  return {
    deps,
    store,
    transitions,
    events,
    ingested,
    ticketWrites,
    issues,
    comments,
    failLinear,
    scheduler,
  };
}

function seedRun(store: InMemoryStore, over: Partial<Run> = {}): Run {
  const run = {
    id: `r-${over.state ?? 'x'}`,
    parentRunId: null,
    kind: 'repo',
    issueId: `ISS-${over.state ?? 'x'}`,
    issueKey: 'ENG-42',
    issueTitle: 'add a worker',
    issueUrl: 'https://linear.app/x/ENG-42',
    repoDir: '/code/api',
    repoSlug: 'org/api',
    branch: 'bot/eng-42',
    worktreePath: '/wt/r1',
    sessionId: 's1',
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

function seedAllNine(store: InMemoryStore): void {
  for (const state of ALL_STATES) seedRun(store, { state });
}

function seedQuestion(store: InMemoryStore, over: Partial<PendingQuestion> = {}): PendingQuestion {
  const q = {
    id: 'q1',
    runId: 'r-awaiting_answer',
    text: 'which database?',
    assumption: 'postgres',
    linearCommentId: 'c-q1',
    askedAt: 1_000,
    deadlineAt: 1_000 + 4 * 60 * 60 * 1_000,
    status: 'open',
    answer: null,
    answeredBy: null,
    ...over,
  } as PendingQuestion;
  store.insertQuestion(q);
  return q;
}

// --- Task 1: the boot sweep (D-07 / D-08 / OPS-01) -------------------------

test('the sweep produces exactly D-07: requeue the cheap two, fail the expensive two, leave the rest', async () => {
  const h = harness();
  seedAllNine(h.store);

  await recoverAtBoot(h.deps);

  const stateOf = (s: RunState) => h.store.getRun(`r-${s}`)!.state;
  assert.equal(stateOf('queued'), 'queued');
  assert.equal(stateOf('preparing'), 'queued');
  assert.equal(stateOf('running'), 'failed');
  assert.equal(stateOf('delivering'), 'failed');
  assert.equal(stateOf('awaiting_answer'), 'awaiting_answer');
  // Terminal rows are not loaded and not touched.
  assert.equal(stateOf('delivered'), 'delivered');
  assert.equal(stateOf('partial'), 'partial');
  assert.equal(stateOf('failed'), 'failed');
  assert.equal(stateOf('cancelled'), 'cancelled');
});

test('D-08: no run survives the sweep in a non-terminal state other than queued or awaiting_answer', async () => {
  const h = harness();
  seedAllNine(h.store);

  await recoverAtBoot(h.deps);

  // The completeness assertion. The state set comes from the domain table, not
  // from a list written here, so a tenth state added to the contract fails this
  // test rather than slipping through the sweep unhandled.
  const survivors = h.store
    .listByState(...nonTerminalStates())
    .filter((r) => r.state !== 'queued' && r.state !== 'awaiting_answer');
  assert.deepEqual(survivors, []);
});

test('every non-terminal state in the domain table has a boot action', () => {
  // The static half of the same guarantee: `BOOT_ACTION` is typed
  // `Record<RunState, ...>`, so this is what catches a tenth state at runtime
  // during the rush window where nothing typechecks.
  for (const state of nonTerminalStates()) {
    assert.ok(BOOT_ACTION[state] !== undefined, `no boot action for ${state}`);
  }
  assert.deepEqual(Object.keys(BOOT_ACTION).sort(), Object.keys(RUN_STATE_TABLE).sort());
});

test('a failed-at-boot run gets exactly one diagnosis naming the state it was recovered from', async () => {
  const h = harness();
  seedRun(h.store, { state: 'running' });
  seedRun(h.store, { state: 'delivering' });

  await recoverAtBoot(h.deps);

  const running = repoRunOf(h.store, 'r-running');
  assert.match(running.failureReason!, /running/);
  assert.match(running.failureReason!, /left in place/);
  const delivering = repoRunOf(h.store, 'r-delivering');
  assert.match(delivering.failureReason!, /delivering/);

  // Exactly one, not one per pass and not one per state.
  assert.equal(h.transitions.filter((t) => t.runId === 'r-running').length, 1);
  assert.match(h.transitions.find((t) => t.runId === 'r-running')!.detail!, /recovered from running/);
});

test('the sweep never touches the ticket and never prunes a worktree', async () => {
  const h = harness();
  seedAllNine(h.store);

  await recoverAtBoot(h.deps);

  // A requeued run is going to run, so In Progress is still the truth -- moving
  // the ticket would be a lie the operator has to read twice.
  assert.deepEqual(h.ticketWrites, []);
  // The worktree of a failed run is left for inspection (D-13), and pruning a
  // `preparing` leftover is Phase 4's boot GC. `RecoveryDeps` has no worktree
  // port at all, so neither is reachable from this module.
  assert.equal(h.store.getRun('r-running')!.worktreePath, '/wt/r1');
  assert.equal(h.store.getRun('r-preparing')!.worktreePath, '/wt/r1');
});

test('an awaiting_answer run has nothing re-armed: no transition, and its deadline is unchanged', async () => {
  const h = harness();
  seedRun(h.store, { state: 'awaiting_answer' });
  const before = seedQuestion(h.store);

  await recoverAtBoot(h.deps);

  assert.deepEqual(
    h.transitions.filter((t) => t.runId === 'r-awaiting_answer'),
    [],
  );
  const after = h.store.getQuestion(before.id)!;
  assert.equal(after.deadlineAt, before.deadlineAt);
  assert.equal(after.status, 'open');
});

test('sweeping twice is a no-op the second time', async () => {
  const h = harness();
  seedAllNine(h.store);

  await recoverAtBoot(h.deps);
  const afterFirst = h.transitions.length;
  const snapshot = ALL_STATES.map((s) => h.store.getRun(`r-${s}`)!.state);

  await recoverAtBoot(h.deps);

  assert.equal(h.transitions.length, afterFirst);
  assert.deepEqual(
    ALL_STATES.map((s) => h.store.getRun(`r-${s}`)!.state),
    snapshot,
  );
});

test('the scheduler agrees with the database afterwards, and awaiting_answer contributes zero', async () => {
  const h = harness();
  seedAllNine(h.store);

  await recoverAtBoot(h.deps);

  // Post-sweep the only non-terminal rows are `queued` and `awaiting_answer`,
  // and the state table says neither holds a slot (01-CONTEXT D-02). Starting
  // at anything other than zero here is how a restart silently loses capacity.
  assert.equal(h.scheduler.inUse(), 0);
});

test('one unrecoverable row does not abandon the runs behind it', async () => {
  const h = harness();
  seedRun(h.store, { state: 'running' });
  seedRun(h.store, { state: 'preparing' });
  const engine = h.deps.engine as unknown as { transition: (...a: unknown[]) => Promise<unknown> };
  const real = engine.transition;
  engine.transition = async (...args: unknown[]) => {
    if (args[0] === 'r-running') throw new Error('store exploded');
    return real.apply(engine, args);
  };

  const report = await recoverAtBoot(h.deps);

  assert.deepEqual(report.requeued, ['r-preparing']);
  assert.equal(h.store.getRun('r-preparing')!.state, 'queued');
});

// --- Task 2: the reconciliation poll (INTK-07 / 03-CONTEXT D-04, D-05) ------

const NOW = Date.parse('2026-09-06T12:00:00.000Z');
const OLD = '2026-09-06T10:00:00.000Z';
const FRESH = '2026-09-06T11:00:00.000Z';

test('a bot-assigned issue with no non-terminal run is enqueued (INTK-07)', async () => {
  const h = harness();
  h.store.kvSet(POLL_WATERMARK_KEY, OLD);
  h.issues.push({ id: 'ISS-new', identifier: 'ENG-99', updatedAt: FRESH });

  const report = await reconcile(h.deps, NOW);

  assert.deepEqual(report.enqueued, ['ISS-new']);
  assert.deepEqual(h.events, [{ kind: 'run.requested', issueId: 'ISS-new' }]);
});

test('an issue that already has a non-terminal run is not enqueued again — three passes, one run', async () => {
  const h = harness();
  h.store.kvSet(POLL_WATERMARK_KEY, OLD);
  h.issues.push({ id: 'ISS-running', identifier: 'ENG-1', updatedAt: FRESH });
  seedRun(h.store, { state: 'running' });

  await reconcile(h.deps, NOW);
  await reconcile(h.deps, NOW);
  await reconcile(h.deps, NOW);

  assert.deepEqual(h.events, []);
});

test('an issue below the watermark is not re-enqueued on the next pass', async () => {
  const h = harness();
  h.issues.push({ id: 'ISS-new', identifier: 'ENG-99', updatedAt: FRESH });

  const first = await reconcile(h.deps, NOW);
  assert.deepEqual(first.enqueued, ['ISS-new']);
  assert.equal(first.watermark, FRESH);
  assert.equal(h.store.kvGet(POLL_WATERMARK_KEY), FRESH);

  // The run the first pass created is not in this fake store, so only the
  // watermark can prevent the second enqueue. That is the assertion.
  const second = await reconcile(h.deps, NOW);
  assert.deepEqual(second.enqueued, []);
});

test('a reply posted while the daemon was down resumes its run on the first poll, deadline unexpired', async () => {
  // 03-CONTEXT D-05, the half everyone leaves out. An issue-level updatedAt diff
  // sees that the issue changed; it does not see that a threaded reply landed on
  // a comment, and a reply is not an issue field. Without the comment listing
  // this run sits in `awaiting_answer` for its full four hours despite the
  // operator having already answered in writing.
  const h = harness();
  h.store.kvSet(POLL_WATERMARK_KEY, OLD);
  seedRun(h.store, { state: 'awaiting_answer' });
  const q = seedQuestion(h.store, { deadlineAt: NOW + 3 * 60 * 60 * 1_000 });
  h.comments.set('ISS-awaiting_answer', [
    {
      id: 'c-reply',
      parentId: 'c-q1',
      body: 'use sqlite',
      authorId: 'human',
      authorName: 'Ada',
      createdAt: FRESH,
    },
  ]);

  const report = await reconcile(h.deps, NOW);

  assert.equal(report.resumed, 1);
  assert.equal(h.store.getRun('r-awaiting_answer')!.state, 'running');
  const answered = h.store.getQuestion(q.id)!;
  assert.equal(answered.status, 'answered');
  assert.equal(answered.answer, 'use sqlite');
  assert.equal(answered.answeredBy, 'Ada');
  // And it resumed because of the reply, not because the deadline elapsed.
  assert.ok(answered.deadlineAt > NOW, 'the deadline had not passed');
});

test('every listed comment goes through the one correlator, never a second matcher here', async () => {
  const h = harness();
  h.store.kvSet(POLL_WATERMARK_KEY, OLD);
  seedRun(h.store, { state: 'awaiting_answer' });
  seedQuestion(h.store);
  h.comments.set('ISS-awaiting_answer', [
    { id: 'c-a', parentId: 'c-q1', body: 'yes', authorId: 'human', authorName: 'Ada', createdAt: FRESH },
  ]);

  await reconcile(h.deps, NOW);

  assert.equal(h.ingested.length, 1);
  assert.deepEqual(h.ingested[0], {
    id: 'c-a',
    issueId: 'ISS-awaiting_answer',
    parentId: 'c-q1',
    body: 'yes',
    authorId: 'human',
    authorName: 'Ada',
  });
});

test('an issue with an open question but no new comments produces no correlation and no transition', async () => {
  const h = harness();
  h.store.kvSet(POLL_WATERMARK_KEY, FRESH);
  seedRun(h.store, { state: 'awaiting_answer' });
  seedQuestion(h.store);
  // Older than the watermark: already covered by a previous clean pass.
  h.comments.set('ISS-awaiting_answer', [
    { id: 'c-old', parentId: 'c-q1', body: 'stale', authorId: 'human', authorName: 'Ada', createdAt: OLD },
  ]);

  const report = await reconcile(h.deps, NOW);

  assert.deepEqual(h.ingested, []);
  assert.equal(report.resumed, 0);
  assert.deepEqual(h.transitions, []);
  assert.equal(h.store.getRun('r-awaiting_answer')!.state, 'awaiting_answer');
});

test('a bot-authored comment found by the listing correlates to nothing (T-06-17)', async () => {
  // These comments came straight off the API and passed none of Phase 3's four
  // ingress guards. The bot-author drop lives inside `correlate()` precisely so
  // this second entry point inherits it -- the bot's own question comment is the
  // first thing this listing returns, and answering it is an infinite loop.
  const h = harness();
  h.store.kvSet(POLL_WATERMARK_KEY, OLD);
  seedRun(h.store, { state: 'awaiting_answer' });
  seedQuestion(h.store);
  h.comments.set('ISS-awaiting_answer', [
    { id: 'c-q1', parentId: null, body: 'which database?', authorId: BOT, authorName: 'bot', createdAt: FRESH },
  ]);

  const report = await reconcile(h.deps, NOW);

  assert.equal(h.ingested.length, 1, 'the guard is inside correlate, so the comment still reaches it');
  assert.equal(report.resumed, 0);
  assert.equal(h.store.getRun('r-awaiting_answer')!.state, 'awaiting_answer');
});

test('a Linear failure mid-poll is swallowed and leaves the watermark where it was', async () => {
  const h = harness();
  h.store.kvSet(POLL_WATERMARK_KEY, OLD);
  h.issues.push({ id: 'ISS-new', identifier: 'ENG-99', updatedAt: FRESH });
  h.failLinear.on = true;

  const report = await reconcile(h.deps, NOW);

  // Degraded to "missing backlog until the next pass", not stopped.
  assert.equal(report.advanced, false);
  assert.equal(report.watermark, OLD);
  assert.equal(h.store.kvGet(POLL_WATERMARK_KEY), OLD);

  // The next pass re-covers the same window rather than skipping it. Preferring
  // re-processing over skipping is safe here: the no-active-run check absorbs a
  // duplicate, whereas a skipped window is silently lost work.
  h.failLinear.on = false;
  const retry = await reconcile(h.deps, NOW);
  assert.deepEqual(retry.enqueued, ['ISS-new']);
  assert.equal(h.store.kvGet(POLL_WATERMARK_KEY), FRESH);
});

test('the watermark never advances past our own clock', async () => {
  // A Linear clock running ahead of ours must not carry the watermark into the
  // future, because everything between now and there would be skipped.
  const h = harness();
  h.issues.push({ id: 'ISS-future', identifier: 'ENG-7', updatedAt: '2027-01-01T00:00:00.000Z' });

  const report = await reconcile(h.deps, NOW);

  assert.equal(report.advanced, false);
  assert.equal(h.store.kvGet(POLL_WATERMARK_KEY), undefined);
  // It is still enqueued -- the clamp bounds the watermark, not the work.
  assert.deepEqual(report.enqueued, ['ISS-future']);
});
