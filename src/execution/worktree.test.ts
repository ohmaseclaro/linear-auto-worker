/**
 * worktree.ts. RUSH mode: written, not run — see 04-CONTEXT.md and TRAPS.md.
 * `node:test` + `node:assert/strict`, no git/gh/claude installed — every `git` call is a
 * scripted `runCommand` that records the exact argv it received.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { finishWorktree, prepareWorktree, reconcileWorktrees } from './worktree.js';
import type { RunCommand, RunCommandOptions, RunCommandResult } from './execute-run.js';

interface RecordedCall {
  file: string;
  args: string[];
  options: RunCommandOptions | undefined;
}

/**
 * A faithful-enough execa stand-in: resolves `handler`'s partial result, and — matching
 * the real `defaultRunCommand`'s documented contract ("a non-zero exit REJECTS unless
 * `reject` is explicitly false") — throws on a non-zero exit code unless the caller opted
 * out.
 */
function makeRunner(
  handler: (call: RecordedCall) => Partial<RunCommandResult> | Promise<Partial<RunCommandResult>>
): { run: RunCommand; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const run: RunCommand = async (file, args, options) => {
    const call: RecordedCall = { file, args: [...args], options };
    calls.push(call);
    const partial = await handler(call);
    const result: RunCommandResult = { exitCode: 0, stdout: '', stderr: '', ...partial };
    const reject = options?.reject ?? true;
    if (reject && result.exitCode !== 0) {
      throw new Error(`scripted command failed: git ${args.join(' ')}`);
    }
    return result;
  };
  return { run, calls };
}

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Drains pending microtasks (any depth) by yielding to the macrotask queue once. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const BASE_INPUT = {
  repoPath: '/Users/operator/code/widget',
  repoSlug: 'acme-widget',
  daemonDir: '/Users/operator/.linear-auto-worker',
  base: 'main',
};

