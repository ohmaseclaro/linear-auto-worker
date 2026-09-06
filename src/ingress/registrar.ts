/**
 * Webhook registration reconciler -- HOOK-02, HOOK-03, HOOK-09.
 *
 * D-01 keeps the ngrok domain ephemeral, so the registered URL is stale on every
 * boot by construction. Reconciliation is therefore the normal path here, not a
 * repair path, and ownership is matched on a locally generated id that outlives
 * a URL which is different every time the daemon starts.
 */
import crypto from 'node:crypto';
import type { LinearClient, Webhook } from '@linear/sdk';
import type { Logger, Store } from '../domain/ports.js';

/**
 * Only a registration carrying this label is ours. HOOK-09's prune is gated on it
 * because another tool in the same workspace may legitimately run its own ngrok
 * webhook, and the label is the only field that tells the two apart.
 */
export const WEBHOOK_LABEL = 'linear-auto-worker';

const NGROK_URL = /\.ngrok(-free)?\.(app|dev|io)(\/|$)/;

const KEY_ID = 'webhook_id';
const KEY_SECRET = 'webhook_secret';

export interface WebhookRegistration {
  id: string;
  secret: string;
  url: string;
}

/**
 * Converge the workspace on exactly one webhook owned by this daemon.
 * Returns the id, the signing secret the receiver verifies against, and the URL
 * now registered with Linear.
 */
export async function reconcile(
  client: LinearClient,
  store: Store,
  log: Logger,
  tunnelUrl: string,
): Promise<WebhookRegistration> {
  const desiredUrl = `${tunnelUrl}/linear/webhook`;

  // HOOK-03 / D-03: the signing secret is ours. Generated locally and written to
  // kv BEFORE the first remote call, never read back -- Unknown 3 found the field
  // the API returns is typed nullable, so reading it back is code that works
  // until it doesn't. The client-supplied id is what makes registration
  // idempotent across a URL that changes on every boot (D-01).
  const id = store.kvGet(KEY_ID) ?? crypto.randomUUID();
  const secret = store.kvGet(KEY_SECRET) ?? crypto.randomBytes(32).toString('hex');
  store.kvPut(KEY_ID, id);
  store.kvPut(KEY_SECRET, secret);

  // T22: fetchNext() mutates and returns `this`, appending into page.nodes.
  // Collecting nodes per iteration therefore duplicates every earlier page, and
  // the prune below would then act on registrations it has already seen.
  const page = await client.webhooks({ first: 250 });
  while (page.pageInfo.hasNextPage) await page.fetchNext();
  const all: Webhook[] = page.nodes;
  // T23: every element above carries a live signing secret. Project before logging.

  // Match on the persisted id, never on URL equality -- the URL is different on
  // every boot by design.
  const ours = all.find((w) => w.id === id);

  if (!ours) {
    // T21: the SDK method is createWebhook. The GraphQL mutation spelling used in
    // PROJECT.md and PITFALLS.md is not a method on LinearClient and tsc rejects it.
    const res = await client.createWebhook({
      id,
      secret,
      url: desiredUrl,
      enabled: true,
      label: WEBHOOK_LABEL,
      allPublicTeams: true,
      // A narrower subscription is fewer loop surfaces for plan 03-03's guards.
      resourceTypes: ['Issue', 'Comment'],
    });
    if (!res.success) throw new Error('webhook registration failed');
    log.info({ webhookId: id, url: desiredUrl }, 'webhook registered');
  } else {
    // D-02: URL update and re-enable in one call. `enabled: true` is unconditional
    // and is not a repair -- with an ephemeral URL every restart guarantees failed
    // deliveries, so Linear auto-disabling the webhook is the steady state.
    await client.updateWebhook(id, { url: desiredUrl, enabled: true });
    log.info(
      { webhookId: id, url: desiredUrl, wasEnabled: ours.enabled },
      'webhook reconciled',
    );
  }

  // HOOK-09: prune our own abandoned ngrok registrations only. All three
  // conditions are load-bearing -- id mismatch keeps us from deleting the live
  // one, the label keeps us off a foreign tool's webhook, and the URL shape keeps
  // us off our own non-tunnel registrations.
  for (const w of all) {
    if (w.id === id) continue;
    if (w.label !== WEBHOOK_LABEL) continue;
    if (!NGROK_URL.test(w.url)) continue;
    log.warn({ webhookId: w.id, url: w.url }, 'pruning stale ngrok webhook');
    await client.deleteWebhook(w.id);
  }

  return { id, secret, url: desiredUrl };
}
