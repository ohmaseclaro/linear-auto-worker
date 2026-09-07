/**
 * Gaps D6 and D7 — the two values the daemon computed or held and then discarded.
 *
 * D6: `classifyOutcome` has read `total_cost_usd` off the agent's result event since Phase
 * 4. `toNotifyEvent` hardcoded `costUsd: 0, tokensUsed: 0`, so Slack, the Linear comment
 * and the log reported `$0.0000` for every run ever made.
 *
 * D7: `runs.pid` was in the schema from migration 001, written `null` at creation, and
 * never written again. After an unclean exit there was nothing to point at the `claude`
 * process group still holding a worktree.
 *
 * Driven through the real `createAgentRunner` against a real SQLite file, because the
 * failure mode both of these belong to is a value that exists in one layer and never
 * reaches the next — which a mocked store cannot show.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { createAgentRunner, mappingIndex } from './adapters.js';
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

const config = {
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

const RUN_ID = 'run-usage' as RunId;
const SPAWN_PID = 4242;

let dir: string;
let store: Store;

function seed(): void {
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
    worktreePath: '/tmp/wt',
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

/** A session that finishes with the usage block a real `claude` run reports. */
function sessionReporting(costUsd: number, usage: Record<string, number> | undefined) {
  return () => ({
    stdout: (async function* () {
      yield `${JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 's',
        permissionMode: 'dontAsk',
        skills: ['gsd-execute-phase', 'gsd-plan-phase', 'gsd-verify-work'],
      })}\n`;
      yield `${JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        structured_output: { status: 'complete', summary: 's', prTitle: 't', prBody: 'b' },
        total_cost_usd: costUsd,
        ...(usage ? { usage } : {}),
        permission_denials: [],
      })}\n`;
    })(),
    stderr: (async function* () {})(),
    kill: () => true,
    pid: SPAWN_PID,
    then: (r: (v: { exitCode: number }) => void) => r({ exitCode: 0 }),
  });
}

/** `git log` reports two commits so the T73 verdict believes the `complete` claim. */
const gitWithCommits = async (cmd: string, args: readonly string[]) => {
  assert.equal(cmd, 'git');
  if (args.includes('log')) return { stdout: 'a x\nb y', stderr: '', exitCode: 0 };
  return { stdout: '', stderr: '', exitCode: 0 };
};

const request: AgentSpawnRequest = {
  runId: RUN_ID,
  sessionId: 'sess-1' as SessionId,
  cwd: '/tmp/wt',
  prompt: 'do it',
  resume: false,
  env: {},
};

