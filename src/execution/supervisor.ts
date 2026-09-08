/**
 * Spawn and supervise one `claude -p`. AGNT-06, AGNT-08, D-07, D-08, D-09, D-10 amended.
 *
 * Plan 05 completes what the tracer deliberately left out: the deadline, the escalating
 * process-group kill with a liveness check between every step, and completion as a RACE
 * rather than an await.
 */
import { execa } from 'execa';
import type { Logger } from '../infra/logger.js';
import { userMessageLine } from './agent-args.js';
import { makeEventRouter } from './event-router.js';
import type { AgentResultEvent, PermissionDenial, ProgressUpdate } from './event-router.js';
import { makeLineParser } from './stream-parser.js';

/**
 * The slice of an execa 10 handle this module uses.
 *
 * T30: execa 10 returns a promise-like exposing `pid`, `kill`, `stdout`, `stderr`, `then`
 * and `catch`. It has NO `.on()` — PITFALLS.md's Pitfall-5 sample is `node:child_process`
 * code and throws if pasted onto this handle. Typing the handle this narrowly is what
 * makes that mistake a compile error instead of a runtime one, and is what lets a test
 * script the whole supervision path with two async generators.
 *
 * `stdin` was added by T113 and is the ONE addition this interface has taken. It is
 * required because the prompt no longer travels in argv — it is written here, as an NDJSON
 * `user` message, immediately after the spawn. `kill` is still absent, on purpose.
 *
 * Note what is NOT on this interface: the handle's own `kill` method. T29 measured it —
 * even with `detached: true` it killed the child, ORPHANED the grandchild, and left this
 * promise PERMANENTLY PENDING, because the survivor holds the stdout pipe open. Omitting
 * it from the type is the cheapest possible enforcement of "never call it".
 */
export interface AgentSubprocess extends PromiseLike<{ exitCode?: number | undefined }> {
  pid?: number | undefined;
  stdout: AsyncIterable<unknown> | null;
  stderr: AsyncIterable<unknown> | null;
  stdin: NodeJS.WritableStream | null;
}

export type AgentSpawn = (
  file: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv }
) => AgentSubprocess;

/**
 * Signal delivery, injected.
 *
 * The `pid` argument is ALREADY NEGATED by the caller — the negation is the whole point
 * of the escalation and a test asserts the sign on every recorded call. A positive pid
 * here signals the leader alone and orphans the agent's own Bash subtree, which then
 * accumulates across a week; it is a bug that is completely invisible without that
 * assertion.
 */
export type KillGroup = (pid: number, signal: NodeJS.Signals) => void;

/**
 * Liveness, injected. Checked BETWEEN escalation steps — never assumed (T29).
 *
 * Like `KillGroup`, the `pid` handed here is ALREADY NEGATED: the question the escalation
 * has to ask is "is anything in the GROUP still alive", not "is the leader still alive".
 * `process.kill(-pgid, 0)` answers the first; `process.kill(pid, 0)` answers the second and
 * is the bug 07-06 found — `sh -c 'sleep 600 & sleep 600'` is POSIX-required to make the
 * BACKGROUND job ignore SIGINT, so the leader dies to SIGINT, the leader-only check reports
 * "gone", the ladder stops, and the grandchild outlives the daemon holding its stdout pipe.
 */
export type IsAlive = (pid: number) => boolean;

export type Sleep = (ms: number) => Promise<void>;

/** The signal that finally reaped the group, in escalation order. */
export type EscalationStep = 'SIGINT' | 'SIGTERM' | 'SIGKILL';

/**
 * A3, and stated as an assumption rather than a measurement: the 45-minute figure is
 * INHERITED from PITFALLS.md and was never measured against a real GSD run. Erring long
 * is the safer error — too short truncates real work into `partial` rather than losing
 * it, and `partial` still ships a draft PR. Callers normally pass
 * `MappingToggles.maxRunMs`; this is only the floor for a mapping that carries none.
 */
export const DEFAULT_MAX_RUN_MS = 45 * 60_000;

