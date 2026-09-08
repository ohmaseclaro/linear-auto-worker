/**
 * The INTEGRATION check, and the T109 target for both of this task's wires.
 *
 * `inject.test.ts` proves the registry and the socket work. This proves they are CALLED —
 * driven through the real `createAgentRunner` with a scripted spawn whose stdin is a real
 * `PassThrough`. T109 is the whole reason it exists: deleting `onInput:` in `adapters.ts`
 * must turn THIS red while the unit suites stay green. Both red means it is targeting the
 * module; neither red means it is targeting nothing (which is what pass 1 of the run-log
 * wiring measured, and why the run-log assertion is in here too).
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { createAgentRunner, mappingIndex } from './adapters.js';
import { createInjector } from '../execution/inject.js';
import { runLogPath } from '../execution/run-log.js';
import { openStore } from '../infra/store/db.js';
import { createSqliteStore, type RunRow, type Store } from '../infra/store/sqlite-store.js';
import type { AgentSpawnRequest, Config } from '../domain/ports.js';
import type { RunId, SessionId } from '../domain/types.js';

const silent = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => silent,
} as never;

const RUN_ID = 'run-inject' as RunId;

const INIT = {
  type: 'system',
  subtype: 'init',
  session_id: 's',
  permissionMode: 'dontAsk',
  skills: ['gsd-execute-phase', 'gsd-plan-phase', 'gsd-verify-work'],
};

const RESULT = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  structured_output: { status: 'complete', summary: 's', prTitle: 't', prBody: 'b' },
  total_cost_usd: 0.1,
  permission_denials: [],
};

const gitWithCommits = async (_cmd: string, args: readonly string[]) => {
  if (args.includes('log')) return { stdout: 'a x\nb y', stderr: '', exitCode: 0 };
  return { stdout: '', stderr: '', exitCode: 0 };
};

/** A push-driven stdout: the test decides exactly when the agent speaks. */
function channel(): { push(text: string): Promise<void>; end(): Promise<void>; stream: AsyncIterable<string> } {
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
  const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
  return {
    async push(text: string) {
      queue.push(text);
      wake();
      await tick();
      await tick();
    },
    async end() {
      closed = true;
      wake();
      await tick();
    },
    stream,
  };
}

function seed(store: Store, dir: string): void {
  const row: RunRow = {
    id: RUN_ID,
    parentRunId: null,
    kind: 'repo',
    issueId: 'issue-1',
    issueKey: 'LAW-9',
    issueTitle: 'a ticket',
    issueUrl: 'https://linear.app/x/LAW-9',
    repoDir: '/tmp/r',
    repoSlug: 'o/r',
    branch: 'law-9',
    worktreePath: join(dir, 'wt'),
    sessionId: null,
    pid: null,
    state: 'running',
    attempt: 0,
    questionRound: 0,
    prUrl: null,
    failureReason: null,
    createdAt: 1,
    updatedAt: 1,
  };
  store.insertRun(row);
}

const request: AgentSpawnRequest = {
  runId: RUN_ID,
  sessionId: 'sess-1' as SessionId,
  cwd: '/tmp/wt',
  prompt: 'implement the ticket',
  resume: false,
  env: {},
};

test('T109: `law say` reaches a live agent\'s stdin THROUGH createAgentRunner', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'law-adapters-inject-'));
  const store = createSqliteStore(openStore(join(dir, 'store.db')));
  seed(store, dir);

  const out = channel();
  const stdin = new PassThrough();
  const injector = createInjector();

  const config = {
    // `daemonDirOf` = dirname(worktreeRoot), which is where the run log lands.
    worktreeRoot: join(dir, 'worktrees'),
    concurrency: 3,
    maxTurns: 40,
    defaults: {
      postLinearComments: true,
      notifySlack: false,
      baseBranch: 'main',
      draftPr: true,
      questionsEnabled: true,
      questionTimeoutMs: 1000,
      maxRunMs: 60_000,
    },
    mappings: {
      m1: { repos: [{ repoDir: '/tmp/r', repoSlug: 'o/r', baseBranch: 'main', enabled: true }] },
    },
  } as unknown as Config;

  const runner = createAgentRunner({
    store: store as never,
    config,
    log: silent,
    index: mappingIndex(config),
    runCommand: gitWithCommits as never,
    injector,
    spawn: (() => ({
      stdout: out.stream,
      stderr: (async function* () {})(),
      stdin,
      pid: 4242,
      then: () => undefined,
    })) as never,
  });

  const running = runner.run(request, new AbortController().signal);
  await out.push(`${JSON.stringify(INIT)}\n`);

  // The run is IN FLIGHT. This is the whole claim: an outside caller holding only the
  // injector can reach this session.
  assert.deepEqual(
    injector.send(RUN_ID, 'stop and run the tests'),
    { ok: true },
    'the run must have registered itself with the injector',
  );

  const raw: string = (stdin.read() as Buffer | null)?.toString('utf8') ?? '';
  const said = raw
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as { message: { content: Array<{ text: string }> } });
  assert.equal(said.length, 2, 'the prompt, then the injected message');
  assert.equal(said[1]?.message.content[0]?.text, 'stop and run the tests');

  // Now the turn ends. The window closes on the FIRST result — the Task 2 terminal rule,
  // observed here from the outside rather than from inside the supervisor.
  await out.push(`${JSON.stringify(RESULT)}\n`);
  const late = injector.send(RUN_ID, 'too late');
  assert.equal(late.ok, false, 'the injection window is spawn -> first result');

  await out.end();
  await running;

  // T109, the run-log half. Pass 1 of the procedure found NOTHING went red when
  // `onEvent:` was deleted in `adapters.ts` — the module suites target `run-log.ts` and
  // `watch.ts`, not the wiring. This is the assertion that closes that hole.
  const log = runLogPath(join(dir, 'worktrees', '..'), RUN_ID);
  assert.ok(existsSync(log), `the run wrote its activity log at ${log}`);
  const events = readFileSync(log, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as { type?: string });
  assert.ok(
    events.some((e) => e.type === 'system'),
    'the system/init reached the log',
  );
  assert.ok(events.some((e) => e.type === 'result'), 'and so did the result');

  store.close();
  rmSync(dir, { recursive: true, force: true });
});
