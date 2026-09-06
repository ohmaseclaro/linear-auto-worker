/**
 * Webhook registration reconciler -- HOOK-02, HOOK-03, HOOK-09.
 *
 * D-01 keeps the ngrok domain ephemeral, so the registered URL is stale on every
 * boot by construction. Reconciliation is therefore the normal path here, not a
 * repair path, and so is finding our own webhook DISABLED: an ephemeral URL
 * guarantees failed deliveries on every restart, Linear auto-disables after three,
 * and that is the steady state rather than an edge case (03-CONTEXT D-02).
 *
 * ## Why this speaks the domain port and not the raw SDK
 *
 * It used to take an `@linear/sdk` `LinearClient` directly, which made two things
 * this module's problem that are not: paging a connection whose `fetchNext()`
 * mutates and returns `this` (T22), and holding raw `Webhook` objects that carry a
 * live signing secret (T23). Both now live once, inside `outbound/linear-client.ts`
 * -- `listWebhooks()` pages to completion and projects `secret` away at the only
 * place raw webhooks exist. What is left here is reconciliation logic, which is
 * what lets the boot smoke exercise it offline against `FakeLinearClient` instead
 * of leaving the one step that mutates workspace configuration unexercised.
 *
 * ## Why ownership is matched by LABEL and not by a client-supplied id
 *
 * The previous version generated the webhook id itself and passed it to the create
 * mutation. `WebhookCreateInput` does accept an `id`, but the domain port
 * deliberately does not expose it, and matching on a self-assigned id is a weaker
 * scheme than it looks: an operator who deletes the webhook in the Linear UI leaves
 * a persisted id matching nothing, and the reconciler then creates a second
 * registration while the prune below refuses to touch the first (it is matched by
 * id, and the id is now the live one). The label is the field that survives both.
 */
import type { LinearClient, Logger, Store } from '../domain/ports.js';

/**
 * Only a registration carrying this label is ours. HOOK-09's prune is gated on it
 * because another tool in the same workspace may legitimately run its own ngrok
 * webhook, and the label is the only field that tells the two apart.
 */
export const WEBHOOK_LABEL = 'linear-auto-worker';

const NGROK_URL = /\.ngrok(-free)?\.(app|dev|io)(\/|$)/;

/** kv keys. Exported so the composition root reads the SAME key this module writes --
 *  a second spelling of 'webhook_secret' is a receiver that verifies against a secret
 *  nobody registered, which fails as a 400 on every real delivery. */
export const KEY_ID = 'webhook_id';
export const KEY_SECRET = 'webhook_secret';

/** The resource types this daemon subscribes to. A narrower subscription is fewer
 *  loop surfaces for the four ingress guards. */
export const RESOURCE_TYPES = ['Issue', 'Comment'];

export interface WebhookRegistration {
  id: string;
  secret: string;
  url: string;
  /** True when the reconcile had to create the registration rather than update one. */
  created: boolean;
  /** True when the registration we found was disabled and this call re-enabled it. */
  reenabled: boolean;
}

export interface ReconcileOptions {
  tunnelUrl: string;
  /** Linear requires a team on `webhookCreate`. The composition root resolves it. */
  teamId: string;
  /** Generated locally and ALREADY persisted by the caller. See below. */
  secret: string;
}

/**
 * Converge the workspace on exactly one webhook owned by this daemon.
 *
 * ## The secret ordering, which is T-07-22
 *
 * The signing secret is OURS (HOOK-03 / 03-02 D-03 / research landmine #3): generated
 * locally, never read back from Linear -- whose own documentation and whose shipped
 * GraphQL schema disagree about whether it is returned at all. The caller generates and
 * PERSISTS it before calling here, and the id is persisted in the same transaction as
 * the secret immediately after the create. So the only crash window is one in which the
 * secret is on disk and the webhook is not, which self-heals on the next boot -- the
 * reverse window, a live webhook whose secret is nowhere, would make every delivery fail
 * signature verification with no way back except deleting the webhook by hand.
 */
