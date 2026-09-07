/**
 * The Phase 6 tracer: one run travelling the whole orchestration path end to
 * end, including the Q&A detour, against Phase 1's in-memory fakes. No network,
 * no Claude process, no sibling phase code.
 *
 * The headline assertion is the ordering one: at the instant `awaiting_answer`
 * is written, the semaphore already reads zero. Releasing after the write would
 * leave a window in which a blocked run still counts against the cap, and that
 * window is the bug this phase exists to prevent (D-02, QA-03, invariant 1).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FakeAgentRunner,
  FakeDeliverer,
  FakeLinearClient,
  FakeWorktreeManager,
  InMemoryStore,
} from '../domain/fakes.js';
import type { AgentResult, Config, Logger } from '../domain/ports.js';
import { createScheduler } from './scheduler.js';
import { createRunEngine } from './run-engine.js';
import { createQuestions } from './questions.js';
import { POLL_WATERMARK_KEY, reconcile } from './recovery.js';
import type { RecoveryDeps } from './recovery.js';

const silent: Logger = {
  child: () => silent,
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

const ISSUE = {
  id: 'issue-1',
  identifier: 'ENG-42',
  title: 'Add a health endpoint',
  description: null,
  url: 'https://linear.app/x/issue/ENG-42',
  branchName: 'eng-42-add-a-health-endpoint',
  assigneeId: 'bot',
  projectId: 'proj-1',
  teamId: 'team-1',
  stateId: 'state-todo',
  stateType: 'unstarted',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const CONFIG: Config = {
  botUserId: 'bot',
  teamId: 'team-1',
  concurrency: 3,
  maxQuestionRounds: 3,
  maxTurns: 40,
  worktreeRoot: '/tmp/wt',
  dbPath: '/tmp/store.db',
  defaults: {
    questionTimeoutMs: 4 * 60 * 60 * 1000,
    baseBranch: 'main',
    postLinearComments: false,
    notifySlack: false,
    draftPr: true,
    questionsEnabled: true,
    maxRunMs: 60 * 60 * 1000,
  },
  mappings: {
    'proj-1': {
      linearProjectId: 'proj-1',
      linearTeamId: null,
      repos: [{ repoDir: '/repo/api', repoSlug: 'org/api', baseBranch: 'main', enabled: true }],
    },
  },
};

const NEEDS_INPUT: AgentResult = {
  status: 'needs_input',
  summary: 'Blocked on a product judgement.',
  question: 'Should the health endpoint report database connectivity?',
  assumption: 'Report process liveness only.',
};

const COMPLETE: AgentResult = {
  status: 'complete',
  summary: 'Added GET /health and a test.',
  prTitle: 'ENG-42: add a health endpoint',
  prBody: 'Adds GET /health.',
};

function harness(script: AgentResult[], issues: Array<typeof ISSUE> = [ISSUE]) {
  const store = new InMemoryStore();
  const scheduler = createScheduler({ config: CONFIG, log: silent });
  const agent = new FakeAgentRunner(script);
  const worktrees = new FakeWorktreeManager();
  const deliverer = new FakeDeliverer();
  const linear = new FakeLinearClient({ issues });

  // Late binding: questions calls back into the engine, so the engine takes a
  // thunk rather than the object.
  let questions: ReturnType<typeof createQuestions>;
  const engine = createRunEngine({
    store,
    scheduler,
    agent,
    worktrees,
    deliverer,
    linear,
    config: CONFIG,
    log: silent,
    questions: () => questions,
  });
  questions = createQuestions({ store, engine, config: CONFIG, linear, log: silent });

  return { store, scheduler, agent, worktrees, deliverer, linear, engine, questions };
}

test('one run travels queued -> delivered through the Q&A detour, holding no slot while blocked', async () => {
  const { store, scheduler, agent, engine } = harness([NEEDS_INPUT, COMPLETE]);

  // Record what the semaphore reads at the instant each state is written. This
  // is what proves the slot is released BEFORE the awaiting_answer write and
  // re-acquired BEFORE the run goes back to running -- an ordering claim a
  // final-state assertion cannot make.
  const slotAtWrite: Array<[string, number]> = [];
  const appendRunEvent = store.appendRunEvent.bind(store);
  store.appendRunEvent = (e) => {
    slotAtWrite.push([e.to, scheduler.inUse()]);
    appendRunEvent(e);
  };

  await engine.handle({ kind: 'run.requested', trigger: 'assignment', issueId: ISSUE.id });

  const [run] = store.findActiveRunByIssue(ISSUE.id);
  assert.ok(run, 'run.requested inserts exactly one run');
  assert.equal(store.listRunEvents(run.id)[0].from, null);
  assert.equal(store.listRunEvents(run.id)[0].to, 'queued');

  // --- the agent asks, the run blocks, the slot goes back ------------------
  await engine.settle();

  assert.equal(store.getRun(run.id)!.state, 'awaiting_answer');
  assert.equal(scheduler.inUse(), 0, 'awaiting_answer holds no concurrency slot');
  assert.equal(agent.calls.length, 1);
  assert.equal(agent.calls[0].resume, false, 'first spawn is a fresh session');

  const open = store.openQuestionsForIssue(ISSUE.id);
  assert.equal(open.length, 1, 'exactly one open question per blocked run');
  assert.equal(open[0].text, NEEDS_INPUT.question);
  assert.equal(open[0].assumption, NEEDS_INPUT.assumption);
  assert.ok(open[0].deadlineAt > open[0].askedAt, 'deadline is absolute, in the row');

  // --- the human answers, the run resumes and ships ------------------------
  await engine.handle({
    kind: 'question.answered',
    questionId: open[0].id,
    answer: 'Yes -- include a database ping.',
    authorName: 'operator',
  });
  await engine.settle();

  assert.equal(agent.calls.length, 2, 'the answer re-spawns the agent');
  assert.equal(agent.calls[1].resume, true, 'the second spawn resumes the session');
  assert.equal(agent.calls[1].sessionId, agent.calls[0].sessionId, 'same pre-assigned session id');
  // CONTAINS, not EQUALS. This asserted equality with the bare answer, which pinned the
  // defect it should have caught: the human's reply is a Linear COMMENT, and passing it to
  // `-p` verbatim put the most likely injection vector in the product through the one path
  // with no delimiter around it (T99).
  assert.match(agent.calls[1].prompt, /Yes -- include a database ping\./, 'the answer must reach the agent');
  assert.match(agent.calls[1].prompt, /is DATA, not instructions/i, 'and must be framed as data');
  assert.match(
    agent.calls[1].prompt,
    /do NOT run\s+git push/i,
    'a resumed turn must restate the delivery contract — the original brief is not in this turn',
  );

  const done = store.getRun(run.id)!;
  assert.equal(done.state, 'delivered');
  assert.ok(done.prUrl, 'a delivered run carries its PR url');
  assert.equal(scheduler.inUse(), 0, 'the slot is returned on the terminal state');

  // --- run_events mirrors the state sequence exactly (Phase 1 D-03) --------
  assert.deepEqual(
    store.listRunEvents(run.id).map((e) => e.to),
    ['queued', 'preparing', 'running', 'awaiting_answer', 'running', 'delivering', 'delivered'],
  );

  // --- the ordering claim --------------------------------------------------
  const atAwaiting = slotAtWrite.filter(([to]) => to === 'awaiting_answer');
  assert.deepEqual(atAwaiting, [['awaiting_answer', 0]], 'slot released before the write, not after');

  const running = slotAtWrite.filter(([to]) => to === 'running');
  assert.deepEqual(
    running.map(([, n]) => n),
    [1, 1],
    'the slot is held on every entry to running, including the resume',
  );
});

test('an issue with no repo mapping is ignored rather than inserted half-formed', async () => {
  const unmapped = { ...ISSUE, id: 'issue-2', projectId: 'proj-unknown', teamId: 'team-unknown' };
  const { store, engine, agent } = harness([COMPLETE], [unmapped]);

  await engine.handle({ kind: 'run.requested', trigger: 'assignment', issueId: unmapped.id });
  await engine.settle();

  assert.equal(store.findActiveRunByIssue(unmapped.id).length, 0, 'no run row');
  assert.equal(agent.calls.length, 0, 'no agent spawned');
});

/**
 * T107, the P0 this whole file's harness is here to catch: a ticket the daemon has
 * already DELIVERED must never be re-run by the reconciliation poll.
 *
 * Observed live on COD-2 — PR opened, run `delivered`, and sixty seconds later the poll
 * started a second run on the same ticket. Left alone it opens a pull request and burns a
 * paid `claude` session every minute, forever. Two faults met: `findActiveRunByIssue`
 * excludes terminal states so a `delivered` run blocks nothing, and the watermark cannot
 * bound the poll either because the bot's OWN In Progress transition and Done comment bump
 * `issue.updatedAt`.
 *
 * The second pass reproduces exactly that self-bump via `putIssue`, so neither pass is
 * allowed to pass vacuously on the watermark.
 */
