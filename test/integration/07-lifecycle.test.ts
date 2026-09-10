/**
 * The daemon's lifecycle: what a clean stop guarantees, and what the next boot does with
 * what it finds.
 *
 * `07-ingress-seam.test.ts` proves a signed webhook becomes a persisted run and
 * `07-run-path.test.ts` walks that run to a pull request. This file covers the two ends —
 * OPS-05's reverse-order shutdown and 06-CONTEXT D-07's per-state restart recovery — and
 * the seam between them, which is the one people get wrong: D-07 fails a `running` row at
 * boot because after a CRASH the push status is unknowable, and that is only tolerable
 * because a CLEAN stop moves those runs back to `queued` first (07-CONTEXT D-06). Break the
 * clean-stop half and every Ctrl-C costs a manual re-assignment of every live ticket, with
 * nothing failing to say so (TRAPS T18, T26).
 *
 * Four rules, three inherited:
 *
 *  1. **Assert on database state and on recorded order, never on elapsed time.**
 *  2. **The store is real SQLite against the real migration** — `InMemoryStore` is what let
 *     three statements against columns that do not exist survive a green typecheck and a
 *     green unit suite (07-RUNTIME-EVIDENCE, T53).
 *  3. **The git repository is real**, because `prepareWorktree` shells out.
 *  4. **New here: after `bootDaemon` resolves, the scheduler is RUNNING.** Boot's last step
 *     is `scheduler.start()`, so a recovery assertion written against a run's *current*
 *     state is racing the driver that just picked it up. Every recovery assertion below is
 *     therefore written against `run_events`, which is append-only and cannot be overtaken.
 *
 * Written by plan 07-05; first executed by plan 07-06, which owns the gate.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { execa } from 'execa';

import {
  bootDaemon,
  createIngressMapper,
  SHUTDOWN_NOTE,
  type DaemonHandle,
} from '../../src/cli/daemon.js';
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
import { asDomainStore } from '../../src/infra/store/domain-store.js';
import { createSqliteStore } from '../../src/infra/store/sqlite-store.js';
import { openStore } from '../../src/infra/store/db.js';
import { isTerminal } from '../../src/domain/state-machine.js';
import type { AgentSubprocess } from '../../src/execution/supervisor.js';
import { defaultRunCommand, type RunCommandOptions, type RunCommandResult } from '../../src/execution/execute-run.js';
import type {
  AgentResult,
  AgentRunner,
  AgentSpawnRequest,
  Deliverer,
  LinearComment,
  PendingQuestion,
  PullRequest,
  RepoRun,
  Run,
  RunEventRow,
  RunState,
  Store,
} from '../../src/domain/ports.js';

const SECRET = 'lifecycle-webhook-secret-0123456789abcdef';

/** `process.kill(pid, 0)` is the liveness probe; ESRCH is "gone". */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Poll a synchronous predicate. Same reason as `until`: no sleep-and-hope. */
async function untilTrue(what: () => boolean, label: string, timeoutMs = 20_000): Promise<void> {
  await until(() => (what() ? true : undefined), { label, timeoutMs });
}

// ── the detached shell that gives us a real grandchild ────────────────────────

/**
 * A spawn that starts a shell which BACKGROUNDS a sleeper and then sleeps itself.
 *
 * This is the whole point of the first two cases. `child.kill()` — and equally
 * `process.kill(pid, sig)` on the positive pid — reaps the shell and ORPHANS the
 * backgrounded sleeper, which then survives the daemon, keeps whatever it was doing, and
 * holds the stdout pipe open so the supervisor's promise never settles (04-CONTEXT D-09,
 * T29, measured). A test that spawns a single childless process passes against exactly
 * that bug, which is why this one prints its grandchild's pid and asserts on it by name.
 */
interface SpawnRecord {
  leader?: number;
  grandchild?: number;
}