/**
 * How long a spawned session has to acknowledge itself before it is presumed hung.
 *
 * The M2/T113 failure — `-p` discarded under `--input-format stream-json`, session hangs
 * forever — is invisible to `npm run verify`: the only instrument that can see it is the
 * human-run `scripts/probe-stream-input.ts`, which nothing runs on a schedule. Our own
 * regressions are contained by the suite; a VENDOR regression (the CLI ships a new major
 * roughly weekly) is not. Without this deadline such a change would reproduce M2 on every
 * run, the log would look healthy, no gate would fire, and the operator would find out 45
 * minutes later.
 *
 * Acknowledgement is either a `system/init` or any replayed `user` event. Both are things
 * a live session produces within a few seconds — measured on CLI 2.1.263 at 2.6s to init
 * and 4.2s to the first echo, on a cold start with 113 skills — and a hung one produces
 * neither, ever.
 *
 * 60 SECONDS, chosen deliberately. The measurement bounds it from below: the hook burst
 * landed in 0.7s and then nothing arrived for the full 90s the probe waited. 60s is ~85x
 * the observed hook latency — far past any cold start, a slow `SessionStart` hook chain or
 * a loaded machine — while being 1/45th of the default `maxRunMs`. Erring long is the
 * safer error here because the penalty for a false positive is reaping real work; erring
 * much longer forfeits the point of the deadline.
 */
export const AGENT_ACK_TIMEOUT_MS = 60_000;

/** Grace after SIGINT before escalating. Pattern 6's measured figure. */
export const SIGINT_GRACE_MS = 15_000;
/** Grace after SIGTERM before the un-catchable one. */
export const SIGTERM_GRACE_MS = 10_000;

export interface RunAgentInput {
  /** The isolated checkout. The agent's cwd is the only place it is expected to write. */
  cwd: string;
  /** From `buildClaudeArgs()`. This module decides no flags of its own. */
  args: readonly string[];
  /** From `buildChildEnv()`. */
  env: NodeJS.ProcessEnv;
  sessionId: string;
  /**
   * The brief. REQUIRED, because since T113 it no longer travels in argv — it is written to
   * the child's stdin as an NDJSON `user` message immediately after the spawn.
   */
  prompt: string;
  /**
   * `law say`. Called once, synchronously, right after the prompt is written, with a
   * `send` that writes one more message into the LIVE session.
   *
   * `send` returns `false` rather than throwing, for anything: stdin already ended, a dead
   * pipe, a child that never had one. It NEVER throws — the caller is a socket handler in
   * the daemon and a throw there would take down more than the message.
   *
   * The injection window is spawn -> first `result`. See the stdin-close rule below.
   */
  onInput?: (send: (text: string) => boolean) => void;
  /** `MappingToggles.maxRunMs`. Non-positive falls back to `DEFAULT_MAX_RUN_MS`. */
  maxRunMs: number;
  /**
   * FLAG-A. Defaults to `AGENT_ACK_TIMEOUT_MS`; a parameter for exactly the reason
   * `maxRunMs` is one — a deadline that can only be reached by waiting it out in real time
   * is a deadline no test can drive, and an untested reap ladder is worse than none.
   */
  ackTimeoutMs?: number;
  log: Logger;
  spawn?: AgentSpawn;
  /** Injected so the escalation is a state machine a test can drive deterministically. */
  kill?: KillGroup;
  isAlive?: IsAlive;
  sleep?: Sleep;
  /**
   * 07-CONTEXT P5. `event-router.ts` has routed `task_summary` / `post_turn_summary` into
   * this callback since plan 04, but nothing threaded it this far, so the milestones died
   * in the router and a 40-minute run went silent between pickup and its terminal comment
   * — which reads as a hung daemon. This field is the whole of the thread; the composition
   * root decides where the updates go.
   */
  onProgress?: (update: ProgressUpdate) => void;
  /**
   * Cancellation (D-11 / INTK-08). Aborting reaps the process GROUP through the same
   * escalation the deadline uses. Without it the daemon's cancel path has no way to reach
   * a live child at all: `runAgent` owns the only pid, so an unassigned ticket would leave
   * a `claude` session running for up to `maxRunMs` while the run row already said
   * `cancelled`.
   */
  signal?: AbortSignal;
  /**
   * Gap D7. The child's pid, the moment it exists.
   *
   * `runs.pid` was declared in the schema, written `null` at run creation, and never
   * written again — a dead column. It costs nothing while shutdown is clean, because the
   * reap goes through the in-process abort map and never needs to look one up. It costs
   * the operator their only handle after an UNCLEAN exit, which is exactly when a stray
   * `claude` process group is still holding a worktree and there is nothing left in the
   * database to point at it.
   *
   * `undefined` is a real outcome and is passed through rather than swallowed: a spawn
   * that reports no pid is the case `reap` already logs as unkillable.
   */
  onSpawn?: (pid: number | undefined) => void;
  /**
   * Every parsed stream event, in emission order, BEFORE the router sees it.
   *
   * The ordering is load-bearing, not stylistic: `router.route` THROWS on a session it
   * refuses (`assertSessionUsable`), and the refused session is precisely the one whose
   * `system/init` an operator needs to look at — a hook placed after the route call
   * records nothing for exactly the runs that need a record. Unparseable lines come
   * through here too, as `{type:'law.badline', line}`, so a malformed stream is visible in
   * `law watch` and not only in pino.
   */
  onEvent?: (event: unknown) => void;
}

