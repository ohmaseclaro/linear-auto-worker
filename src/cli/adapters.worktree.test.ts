/**
 * T112 — the worktree's base ref, proven through the live call path.
 *
 * `prepareWorktree` fetched and then branched from `o.base`, the bare config string
 * `"main"`. A fetch advances `refs/remotes/origin/main` and never moves `refs/heads/main`,
 * so the fetch was inert and every run forked off whatever the operator last pulled.
 * Measured live: `~/ohmaseclaro/kardun` sat 18 commits behind its own `origin/main`.
 *
 * Real git, no doubles, driven through `createWorktreeManager` — the same factory
 * `daemon.ts:539` constructs — because no fake can tell you which commit a worktree
 * actually landed on, and a unit test inside `worktree.ts` cannot tell you the adapter
 * still calls it.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createWorktreeManager } from './adapters.js';
import { makeScratchRepo } from './daemon-fixture.js';
import { defaultRunCommand } from '../execution/execute-run.js';
import type { Config, RepoMapping } from '../domain/ports.js';
import type { RunId } from '../domain/types.js';

const silent = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => silent,
} as never;

/** `create` reads neither store nor log nor index — stub them as adapters.verdict.test.ts does. */
const store = { getRun: () => undefined, updateRun: () => undefined } as never;

const git = (cwd: string, ...args: string[]) => defaultRunCommand('git', ['-C', cwd, ...args]);

async function headOf(repo: string): Promise<string> {
  return (await git(repo, 'rev-parse', 'HEAD')).stdout.trim();
}

function managerFor(dir: string) {
  // daemonDirOf = path.dirname(worktreeRoot), and prepareWorktree asserts containment
  // against that parent — so the root must be one level down inside the tmp dir.
  const config = { worktreeRoot: join(dir, 'daemon', 'worktrees') } as unknown as Config;
  return createWorktreeManager({ store, config, log: silent, index: new Map(), runCommand: defaultRunCommand });
}

function mappingFor(repoDir: string): RepoMapping {
  return { repoDir, repoSlug: 'o/r', baseBranch: 'main', enabled: true } as RepoMapping;
}

test('a clone whose local main is behind origin/main gets a worktree at the REMOTE tip', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'law-wt-remote-'));
  try {
    const upstream = await makeScratchRepo(dir, 'main');
    const clone = join(dir, 'clone');
    await defaultRunCommand('git', ['clone', '--quiet', upstream, clone]);

    // One further commit in the UPSTREAM only: the clone's local `main` is now behind its
    // own remote-tracking ref, exactly as kardun was.
    await git(upstream, 'commit', '--quiet', '--allow-empty', '-m', 'ahead of the clone');
    const upstreamTip = await headOf(upstream);
    const staleLocal = await headOf(clone);
    assert.notEqual(upstreamTip, staleLocal, 'setup: the clone must actually be behind');

    const worktree = await managerFor(dir).create('run-1' as RunId, mappingFor(clone), 'ENG-1');

    assert.equal(await headOf(worktree.path), upstreamTip);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a repo with no origin at all still gets a worktree — the fallback is required', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'law-wt-noremote-'));
  try {
    const repo = await makeScratchRepo(dir, 'main');
    const only = await headOf(repo);

    // The fetch here fails (no remote). It must stay swallowed: this is the offline path.
    const worktree = await managerFor(dir).create('run-2' as RunId, mappingFor(repo), 'ENG-2');

    assert.equal(await headOf(worktree.path), only);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * T125, through the same real-git instrument. The two cases above prove the worktree
 * lands on the remote tip; neither can see whether the ref that put it there survives to
 * the diff range. `Worktree.baseBranch` is what `deliver.ts` computes `<base>..HEAD` from
 * and what `gatherEvidence` counts commits against, so this is the assertion that catches
 * the fork point and the diff range being two different strings.
 */
test('the ref actually branched from reaches Worktree.baseBranch, not the bare config name', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'law-wt-baseref-'));
  try {
    const upstream = await makeScratchRepo(dir, 'main');
    const clone = join(dir, 'clone');
    await defaultRunCommand('git', ['clone', '--quiet', upstream, clone]);
    await git(upstream, 'commit', '--quiet', '--allow-empty', '-m', 'ahead of the clone');
    const upstreamTip = await headOf(upstream);

    const worktree = await managerFor(dir).create('run-3' as RunId, mappingFor(clone), 'ENG-3');

    assert.equal(worktree.baseBranch, 'refs/remotes/origin/main');
    // And it is a ref git can actually resolve FROM INSIDE the worktree, to the commit the
    // branch was cut at — which is what makes `<base>..HEAD` mean "this run's commits".
    assert.equal((await git(worktree.path, 'rev-parse', worktree.baseBranch)).stdout.trim(), upstreamTip);
    // The bare local name resolves to the STALE commit. That is the wrong answer, on disk,
    // measured — 1 phantom commit in the range where the run committed nothing.
    const stale = (await git(worktree.path, 'rev-parse', 'main')).stdout.trim();
    assert.notEqual(stale, upstreamTip);
    const phantom = await git(worktree.path, 'log', '--oneline', 'main..HEAD');
    assert.equal(phantom.stdout.trim().split('\n').filter((l) => l.length > 0).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * The shared parent, through the real factory and real git. `readdir(parent)` returning
 * exactly the ticket's repositories is the literal statement of the isolation property —
 * a directory whose only contents are those worktrees — and no fake can make it.
 */
test('three repos of one ticket land under one parent whose only entries are those three', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'law-wt-parent-'));
  try {
    const manager = managerFor(dir);
    const daemonDir = join(dir, 'daemon');
    const parent = join(daemonDir, 'tickets', 'parent-uuid');
    await mkdir(parent, { recursive: true });

    const slugs = ['org/api', 'org/web', 'org/infra'];
    const paths: string[] = [];
    for (const [i, slug] of slugs.entries()) {
      const src = await makeScratchRepo(await mkdtemp(join(dir, `src-${i}-`)), 'main');
      const mapping = { repoDir: src, repoSlug: slug, baseBranch: 'main', enabled: true } as RepoMapping;
      const wt = await manager.create(`run-p${i}` as RunId, mapping, `ENG-9-${i}`, parent);
      paths.push(wt.path);
      // The leaf is the REPOSITORY, flattened — so `orgA/api` and `orgB/api` in one
      // mapping cannot collide on `api` and fail one child.
      assert.equal(wt.path, join(parent, slug.replace('/', '-')));
    }

    assert.deepEqual((await readdir(parent)).sort(), ['org-api', 'org-infra', 'org-web']);
    // Every one is a real worktree on a real branch, not just a directory.
    for (const p of paths) {
      assert.equal((await git(p, 'rev-parse', '--is-inside-work-tree')).stdout.trim(), 'true');
      assert.notEqual((await git(p, 'symbolic-ref', '--short', 'HEAD')).stdout.trim(), '');
    }
    // And nothing escaped the daemon root, which is what `reconcileWorktrees` relies on.
    for (const p of paths) assert.ok(p.startsWith(daemonDir + '/'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