function detachedGrandchildSpawn(seen: SpawnRecord) {
  return (_file: string, _args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv }): AgentSubprocess => {
    const child = execa('sh', ['-c', 'sleep 600 & echo "GRANDCHILD=$!"; sleep 600'], {
      cwd: options.cwd,
      env: options.env,
      extendEnv: false,
      // Group leader, which is what makes the negative-pid kill legal at all.
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      reject: false,
    });
    seen.leader = child.pid;

    // Tee rather than consume: the supervisor drains this stream, and an undrained stdout
    // deadlocks the child at ~64 KB (D-07).
    const source = child.stdout;
    const stdout =
      source === null || source === undefined
        ? null
        : (async function* () {
            for await (const chunk of source as AsyncIterable<unknown>) {
              const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
              const m = /GRANDCHILD=(\d+)/.exec(text);
              if (m?.[1]) seen.grandchild = Number(m[1]);
              yield chunk;
            }
          })();

    return {
      pid: child.pid,
      stdout,
      stderr: child.stderr as AsyncIterable<unknown> | null,
      // T113: the prompt travels here now. This case is about the reap ladder against a
      // real process tree, so it passes the real child's stdin straight through.
      stdin: child.stdin as NodeJS.WritableStream | null,
      then: (onOk, onErr) => (child as PromiseLike<{ exitCode?: number | undefined }>).then(onOk, onErr),
    } satisfies AgentSubprocess;
  };
}

// ── scripted collaborators ───────────────────────────────────────────────────

class ScriptedAgent implements AgentRunner {
  /**
   * These integration fixtures all map ONE repository, so the engine never reaches
   * discovery — `narrowRepos` returns early below two repos. `undefined` is nonetheless the
   * honest answer rather than a throw: it is the "could not answer" arm, and the caller
   * falls back to the operator's mapping.
   */
  discoverRepos(): Promise<string[] | undefined> {
    return Promise.resolve(undefined);
  }

  readonly calls: AgentSpawnRequest[] = [];
  private readonly result: AgentResult;
  constructor(result: AgentResult) {
    this.result = result;
  }
  run(req: AgentSpawnRequest): Promise<AgentResult> {
    this.calls.push(req);
    return Promise.resolve(this.result);
  }
  onProgress(): void {
    /* nothing to report */
  }
}

class FakeDeliverer implements Deliverer {
  readonly calls: number[] = [];
  deliver(): Promise<PullRequest> {
    this.calls.push(this.calls.length + 1);
    return Promise.resolve({ url: 'https://github.com/smoke/repo/pull/1', number: 1 });
  }
}

/**
 * `RecordingLinear` plus scripted HUMAN replies.
 *
 * The shared fake stamps every comment with the BOT's author id, because every comment it
 * has is one the daemon wrote. A reply from a person is the thing this file needs and the
 * one thing that fake structurally cannot produce.
 */
class ReplyingLinear extends RecordingLinear {
  readonly replies: LinearComment[] = [];
  override async listComments(issueId: string, since?: string): Promise<LinearComment[]> {
    const base = await super.listComments(issueId, since);
    return [...base, ...this.replies];
  }
}

// ── seeding a database the way a previous process would have left it ─────────

function seedRun(store: Store, state: RunState, dir: string, overrides: Partial<RepoRun> = {}): RepoRun {
  const at = Date.now();
  const run: RepoRun = {
    kind: 'repo',
    id: randomUUID(),
    parentRunId: null,
    issueId: ISSUE_ID,
    issueKey: 'SMK-1',
    issueTitle: 'seeded',
    issueUrl: 'https://linear.app/smoke/issue/SMK-1',
    attempt: 1,
    questionRound: 0,
    createdAt: at,
    updatedAt: at,
    state,
    repoDir: `${dir}/repo`,
    repoSlug: 'smoke/repo',
    branch: 'smoke/smk-1',
    worktreePath: null,
    sessionId: null,
    pid: null,
    prUrl: null,
    failureReason: null,
    ...overrides,
  };
  store.insertRun(run);
  store.appendRunEvent({ runId: run.id, from: null, to: state, at, detail: 'seeded' });
  return run;
}

/** Open the file the daemon used, after the daemon has closed it. */
function reopen(dir: string): Store {
  return asDomainStore(createSqliteStore(openStore(`${dir}/store.db`)));
}

function eventsOf(store: Store, runId: string): RunEventRow[] {
  return store.listRunEvents(runId);
}

