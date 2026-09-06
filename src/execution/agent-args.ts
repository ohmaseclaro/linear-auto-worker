/**
 * The single source of truth for every `claude` flag in this project.
 *
 * No other module in `src/execution/` decides a flag. Phase 6 calls
 * `buildResumeArgs()` rather than assembling its own list, so an amendment made here
 * reaches the resume path too. AGNT-05, D-01, D-02, D-03, D-04, D-16.
 */

/**
 * D-01 (amended). Exported so `event-router.ts` can assert that `system/init` echoed the
 * mode we actually asked for, without a second file hard-coding the string. If these two
 * drift apart the init-time detector for T1 silently stops detecting.
 */
export const PERMISSION_MODE = 'dontAsk';

/**
 * D-01 (amended) / T27. Not optional: see the comment in `buildClaudeArgs`.
 *
 * OPEN, and it matters (04-CONTEXT D-01): this set is verified sufficient for writes and
 * a git chain, but a real GSD run also reaches for Task, Skill, Glob, Grep and TodoWrite.
 * Under-granting reproduces the silent-nothing failure. The integration gate probes this
 * manually; it is never a plan-blocking step.
 */
export const ALLOWED_TOOLS: readonly string[] = ['Write', 'Edit', 'Bash'];

/**
 * D-16 / QA-01. The schema the agent's final turn must satisfy, verified end to end
 * against CLI 2.1.259 on both a fresh and a `--resume`d session.
 *
 * It lives here, beside the flag that carries it, rather than in `src/domain/`: the
 * binding contract names no module for it, and `src/orchestration/` has independently
 * assumed a differently-shaped `AgentResult` (`complete` / `prTitle` / `prBody` /
 * `assumptionIfUnanswered`). Reconciling the two is Phase 7's; inventing a second copy
 * under `src/domain/` is what RUSH rule 3 forbids. See 04-01-SUMMARY.md.
 */
export const AGENT_RESULT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['delivered', 'needs_input'] },
    question: { type: 'string' },
    assumption: { type: 'string' },
    summary: { type: 'string' },
  },
  required: ['status'],
  additionalProperties: false,
};

export interface ClaudeArgsInput {
  sessionId: string;
  prompt: string;
  schema: object;
}

/** The flag list for a fresh run. Order is stable so tests can assert on adjacency. */
export function buildClaudeArgs(o: ClaudeArgsInput): string[] {
  return [
    '-p',
    o.prompt,
    '--output-format',
    'stream-json',
    // D-03 / T3: omitting this is a hard startup error, not a warning —
    // "When using --print, --output-format=stream-json requires --verbose".
    '--verbose',
    // D-04 / T4: pre-assigned by the caller and already persisted to the run row.
    // Never parsed back out of the stream: 16 hook events precede `system/init`.
    '--session-id',
    o.sessionId,
    '--permission-mode',
    PERMISSION_MODE,
    // VERIFIED 2026-09-06 on CLI 2.1.259 (T27): `dontAsk` ALONE denies the Write tool
    // with decision_reason_type:"mode", creates nothing, and STILL EXITS 0 with
    // is_error:false and subtype:"success" — trap T1 reached through the very flag
    // chosen to avoid it. The same probe with the allowlist below had zero denials and
    // produced a real git commit. The mode and the allowlist ship together or the
    // product silently produces nothing. Do not remove it.
    '--allowedTools',
    ...ALLOWED_TOOLS,
    // Nobody is present to answer a prompt. Verified redundant alongside the mode today
    // rather than contradictory; it guards against a future change of default.
    '--permission-prompts',
    'none',
    '--json-schema',
    JSON.stringify(o.schema),
    //
    // D-02 / T2 — the forbidden flag, named here on purpose so a future contributor
    // reading the vendor docs does not add it back:
    //
    //   --bare is FORBIDDEN. No exceptions.
    //
    // Vendor docs recommend --bare for scripted use and state it will become the -p
    // default. It skips ~/.claude auto-discovery, which is exactly where this operator's
    // global GSD install lives — the install this entire product depends on. Passing
    // --bare makes every run silently produce generic, non-GSD work and exit 0, which is
    // indistinguishable from success from the outside. `event-router.ts` asserts the GSD
    // skills are present on `system/init` as the runtime backstop for this comment.
  ];
}

/**
 * Phase 6's resume path (D-16 / T31): an answered question continues the same session.
 *
 * `--session-id` is dropped, not reused — a spent ID is a hard error
 * (`Session ID <uuid> is already in use.`, exit 1, empty stdout). `-p` is retained
 * alongside `--resume` because it is how the human's answer reaches the new turn;
 * dropping it would resume the session with nothing to say. `--json-schema` is retained
 * because it is verified to survive `--resume`.
 */
export function buildResumeArgs(o: ClaudeArgsInput): string[] {
  return [
    '--resume',
    o.sessionId,
    '-p',
    o.prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    PERMISSION_MODE,
    '--allowedTools',
    ...ALLOWED_TOOLS,
    '--permission-prompts',
    'none',
    '--json-schema',
    JSON.stringify(o.schema),
  ];
}
