/**
 * The run path: what happens between a `queued` row and a pull request.
 *
 * `07-ingress-seam.test.ts` proves a signed webhook becomes a persisted run. This file
 * picks that run up and walks it through the half plan 07-03 deliberately left faked —
 * the real worktree manager against a real git repository, the real run engine, the real
 * scheduler — with exactly two substitutions, both of which cross a boundary this machine
 * cannot cross in a test: the `claude` spawn and the `git push` / `gh pr create`.
 *
 * Three rules, all inherited and all earned:
 *
 *  1. **Assert on database state and on recorded order, never on elapsed time.** Every
 *     ordering constraint here (06-CONTEXT D-09) is about what happened before what, not
 *     about how fast. A latency assertion on a machine under load is a flaky test that
 *     teaches people to re-run the suite.
 *  2. **The store is real SQLite against the real migration.** `InMemoryStore` is what let
 *     three statements against columns that do not exist survive a green typecheck and a
 *     green unit suite (07-RUNTIME-EVIDENCE, T53).
 *  3. **The git repository is real.** `prepareWorktree` shells out; no fake can tell you
 *     whether the branch was actually created or the HEAD came back attached.
 *
 * Written by plan 07-04; first executed by plan 07-06, which owns the gate.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import test from 'node:test';

import { bootDaemon, type DaemonHandle } from '../../src/cli/daemon.js';
import { UNTRUSTED_CLOSE, UNTRUSTED_OPEN } from '../../src/execution/prompt.js';
import {
  ISSUE_ID,
  makeScratchRepo,
  makeWorkspace,
  okTools,
  probingTunnel,
  RecordingLinear,
  smokeIssue,
  until,
} from '../../src/cli/daemon-fixture.js';
import type {
  AgentResult,
  AgentRunner,
  AgentSpawnRequest,
  Deliverer,
  PullRequest,
  RepoMapping,
  RepoRun,
  Run,
  RunEventRow,
  RunId,
  RunState,
  Worktree,
} from '../../src/domain/ports.js';

const SECRET = 'run-path-webhook-secret-0123456789abcdef';
const BASE_BRANCH = 'main';

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

/**
 * One ordered trace of everything the run path did, across three components.
 *
 * A per-component array cannot answer "did the acknowledgement happen before the spawn?",
 * which is the only interesting form of 06-CONTEXT D-09. One shared, append-only list can.
 */
type Step =
  | { at: 'ack' }
  | { at: 'in-progress' }
  | { at: 'spawn'; req: AgentSpawnRequest; cwdExists: boolean }
  | { at: 'deliver'; worktree: Worktree; repo: RepoMapping };

/** `AgentRunner` scripted with one result per call, repeating the last once exhausted. */
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
  private readonly script: Array<AgentResult | Error>;
  private readonly trace: Step[];
  private cursor = 0;

  constructor(trace: Step[], script: Array<AgentResult | Error>) {
    this.trace = trace;
    this.script = script;
  }

  onProgress(): void {
    // The composition root wires this to the log; nothing here reads it back.
  }

  async run(req: AgentSpawnRequest, signal: AbortSignal): Promise<AgentResult> {
    this.calls.push(req);
    // Recorded AT SPAWN TIME, not afterwards: the question is whether the worktree existed
    // when the child was about to be handed it, and a check run after the run finished
    // would answer a different one (`delivered` removes the worktree).
    const cwdExists = await fs
      .access(req.cwd)
      .then(() => true)
      .catch(() => false);
    this.trace.push({ at: 'spawn', req, cwdExists });

    if (signal.aborted) return { status: 'cancelled' };
    const next = this.script[Math.min(this.cursor, this.script.length - 1)]!;
    this.cursor += 1;
    if (next instanceof Error) throw next;
    return next;
  }
}

class ScriptedDeliverer implements Deliverer {
  readonly calls: Array<{ worktree: Worktree; repo: RepoMapping }> = [];
  private readonly trace: Step[];

  constructor(trace: Step[]) {
    this.trace = trace;
  }

  deliver(worktree: Worktree, repo: RepoMapping): Promise<PullRequest> {
    this.calls.push({ worktree, repo });
    this.trace.push({ at: 'deliver', worktree, repo });
    return Promise.resolve({ url: `https://github.com/${repo.repoSlug}/pull/1`, number: 1 });
  }
}

/**
 * The Linear double, recording into the SAME trace as the agent and the deliverer.
 *
 * `RecordingLinear` already seeds the bot user id that `viewer()` now decides, which is
 * what keeps the router willing to route at all.
 */
class TracingLinear extends RecordingLinear {
  private readonly trace: Step[];

