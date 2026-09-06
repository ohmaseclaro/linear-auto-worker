/**
 * The receiver matrix. Two rows carry more weight than the rest and neither is obvious:
 *
 *  - **absent-timestamp.** A stale-timestamp test only ever exercises a PRESENT timestamp,
 *    so it structurally cannot see the skip T20 describes. The guard NAME is asserted, not
 *    just the status.
 *  - **acknowledgement timing.** The router fake sleeps 1200 ms. A fake that returns
 *    immediately cannot fail this assertion, which is precisely how the bug reaches
 *    production (Pitfall 3).
 *
 * Guard names are asserted throughout, off a recording logger. A test that asserts only
 * the status code cannot tell "someone is replaying deliveries" from "our persisted secret
 * is stale" — opposite incidents, opposite fixes. That is why D-09 exists.
 */
// T41: co-located under src/ — `tsc && node --test dist` never sees a top-level test/ dir.
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import { LINEAR_WEBHOOK_SIGNATURE_HEADER } from '@linear/sdk/webhooks';

import type { Logger, Store } from '../domain/ports.js';
import type { WebhookPayload } from './router.js';
import {
  type Fixture,
  TEST_SECRET,
  UNICODE_TITLE,
  issuePayload,
  latin1Reinterpretation,
  signed,
} from './fixtures.js';
import { createReceiver } from './receiver.js';

const BOT = 'bot-user-id';

interface Harness {
  listener: http.RequestListener;
  logs: Array<Record<string, unknown>>;
  enqueued: Array<{ payload: WebhookPayload; deliveryId?: string }>;
  inserted: string[];
}

function harness(enqueue?: (p: WebhookPayload, d?: string) => Promise<void>): Harness {
  const logs: Array<Record<string, unknown>> = [];
  const push = (o: unknown): void => {
    logs.push(o as Record<string, unknown>);
  };
  const log: Logger = {
    child: () => log,
    info: push,
    warn: push,
    error: push,
    debug: push,
  } as unknown as Logger;

  const inserted: string[] = [];
  const store = {
    recordDelivery(deliveryId: string): boolean {
      if (inserted.includes(deliveryId)) return false;
      inserted.push(deliveryId);
      return true;
    },
  } as unknown as Store;

  const enqueued: Array<{ payload: WebhookPayload; deliveryId?: string }> = [];
  const listener = createReceiver({
    secret: TEST_SECRET,
    store,
    log,
    botUserId: BOT,
    router: {
      async enqueue(payload, deliveryId) {
        enqueued.push({ payload, deliveryId });
        if (enqueue) await enqueue(payload, deliveryId);
      },
    },
  });

  return { listener, logs, enqueued, inserted };
}

