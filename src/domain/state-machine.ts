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

/**
 * Resolve a (state, trigger) pair to its target state, or null if that trigger is illegal
 * there.
 *
 * **Called only from `state-machine.test.ts`, and kept deliberately.** A dead-export sweep
 * will flag it; it is not dead in the sense that matters. `TRANSITIONS` is the live source
 * of truth — `canTransition`, which the run engine calls before every write, reads it — and
 * this is the accessor the test uses to pin every legal and illegal pair in that table.
 * Deleting it would delete the coverage of a table production depends on, to remove a
 * function that costs two lines.
 */
export function nextState(from: RunState, t: Trigger): RunState | null {
  return TRANSITIONS[from][t] ?? null;
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

/**
 * `assertTransition`, `acceptsCancel` and `cancelIsDeferred` were removed at the release
 * pass: nothing outside this module's own test had ever called them. The engine reads
 * `canTransition` and throws `IllegalTransitionError` itself, and the cancel path branches
 * on `RUN_STATE_TABLE[state].hasLiveChild` / `.terminal` directly. `runs.cancel_requested`
 * is vestigial for the same reason — the deferred cancel is recorded as a `kv` row
 * (`cancelKey(runId)`), not as a column.
 */
