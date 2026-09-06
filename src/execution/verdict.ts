/**
 * Evidence-based classification. D-06, T1, T31, QA-01, D-16.
 *
 * Pure on purpose: the git evidence is collected by the caller and passed in, which is
 * what makes this module testable with no git anywhere — under RUSH mode the only kind
 * of test that exists.
 *
 * THE RULE OF THIS FILE: the child's exit status is not an input. It is not a parameter,
 * it is not read off the result event, and it cannot be. Every silent-failure probe in
 * the research session terminated with a successful-looking exit — status 0,
 * subtype "success", terminal_reason "completed" — while having been denied every edit
 * and having created nothing (T1, D-06). A function that cannot see the exit code cannot
 * be tempted by it. Success is what is in the working tree.
 */
import { AgentResultSchema, parseAgentResult } from '../domain/agent-result.js';
import type { AgentResultEvent } from './event-router.js';
import type { ExecutionVerdict } from './execute-run.js';

export interface WorktreeEvidence {
  /** Line count of `git log --oneline <base>..HEAD`. */
  commitCount: number;
  /** `git status --porcelain` was non-empty — work the agent left uncommitted. */
  dirty: boolean;
  /**
   * The `git status --porcelain` paths, when the caller collected them. Reported to the
   * operator: an hour of agent work that exists on disk but was never committed must be
   * named, not silently discarded.
   */
  uncommittedPaths?: string[];
}

/** The shape `AgentResultSchema` constrains the agent's final turn to. */
export interface AgentStructuredOutput {
  status?: string;
  question?: string;
  assumption?: string;
  summary?: string;
}

export interface Classification {
  verdict: ExecutionVerdict;
  question?: string;
  assumption?: string;
  summary?: string;
  /**
   * Set when the agent was refused a tool. Naming the tool and its input is the
   * difference between a diagnosable failure and "it produced nothing".
   */
  denialCause?: string;
  /** The refused tool names, unwrapped, so a caller can branch without parsing prose. */
  deniedTools?: string[];
  /**
   * Set when the agent's own structured output did not satisfy the contract. The run is
   * then classified from the working tree alone — the agent is never trusted to be
   * well-formed just because TypeScript typed the field.
   */
  schemaError?: string;
  /** Paths the agent changed but never committed. Present only when there are some. */
  uncommittedPaths?: string[];
  /**
   * A `partial` run still ships — as a DRAFT. That is why `partial` is a real state in
   * the binding contract rather than a rounding of `failed` (Phase 1 D-01): truncated
   * work that committed is reviewable, and throwing it away is the expensive mistake.
   */
  shipDraftPr: boolean;
  costUsd: number;
  numTurns: number;
}

function asStructured(value: unknown): AgentStructuredOutput | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as AgentStructuredOutput;
}

/**
 * Validate the ONE input to this module authored by an agent that was itself steered by
 * attacker-influenceable ticket text (T-04-29). Delegates to `parseAgentResult`, the
 * domain's single validator, rather than re-checking fields here.
 *
 * T58/T64 are settled: there is ONE shape, in `src/domain/agent-result.ts`, and its
 * question field is `assumption` — the name this module always read and the name the
 * live CLI probe returned. The normalisation that used to bridge the two names is gone;
 * only the summary default below survives, and for a different reason.
 */
function validateNeedsInput(raw: AgentStructuredOutput): { question: string; assumption: string } {
  const parsed = parseAgentResult({
    status: 'needs_input',
    // D-16 requires the question and the assumption; it does not require a summary, and
    // the wire schema does not mark one required either. Defaulting it here keeps the
    // domain validator's non-empty rule from failing a hand-off for the one field whose
    // absence costs nothing.
    summary: raw.summary ?? '(the agent returned no summary)',
    question: raw.question ?? '',
    assumption: raw.assumption ?? '',
  });
  if (parsed.status !== 'needs_input') {
    throw new Error(`expected needs_input, got ${parsed.status}`);
  }
  return { question: parsed.question, assumption: parsed.assumption };
}

export function classifyOutcome(o: {
  evidence: WorktreeEvidence;
  result: AgentResultEvent | undefined;
  /** From `runAgent`. A run the supervisor reaped is truncated by definition (AGNT-08). */
  timedOut?: boolean;
}): Classification {
  const event = o.result;

  const denials = event?.permission_denials ?? [];
  const deniedTools = denials.map((d) => d.tool_name);
  const denialCause =
    denials.length > 0
      ? `${denials.length} tool call(s) refused: ` +
        denials
          .map((d) => `${d.tool_name}(${JSON.stringify(d.tool_input).slice(0, 120)})`)
          .join('; ')
      : undefined;

  // T31: read the PARSED object the event already carries, never the JSON string beside
  // it — parsing that string duplicates work and adds a second failure mode for no gain.
  // And never gate on the stop reason being a completed turn: with --json-schema the stop
  // reason is a tool use (verified twice), and a resumed session returns a tool use too,
  // so any such check is a bug that fires on every ANSWERED QUESTION. There is
  // deliberately no branch on `stop_reason` anywhere below.
  const structured = asStructured(event?.structured_output);

  let schemaError: string | undefined;
  let handoff: { question: string; assumption: string } | undefined;

  if (structured?.status === 'needs_input') {
    try {
      handoff = validateNeedsInput(structured);
    } catch (err) {
      // D-16 requires BOTH halves. A question with no assumption is a run that cannot
      // proceed without a human, which is the exact outcome the assumption exists to
      // avoid — so it is reported malformed rather than quietly half-accepted.
      schemaError =
        `agent structured_output failed validation ` +
        `(required: ${AgentResultSchema.required.join(', ')}): ` +
        (err instanceof Error ? err.message : String(err));
    }
  }

  const base = {
    denialCause,
    deniedTools: denials.length > 0 ? deniedTools : undefined,
    schemaError,
    uncommittedPaths:
      o.evidence.uncommittedPaths && o.evidence.uncommittedPaths.length > 0
        ? o.evidence.uncommittedPaths
        : undefined,
    costUsd: event?.total_cost_usd ?? 0,
    numTurns: event?.num_turns ?? 0,
    summary: structured?.summary,
  };

  // 1. A VALID hand-off wins over everything, including the evidence. A run that
  //    committed and still asked a question is a question: the answer changes what the
  //    rest of the work should be. An INVALID one falls through to the evidence below.
  if (handoff) {
    return {
      ...base,
      verdict: 'needs_input',
      question: handoff.question,
      assumption: handoff.assumption,
      shipDraftPr: false,
    };
  }

  // 2. No commits, no delivery — whatever the child's exit said. Research calls this
  //    shape "barren"; the binding nine states have no such literal, so it folds into
  //    `failed` (Phase 1 D-01). The uncommitted paths ride along on `base` so the
  //    operator is told the work exists and was never committed.
  if (o.evidence.commitCount === 0) {
    return { ...base, verdict: 'failed', shipDraftPr: false };
  }

  // 3. Commits exist. The only remaining question is whether the run finished or was cut
  //    off — by the supervisor's deadline, or by the agent's own turn limit.
  const truncated = o.timedOut === true || event?.subtype !== 'success';
  return {
    ...base,
    verdict: truncated ? 'partial' : 'delivered',
    shipDraftPr: truncated,
  };
}
