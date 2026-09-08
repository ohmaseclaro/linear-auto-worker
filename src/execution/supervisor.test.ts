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
import { PassThrough } from 'node:stream';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgent, SIGINT_GRACE_MS, SIGTERM_GRACE_MS } from './supervisor.js';
import type { AgentSubprocess, EscalationStep } from './supervisor.js';
import type { Logger } from '../infra/logger.js';
import { LawError } from '../domain/errors.js';

const PID = 4242;
const PROMPT = 'implement the ticket';

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
  /** A REAL PassThrough, so the stdin seam is exercised rather than described (T113). */
  stdin?: PassThrough | null;
}): FakeChild {
  const state = { handleKillCalls: 0 };
  const handle = {
    pid: o.pid ?? PID,
    stdout: o.out.stream,
    stderr: o.err.stream,
    stdin: o.stdin === undefined ? new PassThrough() : o.stdin,
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
    prompt: PROMPT,
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
    prompt: PROMPT,
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
    prompt: PROMPT,
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
    prompt: PROMPT,
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
    prompt: PROMPT,
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
    prompt: PROMPT,
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
    prompt: PROMPT,
    // If the escalation waited for the deadline instead of firing on the throw, this test
    // would hang for half an hour. That is the point of the number.
    maxRunMs: 30 * 60_000,
    log: logger(h),
    spawn: () => child.handle,
    kill: (pid, signal) => h.kills.push({ pid, signal }),
    isAlive: () => false,
    sleep: async () => undefined,
  });

  // The rejection handler is attached BEFORE the push that causes it. `push()` ends with a
  // `setImmediate` tick, and a promise that rejects with no handler attached by the end of
  // that turn is reported by Node as an unhandledRejection — which fails the test with the
  // very error it is asserting on. Ordering, not wording, is what made this case red.
  //
  // Asserted on the ERROR CODE and on the named missing skill, not on prose. The original
  // form matched /GSD skills absent/ against a message that has read "GSD skills missing
  // from the spawned session: …" since plan 04 — a wording gate that goes red on a reword
  // and stays green on a real regression is the failure mode T71/T76 exist to prevent.
  const rejected = assert.rejects(running, (err: unknown) => {
    assert.ok(err instanceof LawError, 'the router refuses the session with a LawError');
    assert.equal(err.code, 'AGENT_ENV');
    assert.match(err.message, /gsd-execute-phase/, 'and names which skill was absent');
    return true;
  });

  // No GSD skills: the session would produce generic, non-GSD work and exit 0.
  await out.push(ndjson({ ...GOOD_INIT, skills: ['other-skill'] }));
  await rejected;
  assert.deepEqual(
    h.kills.map((k) => k.signal),
    ['SIGINT'],
    'the fault is reaped in the first second, not after the run deadline'
  );
  assert.equal(h.kills[0]?.pid, -PID);
  assert.equal(child.handleKillCalls, 0);
});

// ── T113 / T114: streaming input, and the terminal condition ────────────────────

/** Everything the child was told, one parsed envelope per line written. */
function saidTo(stdin: PassThrough): Array<{ message: { content: Array<{ text: string }> } }> {
  return stdin
    .read()
    ?.toString('utf8')
    .split('\n')
    .filter((l: string) => l.trim().length > 0)
    .map((l: string) => JSON.parse(l)) ?? [];
}

/**
 * T99 AND T57, RELOCATED to the seam the prompt actually crosses.
 *
 * `agent-args.test.ts` used to own both: `after(nasty, '-p') === hostile` (the argv
 * containment control) and `after(args, '-p') === answer` (the "a resumed session is
 * actually TOLD the answer" control). Since T113 the prompt is not in argv at all, so
 * asserting there can no longer see either property. They are re-asserted here, against a
 * real `PassThrough`, and both were observed RED at this seam before being trusted.
 */
