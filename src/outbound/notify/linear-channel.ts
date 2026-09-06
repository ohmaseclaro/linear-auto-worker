/**
 * Milestone comments on the Linear issue (D-01: roughly 4-6 per run, never a stream).
 *
 * Three things this file is careful about:
 *
 *  - **The marker is imported, never redefined (TRAPS T32 / D-09 / threat T-05-04).**
 *    `BOT_COMMENT_MARKER_PREFIX` lives in `src/domain/` because two owners share it: this
 *    channel writes it onto every comment, and Phase 3's filter drops any comment carrying
 *    it regardless of actor. A second local copy silently breaks that filter and the break
 *    presents as a webhook loop burning the shared Linear request budget. Two phases
 *    already invented two different homes for this constant — this is the settled one.
 *  - **Bodies are composed only from RunEvent fields (threat T-05-05).** Never an agent's
 *    raw stdout, never a stack trace, never a filesystem path: a Linear comment is
 *    human-visible on a shared ticket and any of those could carry a secret.
 *  - **Every successful write is announced to Phase 3 via `noteSelfWrite`.** That feeds the
 *    `suppression:self-write` guard, which reads zero until the writer says a write
 *    happened — ingress cannot know on its own (03-CONTEXT D-09).
 *
 * `QUESTION_MARKER_PREFIX` is deliberately absent. The per-question short code is Phase 6's
 * correlation concern, not this channel's.
 */

import { BOT_COMMENT_MARKER_PREFIX } from '../../domain/index.js';
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

export interface LinearCommentChannelOptions {
  client: LinearClient;
  /**
   * Per-mapping toggle (NOTF-05). Turning this off costs zero logging, because the log
   * channel is a separate, unconditional entry rather than a peer in the same array.
   */
  postLinearComments: (mappingId: string) => boolean;
  log?: LogFn;
}

export class LinearCommentChannel implements NotifyChannel {
  readonly name = 'linear';
  private readonly client: LinearClient;
  private readonly postLinearComments: (mappingId: string) => boolean;
  private readonly log: LogFn;

  constructor(opts: LinearCommentChannelOptions) {
    this.client = opts.client;
    this.postLinearComments = opts.postLinearComments;
    this.log = opts.log ?? (() => {});
  }

  enabled(e: RunEvent): boolean {
    return this.postLinearComments(e.mappingId);
  }

  async emit(e: RunEvent): Promise<NotifyResult> {
    const body = `${BOT_COMMENT_MARKER_PREFIX}${composeBody(e)}`;
    // No parentId: none of this channel's kinds is itself a reply. Phase 6 threads answers.
    const { id } = await this.client.createComment(e.issueId, body);

    // Must not throw between the write landing and this returning — a rejection here would
    // send the whole emit back through withBoundedRetry and post a duplicate comment.
    try {
      noteSelfWrite('Comment', id);
    } catch (err) {
      this.log(
        {
          severity: 'warn',
          runId: e.runId,
          commentId: id,
          error: err instanceof Error ? err.message : String(err),
        },
        'notify.self_write_note_failed',
      );
    }

    // Phase 6 persists this to correlate the operator's reply back to the question.
    return e.kind === 'question_asked' ? { linearCommentId: id } : {};
  }
}