function hasTransition(events: RunEventRow[], from: RunState, to: RunState): boolean {
  return events.some((e) => e.from === from && e.to === to);
}

// ─────────────────────────────────────────────────────────────────────────────

test('shutdown reaps the whole process GROUP: the agent and its own grandchild both die', async () => {
  const workspace = await makeWorkspace(SECRET);
  await makeScratchRepo(workspace.dir);
  const issue = smokeIssue({ assigneeId: BOT_USER_ID });
  const linear = new RecordingLinear({ issues: [issue] });
  const seen: SpawnRecord = {};

  const daemon = await bootDaemon({
    configDir: workspace.dir,
    linear,
    tunnel: probingTunnel(),
    runCommand: okTools,
    spawn: detachedGrandchildSpawn(seen),
  });

  try {
    // The boot sweep finds the bot-assigned issue and the started scheduler drives it, so
    // the shell is spawned without any webhook needing to arrive.
    await untilTrue(
      () => seen.leader !== undefined && seen.grandchild !== undefined,
      'the agent shell and its backgrounded grandchild to report their pids',
    );
    const leader = seen.leader!;
    const grandchild = seen.grandchild!;
    assert.notEqual(leader, grandchild, 'the fixture must produce a real grandchild');
    assert.ok(alive(leader) && alive(grandchild), 'both processes are running before shutdown');

    await daemon.shutdown('test');

    // The assertion that distinguishes a correct kill from the bug. A positive-pid signal
    // leaves the grandchild alive here and every other assertion in this test still passes.
    assert.equal(alive(grandchild), false, 'the GRANDCHILD outlived the daemon (T29 / D-09)');
    assert.equal(alive(leader), false, 'the agent process outlived the daemon');
  } finally {
    await daemon.shutdown('cleanup');
    await workspace.remove();
  }
});

test('shutdown order: children are dead before the tunnel closes, and the store closes last', async () => {
  const workspace = await makeWorkspace(SECRET);
  await makeScratchRepo(workspace.dir);
  const issue = smokeIssue({ assigneeId: BOT_USER_ID });
  const linear = new RecordingLinear({ issues: [issue] });
  const seen: SpawnRecord = {};
  const order: string[] = [];

  // The tunnel records WHEN it was asked to close, and what was true at that moment.
  const inner = probingTunnel();
  const tunnel = {
    open: (port: number) => inner.open(port),
    url: () => inner.url(),
    close: async () => {
      order.push(seen.leader !== undefined && alive(seen.leader) ? 'tunnel:children-alive' : 'tunnel:children-dead');
      await inner.close();
    },
  };

  const daemon = await bootDaemon({
    configDir: workspace.dir,
    linear,
    tunnel,
    runCommand: okTools,
    spawn: detachedGrandchildSpawn(seen),
  });

  try {
    await untilTrue(() => seen.leader !== undefined, 'the agent to be spawned');
    await daemon.shutdown('test');

    assert.deepEqual(
      order,
      ['tunnel:children-dead'],
      'the children must be reaped BEFORE the tunnel closes — closing the tunnel while an ' +
        'agent is still writing is how a half-finished push becomes a stuck ticket',
    );

    // The store closes LAST, which is provable from the other side: the in-flight mark
    // (step 6) is a write, and it landed. Had the store closed first it would have thrown.
    const store = reopen(workspace.dir);
    const marked = store
      .listByState('queued', 'preparing', 'running', 'delivering', 'awaiting_answer')
      .filter((r): r is RepoRun => r.kind === 'repo');
    assert.ok(
      marked.some((r) => r.failureReason === SHUTDOWN_NOTE),
      'the in-flight mark must have been written before the store closed',
    );
    store.close();
  } finally {
    await daemon.shutdown('cleanup');
    await workspace.remove();
  }
});

