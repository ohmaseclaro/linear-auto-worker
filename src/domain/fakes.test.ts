/**
 * Constructs every fake with no arguments and asserts one real behaviour of each. This is
 * what turns "a compiling fake for every port" into something the integration gate actually
 * checks (T41 — this file stays inside `src/domain/`, never `test/`, so `node --test dist`
 * finds it). Written; not run — rush mode defers every `node --test` invocation to the
 * single end-of-milestone integration gate.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  InMemoryStore,
  FakeConfigLoader,
  RecordingLogger,
  FakeTunnel,
  FakeWebhookRegistrar,
  FakeReceiver,
  FakeEventRouter,
  FakeScheduler,
  FakeRunEngine,
  FakeWorktreeManager,
  FakeAgentRunner,
  FakeDeliverer,
  FakeLinearClient,
  RecordingNotifier,
} from './fakes.js';
import { resolveToggles } from './types.js';
import type { RepoRun, RepoMapping } from './types.js';
import type { LinearIssue } from './ports.js';

function makeRepoRun(overrides: Partial<RepoRun> = {}): RepoRun {
  return {
    id: 'run-1',
    kind: 'repo',
    parentRunId: null,
    issueId: 'issue-1',
    issueKey: 'ENG-1',
    issueTitle: 'test issue',
    issueUrl: 'https://linear.app/x/issue/ENG-1',
    attempt: 1,
    questionRound: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    state: 'queued',
    repoDir: '/repo',
    repoSlug: 'org/repo',
    branch: 'eng-1',
    worktreePath: null,
    sessionId: null,
    pid: null,
    prUrl: null,
    failureReason: null,
    ...overrides,
  };
}

const FAKE_REPO: RepoMapping = { repoDir: '/repo', repoSlug: 'org/repo', baseBranch: 'main', enabled: true };
const FAKE_AGENT_SPAWN_REQUEST = {
  runId: 'run-1',
  sessionId: 'session-1',
  cwd: '/wt/run-1',
  prompt: 'do the thing',
  resume: false,
  env: {},
};

test('every fake constructs with no arguments', () => {
  new InMemoryStore();
  new FakeConfigLoader();
  new RecordingLogger();
  new FakeTunnel();
  new FakeWebhookRegistrar();
  new FakeReceiver();
  new FakeEventRouter();
  new FakeScheduler();
  new FakeRunEngine();
  new FakeWorktreeManager();
  new FakeAgentRunner();
  new FakeDeliverer();
  new FakeLinearClient();
  new RecordingNotifier();
});

test('InMemoryStore.recordDelivery returns false on a duplicate id, true on a fresh one, no other effect either way', () => {
  const store = new InMemoryStore();
  assert.equal(store.recordDelivery('d1', 1), true);
  assert.equal(store.recordDelivery('d1', 2), false);
  assert.equal(store.recordDelivery('d2', 3), true);
});

test('InMemoryStore.findActiveRunByIssue excludes terminal runs', () => {
  const store = new InMemoryStore();
  store.insertRun(makeRepoRun({ id: 'r-open', state: 'running' }));
  store.insertRun(makeRepoRun({ id: 'r-done', state: 'delivered' }));
  const active = store.findActiveRunByIssue('issue-1');
  assert.deepEqual(
    active.map((r) => r.id),
    ['r-open'],
  );
});

test('InMemoryStore.findRunsByIssue answers the history question, terminals included', () => {
  const store = new InMemoryStore();
  store.insertRun(makeRepoRun({ id: 'r-open', state: 'running' }));
  store.insertRun(makeRepoRun({ id: 'r-done', state: 'delivered' }));
  store.insertRun(makeRepoRun({ id: 'r-other', issueId: 'issue-2', state: 'delivered' }));

  assert.deepEqual(
    store
      .findRunsByIssue('issue-1')
      .map((r) => r.id)
      .sort(),
    ['r-done', 'r-open'],
    'history: every row, terminal or not',
  );
  assert.deepEqual(
    store.findActiveRunByIssue('issue-1').map((r) => r.id),
    ['r-open'],
    'liveness: only the non-terminal one',
  );
  assert.equal(
    store.findRunsByIssue('issue-1').some((r) => r.id === 'r-other'),
    false,
    "another issue's run is in neither answer",
  );
  assert.deepEqual(store.findActiveRunByIssue('issue-2'), []);
});

test("FakeConfigLoader's fixture resolves a sparse override over the defaults (CONF-01/02, D-07, D-09)", async () => {
  const loader = new FakeConfigLoader();
  const config = await loader.load();
  const projectKeyed = Object.values(config.mappings).find((m) => m.linearProjectId !== null);
  const teamKeyed = Object.values(config.mappings).find((m) => m.linearTeamId !== null);
  assert.ok(projectKeyed, 'fixture must include a project-keyed mapping');
  assert.ok(teamKeyed, 'fixture must include a team-keyed fallback mapping');
  if (!projectKeyed || !teamKeyed) throw new Error('unreachable');
  assert.equal(projectKeyed.repos.length, 2);
  assert.ok(projectKeyed.slackWebhookUrl);
  assert.equal(Object.keys(teamKeyed.overrides ?? {}).length, 1, 'override must be sparse');
  const resolved = resolveToggles(config.defaults, teamKeyed);
  assert.notEqual(resolved.draftPr, config.defaults.draftPr);
});

test('RecordingLogger retains every line and child() shares the array with merged bindings', () => {
  const root = new RecordingLogger({ service: 'worker' });
  root.info('booted');
  const child = root.child({ runId: 'run-1' });
  child.warn({ secretish: false }, 'careful');
  assert.equal(root.lines.length, 2, 'child() must append to the same shared array');
  assert.equal(root.lines[1]!.bindings.runId, 'run-1');
  assert.equal(root.lines[1]!.bindings.service, 'worker');
});

test('FakeTunnel counts opens and reports no url before the first open', () => {
  const tunnel = new FakeTunnel();
  assert.equal(tunnel.url(), null);
  assert.equal(tunnel.openCount, 0);
});

test('FakeWebhookRegistrar.reconcile is idempotent: repeated calls return the same id', async () => {
  const registrar = new FakeWebhookRegistrar();
  const first = await registrar.reconcile('https://a.ngrok.app');
  const second = await registrar.reconcile('https://b.ngrok.app');
  assert.equal(first.webhookId, second.webhookId);
  assert.equal(registrar.reconcileCount, 2);
});

test('FakeReceiver.deliver pushes a delivery through the stored callback with no HTTP server', async () => {
  const receiver = new FakeReceiver();
  const received: unknown[] = [];
  await receiver.listen((d) => received.push(d));
  receiver.deliver({ deliveryId: 'd1', eventType: 'Issue', action: 'update', timestamp: Date.now(), body: {} });
  assert.equal(received.length, 1);
});

test('FakeEventRouter replays the scripted queue in order, then reports nothing', async () => {
  const router = new FakeEventRouter([{ kind: 'issue.assigned', issueId: 'issue-1' }]);
  const delivery = { deliveryId: 'd1', eventType: 'Issue', action: 'update' as const, timestamp: 1, body: {} };
  const first = await router.route(delivery);
  const second = await router.route(delivery);
  assert.equal(first?.kind, 'issue.assigned');
  assert.equal(second, null);
  assert.equal(router.delivered.length, 2);
});

test('FakeScheduler hands out exactly its capacity, and a doubled release does not inflate the count', async () => {
  const scheduler = new FakeScheduler(2);
  const releaseA = await scheduler.acquire('run-a');
  await scheduler.acquire('run-b');
  assert.equal(scheduler.inUse(), 2);

  let thirdAcquired = false;
  const thirdPromise = scheduler.acquire('run-c').then(() => {
    thirdAcquired = true;
  });

  releaseA();
  releaseA(); // idempotent — must not hand out a slot that was never taken
  await thirdPromise;
  assert.equal(thirdAcquired, true);
  assert.equal(scheduler.inUse(), 2);
});

test('FakeScheduler.syncFromStore recomputes admitted count from holdsSlot states', () => {
  const scheduler = new FakeScheduler(3);
  scheduler.syncFromStore([
    makeRepoRun({ id: 'r1', state: 'running' }),
    makeRepoRun({ id: 'r2', state: 'awaiting_answer' }), // holds no slot (D-02)
    makeRepoRun({ id: 'r3', state: 'delivering' }),
  ]);
  assert.equal(scheduler.inUse(), 2);
});

test('FakeRunEngine records handled events and recover/drain calls', async () => {
  const engine = new FakeRunEngine();
  await engine.handle({ kind: 'run.requested', trigger: 'assignment', issueId: 'issue-1' });
  await engine.recover();
  await engine.drain(5000);
  assert.equal(engine.handled.length, 1);
  assert.equal(engine.recovered, true);
  assert.equal(engine.drainedGraceMs, 5000);
});

test('FakeWorktreeManager.gc drops worktrees whose run is no longer live', async () => {
  const wtm = new FakeWorktreeManager();
  await wtm.create('run-1', FAKE_REPO, 'eng-1');
  await wtm.create('run-2', FAKE_REPO, 'eng-2');
  const removed = await wtm.gc(new Set(['run-1']));
  assert.equal(removed.length, 1);
  assert.equal(await wtm.exists('run-2'), false);
  assert.equal(await wtm.exists('run-1'), true);
});

test('FakeAgentRunner returns the scripted results in order, then repeats the last', async () => {
  const runner = new FakeAgentRunner([
    { status: 'needs_input', summary: 'need input', question: 'q?', assumption: 'assume yes' },
    { status: 'complete', summary: 'done', prTitle: 't', prBody: 'b' },
  ]);
  const first = await runner.run(FAKE_AGENT_SPAWN_REQUEST, new AbortController().signal);
  const second = await runner.run(FAKE_AGENT_SPAWN_REQUEST, new AbortController().signal);
  const third = await runner.run(FAKE_AGENT_SPAWN_REQUEST, new AbortController().signal);
  assert.equal(first.status, 'needs_input');
  assert.equal(second.status, 'complete');
  assert.equal(third.status, 'complete'); // repeats last once exhausted
  assert.equal(runner.calls.length, 3);
});

test('FakeAgentRunner resolves cancelled, never throws, when the signal is already aborted', async () => {
  const runner = new FakeAgentRunner();
  const controller = new AbortController();
  controller.abort();
  const result = await runner.run(FAKE_AGENT_SPAWN_REQUEST, controller.signal);
  assert.equal(result.status, 'cancelled');
});

test('FakeAgentRunner resolves cancelled when the signal aborts while the run is pending', async () => {
  const runner = new FakeAgentRunner();
  const controller = new AbortController();
  const pending = runner.run(FAKE_AGENT_SPAWN_REQUEST, controller.signal);
  controller.abort();
  const result = await pending;
  assert.equal(result.status, 'cancelled');
});

test('FakeDeliverer is idempotent: a repeated call for the same worktree returns the same PR', async () => {
  const deliverer = new FakeDeliverer();
  const wt = { runId: 'run-1', repoDir: '/repo', path: '/wt/run-1', branch: 'eng-1', baseBranch: 'main' };
  const pr = {
    title: 't',
    prBody: { ticketIdentifier: 'ENG-1', ticketUrl: 'https://linear.app/x/issue/ENG-1', summary: 'b' },
  };
  const first = await deliverer.deliver(wt, FAKE_REPO, pr);
  const second = await deliverer.deliver(wt, FAKE_REPO, pr);
  assert.equal(first.url, second.url);
  assert.equal(first.number, second.number);
});

test('FakeLinearClient.createComment returns a distinct id per call, retained for correlation', async () => {
  const issue: LinearIssue = {
    id: 'issue-1',
    identifier: 'ENG-1',
    title: 't',
    description: null,
    url: 'https://linear.app/x/issue/ENG-1',
    branchName: 'eng-1',
    assigneeId: 'fake-bot-user',
    projectId: null,
    teamId: 'team-1',
    stateId: 'state-1',
    stateType: 'started',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const client = new FakeLinearClient({ issues: [issue] });
  const first = await client.createComment('issue-1', 'hello');
  const second = await client.createComment('issue-1', 'world');
  assert.notEqual(first.id, second.id);
  assert.equal(client.comments.length, 2);
});

test('FakeLinearClient.getIssue rejects with LinearApiError on a miss', async () => {
  const client = new FakeLinearClient();
  await assert.rejects(() => client.getIssue('missing-issue'));
});

test('RecordingNotifier retains what it was given', async () => {
  const notifier = new RecordingNotifier();
  const run = makeRepoRun();
  await notifier.emit({ kind: 'run.queued', run });
  assert.equal(notifier.events.length, 1);
  assert.equal(notifier.events[0]!.kind, 'run.queued');
});
