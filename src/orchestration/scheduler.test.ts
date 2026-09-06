/**
 * The semaphore's own tests. The first one is the reason this phase exists:
 * three runs blocked on a human must leave all three slots free. If it fails,
 * three open questions look exactly like a dead daemon and the operator's
 * natural diagnosis ("it's hung") sends them somewhere else entirely
 * (QA-03, 06-CONTEXT D-02, research invariant 1).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { RUN_STATE_TABLE } from '../domain/state-machine.js';
import type { Run, RunState } from '../domain/types.js';
import type { Config, Logger } from '../domain/ports.js';
import { createScheduler, DEFAULT_CONCURRENCY, holdsSlot } from './scheduler.js';

const silent: Logger = {
  child: () => silent,
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

// `concurrency` is TOP LEVEL on Config, never under `defaults` — it is a global cap on
// local RAM, so types.ts rules out a per-mapping override explicitly. Nesting it here made
// every capacity assertion silently read the default instead of the fixture's value.
const configWith = (concurrency?: number) =>
  ({ concurrency, mappings: {} }) as unknown as Config;

// `kind` is load-bearing, not decoration: `syncFromStore` skips anything that is not a
// `repo` run, because a ticket-kind parent has no state and holds no slot by construction
// (D-04). A fixture without it is skipped by every one of these assertions, which is what
// made all seven of them fail on the milestone's first gate run.
const runAt = (id: string, state: RunState): Run =>
  ({ kind: 'repo', id, state }) as unknown as Run;

/** Lets every already-resolved acquisition settle before we assert. */
const tick = () => new Promise((r) => setImmediate(r));

const ALL_STATES = Object.keys(RUN_STATE_TABLE) as RunState[];

test('three runs in awaiting_answer leave all three slots free', async () => {
  const scheduler = createScheduler({ config: configWith(3), log: silent });

  scheduler.syncFromStore([
    runAt('r1', 'awaiting_answer'),
    runAt('r2', 'awaiting_answer'),
    runAt('r3', 'awaiting_answer'),
  ]);

  assert.equal(scheduler.inUse(), 0, 'a blocked run holds no slot');

  // A fourth run must be admitted immediately, not queued behind the three.
  let admitted = false;
  void scheduler.acquire('r4').then(() => {
    admitted = true;
  });
  await tick();

  assert.equal(admitted, true, 'a fresh run is admitted while three questions are open');
  assert.equal(scheduler.positionOf('r4'), 0, 'and it never entered the wait queue');
});

test('slot accounting is the domain state table, not a list kept in the scheduler', () => {
  // Driven from the table itself, so a state added in Phase 1 cannot silently
  // escape this assertion.
  for (const state of ALL_STATES) {
    const scheduler = createScheduler({ config: configWith(9), log: silent });
    scheduler.syncFromStore([runAt('r1', state)]);
    assert.equal(
      scheduler.inUse(),
      RUN_STATE_TABLE[state].holdsSlot ? 1 : 0,
      `${state} should count ${RUN_STATE_TABLE[state].holdsSlot ? 'one slot' : 'no slot'}`,
    );
    if (RUN_STATE_TABLE[state].terminal) {
      assert.equal(scheduler.inUse(), 0, `terminal state ${state} must hold no slot`);
    }
    assert.equal(holdsSlot(state), RUN_STATE_TABLE[state].holdsSlot);
  }
});

test('the cap defaults to 3 and is configurable', () => {
  assert.equal(DEFAULT_CONCURRENCY, 3);
  assert.equal(createScheduler({ config: configWith(), log: silent }).capacity(), 3);
  assert.equal(createScheduler({ config: configWith(7), log: silent }).capacity(), 7);
});

test('acquisition beyond the cap parks, and releases hand the slot over in FIFO order', async () => {
  const scheduler = createScheduler({ config: configWith(2), log: silent });

  const releaseA = await scheduler.acquire('a');
  await scheduler.acquire('b');
  assert.equal(scheduler.inUse(), 2);

  const order: string[] = [];
  void scheduler.acquire('c').then(() => order.push('c'));
  void scheduler.acquire('d').then(() => order.push('d'));
  await tick();

  assert.deepEqual(order, [], 'neither resolves while the cap is full');
  assert.equal(scheduler.positionOf('c'), 1, 'positions are 1-based');
  assert.equal(scheduler.positionOf('d'), 2);

  releaseA();
  await tick();

  assert.deepEqual(order, ['c'], 'the longest-waiting run gets the slot');
  assert.equal(scheduler.positionOf('d'), 1, "the head's position decreases as earlier runs are admitted");
  assert.equal(scheduler.inUse(), 2);
});

test('calling a release function twice credits the semaphore once', async () => {
  const scheduler = createScheduler({ config: configWith(1), log: silent });

  const release = await scheduler.acquire('a');
  assert.equal(scheduler.inUse(), 1);

  release();
  release();
  await tick();

  // Over-crediting would show up here as a second admission on a cap of one.
  assert.equal(scheduler.inUse(), 0);
  await scheduler.acquire('b');
  let extra = false;
  void scheduler.acquire('c').then(() => {
    extra = true;
  });
  await tick();
  assert.equal(extra, false, 'the cap still holds after a double release');
});

test('positionOf is side-effect free', async () => {
  const scheduler = createScheduler({ config: configWith(1), log: silent });
  await scheduler.acquire('a');
  void scheduler.acquire('b');
  await tick();

  assert.equal(scheduler.positionOf('b'), 1);
  assert.equal(scheduler.positionOf('b'), 1, 'a second query returns the same answer');
  assert.equal(scheduler.positionOf('nobody'), 0);
  assert.equal(scheduler.inUse(), 1, 'querying admitted nothing');
});

test('pause stops admitting without rejecting parked waiters; start resumes in order', async () => {
  const scheduler = createScheduler({ config: configWith(1), log: silent });

  const release = await scheduler.acquire('a');
  const order: string[] = [];
  void scheduler.acquire('b').then(() => order.push('b'));
  void scheduler.acquire('c').then(() => order.push('c'));

  scheduler.pause();
  release();
  await tick();

  assert.deepEqual(order, [], 'a freed slot is not handed out while paused');
  assert.equal(scheduler.positionOf('b'), 1, 'parked waiters stay parked, not rejected');

  scheduler.start();
  await tick();
  assert.deepEqual(order, ['b'], 'the queue resumes in arrival order');
});

test('N runs derived from one ticket occupy N slots, not one', async () => {
  // D-03: each repo of a multi-repo ticket is a first-class run with its own
  // Claude process, so each must count against the cap that bounds local RAM.
  const scheduler = createScheduler({ config: configWith(3), log: silent });

  scheduler.syncFromStore([
    runAt('ticket-1/api', 'running'),
    runAt('ticket-1/web', 'running'),
  ]);

  assert.equal(scheduler.inUse(), 2, 'two children of one ticket hold two slots');
});
