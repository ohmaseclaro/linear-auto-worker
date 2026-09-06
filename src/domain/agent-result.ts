/**
 * The contract between the spawned agent and the run engine.
 *
 * A turn's outcome is a schema-constrained JSON object, never prose and never an exit
 * code. `claude -p --json-schema <this>` puts the parsed object in `result.structured_output`
 * (TRAPS T31 — read that, not `result.result`), and `parseAgentResult` is the one place it
 * becomes a value the worker will act on.
 */

import { AgentResultParseError } from './errors.js';

/**
 * Six outcomes. The agent itself can only produce the first three; `partial`, `crashed`
 * and `cancelled` are synthesised by the runner.
 *
 * `partial` is the one that matters and it is deliberately NOT in the wire schema below.
 * The agent cannot self-report it, because the whole point is that the agent's own claim
 * is not trusted: `claude -p` exits 0 having been denied every edit and will happily say
 * `complete` (TRAPS T1/T27). The runner decides `partial` from the WORKTREE — commits
 * present but the turn truncated — and a `partial` run still ships, as a DRAFT PR
 * (Phase 1 D-01, research Pitfall 3). Rounding it to `failed` would discard real work;
 * rounding it to `complete` would describe a truncated branch as finished.
 */
export type AgentResult =
  | { status: 'complete'; summary: string; prTitle: string; prBody: string }
  | {
      status: 'partial';
      summary: string;
      prTitle: string;
      prBody: string;
      /** Work the agent left on disk but never committed. Named, never silently dropped. */
      uncommittedPaths?: string[];
    }
  | { status: 'needs_input'; summary: string; question: string; assumption: string }
  | { status: 'failed'; summary: string; failureReason: string }
  | { status: 'crashed'; exitCode: number; stderrTail: string }
  | { status: 'cancelled' };

/**
 * A JSON Schema document, hand-written rather than derived from zod: `src/domain/` imports
 * nothing outside itself, the CLI wants a schema document rather than a validator, and a
 * conversion step would be one more moving part between the contract and the wire.
 *
 * Only the three statuses the agent can emit appear in the enum. Requiring
 * `assumption` at ask time (QA-01) is what makes the timeout fallback honest:
 * the assumption is the agent's own, stated before it knew whether anyone would answer.
 *
 * T58/T64 — the field is `assumption`, not `assumptionIfUnanswered`. That is what CLI
 * 2.1.259 was observed returning and what `src/execution/verdict.ts` reads. Because
 * `additionalProperties: false` forbids anything not listed here, the longer name meant
 * the agent physically COULD NOT return its assumption and every timed-out question
 * posted nothing. This is the only copy of the schema; `src/execution/agent-args.ts`
 * re-exports this value under its own name and defines nothing.
 */
export const AgentResultSchema = {
  type: 'object',
  required: ['status', 'summary'],
  additionalProperties: false,
  properties: {
    status: { enum: ['complete', 'needs_input', 'failed'] },
    summary: { type: 'string', description: 'One paragraph of what happened this turn.' },
    // present iff status === "needs_input"
    question: {
      type: 'string',
      description: 'One specific question only the human can answer.',
    },
    assumption: {
      type: 'string',
      description: 'The reasonable default you will proceed with if nobody answers.',
    },
    // present iff status === "complete"
    changedRepos: { type: 'array', items: { type: 'string' } },
    prTitle: { type: 'string' },
    prBody: { type: 'string' },
    // present iff status === "failed"
    failureReason: { type: 'string' },
  },
} as const;

function str(o: Record<string, unknown>, key: string, status: string): string {
  const v = o[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new AgentResultParseError(`agent result "${status}" is missing string field "${key}"`);
  }
  return v;
}

/**
 * Narrow untrusted output into an `AgentResult`, or throw.
 *
 * The child's stdout is attacker-influenceable the moment a Linear issue body reaches the
 * prompt (T-01-05), so nothing is inferred: the `status` discriminator is matched exactly
 * and every field that member requires must be present and non-empty. An object crafted to
 * look like a completed delivery cannot become one by omission.
 */
export function parseAgentResult(raw: unknown): AgentResult {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AgentResultParseError(`agent result is not an object: ${typeof raw}`);
  }
  const o = raw as Record<string, unknown>;
  const status = o.status;

  switch (status) {
    case 'complete':
      return {
        status,
        summary: str(o, 'summary', status),
        prTitle: str(o, 'prTitle', status),
        prBody: str(o, 'prBody', status),
      };
    case 'needs_input':
      return {
        status,
        summary: str(o, 'summary', status),
        question: str(o, 'question', status),
        assumption: str(o, 'assumption', status),
      };
    case 'failed':
      return {
        status,
        summary: str(o, 'summary', status),
        failureReason: str(o, 'failureReason', status),
      };
    case 'crashed': {
      const exitCode = o.exitCode;
      if (typeof exitCode !== 'number') {
        throw new AgentResultParseError('agent result "crashed" is missing numeric "exitCode"');
      }
      return { status, exitCode, stderrTail: str(o, 'stderrTail', status) };
    }
    case 'cancelled':
      return { status };
    default:
      throw new AgentResultParseError(`unknown agent result status: ${JSON.stringify(status)}`);
  }
}
