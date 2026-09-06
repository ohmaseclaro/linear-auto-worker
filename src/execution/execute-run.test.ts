/**
 * The end-to-end tracer test: one issue from a fresh worktree to a returned PR URL.
 *
 * Every claim here is one that a final-state assertion cannot make:
 *
 *  - the session ID reaches the store BEFORE the child is spawned, proven by call
 *    ordering rather than by reading the store afterwards (D-04, AGNT-04, T4);
 *  - the permission mode and its allowlist arrive in the SAME argv, so the two cannot
 *    drift apart into the exact silent-nothing failure the phase exists to prevent
 *    (D-01 amended, T27);
 *  - the child's environment is built by allowlist, proven by setting the worker's own
 *    secrets and a CLAUDE* variable in this process first and finding neither downstream
 *    (D-15 amended, T28);
 *  - the SAME canned exit code of 0 produces `delivered` in one variant and `failed` in
 *    the other, which is the whole of D-06 in one pair of assertions (T1);
 *  - a run whose branch is the default branch never constructs a push argument at all,
 *    proven by scanning every command the run issued (DELV-04, D-13).
 *
 * No `git`, no `gh`, no `claude` and no network: the command runner and the spawn are
 * both injected, which is the only kind of test that can exist under RUSH mode.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { executeRun } from './execute-run.js';
import type {
  ExecuteRunInput,
  ExecutionStore,
  RunCommand,
  RunCommandResult,
} from './execute-run.js';
import type { AgentSpawn, AgentSubprocess } from './supervisor.js';
import type { Logger } from '../infra/logger.js';

function silentLogger(): Logger {
  const log: Logger = {
    child: () => log,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  };
  return log;
}

const RESULT_EVENT = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  session_id: 'replaced-at-runtime',
  result: '{"status":"delivered"}',
  structured_output: { status: 'delivered', summary: 'Shipped the thing.' },
  stop_reason: 'tool_use',
  terminal_reason: 'completed',
  num_turns: 1,
  total_cost_usd: 0.246124,
  permission_denials: [],
};

/** Mirrors the real emission order: hook events precede `system/init` (D-04's proof). */
function cannedStream(): string {
  const events: unknown[] = [
    { type: 'system', subtype: 'hook_started', hook_name: 'SessionStart:startup' },
    { type: 'system', subtype: 'hook_response', outcome: 'success', exit_code: 0 },
    {
      type: 'system',
      subtype: 'init',
      cwd: '/tmp/wt',
      permissionMode: 'dontAsk',
      skills: ['gsd-execute-phase', 'gsd-plan-phase', 'gsd-verify-work', 'gsd-ship'],
    },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } },
    RESULT_EVENT,
  ];
  return events.map((event) => JSON.stringify(event)).join('\n') + '\n';
}

/**
 * Split the stream INSIDE a JSON token rather than on a line boundary. A naive
 * `split("\n").map(JSON.parse)` loses everything after the cut; the carry-buffer parser
 * must reassemble it (D-08).
 */
function midTokenChunks(stream: string): [string, string] {
  const marker = stream.indexOf('"structured_output"');
  assert.ok(marker > 0, 'canned stream must contain the result event');
  const cut = marker + 8;
  return [stream.slice(0, cut), stream.slice(cut)];
}

interface Harness {
  order: string[];
  commands: string[][];
  spawned: Array<{ args: readonly string[]; env: NodeJS.ProcessEnv }>;
  storedSessionIds: string[];
  input: ExecuteRunInput;
  store: ExecutionStore;
  runCommand: RunCommand;
  spawn: AgentSpawn;
}

function harness(o: { commitLog: string; branchName?: string; prUrl?: string }): Harness {
  const order: string[] = [];
  const commands: string[][] = [];
  const spawned: Array<{ args: readonly string[]; env: NodeJS.ProcessEnv }> = [];
  const storedSessionIds: string[] = [];

  const ok = (stdout: string): RunCommandResult => ({ exitCode: 0, stdout, stderr: '' });

  const runCommand: RunCommand = async (file, args) => {
    commands.push([file, ...args]);
    const joined = args.join(' ');
    if (file === 'gh') {
      order.push('gh');
      return ok(`Creating pull request\n${o.prUrl ?? 'https://github.com/acme/api/pull/7'}\n`);
    }
    // `git show-ref --verify --quiet refs/heads/<b>` is a PROBE, not a command: exit 0 means
    // the branch ALREADY EXISTS. The blanket `ok('')` fallthrough below therefore answered
    // "yes" to every candidate, so `resolveBranchName` burned all 50 suffixes and
    // `prepareWorktree` threw before a single assertion in this file could run.
    if (joined.includes('show-ref')) return { exitCode: 1, stdout: '', stderr: '' };
    if (joined.includes('push')) order.push('push');
    if (joined.includes('log --oneline')) return ok(o.commitLog);
    if (joined.includes('status --porcelain')) return ok('');
    if (joined.includes('diff --name-only')) return ok('src/index.ts\n');
    return ok('');
  };

  const spawn: AgentSpawn = (_file, args, options) => {
    order.push('spawn');
    spawned.push({ args, env: options.env });
    const [first, second] = midTokenChunks(cannedStream());
    const settled = Promise.resolve({ exitCode: 0 });
    const handle = {
      pid: 4242,
      stdout: (async function* () {
        yield first;
        yield second;
      })(),
      stderr: null,
      then: (onfulfilled: unknown, onrejected: unknown) =>
        settled.then(
          onfulfilled as never,
          onrejected as never
        ),
    };
    return handle as unknown as AgentSubprocess;
  };

  const store: ExecutionStore = {
    updateRun(_runId, patch) {
      if (patch.sessionId !== undefined) {
        order.push('store:sessionId');
        storedSessionIds.push(patch.sessionId);
      }
    },
  };

  const input: ExecuteRunInput = {
    runId: 'run-1',
    issue: {
      identifier: 'ENG-42',
      title: 'Expose the timeout as config',
      description: 'The timeout is hardcoded.',
      branchName: o.branchName ?? 'eng-42-expose-the-timeout',
      url: 'https://linear.app/acme/issue/ENG-42',
    },
    mapping: {
      repoPath: '/repos/api',
      ownerRepo: 'acme/api',
      defaultBranch: 'main',
      draftPr: true,
      maxRunMs: 60_000,
    },
    daemonDir: '/home/dev/.linear-auto-worker',
  };

  return { order, commands, spawned, storedSessionIds, input, store, runCommand, spawn };
}

