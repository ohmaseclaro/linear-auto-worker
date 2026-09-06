/**
 * The run state machine. Pure: no I/O, no clock, no randomness, and it imports nothing
 * outside `src/domain/`. Every layer that changes a run's state goes through here.
 */

import type { RunState } from './types.js';
import { IllegalTransitionError } from './errors.js';

export type Trigger =
  | 'claim'
  | 'worktree_ready'
  | 'spawned'
  | 'needs_input'
  | 'answered'
  | 'timed_out'
  | 'agent_complete'
  | 'delivered'
  | 'cancel'
  | 'error'
  | 'requeue';

type TransitionTable = Readonly<Record<RunState, Readonly<Partial<Record<Trigger, RunState>>>>>;

const TRANSITIONS: TransitionTable = {
  queued: { claim: 'preparing' },
  preparing: {},
  running: {},
  awaiting_answer: {},
  delivering: {},
  delivered: {},
  partial: {},
  failed: {},
  cancelled: {},
};

/** The target state, or null when the trigger is illegal from `from`. */
export function nextState(from: RunState, t: Trigger): RunState | null {
  return TRANSITIONS[from][t] ?? null;
}

/** Same, but throws instead of returning null. Use at every call site. */
export function assertTransition(from: RunState, t: Trigger): RunState {
  const to = nextState(from, t);
  if (to === null) throw new IllegalTransitionError(from, t);
  return to;
}
