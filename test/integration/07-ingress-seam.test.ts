/**
 * The ingress seam, as gate cases rather than as a script.
 *
 * `scripts/boot-smoke.ts` proves the happy path outside the gate; this file proves the same
 * seam plus its six rejections inside `node --test`, so a regression fails `npm run verify`
 * rather than only failing a script somebody remembered to run.
 *
 * Two rules govern every case here:
 *
 *  1. **Assert on DATABASE STATE, never on a return value.** The property being proved is
 *     that ingress REACHES persistence. A handler that returns the right status while
 *     writing nothing passes a return-value assertion and is exactly the T45 failure —
 *     boots green, verifies green, processes nothing.
 *  2. **Boot the real graph on a fresh throwaway directory per case.** The store is real
 *     SQLite against the real migration. `InMemoryStore` is what let three statements
 *     against non-existent columns survive a green typecheck and a green unit suite
 *     (07-RUNTIME-EVIDENCE, T53).
 *
 * Written by plan 07-03; first executed by plan 07-06, which owns the gate.
 */
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';

import { bootDaemon, type DaemonHandle } from '../../src/cli/daemon.js';
import {
  BOT_USER_ID,
  ISSUE_ID,
  makeWorkspace,
  postDelivery,
  probingTunnel,
  RecordingLinear,
  smokeIssue,
  until,
} from '../../src/cli/daemon-fixture.js';
import { issuePayload, signed, UNICODE_TITLE } from '../../src/ingress/fixtures.js';
import { selfEventDropCounts } from '../../src/ingress/guards.js';
import type { Run, RunState } from '../../src/domain/ports.js';

const SECRET = 'integration-webhook-secret-0123456789abcdef';

const ALL_STATES: RunState[] = [
  'queued',
  'preparing',
  'running',
  'awaiting_answer',
  'delivering',
  'delivered',
  'partial',
  'failed',
  'cancelled',
];

interface Ctx {
  daemon: DaemonHandle;
  linear: RecordingLinear;
  /** Every run row in any state — the "nothing was written" assertion reads this. */
  allRuns(): Run[];
}

/** Boot the real graph on its own throwaway config root, and always tear it down. */
async function withDaemon(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const workspace = await makeWorkspace(SECRET);
  // UNASSIGNED at boot. `smokeIssue()` defaults to the bot, and boot's missed-work sweep
  // (daemon step 7) lists exactly the bot-assigned open issues and enqueues them — so a
  // fixture seeded already-assigned hands every case here a run it did not ask for, and
  // "no run was written" cannot be told from "the sweep wrote one".
  const linear = new RecordingLinear({ issues: [smokeIssue({ assigneeId: null })] });
  const daemon = await bootDaemon({
    configDir: workspace.dir,
    linear,
    tunnel: probingTunnel(),
  });
  // Boot starts the scheduler (07-05). This file is about ingress REACHING persistence, and
  // every assertion below reads `queued` or counts rows; leaving the driver running means
  // racing it out of `queued` into a `preparing` that has no repository to work in. Plan
  // 07-05's `07-lifecycle` and 07-04's `07-run-path` own what happens after `queued`.
  daemon.scheduler.pause();
  // NOW the human assigns. Every canonical fetch from here on sees the bot as assignee,
  // which is what the router requires and what the sweep already declined to act on.
  linear.putIssue(smokeIssue());
  try {
    await fn({ daemon, linear, allRuns: () => daemon.store.listByState(...ALL_STATES) });
  } finally {
    await daemon.shutdown();
    await workspace.remove();
  }
}

/**
 * Ingress acknowledges BEFORE it works (HOOK-08), so "no run appeared" needs a window in
 * which one could have. 250ms is two orders of magnitude more than the observed
 * delivery-to-insert latency and still fast enough to run seven of them.
 */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 250));

/** A bot-assignment delivery: the edge is the assigneeId KEY in `updatedFrom`. */
function assignment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return issuePayload({
    actor: { id: 'human-user-id', type: 'user' },
    data: { id: ISSUE_ID, assigneeId: BOT_USER_ID },
    updatedFrom: { assigneeId: null },
    webhookTimestamp: Date.now(),
    ...overrides,
  });
}

const queuedRuns = (ctx: Ctx): Run[] => ctx.daemon.store.listByState('queued');

test('a valid signed delivery is accepted and produces exactly one queued run', async () => {
  await withDaemon(async (ctx) => {
    const fixture = signed(assignment(), { secret: SECRET, deliveryId: randomUUID() });
    const res = await postDelivery(ctx.daemon.port, fixture);
    assert.equal(res.status, 200);

    const runs = await until(
      () => {
        const found = queuedRuns(ctx);
        return found.length > 0 ? found : undefined;
      },
      { label: 'one queued run' },
    );
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.issueId, ISSUE_ID);

    // The seam reaches persistence, not just the handler: the genesis transition row is
    // written in the same transaction as the insert (D-03).
    const events = ctx.daemon.store.listRunEvents(runs[0]!.id);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.from, null);
    assert.equal(events[0]?.to, 'queued');

    // INTK-05: the decision came from a canonical fetch, never from the delivery body.
    assert.ok(ctx.linear.fetched.includes(ISSUE_ID));
  });
});

