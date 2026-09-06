/**
 * The single source of truth for every `claude` flag in this project.
 *
 * No other module in `src/execution/` decides a flag, and no other module may assemble an
 * argument list of its own. Phase 6's resume path calls `buildResumeArgs()` here, so an
 * amendment made in this file reaches it too. AGNT-04, AGNT-05, D-01, D-02, D-03, D-04, D-16.
 *
 * Read the three load-bearing comments below before changing anything. Each names a
 * measured failure that exits 0 with `is_error: false`, which is to say a failure that is
 * indistinguishable from success from the outside. `agent-args.test.ts` has one test per
 * comment; if you delete the comment the test is the only thing left that explains why.
 */

// The --json-schema payload is the DOMAIN's schema, never a literal in this file. A second
// copy is how the wire contract and the parser drift apart, and `parseAgentResult` in that
// same module is what the orchestration layer narrows the reply with.
//
// SETTLED (07-02, TRAPS T58/T64). One shape survives: the domain's
// `complete | needs_input | failed`, whose question field is now `assumption` — the name
// `verdict.ts` reads and the name CLI 2.1.259 was observed returning. This module defines
// no schema of its own and never did; it re-exports the domain value under the name
// `execute-run.ts` imports. `additionalProperties: false` still means the agent cannot
// return a field the domain schema does not list, so add there, never here.
import { AgentResultSchema } from '../domain/agent-result.js';

/**
 * D-01 (amended). Exported so `event-router.ts` can assert that `system/init` echoed the
 * mode we actually asked for, without a second file hard-coding the string. If these two
 * drift apart the init-time detector for T1 silently stops detecting.
 */
export const PERMISSION_MODE = 'dontAsk';

/**
 * D-01 (amended) / T27. Not optional — see the comment in `commonArgs`.
 *
 * ONE list, used by both the fresh and the resumed path. Two lists is how a resumed
 * session ends up with a narrower grant than the session it resumes, and that drift is
 * invisible until an answered question silently produces nothing.
 *
 * OPEN, and it matters (04-CONTEXT D-01 amended): this set is verified sufficient for a
 * file write and a four-command git chain with zero denials, but a real GSD phase run also
 * reaches for Task, Skill, Glob, Grep and TodoWrite. **Under-granting reproduces the
 * silent-nothing failure exactly.** `scripts/probe-gsd-allowlist.ts` is the thing that
 * settles it; it is a milestone integration-gate item, run by a human, never a plan gate.
 * Until it has passed once, this array is an assumption.
 */
export const ALLOWED_TOOLS: readonly string[] = ['Write', 'Edit', 'Bash'];

/** D-03 / T3. Paired with `--verbose` below; see the comment there. */
export const OUTPUT_FORMAT = 'stream-json';

/** Nobody is watching a terminal. There is no surface on which to answer a prompt. */
export const PERMISSION_PROMPTS = 'none';

/**
 * D-16 / QA-01. The schema the agent's final turn must satisfy. Verified end to end
 * against CLI 2.1.259 on both a fresh and a `--resume`d session — `--json-schema` survives
 * the resume, and the parsed object arrives on `result.structured_output` (T31), never on
 * `result.result` beside it.
 *
 * Re-exported under this name because that is what `execute-run.ts` and Phase 6 import.
 * The value is the domain's; this is an alias, not a copy.
 */
export const AGENT_RESULT_JSON_SCHEMA: object = AgentResultSchema;

export interface ClaudeArgsInput {
  sessionId: string;
  prompt: string;
  schema: object;
}

/**
 * Everything both paths share. Built once so the fresh and the resumed session cannot be
 * granted different permissions, different output handling, or different schemas.
 */
function commonArgs(schema: object): string[] {
  return [
    '--output-format',
    OUTPUT_FORMAT,
    // D-03 / T3: omitting this is a hard STARTUP error, not a warning —
    // "When using --print, --output-format=stream-json requires --verbose". It is not a
    // style choice and it is not removable while the output format is stream-json.
    '--verbose',
    '--permission-mode',
    PERMISSION_MODE,
    // VERIFIED 2026-09-06 on CLI 2.1.259 (T27): `dontAsk` ALONE denies the Write tool with
    // decision_reason_type:"mode", creates nothing, and STILL EXITS 0 with is_error:false
    // and subtype:"success" — trap T1 reached through the very flag chosen to avoid it.
    // The identical probe with the allowlist below had zero denials and produced a real
    // git commit. The mode and the allowlist ship together or the product silently
    // produces nothing and reports success. Do not remove it.
    '--allowedTools',
    ...ALLOWED_TOOLS,
    // Verified redundant alongside the mode today rather than contradictory; it is here to
    // guard against a future change of default, not to fix a present bug.
    '--permission-prompts',
    PERMISSION_PROMPTS,
    '--json-schema',
    JSON.stringify(schema),
    //
    // D-02 / T2 — THE FORBIDDEN FLAG, named here on purpose so a contributor who has just
    // read the vendor docs does not add it back:
    //
    //   --bare is FORBIDDEN. No exceptions.
    //
    // The vendor docs recommend --bare for scripted use and state that it will become the
    // default for -p. It skips ~/.claude auto-discovery — which is exactly where this
    // operator's global GSD install lives, the install this entire product depends on.
    // Passing it makes every run silently produce generic, non-GSD work and exit 0, which
    // is indistinguishable from success. `event-router.ts` asserts the GSD skills are
    // present on `system/init` as the runtime backstop for this comment, and
    // `docs/agent-invocation.md` records the trade it forces: because the flag is
    // forbidden, a mapped repository's own `.claude/settings.json` hooks run unprompted.
  ];
}

/** The flag list for a fresh run. Order is stable so tests can assert on adjacency. */
export function buildClaudeArgs(o: ClaudeArgsInput): string[] {
  return [
    '-p',
    o.prompt,
    // D-04 / T4: pre-assigned by the caller and already persisted to the run row before
    // the spawn. Never parsed back out of the stream — 16 hook events precede system/init.
    '--session-id',
    o.sessionId,
    ...commonArgs(o.schema),
  ];
}

/**
 * Phase 6's resume path (D-16 / T31 / T57): an answered question continues the same session.
 *
 * `-p` is RETAINED alongside `--resume` because it is how the human's answer reaches the
 * new turn. The plan and the research both said "replace `-p` with `--resume`"; taken
 * literally the worker resumes the session and then says nothing to it, so the answer
 * never arrives and the entire Q&A feature is inert while every log line looks healthy.
 *
 * `--session-id` is DROPPED, not reused — that is the flag that hard-errors on a spent id
 * ("Session ID <uuid> is already in use.", exit 1, empty stdout).
 */
export function buildResumeArgs(o: ClaudeArgsInput): string[] {
  return ['--resume', o.sessionId, '-p', o.prompt, ...commonArgs(o.schema)];
}