export interface AgentRunOutcome {
  /**
   * Carried for logging only. It is NOT an input to the verdict (D-06): every
   * silent-failure probe in the research session exited 0 with `is_error: false`.
   */
  exitCode: number | undefined;
  sessionId: string;
  resultEvent: AgentResultEvent | undefined;
  denials: PermissionDenial[];
  /** Lines that were not valid JSON. A non-empty list is a red flag worth reporting. */
  badLines: string[];
  /** AGNT-08. The verdict reads this to classify a truncated run as `partial`. */
  timedOut: boolean;
  /**
   * M6. Summed across EVERY result in the session (per message), against `total_cost_usd`
   * which is cumulative and must be taken from the last one. See `EventRouter.tokensUsed`.
   */
  tokensUsed: number;
  /**
   * T113. How many `user`-role events the CLI emitted. A SUPERSET of the messages the
   * daemon wrote (see `EventRouter.userEchoes`); what matters is zero versus non-zero.
   * Zero, on a run that also produced no result, IS the M2 signature — the prompt was
   * never consumed.
   */
  userEchoes: number;
  /** Which escalation step the group finally died to. Undefined if it was never killed. */
  killedBy?: EscalationStep;
}

const defaultSpawn: AgentSpawn = (file, args, options) =>
  execa(file, [...args], {
    cwd: options.cwd,
    env: options.env,
    // Load-bearing, and easy to miss: execa MERGES the given env over `process.env` by
    // default. Without this the allowlist in `agent-env.ts` withholds nothing at all and
    // both D-15 and T28 come straight back.
    extendEnv: false,
    // Makes the child a process-group leader (verified: pgid === pid), which is what
    // makes the negative-pid group kill below legal (D-09).
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    // A signalled process must not throw past the evidence-based verdict (D-06). If it
    // throws, D-06 is violated by accident rather than by decision.
    reject: false,
  }) as unknown as AgentSubprocess;

/**
 * ESRCH from an already-dead group is normal, not exceptional: liveness is checked and
 * then signalled, and the process can die in between. Swallowing it here is what keeps
 * that ordinary race out of the error path.
 */
const defaultKill: KillGroup = (pid, signal) => {
  try {
    process.kill(pid, signal);
  } catch {
    /* already gone */
  }
};

const defaultIsAlive: IsAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isResultEvent(event: unknown): boolean {
  return typeof event === 'object' && event !== null && (event as { type?: unknown }).type === 'result';
}

function toText(chunk: unknown): string {
  if (typeof chunk === 'string') return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString('utf8');
  return String(chunk);
}

