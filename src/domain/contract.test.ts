/**
 * The contract's own runnable logic, which is small and deliberately so: a parser at a
 * trust boundary, one merge, one enumerable table, and the marker helpers. Everything
 * else in `src/domain/` is types, and `tsc` is its test.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseAgentResult } from './agent-result.js';
import { RUN_STATE_TABLE, canTransition } from './state-machine.js';
import {
  isBotAuthoredBody,
  questionMarker,
  questionShortCode,
  resolveToggles,
  type MappingToggles,
} from './types.js';

test('parseAgentResult narrows on status and refuses anything else (T-01-05)', () => {
  // The child's stdout is attacker-influenceable once an issue body reaches the prompt.
  assert.throws(() => parseAgentResult('complete'), /not an object/);
  assert.throws(() => parseAgentResult({ status: 'shipped' }), /unknown agent result status/);
  // A crafted object cannot become a completed delivery by omitting the PR fields.
  assert.throws(() => parseAgentResult({ status: 'complete', summary: 'done' }), /prTitle/);
  assert.throws(
    () => parseAgentResult({ status: 'needs_input', summary: 's', question: 'q' }),
    /assumptionIfUnanswered/,
  );

  assert.deepEqual(parseAgentResult({ status: 'cancelled' }), { status: 'cancelled' });
  assert.deepEqual(
    parseAgentResult({
      status: 'needs_input',
      summary: 's',
      question: 'q',
      assumptionIfUnanswered: 'a',
      extra: 'ignored',
    }),
    { status: 'needs_input', summary: 's', question: 'q', assumptionIfUnanswered: 'a' },
  );
});

test('RUN_STATE_TABLE is enumerable and awaiting_answer holds no slot', () => {
  const states = Object.keys(RUN_STATE_TABLE);
  assert.equal(states.length, 9, 'a tenth state must not escape the table');
  // Invariant 1: an hours-long human wait costs the daemon nothing.
  assert.equal(RUN_STATE_TABLE.awaiting_answer.holdsSlot, false);
  assert.equal(RUN_STATE_TABLE.awaiting_answer.hasLiveChild, false);
  assert.equal(RUN_STATE_TABLE.running.holdsSlot, true);
  assert.equal(RUN_STATE_TABLE.running.hasLiveChild, true);
  for (const info of Object.values(RUN_STATE_TABLE)) {
    if (info.terminal) assert.equal(info.holdsSlot, false, `${info.state} is terminal`);
  }
});

test('canTransition is state-to-state and terminal states stay put', () => {
  assert.equal(canTransition('queued', 'preparing'), true);
  assert.equal(canTransition('running', 'awaiting_answer'), true);
  assert.equal(canTransition('awaiting_answer', 'running'), true);
  assert.equal(canTransition('delivering', 'partial'), true);
  assert.equal(canTransition('delivered', 'running'), false);
  // The one documented exception: an explicit operator requeue.
  assert.equal(canTransition('failed', 'queued'), true);
});

const DEFAULTS: MappingToggles = {
  postLinearComments: true,
  notifySlack: true,
  baseBranch: 'main',
  draftPr: false,
  questionsEnabled: true,
  maxRunMs: 60 * 60 * 1000,
  questionTimeoutMs: 4 * 60 * 60 * 1000,
};

test('resolveToggles spreads a sparse override over the defaults (D-09)', () => {
  assert.equal(resolveToggles(DEFAULTS, {}).baseBranch, 'main');
  assert.equal(resolveToggles(DEFAULTS, undefined).draftPr, false);
  const resolved = resolveToggles(DEFAULTS, { overrides: { draftPr: true, baseBranch: 'trunk' } });
  assert.equal(resolved.draftPr, true);
  assert.equal(resolved.baseBranch, 'trunk');
  assert.equal(resolved.notifySlack, true, 'untouched toggles come from the defaults');
});

test('the bot marker is actor-independent and carries the question short code (T32)', () => {
  const marker = questionMarker('abcdef01-2345-6789');
  // The loop guard must fire on the bot's own question comments too.
  assert.equal(isBotAuthoredBody(`${marker}\nShould /health check the database?`), true);
  assert.equal(isBotAuthoredBody('a human reply'), false);
  assert.equal(questionShortCode(`${marker} body`), 'abcdef01');
  assert.equal(questionShortCode('no marker here'), null);
});
