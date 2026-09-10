import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverRepos } from './repo-discovery.js';
import { defaultRunCommand } from '../../execution/execute-run.js';

// NOTE (RUSH MODE): not executed during this milestone's parallel build — no
// node_modules exist on this branch yet. Written complete and correct for the
// milestone-end integration gate (`tsc --noEmit && node --test`, 01-CONTEXT D-13).
// This is a pure filesystem function, so it exercises a real temp directory tree
// rather than mocking fs.

let tmp: string;

before(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'law-repo-discovery-'));

  // depth 0: root itself is a git repo (should stop scanning here entirely)
  // -- built in its own subtest via a separate temp dir, see below.

  // depth 1 + depth 2 fixture, rooted at tmp/mixed:
  //   mixed/a/.git           -> repo at depth 1
  //   mixed/b/               -> not a repo
  //   mixed/b/c/.git         -> repo at depth 2 (reachable)
  //   mixed/b/c/d/.git       -> repo at depth 3 (NOT reachable, past cap)
  //   mixed/node_modules/.git -> must be skipped (name skip)
  //   mixed/.hidden/.git      -> must be skipped (dotdir skip)
  //   mixed/loop -> symlink to mixed (must not be followed)
  const mixed = join(tmp, 'mixed');
  await mkdir(join(mixed, 'a', '.git'), { recursive: true });
  await mkdir(join(mixed, 'b', 'c', '.git'), { recursive: true });
  await mkdir(join(mixed, 'b', 'c', 'd', '.git'), { recursive: true });
  await mkdir(join(mixed, 'node_modules', '.git'), { recursive: true });
  await mkdir(join(mixed, '.hidden', '.git'), { recursive: true });
  await mkdir(join(mixed, 'unreadable'), { recursive: true });
  await writeFile(join(mixed, 'unreadable', 'placeholder'), '');
  try {
    await chmod(join(mixed, 'unreadable'), 0o000);
  } catch {
    // best-effort — some CI environments (e.g. running as root) ignore chmod 000
  }
  await symlink(mixed, join(mixed, 'loop'), 'dir');

  // depth 0 fixture: root is itself a repo
  await mkdir(join(tmp, 'is-a-repo', '.git'), { recursive: true });
});

after(async () => {
  // restore perms so rm can clean up even where chmod 000 took effect
  try {
    await chmod(join(tmp, 'mixed', 'unreadable'), 0o755);
  } catch {
    // ignore
  }
  await rm(tmp, { recursive: true, force: true });
});

test('discoverRepos: root itself a git repo returns one entry, does not descend', async () => {
  const root = join(tmp, 'is-a-repo');
  const results = await discoverRepos(root);
  assert.equal(results.length, 1);
  assert.equal(results[0]?.path, root);
  assert.equal(results[0]?.name, 'is-a-repo');
});

test('discoverRepos: finds repos at depth 1 and depth 2, not depth 3, not node_modules/dotdir', async () => {
  const root = join(tmp, 'mixed');
  const results = await discoverRepos(root);
  const paths = results.map((r) => r.path).sort();

  assert.ok(paths.includes(join(root, 'a')), 'depth-1 repo "a" should be found');
  assert.ok(paths.includes(join(root, 'b', 'c')), 'depth-2 repo "b/c" should be found');
  assert.ok(
    !paths.includes(join(root, 'b', 'c', 'd')),
    'depth-3 repo "b/c/d" is past the cap and must not be found',
  );
  assert.ok(
    !paths.some((p) => p.includes('node_modules')),
    'node_modules must never be descended into',
  );
  assert.ok(
    !paths.some((p) => p.includes('.hidden')),
    'dotdirs must never be descended into',
  );
});

test('discoverRepos: never follows symlinked directories (no infinite loop, no duplicate entries)', async () => {
  const root = join(tmp, 'mixed');
  const results = await discoverRepos(root);
  // If the "loop" symlink were followed, this would either hang or produce
  // duplicate/extra entries for "a" and "b/c" reached via mixed/loop/...
  const aOccurrences = results.filter((r) => r.name === 'a').length;
  assert.equal(aOccurrences, 1);
});

