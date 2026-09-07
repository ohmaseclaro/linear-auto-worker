import test from 'node:test';
import assert from 'node:assert/strict';

import type { RunState } from './types.js';
import { HAS_CHILD, HOLDS_SLOT, TERMINAL } from './types.js';
import type { Trigger } from './state-machine.js';
import {
  deriveParentState,
  hasLiveChild,
  holdsSlot,
  isTerminal,
  nextState,
  RUN_STATE_TABLE,
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
  }
});

test('illegal transitions resolve to null', () => {
  // `assertTransition` used to be asserted here too. It was deleted at the release pass —
  // nothing outside this file ever called it, and the engine throws
  // `IllegalTransitionError` from its own `canTransition` check.
  for (const [from, trigger] of ILLEGAL) {
    assert.equal(nextState(from, trigger), null, `${from} --${trigger}--> should not resolve`);
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

// The two cases below asserted `acceptsCancel` / `cancelIsDeferred`, helpers that nothing
// outside this file called. They are gone; the RULES they encoded are not, so the same
// assertions now read the table the live cancel path actually branches on
// (`run-engine.ts` checks `RUN_STATE_TABLE[state].terminal` and `.hasLiveChild`).

test('cancel is accepted from every non-terminal state (D-05)', () => {
  assert.deepEqual(
    ALL_STATES.filter((s) => !RUN_STATE_TABLE[s].terminal),
    ['queued', 'preparing', 'running', 'awaiting_answer', 'delivering'],
  );
});

test('cancel is deferred for exactly the state with an irreversible side effect', () => {
  // `hasLiveChild` is what defers it: the run engine sets the cancel marker and aborts,
  // honouring it at the next supervisor checkpoint, rather than transitioning immediately.
  assert.deepEqual(
    ALL_STATES.filter((s) => RUN_STATE_TABLE[s].hasLiveChild),
    ['running'],
  );
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

test('the state TABLE and the exported arrays cannot disagree', () => {
  // Two sources of truth for the same three facts. `domain/state-machine.ts` exposed
  // `holdsSlot` reading `HOLDS_SLOT.includes(s)` while `orchestration/scheduler.ts` defined
  // its OWN `holdsSlot` reading `RUN_STATE_TABLE[state].holdsSlot` — two functions, agreeing
  // only by luck. The duplicate is gone; this is what keeps the remaining pair honest.
  //
  // A divergence here is not cosmetic: the scheduler admits work by one and the daemon
  // decides what is "in flight" at shutdown by the other, so a disagreement is a run that
  // holds a slot nobody accounts for, or is requeued while its child is still alive.
  for (const s of ALL_STATES) {
    assert.equal(RUN_STATE_TABLE[s].holdsSlot, HOLDS_SLOT.includes(s), `holdsSlot(${s})`);
    assert.equal(RUN_STATE_TABLE[s].hasLiveChild, HAS_CHILD.includes(s), `hasLiveChild(${s})`);
    assert.equal(RUN_STATE_TABLE[s].terminal, TERMINAL.includes(s), `terminal(${s})`);
  }
});
