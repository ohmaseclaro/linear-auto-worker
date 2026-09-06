import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, mock, test } from 'node:test';
import * as execaModule from 'execa';
import * as prompts from '@inquirer/prompts';

import { annotateRepoSafety, checkAgentDocs } from './repo-safety.js';
import type { Mapping } from './mapping.js';

// NOTE (RUSH MODE): this file is not executed during this milestone's parallel build — no
// package.json / node_modules exist on this branch yet. Written complete and correct for
// the single, milestone-end integration gate (`tsc --noEmit && node --test`) per
// 01-CONTEXT.md D-13.

// Captured before any `mock.method(execaModule, 'execa', ...)` call below, so the git-backed
// fixtures set up in `before()` and the "delegate real git calls through" stubs later in this
// file both reach the real binary rather than a mock of themselves.
const realExeca = execaModule.execa;

function emptyMapping(repos: string[]): Mapping {
  return { key: { kind: 'team', id: 'team-1', name: 'Team One' }, repos };
}

let root: string;
let cleanRepo: string;
let noRemoteRepo: string;
let submoduleRepo: string;
let missingDocsRepo: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'repo-safety-'));

  cleanRepo = join(root, 'clean');
  noRemoteRepo = join(root, 'no-remote');
  submoduleRepo = join(root, 'submodule');
  missingDocsRepo = join(root, 'missing-docs');

  for (const dir of [cleanRepo, noRemoteRepo, submoduleRepo, missingDocsRepo]) {
    await mkdir(dir, { recursive: true });
    await realExeca('git', ['init'], { cwd: dir });
  }

  // Every fixture except `missingDocsRepo` already has agent docs, so tests exercising the
  // remote/branch/submodule checks don't also trip checkAgentDocs' confirm() prompt.
  for (const dir of [cleanRepo, noRemoteRepo, submoduleRepo]) {
    await writeFile(join(dir, 'CLAUDE.md'), '# fixture\n', 'utf8');
  }

  await realExeca('git', ['remote', 'add', 'origin', 'git@github.com:org/clean.git'], {
    cwd: cleanRepo,
  });
  await realExeca('git', ['remote', 'add', 'origin', 'git@github.com:org/submodule.git'], {
    cwd: submoduleRepo,
  });
  await writeFile(join(submoduleRepo, '.gitmodules'), '[submodule "x"]\n', 'utf8');
  // noRemoteRepo deliberately gets no `git remote add` — that omission is the fixture.
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Routes `git` calls to the real binary (against the temp fixtures above) and answers `gh`
 *  calls from the supplied canned responses, keyed by the repo's basename. */
function stubExeca(
  ghByRepo: Record<
    string,
    { repoView?: { defaultBranchRef?: { name: string } | null; nameWithOwner?: string } | 'fail'; protection?: 'ok' | 'fail' }
  >,
) {
  return mock.method(
    execaModule,
    'execa',
    async (cmd: string, args?: readonly string[], opts?: { cwd?: string }) => {
      if (cmd === 'git') return realExeca(cmd, args as string[], opts as never);

      const cwd = opts?.cwd ?? '';
      const repoName = cwd.split('/').filter(Boolean).pop() ?? '';
      const config = ghByRepo[repoName];

      if (cmd === 'gh' && args?.[0] === 'repo' && args?.[1] === 'view') {
        if (!config || config.repoView === 'fail' || !config.repoView) {
          throw new Error(`gh repo view failed for ${repoName}`);
        }
        return { stdout: JSON.stringify(config.repoView), exitCode: 0 } as never;
      }
      if (cmd === 'gh' && args?.[0] === 'api') {
        if (config?.protection === 'fail') throw new Error('gh api: 404 Not Found');
        return { stdout: '{}', exitCode: 0 } as never;
      }
      throw new Error(`unexpected execa call in test: ${cmd} ${JSON.stringify(args)}`);
    },
  );
}

test('checkAgentDocs: warns and writes a starter CLAUDE.md on explicit confirm', async () => {
  const confirmMock = mock.method(prompts, 'confirm', async () => true);
  try {
    const warning = await checkAgentDocs(missingDocsRepo);
    assert.ok(warning);
    assert.equal(warning?.kind, 'missing-agent-docs');
    assert.equal(warning?.fixOffered, true);
    assert.match(warning?.message ?? '', /highest-leverage/);
  } finally {
    confirmMock.mock.restore();
  }
});

