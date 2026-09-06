/**
 * The run state machine. Pure: no I/O, no clock, no randomness, and it imports nothing
 * outside `src/domain/`. Every layer that changes a run's state goes through here.
 */

import type { RunState } from './types.js';
import { HAS_CHILD, HOLDS_SLOT, TERMINAL } from './types.js';
import { IllegalTransitionError } from './errors.js';

/**
 * `delivered_partial` is the only addition to the eleven triggers in
 * research/ARCHITECTURE.md: the `partial` state did not exist in that document and needs
 * a way in.
 */
export type Trigger =
  | 'claim'
  | 'worktree_ready'
  | 'spawned'
  | 'needs_input'
  | 'answered'
  | 'timed_out'
  | 'agent_complete'
  | 'delivered'
  | 'delivered_partial'
  | 'cancel'
  | 'error'
  | 'requeue';

type TransitionTable = Readonly<Record<RunState, Readonly<Partial<Record<Trigger, RunState>>>>>;

const TRANSITIONS: TransitionTable = {
  queued: {
    claim: 'preparing',
    cancel: 'cancelled',
    error: 'failed',
  },
  preparing: {
    // A self-transition on purpose. The older contract had two states here
    // (claimed / worktree_ready) and collapsing them into one must not lose the event:
    // this is still a real milestone worth a run_events row even though the state is
    // unchanged.
    worktree_ready: 'preparing',
    spawned: 'running',
    error: 'failed',
    requeue: 'queued',
    cancel: 'cancelled',
  },
  running: {
    needs_input: 'awaiting_answer',
    agent_complete: 'delivering',
    error: 'failed',
    // Restart recovery only. No handle can survive a process restart, so every row found
    // in this state at boot is a crash artefact and never a live child.
    requeue: 'queued',
    cancel: 'cancelled',
  },
  awaiting_answer: {
    answered: 'running',
    // The deadline elapsed: resume the agent with the assumption it stated when it asked.
    timed_out: 'running',
    cancel: 'cancelled',
    error: 'failed',
  },
  delivering: {
    delivered: 'delivered',
    delivered_partial: 'partial',
    error: 'failed',
    cancel: 'cancelled',
  },
  // The one documented exception to "terminal states never transition".
  failed: {
    requeue: 'queued',
  },
  delivered: {},
  partial: {},
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

/** Does a run in this state occupy one of the daemon's concurrency slots? */
export function holdsSlot(s: RunState): boolean {
  return HOLDS_SLOT.includes(s);
}

/** Does a run in this state have a live `claude` child process? */
export function hasLiveChild(s: RunState): boolean {
  return HAS_CHILD.includes(s);
}

export function isTerminal(s: RunState): boolean {
  return TERMINAL.includes(s);
}

/**
 * A cancel request (the bot being unassigned, INTK-08) is accepted from every
 * non-terminal state (D-05).
 */
export function acceptsCancel(s: RunState): boolean {
  return !isTerminal(s);
}

/**
 * True for the two states that own irreversible side effects. The caller must set the
 * run's cancel-requested flag now and let the supervisor honour it at its next checkpoint,
 * rather than transitioning now.
 *
 * The reason is that a pushed branch cannot be un-pushed, so transitioning instantly would
 * lie about what happened. The transition table still lists `cancel` as legal from both,
 * so the eventual transition is legal once the supervisor reaches that checkpoint.
 */
export function cancelIsDeferred(s: RunState): boolean {
  return s === 'running' || s === 'delivering';
}

/**
 * Is there any trigger that moves a run from `from` to `to`?
 *
 * State-to-state rather than state-plus-trigger, because the engine's `transition(runId,
 * to)` names a destination and lets the table decide whether the move is legal — there is
 * exactly one writer of `runs.state` and it should not also have to pick a trigger name.
 */
export function canTransition(from: RunState, to: RunState): boolean {
  return Object.values(TRANSITIONS[from]).includes(to);
}

/** What one state means to the scheduler and to restart recovery. */
export interface RunStateInfo {
  state: RunState;
  holdsSlot: boolean;
  hasLiveChild: boolean;
  terminal: boolean;
}

/**
 * Every state and its properties, as an enumerable object.
 *
 * Enumerable on purpose: the scheduler's slot-accounting test walks `Object.keys()` so
 * that a tenth state cannot escape it. And because the keys come from `TRANSITIONS`, which
 * `tsc` requires to have an entry per `RunState`, a tenth state cannot escape this table
 * either.
 */
export const RUN_STATE_TABLE: Readonly<Record<RunState, RunStateInfo>> = Object.fromEntries(
  (Object.keys(TRANSITIONS) as RunState[]).map((s) => [
    s,
    { state: s, holdsSlot: holdsSlot(s), hasLiveChild: hasLiveChild(s), terminal: isTerminal(s) },
  ]),
) as Record<RunState, RunStateInfo>;

/**
 * A ticket-level parent run stores no state of its own (D-04); its status is this pure
 * function of its children. Deriving rather than storing is what makes it impossible for
 * parent and child to disagree — the disagreement that would otherwise let one repo's
 * failure discard another repo's already-shipped pull request (DELV-07).
 */
export function deriveParentState(children: readonly RunState[]): RunState {
  if (children.length === 0) return 'queued';
  if (children.every((s) => s === 'queued')) return 'queued';
  if (children.some((s) => !isTerminal(s))) return 'running';
  if (children.every((s) => s === 'delivered')) return 'delivered';
  // A shipped PR is never discarded by a sibling's failure.
  if (children.some((s) => s === 'delivered' || s === 'partial')) return 'partial';
  if (children.some((s) => s === 'failed')) return 'failed';
  return 'cancelled';
}
