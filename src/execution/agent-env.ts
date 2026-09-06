/**
 * The spawned agent's environment. AGNT-11, D-15 (amended), T28.
 */

/**
 * The complete set of variables the child is allowed to inherit. Everything else is
 * withheld by construction.
 *
 * `SSH_AUTH_SOCK` is here because the agent may legitimately talk to a git remote over
 * SSH while working. It is deliberately the only credential-adjacent entry.
 */
const PASS: readonly string[] = [
  'PATH',
  'HOME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'TERM',
  'TMPDIR',
  'USER',
  'LOGNAME',
  'SSH_AUTH_SOCK',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
];

/**
 * Build the child environment from an empty object by allowlist.
 *
 * This is an allowlist and not `const { LINEAR_API_KEY, ...rest } = process.env` for two
 * independent reasons, and the second one is why D-15 was amended:
 *
 *  (a) It withholds LINEAR_API_KEY and NGROK_AUTHTOKEN by construction (D-15, AGNT-11).
 *      A denylist withholds only the secrets someone remembered to name, so every future
 *      secret leaks into the child by omission rather than by decision.
 *
 *  (b) VERIFIED 2026-09-06 (T28): a daemon launched from inside a Claude Code session
 *      inherits 22 CLAUDE* variables (CLAUDECODE, CLAUDE_CODE_MESSAGING_SOCKET,
 *      CLAUDE_CODE_CHILD_SESSION and friends). With those present, the identical probe
 *      that otherwise succeeded denied Write with decision_reason_type:"asyncAgent"
 *      ("no approval surface"). Permission behaviour would therefore depend on how the
 *      operator happened to start the daemon. A denylist cannot anticipate 22 names it
 *      has never seen; an allowlist does not have to.
 *
 * THIS FUNCTION IS ONLY HALF THE BOUNDARY (T56). execa MERGES a supplied `env` over
 * `process.env` unless `extendEnv: false` is passed alongside it, so a spawn site that
 * forgets that flag withholds nothing at all while every assertion on this function's
 * return value still passes. `supervisor.ts` sets it; `execute-run.test.ts` asserts on the
 * env the SPAWN received, which is the only place the regression is visible. Note
 * `node:child_process.spawn` has the opposite default, so the trap is execa-specific.
 */
export function buildChildEnv(runId: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of PASS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  env['LAW_RUN_ID'] = runId;
  return env;
}