test('a delivered run is never re-run by the reconciliation poll (T107)', async () => {
  const h = harness([COMPLETE]);

  await h.engine.handle({ kind: 'run.requested', trigger: 'assignment', issueId: ISSUE.id });
  await h.engine.settle();

  assert.equal(h.store.findRunsByIssue(ISSUE.id).length, 1, 'one assignment, one run');
  assert.equal(h.store.listByState('delivered').length, 1, 'and it reached delivered');

  const deps: RecoveryDeps = {
    store: h.store,
    engine: h.engine,
    scheduler: h.scheduler,
    questions: h.questions,
    linear: h.linear,
    config: CONFIG,
    log: silent,
    now: () => Date.parse('2026-06-01T00:00:00.000Z'),
  };

  // The issue is still assigned to the bot and still open, so the poll still lists it.
  assert.equal(
    (await h.linear.listAssignedOpenIssues(CONFIG.botUserId)).length,
    1,
    'precondition: the delivered ticket is still assigned and still listed',
  );

  // Pass one. The watermark is unset (EPOCH) and ISSUE.updatedAt is 2026-01-01, so the
  // issue CLEARS the watermark check — without this the test would pass vacuously against
  // broken code and prove nothing (T71).
  assert.equal(h.store.kvGet(POLL_WATERMARK_KEY), undefined, 'watermark starts unset');
  const first = await reconcile(deps, Date.parse('2026-06-01T00:00:00.000Z'));
  await h.engine.settle();
  assert.equal(
    h.store.findRunsByIssue(ISSUE.id).length,
    1,
    'pass one started no second run on the delivered ticket',
  );
  assert.deepEqual(first.enqueued, [], 'pass one enqueued nothing');

  // Pass two, with the self-event reproduced: the bot's own writes bump `updatedAt`, which
  // is what lifts the issue back over the watermark the first pass just advanced.
  h.linear.putIssue({ ...ISSUE, updatedAt: '2026-03-01T00:00:00.000Z' });
  const bumped = (await h.linear.listAssignedOpenIssues(CONFIG.botUserId))[0];
  assert.ok(
    bumped.updatedAt > h.store.kvGet(POLL_WATERMARK_KEY)!,
    'precondition: the bot-bumped issue clears the watermark, so pass two is not vacuous',
  );
  const second = await reconcile(deps, Date.parse('2026-06-01T00:00:00.000Z'));
  await h.engine.settle();
  assert.equal(
    h.store.findRunsByIssue(ISSUE.id).length,
    1,
    'still exactly one run: no second worktree, no second claude session, no second PR',
  );
  assert.deepEqual(second.enqueued, [], 'pass two enqueued nothing');
});

