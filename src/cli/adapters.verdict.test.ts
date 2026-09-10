/**
 * TRAPS T73 — the agent's word is not the verdict.
 *
 * For the whole of milestone v1 the run engine took `result.structured_output.status`
 * verbatim, so an agent that reported `complete` having written nothing WAS complete as
 * far as the daemon could tell. That is the single silent failure the research is most
 * emphatic about: `claude -p` exits 0 having been denied every edit (TRAPS T1/T27), and
 * "judge by evidence in the worktree, never by exit code" (Pitfall 3) existed in
 * `verdict.ts` from Phase 4 with nothing on the live path calling it.
 *
 * These cases pin the three outcomes apart. Each was confirmed to FAIL against the
 * pre-fix adapter before being committed — a first attempt at the fix left `partial`
 * still unreachable, because `timedOut` short-circuited to `failed` before the classifier
 * ran, and only case 3 caught it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAgentRunner, mappingIndex, toAgentResult } from './adapters.js';
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
  // T94: the fixture is widened, never the production code. `worktreeRoot` is REQUIRED by
  // the config schema and this fixture simply omitted it; `createAgentRunner` now derives
  // the run-log directory from it the same way it has always derived the worktree
  // directory. A throwaway temp path keeps the trace out of the operator's real root.
  worktreeRoot: join(tmpdir(), `law-runlog-fixture-${process.pid}`, 'worktrees'),
  concurrency: 3,
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

/**
 * A store whose only job is to say the run is a repo-run in `o/r`.
 *
 * `updateRun` is a sink rather than an omission: since gap D6/D7 the runner records the
 * spawned pid and the session's cost on the way past, and a stub without it throws
 * `deps.store.updateRun is not a function` in every case here. What those writes contain
 * is `usage.test.ts`'s subject, against a real SQLite file; this file is only about the
 * verdict, and asserting the writes here too would pin the same behaviour twice.
 */
const store = {
  getRun: () => ({ kind: 'repo', repoSlug: 'o/r' }),
  updateRun: () => undefined,
} as never;

/** `git log --oneline main..HEAD` returns `commits` lines; `git status --porcelain` returns `dirty`. */
function gitSaying(commits: number, dirty: string[] = []) {
  return async (cmd: string, args: readonly string[]) => {
    assert.equal(cmd, 'git');
    if (args.includes('log')) {
      return { stdout: Array.from({ length: commits }, (_, i) => `abc${i} msg`).join('\n'), stderr: '', exitCode: 0 };
    }
    return { stdout: dirty.map((p) => ` M ${p}`).join('\n'), stderr: '', exitCode: 0 };
  };
}

/** A `claude` session that emits one result event claiming `complete`, then exits 0. */
function sessionClaimingComplete(opts: { hang?: boolean } = {}) {
  return () => {
    const event = {
      type: 'result',
      subtype: 'success',
      is_error: false,
      structured_output: {
        status: 'complete',
        summary: 'did the thing',
        prTitle: 'Fix login',
        prBody: 'body',
      },
      total_cost_usd: 0,
      permission_denials: [],
    };
    let killed = false;
    return {
      stdout: (async function* () {
        yield `${JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', permissionMode: 'dontAsk', skills: ['gsd-execute-phase', 'gsd-plan-phase', 'gsd-verify-work'] })}\n`;
        if (!opts.hang) return void (yield `${JSON.stringify(event)}\n`);
        // A session that produces nothing further and never exits. The supervisor must
        // reap it at `maxRunMs` — ending the stream instead would report `crashed` (no
        // result event), which is a different outcome and would not exercise `partial`.
        while (!killed) await new Promise((r) => setTimeout(r, 5));
      })(),
      stderr: (async function* () {})(),
      kill: () => {
        killed = true;
        return true;
      },
      pid: 1234,
      then: (r: (v: { exitCode: number }) => void) => {
        if (!opts.hang) r({ exitCode: 0 });
        // hang: never settles until killed, which is what a reap looks like.
        else void new Promise<void>((res) => {
          const t = setInterval(() => {
            if (killed) { clearInterval(t); res(); }
          }, 5);
        }).then(() => r({ exitCode: 143 }));
      },
    } as never;
  };
}

const request: AgentSpawnRequest = {
  runId: 'run-1' as RunId,
  sessionId: 'sess-1' as SessionId,
  cwd: '/tmp/wt',
  prompt: 'do it',
  resume: false,
  env: {},
};

function runnerWith(git: ReturnType<typeof gitSaying>, spawn: ReturnType<typeof sessionClaimingComplete>) {
  return createAgentRunner({
    store,
    config,
    log: silent,
    index: mappingIndex(config),
    runCommand: git as never,
    spawn: spawn as never,
  });
}