test('a run left `running` at shutdown is requeued, marked, and still in the database', async () => {
  const workspace = await makeWorkspace(SECRET);
  const linear = new RecordingLinear({ issues: [smokeIssue({ assigneeId: null })] });

  const daemon = await bootDaemon({
    configDir: workspace.dir,
    linear,
    tunnel: probingTunnel(),
    runCommand: okTools,
    agent: new ScriptedAgent({ status: 'failed', summary: '', failureReason: 'not driven' }),
  });
  daemon.scheduler.pause();

  const run = seedRun(daemon.store, 'queued', workspace.dir);
  await daemon.engine.transition(run.id, 'preparing', 'test');
  await daemon.engine.transition(run.id, 'running', 'test');

  await daemon.shutdown('test');

  const store = reopen(workspace.dir);
  const after = store.getRun(run.id);
  assert.ok(after, 'the run must survive the shutdown — a deleted run is a stuck ticket');
  assert.equal(after.kind === 'repo' ? after.state : null, 'queued', '07-CONTEXT D-06');
  assert.equal(
    after.kind === 'repo' ? after.failureReason : null,
    SHUTDOWN_NOTE,
    'the run must say WHY it went back to the queue',
  );
  // The audit row, not just the column: `run_events` is what an operator reads afterwards.
  assert.ok(
    hasTransition(eventsOf(store, run.id), 'running', 'queued'),
    'the requeue must be recorded as a transition',
  );
  store.close();
  await workspace.remove();
});

test('a run left `delivering` at shutdown is NOT requeued — its push status is unknowable', async () => {
  const workspace = await makeWorkspace(SECRET);
  const linear = new RecordingLinear({ issues: [smokeIssue({ assigneeId: null })] });

  const daemon = await bootDaemon({
    configDir: workspace.dir,
    linear,
    tunnel: probingTunnel(),
    runCommand: okTools,
  });
  daemon.scheduler.pause();

  const run = seedRun(daemon.store, 'queued', workspace.dir);
  await daemon.engine.transition(run.id, 'preparing', 'test');
  await daemon.engine.transition(run.id, 'running', 'test');
  await daemon.engine.transition(run.id, 'delivering', 'test');

  await daemon.shutdown('test');

  const store = reopen(workspace.dir);
  const after = store.getRun(run.id);
  // T-07-26, accepted deliberately: replaying a run whose branch was already pushed opens
  // a SECOND pull request for work that already shipped. The cost of not replaying is one
  // manual restart; the cost of replaying is a duplicate PR nobody asked for.
  assert.equal(after?.kind === 'repo' ? after.state : null, 'delivering');
  assert.equal(after?.kind === 'repo' ? after.failureReason : null, SHUTDOWN_NOTE);
  store.close();
  await workspace.remove();
});

