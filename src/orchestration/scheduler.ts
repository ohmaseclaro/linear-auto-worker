/**
 * The concurrency semaphore, and nothing else (06-CONTEXT D-01).
 *
 * The scheduler never touches run state. It answers exactly one question --
 * "may another run start?" -- and hands back a release function.
 */
import { RUN_STATE_TABLE } from '../domain/state-machine.js';
import type { Run, RunId, RunState } from '../domain/types.js';
import type { Config, Logger, Scheduler as SchedulerPort } from '../domain/ports.js';

/** INTK-06: global cap on simultaneous spawned Claude sessions. */
export const DEFAULT_CONCURRENCY = 3;

/**
 * Does a run in this state occupy one of the slots?
 *
 * This is a lookup, not a judgement. Which states hold a slot is recorded once,
 * per state, in Phase 1's state table (01-CONTEXT D-02). Keeping a second list
 * here would be a second thing to keep in sync, and the sync failure is the
 * expensive one: a state that wrongly holds a slot while a human is thinking
 * turns three open questions into a dead daemon, and "it's hung" sends the
 * operator looking in entirely the wrong place (06-CONTEXT D-02, QA-03,
 * research invariant 1).
 *
 * `awaiting_answer` therefore gets no branch anywhere in this file. It holds no
 * slot because the table says it holds none. That is the whole implementation,
 * and it is deliberately the whole implementation.
 */
export function holdsSlot(state: RunState): boolean {
  return RUN_STATE_TABLE[state].holdsSlot;
}

export interface Scheduler extends SchedulerPort {
  /** 1-based place in the wait queue; 0 once admitted. Side-effect free. */
  positionOf(runId: RunId): number;
  /** Recompute the admitted set from the runs table (boot recovery, plan 04). */
  syncFromStore(runs: readonly Run[]): void;
}

interface Waiter {
  runId: RunId;
  resolve(release: () => void): void;
}

export interface SchedulerDeps {
  config: Config;
  log?: Logger;
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  // `Config.concurrency`, top level — never `defaults.concurrency`. The cap bounds local
  // RAM across every run on this machine, so a per-mapping override must not exist
  // (types.ts: "Never per-mapping").
  const cap = deps.config.concurrency ?? DEFAULT_CONCURRENCY;

  /**
   * Admitted run ids, not a counter. `inUse()` is a recount of this set, so a
   * double release cannot over-credit and a resync cannot drift (T-06-02).
   * Counts runs, not tickets: when plan 05 fans a ticket into N children each
   * child is a first-class run with its own id and its own slot (D-03), which
   * falls out of this for free.
   */
  const admitted = new Set<RunId>();
  const waiting: Waiter[] = [];
  let admitting = true;

  function makeRelease(runId: RunId): () => void {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      admitted.delete(runId);
      pump();
    };
  }

  function pump(): void {
    while (admitting && admitted.size < cap && waiting.length > 0) {
      const next = waiting.shift()!;
      admitted.add(next.runId);
      next.resolve(makeRelease(next.runId));
    }
  }

  return {
    capacity: () => cap,
    inUse: () => admitted.size,

    acquire(runId: RunId): Promise<() => void> {
      if (admitting && admitted.size < cap) {
        admitted.add(runId);
        return Promise.resolve(makeRelease(runId));
      }
      // FIFO: parked in arrival order, handed the slot in arrival order.
      return new Promise<() => void>((resolve) => {
        waiting.push({ runId, resolve });
      });
    },

    positionOf(runId: RunId): number {
      const i = waiting.findIndex((w) => w.runId === runId);
      return i < 0 ? 0 : i + 1;
    },

    syncFromStore(runs: readonly Run[]): void {
      admitted.clear();
      // A ticket-kind parent has no state and is not runnable: it holds no slot by
      // construction, so it is skipped rather than given a state to look up (D-04).
      for (const run of runs) if (run.kind === 'repo' && holdsSlot(run.state)) admitted.add(run.id);
      deps.log?.info({ inUse: admitted.size, capacity: cap }, 'scheduler resynced');
      pump();
    },

    /** Phase 7 calls this first on shutdown. Parked waiters stay parked. */
    pause(): void {
      admitting = false;
    },

    start(): void {
      admitting = true;
      pump();
    },
  };
}