async function withServer(h: Harness, fn: (url: string) => Promise<void>): Promise<void> {
  const server = http.createServer(h.listener);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}/`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

interface PostOverrides {
  /** `null` omits the header entirely. */
  signature?: string | null;
  deliveryId?: string | null;
  /** Bytes actually sent, when they must differ from the signed bytes. */
  body?: Buffer;
}

function post(url: string, fx: Fixture, o: PostOverrides = {}): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const sig = o.signature === undefined ? fx.signature : o.signature;
  if (sig !== null) headers[LINEAR_WEBHOOK_SIGNATURE_HEADER] = sig;
  const did = o.deliveryId === undefined ? fx.deliveryId : o.deliveryId;
  if (did !== null) headers['linear-delivery'] = did;
  return fetch(url, { method: 'POST', headers, body: o.body ?? fx.raw });
}

/** The guard name off the last log line that carried one — D-09's whole point. */
const lastGuard = (h: Harness): unknown =>
  [...h.logs].reverse().find((l) => l.guard !== undefined)?.guard;

/** Give the deferred `setImmediate` hand-off a turn to run. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

test('non-POST is answered 405 without reading a body', async () => {
  const h = harness();
  await withServer(h, async (url) => {
    const res = await fetch(url, { method: 'GET' });
    assert.equal(res.status, 405);
    assert.equal(h.enqueued.length, 0);
  });
});

test('valid delivery: 200, and the router receives the payload exactly once', async () => {
  const h = harness();
  await withServer(h, async (url) => {
    const fx = signed(issuePayload());
    const res = await post(url, fx);
    assert.equal(res.status, 200);
    await settle();
    assert.equal(h.enqueued.length, 1);
    assert.equal(h.enqueued[0]?.deliveryId, fx.deliveryId);
  });
});

test('tampered body: 400, guard signature, nothing inserted into deliveries', async () => {
  const h = harness();
  await withServer(h, async (url) => {
    const fx = signed(issuePayload());
    // Signed over `fx.raw`, sent with an extra byte. D-10 / T6: 400, never 401.
    const res = await post(url, fx, { body: Buffer.concat([fx.raw, Buffer.from(' ')]) });
    assert.equal(res.status, 400);
    assert.equal(lastGuard(h), 'signature');
    assert.deepEqual(h.inserted, []);
    assert.equal(h.enqueued.length, 0);
  });
});

test('signature header absent: 400, guard signature', async () => {
  const h = harness();
  await withServer(h, async (url) => {
    const res = await post(url, signed(issuePayload()), { signature: null });
    assert.equal(res.status, 400);
    assert.equal(lastGuard(h), 'signature');
  });
});

test('timestamp 90s in the past: 400, guard timestamp:stale', async () => {
  const h = harness();
  await withServer(h, async (url) => {
    const res = await post(url, signed(issuePayload({ webhookTimestamp: Date.now() - 90_000 })));
    assert.equal(res.status, 400);
    assert.equal(lastGuard(h), 'timestamp:stale');
  });
});

test('timestamp 90s in the future: 400, same guard — the window is symmetric', async () => {
  const h = harness();
  await withServer(h, async (url) => {
    const res = await post(url, signed(issuePayload({ webhookTimestamp: Date.now() + 90_000 })));
    assert.equal(res.status, 400);
    assert.equal(lastGuard(h), 'timestamp:stale');
  });
});

test('webhookTimestamp absent from the signed body: 400, guard timestamp:absent', async () => {
  // The row that matters most. The SDK's window is wrapped in `if (timestamp)`, so without
  // this assertion an absent field silently skips replay protection and answers 200 (T20).
  const h = harness();
  await withServer(h, async (url) => {
    const p = issuePayload();
    delete p.webhookTimestamp;
    const res = await post(url, signed(p));
    assert.equal(res.status, 400);
    assert.equal(lastGuard(h), 'timestamp:absent');
    assert.equal(h.enqueued.length, 0);
  });
});

test('webhookTimestamp of 0: 400, guard timestamp:absent — zero is falsy', async () => {
  const h = harness();
  await withServer(h, async (url) => {
    const res = await post(url, signed(issuePayload({ webhookTimestamp: 0 })));
    assert.equal(res.status, 400);
    assert.equal(lastGuard(h), 'timestamp:absent');
  });
});

test('non-ASCII body signed over the exact bytes: 200', async () => {
  const h = harness();
  await withServer(h, async (url) => {
    const fx = signed(issuePayload({ data: { id: 'issue-uuid', title: UNICODE_TITLE } }));
    const res = await post(url, fx);
    assert.equal(res.status, 200);
    await settle();
    assert.equal(h.enqueued.length, 1);
  });
});

test('the same non-ASCII body signed over a latin1 reinterpretation: 400, guard signature', async () => {
  // Pitfall 5's negative half. The positive row above passes even for a broken receiver
  // that re-serialises, because V8 happens to round-trip these bytes identically; only
  // hashing a genuinely different encoding of the same payload proves the HMAC input.
  const h = harness();
  await withServer(h, async (url) => {
    const fx = signed(issuePayload({ data: { id: 'issue-uuid', title: UNICODE_TITLE } }), {
      signBytes: latin1Reinterpretation,
    });
    const res = await post(url, fx);
    assert.equal(res.status, 400);
    assert.equal(lastGuard(h), 'signature');
  });
});

test('replayed delivery id: 200, no router call, guard delivery-id:replay', async () => {
  const h = harness();
  await withServer(h, async (url) => {
    const fx = signed(issuePayload());
    assert.equal((await post(url, fx)).status, 200);
    await settle();
    // Same id, freshly signed body — only the delivery id is the reason for the drop.
    const again = signed(issuePayload(), { deliveryId: fx.deliveryId });
    const res = await post(url, again);
    // 200, not an error: a rejection would burn Linear's retry budget on our own filtering.
    assert.equal(res.status, 200);
    assert.equal(lastGuard(h), 'delivery-id:replay');
    await settle();
    assert.equal(h.enqueued.length, 1);
  });
});

test('delivery header absent: the surrogate id carries traffic, exactly once', async () => {
  const h = harness();
  await withServer(h, async (url) => {
    const fx = signed(issuePayload());
    assert.equal((await post(url, fx, { deliveryId: null })).status, 200);
    await settle();
    assert.equal(h.enqueued.length, 1);
    assert.match(String(h.enqueued[0]?.deliveryId), /^sha256:[0-9a-f]{64}$/);
    // Identical bytes resent — Linear's retries do exactly this — must dedupe.
    assert.equal((await post(url, fx, { deliveryId: null })).status, 200);
    await settle();
    assert.equal(h.enqueued.length, 1);
  });
});

test('a loop-prevention guard firing: 200, no router call, guard named in the log', async () => {
  const h = harness();
  await withServer(h, async (url) => {
    const res = await post(url, signed(issuePayload({ actor: null })));
    assert.equal(res.status, 200);
    assert.equal(lastGuard(h), 'actor:null-untrusted');
    await settle();
    assert.equal(h.enqueued.length, 0);
  });
});

test('a 1200 ms hand-off does not delay the acknowledgement', async () => {
  // Pitfall 3: a router fake that returns immediately structurally cannot fail this.
  let release: () => void = () => {};
  const finished = new Promise<void>((r) => {
    release = r;
  });
  const h = harness(
    () =>
      new Promise<void>((r) =>
        setTimeout(() => {
          r();
          release();
        }, 1200),
      ),
  );
  await withServer(h, async (url) => {
    const started = Date.now();
    const res = await post(url, signed(issuePayload()));
    const ackMs = Date.now() - started;
    assert.equal(res.status, 200);
    assert.ok(ackMs < 200, `ACK took ${ackMs}ms — HOOK-08 requires the 200 before the work`);
    await finished;
  });
});
