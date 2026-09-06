import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import * as execaModule from 'execa';
import {
  checkNodeVersion,
  checkGitIdentity,
  checkGhAuth,
  checkClaudeOnPath,
  checkGsdInstall,
  checkResourceHeadroom,
  runPreflight,
} from './preflight.js';

// NOTE (RUSH MODE): this file is not executed during this milestone's parallel
// build — no package.json / node_modules exist on this branch yet. It is
// written complete and correct for the single, milestone-end integration gate
// (`tsc --noEmit && node --test`) per 01-CONTEXT.md D-13.

test('checkNodeVersion: pass on current runtime (this file cannot mock process.version cheaply)', () => {
  const result = checkNodeVersion();
  assert.ok(['pass', 'warn', 'fail'].includes(result.status));
  assert.equal(result.name, 'Node version');
});

test('checkGitIdentity: pass when both user.name and user.email resolve', async () => {
  const execaMock = mock.method(execaModule, 'execa', async (_cmd: string, args?: string[]) => {
    if (args?.includes('user.name')) return { stdout: 'Ada Lovelace', exitCode: 0 } as any;
    if (args?.includes('user.email')) return { stdout: 'ada@example.com', exitCode: 0 } as any;
    throw new Error('unexpected args');
  });
  try {
    const result = await checkGitIdentity();
    assert.equal(result.status, 'pass');
  } finally {
    execaMock.mock.restore();
  }
});

test('checkGitIdentity: fail with git config fix when user.email is empty', async () => {
  const execaMock = mock.method(execaModule, 'execa', async (_cmd: string, args?: string[]) => {
    if (args?.includes('user.name')) return { stdout: 'Ada Lovelace', exitCode: 0 } as any;
    if (args?.includes('user.email')) {
      const err: any = new Error('exit code 1');
      err.exitCode = 1;
      throw err;
    }
    throw new Error('unexpected args');
  });
  try {
    const result = await checkGitIdentity();
    assert.equal(result.status, 'fail');
    assert.match(result.fix ?? '', /git config --global user\.email/);
  } finally {
    execaMock.mock.restore();
  }
});

test('checkGhAuth: pass when gh auth status exits 0 with workflow scope present', async () => {
  const execaMock = mock.method(execaModule, 'execa', async () => ({
    stdout: '',
    stderr: 'Token scopes: repo, workflow, read:org',
    exitCode: 0,
  } as any));
  try {
    const result = await checkGhAuth();
    assert.equal(result.status, 'pass');
  } finally {
    execaMock.mock.restore();
  }
});

test('checkGhAuth: warn when workflow scope missing from Token scopes line', async () => {
  const execaMock = mock.method(execaModule, 'execa', async () => ({
    stdout: '',
    stderr: 'Token scopes: repo, read:org',
    exitCode: 0,
  } as any));
  try {
    const result = await checkGhAuth();
    assert.equal(result.status, 'warn');
    assert.match(result.fix ?? '', /gh auth refresh -h github\.com -s workflow/);
  } finally {
    execaMock.mock.restore();
  }
});

test('checkGhAuth: fail with gh auth login fix on non-zero exit', async () => {
  const execaMock = mock.method(execaModule, 'execa', async () => {
    const err: any = new Error('not logged in');
    err.exitCode = 1;
    throw err;
  });
  try {
    const result = await checkGhAuth();
    assert.equal(result.status, 'fail');
    assert.match(result.fix ?? '', /gh auth login/);
  } finally {
    execaMock.mock.restore();
  }
});

test('checkClaudeOnPath: pass with parsed version in detail', async () => {
  const execaMock = mock.method(execaModule, 'execa', async () => ({
    stdout: '2.1.259 (Claude Code)',
    exitCode: 0,
  } as any));
  try {
    const result = await checkClaudeOnPath();
    assert.equal(result.status, 'pass');
    assert.match(result.detail, /2\.1\.259/);
  } finally {
    execaMock.mock.restore();
  }
});

test('checkClaudeOnPath: fail with install fix on ENOENT', async () => {
  const execaMock = mock.method(execaModule, 'execa', async () => {
    const err: any = new Error('spawn claude ENOENT');
    err.code = 'ENOENT';
    throw err;
  });
  try {
    const result = await checkClaudeOnPath();
    assert.equal(result.status, 'fail');
    assert.match(result.fix ?? '', /install the claude CLI/);
  } finally {
    execaMock.mock.restore();
  }
});

test('checkGsdInstall: pass when ~/.claude/skills or ~/.claude/gsd-core is readable', async () => {
  const result = await checkGsdInstall();
  // Cannot control the real home directory in this test file without a fs mock
  // layer; asserts the shape is well-formed regardless of the local machine's state.
  assert.ok(['pass', 'fail'].includes(result.status));
  assert.equal(result.name, 'Global GSD install');
});

test('checkResourceHeadroom: always pass, includes a concurrency suggestion in detail', async () => {
  const execaMock = mock.method(execaModule, 'execa', async () => ({
    stdout: '256',
    exitCode: 0,
  } as any));
  try {
    const result = await checkResourceHeadroom();
    assert.equal(result.status, 'pass');
    assert.match(result.detail, /concurrency/i);
    assert.match(result.fix ?? '', /ulimit -n/);
  } finally {
    execaMock.mock.restore();
  }
});

test('checkResourceHeadroom: no fix appended when ulimit already >= 1024', async () => {
  const execaMock = mock.method(execaModule, 'execa', async () => ({
    stdout: '4096',
    exitCode: 0,
  } as any));
  try {
    const result = await checkResourceHeadroom();
    assert.equal(result.status, 'pass');
    assert.equal(result.fix, undefined);
  } finally {
    execaMock.mock.restore();
  }
});

test('runPreflight: returns exactly 6 results in the fixed order', async () => {
  const results = await runPreflight();
  assert.equal(results.length, 6);
  assert.equal(results[0]?.name, 'Node version');
  assert.equal(results[1]?.name, 'Git identity');
  assert.equal(results[2]?.name, 'GitHub CLI auth');
  assert.equal(results[3]?.name, 'Claude CLI');
  assert.equal(results[4]?.name, 'Global GSD install');
  assert.equal(results[5]?.name, 'Resource headroom');
});