describe('prepareWorktree', () => {
  test('a free branch name is used verbatim — never slugified or lowercased', async () => {
    const { run, calls } = makeRunner((call) => {
      if (call.args.includes('show-ref')) return { exitCode: 1 }; // never exists
      return { exitCode: 0 };
    });

    const result = await prepareWorktree({ ...BASE_INPUT, runCommand: run, branchName: 'ENG-42-Fix_The-Thing' });

    assert.equal(result.branch, 'ENG-42-Fix_The-Thing');
    const addCall = calls.find((c) => c.args.includes('add'));
    assert.ok(addCall, 'expected a worktree add call');
    assert.ok(addCall.args.includes('ENG-42-Fix_The-Thing'));
  });

  test('a colliding branch name is suffixed -2, and -2 colliding too suffixes -3', async () => {
    const existing = new Set(['ENG-42', 'ENG-42-2']);
    const { run, calls } = makeRunner((call) => {
      if (call.args.includes('show-ref')) {
        const ref = call.args[call.args.length - 1] ?? '';
        const branch = ref.replace('refs/heads/', '');
        return { exitCode: existing.has(branch) ? 0 : 1 };
      }
      return { exitCode: 0 };
    });

    const result = await prepareWorktree({ ...BASE_INPUT, runCommand: run, branchName: 'ENG-42' });

    assert.equal(result.branch, 'ENG-42-3');
    const addCall = calls.find((c) => c.args.includes('add'));
    assert.ok(addCall?.args.includes('ENG-42-3'));
    assert.ok(!addCall?.args.includes('ENG-42-2'));
    assert.ok(!addCall?.args.includes('ENG-42'));
  });

  test('the branch-resetting create variant ("-B") is never emitted', async () => {
    const { run, calls } = makeRunner((call) => (call.args.includes('show-ref') ? { exitCode: 1 } : { exitCode: 0 }));

    await prepareWorktree({ ...BASE_INPUT, runCommand: run, branchName: 'ENG-1' });

    for (const call of calls) {
      assert.ok(!call.args.includes('-B'), `argv must never include -B: ${call.args.join(' ')}`);
    }
  });

  test('a detached HEAD after creation rejects prepareWorktree', async () => {
    const { run } = makeRunner((call) => {
      if (call.args.includes('show-ref')) return { exitCode: 1 };
      if (call.args.includes('symbolic-ref')) return { exitCode: 1 }; // detached
      return { exitCode: 0 };
    });

    await assert.rejects(() => prepareWorktree({ ...BASE_INPUT, runCommand: run, branchName: 'ENG-1' }));
  });

  test('the worktree path is under the daemon root and never inside repoPath', async () => {
    const { run } = makeRunner((call) => (call.args.includes('show-ref') ? { exitCode: 1 } : { exitCode: 0 }));

    const result = await prepareWorktree({ ...BASE_INPUT, runCommand: run, branchName: 'ENG-1' });

    assert.ok(result.path.startsWith(BASE_INPUT.daemonDir));
    assert.ok(!result.path.startsWith(BASE_INPUT.repoPath));
    assert.ok(!result.path.split(/[/\\]/).includes('..'));
  });

  test('two preparations against the same repoPath do not interleave their git invocations', async () => {
    const gate = deferred<void>();
    let fetchesSeen = 0;
    const { run, calls } = makeRunner(async (call) => {
      if (call.args.includes('fetch')) {
        fetchesSeen += 1;
        if (fetchesSeen === 1) await gate.promise; // block only the FIRST call's fetch
      }
      if (call.args.includes('show-ref')) return { exitCode: 1 };
      return { exitCode: 0 };
    });

    const p1 = prepareWorktree({ ...BASE_INPUT, runCommand: run, branchName: 'ENG-1' });
    const p2 = prepareWorktree({ ...BASE_INPUT, runCommand: run, branchName: 'ENG-2' });

    // Let the event loop settle: p2 must be queued on the mutex, not yet issuing argv.
    await flush();
    assert.equal(calls.length, 1, 'the second call must not issue any argv before the first has finished');

    gate.resolve();
    const [r1, r2] = await Promise.all([p1, p2]);

    assert.equal(r1.branch, 'ENG-1');
    assert.equal(r2.branch, 'ENG-2');
    assert.ok(calls.length > 1);
  });

  test('two preparations against DIFFERENT repoPaths interleave', async () => {
    const gate = deferred<void>();
    let sawSecondRepoFetch = false;
    const { run } = makeRunner(async (call) => {
      if (call.args.includes('fetch') && call.args[1] === '/repo/a') {
        await gate.promise; // block repo A's fetch
      }
      if (call.args.includes('fetch') && call.args[1] === '/repo/b') {
        sawSecondRepoFetch = true;
      }
      if (call.args.includes('show-ref')) return { exitCode: 1 };
      return { exitCode: 0 };
    });

    const p1 = prepareWorktree({ ...BASE_INPUT, repoPath: '/repo/a', runCommand: run, branchName: 'ENG-1' });
    const p2 = prepareWorktree({ ...BASE_INPUT, repoPath: '/repo/b', runCommand: run, branchName: 'ENG-2' });

    await flush();
    assert.equal(sawSecondRepoFetch, true, 'a different repoPath must not wait on repo A\'s mutex');

    gate.resolve();
    await Promise.all([p1, p2]);
  });

  /**
   * T112. These two script `show-ref` by ref NAMESPACE, not by the bare word `show-ref`.
   * Every case above answers `show-ref` with exit 1 unconditionally, so a test written the
   * obvious way tells the new remote-tracking probe "absent" and passes against unfixed
   * code — vacuous. Both were run against HEAD before the fix landed: the first RED, the
   * second already green.
   */
  test('the base is the remote-tracking ref when it exists, not the bare local name', async () => {
    const { run, calls } = makeRunner((call) => {
      if (call.args.includes('show-ref')) {
        const ref = call.args[call.args.length - 1] ?? '';
        if (ref.startsWith('refs/remotes/')) return { exitCode: 0 }; // origin/main exists
        return { exitCode: 1 }; // no local branch collides
      }
      return { exitCode: 0 };
    });

    await prepareWorktree({ ...BASE_INPUT, runCommand: run, branchName: 'ENG-1' });

    const addCall = calls.find((c) => c.args.includes('add'));
    assert.ok(addCall, 'expected a worktree add call');
    const base = addCall.args[addCall.args.length - 1];
    assert.equal(base, 'refs/remotes/origin/main');
    assert.notEqual(base, 'main', 'branching from the bare local name makes the fetch inert');
  });

  test('the base falls back to the bare local name when no remote-tracking ref exists', async () => {
    const { run, calls } = makeRunner((call) => (call.args.includes('show-ref') ? { exitCode: 1 } : { exitCode: 0 }));

    await prepareWorktree({ ...BASE_INPUT, runCommand: run, branchName: 'ENG-1' });

    const addCall = calls.find((c) => c.args.includes('add'));
    assert.equal(addCall?.args[addCall.args.length - 1], 'main');
  });

  /**
   * T125's third disagreement. The two cases above prove `worktree add` gets the right
   * ref; they cannot see that the ref was then DISCARDED. `prepareWorktree` returned only
   * `{ branch, path }`, so `deliver.ts` computed its diff range from the bare config
   * string and measured against a local base that T112 measured sitting 18 commits behind
   * its own origin. The returned value is the same variable the checkout used — not a
   * re-derivation, which is what the two-lookup defect was in the first place.
   */
  test('the ref the checkout used is RETURNED, so the fork point and the diff range agree', async () => {
    const { run, calls } = makeRunner((call) => {
      if (call.args.includes('show-ref')) {
        const ref = call.args[call.args.length - 1] ?? '';
        return ref.startsWith('refs/remotes/') ? { exitCode: 0 } : { exitCode: 1 };
      }
      return { exitCode: 0 };
    });

    const result = await prepareWorktree({ ...BASE_INPUT, runCommand: run, branchName: 'ENG-1' });

    const addCall = calls.find((c) => c.args.includes('add'));
    assert.equal(result.base, 'refs/remotes/origin/main');
    assert.equal(result.base, addCall?.args[addCall.args.length - 1], 'the SAME string, not a second answer');
  });

  test('the returned base is the bare fallback when no remote-tracking ref exists', async () => {
    const { run } = makeRunner((call) => (call.args.includes('show-ref') ? { exitCode: 1 } : { exitCode: 0 }));

    const result = await prepareWorktree({ ...BASE_INPUT, runCommand: run, branchName: 'ENG-1' });

    assert.equal(result.base, 'main');
  });
});

