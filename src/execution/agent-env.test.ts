/**
 * The child environment allowlist. AGNT-11, D-15 (amended), T28, threat T-04-15.
 *
 * THE SETUP IS THE TEST. Asserting against whatever environment the runner happened to
 * have proves nothing — on a clean box `buildChildEnv()` would pass while leaking
 * everything. So this file deliberately pollutes `process.env` with both worker secrets
 * and four CLAUDE* variables first, one of which is INVENTED: `CLAUDE_FUTURE_VARIABLE` is
 * the variable a denylist could not have known to remove, and is the whole argument for
 * the allowlist.
 *
 * Note the boundary this file does NOT cover: execa merges a supplied `env` OVER
 * `process.env` unless `extendEnv: false` (T56). `supervisor.ts` sets it and
 * `execute-run.test.ts` asserts on the env the SPAWN received. A green file here with a
 * missing `extendEnv: false` there means the allowlist withholds nothing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildChildEnv } from './agent-env.js';

const POLLUTION: Record<string, string> = {
  LINEAR_API_KEY: 'lin_api_do_not_leak_me',
  NGROK_AUTHTOKEN: 'ngrok_do_not_leak_me_either',
  CLAUDECODE: '1',
  CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/claude-messaging.sock',
  CLAUDE_CODE_CHILD_SESSION: 'true',
  // Invented on purpose. No denylist written today could name it; the allowlist does not
  // have to. This is the variable that makes the D-15 amendment necessary.
  CLAUDE_FUTURE_VARIABLE: 'whatever ships next quarter',
};

/** Set the pollution, run `fn`, restore exactly what was there before. */
function withPollutedEnv(fn: () => void): void {
  const saved = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(POLLUTION)) {
    saved.set(k, process.env[k]);
    process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('D-15/AGNT-11: neither worker secret reaches the child', () => {
  withPollutedEnv(() => {
    const env = buildChildEnv('run-1');
    assert.ok(!('LINEAR_API_KEY' in env), 'LINEAR_API_KEY leaked into the spawned agent');
    assert.ok(!('NGROK_AUTHTOKEN' in env), 'NGROK_AUTHTOKEN leaked into the spawned agent');
  });
});

test('T28: no key of the child environment begins with CLAUDE', () => {
  // Asserted by ITERATING THE KEYS, not by naming the three we happen to know about.
  // Measured 2026-09-06: a daemon launched from inside a Claude Code session inherits 22
  // CLAUDE* variables, and with them present the identical probe that otherwise succeeded
  // denied Write with decision_reason_type:"asyncAgent" — "this session has no approval
  // surface". Permission behaviour would depend on how the operator started the daemon.
  withPollutedEnv(() => {
    const env = buildChildEnv('run-2');
    const leaked = Object.keys(env).filter((k) => k.startsWith('CLAUDE'));
    assert.deepEqual(leaked, [], `inherited CLAUDE* variables: ${leaked.join(', ')}`);
  });
});

test('allowlisted variables that are set pass through with their exact values', () => {
  withPollutedEnv(() => {
    process.env['XDG_CACHE_HOME'] = '/tmp/law-cache';
    try {
      const env = buildChildEnv('run-3');
      assert.equal(env['PATH'], process.env['PATH']);
      assert.equal(env['HOME'], process.env['HOME']);
      assert.equal(env['XDG_CACHE_HOME'], '/tmp/law-cache');
    } finally {
      delete process.env['XDG_CACHE_HOME'];
    }
  });
});

test('allowlisted variables that are unset are ABSENT, not present-and-undefined', () => {
  // `{ LC_ALL: undefined }` is not the same object as `{}` to a child process spawner, and
  // the difference has bitten every codebase that used a spread instead of a copy.
  const saved = process.env['LC_ALL'];
  delete process.env['LC_ALL'];
  try {
    const env = buildChildEnv('run-4');
    assert.ok(!('LC_ALL' in env), 'unset allowlist entries must not appear as keys at all');
  } finally {
    if (saved !== undefined) process.env['LC_ALL'] = saved;
  }
});

test('LAW_RUN_ID carries the run id, so a stray process is attributable', () => {
  const env = buildChildEnv('run-5');
  assert.equal(env['LAW_RUN_ID'], 'run-5');
});

test('the result is a fresh object: mutating it does not mutate process.env', () => {
  const before = process.env['PATH'];
  const env = buildChildEnv('run-6');
  env['PATH'] = '/tampered';
  env['LINEAR_API_KEY'] = 'nope';
  assert.equal(process.env['PATH'], before);
  assert.equal(process.env['LINEAR_API_KEY'], undefined);
});