async function drain(
  stream: AsyncIterable<unknown> | null,
  onText: (text: string) => void
): Promise<void> {
  if (!stream) return;
  for await (const chunk of stream) onText(toText(chunk));
}

/**
 * AGNT-08 / D-10 amended / T29. SIGINT, then SIGTERM, then SIGKILL — each to the NEGATED
 * pid, each gated on a fresh liveness check.
 *
 * Why SIGINT is first and why it is not sufficient: SIGINT leaves the session resumable,
 * so an overrun run can be continued rather than only killed — that is D-10's reason and
 * it still holds. But the empirical matrix measured `process.kill(-pid, "SIGINT")`
 * killing the group LEADER ONLY while a backgrounded grandchild survived and the child
 * promise stayed pending; `SIGTERM` to the same group reaped both. The escalation is
 * therefore mandatory, not a courtesy.
 *
 * Why the pid is negated: a signal to the positive pid orphans the agent's own Bash
 * subprocesses, which then accumulate across a week of runs.
 */
async function escalate(
  pid: number,
  deps: { kill: KillGroup; isAlive: IsAlive; sleep: Sleep; log: Logger }
): Promise<EscalationStep> {
  const ladder: ReadonlyArray<readonly [EscalationStep, number]> = [
    ['SIGINT', SIGINT_GRACE_MS],
    ['SIGTERM', SIGTERM_GRACE_MS],
    ['SIGKILL', 0],
  ];

  let last: EscalationStep = 'SIGINT';
  for (const [signal, graceMs] of ladder) {
    last = signal;
    deps.log.warn({ pid, signal }, 'signalling agent process group');
    deps.kill(-pid, signal);
    if (graceMs === 0) break;
    await deps.sleep(graceMs);
    // Checked, never assumed. Skipping this is what turns "SIGINT was enough" from a
    // measurement into a hope.
    // NEGATED, like the kill above: a SIGINT-ignoring background grandchild keeps the
    // GROUP alive while the leader is already reaped, and that is precisely the case the
    // escalation exists for.
    if (!deps.isAlive(-pid)) break;
  }
  return last;
}