test('T73: an agent claiming "complete" with an EMPTY worktree is failed, not delivered', async () => {
  const runner = runnerWith(gitSaying(0), sessionClaimingComplete());
  const result = await runner.run(request, new AbortController().signal);

  assert.equal(
    result.status,
    'failed',
    'a barren run must not be believed — this is `claude -p` denied every edit and still exiting 0',
  );
  assert.match(
    'failureReason' in result ? result.failureReason : '',
    /no commits/,
    'the diagnosis must say WHY the claim was rejected, or the operator cannot act on it',
  );
});

test('T73: an agent claiming "complete" WITH commits is believed', async () => {
  const runner = runnerWith(gitSaying(3), sessionClaimingComplete());
  const result = await runner.run(request, new AbortController().signal);

  assert.equal(result.status, 'complete', 'evidence agrees with the claim; nothing to override');
  assert.equal('prTitle' in result ? result.prTitle : null, 'Fix login');
});

test('T73: a run reaped at its deadline WITH commits is `partial`, and keeps its work', () => {
  // Driven through `toAgentResult` directly rather than a live reap: the timeout branch
  // sits behind the real SIGINT->SIGTERM->SIGKILL ladder (SIGINT_GRACE_MS is 15s), and
  // paying that on every gate run to reach one branch is not a trade worth making.
  const result = toAgentResult(
    { timedOut: true, killedBy: 'SIGTERM', exitCode: 143, resultEvent: undefined, denials: [] } as never,
    { commitCount: 2, dirty: true, uncommittedPaths: ['src/half-done.ts'] },
  );

  // Before the fix this was `failed`: the `timedOut` branch returned ahead of the
  // classifier, so `partial` could not be produced by ANY input at all.
  assert.equal(result.status, 'partial', 'commits survived the deadline; discarding them is the wrong error');
  assert.deepEqual(
    'uncommittedPaths' in result ? result.uncommittedPaths : undefined,
    ['src/half-done.ts'],
    'work left on disk must be NAMED — an hour of agent output is not silently dropped',
  );
});

test('T73: a run reaped at its deadline with NOTHING to show is still `failed`', () => {
  const result = toAgentResult(
    { timedOut: true, killedBy: 'SIGKILL', exitCode: 137, resultEvent: undefined, denials: [] } as never,
    { commitCount: 0, dirty: false },
  );
  assert.equal(result.status, 'failed', 'a deadline with no commits has no work to ship');
});

// ── T125: the commit count and the diff range must use the SAME ref string ───
//
// `gatherEvidence` read `mapping.repos.find(...).baseBranch` — the bare `"main"` — and
// `verdict.ts` gates `commitCount === 0` on the result. T112 measured a clone 18 commits
// behind its own `origin/main`; there, `main..HEAD` returns those 18 UPSTREAM commits for
// a run that committed nothing, so `commitCount > 0` and the verdict declares the agent
// committed. This is the assertion that pins the range to the ref the branch was cut from.

/** Records the ranges `gatherEvidence` asks git for, and reports zero commits. */
function gitRecordingRanges(ranges: string[]) {
  return async (cmd: string, args: readonly string[]) => {
    assert.equal(cmd, 'git');
    if (args.includes('log')) {
      const range = args[args.length - 1] ?? '';
      ranges.push(range);
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  };
}

test('T125: the commit count is measured against the ref the run was branched from', async () => {
  const ranges: string[] = [];
  const runner = createAgentRunner({
    // The run row remembers the RESOLVED ref, written by the driver at worktree creation
    // — the same string `deliver.ts` builds its diff range from.
    store: {
      getRun: () => ({ kind: 'repo', repoSlug: 'o/r', baseRef: 'refs/remotes/origin/main' }),
      updateRun: () => undefined,
    } as never,
    config,
    log: silent,
    index: mappingIndex(config),
    runCommand: gitRecordingRanges(ranges) as never,
    spawn: sessionClaimingComplete() as never,
  });

  await runner.run(request, new AbortController().signal);

  assert.deepEqual(ranges, ['refs/remotes/origin/main..HEAD']);
  assert.ok(!ranges.includes('main..HEAD'), 'the bare local name counts UPSTREAM commits as the run’s own');
});

test('T125: with no recorded ref the mapped repo’s own base branch is used, not the instance default', async () => {
  const ranges: string[] = [];
  const overriding = {
    ...(config as unknown as Record<string, unknown>),
    defaults: { ...(config.defaults as unknown as Record<string, unknown>), baseBranch: 'main' },
    mappings: {
      m1: { repos: [{ repoDir: '/tmp/r', repoSlug: 'o/r', baseBranch: 'master', enabled: true }] },
    },
  } as unknown as Config;

  const runner = createAgentRunner({
    // A row that predates the column — the recovery shape.
    store: { getRun: () => ({ kind: 'repo', repoSlug: 'o/r' }), updateRun: () => undefined } as never,
    config: overriding,
    log: silent,
    index: mappingIndex(overriding),
    runCommand: gitRecordingRanges(ranges) as never,
    spawn: sessionClaimingComplete() as never,
  });

  await runner.run(request, new AbortController().signal);

  assert.deepEqual(ranges, ['master..HEAD']);
});
