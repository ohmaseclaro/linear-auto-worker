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
};

// Shaped against the ADDENDUM (`defaults` + `mappings`); cast because the exact
// field set lands with Phase 1 and this test must not pin it.
const CONFIG = {
  defaults: {
    concurrency: 3,
    questionTimeoutMs: 4 * 60 * 60 * 1000,
    baseBranch: 'main',
    postLinearComments: false,
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

const NEEDS_INPUT: AgentResult = {
  status: 'needs_input',
  summary: 'Blocked on a product judgement.',
  question: 'Should the health endpoint report database connectivity?',
  assumptionIfUnanswered: 'Report process liveness only.',
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
  questions = createQuestions({ store, engine, config: CONFIG, log: silent });

  return { store, scheduler, agent, worktrees, deliverer, linear, engine };
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

  await engine.handle({ kind: 'run.requested', issueId: ISSUE.id });

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
  assert.equal(open[0].assumption, NEEDS_INPUT.assumptionIfUnanswered);
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
  assert.equal(agent.calls[1].prompt, 'Yes -- include a database ping.');

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

  await engine.handle({ kind: 'run.requested', issueId: unmapped.id });
  await engine.settle();

  assert.equal(store.findActiveRunByIssue(unmapped.id).length, 0, 'no run row');
  assert.equal(agent.calls.length, 0, 'no agent spawned');
});