test('a committing run reaches a PR URL, and the session id was stored before the spawn', async () => {
  // Set on THIS process so the allowlist has something real to withhold. CLAUDECODE is
  // present for real whenever the daemon is started from inside a Claude Code session,
  // which is the condition T28 measured flipping a working run into an asyncAgent denial.
  process.env['LINEAR_API_KEY'] = 'lin_api_notreal';
  process.env['NGROK_AUTHTOKEN'] = 'ngrok_notreal';
  process.env['CLAUDECODE'] = '1';

  const h = harness({ commitLog: 'abc1234 implement the thing\n' });
  const outcome = await executeRun(h.input, {
    store: h.store,
    log: silentLogger(),
    runCommand: h.runCommand,
    spawn: h.spawn,
  }).finally(() => {
    delete process.env['LINEAR_API_KEY'];
    delete process.env['NGROK_AUTHTOKEN'];
    delete process.env['CLAUDECODE'];
  });

  // Ordering, not final state: the row must carry the session id before a child exists.
  assert.ok(
    h.order.indexOf('store:sessionId') < h.order.indexOf('spawn'),
    `session id must be persisted before the spawn, got ${h.order.join(' -> ')}`
  );

  const spawnedRun = h.spawned[0];
  assert.ok(spawnedRun, 'the agent must have been spawned');
  const args = [...spawnedRun.args];

  // The mode and its allowlist ship together, or the run silently produces nothing (T27).
  assert.ok(args.includes('--permission-mode'));
  assert.ok(args.includes('dontAsk'));
  assert.ok(args.includes('--allowedTools'));
  assert.ok(args.includes('Write'));
  assert.ok(args.includes('--verbose'));
  assert.ok(args.includes('--output-format'));
  assert.ok(args.includes('stream-json'));
  assert.ok(args.includes('--session-id'));
  assert.equal(args[args.indexOf('--session-id') + 1], h.storedSessionIds[0]);

  // T2 / D-02: the forbidden flag is documented in agent-args.ts and emitted by nothing.
  assert.ok(!args.includes('--bare'), 'the forbidden flag must never be emitted');

  // D-15 amended / T28: allowlist, so all three of these are absent by construction.
  assert.equal(spawnedRun.env['LINEAR_API_KEY'], undefined);
  assert.equal(spawnedRun.env['NGROK_AUTHTOKEN'], undefined);
  assert.deepEqual(
    Object.keys(spawnedRun.env).filter((key) => key.startsWith('CLAUDE')),
    []
  );
  assert.equal(spawnedRun.env['LAW_RUN_ID'], 'run-1');

  // The mid-token split was reassembled: these numbers live only in the result event,
  // which is entirely on the far side of the cut.
  assert.equal(outcome.numTurns, 1);
  assert.equal(outcome.costUsd, 0.246124);

  // D-06: commits present, so `delivered` — from a canned exit code of 0.
  assert.equal(outcome.verdict, 'delivered');
  assert.equal(outcome.prUrl, 'https://github.com/acme/api/pull/7');

  // Pitfall 7: `gh` is given a branch that is already on the remote, or it hangs.
  assert.ok(
    h.order.indexOf('push') < h.order.indexOf('gh'),
    `push must precede gh pr create, got ${h.order.join(' -> ')}`
  );
});

test('a barren run with the SAME exit code of 0 is failed, and delivers nothing', async () => {
  const h = harness({ commitLog: '' });

  const outcome = await executeRun(h.input, {
    store: h.store,
    log: silentLogger(),
    runCommand: h.runCommand,
    spawn: h.spawn,
  });

  // The identical canned child: exit 0, is_error false, subtype "success",
  // terminal_reason "completed". Only the worktree evidence differs (D-06, T1).
  assert.equal(outcome.verdict, 'failed');
  assert.equal(outcome.prUrl, undefined);
  assert.ok(!h.order.includes('push'), 'a barren run must not push');
  assert.ok(!h.order.includes('gh'), 'a barren run must not open a PR');
});

test('a run whose branch is the default branch is refused before any push is constructed', async () => {
  const h = harness({ commitLog: 'abc1234 implement the thing\n', branchName: 'main' });

  await assert.rejects(
    executeRun(h.input, {
      store: h.store,
      log: silentLogger(),
      runCommand: h.runCommand,
      spawn: h.spawn,
    }),
    /default/
  );

  const pushed = h.commands.some((command) => command.includes('push'));
  assert.equal(pushed, false, 'the gate must fire before a push argument exists');
});
