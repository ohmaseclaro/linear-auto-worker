/**
 * Reconciler tests.
 *
 * ## What moved out of this file in 07-05, and where the coverage went
 *
 * The old version's load-bearing case was pagination: T22's `fetchNext()` mutates and
 * returns `this`, so a loop collecting `page.nodes` per iteration sees every earlier page
 * twice and issues nine deletes for six webhooks. That trap no longer exists HERE --
 * the reconciler now speaks the domain port, and `LinearClientImpl.listWebhooks()` pages
 * to completion with `pageAll` and hands back one flat array. T22 is owned by
 * `outbound/linear-client.ts` and is asserted there.
 *
 * Same for T23. The old reconciler held raw `Webhook` objects, every one of which carries
 * a live signing secret. The domain port's `listWebhooks()` returns a summary with no
 * `secret` field at all, so leaking one from here is a compile error rather than a test.
 * What survives as a real risk is the CALLER's secret, which this module does hold in
 * order to pass it to the create mutation -- and that is what the last test covers.
 *
 * The payoff for the move is that the boot smoke can now run this step offline against
 * `FakeLinearClient`, so the one boot step that mutates workspace configuration stops
 * being the one boot step nothing exercises.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeLinearClient } from '../domain/fakes.js';
import type { Logger, Store } from '../domain/ports.js';
import {
  createWebhookRegistrar,
  disable,
  ensureWebhookSecret,
  KEY_ID,
  KEY_SECRET,
  reconcile,
  WEBHOOK_LABEL,
} from './registrar.js';

const TUNNEL = 'https://abc123.ngrok-free.app';
const DESIRED = `${TUNNEL}/linear/webhook`;
const TEAM = 'team-1';
const SECRET = 'a'.repeat(64);

type Summary = {
  id: string;
  label: string | null;
  url: string;
  enabled: boolean;
  resourceTypes: string[];
};

/**
 * The domain port, recorded. Extends the shared fake rather than re-declaring one, so a
 * port method added later is a compile error here too.
 */
class RecordingWebhookClient extends FakeLinearClient {
  readonly created: Array<Record<string, unknown>> = [];
  readonly updated: Array<{ id: string; input: Record<string, unknown> }> = [];
  readonly deleted: string[] = [];
  readonly calls: string[] = [];
  private readonly seeded: Summary[];
  private createFails: boolean;

  constructor(seeded: Summary[] = [], createFails = false) {
    super();
    this.seeded = seeded;
    this.createFails = createFails;
  }

  override listWebhooks(): Promise<Summary[]> {
    this.calls.push('client:listWebhooks');
    return Promise.resolve([...this.seeded]);
  }

  override createWebhook(i: {
    label: string;
    url: string;
    teamId: string;
    secret: string;
    resourceTypes: string[];
  }): Promise<{ id: string }> {
    this.calls.push('client:createWebhook');
    this.created.push({ ...i });
    if (this.createFails) return Promise.reject(new Error('webhook registration failed'));
    return Promise.resolve({ id: 'created-id' });
  }

  override updateWebhook(
    id: string,
    i: { url?: string; enabled?: boolean; resourceTypes?: string[] },
  ): Promise<void> {
    this.calls.push('client:updateWebhook');
    this.updated.push({ id, input: { ...i } });
    return Promise.resolve();
  }

  override deleteWebhook(id: string): Promise<void> {
    this.calls.push('client:deleteWebhook');
    this.deleted.push(id);
    return Promise.resolve();
  }
}

const summary = (
  id: string,
  url: string,
  label: string | null = WEBHOOK_LABEL,
  enabled = true,
): Summary => ({ id, label, url, enabled, resourceTypes: ['Issue', 'Comment'] });

function makeStore(calls: string[], seed: Record<string, string> = {}) {
  const kv = new Map<string, string>(Object.entries(seed));
  const store = {
    kvGet: (k: string) => kv.get(k),
    kvSet: (k: string, v: string) => {
      calls.push(`kv:put:${k}`);
      kv.set(k, v);
    },
    // Real enough to prove the pair is written together: the callback runs, and a throw
    // inside it is not swallowed.
    transaction: <T>(fn: () => T): T => {
      calls.push('kv:transaction');
      return fn();
    },
  } as unknown as Store;
  return { store, kv };
}

function makeLogger() {
  const lines: unknown[][] = [];
  const record = (...args: unknown[]) => {
    lines.push(args);
  };
  const log: Logger = { child: () => log, info: record, warn: record, error: record, debug: record };
  return { log, lines };
}