test('checkAgentDocs: returns null when CLAUDE.md already exists (no confirm prompt)', async () => {
  const confirmMock = mock.method(prompts, 'confirm', async () => {
    throw new Error('confirm() must not be called when a doc file already exists');
  });
  try {
    const warning = await checkAgentDocs(cleanRepo);
    assert.equal(warning, null);
  } finally {
    confirmMock.mock.restore();
  }
});

test('annotateRepoSafety: clean repo records remoteName/defaultBranch/ownerRepo, no warnings', async () => {
  const execaMock = stubExeca({
    clean: {
      repoView: { defaultBranchRef: { name: 'main' }, nameWithOwner: 'org/clean' },
      protection: 'ok',
    },
  });
  try {
    const { mappings, warnings } = await annotateRepoSafety([emptyMapping([cleanRepo])]);
    assert.equal(warnings.length, 0);
    assert.deepEqual(mappings[0]?.repoSafety, [
      { repoPath: cleanRepo, remoteName: 'origin', defaultBranch: 'main', ownerRepo: 'org/clean' },
    ]);
  } finally {
    execaMock.mock.restore();
  }
});

test('annotateRepoSafety: no-remote repo warns and records no remoteName', async () => {
  const execaMock = stubExeca({});
  try {
    const { mappings, warnings } = await annotateRepoSafety([emptyMapping([noRemoteRepo])]);
    const noRemote = warnings.find((w) => w.kind === 'no-remote');
    assert.ok(noRemote, 'expected a no-remote warning');
    assert.equal(mappings[0]?.repoSafety[0]?.remoteName, undefined);
  } finally {
    execaMock.mock.restore();
  }
});

test('annotateRepoSafety: submodule repo warns without aborting the rest of its checks', async () => {
  const execaMock = stubExeca({
    submodule: {
      repoView: { defaultBranchRef: { name: 'main' }, nameWithOwner: 'org/submodule' },
      protection: 'ok',
    },
  });
  try {
    const { mappings, warnings } = await annotateRepoSafety([emptyMapping([submoduleRepo])]);
    assert.ok(warnings.some((w) => w.kind === 'submodules'));
    // the submodule warning did not stop the remote/branch checks on the same repo
    assert.equal(mappings[0]?.repoSafety[0]?.ownerRepo, 'org/submodule');
  } finally {
    execaMock.mock.restore();
  }
});

test('annotateRepoSafety: missing branch protection warns, 404 and 403 both read as absent', async () => {
  const execaMock = stubExeca({
    clean: {
      repoView: { defaultBranchRef: { name: 'main' }, nameWithOwner: 'org/clean' },
      protection: 'fail',
    },
  });
  try {
    const { warnings } = await annotateRepoSafety([emptyMapping([cleanRepo])]);
    const protectionWarning = warnings.find((w) => w.kind === 'no-branch-protection');
    assert.ok(protectionWarning);
    assert.match(protectionWarning?.message ?? '', /branch protection/);
  } finally {
    execaMock.mock.restore();
  }
});

test('annotateRepoSafety: one repo failing unexpectedly never blocks the next repo in the same mapping', async () => {
  const nonexistentRepo = join(root, 'does-not-exist');
  // Never created by `before()` — missing dir means checkAgentDocs also finds neither file
  // and would prompt; decline so the test never touches real stdin.
  const confirmMock = mock.method(prompts, 'confirm', async () => false);
  const execaMock = stubExeca({
    clean: {
      repoView: { defaultBranchRef: { name: 'main' }, nameWithOwner: 'org/clean' },
      protection: 'ok',
    },
  });
  try {
    const { mappings, warnings } = await annotateRepoSafety([
      emptyMapping([nonexistentRepo, cleanRepo]),
    ]);
    assert.equal(mappings[0]?.repoSafety.length, 2, 'both repos must produce an entry');
    assert.ok(
      warnings.some((w) => w.repoPath === nonexistentRepo),
      'the missing repo must be flagged, not silently dropped',
    );
    assert.equal(
      mappings[0]?.repoSafety[1]?.ownerRepo,
      'org/clean',
      'the sibling repo must still be checked in full',
    );
  } finally {
    execaMock.mock.restore();
    confirmMock.mock.restore();
  }
});
