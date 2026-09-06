import test from 'node:test';
import assert from 'node:assert/strict';

import type { RunState } from './types.js';
import { TERMINAL } from './types.js';
import type { Trigger } from './state-machine.js';
import {
  acceptsCancel,
  assertTransition,
  cancelIsDeferred,
  deriveParentState,
  hasLiveChild,
  holdsSlot,
  isTerminal,
  nextState,
} from './state-machine.js';
import { IllegalTransitionError } from './errors.js';

const ALL_STATES = [
  'queued',
  'preparing',
  'running',
  'awaiting_answer',
  'delivering',
  'delivered',
  'partial',
  'failed',
  'cancelled',
] as const;

const ALL_TRIGGERS = [
  'claim',
  'worktree_ready',
  'spawned',
  'needs_input',
  'answered',
  'timed_out',
  'agent_complete',
  'delivered',
  'delivered_partial',
  'cancel',
  'error',
  'requeue',
] as const;

/**
 * Compile-time exhaustiveness, derived from the unions themselves rather than from a
 * second hand-written list. Adding a tenth `RunState` or a thirteenth `Trigger` without
 * extending the arrays above makes `tsc --noEmit` fail here, so a new state cannot slip
 * through this suite by simply having no transitions defined for it.
 */
type Unlisted =
  | Exclude<RunState, (typeof ALL_STATES)[number]>
  | Exclude<(typeof ALL_STATES)[number], RunState>
  | Exclude<Trigger, (typeof ALL_TRIGGERS)[number]>
  | Exclude<(typeof ALL_TRIGGERS)[number], Trigger>;
const _exhaustive: [Unlisted] extends [never] ? true : never = true;
void _exhaustive;

/** Every legal transition, exhaustively. Nothing outside this table may resolve. */
const LEGAL: ReadonlyArray<readonly [RunState, Trigger, RunState]> = [
  ['queued', 'claim', 'preparing'],
  ['queued', 'cancel', 'cancelled'],
  ['queued', 'error', 'failed'],

  // A self-transition on purpose: a real milestone that must still produce an event row.
  ['preparing', 'worktree_ready', 'preparing'],
  ['preparing', 'spawned', 'running'],
  ['preparing', 'error', 'failed'],
  ['preparing', 'requeue', 'queued'],
  ['preparing', 'cancel', 'cancelled'],

  ['running', 'needs_input', 'awaiting_answer'],
  ['running', 'agent_complete', 'delivering'],
  ['running', 'error', 'failed'],
  ['running', 'requeue', 'queued'],
  ['running', 'cancel', 'cancelled'],

  ['awaiting_answer', 'answered', 'running'],
  ['awaiting_answer', 'timed_out', 'running'],
  ['awaiting_answer', 'cancel', 'cancelled'],
  ['awaiting_answer', 'error', 'failed'],

  ['delivering', 'delivered', 'delivered'],
  ['delivering', 'delivered_partial', 'partial'],
  ['delivering', 'error', 'failed'],
  ['delivering', 'cancel', 'cancelled'],

  // The one documented exception to "terminal states never transition".
  ['failed', 'requeue', 'queued'],
];

const ILLEGAL: ReadonlyArray<readonly [RunState, Trigger]> = [
  ['delivered', 'requeue'],
  ['partial', 'requeue'],
  ['cancelled', 'cancel'],
  ['delivered', 'error'],
  ['queued', 'spawned'],
  ['running', 'delivered'],
  ['delivering', 'answered'],
  ['preparing', 'agent_complete'],
  ['awaiting_answer', 'spawned'],
  ['queued', 'answered'],
];

test('every legal transition resolves to its stated target state', () => {
  for (const [from, trigger, to] of LEGAL) {
    assert.equal(nextState(from, trigger), to, `${from} --${trigger}--> ${to}`);
    assert.equal(assertTransition(from, trigger), to, `${from} --${trigger}--> ${to}`);
  }
});

test('illegal transitions return null and throw IllegalTransitionError', () => {
  for (const [from, trigger] of ILLEGAL) {
    assert.equal(nextState(from, trigger), null, `${from} --${trigger}--> should not resolve`);
    assert.throws(
      () => assertTransition(from, trigger),
      IllegalTransitionError,
      `${from} --${trigger}--> should throw`,
    );
  }
});

test('no transition exists outside the legal table', () => {
  const legalKeys = new Set(LEGAL.map(([from, trigger]) => `${from}:${trigger}`));
  for (const from of ALL_STATES) {
    for (const trigger of ALL_TRIGGERS) {
      const resolved = nextState(from, trigger) !== null;
      assert.equal(
        resolved,
        legalKeys.has(`${from}:${trigger}`),
        `${from} --${trigger}--> disagrees with the legal table`,
      );
    }
  }
});

test('the legal table plus the terminal states covers all nine states', () => {
  const covered = new Set<RunState>([...LEGAL.map(([from]) => from), ...TERMINAL]);
  assert.deepEqual([...covered].sort(), [...ALL_STATES].sort());
});

test('the nine states partition into slot / child / terminal as D-02 requires', () => {
  assert.deepEqual(ALL_STATES.filter(holdsSlot), ['preparing', 'running', 'delivering']);
  assert.deepEqual(ALL_STATES.filter(hasLiveChild), ['running']);
  assert.deepEqual(ALL_STATES.filter(isTerminal), [
    'delivered',
    'partial',
    'failed',
    'cancelled',
  ]);
});

test('the parked state holds no slot and has no live child', () => {
  // This is what makes an hours-long human wait affordable on a three-slot laptop.
  assert.equal(holdsSlot('awaiting_answer'), false);
  assert.equal(hasLiveChild('awaiting_answer'), false);
  assert.equal(isTerminal('awaiting_answer'), false);
});

test('cancel is accepted from every non-terminal state (D-05)', () => {
  for (const s of ALL_STATES) {
    assert.equal(acceptsCancel(s), !isTerminal(s), `acceptsCancel(${s})`);
  }
  assert.deepEqual(ALL_STATES.filter(acceptsCancel), [
    'queued',
    'preparing',
    'running',
    'awaiting_answer',
    'delivering',
  ]);
});

test('cancel is deferred for exactly the two states with irreversible side effects', () => {
  assert.deepEqual(ALL_STATES.filter(cancelIsDeferred), ['running', 'delivering']);
});

test("a parent's state is a pure function of its children (D-04)", () => {
  assert.equal(deriveParentState([]), 'queued');
  assert.equal(deriveParentState(['queued', 'queued']), 'queued');
  assert.equal(deriveParentState(['delivered', 'running']), 'running');
  assert.equal(deriveParentState(['failed', 'awaiting_answer']), 'running');
  assert.equal(deriveParentState(['delivered', 'delivered']), 'delivered');
  // A shipped PR is never discarded by a sibling's failure.
  assert.equal(deriveParentState(['delivered', 'failed']), 'partial');
  assert.equal(deriveParentState(['partial', 'cancelled']), 'partial');
  assert.equal(deriveParentState(['failed', 'cancelled']), 'failed');
  assert.equal(deriveParentState(['cancelled', 'cancelled']), 'cancelled');
});
