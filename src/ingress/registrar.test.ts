/**
 * Reconciler tests.
 *
 * The load-bearing one is the pagination count: T22's fetchNext() mutates and
 * returns `this`, so a loop that collects page.nodes per iteration sees every
 * earlier page twice. The fake below reproduces that mutate-and-return-this
 * semantic exactly -- a fake handing back a fresh page per call cannot fail the
 * six-not-nine assertion, which would make this whole file vacuous.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { LinearClient, Webhook } from '@linear/sdk';
import type { Logger, Store } from '../domain/ports.js';
import { reconcile, WEBHOOK_LABEL } from './registrar.js';

const TUNNEL = 'https://abc123.ngrok-free.app';
const DESIRED = `${TUNNEL}/linear/webhook`;

/** Fake webhooks always carry a secret, so T23 has something to leak if we slip. */
const hook = (
  id: string,
  url: string,
  label: string | null = WEBHOOK_LABEL,
  enabled = true,
): Webhook =>
  ({ id, url, label, enabled, secret: `sekrit-${id}` }) as unknown as Webhook;

const secretsOf = (pages: Webhook[][]): string[] =>
  pages.flat().map((w) => (w as unknown as { secret: string }).secret);

/**
 * T22 reproduction: one nodes array for the life of the connection, fetchNext()
 * appends the next page into it and returns the same object.
 */
function connectionOf(pages: Webhook[][]) {
  let cursor = 0;
  const conn = {
    nodes: [...(pages[0] ?? [])] as Webhook[],
    pageInfo: {
      get hasNextPage(): boolean {
        return cursor < pages.length - 1;
      },
    },
    async fetchNext() {
      cursor += 1;
      for (const w of pages[cursor] ?? []) conn.nodes.push(w);
      return conn;
    },
  };
  return conn;
}

function makeClient(pages: Webhook[][], calls: string[], createSuccess = true) {
  const created: Array<Record<string, unknown>> = [];
  const updated: Array<{ id: string; input: Record<string, unknown> }> = [];
  const deleted: string[] = [];
  const client = {
    async webhooks(_args: unknown) {
      calls.push('client:webhooks');
      return connectionOf(pages);
    },
    async createWebhook(input: Record<string, unknown>) {
      calls.push('client:createWebhook');
      created.push(input);
      return { success: createSuccess };
    },
    async updateWebhook(id: string, input: Record<string, unknown>) {
      calls.push('client:updateWebhook');
      updated.push({ id, input });
      return { success: true };
    },
    async deleteWebhook(id: string) {
      calls.push('client:deleteWebhook');
      deleted.push(id);
      return { success: true };
    },
  };
  return { client: client as unknown as LinearClient, created, updated, deleted };
}

function makeStore(calls: string[], seed: Record<string, string> = {}) {
  const kv = new Map<string, string>(Object.entries(seed));
  const store = {
    kvGet: (k: string) => kv.get(k),
    kvSet: (k: string, v: string) => {
      calls.push(`kv:put:${k}`);
      kv.set(k, v);
    },
  } as unknown as Store;
  return { store, kv };
}

function makeLogger() {
  const lines: unknown[][] = [];
  const record = (...args: unknown[]) => {
    lines.push(args);
  };
  const log: Logger = {
    child: () => log,
    info: record,
    warn: record,
    error: record,
    debug: record,
  };
  return { log, lines };
}

test('fresh install: generates id and secret and persists both before any Linear call', async () => {
  const calls: string[] = [];
  const { client, created } = makeClient([[]], calls);
  const { store, kv } = makeStore(calls);
  const { log } = makeLogger();

  const out = await reconcile(client, store, log, TUNNEL);

  // HOOK-03 ordering: the secret is durable before a single byte leaves for Linear.
  const secretWrite = calls.indexOf('kv:put:webhook_secret');
  const firstRemote = calls.findIndex((c) => c.startsWith('client:'));
  assert.notEqual(secretWrite, -1, 'secret was never persisted');
  assert.notEqual(firstRemote, -1, 'no Linear call was made');
  assert.ok(secretWrite < firstRemote, 'secret must be persisted before the first Linear call');

  assert.match(out.secret, /^[0-9a-f]{64}$/, '32 random bytes, hex');
  assert.equal(kv.get('webhook_id'), out.id);
  assert.equal(kv.get('webhook_secret'), out.secret);
  assert.equal(out.url, DESIRED);

  assert.equal(created.length, 1);
  assert.equal(created[0]?.id, out.id);
  assert.equal(created[0]?.secret, out.secret);
  assert.equal(created[0]?.url, DESIRED);
  assert.equal(created[0]?.enabled, true);
  assert.equal(created[0]?.label, WEBHOOK_LABEL);
  assert.deepEqual(created[0]?.resourceTypes, ['Issue', 'Comment']);
});

test('second boot: reuses the persisted id and secret, generates nothing new', async () => {
  const calls: string[] = [];
  const { client, created } = makeClient([[]], calls);
  const { store } = makeStore(calls, {
    webhook_id: 'persisted-id',
    webhook_secret: 'persisted-secret',
  });
  const { log } = makeLogger();

  const out = await reconcile(client, store, log, TUNNEL);

  assert.equal(out.id, 'persisted-id');
  assert.equal(out.secret, 'persisted-secret');
  assert.equal(created[0]?.id, 'persisted-id');
  assert.equal(created[0]?.secret, 'persisted-secret');
});