export async function runAgent(o: RunAgentInput): Promise<AgentRunOutcome> {
  const spawn = o.spawn ?? defaultSpawn;
  const kill = o.kill ?? defaultKill;
  const isAlive = o.isAlive ?? defaultIsAlive;
  const sleep = o.sleep ?? defaultSleep;
  const maxRunMs = o.maxRunMs > 0 ? o.maxRunMs : DEFAULT_MAX_RUN_MS;

  const badLines: string[] = [];
  const router = makeEventRouter({ log: o.log, onProgress: o.onProgress });
  // Assigned once the child exists; the parser closes over them, and the parser is built
  // first because `spawn` needs nothing from it.
  let endStdin: () => void = () => undefined;
  let onAgentAck: () => void = () => undefined;

  const parser = makeLineParser(
    (event) => {
      // BEFORE `route`, deliberately. See `RunAgentInput.onEvent`: `route` throws on a
      // session it refuses, and that session's `system/init` is the one worth keeping.
      o.onEvent?.(event);
      // T114 — THE TERMINAL RULE, and the trap this whole task is built around.
      //
      // `result` is NOT terminal and must never become one. Under streaming input the CLI
      // emits one result per USER MESSAGE (M4), so an injected `law say` produces a second
      // one; treating the first as "the run is over" ships a pull request after turn one
      // while the agent is still working. The run ends when the PROCESS EXITS —
      // `Promise.race([completed, reaped])` below, unchanged.
      //
      // The ONE thing a result decides is when stdin closes, and closing here is what makes
      // today's semantics survive: a run that sends one message gets one result (M4), stdin
      // closes, the child hits EOF (M8) and exits, exactly as before. A message written
      // BEFORE this close is still delivered — pipe bytes precede EOF — so the operator's
      // correction gets its turn and its result, and `routed.result` is last-wins (M10).
      if (isResultEvent(event)) endStdin();
      router.route(event);
      // FLAG-A, live. Either signal means a real session is on the other end of the pipe.
      if (router.routed.init !== undefined || router.userEchoes > 0) onAgentAck();
    },
    (line) => {
      badLines.push(line);
      o.onEvent?.({ type: 'law.badline', line });
      o.log.warn({ line: line.slice(0, 200) }, 'unparseable agent stream line');
    }
  );

  const child = spawn('claude', o.args, { cwd: o.cwd, env: o.env });
  o.log.info({ pid: child.pid, sessionId: o.sessionId }, 'agent spawned');
  // Before the first await below: a run reaped early must still have left its pid behind.
  o.onSpawn?.(child.pid);

  /**
   * T113. The prompt, on stdin, SYNCHRONOUSLY and before any await — the same
   * before-the-first-await rule `onSpawn` above follows, and for a sharper reason: this is
   * the only thing that makes the session do anything at all. Under `--input-format
   * stream-json` a session with nothing on stdin sits silent until its deadline (M2).
   *
   * A failure here is a hard failure of the run, not a warning. It is logged at error and
   * the run is left to reach the no-result path, which now names the cause.
   */
  let stdinEnded = false;
  function writeLine(line: string): boolean {
    if (stdinEnded || !child.stdin) return false;
    try {
      // A `false` return is BACKPRESSURE, not failure — the bytes are buffered and will be
      // flushed. Only the stream's async `'error'` event means the write was lost, and by
      // then this call has long returned. Reporting backpressure as failure would tell the
      // operator their message was dropped when it was in fact delivered.
      child.stdin.write(line);
      return true;
    } catch {
      return false;
    }
  }

  if (!writeLine(userMessageLine(o.prompt))) {
    o.log.error(
      { sessionId: o.sessionId },
      'could not write the prompt to the agent stdin — the session will produce nothing (T113)',
    );
  }

  // `law say`. The window this opens is spawn -> first `result`; see the stdin close below.
  o.onInput?.((text: string) => writeLine(userMessageLine(text)));

  // M8: EOF on stdin is what ends the session — measured, clean exit 0 within 0.6s, and
  // nothing else terminated it in 90 seconds. Idempotent: the first result closes it and
  // every subsequent one is a no-op.
  endStdin = (): void => {
    if (stdinEnded) return;
    stdinEnded = true;
    try {
      child.stdin?.end();
    } catch {
      /* already gone; the child is about to exit anyway */
    }
  };

  let timedOut = false;
  let killedBy: EscalationStep | undefined;
  let routerError: unknown;
  let reaping: Promise<void> | undefined;

  // Resolves when — and only when — the escalation has finished. This is the second
  // horse in the race below.
  let onReaped: () => void = () => undefined;
  const reaped = new Promise<void>((resolve) => {
    onReaped = resolve;
  });

  /** Idempotent: the deadline and a router assertion can both reach for it. */
  function beginEscalation(reason: string): Promise<void> {
    if (reaping) return reaping;
    const pid = child.pid;
    if (pid === undefined) {
      o.log.error({ reason }, 'cannot reap agent: the spawn reported no pid');
      onReaped();
      reaping = Promise.resolve();
      return reaping;
    }
    reaping = escalate(pid, { kill, isAlive, sleep, log: o.log }).then((step) => {
      killedBy = step;
      o.log.warn({ pid, reason, killedBy: step }, 'agent process group reaped');
      onReaped();
    });
    return reaping;
  }

  const timer = setTimeout(() => {
    timedOut = true;
    void beginEscalation('deadline');
  }, maxRunMs);

  /**
   * FLAG-A / T113. The M2 containment that does not depend on anybody remembering to run a
   * probe. See `AGENT_ACK_TIMEOUT_MS` for why it exists and why the number is what it is.
   *
   * Deliberately NOT setting `timedOut`: that flag means "the maxRunMs deadline reaped a
   * run that was working", and the verdict reads it to ship committed work as `partial`.
   * A session that never acknowledged its prompt has done nothing and committed nothing;
   * it reaches the no-result path, where `userEchoes === 0` names the cause exactly.
   */
  const ackTimer = setTimeout(() => {
    o.log.error(
      { sessionId: o.sessionId, afterMs: o.ackTimeoutMs ?? AGENT_ACK_TIMEOUT_MS },
      'the agent produced neither a system/init nor a replayed prompt — presuming the stdin ' +
        'delivery failed (T113/M2) and reaping now rather than at maxRunMs',
    );
    void beginEscalation('no-agent-ack');
  }, o.ackTimeoutMs ?? AGENT_ACK_TIMEOUT_MS);
  onAgentAck = (): void => clearTimeout(ackTimer);

  // Not `timedOut`: a cancelled run is not a truncated one, and the verdict reads that
  // flag to decide `partial` (T61).
  const onAbort = (): void => void beginEscalation('cancelled');
  if (o.signal?.aborted) onAbort();
  else o.signal?.addEventListener('abort', onAbort, { once: true });

  // D-07: BOTH streams, concurrently, both started before either is awaited. An undrained
  // stdout deadlocks the child at ~64 KB, which a real GSD run reaches inside its first
  // minute — and the symptom is a run that hangs forever with no output, not an error.
  // Draining stdout alone just moves the deadlock to stderr.
  //
  // stderr goes to the log at debug level and NO FURTHER: raw agent output is never
  // posted outward (ASVS V7); redaction is the log sink's job (Phase 2).
  const drained = Promise.all([
    drain(child.stdout, (text) => parser.push(text)),
    drain(child.stderr, (text) => o.log.debug({ stderr: text }, 'agent stderr')),
  ]).then(undefined, (err: unknown) => {
    // The router refused the session (D-05 / AGNT-07): no GSD skills, or a permission
    // mode the CLI did not apply. Reap NOW rather than at the deadline — waiting out 45
    // minutes to report a fault detected in the first second is the difference between a
    // loud failure and a slow one.
    routerError = err;
    return beginEscalation('router-assertion');
  });

  let exitCode: number | undefined;
  const completed = (async () => {
    await drained;
    const settled = await child;
    exitCode = settled.exitCode;
  })().catch((err: unknown) => {
    routerError ??= err;
  });

  // Pitfall 3, encoded as control flow. Awaiting the child alone is a run stuck in
  // `running` at 0% CPU forever: a surviving grandchild inherits and holds the stdout
  // pipe, so neither the drain nor the promise ever settles even though `claude` is dead.
  // Completion is whichever of the two finishes first, never the promise alone.
  await Promise.race([completed, reaped]);
  clearTimeout(timer);
  clearTimeout(ackTimer);
  // FLAG-C(b). The run is over — close the injection window HERE, not in whatever `finally`
  // the caller gets round to. A child can die without ever emitting a `result` (a crash, a
  // reap), which leaves `stdinEnded` false: `write()` would then succeed against a dead
  // pipe, EPIPE would surface asynchronously, and `law say` would already have told the
  // operator the message was accepted. Flipping the flag at the one place that knows the
  // run has ended makes every later `send` return false honestly.
  endStdin();
  o.signal?.removeEventListener('abort', onAbort);
  parser.flush();

  if (routerError !== undefined) throw routerError;

  const resultEvent = router.routed.result;
  return {
    exitCode,
    sessionId: o.sessionId,
    resultEvent,
    // Prefer the ROUTER's tally over the result event's (07-CONTEXT P5). A run the
    // supervisor reaped has no result event at all, so reading only
    // `resultEvent.permission_denials` reports zero denials for exactly the runs whose
    // denials explain why they had to be reaped.
    denials: router.denials.length > 0 ? [...router.denials] : (resultEvent?.permission_denials ?? []),
    badLines,
    timedOut,
    tokensUsed: router.tokensUsed,
    userEchoes: router.userEchoes,
    killedBy,
  };
}

// A timed-out run's isolated checkout stays EXACTLY where it is. This module performs no
// filesystem cleanup of any kind and must not learn how (AGNT-08): the directory is the
// only evidence the operator has of what the agent actually did, and removal is
// `finishWorktree`'s job, verdict-gated, in plan 04-02.