describe('finishWorktree', () => {
  for (const verdict of ['partial', 'failed', 'needs_input'] as const) {
    test(`issues nothing for verdict=${verdict}`, async () => {
      const { run, calls } = makeRunner(() => ({ exitCode: 0 }));

      await finishWorktree({ verdict, runCommand: run, repoPath: '/repo/a', path: '/daemon/worktrees/a/b' });

      assert.equal(calls.length, 0);
    });
  }

  test('issues worktree remove --force for verdict=delivered', async () => {
    const { run, calls } = makeRunner(() => ({ exitCode: 0 }));

    await finishWorktree({ verdict: 'delivered', runCommand: run, repoPath: '/repo/a', path: '/daemon/worktrees/a/b' });

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.args, ['-C', '/repo/a', 'worktree', 'remove', '--force', '/daemon/worktrees/a/b']);
  });
});


describe('reconcileWorktrees', () => {
  const DAEMON_DIR = '/Users/operator/.linear-auto-worker';

  function porcelainOf(paths: string[]): string {
    return paths
      .map((p) => `worktree ${p}\nHEAD abc123def456\nbranch refs/heads/some-branch\n`)
      .join('\n');
  }

  test('prunes worktrees under the daemon root with no referencing run row', async () => {
    const referenced = `${DAEMON_DIR}/worktrees/acme/ENG-1`;
    const unreferenced1 = `${DAEMON_DIR}/worktrees/acme/ENG-2`;
    const unreferencedWithSpace = `${DAEMON_DIR}/worktrees/acme/ENG-3 fix the thing`;

    const { run, calls } = makeRunner((call) => {
      if (call.args.includes('prune')) return { exitCode: 0 };
      if (call.args.includes('list')) {
        return { exitCode: 0, stdout: porcelainOf([referenced, unreferenced1, unreferencedWithSpace]) };
      }
      return { exitCode: 0 };
    });

    const result = await reconcileWorktrees({
      runCommand: run,
      daemonDir: DAEMON_DIR,
      repoPaths: ['/Users/operator/code/acme'],
      nonTerminalRuns: [{ runId: 'run-1', worktreePath: referenced }],
    });

    assert.deepEqual(result.pruned.sort(), [unreferenced1, unreferencedWithSpace].sort());
    assert.deepEqual(result.orphanedRuns, []);

    const pruneIdx = calls.findIndex((c) => c.args.includes('prune'));
    const listIdx = calls.findIndex((c) => c.args.includes('list'));
    assert.ok(pruneIdx >= 0 && listIdx >= 0 && pruneIdx < listIdx, 'prune must run before the listing is read');

    const removeCalls = calls.filter((c) => c.args.includes('remove'));
    assert.equal(removeCalls.length, 2);
    for (const rc of removeCalls) {
      assert.ok(rc.args.includes('--force'));
    }
    assert.deepEqual(
      removeCalls.map((c) => c.args[c.args.length - 1]).sort(),
      [unreferenced1, unreferencedWithSpace].sort()
    );
  });

  test('a worktree outside the daemon root is never removed even when unreferenced', async () => {
    const outside = '/Users/operator/code/some-other-project';
    const { run, calls } = makeRunner((call) => {
      if (call.args.includes('prune')) return { exitCode: 0 };
      if (call.args.includes('list')) return { exitCode: 0, stdout: porcelainOf([outside]) };
      return { exitCode: 0 };
    });

    const result = await reconcileWorktrees({
      runCommand: run,
      daemonDir: DAEMON_DIR,
      repoPaths: [outside],
      nonTerminalRuns: [],
    });

    assert.deepEqual(result.pruned, []);
    assert.ok(!calls.some((c) => c.args.includes('remove')), 'no removal argv may ever be issued for a path outside the daemon root');
  });

  test('a run row whose worktree path is absent from the listing is reported orphaned, no argv issued for it', async () => {
    const alive = `${DAEMON_DIR}/worktrees/acme/ENG-1`;
    const vanished = `${DAEMON_DIR}/worktrees/acme/ENG-vanished`;

    const { run, calls } = makeRunner((call) => {
      if (call.args.includes('prune')) return { exitCode: 0 };
      if (call.args.includes('list')) return { exitCode: 0, stdout: porcelainOf([alive]) };
      return { exitCode: 0 };
    });

    const result = await reconcileWorktrees({
      runCommand: run,
      daemonDir: DAEMON_DIR,
      repoPaths: ['/Users/operator/code/acme'],
      nonTerminalRuns: [
        { runId: 'run-alive', worktreePath: alive },
        { runId: 'run-orphaned', worktreePath: vanished },
      ],
    });

    assert.deepEqual(result.orphanedRuns, ['run-orphaned']);
    assert.deepEqual(result.pruned, []);
    assert.ok(!calls.some((c) => c.args.some((a) => a.includes('ENG-vanished'))));
  });

  test('the porcelain parser handles multiple repos and blank-line-delimited records', async () => {
    const a1 = `${DAEMON_DIR}/worktrees/acme/ENG-1`;
    const b1 = `${DAEMON_DIR}/worktrees/beta/ENG-9`;

    const { run } = makeRunner((call) => {
      if (call.args.includes('prune')) return { exitCode: 0 };
      if (call.args.includes('list')) {
        const repoPath = call.args[1];
        if (repoPath === '/repo/acme') return { exitCode: 0, stdout: porcelainOf([a1]) };
        if (repoPath === '/repo/beta') return { exitCode: 0, stdout: porcelainOf([b1]) };
      }
      return { exitCode: 0 };
    });

    const result = await reconcileWorktrees({
      runCommand: run,
      daemonDir: DAEMON_DIR,
      repoPaths: ['/repo/acme', '/repo/beta'],
      nonTerminalRuns: [
        { runId: 'run-a', worktreePath: a1 },
        { runId: 'run-b', worktreePath: b1 },
      ],
    });

    assert.deepEqual(result.pruned, []);
    assert.deepEqual(result.orphanedRuns, []);
  });
});
