/**
 * The pending-question lifecycle.
 *
 * Thin on purpose: plan 03 owns correlation tiers (D-06) and the deadline sweep
 * (D-05). What is fixed here is the boundary -- this module reaches `runs.state`
 * only through `engine.transition()` and never writes that column itself
 * (06-CONTEXT D-01, research invariant 6).
 */
import { randomUUID } from 'node:crypto';
import type { PendingQuestion, RunId } from '../domain/types.js';
import type { Config, Logger, Store } from '../domain/ports.js';
import type { RunEngine } from './run-engine.js';

/** D-05: four hours, configurable. Data in SQLite, never a `setTimeout`. */
export const DEFAULT_QUESTION_TIMEOUT_MS = 4 * 60 * 60 * 1000;

export interface Questions {
  openQuestion(runId: RunId, text: string, assumption: string): Promise<PendingQuestion>;
  applyAnswer(questionId: string, answer: string): Promise<PendingQuestion | null>;
}

export interface QuestionsDeps {
  store: Store;
  engine: RunEngine;
  config: Config;
  log: Logger;
  now?: () => number;
}

export function createQuestions(deps: QuestionsDeps): Questions {
  const { store, engine, config, log } = deps;
  const now = deps.now ?? Date.now;
  const timeoutMs = config.defaults.questionTimeoutMs ?? DEFAULT_QUESTION_TIMEOUT_MS;

  return {
    /**
     * The caller (the engine) has already released the slot by the time we get
     * here. That ordering is the engine's obligation, not ours -- see the
     * `needs_input` arm of run-engine.ts.
     */
    async openQuestion(runId, text, assumption) {
      const at = now();
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
      };
      store.insertQuestion(question);
      await engine.transition(runId, 'awaiting_answer', `question ${question.id}`);
      log.info({ runId, questionId: question.id, deadlineAt: question.deadlineAt }, 'question opened');
      return question;
    },

    async applyAnswer(questionId, answer) {
      const question = store.getQuestion(questionId);
      if (!question || question.status !== 'open') {
        log.warn({ questionId }, 'answer for a question that is not open');
        return null;
      }
      store.updateQuestion(questionId, { status: 'answered', answer });
      await engine.transition(question.runId, 'running', `answer to ${questionId}`);
      return { ...question, status: 'answered', answer };
    },
  };
}