test('fresh install: creates with the caller secret and persists id and secret together', async () => {
  const calls: string[] = [];
  const client = new RecordingWebhookClient([]);
  const { store, kv } = makeStore(calls);
  const { log } = makeLogger();

  const out = await reconcile(client, store, log, {
    tunnelUrl: TUNNEL,
    teamId: TEAM,
    secret: SECRET,
  });

  assert.equal(out.created, true);
  assert.equal(out.id, 'created-id');
  assert.equal(out.url, DESIRED);
  assert.equal(kv.get(KEY_ID), 'created-id');
  assert.equal(kv.get(KEY_SECRET), SECRET);

  // T-07-22: both writes inside ONE transaction, so no crash window leaves a live
  // webhook whose signing secret is not on disk.
  const txn = calls.indexOf('kv:transaction');
  assert.notEqual(txn, -1, 'the pair must be written in a transaction');
  assert.ok(calls.indexOf(`kv:put:${KEY_ID}`) > txn);
  assert.ok(calls.indexOf(`kv:put:${KEY_SECRET}`) > txn);

  assert.equal(client.created.length, 1);
  assert.equal(client.created[0]?.secret, SECRET, 'the secret passed in is the secret sent');
  assert.equal(client.created[0]?.url, DESIRED);
  assert.equal(client.created[0]?.label, WEBHOOK_LABEL);
  assert.equal(client.created[0]?.teamId, TEAM);
  assert.deepEqual(client.created[0]?.resourceTypes, ['Issue', 'Comment']);
});

test('existing registration is matched by LABEL, not by the persisted id', async () => {
  // The operator deleted the webhook in the UI and re-made it; kv still holds the old id.
  // Matching on the id alone would create a SECOND registration and then refuse to prune
  // the first, because the prune skips whatever id is live.
  const calls: string[] = [];
  const client = new RecordingWebhookClient([summary('made-in-the-ui', `${TUNNEL}/linear/webhook`)]);
  const { store, kv } = makeStore(calls, { [KEY_ID]: 'long-gone', [KEY_SECRET]: SECRET });
  const { log } = makeLogger();

  const out = await reconcile(client, store, log, {
    tunnelUrl: TUNNEL,
    teamId: TEAM,
    secret: SECRET,
  });

  assert.equal(out.created, false, 'a labelled registration exists; do not create a second');
  assert.equal(out.id, 'made-in-the-ui');
  assert.equal(kv.get(KEY_ID), 'made-in-the-ui', 'the persisted id is corrected');
  assert.deepEqual(client.deleted, []);
});

test('a disabled registration is re-enabled in the same call as the URL update (D-02)', async () => {
  const calls: string[] = [];
  const dead = summary('ours', 'https://old.ngrok-free.app/linear/webhook', WEBHOOK_LABEL, false);
  const client = new RecordingWebhookClient([dead]);
  const { store } = makeStore(calls, { [KEY_ID]: 'ours', [KEY_SECRET]: SECRET });
  const { log } = makeLogger();

  const out = await reconcile(client, store, log, {
    tunnelUrl: TUNNEL,
    teamId: TEAM,
    secret: SECRET,
  });

  assert.equal(out.reenabled, true, 'finding it disabled is the NORMAL case, not a repair');
  assert.equal(client.created.length, 0, 'never re-create what can be updated');
  assert.equal(client.updated.length, 1, 'one call, not an update then an enable');
  assert.equal(client.updated[0]?.id, 'ours');
  assert.equal(client.updated[0]?.input.url, DESIRED);
  assert.equal(client.updated[0]?.input.enabled, true);
});

test('prune is label-scoped: foreign and non-ngrok registrations are untouched (HOOK-09)', async () => {
  const calls: string[] = [];
  const client = new RecordingWebhookClient([
    summary('ours-live', 'https://live.ngrok-free.app/linear/webhook'),
    summary('ours-stray-1', 'https://dead1.ngrok-free.app/linear/webhook'),
    summary('ours-stray-2', 'https://dead2.ngrok.io/linear/webhook'),
    summary('ours-stray-3', 'https://dead3.ngrok.dev/linear/webhook'),
    summary('foreign', 'https://other-tool.ngrok-free.app/hook', 'some-other-tool'),
    summary('unlabelled', 'https://anon.ngrok-free.app/hook', null),
    summary('ours-static', 'https://worker.example.com/linear/webhook'),
  ]);
  const { store } = makeStore(calls, { [KEY_ID]: 'ours-live', [KEY_SECRET]: SECRET });
  const { log } = makeLogger();

  await reconcile(client, store, log, { tunnelUrl: TUNNEL, teamId: TEAM, secret: SECRET });

  // Every stray our label owns, and nothing else. The live one is spared by the id
  // check, the foreign tool by the label, our own static registration by the URL shape.
  assert.deepEqual([...client.deleted].sort(), ['ours-stray-1', 'ours-stray-2', 'ours-stray-3']);
});

