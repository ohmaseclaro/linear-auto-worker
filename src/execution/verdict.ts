/**
 * Evidence-based classification. D-06, T1, T31.
 *
 * Pure on purpose: the git evidence is collected by the caller and passed in, which is
 * what makes this module testable with no git anywhere — under RUSH mode the only kind
 * of test that exists.
 */
import type { AgentResultEvent } from './event-router.js';
import type { ExecutionVerdict } from './execute-run.js';

export interface WorktreeEvidence {
  /** Line count of `git log --oneline <base>..HEAD`. */
  commitCount: number;
  /** `git status --porcelain` was non-empty — work the agent left uncommitted. */
  dirty: boolean;
}

/** The shape `AGENT_RESULT_JSON_SCHEMA` constrains the agent's final turn to. */
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
  costUsd: number;
  numTurns: number;
}

function asStructured(value: unknown): AgentStructuredOutput | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  return value as AgentStructuredOutput;
}

export function classifyOutcome(o: {
  evidence: WorktreeEvidence;
  result: AgentResultEvent | undefined;
}): Classification {
  const event = o.result;

  const denials = event?.permission_denials ?? [];
  const denialCause =
    denials.length > 0
      ? `${denials.length} tool call(s) refused: ` +
        denials
          .map((d) => `${d.tool_name}(${JSON.stringify(d.tool_input).slice(0, 120)})`)
          .join('; ')
      : undefined;

  const base = {
    denialCause,
    costUsd: event?.total_cost_usd ?? 0,
    numTurns: event?.num_turns ?? 0,
  };

  // T31: read the PARSED object the event already carries, never the JSON string beside
  // it. And never gate on the stop reason being a completed turn — with --json-schema the
  // stop reason is a tool use (verified twice), so any such check is a bug that fires on
  // every resumed session, which means on every answered question.
  const structured = asStructured(event?.structured_output);

  // Wins over everything, including evidence: an agent that stopped to ask has not failed.
  // Phase 6 owns what happens next.
  if (structured?.status === 'needs_input') {
    return {
      ...base,
      verdict: 'needs_input',
      question: structured.question,
      assumption: structured.assumption,
      summary: structured.summary,
    };
  }

  // D-06 / T1. The child's exit status is deliberately not consulted here and is not even
  // passed in: EVERY silent-failure probe in the research session terminated with
  // is_error:false, subtype:"success" and terminal_reason:"completed" while having been
  // denied every edit and having created nothing. Success is what is in the worktree.
  if (o.evidence.commitCount === 0) {
    // Research calls this shape "barren". The binding contract has no such state, so it
    // folds into `failed` (Phase 1 D-01).
    return { ...base, verdict: 'failed', summary: structured?.summary };
  }

  const completed = event?.subtype === 'success' && event.is_error === false;
  return {
    ...base,
    // A truncated run that still committed ships a draft PR rather than nothing.
    verdict: completed ? 'delivered' : 'partial',
    summary: structured?.summary,
  };
}
