/**
 * The fan-out notifier.
 *
 * Two structural properties this module exists to enforce, neither of which is a runtime
 * check anyone could skip:
 *
 *  - **The log channel cannot be turned off (D-04 / NOTF-01).** `Notifier` constructs its
 *    own `LogChannel` and emits to it directly; the constructor accepts only *additional*
 *    channels. There is no argument, config key, or channel array that removes it, so it
 *    is impossible to add a notification path that forgets to log. With no dashboard, the
 *    structured log IS the UI.
 *  - **`emit()` never rejects (D-03 / NOTF-06).** Every non-log channel runs under bounded
 *    exponential backoff; a permanently dead channel produces one `notify.channel_failed`
 *    warning and nothing else. This is what makes D-05's pattern — emit the terminal event
 *    from a `finally` — safe: a notifier that threw from inside a `finally` would replace
 *    the run's real error with its own, and a Slack outage would discard a run that had
 *    already produced a working PR.
 */

import { LogChannel } from './log-channel.js';
import { LinearCommentChannel } from './linear-channel.js';
import { SlackChannel } from './slack-channel.js';
import type { LinearClient, LogFn } from '../linear-client.js';

export type { LogFn };

/**
 * D-01: milestones only, roughly 4-6 per run — not a stream of steps. Every comment the
 * bot posts is itself an event Phase 3's four loop guards must filter, so comment volume
 * is not free.
 */
export type RunEventKind =
  | 'picked_up'
  | 'worktree_ready'
  | 'agent_started'
  | 'question_asked'
  | 'terminal';

/** Fields every event carries, whatever its kind. */
interface RunEventBase {
  runId: string;
  issueId: string;
  issueIdentifier: string;
  issueUrl: string;
  /**
   * Which config mapping this run belongs to. Both toggleable channels gate on it —
   * `postLinearComments` and the Slack webhook lookup are per-mapping (Phase 1 D-09).
   */
  mappingId: string;
  /** Epoch ms. */
  at: number;
}

export type TerminalRunState = 'delivered' | 'partial' | 'failed' | 'cancelled';

export type RunEvent =
  | (RunEventBase & { kind: 'picked_up' | 'worktree_ready' | 'agent_started' })
  | (RunEventBase & { kind: 'question_asked'; question: string })
  | (RunEventBase & {
      kind: 'terminal';
      state: TerminalRunState;
      costUsd: number;
      tokensUsed: number;
      prUrl?: string;
      /**
       * A short human phrase, never a full error object or an agent transcript
       * (DELV-05 / threat T-05-05 — either could carry a secret).
       */
      reason?: string;
    });

/** What a channel may hand back. Only the Linear channel populates it, and only for questions. */
export interface NotifyResult {
  linearCommentId?: string;
}

export interface NotifyChannel {
  readonly name: string;
  /** Kind- and config-based gating lives here, per channel — never in the fan-out loop. */
  enabled(e: RunEvent): boolean;
  emit(e: RunEvent): Promise<NotifyResult | void>;
}

export interface RetryOptions {
  /** Total tries, including the first. `n` attempts means at most `n - 1` waits. */
  attempts: number;
  baseDelayMs: number;
  /** Ceiling on a single wait — the bounded half of D-03. */
  maxDelayMs: number;
}

export type DelayFn = (ms: number) => Promise<void>;

/**
 * Worst case 3 tries and 1.5s of total waiting per channel per event. Deliberately small:
 * the content being retried is already in the log, so a long retry only makes a healthy
 * run look stalled (threat T-05-07).
 */
export const DEFAULT_RETRY: RetryOptions = { attempts: 3, baseDelayMs: 500, maxDelayMs: 4_000 };

