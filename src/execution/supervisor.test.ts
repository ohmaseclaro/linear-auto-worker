/**
 * The escalation is a state machine, and this file drives it against injected fakes.
 *
 * There is no real child process anywhere on purpose. Testing a kill against a real
 * process tree is slow, flaky, and — worst — passes for the wrong reason: a positive-pid
 * signal reaps a childless `sleep` just fine, so the exact bug this file exists to catch
 * is the one a real-process test cannot see. What IS asserted here:
 *
 *  - the SIGN of the pid on every single signal (T29, D-09). A positive pid orphans the
 *    agent's own Bash subtree and is invisible without this assertion;
 *  - that liveness is CHECKED between steps rather than assumed — SIGINT was measured to
 *    kill only the group leader, so both the "keep going" and the "stop early" branches
 *    are real behaviour, not defensive padding;
 *  - that the handle's own kill method is never invoked (T29: it orphans the grandchild
 *    and leaves the promise permanently pending);
 *  - that `runAgent` RESOLVES even though the fake child's promise never settles. That is
 *    Pitfall 3 written as a test instead of a comment.
 *
 * RUSH MODE: written, not run. No `node --test` on this branch.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgent, SIGINT_GRACE_MS, SIGTERM_GRACE_MS } from './supervisor.js';
import type { AgentSubprocess, EscalationStep } from './supervisor.js';
import type { Logger } from '../infra/logger.js';

const PID = 4242;

const GOOD_INIT = {
  type: 'system',
  subtype: 'init',
  cwd: '/tmp/wt',
  permissionMode: 'dontAsk',
  skills: ['gsd-execute-phase', 'gsd-plan-phase', 'gsd-verify-work'],
};

const RESULT_EVENT = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  session_id: 'sess-1',
  structured_output: { status: 'delivered', summary: 'done' },
  stop_reason: 'tool_use',
  terminal_reason: 'completed',
  num_turns: 3,
  total_cost_usd: 0.24,
  permission_denials: [],
};

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

interface Channel {
  push(text: string): Promise<void>;
  end(): Promise<void>;
  stream: AsyncIterable<string>;
}

/** A push-driven async iterable: the test decides exactly when a chunk lands. */
function channel(): Channel {
  const queue: string[] = [];
  let closed = false;
  let wake: () => void = () => undefined;

  const stream = (async function* () {
    for (;;) {
      while (queue.length > 0) yield queue.shift() as string;
      if (closed) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  })();

  return {
    async push(text: string): Promise<void> {
      queue.push(text);
      wake();
      await tick();
    },
    async end(): Promise<void> {
      closed = true;
      wake();
      await tick();
    },
    stream,
  };
}

interface FakeChild {
  handle: AgentSubprocess;
  /** T29: this must stay at zero forever. */
  handleKillCalls: number;
}

/**
 * @param settle `undefined` reproduces the measured Pitfall-3 shape: a surviving
 * grandchild holds the stdout pipe, so the promise NEVER settles.
 */
function fakeChild(o: {
  out: Channel;
  err: Channel;
  settle?: { exitCode: number };
  pid?: number;
}): FakeChild {
  const state = { handleKillCalls: 0 };
  const handle = {
    pid: o.pid ?? PID,
    stdout: o.out.stream,
    stderr: o.err.stream,
    // Present because the REAL execa handle has it. Its call count is the assertion.
    kill(): boolean {
      state.handleKillCalls += 1;
      return true;
    },
    then(onFulfilled?: (v: { exitCode?: number }) => unknown): unknown {
      if (o.settle) setImmediate(() => onFulfilled?.({ exitCode: o.settle?.exitCode }));
      return undefined;
    },
  };
  return {
    handle: handle as unknown as AgentSubprocess,
    get handleKillCalls(): number {
      return state.handleKillCalls;
    },
  };
}

interface Harness {
  kills: Array<{ pid: number; signal: string }>;
  sleeps: number[];
  stderrSeen: string[];
}

function harness(): Harness {
  return { kills: [], sleeps: [], stderrSeen: [] };
}

function logger(h: Harness): Logger {
  const log: Logger = {
    child: () => log,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: (obj: unknown) => {
      const rec = obj as { stderr?: string };
      if (typeof rec?.stderr === 'string') h.stderrSeen.push(rec.stderr);
    },
  };
  return log;
}

function ndjson(...events: unknown[]): string {
  return events.map((e) => JSON.stringify(e)).join('\n') + '\n';
}

// ── AGNT-08 / T29: the escalation ladder ────────────────────────────────────────

test('a timed-out run signals SIGINT, SIGTERM then SIGKILL to the NEGATIVE pid', async () => {
  const h = harness();
  const out = channel();
  const err = channel();
  const child = fakeChild({ out, err }); // never settles — Pitfall 3
  const cwd = mkdtempSync(join(tmpdir(), 'law-supervisor-'));

  const outcome = await runAgent({
    cwd,
    args: ['-p', 'x'],
    env: {},
    sessionId: 'sess-1',
    maxRunMs: 1,
    log: logger(h),
    spawn: () => child.handle,
    kill: (pid, signal) => h.kills.push({ pid, signal }),
    // The measured T29 case: the group leader dies, the grandchild does not.
    isAlive: () => true,
    sleep: async (ms) => {
      h.sleeps.push(ms);
    },
  });

  assert.deepEqual(
    h.kills.map((k) => k.signal),
    ['SIGINT', 'SIGTERM', 'SIGKILL']
  );
  // THE assertion. A signal to +pid reaps the leader and orphans the agent's own Bash
  // subtree, and every other assertion in this file still passes when it does.
  for (const call of h.kills) {
    assert.equal(call.pid, -PID, 'every signal must go to the negative pid');
    assert.ok(call.pid < 0, 'a positive pid is not a group kill');
  }
  assert.deepEqual(h.sleeps, [SIGINT_GRACE_MS, SIGTERM_GRACE_MS]);

  assert.equal(outcome.timedOut, true);
  assert.equal(outcome.killedBy, 'SIGKILL' satisfies EscalationStep);

  // T29: never, under any circumstance.
  assert.equal(child.handleKillCalls, 0);

  // AGNT-08: the isolated checkout survives the kill untouched. `runAgent` performs no
  // removal of any kind — it is the only evidence of what the agent actually did.
  assert.equal(existsSync(cwd), true);
});

test('liveness is checked, not assumed: a group gone after SIGINT gets no SIGTERM', async () => {
  const h = harness();
  const out = channel();
  const err = channel();
  const child = fakeChild({ out, err });
  let aliveChecks = 0;

  const outcome = await runAgent({
    cwd: '/tmp/wt',
    args: [],
    env: {},
    sessionId: 'sess-1',
    maxRunMs: 1,
    log: logger(h),
    spawn: () => child.handle,
    kill: (pid, signal) => h.kills.push({ pid, signal }),
    isAlive: () => {
      aliveChecks += 1;
      return false;
    },
    sleep: async (ms) => {
      h.sleeps.push(ms);
    },
  });

  assert.deepEqual(
    h.kills.map((k) => k.signal),
    ['SIGINT']
  );
  assert.equal(h.kills[0]?.pid, -PID);
  assert.equal(aliveChecks, 1, 'liveness is checked exactly once, between step 1 and 2');
  assert.equal(outcome.timedOut, true);
  assert.equal(outcome.killedBy, 'SIGINT');
  assert.equal(child.handleKillCalls, 0);
});

// ── Pitfall 3: completion is a race ─────────────────────────────────────────────

test('runAgent resolves even though the child promise never settles', async () => {
  const h = harness();
  const out = channel();
  const err = channel();
  // Neither stream ever ends and `then` never fires: exactly what three probes measured
  // when a grandchild survived holding the stdout pipe. Awaiting the promise alone here
  // hangs forever, which is a run stuck in `running` at 0% CPU.
  const child = fakeChild({ out, err });

  const outcome = await runAgent({
    cwd: '/tmp/wt',
    args: [],
    env: {},
    sessionId: 'sess-1',
    maxRunMs: 1,
    log: logger(h),
    spawn: () => child.handle,
    kill: (pid, signal) => h.kills.push({ pid, signal }),
    isAlive: () => true,
    sleep: async () => undefined,
  });

  assert.equal(outcome.timedOut, true);
  assert.equal(outcome.exitCode, undefined, 'nothing ever reported an exit status');
});

// ── D-07: both streams drain ────────────────────────────────────────────────────

test('stderr is consumed concurrently with stdout and reaches the log', async () => {
  const h = harness();
  const out = channel();
  const err = channel();
  const child = fakeChild({ out, err, settle: { exitCode: 0 } });

  const running = runAgent({
    cwd: '/tmp/wt',
    args: [],
    env: {},
    sessionId: 'sess-1',
    maxRunMs: 600_000,
    log: logger(h),
    spawn: () => child.handle,
    kill: (pid, signal) => h.kills.push({ pid, signal }),
    isAlive: () => false,
    sleep: async () => undefined,
  });

  // Interleaved on purpose: stderr producing must not stall stdout. Draining only stdout
  // moves the ~64 KB pipe deadlock to stderr rather than removing it.
  await err.push('warning: something\n');
  await out.push(ndjson(GOOD_INIT));
  await err.push('warning: another\n');
  await out.push(ndjson(RESULT_EVENT));
  await err.end();
  await out.end();

  const outcome = await running;

  assert.deepEqual(h.stderrSeen, ['warning: something\n', 'warning: another\n']);
  assert.equal(outcome.resultEvent?.subtype, 'success');
  assert.equal(outcome.exitCode, 0);
});

test('stdout chunks reach the parser in order, including one arriving after the deadline', async () => {
  const h = harness();
  const out = channel();
  const err = channel();
  const child = fakeChild({ out, err }); // never settles

  // Split INSIDE a JSON token, so a chunk arriving out of order or dropped after the
  // deadline cannot produce a parsed event by luck.
  const line = ndjson(RESULT_EVENT);
  const cut = Math.floor(line.length / 2);

  const outcome = await runAgent({
    cwd: '/tmp/wt',
    args: [],
    env: {},
    sessionId: 'sess-1',
    maxRunMs: 1,
    log: logger(h),
    spawn: () => child.handle,
    kill: (pid, signal) => h.kills.push({ pid, signal }),
    isAlive: () => h.kills.length < 2,
    // The window between the first signal and the process actually dying: the child is
    // still writing, and those bytes are still evidence.
    sleep: async (ms) => {
      h.sleeps.push(ms);
      if (h.sleeps.length === 1) {
        await out.push(line.slice(0, cut));
        await out.push(line.slice(cut));
      }
    },
  });

  assert.equal(outcome.timedOut, true);
  assert.equal(outcome.resultEvent?.subtype, 'success', 'the post-deadline chunk was parsed');
  assert.equal(outcome.resultEvent?.num_turns, 3);
  assert.deepEqual(outcome.badLines, []);
});

// ── the happy path cancels the timer ────────────────────────────────────────────

test('a child that exits before the deadline is never signalled', async () => {
  const h = harness();
  const out = channel();
  const err = channel();
  const child = fakeChild({ out, err, settle: { exitCode: 0 } });

  const running = runAgent({
    cwd: '/tmp/wt',
    args: [],
    env: {},
    sessionId: 'sess-1',
    // Long enough that a leaked timer would keep this test process alive well past the
    // suite — the assertion is the absence of both the signal and the hang.
    maxRunMs: 30 * 60_000,
    log: logger(h),
    spawn: () => child.handle,
    kill: (pid, signal) => h.kills.push({ pid, signal }),
    isAlive: () => false,
    sleep: async () => undefined,
  });

  await out.push(ndjson(GOOD_INIT, RESULT_EVENT));
  await out.end();
  await err.end();
  const outcome = await running;

  assert.deepEqual(h.kills, []);
  assert.equal(outcome.timedOut, false);
  assert.equal(outcome.killedBy, undefined);
  assert.equal(child.handleKillCalls, 0);
  assert.equal(outcome.exitCode, 0);
});

// ── D-05: fail fast, not at the deadline ────────────────────────────────────────

test('a system/init assertion reaps immediately and propagates out of runAgent', async () => {
  const h = harness();
  const out = channel();
  const err = channel();
  const child = fakeChild({ out, err }); // never settles

  const running = runAgent({
    cwd: '/tmp/wt',
    args: [],
    env: {},
    sessionId: 'sess-1',
    // If the escalation waited for the deadline instead of firing on the throw, this test
    // would hang for half an hour. That is the point of the number.
    maxRunMs: 30 * 60_000,
    log: logger(h),
    spawn: () => child.handle,
    kill: (pid, signal) => h.kills.push({ pid, signal }),
    isAlive: () => false,
    sleep: async () => undefined,
  });

  // No GSD skills: the session would produce generic, non-GSD work and exit 0.
  await out.push(ndjson({ ...GOOD_INIT, skills: ['other-skill'] }));

  await assert.rejects(running, /GSD skills absent/);
  assert.deepEqual(
    h.kills.map((k) => k.signal),
    ['SIGINT'],
    'the fault is reaped in the first second, not after the run deadline'
  );
  assert.equal(h.kills[0]?.pid, -PID);
  assert.equal(child.handleKillCalls, 0);
});
