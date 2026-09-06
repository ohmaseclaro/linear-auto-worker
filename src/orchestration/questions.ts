/**
 * The pending-question lifecycle: posted, correlated, deadlined, and durable
 * across a restart.
 *
 * Two rules carry this module's bug density.
 *
 * 1. **The deadline is data, not a timer** (D-05, invariant 8). `deadlineAt` is
 *    an absolute epoch-millisecond column on the `questions` row, swept by
 *    `sweep(now)` which Phase 7 drives from the daemon tick. Nothing here
 *    registers a callback: a scheduled callback is process-local state, and a
 *    restart erases it silently, leaving a run to wait forever on a fallback
 *    that no longer exists.
 * 2. **Correlation is threaded-first with a top-level fallback** (D-06), keyed
 *    on the stored `linearCommentId` and never on recency (invariant 13).
 *
 * Boundary: this module reaches `runs.state` only through `engine.transition()`
 * and never writes that column itself (06-CONTEXT D-01, research invariant 6).
 * Resumption goes through `engine.handle()`, which owns slot re-acquisition and
 * the `--resume` spawn.
 */
import { randomUUID } from 'node:crypto';
import type { PendingQuestion, Run, RunId } from '../domain/types.js';
import type { Config, DomainEvent, LinearClient, Logger, Store } from '../domain/ports.js';
// T32: the marker constants live in `src/domain/` and are reached through the
// barrel. Never declared, re-exported or re-derived here -- a second copy is
// exactly what makes the loop-prevention filter unmergeable.
import {
  BOT_COMMENT_MARKER_PREFIX,
  QUESTION_MARKER_PREFIX,
  isBotAuthoredBody,
  resolveToggles,
} from '../domain/index.js';
import type { RunEngine } from './run-engine.js';

/** D-05: four hours, configurable per mapping. Data in SQLite, never a `setTimeout`. */
export const DEFAULT_QUESTION_TIMEOUT_MS = 4 * 60 * 60 * 1000;

/**
 * The shape correlation needs from a Linear comment. Deliberately structural and
 * minimal: Phase 3 builds one from a webhook payload, and plan 04's boot recovery
 * builds one from a comment it listed off the API. Both feed the same
 * `correlate()` rather than growing a second, divergent matcher.
 */
export interface AnswerComment {
  id: string;
  issueId: string;
  /** Threaded replies carry the parent comment's id. Top-level replies carry null. */
  parentId: string | null;
  body: string;
  authorId: string | null;
  authorName: string | null;
}

export type Correlation =
  /** tier 1 = threaded (`parentId`), tier 2 = top-level with exactly one open question. */
  | { outcome: 'matched'; question: PendingQuestion; tier: 1 | 2 }
  | { outcome: 'ambiguous'; candidates: readonly PendingQuestion[] }
  | { outcome: 'none'; reason: 'bot_authored' | 'no_open_questions' | 'unknown_thread' };

/**
 * Pure. Returns a match, an ambiguity, or nothing -- never a guess.
 *
 * Exported because plan 04's boot recovery correlates comments it listed straight
 * from the API. Those comments never passed through Phase 3's four ingress guards,
 * which is why the bot-author drop lives *here* rather than at the ingress
 * boundary: a check that only exists in ingress is a check boot recovery skips.
 *
 * Correlates on the stored `linearCommentId` and never on the comment body:
 * SQLite is the source of truth and Linear comments are an editable projection,
 * so re-parsing a body to recover which question is which is re-targetable after
 * the fact (T-06-13).
 */
export function correlate(
  comment: AnswerComment,
  openQuestions: readonly PendingQuestion[],
  botUserId: string,
): Correlation {
  // Guard, before either tier. Two independent tests because the actor can be
  // null on a comment we authored through the API, and a cached bot id goes
  // stale the day the bot user is re-created.
  if (comment.authorId === botUserId || isBotAuthoredBody(comment.body)) {
    return { outcome: 'none', reason: 'bot_authored' };
  }

  const open = openQuestions.filter((q) => q.status === 'open');
  if (open.length === 0) return { outcome: 'none', reason: 'no_open_questions' };

  // Tier 1 (D-06, QA-04) -- threading. Exact, and correct with any number of
  // open questions on the ticket, which is the normal case once multi-repo
  // lands. No ordering is consulted: picking the newest here is the bug that
  // appears the day two runs share a ticket.
  if (comment.parentId !== null) {
    const threaded = open.find((q) => q.linearCommentId === comment.parentId);
    return threaded
      ? { outcome: 'matched', question: threaded, tier: 1 }
      : // A parented comment that matches no question is a reply in someone
        // else's thread. It is not a candidate for the top-level fallback.
        { outcome: 'none', reason: 'unknown_thread' };
  }

  // Tier 2 (D-06) -- the top-level fallback. Replying in the main box instead of
  // the thread is the mistake everyone makes, and silently ignoring it is
  // indistinguishable from the bot being broken. The exactly-one guard is what
  // keeps the fallback from becoming a guess (T-06-12).
  if (open.length === 1) return { outcome: 'matched', question: open[0]!, tier: 2 };
  return { outcome: 'ambiguous', candidates: open };
}