test('a delivery whose body was altered after signing is rejected 400 and writes nothing', async () => {
  await withDaemon(async (ctx) => {
    const fixture = signed(assignment(), { secret: SECRET, deliveryId: randomUUID() });
    // The signature stays valid for the ORIGINAL bytes; the bytes on the wire do not match.
    const tampered = Buffer.from(
      fixture.raw.toString('utf8').replace(ISSUE_ID, 'tampered-issue-id'),
      'utf8',
    );

    const res = await postDelivery(ctx.daemon.port, { ...fixture, raw: tampered });
    // T6: 400, NOT 401. Linear's own verifier answers 400, and a 401 assertion here would
    // never fire — it would pass on a receiver that rejected nothing at all.
    assert.equal(res.status, 400);

    await settle();
    assert.deepEqual(ctx.allRuns(), []);
  });
});

test('a delivery whose timestamp is outside the accepted skew is rejected and produces no run', async () => {
  await withDaemon(async (ctx) => {
    const fixture = signed(assignment({ webhookTimestamp: Date.now() - 10 * 60_000 }), {
      secret: SECRET,
      deliveryId: randomUUID(),
    });

    const res = await postDelivery(ctx.daemon.port, fixture);
    assert.equal(res.status, 400);

    await settle();
    assert.deepEqual(ctx.allRuns(), []);
  });
});

test('a body containing multibyte characters signs and verifies correctly', async () => {
  await withDaemon(async (ctx) => {
    // 03-CONTEXT D-10 names this case because the ASCII-only test passes while every real
    // ticket carrying emoji fails: any parse-then-restringify on the way to the hash
    // changes the bytes. `signed()` hashes the exact Buffer it hands back, so a receiver
    // that reconstructs the body fails here and only here.
    const fixture = signed(
      assignment({ data: { id: ISSUE_ID, assigneeId: BOT_USER_ID, title: UNICODE_TITLE } }),
      { secret: SECRET, deliveryId: randomUUID() },
    );
    // More UTF-8 bytes than UTF-16 code units: the body really is multibyte.
    assert.ok(fixture.raw.length > fixture.raw.toString('utf8').length);

    const res = await postDelivery(ctx.daemon.port, fixture);
    assert.equal(res.status, 200);

    const runs = await until(
      () => {
        const found = queuedRuns(ctx);
        return found.length > 0 ? found : undefined;
      },
      { label: 'a queued run from a multibyte delivery' },
    );
    assert.equal(runs.length, 1);
  });
});

test('the same delivery id posted twice produces one run, not two', async () => {
  await withDaemon(async (ctx) => {
    const fixture = signed(assignment(), { secret: SECRET, deliveryId: randomUUID() });

    const first = await postDelivery(ctx.daemon.port, fixture);
    assert.equal(first.status, 200);
    await until(
      () => (queuedRuns(ctx).length > 0 ? true : undefined),
      { label: 'the first delivery to land' },
    );

    // A replay is answered 200, not an error: rejecting it would burn Linear's retry
    // budget on our own filtering. What must not happen is a second run.
    const second = await postDelivery(ctx.daemon.port, fixture);
    assert.equal(second.status, 200);

    await settle();
    assert.equal(ctx.allRuns().length, 1);
  });
});

test('a delivery whose actor is the bot produces no run and increments the named guard', async () => {
  await withDaemon(async (ctx) => {
    const before = selfEventDropCounts['actor:self'] ?? 0;
    const fixture = signed(assignment({ actor: { id: BOT_USER_ID, type: 'user' } }), {
      secret: SECRET,
      deliveryId: randomUUID(),
    });

    const res = await postDelivery(ctx.daemon.port, fixture);
    assert.equal(res.status, 200);

    await settle();
    assert.deepEqual(ctx.allRuns(), []);
    // D-09: which guard fired is the whole point. A drop counter that never moves is
    // indistinguishable from a filter that was never wired.
    assert.equal(selfEventDropCounts['actor:self'], before + 1);
  });
});

test('a delivery with a null actor produces no run', async () => {
  await withDaemon(async (ctx) => {
    const before = selfEventDropCounts['actor:null-untrusted'] ?? 0;
    const fixture = signed(assignment({ actor: null }), {
      secret: SECRET,
      deliveryId: randomUUID(),
    });

    const res = await postDelivery(ctx.daemon.port, fixture);
    assert.equal(res.status, 200);

    await settle();
    // D-08: a missing actor is UNTRUSTED, not not-the-bot. Safe only because D-04's
    // reconciliation poll re-discovers anything real lost this way.
    assert.deepEqual(ctx.allRuns(), []);
    assert.equal(selfEventDropCounts['actor:null-untrusted'], before + 1);
  });
});
