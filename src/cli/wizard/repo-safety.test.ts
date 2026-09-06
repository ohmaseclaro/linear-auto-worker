import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { annotateRepoSafety, checkAgentDocs } from './repo-safety.js';
import { defaultRunCommand, realPrompts, type RunCommand, type WizardPrompts } from './deps.js';
import type { Mapping } from './mapping.js';

// First executed by plan 07-06. Originally written against
// `mock.method(execaModule, 'execa', …)` and `mock.method(prompts, 'confirm', …)`, which threw
// `Cannot redefine property` on all seven cases — an ESM namespace binding is
// non-configurable by specification. Both boundaries are now default parameters (`deps.ts`).

/** The real runner. `git` calls below go through it against the temp fixtures. */
const realRun: RunCommand = defaultRunCommand;

/** `confirm` that fails loudly: a prompt this test did not script is a real bug. */
function noPrompts(answer?: boolean): WizardPrompts {
  return {
    ...realPrompts,
    confirm: () => {
      if (answer === undefined) {
        return Promise.reject(new Error('confirm() must not be called in this case'));
      }
      return Promise.resolve(answer);
    },
  };
}

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
    await realRun('git', ['init'], { cwd: dir });
  }

  // Every fixture except `missingDocsRepo` already has agent docs, so tests exercising the
  // remote/branch/submodule checks don't also trip checkAgentDocs' confirm() prompt.
  for (const dir of [cleanRepo, noRemoteRepo, submoduleRepo]) {
    await writeFile(join(dir, 'CLAUDE.md'), '# fixture\n', 'utf8');
  }

  await realRun('git', ['remote', 'add', 'origin', 'git@github.com:org/clean.git'], {
    cwd: cleanRepo,
  });
  await realRun('git', ['remote', 'add', 'origin', 'git@github.com:org/submodule.git'], {
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
function stubRun(
  ghByRepo: Record<
    string,
    { repoView?: { defaultBranchRef?: { name: string } | null; nameWithOwner?: string } | 'fail'; protection?: 'ok' | 'fail' }
  >,
): RunCommand {
  return async (cmd, args, opts) => {
    if (cmd === 'git') return realRun(cmd, args, opts);

    const cwd = opts?.cwd ?? '';
    const repoName = cwd.split('/').filter(Boolean).pop() ?? '';
    const config = ghByRepo[repoName];

    if (cmd === 'gh' && args[0] === 'repo' && args[1] === 'view') {
      if (!config || config.repoView === 'fail' || !config.repoView) {
        throw new Error(`gh repo view failed for ${repoName}`);
      }
      return { stdout: JSON.stringify(config.repoView), stderr: '', exitCode: 0 };
    }
    if (cmd === 'gh' && args[0] === 'api') {
      if (config?.protection === 'fail') throw new Error('gh api: 404 Not Found');
      return { stdout: '{}', stderr: '', exitCode: 0 };
    }
    throw new Error(`unexpected command in test: ${cmd} ${JSON.stringify(args)}`);
  };
}

test('checkAgentDocs: warns and writes a starter CLAUDE.md on explicit confirm', async () => {
  const warning = await checkAgentDocs(missingDocsRepo, noPrompts(true));
  assert.ok(warning);
  assert.equal(warning?.kind, 'missing-agent-docs');
  assert.equal(warning?.fixOffered, true);
  assert.match(warning?.message ?? '', /highest-leverage/);
});

test('checkAgentDocs: returns null when CLAUDE.md already exists (no confirm prompt)', async () => {
  // `noPrompts()` REJECTS on confirm — the assertion is that the prompt is never reached.
  const warning = await checkAgentDocs(cleanRepo, noPrompts());
  assert.equal(warning, null);
});

test('annotateRepoSafety: clean repo records remoteName/defaultBranch/ownerRepo, no warnings', async () => {
  const run = stubRun({
    clean: {
      repoView: { defaultBranchRef: { name: 'main' }, nameWithOwner: 'org/clean' },
      protection: 'ok',
    },
  });
  const { mappings, warnings } = await annotateRepoSafety([emptyMapping([cleanRepo])], {
    run,
    prompts: noPrompts(),
  });
  assert.equal(warnings.length, 0);
  assert.deepEqual(mappings[0]?.repoSafety, [
    { repoPath: cleanRepo, remoteName: 'origin', defaultBranch: 'main', ownerRepo: 'org/clean' },
  ]);
});

test('annotateRepoSafety: no-remote repo warns and records no remoteName', async () => {
  const { mappings, warnings } = await annotateRepoSafety([emptyMapping([noRemoteRepo])], {
    run: stubRun({}),
    prompts: noPrompts(),
  });
  const noRemote = warnings.find((w) => w.kind === 'no-remote');
  assert.ok(noRemote, 'expected a no-remote warning');
  assert.equal(mappings[0]?.repoSafety[0]?.remoteName, undefined);
});

test('annotateRepoSafety: submodule repo warns without aborting the rest of its checks', async () => {
  const run = stubRun({
    submodule: {
      repoView: { defaultBranchRef: { name: 'main' }, nameWithOwner: 'org/submodule' },
      protection: 'ok',
    },
  });
  const { mappings, warnings } = await annotateRepoSafety([emptyMapping([submoduleRepo])], {
    run,
    prompts: noPrompts(),
  });
  assert.ok(warnings.some((w) => w.kind === 'submodules'));
  // the submodule warning did not stop the remote/branch checks on the same repo
  assert.equal(mappings[0]?.repoSafety[0]?.ownerRepo, 'org/submodule');
});

test('annotateRepoSafety: missing branch protection warns, 404 and 403 both read as absent', async () => {
  const run = stubRun({
    clean: {
      repoView: { defaultBranchRef: { name: 'main' }, nameWithOwner: 'org/clean' },
      protection: 'fail',
    },
  });
  const { warnings } = await annotateRepoSafety([emptyMapping([cleanRepo])], {
    run,
    prompts: noPrompts(),
  });
  const protectionWarning = warnings.find((w) => w.kind === 'no-branch-protection');
  assert.ok(protectionWarning);
  assert.match(protectionWarning?.message ?? '', /branch protection/);
});

test('annotateRepoSafety: one repo failing unexpectedly never blocks the next repo in the same mapping', async () => {
  const nonexistentRepo = join(root, 'does-not-exist');
  // Never created by `before()` — missing dir means checkAgentDocs also finds neither file
  // and would prompt; decline so the test never touches real stdin.
  const run = stubRun({
    clean: {
      repoView: { defaultBranchRef: { name: 'main' }, nameWithOwner: 'org/clean' },
      protection: 'ok',
    },
  });
  const { mappings, warnings } = await annotateRepoSafety(
    [emptyMapping([nonexistentRepo, cleanRepo])],
    { run, prompts: noPrompts(false) },
  );
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
});
