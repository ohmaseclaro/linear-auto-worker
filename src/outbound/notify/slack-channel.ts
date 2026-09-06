/**
 * Slack, and only when the operator needs to act (D-02 / NOTF-03/NOTF-04).
 *
 * The gate is `enabled()`: `'terminal'` or `'question_asked'`, nothing else. Progress
 * milestones — picked up, worktree ready, agent started — never reach Slack, while still
 * reaching Linear via `LinearCommentChannel`. That difference lives entirely here, so the
 * fan-out loop in `notifier.ts` stays kind-agnostic and a fifth channel is a constructor
 * argument rather than another branch in the loop.
 *
 * The webhook URL is itself the posting credential (threat T-05-06): anyone holding it can
 * post to the operator's channel. It is never logged in full and never appears in an error
 * message this file throws — the notifier logs `error` strings, and a `fetch` failure can
 * quote the request URL back at you.
 *
 * One `fetch` POST, no Slack client dependency.
 */

import { composeBody } from './linear-channel.js';
import type { LogFn } from '../linear-client.js';
import type { NotifyChannel, RunEvent, RunEventKind } from './notifier.js';

/** D-02: Slack reaches the operator when they are not looking at Linear. */
const SLACK_KINDS: ReadonlyArray<RunEventKind> = ['terminal', 'question_asked'];

/** Enough to tell two configured webhooks apart, not enough to post with. */
export function maskWebhookUrl(url: string): string {
  return `***${url.slice(-4)}`;
}

/** Never let the credential travel inside a message that will be logged. */
function scrub(text: string, url: string): string {
  return url ? text.split(url).join(maskWebhookUrl(url)) : text;
}

export interface SlackChannelOptions {
  /** Per-mapping Slack incoming webhook, or undefined when Slack is off for that mapping. */
  webhookUrl: (mappingId: string) => string | undefined;
  log?: LogFn;
  /** Test seam. Production uses the built-in global. */
  fetch?: typeof globalThis.fetch;
}

export class SlackChannel implements NotifyChannel {
  readonly name = 'slack';
  private readonly webhookUrl: (mappingId: string) => string | undefined;
  private readonly log: LogFn;
  private readonly fetch: typeof globalThis.fetch;

  constructor(opts: SlackChannelOptions) {
    this.webhookUrl = opts.webhookUrl;
    this.log = opts.log ?? (() => {});
    this.fetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  enabled(e: RunEvent): boolean {
    return SLACK_KINDS.includes(e.kind) && Boolean(this.webhookUrl(e.mappingId));
  }

  async emit(e: RunEvent): Promise<void> {
    const url = this.webhookUrl(e.mappingId);
    if (!url) return;

    // Same curated summary the Linear comment renders, plus the identity and link Slack
    // lacks the context to supply on its own.
    const text = `*${e.issueIdentifier}* — ${composeBody(e)}\n${e.issueUrl}`;

    let response: Response;
    try {
      response = await this.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      });
    } catch (err) {
      // A transport error message can quote the full request URL — scrub before rethrowing,
      // because the notifier logs whatever message comes out of here.
      const message = scrub(err instanceof Error ? err.message : String(err), url);
      throw new Error(`slack POST to ${maskWebhookUrl(url)} failed: ${message}`);
    }

    if (!response.ok) {
      this.log(
        {
          severity: 'warn',
          runId: e.runId,
          issueId: e.issueId,
          kind: e.kind,
          webhook: maskWebhookUrl(url),
          status: response.status,
        },
        'notify.slack_rejected',
      );
      // Thrown, not swallowed: this is what puts the POST through the notifier's bounded
      // retry. Its eventual permanent failure is still only a logged warning.
      throw new Error(`slack POST to ${maskWebhookUrl(url)} returned ${response.status}`);
    }
  }
}
