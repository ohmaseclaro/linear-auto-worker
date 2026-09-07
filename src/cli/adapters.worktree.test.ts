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
import { mkdtemp, rm } from 'node:fs/promises';
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
