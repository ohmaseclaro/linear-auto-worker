import test from 'node:test';
import assert from 'node:assert/strict';

import { assertTransition, nextState } from './state-machine.js';
import { IllegalTransitionError } from './errors.js';

test('a queued run claimed by the scheduler becomes preparing', () => {
  assert.equal(nextState('queued', 'claim'), 'preparing');
  assert.equal(assertTransition('queued', 'claim'), 'preparing');
});

test('an unrelated trigger from queued is rejected', () => {
  assert.equal(nextState('queued', 'spawned'), null);
  assert.throws(() => assertTransition('queued', 'spawned'), IllegalTransitionError);
});
