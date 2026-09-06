/**
 * The evidence verdict. D-06, T1, T31, QA-01, D-16.
 *
 * EVERY case below uses the same successful-looking termination: `subtype: "success"`,
 * `is_error: false`, `terminal_reason: "completed"`, and a child that exited 0. That is
 * not laziness — it is the point. It is what every failure mode in this project actually
 * produces: `--permission-mode dontAsk` without an allowlist denied the Write tool,
 * created nothing, and terminated exactly like this. A suite that varied the exit status
 * would be testing a signal the product deliberately cannot see, and would pass while the
 * daemon reported empty runs as delivered.
 *
 * The exit code is not even reachable from `classifyOutcome` — it takes no such
 * parameter — so these fixtures carry no exit status at all.
 *
 * RUSH MODE: written, not run.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyOutcome } from './verdict.js';
import type { WorktreeEvidence } from './verdict.js';
import type { AgentResultEvent } from './event-router.js';

/**
 * The successful-looking shape, copied off the wire. `stop_reason: "tool_use"` is what
 * `--json-schema` actually produces — including on a resumed session (T31).
 */
function successResult(over: Partial<AgentResultEvent> = {}): AgentResultEvent {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    session_id: 'sess-1',
    result: '{"status":"delivered"}',
    structured_output: { status: 'delivered', summary: 'Shipped it.' },
    stop_reason: 'tool_use',
    terminal_reason: 'completed',
    num_turns: 7,
    total_cost_usd: 0.246124,
    permission_denials: [],
    ...over,
  };
}

const BARREN: WorktreeEvidence = { commitCount: 0, dirty: false };
const COMMITTED: WorktreeEvidence = { commitCount: 3, dirty: false };

// ── D-06 / T1: the phase's whole thesis, in one case ────────────────────────────

test('a run that produced NOTHING and terminated successfully is failed', () => {
  // No commits, no working-tree changes, subtype "success", terminal_reason "completed",
  // is_error false, and the child exited 0. This is the exact silent-nothing signature
  // the research probes produced while being denied every single edit. Research calls
  // this shape "barren"; the binding contract folds it into `failed`.
  const c = classifyOutcome({ evidence: BARREN, result: successResult() });

  assert.equal(c.verdict, 'failed');
  assert.equal(c.shipDraftPr, false);
});

test('commits plus a completed run is delivered', () => {
  const c = classifyOutcome({ evidence: COMMITTED, result: successResult() });

  assert.equal(c.verdict, 'delivered');
  assert.equal(c.shipDraftPr, false);
  assert.equal(c.summary, 'Shipped it.');
});

// ── truncation: partial still ships ─────────────────────────────────────────────

test('commits plus error_max_turns is partial, and still ships a draft PR', () => {
  const c = classifyOutcome({
    evidence: COMMITTED,
    result: successResult({ subtype: 'error_max_turns' }),
  });

  assert.equal(c.verdict, 'partial');
  assert.equal(c.shipDraftPr, true, 'truncated work that committed is reviewable');
});

test('commits plus the supervisor timedOut flag is partial, and still ships a draft PR', () => {
  // The reaped run's result event still looks like a success — the escalation happened
  // outside the agent's own reporting. `timedOut` is the only witness.
  const c = classifyOutcome({
    evidence: COMMITTED,
    result: successResult(),
    timedOut: true,
  });

  assert.equal(c.verdict, 'partial');
  assert.equal(c.shipDraftPr, true);
});

// ── uncommitted work is named, never discarded ──────────────────────────────────

test('working-tree changes with no commits is failed, carrying the uncommitted paths', () => {
  const c = classifyOutcome({
    evidence: {
      commitCount: 0,
      dirty: true,
      uncommittedPaths: ['src/api/auth.ts', 'src/api/auth.test.ts'],
    },
    result: successResult(),
  });

  assert.equal(c.verdict, 'failed');
  // An hour of agent work exists on disk and was never committed. Reporting "produced
  // nothing" here is how it disappears.
  assert.deepEqual(c.uncommittedPaths, ['src/api/auth.ts', 'src/api/auth.test.ts']);
});

// ── QA-01 / D-16: the hand-off ──────────────────────────────────────────────────

test('a valid needs_input carries question and assumption and wins over the evidence', () => {
  const c = classifyOutcome({
    // Committed work present — and it still loses. The answer changes what the rest of
    // the work should be, so the question is the outcome.
    evidence: COMMITTED,
    result: successResult({
      structured_output: {
        status: 'needs_input',
        summary: 'Scaffolded the endpoint.',
        question: 'Should deletes be soft or hard?',
        assumption: 'Soft delete with a deleted_at column.',
      },
    }),
  });

  assert.equal(c.verdict, 'needs_input');
  assert.equal(c.question, 'Should deletes be soft or hard?');
  assert.equal(c.assumption, 'Soft delete with a deleted_at column.');
  assert.equal(c.schemaError, undefined);
});