const sleep: DelayFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn` up to `opts.attempts` times with exponential backoff, each wait clamped to
 * `opts.maxDelayMs`. Rethrows the last error once the budget is spent — `Notifier` is what
 * turns that into a logged warning.
 *
 * `delay` is injected so tests exercise the real backoff arithmetic without real waiting.
 */
export async function withBoundedRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions,
  delay: DelayFn = sleep,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < opts.attempts; attempt += 1) {
    if (attempt > 0) {
      await delay(Math.min(opts.baseDelayMs * 2 ** (attempt - 1), opts.maxDelayMs));
    }
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

/** Never let a raw error object reach a log line — it can carry secrets (threat T-05-02). */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface NotifierOptions {
  /** Same injection shape as `LinearClientImpl`: Phase 7 wires the real pino child. */
  log: LogFn;
  /** Channels *in addition to* the log channel. The log channel is not listed here by design. */
  channels?: NotifyChannel[];
  retry?: RetryOptions;
  delay?: DelayFn;
}

export class Notifier {
  /**
   * Not in `channels`, not optional, not constructible around. This field is D-04.
   */
  private readonly logChannel: LogChannel;
  private readonly channels: NotifyChannel[];
  private readonly log: LogFn;
  private readonly retry: RetryOptions;
  private readonly delay: DelayFn;

  // No constructor parameter properties: `erasableSyntaxOnly` forbids them (TRAPS T35).
  constructor(opts: NotifierOptions) {
    this.log = opts.log;
    this.logChannel = new LogChannel(opts.log);
    this.channels = opts.channels ?? [];
    this.retry = opts.retry ?? DEFAULT_RETRY;
    this.delay = opts.delay ?? sleep;
  }

  /**
   * Fan out one event. Resolves always — a rejection here would be a bug, not a signal.
   */
  async emit(e: RunEvent): Promise<NotifyResult> {
    // First, directly, unretried, ungated. Even if every other channel is misconfigured to
    // the point that its constructor arguments are wrong, the line still goes out.
    await this.logChannel.emit(e);

    const active = this.channels.filter((c) => this.isEnabled(c, e));
    const settled = await Promise.allSettled(
      active.map((c) => withBoundedRetry(() => c.emit(e), this.retry, this.delay)),
    );

    const out: NotifyResult = {};
    settled.forEach((result, i) => {
      const channel = active[i]!;
      if (result.status === 'rejected') {
        this.warnChannel(channel.name, e, result.reason);
        return;
      }
      const id = result.value && 'linearCommentId' in result.value
        ? result.value.linearCommentId
        : undefined;
      if (id) out.linearCommentId = id;
    });
    return out;
  }

  /** A channel whose gate itself throws is skipped, not fatal. */
  private isEnabled(c: NotifyChannel, e: RunEvent): boolean {
    try {
      return c.enabled(e);
    } catch (err) {
      this.warnChannel(c.name, e, err);
      return false;
    }
  }

  private warnChannel(channel: string, e: RunEvent, err: unknown): void {
    this.log(
      {
        // `severity` rather than `level` so it cannot collide with pino's own field.
        severity: 'warn',
        channel,
        runId: e.runId,
        issueId: e.issueId,
        kind: e.kind,
        error: messageOf(err),
      },
      'notify.channel_failed',
    );
  }
}

export interface CreateNotifierOptions {
  log: LogFn;
  linearClient: LinearClient;
  /** Per-mapping toggle. Turning it off costs zero logging — that is the point of D-04. */
  postLinearComments: (mappingId: string) => boolean;
  /** Per-mapping Slack incoming-webhook URL, or undefined when Slack is off for it. */
  webhookUrl: (mappingId: string) => string | undefined;
  retry?: RetryOptions;
  delay?: DelayFn;
  fetch?: typeof globalThis.fetch;
}

/**
 * The one wiring point: the built-in LogChannel, plus LinearCommentChannel and SlackChannel.
 *
 * Note what is *not* here — no `if (kind === 'terminal')`, no Slack special case. Which
 * kinds reach which channel is each channel's own `enabled()`, so the fan-out loop above
 * stays kind-agnostic and adding a fifth channel is a constructor argument rather than an
 * edit to `emit()`. And because `LogChannel` is not in this array, no future edit to it —
 * including deleting both entries — can remove logging.
 */
export function createNotifier(opts: CreateNotifierOptions): Notifier {
  return new Notifier({
    log: opts.log,
    channels: [
      new LinearCommentChannel({
        client: opts.linearClient,
        postLinearComments: opts.postLinearComments,
        log: opts.log,
      }),
      new SlackChannel({
        webhookUrl: opts.webhookUrl,
        log: opts.log,
        fetch: opts.fetch,
      }),
    ],
    retry: opts.retry,
    delay: opts.delay,
  });
}
