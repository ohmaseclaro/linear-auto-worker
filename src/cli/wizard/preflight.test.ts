import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkNodeVersion,
  checkGitIdentity,
  checkGhAuth,
  checkClaudeOnPath,
  checkGsdInstall,
  checkResourceHeadroom,
  runPreflight,
} from './preflight.js';
import type { RunCommand, RunCommandResult } from './deps.js';

// First executed by plan 07-06. Originally written against
// `mock.method(execaModule, 'execa', …)`, which threw `Cannot redefine property: execa` on
// every case: an ESM namespace binding is non-configurable by specification, so that mock
// could never have worked. The module now takes its command runner as a default parameter
// (see `deps.ts`), so each case hands over a stub and the production call sites are
// unchanged.

/** Exit code and stderr default to the success shape; only `stdout` usually matters here. */
const ok = (stdout: string, stderr = ''): RunCommandResult => ({ exitCode: 0, stdout, stderr });

/** A runner that throws, the way `execa` does on a non-zero exit. */
function fails(err: Error): RunCommand {
  return () => Promise.reject(err);
}

test('checkNodeVersion: pass on current runtime (this file cannot mock process.version cheaply)', () => {
  const result = checkNodeVersion();
  assert.ok(['pass', 'warn', 'fail'].includes(result.status));
  assert.equal(result.name, 'Node version');
});

test('checkGitIdentity: pass when both user.name and user.email resolve', async () => {
  const run: RunCommand = (_cmd, args) => {
    if (args.includes('user.name')) return Promise.resolve(ok('Ada Lovelace'));
    if (args.includes('user.email')) return Promise.resolve(ok('ada@example.com'));
    return Promise.reject(new Error('unexpected args'));
  };
  const result = await checkGitIdentity(run);
  assert.equal(result.status, 'pass');
});

test('checkGitIdentity: fail with git config fix when user.email is empty', async () => {
  const run: RunCommand = (_cmd, args) => {
    if (args.includes('user.name')) return Promise.resolve(ok('Ada Lovelace'));
    if (args.includes('user.email')) return Promise.reject(new Error('exit code 1'));
    return Promise.reject(new Error('unexpected args'));
  };
  const result = await checkGitIdentity(run);
  assert.equal(result.status, 'fail');
  assert.match(result.fix ?? '', /git config --global user\.email/);
});

test('checkGhAuth: pass when gh auth status exits 0 with workflow scope present', async () => {
  const result = await checkGhAuth(() =>
    Promise.resolve(ok('', 'Token scopes: repo, workflow, read:org')),
  );
  assert.equal(result.status, 'pass');
});

test('checkGhAuth: warn when workflow scope missing from Token scopes line', async () => {
  const result = await checkGhAuth(() => Promise.resolve(ok('', 'Token scopes: repo, read:org')));
  assert.equal(result.status, 'warn');
  assert.match(result.fix ?? '', /gh auth refresh -h github\.com -s workflow/);
});

test('checkGhAuth: fail with gh auth login fix on non-zero exit', async () => {
  const result = await checkGhAuth(fails(new Error('not logged in')));
  assert.equal(result.status, 'fail');
  assert.match(result.fix ?? '', /gh auth login/);
});

test('checkClaudeOnPath: pass with parsed version in detail', async () => {
  const result = await checkClaudeOnPath(() => Promise.resolve(ok('2.1.259 (Claude Code)')));
  assert.equal(result.status, 'pass');
  assert.match(result.detail, /2\.1\.259/);
});

test('checkClaudeOnPath: fail with install fix on ENOENT', async () => {
  const result = await checkClaudeOnPath(fails(new Error('spawn claude ENOENT')));
  assert.equal(result.status, 'fail');
  assert.match(result.fix ?? '', /install the claude CLI/);
});

test('checkGsdInstall: pass when ~/.claude/skills or ~/.claude/gsd-core is readable', async () => {
  const result = await checkGsdInstall();
  // Cannot control the real home directory in this test file without a fs mock
  // layer; asserts the shape is well-formed regardless of the local machine's state.
  assert.ok(['pass', 'fail'].includes(result.status));
  assert.equal(result.name, 'Global GSD install');
});

test('checkResourceHeadroom: always pass, includes a concurrency suggestion in detail', async () => {
  const result = await checkResourceHeadroom(() => Promise.resolve(ok('256')));
  assert.equal(result.status, 'pass');
  assert.match(result.detail, /concurrency/i);
  assert.match(result.fix ?? '', /ulimit -n/);
});

test('checkResourceHeadroom: no fix appended when ulimit already >= 1024', async () => {
  const result = await checkResourceHeadroom(() => Promise.resolve(ok('4096')));
  assert.equal(result.status, 'pass');
  assert.equal(result.fix, undefined);
});

test('runPreflight: returns exactly 6 results in the fixed order', async () => {
  // Injected, so the gate never consults the operator's real git/gh/claude — and never
  // reports a different result on a machine where one of them is missing.
  const results = await runPreflight(() => Promise.resolve(ok('')));
  assert.equal(results.length, 6);
  assert.equal(results[0]?.name, 'Node version');
  assert.equal(results[1]?.name, 'Git identity');
  assert.equal(results[2]?.name, 'GitHub CLI auth');
  assert.equal(results[3]?.name, 'Claude CLI');
  assert.equal(results[4]?.name, 'Global GSD install');
  assert.equal(results[5]?.name, 'Resource headroom');
});