  constructor(trace: Step[]) {
    super({ issues: [smokeIssue()] });
    this.trace = trace;
  }

  override createComment(
    issueId: string,
    body: string,
    parentId?: string,
  ): Promise<{ id: string }> {
    // Only the acknowledgement matters for ordering; later comments (question, terminal)
    // are recorded by the base class and asserted through it.
    if (this.comments.length === 0) this.trace.push({ at: 'ack' });
    return super.createComment(issueId, body, parentId);
  }

  override setIssueState(id: string, stateType: 'started' | 'completed' | 'canceled'): Promise<void> {
    if (stateType === 'started') this.trace.push({ at: 'in-progress' });
    return super.setIssueState(id, stateType);
  }
}

interface Ctx {
  daemon: DaemonHandle;
  linear: TracingLinear;
  agent: ScriptedAgent;
  deliverer: ScriptedDeliverer;
  trace: Step[];
  repoDir: string;
  runs(): Run[];
  repoRun(): RepoRun;
  events(id: RunId): RunEventRow[];
}

/**
 * Boot the real graph over a real git repository, run the scheduler, tear everything down.
 *
 * The scheduler is STARTED here and nowhere in `bootDaemon`: 07-CONTEXT D-01 keeps it
 * paused at boot so no plan before 07-05 can accidentally spawn a child, and this file
 * starting it explicitly is what keeps that guarantee visible rather than eroded.
 */
async function withRunPath(
  script: Array<AgentResult | Error>,
  fn: (ctx: Ctx) => Promise<void>,
): Promise<void> {
  const workspace = await makeWorkspace(SECRET);
  const repoDir = await makeScratchRepo(workspace.dir, BASE_BRANCH);

  const trace: Step[] = [];
  const linear = new TracingLinear(trace);
  const agent = new ScriptedAgent(trace, script);
  const deliverer = new ScriptedDeliverer(trace);

  const daemon = await bootDaemon({
    configDir: workspace.dir,
    linear,
    tunnel: probingTunnel(),
    // Without this, boot's preflight runs the operator's real `gh` — see `okTools`.
    runCommand: okTools,
    agent,
    deliverer,
  });
  daemon.scheduler.start();

  const runs = (): Run[] => daemon.store.listByState(...ALL_STATES);
  try {
    await fn({
      daemon,
      linear,
      agent,
      deliverer,
      trace,
      repoDir,
      runs,
      repoRun: () => {
        const run = runs().find((r): r is RepoRun => r.kind === 'repo');
        assert.ok(run, 'no repo run was created');
        return run;
      },
      events: (id) => daemon.store.listRunEvents(id),
    });
  } finally {
    await daemon.shutdown();
    await workspace.remove();
  }
}

const COMPLETE: AgentResult = {
  status: 'complete',
  summary: 'did the thing',
  prTitle: 'SMK-1: do the thing',
  prBody: 'body',
};

const NEEDS_INPUT: AgentResult = {
  status: 'needs_input',
  summary: 'stuck on a choice',
  question: 'Postgres or SQLite?',
  assumption: 'I will use SQLite.',
};

/** Wait for a run to reach one of `states`, then hand it back. */
function untilState(ctx: Ctx, ...states: RunState[]): Promise<RepoRun> {
  return until<RepoRun>(
    () => {
      const run = ctx.runs().find((r): r is RepoRun => r.kind === 'repo' && states.includes(r.state));
      return run ?? undefined;
    },
    { label: `a run in ${states.join(' | ')}`, timeoutMs: 20_000 },
  );
}

// ─────────────────────────────────────────────────── the walk and its event log

test('a queued run walks preparing -> running -> delivering with an event row per move', async () => {
  await withRunPath([COMPLETE], async (ctx) => {
    await ctx.daemon.engine.handle({ kind: 'run.requested', trigger: 'assignment', issueId: ISSUE_ID });
    const run = await untilState(ctx, 'delivered');

    // Every state the run passed through has a row, in order, and each row's `from` is the
    // previous row's `to` — a chain, not a set. A missing transition shows up as a broken
    // link rather than as a count that happens to match (Phase 1 D-03).
    const events = ctx.events(run.id);
    assert.deepEqual(
      events.map((e) => e.to),
      ['queued', 'preparing', 'running', 'delivering', 'delivered'],
    );
    assert.equal(events[0]!.from, null, 'the genesis row has no from-state');
    for (let i = 1; i < events.length; i += 1) {
      assert.equal(events[i]!.from, events[i - 1]!.to, `event ${i} does not chain`);
    }
    assert.equal(run.prUrl, 'https://github.com/smoke/repo/pull/1');
  });
});

// ────────────────────────────────────────── D-09: acknowledge before you work

