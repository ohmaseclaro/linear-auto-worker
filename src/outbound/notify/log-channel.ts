/**
 * The channel that cannot be turned off (D-04 / NOTF-01).
 *
 * It takes no config — no toggle, no mapping lookup, no `enabled` flag — so there is
 * nothing to set to `false`. `Notifier` constructs it itself rather than accepting it in
 * the channel array, which is what makes "every state transition produces one structured,
 * greppable line" a property of the type rather than a convention.
 *
 * 05-CONTEXT specifics: with no dashboard, this output IS the UI. Log line quality is a
 * deliverable here, not a debugging aid.
 */

import type { LogFn } from '../linear-client.js';
import type { NotifyChannel, RunEvent } from './notifier.js';

export class LogChannel implements NotifyChannel {
  readonly name = 'log';
  private readonly log: LogFn;

  // Explicit field assignment, not a parameter property: `erasableSyntaxOnly` (TRAPS T35).
  constructor(log: LogFn) {
    this.log = log;
  }

  /** Unconditional, and takes no event into account. There is no path that returns false. */
  enabled(_e: RunEvent): boolean {
    return true;
  }

  async emit(e: RunEvent): Promise<void> {
    // Explicit allow-list rather than a spread: a future RunEvent field is not silently
    // logged just because someone added it to the type.
    const fields: Record<string, unknown> = {
      runId: e.runId,
      issueId: e.issueId,
      issueIdentifier: e.issueIdentifier,
      issueUrl: e.issueUrl,
      mappingId: e.mappingId,
      kind: e.kind,
      at: e.at,
    };

    if (e.kind === 'question_asked') {
      fields.question = e.question;
    }

    if (e.kind === 'terminal') {
      // NOTF-06 / DELV-05: cost, tokens and the PR url all reach the log, not just Linear.
      fields.state = e.state;
      fields.costUsd = e.costUsd;
      fields.tokensUsed = e.tokensUsed;
      if (e.prUrl !== undefined) fields.prUrl = e.prUrl;
      if (e.reason !== undefined) fields.reason = e.reason;
    }

    try {
      this.log(fields, `run.${e.kind}`);
    } catch {
      // ponytail: the log sink is the last resort — there is nowhere left to report a
      // failure to write to it, and throwing here would defeat the entire never-rejects
      // contract that D-05's finally-emission depends on.
    }
  }
}