test('restart recovery is PER-STATE (06-CONTEXT D-07)', async () => {
  const workspace = await makeWorkspace(SECRET);
  const dir = workspace.dir;

  // Seed the database exactly as a previous process would have left it, then boot on top.
  const seedStore = reopen(dir);
  const queued = seedRun(seedStore, 'queued', dir);
  const preparing = seedRun(seedStore, 'preparing', dir);
  const running = seedRun(seedStore, 'running', dir);
  const delivering = seedRun(seedStore, 'delivering', dir);
  const parked = seedRun(seedStore, 'awaiting_answer', dir);
  const deadline = Date.now() + 4 * 60 * 60_000;
  const question: PendingQuestion = {
    id: randomUUID(),
    runId: parked.id,
    text: 'which database?',
    assumption: 'postgres',
    linearCommentId: 'comment-parent-1',
    askedAt: Date.now(),
    deadlineAt: deadline,
    status: 'open',
    answer: null,
    answeredBy: null,
  };
  seedStore.insertQuestion(question);
  seedStore.close();

  const linear = new RecordingLinear({ issues: [smokeIssue({ assigneeId: null })] });
  const daemon = await bootDaemon({
    configDir: dir,
    linear,
    tunnel: probingTunnel(),
    runCommand: okTools,
    // Requeued runs are claimed the moment boot starts the scheduler. This keeps that from
    // spawning anything; the assertions below read `run_events`, which cannot be overtaken.
    agent: new ScriptedAgent({ status: 'failed', summary: '', failureReason: 'not driven' }),
    deliverer: new FakeDeliverer(),
  });

  const store = daemon.store;

  // queued: nothing was spent and nothing is wrong. No recovery transition at all.
  assert.equal(
    eventsOf(store, queued.id).some((e) => e.detail?.startsWith('recovered from')),
    false,
    'a queued run needs no recovery',
  );
  // preparing: requeue. No agent had been spawned, so there is nothing to be unsure about.
  assert.ok(
    hasTransition(eventsOf(store, preparing.id), 'preparing', 'queued'),
    'a `preparing` run is requeued',
  );
  // running / delivering: FAIL with a diagnosis. Surviving to boot in these states means
  // an UNCLEAN exit, because a clean stop would have requeued or marked them first — and
  // after a crash the worktree contents and the push status are both unknowable.
  for (const [name, run] of [['running', running], ['delivering', delivering]] as const) {
    const after = store.getRun(run.id);
    assert.equal(after?.kind === 'repo' ? after.state : null, 'failed', `a \`${name}\` run fails`);
    assert.match(
      (after?.kind === 'repo' ? after.failureReason : null) ?? '',
      /daemon restarted/,
      `a \`${name}\` run carries an operator-facing diagnosis, not silence`,
    );
  }
  // T50 / R24: the diagnosis reaches the TICKET, not only the database. Before 07-05 a
  // recovered run posted nothing and the operator saw a ticket stuck In Progress with no
  // explanation on it — the exact silence 06-CONTEXT D-08 exists to forbid.
  assert.ok(
    linear.comments.length >= 2,
    'each recovered failure announces itself on the ticket (T50)',
  );

  // awaiting_answer: untouched. Its deadline is a COLUMN, so there is no timer to re-arm,
  // and re-arming something that was never disarmed is the mistake here.
  const parkedAfter = store.getRun(parked.id);
  assert.equal(parkedAfter?.kind === 'repo' ? parkedAfter.state : null, 'awaiting_answer');
  assert.equal(store.getQuestion(question.id)?.deadlineAt, deadline, 'the deadline is intact');
  assert.equal(store.getQuestion(question.id)?.status, 'open');

  await daemon.shutdown('test');
  await workspace.remove();
});

test('OPS-01: after a boot sweep no run is left non-terminal and unowned', async () => {
  const workspace = await makeWorkspace(SECRET);
  const dir = workspace.dir;

  const seedStore = reopen(dir);
  for (const state of ['queued', 'preparing', 'running', 'delivering'] as RunState[]) {
    seedRun(seedStore, state, dir);
  }
  seedStore.close();

  const linear = new RecordingLinear({ issues: [smokeIssue({ assigneeId: null })] });
  const daemon = await bootDaemon({
    configDir: dir,
    linear,
    tunnel: probingTunnel(),
    runCommand: okTools,
    agent: new ScriptedAgent({ status: 'failed', summary: '', failureReason: 'not driven' }),
    deliverer: new FakeDeliverer(),
  });
  await daemon.shutdown('test');

  const store = reopen(dir);
  const all: Run[] = store.listByState(
    'queued',
    'preparing',
    'running',
    'awaiting_answer',
    'delivering',
    'delivered',
    'partial',
    'failed',
    'cancelled',
  );
  for (const run of all) {
    if (run.kind !== 'repo') continue;
    // Every run is either finished, or waiting in a state the next boot knows how to
    // resume from. Nothing is parked in a state that holds a slot with no process behind
    // it — that combination IS the zombie: a stuck In Progress ticket and a slot the cap
    // will never get back.
    assert.ok(
      isTerminal(run.state) || run.state === 'queued' || run.state === 'awaiting_answer',
      `run ${run.id} is stranded in ${run.state}`,
    );
  }
  store.close();
  await workspace.remove();
});