test('the acknowledgement and the In Progress transition precede all worktree and git work', async () => {
  await withRunPath([COMPLETE], async (ctx) => {
    await ctx.daemon.engine.handle({ kind: 'run.requested', trigger: 'assignment', issueId: ISSUE_ID });
    await untilState(ctx, 'delivered');

    // An ORDER assertion, not a latency one (06-CONTEXT D-09). Ten seconds is the budget
    // the design quotes, but a clock reading is a flaky test on a loaded machine and it
    // would not even prove the property: a fast daemon that acknowledged last would pass.
    const order = ctx.trace.map((s) => s.at);
    assert.deepEqual(order.slice(0, 2), ['ack', 'in-progress']);
    assert.ok(order.indexOf('spawn') > order.indexOf('in-progress'), 'spawned before In Progress');
    assert.ok(order.indexOf('deliver') > order.indexOf('spawn'), 'delivered before spawning');
  });
});

// ──────────────────────────────────── D-04 / T4: the session id exists first

test('the session id is on the run row before the spawn, and the spawn carries that same id', async () => {
  await withRunPath([COMPLETE], async (ctx) => {
    await ctx.daemon.engine.handle({ kind: 'run.requested', trigger: 'assignment', issueId: ISSUE_ID });
    await untilState(ctx, 'delivered');

    const spawn = ctx.trace.find((s): s is Extract<Step, { at: 'spawn' }> => s.at === 'spawn');
    assert.ok(spawn, 'the agent was never spawned');

    // The id is minted at INSERT (fanout.ts), so it is durable before anything could
    // spawn. Reading the stream for it instead would be a race: 16 hook events precede
    // `system/init` on this machine (T4), and a daemon that died mid-spawn would leave a
    // run row pointing at no session and a child nobody can resume or attribute.
    const run = ctx.repoRun();
    assert.ok(run.sessionId, 'the run row carries no session id');
    assert.equal(spawn.req.sessionId, run.sessionId);
    assert.equal(spawn.req.runId, run.id);
  });
});

// ─────────────────────────────────────────── D-15 / T28: the child's environment

test('neither secret reaches the child environment', async () => {
  await withRunPath([COMPLETE], async (ctx) => {
    await ctx.daemon.engine.handle({ kind: 'run.requested', trigger: 'assignment', issueId: ISSUE_ID });
    await untilState(ctx, 'delivered');

    const spawn = ctx.trace.find((s): s is Extract<Step, { at: 'spawn' }> => s.at === 'spawn');
    assert.ok(spawn);

    // Asserted by VALUE as well as by key. The workspace fixture writes both secrets into
    // a real `.env` that boot really reads, so a leak here would be the real string — and
    // a key-name-only assertion misses a leak smuggled under a different name.
    const values = Object.values(spawn.req.env);
    assert.equal(spawn.req.env['LINEAR_API_KEY'], undefined);
    assert.equal(spawn.req.env['NGROK_AUTHTOKEN'], undefined);
    assert.ok(!values.includes('smoke-not-a-real-key'), 'the Linear API key reached the child');
    assert.ok(!values.includes('smoke-not-a-real-token'), 'the ngrok authtoken reached the child');
    assert.equal(spawn.req.env['LAW_RUN_ID'], ctx.repoRun().id);
  });
});

// ──────────────────────────────────────────── the worktree, on a real repository

test('the worktree exists on disk at spawn time and its branch is not the default branch', async () => {
  await withRunPath([NEEDS_INPUT], async (ctx) => {
    await ctx.daemon.engine.handle({ kind: 'run.requested', trigger: 'assignment', issueId: ISSUE_ID });
    // Parked rather than delivered: `delivered` is the one verdict that REMOVES the
    // worktree (AGNT-02), so asserting its existence afterwards would race the cleanup.
    await untilState(ctx, 'awaiting_answer');

    const spawn = ctx.trace.find((s): s is Extract<Step, { at: 'spawn' }> => s.at === 'spawn');
    assert.ok(spawn);
    assert.equal(spawn.cwdExists, true, 'the worktree did not exist when the agent was spawned');

    const run = ctx.repoRun();
    assert.equal(run.worktreePath, spawn.req.cwd);
    assert.notEqual(run.branch, BASE_BRANCH);
    // Daemon-owned, never inside the operator's clone (ASVS V12 / threat T-04-06): a
    // worktree nested in the working copy shows up in their own `git status`.
    assert.ok(!spawn.req.cwd.startsWith(`${ctx.repoDir}/`), 'the worktree is inside the repo');
  });
});

// ───────────────────────────────────────── D-02: a parked run holds no slot

