/**
 * The single source of truth for every `claude` flag in this project.
 *
 * No other module in `src/execution/` decides a flag, and no other module may assemble an
 * argument list of its own. Phase 6's resume path calls `buildResumeArgs()` here, so an
 * amendment made in this file reaches it too. AGNT-04, AGNT-05, D-01, D-02, D-03, D-04, D-16.
 *
 * `prompt` is deliberately ABSENT from `ClaudeArgsInput`: since T113 the prompt travels on
 * the child's stdin, not in argv, and removing the field is the enforcement — every stale
 * caller becomes a compile error instead of a silently-ignored argument.
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
 * **Under-granting reproduces the silent-nothing failure exactly**, and worse, it can
 * reproduce it while everything reports success.
 *
 * MEASURED 2026-09-08 on CLI 2.1.263 by `scripts/probe-gsd-allowlist.ts` (T116, T117):
 *
 * - `Skill` and `Read` were REFUSED with `decision_reason_type: "mode"` on a real
 *   delivered run (COD-7 -> dzfweb/miracle-shop). The agent substituted `head`/`cat`
 *   through `Bash` and still shipped a correct PR — so exit code, the pull request, the
 *   Linear comment and `npm run verify` ALL reported success while the agent was being
 *   refused. The run's own event log was the only witness.
 * - `Task` is granted so GSD's skills can delegate to their planner/executor/checker
 *   subagents; refused, every GSD skill degrades to the parent doing everything inline,
 *   which is the same invisible degradation. Those subagents run INSIDE the parent
 *   `claude` process, so they consume no slot of the global session cap. What bounds them
 *   is turns and dollars — and only turns are bounded on a default install: `maxBudgetUsd`
 *   is `.optional()` (`infra/config.ts`), the wizard writes none (`config-writer.test.ts`
 *   asserts `'maxBudgetUsd' in config === false`) and `adapters.ts` only spreads
 *   `--max-budget-usd` when it is defined. So unless the operator configured a budget,
 *   there is NO dollar ceiling. Whether either bound reaches inside a subagent is
 *   unmeasured — T114 established the turn budget is per user message, and nothing has
 *   measured whether subagent turns draw on the parent's `num_turns`.
 * - `Glob`, `Grep` and `TodoWrite` are NOT granted: this CLI does not have them (the
 *   daemon's own `buildChildEnv` run enumerated 30 tools, none of those three). An unknown
 *   name in `--allowedTools` is accepted SILENTLY — measured, not an error — so a granted
 *   name the vendor later renames or removes narrows this list without a single error
 *   anywhere. RE-RUN THE PROBE AFTER A CLI UPGRADE; nothing else can see that.
 *
 * The test beside this constant pins its VALUE and can never establish its SUFFICIENCY.
 * Only `scripts/probe-gsd-allowlist.ts`, against a real GSD run, can.
 */
export const ALLOWED_TOOLS: readonly string[] = ['Write', 'Edit', 'Bash', 'Read', 'Skill', 'Task'];

/** D-03 / T3. Paired with `--verbose` below; see the comment there. */
export const OUTPUT_FORMAT = 'stream-json';

/**
 * T113 / M2. The prompt travels on STDIN, not in argv, so `law say` can write a second
 * message into a session that is still working.
 *
 * This flag is the single most dangerous one in this file. Under it, a VALUE passed to
 * `-p` is silently discarded and the session then hangs forever — measured on CLI 2.1.263:
 * eight `system/hook_started` and eight `system/hook_response` inside 0.7s, then 90 seconds
 * of nothing (no `system/init`, no assistant, no result) until SIGKILL. Every run would
 * burn its full 45-minute `maxRunMs` producing absolutely nothing, with a healthy-looking
 * log. `scripts/probe-stream-input.ts` re-measures this against the real binary on demand.
 */
export const INPUT_FORMAT = 'stream-json';

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
  schema: object;
  /**
   * `Config.maxTurns`. Passed as `--max-turns`, which is a real, validated flag despite
   * being absent from `claude --help` on 2.1.259 — verified by passing a non-numeric value
   * and getting `option '--max-turns <turns>' argument 'notanumber' is invalid. must be a
   * number`, which an unknown flag does not produce (it says `unknown option`).
   *
   * PER SESSION, deliberately. A resumed run gets a fresh turn budget, because the answer
   * to a question is new work and the turns already spent were spent reaching the question.
   * The RUN is bounded elsewhere: by `maxQuestionRounds` on how many times it may resume,
   * and by `maxRunMs` on each session's wall clock.
   *
   * Hitting it is not a crash. The result event comes back with `subtype:
   * "error_max_turns"`, and `classifyOutcome` already reads any non-`success` subtype as
   * truncated — so a run with commits ships a draft PR as `partial` rather than being
   * discarded.
   */
  maxTurns: number;
  /**
   * What is LEFT of `Config.maxBudgetUsd` for this run, or undefined when the operator set
   * no budget.
   *
   * Remaining, not the configured total: one run is several `claude` sessions, and passing
   * the full figure to each would make an N-question run cost up to N+1 times the cap — a
   * limit that does not limit. This is the same per-session-value-on-a-per-run-quantity
   * mistake as T95, refused this time before it shipped.
   *
   * The CLI rejects zero and negatives (`--max-budget-usd must be a positive number
   * greater than 0`), so an exhausted budget must be handled before the spawn rather than
   * passed down as `0`. `cli/adapters.ts` does that.
   */
  maxBudgetUsd?: number;
}