export interface Questions {
  openQuestion(runId: RunId, text: string, assumption: string): Promise<PendingQuestion | null>;
  applyAnswer(questionId: string, answer: string): Promise<PendingQuestion | null>;
  /** Correlate one inbound comment and, on a match, resume its run. */
  ingestComment(comment: AnswerComment): Promise<Correlation>;
  /** Expire every question whose stored deadline has passed. Driven by the tick. */
  sweep(now: number): Promise<PendingQuestion[]>;
}

export interface QuestionsDeps {
  store: Store;
  engine: RunEngine;
  config: Config;
  linear: LinearClient;
  log: Logger;
  now?: () => number;
}

export function createQuestions(deps: QuestionsDeps): Questions {
  const { store, engine, config, linear, log } = deps;
  const now = deps.now ?? Date.now;

  /**
   * Decisions this process has already made about an in-flight question, applied
   * when the engine calls back into `applyAnswer`. It carries the answering
   * author (which `applyAnswer`'s engine-fixed two-argument signature cannot) and
   * the terminal status, so an expiry lands as `expired` rather than `answered`.
   *
   * ponytail: also the sweep's dedupe, so a second tick in the same process does
   * not resume twice. It holds no deadline -- that lives in the `deadlineAt`
   * column -- so losing this map to a restart costs at most one repeated expiry
   * of a row that is still `open` and still overdue, which is the correct action
   * anyway. Move it into a claim column only if the daemon ever runs two sweepers.
   */
  const resolutions = new Map<string, { status: 'answered' | 'expired'; answeredBy: string | null }>();

  /** Every comment this module writes carries the marker: it is the loop guard. */
  function botBody(body: string): string {
    return `${BOT_COMMENT_MARKER_PREFIX}${body}`;
  }

  async function post(issueId: string, body: string, parentId?: string | null): Promise<string | null> {
    try {
      const c = await linear.createComment(issueId, botBody(body), parentId ?? undefined);
      return c.id;
    } catch (err) {
      // Never fragile: a comment we could not post is a worse record, not a
      // stalled run. The deadline and the structured log both survive it.
      log.error({ issueId, err: String(err) }, 'failed to post comment');
      return null;
    }
  }

  /**
   * The single resume path. An answer and an expiry converge here -- two paths
   * would drift, and the drift would only show up on the timeout branch that
   * nobody exercises by hand.
   *
   * The answer text is opaque data. It is handed to the engine as a string and
   * is never interpreted, formatted or interpolated by the orchestrator; the
   * resume-prompt composition in Phase 4 owns delimiting it as untrusted and
   * stripping control and zero-width characters (AGNT criterion 6, T-06-11).
   */
  async function resumeWith(run: Run, questionId: string | null, input: string): Promise<void> {
    const event: DomainEvent =
      questionId !== null
        ? { kind: 'question.answered', questionId, answer: input }
        : // CONTRACT ADDITION -- see 06-03-SUMMARY.md. The QA-07 branch has no
          // question row by construction, so it cannot key off `question.answered`.
          { kind: 'run.resumed', runId: run.id, input, reason: 'question_flow_disabled' };
    await engine.handle(event);
  }

  /**
   * The toggles governing this run, resolved from the run row rather than from
   * the issue. The repo a run owns is recorded at creation (06-01), so a mapping
   * edited mid-run cannot move a live run to another mapping's settings.
   *
   * `Object.values` because the ADDENDUM's `mappings` is a Record and 01-02's is
   * an array; this reads correctly against either.
   */
  function togglesFor(run: Run) {
    const mappings = Object.values(config.mappings ?? {}) as Array<{
      repos?: Array<{ repoDir: string }>;
    }>;
    const mapping = mappings.find((m) => m.repos?.some((r) => r.repoDir === run.repoDir));
    return mapping ? resolveToggles(config.defaults, mapping) : config.defaults;
  }

  async function expire(q: PendingQuestion, run: Run): Promise<void> {
    resolutions.set(q.id, { status: 'expired', answeredBy: null });
    // T-06-15: the record has to show what was decided, not leave the operator
    // to infer it from the diff.
    await post(
      run.issueId,
      `No answer within the deadline — proceeding with the stated assumption:\n\n> ${q.assumption}`,
      q.linearCommentId,
    );
    log.warn({ runId: run.id, questionId: q.id, deadlineAt: q.deadlineAt }, 'question expired');
    await resumeWith(run, q.id, q.assumption);
  }

  return {
    /**
     * The caller (the engine) has already released the slot by the time we get
     * here. That ordering is the engine's obligation, not ours -- see the
     * `needs_input` arm of run-engine.ts.
     *
     * Returns null when the mapping has the question flow switched off.
     */
    async openQuestion(runId, text, assumption) {
      const run = store.getRun(runId);
      if (!run) throw new Error(`no such run: ${runId}`);
      const toggles = togglesFor(run);

      // QA-07 -- the non-blocking branch, kept adjacent to the blocking one on
      // purpose: the difference between them is one `if`, not two subsystems.
      // No question row, no `awaiting_answer`, no wait. The run never blocked,
      // so it never released its slot and never has to re-acquire one.
      if (toggles.questionFlow === false) {
        await post(
          run.issueId,
          `Question flow is off for this mapping — proceeding with the stated assumption:\n\n> ${assumption}`,
        );
        log.info({ runId, assumption }, 'question flow disabled; proceeding on the assumption');
        await resumeWith(run, null, assumption);
        return null;
      }

      const at = now();
      // Resolved at open time and stored as an absolute instant, not a duration:
      // a config edit must not retroactively move a deadline already announced
      // on the ticket.
      const timeoutMs = toggles.questionTimeoutMs ?? DEFAULT_QUESTION_TIMEOUT_MS;
      const question: PendingQuestion = {
        id: randomUUID(),
        runId,
        text,
        assumption,
        linearCommentId: null,
        askedAt: at,
        // Absolute epoch ms, so a restart cannot erase the fallback.
        deadlineAt: at + timeoutMs,
        status: 'open',
        answer: null,
        answeredBy: null,
      };
      store.insertQuestion(question);

      // Posted after the row exists: a question we failed to post still has a
      // deadline, whereas a question we failed to persist has nothing.
      const shortCode = `${QUESTION_MARKER_PREFIX}${question.id.slice(0, 8)}`;
      const commentId = await post(
        run.issueId,
        `${text}\n\n---\n_Reply in this thread to answer._ \`${shortCode}\`\n` +
          `Unanswered, I will proceed with: ${assumption}`,
      );
      if (commentId) {
        // Tier 1 correlation reads exactly this column.
        store.updateQuestion(question.id, { linearCommentId: commentId });
        question.linearCommentId = commentId;
      }

      await engine.transition(runId, 'awaiting_answer', `question ${question.id}`);
      log.info({ runId, questionId: question.id, deadlineAt: question.deadlineAt }, 'question opened');
      return question;
    },

    /**
     * Called by the engine once it has re-acquired a slot. Transitions only
     * questions still `open`; anything else returns without effect, so a
     * replayed delivery cannot resume a run twice.
     */
    async applyAnswer(questionId, answer) {
      const question = store.getQuestion(questionId);
      if (!question || question.status !== 'open') {
        log.warn({ questionId }, 'answer for a question that is not open');
        return null;
      }
      const decided = resolutions.get(questionId) ?? { status: 'answered' as const, answeredBy: null };
      resolutions.delete(questionId);
      const patch = { status: decided.status, answer, answeredBy: decided.answeredBy };
      store.updateQuestion(questionId, patch);
      await engine.transition(question.runId, 'running', `answer to ${questionId}`);
      return { ...question, ...patch };
    },

    async ingestComment(comment) {
      const result = correlate(
        comment,
        store.openQuestionsForIssue(comment.issueId),
        config.botUserId,
      );
      if (result.outcome === 'ambiguous') {
        // Reported, never guessed at: two open questions and a top-level reply
        // cannot be told apart, and picking one crosses two runs' answers.
        log.warn(
          { issueId: comment.issueId, commentId: comment.id, open: result.candidates.length },
          'top-level reply with more than one open question; reply in the thread',
        );
        return result;
      }
      if (result.outcome === 'none') {
        log.debug({ commentId: comment.id, reason: result.reason }, 'comment correlated to nothing');
        return result;
      }

      const q = result.question;
      const run = store.getRun(q.runId);
      if (!run) {
        log.warn({ questionId: q.id, runId: q.runId }, 'question with no run');
        return { outcome: 'none', reason: 'no_open_questions' };
      }
      resolutions.set(q.id, { status: 'answered', answeredBy: comment.authorName });
      log.info({ runId: run.id, questionId: q.id, tier: result.tier }, 'answer correlated');
      await resumeWith(run, q.id, comment.body);
      return result;
    },

    /**
     * Expiry is a query, not a callback. `expiredQuestions` selects rows still
     * `open` whose stored `deadlineAt` has passed -- so the fallback is whatever
     * is in the database at tick time, and a restart between opening a question
     * and its deadline changes nothing.
     */
    async sweep(sweepAt) {
      const due = store.expiredQuestions(sweepAt);
      const expired: PendingQuestion[] = [];
      for (const q of due) {
        if (resolutions.has(q.id)) continue; // already claimed by this process
        const run = store.getRun(q.runId);
        if (!run) {
          log.warn({ questionId: q.id, runId: q.runId }, 'overdue question with no run');
          continue;
        }
        await expire(q, run);
        expired.push(q);
      }
      return expired;
    },
  };
}