export async function reconcile(
  client: LinearClient,
  store: Store,
  log: Logger,
  o: ReconcileOptions,
): Promise<WebhookRegistration> {
  const desiredUrl = `${o.tunnelUrl}/linear/webhook`;

  // Paged to completion by the facade. A reconciler that sees only the first page
  // reconciles against a partial view and registers a duplicate of a webhook it
  // could not see.
  const all = await client.listWebhooks();
  const ours = all.filter((w) => w.label === WEBHOOK_LABEL);
  // Deterministic when the workspace somehow holds more than one of ours: keep the
  // one whose id we already persisted, else the first. The rest are pruned below.
  const persistedId = store.kvGet(KEY_ID);
  const keep = ours.find((w) => w.id === persistedId) ?? ours[0];

  let id: string;
  let created = false;
  let reenabled = false;

  if (!keep) {
    // T21: the SDK method is `createWebhook`. The `webhookCreate` GraphQL mutation
    // spelling used in PROJECT.md and PITFALLS.md is not a method on the client.
    const res = await client.createWebhook({
      label: WEBHOOK_LABEL,
      url: desiredUrl,
      teamId: o.teamId,
      secret: o.secret,
      resourceTypes: RESOURCE_TYPES,
    });
    id = res.id;
    created = true;
    log.info({ webhookId: id, url: desiredUrl }, 'webhook registered');
  } else {
    id = keep.id;
    reenabled = !keep.enabled;
    // D-02: URL update and re-enable in ONE call, and `enabled: true` is
    // unconditional. This is not a repair path -- with an ephemeral URL every
    // restart guarantees failed deliveries, so arriving here to find the webhook
    // disabled is the normal case.
    await client.updateWebhook(id, {
      url: desiredUrl,
      enabled: true,
      resourceTypes: RESOURCE_TYPES,
    });
    log.info({ webhookId: id, url: desiredUrl, reenabled }, 'webhook reconciled');
  }

  // One transaction, so a crash between the two writes is impossible (T-07-22).
  store.transaction(() => {
    store.kvSet(KEY_ID, id);
    store.kvSet(KEY_SECRET, o.secret);
  });

  // HOOK-09: prune our own abandoned ngrok registrations only. All three conditions
  // are load-bearing -- the id check keeps us off the live one, the label keeps us
  // off a foreign tool's webhook, and the URL shape keeps us off our own non-tunnel
  // registrations.
  for (const w of all) {
    if (w.id === id) continue;
    if (w.label !== WEBHOOK_LABEL) continue;
    if (!w.url || !NGROK_URL.test(w.url)) continue;
    log.warn({ webhookId: w.id, url: w.url }, 'pruning stale ngrok webhook');
    await client.deleteWebhook(w.id);
  }

  return { id, secret: o.secret, url: desiredUrl, created, reenabled };
}

/**
 * Shutdown's politeness step (OPS-05 step 3, T-07-23).
 *
 * The tunnel URL is about to stop answering. Linear retries a failed delivery three
 * times and then disables the webhook, so leaving it enabled spends that budget on
 * deliveries that cannot land -- and the next boot's reconcile has to re-enable it
 * anyway. Disabling costs one call and leaves the registration intact.
 *
 * Best effort by contract: it returns false rather than throwing. A shutdown that
 * can be blocked by Linear being slow is a shutdown that does not release the port,
 * does not reap the children and does not mark the in-flight runs.
 */
export async function disable(client: LinearClient, store: Store, log: Logger): Promise<boolean> {
  const id = store.kvGet(KEY_ID);
  if (!id) return false;
  try {
    await client.updateWebhook(id, { enabled: false });
    log.info({ webhookId: id }, 'webhook disabled for shutdown');
    return true;
  } catch (err) {
    log.warn({ webhookId: id, err: String(err) }, 'could not disable the webhook; continuing');
    return false;
  }
}
