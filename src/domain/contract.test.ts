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
  BOT_COMMENT_MARKER,
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
    /assumption/,
  );

  assert.deepEqual(parseAgentResult({ status: 'cancelled' }), { status: 'cancelled' });
  assert.deepEqual(
    parseAgentResult({
      status: 'needs_input',
      summary: 's',
      question: 'q',
      assumption: 'a',
      extra: 'ignored',
    }),
    { status: 'needs_input', summary: 's', question: 'q', assumption: 'a' },
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

/**
 * T119. The marker's whole job is to be invisible in every renderer it reaches, and
 * Linear has no HTML-comment rule at all — the old form arrived as a plain text node and
 * the operator read it on every ticket for a milestone. A CommonMark link reference
 * definition produces no output *by specification*, which is the property being pinned
 * here: a marker whose invisibility is incidental is one parser away from visible.
 */
test('the bot marker is a link reference definition, which renders as nothing (T119)', () => {
  assert.match(BOT_COMMENT_MARKER, /^\[\/\/\]: # \(.+\)$/);
  assert.match(questionMarker('abcdef01-2345-6789'), /^\[\/\/\]: # \(.+\)$/);
});

/**
 * The migration guard. Every bot comment written before 2026-09-09 carries the legacy
 * HTML-comment form, and nothing rewrites them — so the loop guard has to keep reading
 * both for as long as those comments are reachable.
 */
test('isBotAuthoredBody recognises BOTH the new marker and the legacy form', () => {
  assert.equal(isBotAuthoredBody(`${BOT_COMMENT_MARKER}\n\nstatus update`), true);
  assert.equal(isBotAuthoredBody(`${questionMarker('abcdef01-2345')}\n\nwhich database?`), true);
  // GREEN at HEAD by design: this arm is the non-regression, not the new behaviour.
  assert.equal(isBotAuthoredBody('<!-' + '- law-bot\n\nposted last month'), true);
  assert.equal(isBotAuthoredBody('a human reply'), false);
});