test('a needs_input with a question but no assumption is reported malformed', () => {
  const c = classifyOutcome({
    evidence: BARREN,
    result: successResult({
      structured_output: {
        status: 'needs_input',
        summary: 'Stuck.',
        question: 'Should deletes be soft or hard?',
      },
    }),
  });

  // D-16 requires BOTH. A question with no assumption is a run that cannot proceed
  // without a human — the exact outcome the assumption exists to avoid — so it is
  // rejected rather than silently accepted as a hand-off.
  assert.notEqual(c.verdict, 'needs_input');
  assert.equal(c.verdict, 'failed');
  assert.ok(c.schemaError, 'the validation failure is carried, not swallowed');
  assert.match(c.schemaError ?? '', /assumptionIfUnanswered/);
});

test('structured_output that fails the schema is rejected and the evidence decides', () => {
  const c = classifyOutcome({
    evidence: COMMITTED,
    result: successResult({
      // Agent-authored, and the agent was steered by attacker-influenceable ticket text.
      // It is not trusted to be well-formed just because the field is typed.
      structured_output: { status: 'needs_input', question: '', assumption: '' },
    }),
  });

  assert.equal(c.verdict, 'delivered', 'classified from the working tree alone');
  assert.ok(c.schemaError);
});

test('a non-object structured_output is ignored rather than thrown on', () => {
  const c = classifyOutcome({
    evidence: BARREN,
    result: successResult({ structured_output: 'not an object' }),
  });

  assert.equal(c.verdict, 'failed');
});

// ── T31: the stop reason is never a gate ────────────────────────────────────────

test('a tool_use stop reason classifies identically to a completed turn', () => {
  const evidence = COMMITTED;
  const toolUse = classifyOutcome({
    evidence,
    result: successResult({ stop_reason: 'tool_use' }),
  });
  const completedTurn = classifyOutcome({
    evidence,
    result: successResult({ stop_reason: 'end_turn' }),
  });

  // A resumed session — which is to say every ANSWERED QUESTION — returns "tool_use".
  // Any stop-reason gate reintroduced later fails right here.
  assert.equal(toolUse.verdict, completedTurn.verdict);
  assert.equal(toolUse.verdict, 'delivered');
});

test('a needs_input hand-off on a resumed session classifies the same as on a fresh one', () => {
  const handoff = {
    status: 'needs_input',
    summary: 'Need a decision.',
    question: 'Which auth provider?',
    assumption: 'Continue with the existing session cookie.',
  };
  const fresh = classifyOutcome({
    evidence: BARREN,
    result: successResult({ stop_reason: 'end_turn', structured_output: handoff }),
  });
  const resumed = classifyOutcome({
    evidence: BARREN,
    result: successResult({ stop_reason: 'tool_use', structured_output: handoff }),
  });

  assert.equal(fresh.verdict, 'needs_input');
  assert.equal(resumed.verdict, 'needs_input');
  assert.equal(resumed.assumption, 'Continue with the existing session cookie.');
});

// ── permission denials are a named cause ────────────────────────────────────────

test('permission_denials surface as a distinct cause with the tool names', () => {
  const c = classifyOutcome({
    evidence: BARREN,
    result: successResult({
      permission_denials: [
        { tool_name: 'Write', tool_use_id: 'tu_1', tool_input: { file_path: '/tmp/wt/a.ts' } },
      ],
    }),
  });

  // "failed plus a denial naming Write" is a diagnosable failure with a one-line fix in
  // agent-args.ts. "failed" alone is a mystery.
  assert.equal(c.verdict, 'failed');
  assert.deepEqual(c.deniedTools, ['Write']);
  assert.match(c.denialCause ?? '', /Write/);
});

test('a denial cause is reported alongside a delivered verdict, not instead of it', () => {
  const c = classifyOutcome({
    evidence: COMMITTED,
    result: successResult({
      permission_denials: [{ tool_name: 'Task', tool_use_id: 'tu_2', tool_input: {} }],
    }),
  });

  assert.equal(c.verdict, 'delivered');
  assert.deepEqual(c.deniedTools, ['Task']);
});

// ── the terminal comment's numbers ──────────────────────────────────────────────

test('cost and turn count ride through onto the classification', () => {
  const c = classifyOutcome({ evidence: COMMITTED, result: successResult() });

  // Phase 5's terminal comment reports these. Raw input tokens would be actively
  // misleading: the cost is dominated by cache creation on the ~61k-token GSD system
  // prompt, not by the ticket.
  assert.equal(c.costUsd, 0.246124);
  assert.equal(c.numTurns, 7);
});

test('a run with no result event at all is failed, with zeroed numbers', () => {
  const c = classifyOutcome({ evidence: BARREN, result: undefined });

  assert.equal(c.verdict, 'failed');
  assert.equal(c.costUsd, 0);
  assert.equal(c.numTurns, 0);
  assert.deepEqual(c.deniedTools, undefined);
});