async function runOnce(costUsd: number, usage: Record<string, number> | undefined) {
  const runner = createAgentRunner({
    store: store as never,
    config,
    log: silent,
    index: mappingIndex(config),
    runCommand: gitWithCommits as never,
    spawn: sessionReporting(costUsd, usage) as never,
  });
  return runner.run(request, new AbortController().signal);
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'law-usage-'));
  store = createSqliteStore(openStore(join(dir, 'store.db')));
});
after(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

test('D6: the run row records what the session cost', async () => {
  seed();
  const result = await runOnce(1.2345, {
    input_tokens: 2,
    output_tokens: 4,
    cache_creation_input_tokens: 61_520,
    cache_read_input_tokens: 100,
  });
  assert.equal(result.status, 'complete');

  const run = store.getRun(RUN_ID)!;
  assert.equal(run.costUsd, 1.2345, 'the cost the agent reported must survive to the run row');
  assert.equal(
    run.tokensUsed,
    61_626,
    'all four usage counts, not just input+output — 6 would be true and useless here',
  );
});

test('D7: the run row records the pid of the process it spawned', () => {
  const run = store.getRun(RUN_ID)!;
  assert.equal(
    run.pid,
    SPAWN_PID,
    'without this there is nothing to point at a stray process group after an unclean exit',
  );
});

test('D6: a resumed run ACCUMULATES cost across its sessions', async () => {
  // One run is one row and can be several `claude` sessions — every answered question
  // resumes the run through this same function, and `total_cost_usd` is that SESSION's
  // cost. Assigning instead of adding reports only the last session, so the runs that cost
  // the most (the ones that asked the most questions) under-report the worst.
  store.updateRun(RUN_ID, { costUsd: 0, tokensUsed: 0 });
  await runOnce(1.5, { input_tokens: 100 });
  await runOnce(2.25, { input_tokens: 200 });
  const run = store.getRun(RUN_ID)!;
  assert.equal(run.costUsd, 3.75, 'two sessions on one run cost the sum of both');
  assert.equal(run.tokensUsed, 300);
});

test('D6: a result event with no usage block adds zero, not NaN', async () => {
  store.updateRun(RUN_ID, { costUsd: 9, tokensUsed: 9 });
  await runOnce(0, undefined);
  const run = store.getRun(RUN_ID)!;
  assert.equal(run.tokensUsed, 9, 'a session that reported nothing must not corrupt the total');
  assert.equal(run.costUsd, 9);
});

test('D6: an unrecognised usage key is ignored rather than thrown on', async () => {
  store.updateRun(RUN_ID, { costUsd: 0, tokensUsed: 0 });
  await runOnce(0.5, { input_tokens: 10, some_new_field_anthropic_added: 999 } as never);
  const run = store.getRun(RUN_ID)!;
  assert.equal(run.tokensUsed, 10, 'a run must not fail because a vendor added a key');
});

// -- the run budget ----------------------------------------------------------

/** The same config with a run budget attached. */
function budgeted(maxBudgetUsd: number): Config {
  return { ...(config as object), maxBudgetUsd } as unknown as Config;
}

async function runWith(cfg: Config, costUsd: number, spawnPid = SPAWN_PID) {
  const runner = createAgentRunner({
    store: store as never,
    config: cfg,
    log: silent,
    index: mappingIndex(cfg),
    runCommand: gitWithCommits as never,
    spawn: (() => ({ ...sessionReporting(costUsd, { input_tokens: 1 })(), pid: spawnPid })) as never,
  });
  return runner.run(request, new AbortController().signal);
}

test('the budget passed to the CLI is what REMAINS, not the configured total', async () => {
  // One run is several `claude` sessions. Passing the full figure to each would let an
  // N-question run cost up to N+1 times the cap — a limit that does not limit, and the
  // same per-session-value-on-a-per-run-quantity mistake as T95.
  store.updateRun(RUN_ID, { costUsd: 4, tokensUsed: 0 });
  let seen: readonly string[] = [];
  const runner = createAgentRunner({
    store: store as never,
    config: budgeted(10),
    log: silent,
    index: mappingIndex(budgeted(10)),
    runCommand: gitWithCommits as never,
    spawn: ((_cwd: string, args: readonly string[]) => {
      seen = args;
      return sessionReporting(1, { input_tokens: 1 })();
    }) as never,
  });
  await runner.run(request, new AbortController().signal);

  const i = seen.indexOf('--max-budget-usd');
  assert.notEqual(i, -1, 'a configured budget must reach the CLI');
  assert.equal(seen[i + 1], '6', '$10 configured minus $4 already spent');
});

test('an exhausted budget does not spawn, and does not discard committed work', async () => {
  // The CLI refuses a non-positive budget outright, so this must be decided before the
  // spawn. Routed through the same evidence-based verdict as every other ending: the
  // worktree has commits, so the run ships them as a draft `partial` rather than being
  // thrown away for running out of money.
  store.updateRun(RUN_ID, { costUsd: 10, tokensUsed: 0 });
  let spawned = false;
  const cfg = budgeted(10);
  const runner = createAgentRunner({
    store: store as never,
    config: cfg,
    log: silent,
    index: mappingIndex(cfg),
    runCommand: gitWithCommits as never,
    spawn: (() => {
      spawned = true;
      return sessionReporting(1, undefined)();
    }) as never,
  });
  const result = await runner.run(request, new AbortController().signal);

  assert.equal(spawned, false, 'the point of a budget is not to start work it cannot pay for');
  assert.equal(result.status, 'partial', 'commits exist; running out of money must not discard them');
});

test('no configured budget means no cap and no early exit', async () => {
  store.updateRun(RUN_ID, { costUsd: 999, tokensUsed: 0 });
  const result = await runWith(config, 1);
  assert.equal(result.status, 'complete', 'an unbudgeted run is never refused for spend');
});