/**
 * Everything both paths share. Built once so the fresh and the resumed session cannot be
 * granted different permissions, different output handling, or different schemas.
 */
function commonArgs(o: ClaudeArgsInput): string[] {
  return [
    // Both caps ride on `commonArgs` rather than on one path, for the same reason the
    // permissions do: a resumed session must not be granted a budget a fresh one is not.
    '--max-turns',
    String(o.maxTurns),
    ...(o.maxBudgetUsd !== undefined ? ['--max-budget-usd', String(o.maxBudgetUsd)] : []),
    '--output-format',
    OUTPUT_FORMAT,
    // T113 / M2-M3. The prompt is an NDJSON `user` message on stdin (`userMessageLine`
    // below), written by `supervisor.ts` immediately after the spawn.
    '--input-format',
    INPUT_FORMAT,
    // Two reasons, both load-bearing. (1) It is the daemon's ONLY positive receipt that a
    // message written to stdin was actually consumed — a run that ends with no result AND
    // no echo reports "the stdin delivery failed" instead of being a 45-minute mystery
    // (M2/T113). (2) It is what puts the operator's own `law say` words into the run log,
    // so `law watch` shows both halves of the conversation rather than only the agent's
    // unexplained change of direction (M11).
    '--replay-user-messages',
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
    JSON.stringify(o.schema),
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

/**
 * The flag list for a fresh run. Order is stable so tests can assert on adjacency.
 *
 * `-p` is LAST and carries NO VALUE (M3). Both halves matter:
 *   - it is kept because `--input-format` only works with `--print`;
 *   - a value there is SILENTLY DISCARDED and the session then hangs for the full
 *     `maxRunMs` producing nothing (M2 / T113) — the single most expensive failure this
 *     file can cause;
 *   - it is last because an option following a bare `-p` can be eaten as its optional
 *     value. Last is the ordering that was measured working.
 *
 * The prompt is therefore not in argv at all. That STRENGTHENS T99's containment claim:
 * hostile ticket text no longer reaches the argument array in any form.
 */
export function buildClaudeArgs(o: ClaudeArgsInput): string[] {
  return [
    // D-04 / T4: pre-assigned by the caller and already persisted to the run row before
    // the spawn. Never parsed back out of the stream — 16 hook events precede system/init.
    '--session-id',
    o.sessionId,
    ...commonArgs(o),
    '-p',
  ];
}

/**
 * One NDJSON `user` message, newline-terminated — the exact envelope measured working on
 * CLI 2.1.263 (M3).
 *
 * It lives HERE, in the module that is already the single source of truth for everything
 * on the `claude` wire, and `supervisor.ts` (the prompt) and `inject.ts` (`law say`) both
 * import it. A second copy is how the two ends of one wire drift apart —
 * T72/T92/T96 are all exactly that defect.
 *
 * The text crosses into the child as a JSON string inside this envelope: never argv, never
 * a shell. There is no quoting boundary here to break.
 */
export function userMessageLine(text: string): string {
  return `${JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
  })}\n`;
}

/**
 * Phase 6's resume path (D-16 / T31 / T57): an answered question continues the same session.
 *
 * `-p` is RETAINED alongside `--resume`, now bare. The plan and the research both said
 * "replace `-p` with `--resume`"; taken literally the worker resumes the session and then
 * says NOTHING to it, so the answer never arrives and the entire Q&A feature is inert
 * while every log line looks healthy.
 *
 * That failure has not gone away — it has moved one seam over. The answer used to travel
 * as `-p <answer>` and now travels as a `userMessageLine` on stdin, and M2/T113 is the
 * SAME failure through a different door: pass the answer as a value to `-p` under
 * `--input-format stream-json` and it is silently discarded, the resumed session says
 * nothing, and every log line still looks healthy. The control that guards this moved
 * with it: `supervisor.test.ts` now asserts the answer reaches the child's stdin, because
 * asserting on argv can no longer see it.
 *
 * `--session-id` is DROPPED, not reused — that is the flag that hard-errors on a spent id
 * ("Session ID <uuid> is already in use.", exit 1, empty stdout).
 */
export function buildResumeArgs(o: ClaudeArgsInput): string[] {
  return ['--resume', o.sessionId, ...commonArgs(o), '-p'];
}