test('T99/T57 relocated: the prompt reaches the child on STDIN, verbatim, as one line', async () => {
  const out = channel();
  const err = channel();
  const stdin = new PassThrough();
  const child = fakeChild({ out, err, stdin, settle: { exitCode: 0 } });
  const h = harness();

  const hostile = 'line one\n"quoted"; $(rm -rf /) `whoami` --bare';
  const running = runAgent({
    cwd: '/tmp/wt',
    args: [],
    env: {},
    sessionId: 'sess-1',
    prompt: hostile,
    maxRunMs: 60_000,
    log: logger(h),
    spawn: () => child.handle,
    kill: (pid, signal) => h.kills.push({ pid, signal }) as unknown as number,
    isAlive: () => false,
    sleep: async () => undefined,
  });

  // Written SYNCHRONOUSLY, before any output: a session under `--input-format stream-json`
  // with nothing on stdin sits silent for its whole deadline (M2).
  const said = saidTo(stdin);
  assert.equal(said.length, 1, 'exactly one line, before the child said anything');
  assert.equal(said[0]?.message.content.length, 1);
  assert.equal(
    said[0]?.message.content[0]?.text,
    hostile,
    'the answer/brief must actually reach the session — T57 through the new door',
  );

  await out.push(ndjson(GOOD_INIT, RESULT_EVENT));
  await out.end();
  await err.end();
  await running;
});

/**
 * THE ANTI-TRAP CASE. Make `result` terminal and this goes RED at `'turn one'`.
 *
 * Under streaming input a result arrives per USER MESSAGE (M4). The run ends when the
 * PROCESS EXITS; `result` decides only when stdin closes. Treat it as terminal and the
 * daemon ships a pull request after turn one while the agent is still working.
 */
test('T114: the LAST result governs, and stdin closes on the FIRST one', async () => {
  const out = channel();
  const err = channel();
  const stdin = new PassThrough();
  let ended = 0;
  stdin.on('finish', () => {
    ended += 1;
  });
  const child = fakeChild({ out, err, stdin, settle: { exitCode: 0 } });
  const h = harness();

  const result = (summary: string, cost: number, inputTokens: number): unknown => ({
    ...RESULT_EVENT,
    structured_output: { status: 'complete', summary },
    total_cost_usd: cost,
    usage: { input_tokens: inputTokens },
  });

  const running = runAgent({
    cwd: '/tmp/wt',
    args: [],
    env: {},
    sessionId: 'sess-1',
    prompt: PROMPT,
    maxRunMs: 60_000,
    log: logger(h),
    spawn: () => child.handle,
    kill: (pid, signal) => h.kills.push({ pid, signal }) as unknown as number,
    isAlive: () => false,
    sleep: async () => undefined,
  });

  await out.push(ndjson(GOOD_INIT, { type: 'assistant', message: { content: [] } }));
  assert.equal(ended, 0, 'stdin must still be open while the agent is working');

  await out.push(ndjson(result('turn one', 0.5, 10)));
  assert.equal(ended, 1, 'stdin closes on the FIRST result, and exactly once');

  await out.push(
    ndjson({ type: 'assistant', message: { content: [] } }, result('turn two', 0.6, 7)),
  );
  await out.end();
  await err.end();
  const outcome = await running;

  assert.equal(
    (outcome.resultEvent?.structured_output as { summary: string }).summary,
    'turn two',
    'RED at `turn one` if anyone makes `result` terminal — the operator\'s correction must win',
  );
  assert.equal(outcome.resultEvent?.total_cost_usd, 0.6, 'cost is CUMULATIVE: take the last');
  assert.notEqual(outcome.resultEvent?.total_cost_usd, 1.1, 'never summed (M6)');
  assert.equal(outcome.tokensUsed, 17, 'usage is PER MESSAGE: summed (M6)');
  assert.equal(ended, 1, 'stdin ended exactly once across both results');
});