test('create failure is loud', async () => {
  const calls: string[] = [];
  const client = new RecordingWebhookClient([], true);
  const { store, kv } = makeStore(calls);
  const { log } = makeLogger();

  await assert.rejects(
    () => reconcile(client, store, log, { tunnelUrl: TUNNEL, teamId: TEAM, secret: SECRET }),
    /registration failed/,
  );
  assert.equal(kv.get(KEY_ID), undefined, 'no id is persisted for a webhook that does not exist');
});

test('disable() is best effort: a throwing Linear is logged, not propagated (T-07-23)', async () => {
  const calls: string[] = [];
  const client = new RecordingWebhookClient([summary('ours', DESIRED)]);
  client.updateWebhook = () => Promise.reject(new Error('linear is down'));
  const { store } = makeStore(calls, { [KEY_ID]: 'ours' });
  const { log } = makeLogger();

  // A shutdown that can be blocked by Linear being slow never reaches the steps that
  // release the port, reap the children and mark the in-flight runs.
  assert.equal(await disable(client, store, log), false);
});

test('disable() flips enabled off for the persisted id, and no-ops with no id', async () => {
  const calls: string[] = [];
  const client = new RecordingWebhookClient([summary('ours', DESIRED)]);
  const { store } = makeStore(calls, { [KEY_ID]: 'ours' });
  const { log } = makeLogger();

  assert.equal(await disable(client, store, log), true);
  assert.deepEqual(client.updated, [{ id: 'ours', input: { enabled: false } }]);

  const { store: empty } = makeStore(calls);
  assert.equal(await disable(new RecordingWebhookClient(), empty, log), false);
});

test('no logged value contains the signing secret (T23, residual)', async () => {
  const calls: string[] = [];
  const client = new RecordingWebhookClient([
    summary('ours-live', 'https://live.ngrok-free.app/linear/webhook'),
    summary('ours-stray', 'https://dead.ngrok-free.app/linear/webhook'),
  ]);
  const { store } = makeStore(calls, { [KEY_ID]: 'ours-live', [KEY_SECRET]: SECRET });
  const { log, lines } = makeLogger();

  await reconcile(client, store, log, { tunnelUrl: TUNNEL, teamId: TEAM, secret: SECRET });

  assert.ok(lines.length > 0, 'the reconciler must log something, or this test is vacuous');
  assert.ok(!JSON.stringify(lines).includes(SECRET), 'the caller secret reached the logger');
});

// ---------------------------------------------------------------------------
// ensureWebhookSecret / createWebhookRegistrar — moved out of `cli/daemon.ts`
// ---------------------------------------------------------------------------

test('ensureWebhookSecret mints a 64-char hex secret once and reuses it thereafter', () => {
  const calls: string[] = [];
  const { store, kv } = makeStore(calls);

  const first = ensureWebhookSecret(store);
  assert.equal(first.generated, true);
  assert.match(first.secret, /^[0-9a-f]{64}$/, '32 random bytes as hex');
  assert.equal(kv.get(KEY_SECRET), first.secret, 'persisted BEFORE any remote call (T-07-22)');

  const second = ensureWebhookSecret(store);
  assert.equal(second.generated, false, 'a second call must not mint a second secret');
  assert.equal(second.secret, first.secret);
});

test('createWebhookRegistrar passes the caller teamId and secret straight through', async () => {
  const calls: string[] = [];
  const client = new RecordingWebhookClient([]);
  const { store } = makeStore(calls);
  const { log } = makeLogger();

  const registrar = createWebhookRegistrar(client, store, log, { teamId: 'T', secret: 's' });
  const out = await registrar.reconcile('https://x.ngrok.app');

  assert.deepEqual(out, { webhookId: 'created-id', secret: 's' });
  assert.equal(client.created.length, 1);
  assert.equal(client.created[0]?.teamId, 'T', 'the team id came from the caller, not a constant');
  assert.equal(client.created[0]?.secret, 's');
  assert.equal(client.created[0]?.url, 'https://x.ngrok.app/linear/webhook');
});

test('createWebhookRegistrar.disable() disables the persisted registration', async () => {
  const calls: string[] = [];
  const client = new RecordingWebhookClient([summary('wh-1', DESIRED)]);
  const { store } = makeStore(calls, { [KEY_ID]: 'wh-1' });
  const { log } = makeLogger();

  await createWebhookRegistrar(client, store, log, { teamId: TEAM, secret: SECRET }).disable();

  assert.deepEqual(client.updated, [{ id: 'wh-1', input: { enabled: false } }]);
});