test('a parked question survives a full stop and restart, and a later threaded reply resumes it', async () => {
  const workspace = await makeWorkspace(SECRET);
  const dir = workspace.dir;
  await makeScratchRepo(dir);

  // ── process one: park a run on an open question, then stop the daemon ──────
  const seedStore = reopen(dir);
  const parked = seedRun(seedStore, 'awaiting_answer', dir, { worktreePath: `${dir}/wt`, sessionId: randomUUID() });
  const parentCommentId = 'comment-parent-42';
  const question: PendingQuestion = {
    id: randomUUID(),
    runId: parked.id,
    text: 'which database?',
    assumption: 'postgres',
    linearCommentId: parentCommentId,
    askedAt: Date.now(),
    deadlineAt: Date.now() + 4 * 60 * 60_000,
    status: 'open',
    answer: null,
    answeredBy: null,
  };
  seedStore.insertQuestion(question);
  seedStore.close();

  // ── process two: boot on the same directory ───────────────────────────────
  const linear = new ReplyingLinear({ issues: [smokeIssue({ assigneeId: null })] });
  const agent = new ScriptedAgent({
    status: 'complete',
    summary: 'resumed and finished',
    prTitle: 'SMK-1',
    prBody: 'body',
  });
  const daemon = await bootDaemon({
    configDir: dir,
    linear,
    tunnel: probingTunnel(),
    runCommand: okTools,
    agent,
    deliverer: new FakeDeliverer(),
  });

  try {
    // It survived the restart untouched — no re-arm, no requeue, no expiry.
    assert.equal(daemon.store.getQuestion(question.id)?.status, 'open');
    const before = daemon.store.getRun(parked.id);
    assert.equal(before?.kind === 'repo' ? before.state : null, 'awaiting_answer');

    // The human replies in the thread, AFTER the restart. Correlation is by the parent
    // comment id stored in SQLite — the only tier that works when two questions are open,
    // and the tier a single-question ticket would let rot as dead code (T43).
    const reply: LinearComment = {
      id: 'comment-reply-99',
      parentId: parentCommentId,
      body: 'use sqlite',
      authorId: 'human-user-id',
      authorName: 'A Human',
      createdAt: new Date().toISOString(),
    };
    linear.replies.push(reply);

    const toEngineEvent = createIngressMapper({ store: daemon.store, linear });
    const event = await toEngineEvent({
      kind: 'comment.created',
      issueId: ISSUE_ID,
      commentId: reply.id,
      parentId: parentCommentId,
    });
    assert.equal(event.kind, 'question.answered', 'the reply correlated to the stored question');
    await daemon.engine.handle(event);
    await daemon.engine.settle();

    const q = daemon.store.getQuestion(question.id);
    assert.equal(q?.status, 'answered', 'the question is closed by the reply, not by a timeout');
    assert.equal(q?.answer, 'use sqlite');
    const after = daemon.store.getRun(parked.id);
    assert.notEqual(
      after?.kind === 'repo' ? after.state : null,
      'awaiting_answer',
      'the run resumed rather than staying parked — ROADMAP success criterion 5, offline',
    );
    assert.equal(agent.calls.length, 1, 'the resume spawned exactly one agent session');
  } finally {
    await daemon.shutdown('cleanup');
    await workspace.remove();
  }
});

test('shutdown is idempotent: called twice it resolves twice and signals the group once', async () => {
  const workspace = await makeWorkspace(SECRET);
  await makeScratchRepo(workspace.dir);
  const issue = smokeIssue({ assigneeId: BOT_USER_ID });
  const linear = new RecordingLinear({ issues: [issue] });
  const seen: SpawnRecord = {};

  const daemon: DaemonHandle = await bootDaemon({
    configDir: workspace.dir,
    linear,
    tunnel: probingTunnel(),
    runCommand: okTools,
    spawn: detachedGrandchildSpawn(seen),
  });

  await untilTrue(() => seen.leader !== undefined, 'the agent to be spawned');

  // The two calls return the SAME promise. That is the proof that the second call cannot
  // re-signal: there is no second escalation to run, because there is no second shutdown.
  // It matters because a pid is a reusable integer — by the time a duplicate signal went
  // out, `-pid` could name a process group the operator started in the meantime.
  const first = daemon.shutdown('one');
  const second = daemon.shutdown('two');
  assert.equal(first, second, 'a concurrent second shutdown must await the first, not start one');
  await first;
  await second;

  // And a third, long after the first has finished, is still a no-op.
  await daemon.shutdown('three');

  assert.equal(alive(seen.leader!), false, 'the group is dead');
  if (seen.grandchild !== undefined) {
    assert.equal(alive(seen.grandchild), false, 'the grandchild is dead');
  }
  await workspace.remove();
});
