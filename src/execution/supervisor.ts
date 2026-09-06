/**
 * Spawn and supervise one `claude -p`. AGNT-06, AGNT-08, D-07, D-08, D-09.
 *
 * Plan 05 owns the timeout and the escalating process-group kill (D-10 amended, T29).
 * This module deliberately ships no kill at all rather than the one that is known not to
 * work — see the comment on `maxRunMs`.
 */
import { execa } from 'execa';
import type { Logger } from '../infra/logger.js';
import { makeEventRouter } from './event-router.js';
import type { AgentResultEvent, PermissionDenial } from './event-router.js';
import { makeLineParser } from './stream-parser.js';

/**
 * The slice of an execa 10 handle this module uses.
 *
 * T30: execa 10 returns a promise-like exposing `pid`, `kill`, `stdout`, `stderr`, `then`
 * and `catch`. It has NO `.on()` — PITFALLS.md's Pitfall-5 sample is `node:child_process`
 * code and throws if pasted onto this handle. Typing the handle this narrowly is what
 * makes that mistake a compile error instead of a runtime one, and is what lets a test
 * script the whole supervision path with two async generators.
 */
export interface AgentSubprocess extends PromiseLike<{ exitCode?: number | undefined }> {
  pid?: number | undefined;
  stdout: AsyncIterable<unknown> | null;
  stderr: AsyncIterable<unknown> | null;
}

export type AgentSpawn = (
  file: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv }
) => AgentSubprocess;

export interface RunAgentInput {
  /** The worktree. The agent's cwd is the only place it is expected to write. */
  cwd: string;
  /** From `buildClaudeArgs()`. This module decides no flags of its own. */
  args: readonly string[];
  /** From `buildChildEnv()`. */
  env: NodeJS.ProcessEnv;
  sessionId: string;
  /**
   * Accepted and deliberately UNUSED in the tracer. Plan 05 (AGNT-08, D-10 amended)
   * implements the timer and the SIGINT -> SIGTERM -> SIGKILL escalation against the
   * process group. Shipping the obvious `handle.kill()` here would be worse than
   * shipping nothing: T29 measured it to kill the child, orphan the grandchild, and
   * leave this promise PERMANENTLY PENDING, because the surviving grandchild holds the
   * stdout pipe open.
   */
  maxRunMs: number;
  log: Logger;
  spawn?: AgentSpawn;
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
    // makes plan 05's negative-pid group kill legal (D-09).
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    // A signalled process must not throw past the evidence-based verdict (D-06). If it
    // throws, D-06 is violated by accident rather than by decision.
    reject: false,
  }) as unknown as AgentSubprocess;

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

export async function runAgent(o: RunAgentInput): Promise<AgentRunOutcome> {
  const spawn = o.spawn ?? defaultSpawn;
  const badLines: string[] = [];
  const router = makeEventRouter({ log: o.log });
  const parser = makeLineParser(
    (event) => router.route(event),
    (line) => {
      badLines.push(line);
      o.log.warn({ line: line.slice(0, 200) }, 'unparseable agent stream line');
    }
  );

  const child = spawn('claude', o.args, { cwd: o.cwd, env: o.env });
  o.log.info({ pid: child.pid, sessionId: o.sessionId }, 'agent spawned');

  // D-07: BOTH streams, concurrently. An undrained stdout deadlocks the child at ~64 KB,
  // which a real GSD run reaches inside its first minute — and the symptom is a run that
  // hangs forever with no output, not an error.
  //
  // An assertion thrown by the router (D-05) unwinds through here with the child still
  // running. Reaping it is plan 05's; the tracer must not pretend a kill it has not got.
  await Promise.all([
    drain(child.stdout, (text) => parser.push(text)),
    drain(child.stderr, (text) => o.log.debug({ stderr: text }, 'agent stderr')),
  ]);
  parser.flush();

  const settled = await child;
  const resultEvent = router.routed.result;

  return {
    exitCode: settled.exitCode,
    sessionId: o.sessionId,
    resultEvent,
    denials: resultEvent?.permission_denials ?? [],
    badLines,
  };
}
