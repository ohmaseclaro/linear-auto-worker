/**
 * Milestone comments on the Linear issue (D-01: roughly 4-6 per run, never a stream).
 *
 * Three things this file is careful about:
 *
 *  - **This file writes NO comment and imports NO marker.** It composes bodies; the
 *    marker and the `createComment` call both live in `run-engine.ts` (`botBody`), which
 *    is what actually posts. An earlier version of this header claimed "this channel
 *    writes it onto every comment" — it never did, and `composeBody()` below is consumed
 *    by `SlackChannel`. A doc comment asserting a security guard the file does not
 *    implement is itself a trap (T119's sibling); corrected 2026-09-09.
 *  - **Bodies are composed only from RunEvent fields (threat T-05-05).** Never an agent's
 *    raw stdout, never a stack trace, never a filesystem path: a Linear comment is
 *    human-visible on a shared ticket and any of those could carry a secret.
 *  - **Every successful write is announced to Phase 3 via `noteSelfWrite`.** That feeds the
 *    `suppression:self-write` guard, which reads zero until the writer says a write
 *    happened — ingress cannot know on its own (03-CONTEXT D-09).
 *
 * `QUESTION_MARKER_PREFIX` is deliberately absent, and so is every other marker constant:
 * a file that posts nothing has nothing to mark.
 */

import { noteSelfWrite } from '../../ingress/guards.js';
import type { LinearClient, LogFn } from '../linear-client.js';
import type { NotifyChannel, NotifyResult, RunEvent } from './notifier.js';

const USD = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 4,
});

/**
 * The curated per-kind message, without the marker prefix.
 *
 * Exported because `SlackChannel` renders the same summary — one source of truth beats two
 * templates that drift into disagreeing about what a run just did.
 */
export function composeBody(e: RunEvent): string {
  switch (e.kind) {
    case 'picked_up':
      return `Picked up ${e.issueIdentifier}. Queued for an autonomous run.`;
    case 'worktree_ready':
      return 'Worktree prepared. Starting the agent.';
    case 'agent_started':
      return 'Agent running.';
    case 'question_asked':
      // ponytail: `question` is agent-authored text, but it is a RunEvent field the caller
      // curated, not raw process output. Ceiling: Phase 6 owns keeping it to one question.
      return `I need a decision before continuing:\n\n${e.question}`;
    case 'terminal':
      return composeTerminal(e);
  }
}

function composeTerminal(e: Extract<RunEvent, { kind: 'terminal' }>): string {
  // NOTF-06: cost and tokens on every terminal message, whatever the outcome.
  const cost = `Cost ${USD.format(e.costUsd)} · ${e.tokensUsed.toLocaleString('en-US')} tokens.`;
  const reason = e.reason ? ` ${e.reason}` : '';

  switch (e.state) {
    case 'delivered':
      // DELV-05: the PR url is the whole point of the run reaching this state.
      return `Done — pull request: ${e.prUrl ?? '(no pull request url recorded)'}\n\n${cost}`;
    case 'partial':
      return (
        `Partially done — draft pull request: ${e.prUrl ?? '(no pull request url recorded)'}\n` +
        `Review before merging.${reason}\n\n${cost}`
      );
    case 'failed':
      return `Failed.${reason} The branch and worktree are left in place for inspection.\n\n${cost}`;
    case 'cancelled':
      return `Cancelled.${reason}\n\n${cost}`;
  }
}