test('existing registration: updated with enabled:true, never re-created (D-02)', async () => {
  const calls: string[] = [];
  const disabled = hook('persisted-id', 'https://old.ngrok-free.app/linear/webhook', WEBHOOK_LABEL, false);
  const { client, created, updated, deleted } = makeClient([[disabled]], calls);
  const { store } = makeStore(calls, {
    webhook_id: 'persisted-id',
    webhook_secret: 'persisted-secret',
  });
  const { log } = makeLogger();

  await reconcile(client, store, log, TUNNEL);

  assert.equal(created.length, 0, 'create path must not be reached when our id exists');
  assert.equal(updated.length, 1);
  assert.equal(updated[0]?.id, 'persisted-id');
  assert.equal(updated[0]?.input.url, DESIRED);
  // Unconditional re-enable: an auto-disabled webhook is the steady state here.
  assert.equal(updated[0]?.input.enabled, true);
  assert.deepEqual(deleted, [], 'our own live registration is never deleted');
});

test('pagination: two pages of three yield six webhooks, not nine (T22)', async () => {
  const calls: string[] = [];
  const pages = [
    [
      hook('a', 'https://a.ngrok-free.app/linear/webhook'),
      hook('b', 'https://b.ngrok-free.app/linear/webhook'),
      hook('c', 'https://c.ngrok.io/linear/webhook'),
    ],
    [
      hook('d', 'https://d.ngrok-free.app/linear/webhook'),
      hook('e', 'https://e.ngrok.dev/linear/webhook'),
      hook('f', 'https://f.ngrok-free.app/linear/webhook'),
    ],
  ];
  const { client, deleted } = makeClient(pages, calls);
  const { store } = makeStore(calls, {
    webhook_id: 'not-in-either-page',
    webhook_secret: 'persisted-secret',
  });
  const { log } = makeLogger();

  await reconcile(client, store, log, TUNNEL);

  // Six strays seen once each. A per-iteration collector would report nine and
  // issue nine deletes -- the same double-count that, matched on URL rather than
  // id, deletes this daemon's own live registration.
  assert.equal(deleted.length, 6, 'six webhooks, not nine');
  assert.deepEqual([...deleted].sort(), ['a', 'b', 'c', 'd', 'e', 'f']);
});

test('pagination: our own registration on page one survives a second page', async () => {
  const calls: string[] = [];
  const pages = [
    [hook('persisted-id', 'https://old.ngrok-free.app/linear/webhook')],
    [hook('stray', 'https://stray.ngrok-free.app/linear/webhook')],
  ];
  const { client, created, updated, deleted } = makeClient(pages, calls);
  const { store } = makeStore(calls, {
    webhook_id: 'persisted-id',
    webhook_secret: 'persisted-secret',
  });
  const { log } = makeLogger();

  await reconcile(client, store, log, TUNNEL);

  assert.equal(created.length, 0);
  assert.equal(updated.length, 1);
  assert.deepEqual(deleted, ['stray']);
});

test('prune is label-scoped: foreign ngrok webhooks and non-ngrok webhooks are untouched (HOOK-09)', async () => {
  const calls: string[] = [];
  const pages = [
    [
      hook('persisted-id', 'https://live.ngrok-free.app/linear/webhook'),
      hook('ours-stray', 'https://dead.ngrok-free.app/linear/webhook'),
      hook('foreign', 'https://other-tool.ngrok-free.app/hook', 'some-other-tool'),
      hook('unlabelled', 'https://anon.ngrok-free.app/hook', null),
      hook('ours-static', 'https://worker.example.com/linear/webhook'),
    ],
  ];
  const { client, deleted } = makeClient(pages, calls);
  const { store } = makeStore(calls, {
    webhook_id: 'persisted-id',
    webhook_secret: 'persisted-secret',
  });
  const { log } = makeLogger();

  await reconcile(client, store, log, TUNNEL);

  assert.deepEqual(deleted, ['ours-stray']);
});

test('create failure is loud', async () => {
  const calls: string[] = [];
  const { client } = makeClient([[]], calls, false);
  const { store } = makeStore(calls);
  const { log } = makeLogger();

  await assert.rejects(() => reconcile(client, store, log, TUNNEL), /registration failed/);
});

test('no logged value contains a signing secret (T23)', async () => {
  const calls: string[] = [];
  const pages = [
    [
      hook('persisted-id', 'https://live.ngrok-free.app/linear/webhook'),
      hook('ours-stray', 'https://dead.ngrok-free.app/linear/webhook'),
      hook('foreign', 'https://other.ngrok-free.app/hook', 'some-other-tool'),
    ],
    [hook('ours-stray-2', 'https://dead2.ngrok-free.app/linear/webhook')],
  ];
  const { client } = makeClient(pages, calls);
  const { store } = makeStore(calls, {
    webhook_id: 'persisted-id',
    webhook_secret: 'persisted-secret',
  });
  const { log, lines } = makeLogger();

  await reconcile(client, store, log, TUNNEL);

  assert.ok(lines.length > 0, 'the reconciler must log something, or this test is vacuous');
  const serialised = JSON.stringify(lines);
  for (const s of [...secretsOf(pages), 'persisted-secret']) {
    assert.ok(!serialised.includes(s), `logger received a signing secret: ${s}`);
  }
});