test('discoverRepos: an unreadable subdirectory is skipped, not thrown', async () => {
  const root = join(tmp, 'mixed');
  // Should resolve without throwing even though "unreadable" has no permissions.
  await assert.doesNotReject(discoverRepos(root));
});

// ── T127: a linked worktree is not a repository to map ───────────────────────
//
// `hasGitEntry` asked only whether an entry NAMED `.git` existed; `readdir` had already
// told it whether that entry was a file or a directory. Measured on the operator's own
// root: 33 directories bear a `.git` entry, of which 12 have it as a DIRECTORY (real
// clones) and 21 as a FILE (linked worktrees) — and `git rev-parse --git-common-dir`
// resolves all 33 to 12 repositories.
//
// Built with real `git worktree add`, deliberately: the property under test is what git
// actually produces, and a hand-written `.git` file would pass against a rule that only
// happens to match the shape someone typed.

const git = (cwd: string, ...args: string[]): Promise<unknown> =>
  defaultRunCommand('git', ['-C', cwd, ...args]);

async function realRepo(dir: string, name: string): Promise<string> {
  const repo = join(dir, name);
  await mkdir(repo, { recursive: true });
  await defaultRunCommand('git', ['init', '--quiet', '--initial-branch=main', repo]);
  await git(repo, 'config', 'user.email', 'fixture@example.invalid');
  await git(repo, 'config', 'user.name', 'Fixture');
  await writeFile(join(repo, 'README.md'), '# x\n', 'utf8');
  await git(repo, 'add', 'README.md');
  await git(repo, 'commit', '--quiet', '-m', 'initial');
  return repo;
}

test('a real clone and a linked worktree OF IT: only the clone is offered', async () => {
  const root = await mkdtemp(join(tmpdir(), 'law-wt-picker-'));
  try {
    const clone = await realRepo(root, 'app');
    // Sibling of the clone, inside the scanned root — exactly the operator's layout.
    await git(clone, 'worktree', 'add', '--quiet', '-b', 'feature-x', join(root, 'app-feature-x'));

    const found = await discoverRepos(root);

    assert.deepEqual(found.map((r) => r.name), ['app']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a submodule is not offered as a repository of its own', async () => {
  const root = await mkdtemp(join(tmpdir(), 'law-sub-picker-'));
  try {
    const child = await realRepo(root, 'lib-src');
    const parent = await realRepo(join(root, 'nest'), 'parent');
    await git(parent, '-c', 'protocol.file.allow=always', 'submodule', '--quiet', 'add', child, 'vendor/lib');
    await git(parent, 'commit', '--quiet', '-m', 'add submodule');

    // Scan the parent's own directory: `vendor/lib` carries `.git` as a FILE.
    const found = await discoverRepos(join(root, 'nest'));

    assert.deepEqual(found.map((r) => r.name), ['parent'], 'the parent clone, and nothing inside it');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * The behaviour change the type check brings with it, chosen and asserted rather than
 * discovered: `scan` used to `return` at any `.git` entry, so a linked worktree SHADOWED
 * whatever was nested inside it. Making a worktree "not a repo" could have turned that
 * shadow off and started surfacing nested clones the operator never asked about.
 *
 * It does not: a directory whose `.git` is a FILE is skipped AND not descended into. A
 * clone nested inside a worktree is vendored or scratch work, not something to map.
 */
test('a nested clone inside a linked worktree stays shadowed, not newly surfaced', async () => {
  const root = await mkdtemp(join(tmpdir(), 'law-wt-nested-'));
  try {
    const clone = await realRepo(root, 'app');
    const wt = join(root, 'app-feature-x');
    await git(clone, 'worktree', 'add', '--quiet', '-b', 'feature-x', wt);
    await realRepo(wt, 'vendored');

    const found = await discoverRepos(root);

    assert.deepEqual(found.map((r) => r.name), ['app']);
    assert.ok(!found.some((r) => r.name === 'vendored'), 'the worktree is skipped, not descended into');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