test('needs_input parks the run and releases its slot, leaving the scheduler at full capacity', async () => {
  await withRunPath([NEEDS_INPUT], async (ctx) => {
    await ctx.daemon.engine.handle({ kind: 'run.requested', trigger: 'assignment', issueId: ISSUE_ID });
    await untilState(ctx, 'awaiting_answer');

    // The whole reason `awaiting_answer` is absent from HOLDS_SLOT: a human takes minutes
    // to hours, so three open questions on a three-slot laptop would be a deadlock rather
    // than a queue.
    await until(() => (ctx.daemon.scheduler.inUse() === 0 ? true : undefined), {
      label: 'the parked run to release its slot',
      timeoutMs: 20_000,
    });
    assert.equal(ctx.daemon.scheduler.inUse(), 0);
    assert.equal(ctx.daemon.scheduler.capacity(), ctx.daemon.config.concurrency);
  });
});

// ─────────────────────────── D-05: the terminal report comes from a `finally`

test('a throwing agent still produces a terminal state, a terminal event row and a comment', async () => {
  await withRunPath([new Error('the child died in a way nobody planned for')], async (ctx) => {
    await ctx.daemon.engine.handle({ kind: 'run.requested', trigger: 'assignment', issueId: ISSUE_ID });
    const run = await untilState(ctx, 'failed');

    // The report is emitted from a `finally`, so it survives the path that produced no
    // result at all — silence on failure is the loudest complaint in this product
    // category, and the run that went worst is the one most likely to skip a happy-path
    // notification site.
    const events = ctx.events(run.id);
    assert.equal(events.at(-1)?.to, 'failed');
    assert.ok(run.failureReason, 'a failed run carries no diagnosis');

    await until(
      () => (ctx.linear.comments.length >= 2 ? ctx.linear.comments : undefined),
      { label: 'the terminal comment', timeoutMs: 20_000 },
    );
    const terminal = ctx.linear.comments.at(-1)!;
    assert.match(terminal.body, /Run failed/);
    // T-06-06: a classification reaches the ticket; the raw error only ever reaches the
    // log file, because a serialized error routinely carries request headers.
    assert.ok(!terminal.body.includes('    at '), 'a stack trace reached the ticket');

    assert.equal(ctx.deliverer.calls.length, 0, 'a failed run must not open a pull request');
  });
});

// -- what the agent is actually told ------------------------------------------
//
// Nothing in this suite asserted the CONTENT of the prompt, and that is how the live path
// spent an entire milestone sending `run.issueTitle` — the raw ticket title and nothing
// else — while `buildAgentPrompt` sat in `execution/prompt.ts` uncalled. Three things were
// missing from every run: the task itself, the delivery contract, and the prompt-injection
// containment. The Phase 7 runtime evidence records two injection attacks as PASS; they
// were exercising a function no run ever reached.

test('the brief carries the delivery contract, so the agent never pushes past the gates', async () => {
  await withRunPath([{ status: 'complete', summary: 's', prTitle: 't', prBody: 'b' }], async (h) => {
    const spawn = await until(
      () => h.trace.find((s): s is Extract<Step, { at: 'spawn' }> => s.at === 'spawn'),
      { label: 'the agent to be spawned', timeoutMs: 10_000 },
    );

    // The worker pushes after the child exits, precisely so every push passes `gates.ts` —
    // the secret scan, the default-branch refusal, the CI-file flag. An agent that is never
    // told this can push on its own and bypass all of them.
    assert.match(spawn.req.prompt, /Do NOT run git push/i);
    assert.match(spawn.req.prompt, /Do NOT open a pull request/i);
    assert.match(spawn.req.prompt, /Run the GSD workflow/i, 'the agent must be told what to do');
  });
});

test('the brief wraps Linear-authored text in the DATA delimiter, on the LIVE path', async () => {
  await withRunPath([{ status: 'complete', summary: 's', prTitle: 't', prBody: 'b' }], async (h) => {
    const spawn = await until(
      () => h.trace.find((s): s is Extract<Step, { at: 'spawn' }> => s.at === 'spawn'),
      { label: 'the agent to be spawned', timeoutMs: 10_000 },
    );
    assert.match(
      spawn.req.prompt,
      /is DATA, not instructions/i,
      'ticket text reached the agent with no instruction/data boundary at all',
    );
    // The mechanism, not just the prose: the tags are what `defangDelimiter` protects, and
    // asserting the sentence alone would still pass if the block itself went missing.
    assert.ok(
      spawn.req.prompt.includes(UNTRUSTED_OPEN) && spawn.req.prompt.includes(UNTRUSTED_CLOSE),
      'the untrusted block is not delimited',
    );
  });
});