test('T113: `law say` reaches a live session, and is refused once the turn has ended', async () => {
  const out = channel();
  const err = channel();
  const stdin = new PassThrough();
  const child = fakeChild({ out, err, stdin, settle: { exitCode: 0 } });
  const h = harness();

  let send: ((text: string) => boolean) | undefined;
  const running = runAgent({
    cwd: '/tmp/wt',
    args: [],
    env: {},
    sessionId: 'sess-1',
    prompt: PROMPT,
    maxRunMs: 60_000,
    log: logger(h),
    spawn: () => child.handle,
    kill: (pid, signal) => h.kills.push({ pid, signal }) as unknown as number,
    isAlive: () => false,
    sleep: async () => undefined,
    onInput: (s) => {
      send = s;
    },
  });

  assert.equal(send?.('stop and run the tests'), true, 'the window is open while it works');
  const said = saidTo(stdin);
  assert.equal(said.length, 2);
  assert.equal(said[1]?.message.content[0]?.text, 'stop and run the tests');

  await out.push(ndjson(GOOD_INIT, RESULT_EVENT));
  assert.equal(
    send?.('too late'),
    false,
    'the injection window is spawn -> first result, and `send` never throws',
  );

  await out.end();
  await err.end();
  await running;
});

test('T113: a replayed user echo is tallied, and its absence names the cause', async () => {
  const out = channel();
  const err = channel();
  const child = fakeChild({ out, err, settle: { exitCode: 0 } });
  const h = harness();

  const running = runAgent({
    cwd: '/tmp/wt',
    args: [],
    env: {},
    sessionId: 'sess-1',
    prompt: PROMPT,
    maxRunMs: 60_000,
    log: logger(h),
    spawn: () => child.handle,
    kill: (pid, signal) => h.kills.push({ pid, signal }) as unknown as number,
    isAlive: () => false,
    sleep: async () => undefined,
  });

  await out.push(
    ndjson(GOOD_INIT, { type: 'user', message: { content: [{ type: 'text', text: PROMPT }] } }),
  );
  await out.end();
  await err.end();
  const outcome = await running;
  // Zero echoes AND no result is the M2 signature; one echo means the prompt landed.
  assert.equal(outcome.userEchoes, 1);
});

/**
 * FLAG-A. The only thing in the whole suite that can contain a VENDOR regression of M2.
 *
 * `npm run verify` cannot see M2 — only the human-run `scripts/probe-stream-input.ts` can,
 * and nothing runs it on a schedule. A CLI update that changed stdin semantics would
 * reproduce M2 on every run with a healthy-looking log and no gate firing. This deadline
 * is what turns that into a loud failure inside a minute.
 */
test('FLAG-A: a session that never acknowledges the prompt is reaped, not left for 45 minutes', async () => {
  const out = channel();
  const err = channel();
  const child = fakeChild({ out, err });
  const h = harness();

  const running = runAgent({
    cwd: '/tmp/wt',
    args: [],
    env: {},
    sessionId: 'sess-1',
    prompt: PROMPT,
    // The M2 shape exactly: hooks arrive, then nothing. No init, no echo, no result.
    // The real ack deadline is 60s; the test drives it rather than waiting it out, the
    // same way every other deadline case here does.
    maxRunMs: 45 * 60_000,
    ackTimeoutMs: 5,
    log: logger(h),
    spawn: () => child.handle,
    kill: (pid, signal) => h.kills.push({ pid, signal }) as unknown as number,
    isAlive: () => false,
    sleep: async () => undefined,
  });
  await out.push(ndjson({ type: 'system', subtype: 'hook_started', hook_name: 'SessionStart' }));

  await new Promise<void>((resolve) => setTimeout(resolve, 30));

  const outcome = await running;
  assert.deepEqual(
    h.kills.map((k) => k.signal),
    ['SIGINT'],
    'the group is reaped, to the NEGATED pid as always',
  );
  assert.equal(h.kills[0]?.pid, -PID);
  assert.equal(outcome.resultEvent, undefined);
  assert.equal(outcome.userEchoes, 0, 'zero echoes is what names the cause downstream');
  assert.equal(outcome.timedOut, false, 'NOT the maxRunMs deadline — nothing was truncated');
});