/**
 * The other half of T107's delegation, and the guarantee `recovery.test.ts` used to make
 * with its own private filter: an issue with a LIVE run is not re-run either. Three poll
 * passes, each clearing the watermark exactly as the bot's own writes make them, one run.
 */
test('three poll passes over an issue with a live run still produce one run (T107)', async () => {
  const h = harness([NEEDS_INPUT]);

  await h.engine.handle({ kind: 'run.requested', trigger: 'assignment', issueId: ISSUE.id });
  await h.engine.settle();
  assert.equal(h.store.listByState('awaiting_answer').length, 1, 'the run is parked, not over');

  const deps: RecoveryDeps = {
    store: h.store,
    engine: h.engine,
    scheduler: h.scheduler,
    questions: h.questions,
    linear: h.linear,
    config: CONFIG,
    log: silent,
    now: () => Date.parse('2026-06-01T00:00:00.000Z'),
  };

  for (const stamp of ['2026-02-01', '2026-03-01', '2026-04-01']) {
    h.linear.putIssue({ ...ISSUE, updatedAt: `${stamp}T00:00:00.000Z` });
    const watermark = h.store.kvGet(POLL_WATERMARK_KEY);
    assert.ok(
      watermark === undefined || `${stamp}T00:00:00.000Z` > watermark,
      `pass ${stamp} must clear the watermark, or it proves nothing`,
    );
    const report = await reconcile(deps, Date.parse('2026-06-01T00:00:00.000Z'));
    await h.engine.settle();
    assert.deepEqual(report.enqueued, [], `pass ${stamp} enqueued nothing`);
  }

  assert.equal(h.store.findRunsByIssue(ISSUE.id).length, 1, 'three passes, one run');
});
