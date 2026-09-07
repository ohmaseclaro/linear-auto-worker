/**
 * The wizard's last act: register the Linear webhook (SETUP-09).
 *
 * This is what makes `law setup` end with a system that is already working rather than one
 * that is merely configured. It is deliberately thin — the tunnel and the registrar are
 * `src/domain/ports.ts` interfaces, so this module composes them and translates failure
 * into an operator-actionable fix string, while Phase 3 owns the real ngrok/Linear-backed
 * implementations and Phase 7's composition root supplies them.
 *
 * Three verified traps land here:
 *  - **Reconcile by LABEL, never by URL.** PROJECT.md keeps the ephemeral ngrok domain, so
 *    the registered URL is different on every boot. A URL match would never find "our"
 *    prior webhook and would create a duplicate on every single run (Pitfall 2 / T-08-20).
 *    `WEBHOOK_LABEL` is the only stable identifier, so it is imported from Phase 3's
 *    registrar rather than re-declared here — two copies of an ownership marker is exactly
 *    how a reconciler ends up deleting a webhook it does not recognise as its own.
 *  - **T23: a raw Linear `Webhook` carries its signing secret.** Nothing here ever logs a
 *    webhook object, and the signing secret returned by `reconcile()` is returned to the
 *    caller for persistence and NEVER printed. Note `LinearClient.listWebhooks()` already
 *    hands back a projection with no `secret` field — that projection is the reason the
 *    doctor path below can print what it finds at all.
 *  - **T24/T25: an ngrok error message can echo the authtoken back.** Every catch below
 *    extracts at most the `ERR_NGROK_nnnn` code out of the message and discards the rest;
 *    no raw error object or message ever reaches the operator's terminal or a log file.
 */
import { confirm } from '@inquirer/prompts';
import * as net from 'node:net';

import type {
  Config,
  LinearClient,
  Logger,
  TunnelManager,
  WebhookRegistrar,
} from '../../domain/index.js';
import { webhookTeamId } from '../../infra/config.js';
import { asDomainStore } from '../../infra/store/domain-store.js';
import { openStore } from '../../infra/store/db.js';
import { createSqliteStore } from '../../infra/store/sqlite-store.js';
import {
  createWebhookRegistrar,
  ensureWebhookSecret,
  WEBHOOK_LABEL,
} from '../../ingress/registrar.js';
import { createTunnelManager } from '../../ingress/tunnel.js';
import { LinearClientImpl } from '../../outbound/linear-client.js';

/** One definition, owned by Phase 3's registrar; re-exported so wizard callers need one import. */
export { WEBHOOK_LABEL };

/**
 * A URL that looks like it belongs to an ngrok tunnel.
 *
 * ponytail: a second copy of the regex Phase 3's registrar keeps private, because it is
 * one line and exporting it would widen that module's API for a single consumer. If a
 * third consumer appears, promote it to `src/domain/`.
 */
const NGROK_URL = /\.ngrok(-free)?\.(app|dev|io)(\/|$)/;

/**
 * Success carries the registration; failure carries a fix, never a stack trace and never a
 * raw error — the same `{ ok, fix }` convention `secrets.ts` established for a step that
 * halts the wizard (D-08). Registration is a hard failure, not a `SafetyWarning`: a repo
 * with a warning is still usable, a setup with no webhook is not.
 */
export type RegisterResult =
  | { ok: true; webhookId: string; secret: string; publicUrl: string }
  | { ok: false; fix: string };

const NGROK_AUTH_FIX =
  'The ngrok tunnel could not be opened — the authtoken was rejected. Check NGROK_AUTHTOKEN ' +
  'in ~/.linear-auto-worker/.env against https://dashboard.ngrok.com/get-started/your-authtoken ' +
  'and re-run setup';

const NGROK_GENERIC_FIX =
  'The ngrok tunnel could not be opened. Check network connectivity and that your ngrok ' +
  'account has an available tunnel, then re-run setup';

const REGISTRAR_FIX =
  'The Linear webhook could not be registered. Registration requires a WORKSPACE ADMIN key: ' +
  'confirm this account is an admin in Settings -> Members, then re-run setup';

/**
 * The one thing safe to surface from an ngrok failure.
 *
 * T24: the malformed-token error echoes the token back inside its own message, so the
 * message is never interpolated anywhere. T25: every ngrok error carries
 * `code: "GenericFailure"`, so the discriminating information lives only in the message
 * text — matched here and then thrown away.
 */
function ngrokFix(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err ?? '');
  // ERR_NGROK_105 = bad authtoken, ERR_NGROK_4018 = missing/unauthenticated.
  return /ERR_NGROK_(105|4018)/.test(message) ? NGROK_AUTH_FIX : NGROK_GENERIC_FIX;
}

/**
 * Open the tunnel, then converge the workspace on exactly one webhook owned by this daemon.
 *
 * `registrar.reconcile()` is idempotent create-or-update **by `WEBHOOK_LABEL`** per its
 * port contract; re-running it against the same workspace updates the existing registration
 * rather than adding a second one.
 */
export async function reconcileWebhook(
  tunnel: TunnelManager,
  registrar: WebhookRegistrar,
  port: number,
): Promise<RegisterResult> {
  let publicUrl: string;
  try {
    publicUrl = await tunnel.open(port);
  } catch (err) {
    return { ok: false, fix: ngrokFix(err) };
  }

  // T19: `listener.url()` is `string | null`. An empty URL registers "null/linear/webhook",
  // and the daemon then boots clean, reports healthy, and receives nothing — the worst
  // failure shape in the project. Fail loudly here instead.
  if (!publicUrl) {
    return { ok: false, fix: NGROK_GENERIC_FIX };
  }

  try {
    const { webhookId, secret } = await registrar.reconcile(publicUrl);
    // The secret is returned, never printed. T-08-17: this plan's console output only ever
    // confirms that a secret was persisted, never its value.
    return { ok: true, webhookId, secret, publicUrl };
  } catch {
    // The raw error is dropped: a GraphQL error body can carry the request text, and it is
    // unactionable next to the named fix.
    return { ok: false, fix: REGISTRAR_FIX };
  }
}

// ---------------------------------------------------------------------------
// The composition `law setup` was missing
// ---------------------------------------------------------------------------

/**
 * What `registerAtSetup` needs in order to prove a registration works, and how to put it
 * all down again.
 *
 * This interface exists so the wizard's end-to-end test can drive step 7 without a Linear
 * workspace or an ngrok account — `make` is a default parameter, never a mocked module
 * (T88: an ESM namespace binding is non-configurable by specification).
 */
export interface SetupAdapters {
  tunnel: TunnelManager;
  registrar: WebhookRegistrar;
  /** The loopback port the tunnel forwards to. */
  port: number;
  /** Closes the tunnel, the throwaway socket and the database, in that order. */
  close(): Promise<void>;
}

export type MakeSetupAdapters = (ctx: SetupContext) => Promise<SetupAdapters>;

export interface SetupContext {
  config: Config;
  /**
   * The already-validated Linear key, NOT the `@linear/sdk` client the wizard holds.
   *
   * `createWebhookRegistrar` speaks `src/domain/ports.ts`'s `LinearClient`, and
   * `LinearClientImpl` is the only bridge from the SDK to that port — it takes the key.
   * Passing the key rather than re-wrapping the SDK object keeps one construction path.
   */
  linearApiKey: string;
  ngrokAuthtoken: string;
}

/**
 * A logger that writes nowhere.
 *
 * `createLogger()` writes pino JSON to **stdout** (`infra/logger.ts`'s
 * `SecretScrubbingStream`), so handing it to the registrar would interleave machine log
 * lines through a wizard whose entire output contract is "a named, actionable line per
 * step" (D-08). Every failure on this path already comes back as a `fix` string, so there
 * is nothing here a log line would add that the operator does not already get.
 *
 * ponytail: five lines beat a second sink. Give it a real file sink the day `law setup`
 * needs a post-mortem trail.
 */
const silentLog: Logger = {
  child: () => silentLog,
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

/**
 * The real tunnel, the real registrar, and the loopback socket the tunnel forwards to.
 *
 * Ordering is HOOK-01's, deliberately: the socket BINDS BEFORE the tunnel opens. The
 * daemon does exactly this and for exactly this reason (a live public URL backed by
 * nothing burns Linear's three-delivery retry budget), so the wizard must not model the
 * opposite — and `addr: 0` would forward ngrok at port 0, while guessing a fixed port is
 * worse than binding one.
 *
 * The store is here because the registrar's contract requires the SIGNING SECRET to be
 * persisted before the remote call (T-07-22), and `ensureWebhookSecret` writes it under
 * the same kv key `law start` reads — so the daemon reuses this registration rather than
 * minting a second secret its own receiver would then reject.
 */
async function realSetupAdapters(ctx: SetupContext): Promise<SetupAdapters> {
  // Throws with the named "no Linear team is configured" line when there is no team
  // anywhere. `registerAtSetup` turns that into the fix the operator reads.
  const teamId = webhookTeamId(ctx.config);

  const db = openStore(ctx.config.dbPath);
  const store = asDomainStore(createSqliteStore(db));
  const { secret } = ensureWebhookSecret(store);

  const server = net.createServer();
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr === null || typeof addr === 'string') {
        reject(new Error('setup bound to a non-TCP address'));
        return;
      }
      resolve(addr.port);
    });
  });

  const linear = new LinearClientImpl({ apiKey: ctx.linearApiKey });
  const tunnel = createTunnelManager(ctx.ngrokAuthtoken, silentLog);

  return {
    tunnel,
    registrar: createWebhookRegistrar(linear, store, silentLog, { teamId, secret }),
    port,
    async close(): Promise<void> {
      await tunnel.close().catch(() => {});
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    },
  };
}

/**
 * `law setup`'s last step, and the only thing that proves the setup actually works.
 *
 * Registration is not a formality here: `webhookCreate` is the WORKSPACE-ADMIN-gated call,
 * and opening a tunnel is the only proof the ngrok authtoken is live. Listing webhooks
 * would prove neither. So this fails at setup rather than at the operator's first
 * `law start` three days later.
 *
 * `close()` runs in a `finally` — a tunnel left open by a failed registration outlives the
 * command and holds the operator's single free ngrok session.
 */
export async function registerAtSetup(
  ctx: SetupContext,
  make: MakeSetupAdapters = realSetupAdapters,
): Promise<RegisterResult> {
  let adapters: SetupAdapters;
  try {
    adapters = await make(ctx);
  } catch (err) {
    // The only expected throw is `webhookTeamId`'s, whose message names the real fix.
    // Surfacing REGISTRAR_FIX here instead would send the operator to check an admin
    // grant that is not the problem. Message only — never a stack trace (D-08).
    return { ok: false, fix: err instanceof Error ? err.message : String(err) };
  }

  try {
    return await reconcileWebhook(adapters.tunnel, adapters.registrar, adapters.port);
  } finally {
    await adapters.close();
  }
}

// ---------------------------------------------------------------------------
// law setup --doctor
// ---------------------------------------------------------------------------

export type DoctorAction = 'ok' | 'reenabled' | 'reported' | 'deleted';

export interface DoctorFinding {
  webhookId: string;
  url: string;
  label: string | null;
  action: DoctorAction;
  message: string;
}

/**
 * The three webhook operations the doctor needs, taken from the `LinearClient` port.
 *
 * `listWebhooks()` is the projection that drops the signing secret (T23) and pages to
 * completion inside the implementation — this module must never page a raw connection
 * itself, because `fetchNext()` mutates and returns `this`, so the intuitive loop
 * double-counts every page and the reconciler ends up classifying its own live webhook as
 * a duplicate (T22).
 */
export type DoctorClient = Pick<LinearClient, 'listWebhooks' | 'updateWebhook' | 'deleteWebhook'>;

export interface DoctorDeps {
  /** Per-item, defaulting to NO. There is no blanket-delete path (T-08-16). */
  confirmDelete?: (finding: Omit<DoctorFinding, 'action'>) => Promise<boolean>;
  log?: (message: string) => void;
}

const promptDelete = (finding: Omit<DoctorFinding, 'action'>): Promise<boolean> =>
  confirm({
    message: `Delete this webhook? ${finding.url} (label: ${finding.label ?? 'none'})`,
    default: false,
  });

/**
 * Inspect the workspace's webhooks and report what looks wrong (Pitfall 2's `--doctor`).
 *
 * The one genuinely destructive action in this whole phase lives here, so its rules are
 * narrow and stated once:
 *  - a webhook labelled `WEBHOOK_LABEL` is OURS: it is never deleted, and if Linear has
 *    auto-disabled it (which it does to a persistently-unresponsive endpoint, and an
 *    ephemeral tunnel URL guarantees failed deliveries on every restart) it is re-enabled
 *    automatically — T-08-18, otherwise the operator is left with a silently dead setup;
 *  - a webhook with a DIFFERENT label but an ngrok-looking URL is reported and never
 *    auto-deleted: another tool in the same workspace may legitimately run its own tunnel,
 *    and the label is the only field that tells the two apart. Deletion requires an
 *    explicit per-item confirmation;
 *  - anything else is left alone entirely and not even reported — it is not this daemon's
 *    business.
 */
export async function doctorWebhooks(
  client: DoctorClient,
  deps: DoctorDeps = {},
): Promise<DoctorFinding[]> {
  const log = deps.log ?? ((message: string) => console.log(message));
  const confirmDelete = deps.confirmDelete ?? promptDelete;

  const webhooks = await client.listWebhooks();
  const findings: DoctorFinding[] = [];

  for (const webhook of webhooks) {
    const base = { webhookId: webhook.id, url: webhook.url, label: webhook.label };

    if (webhook.label === WEBHOOK_LABEL) {
      if (webhook.enabled) {
        findings.push({ ...base, action: 'ok', message: 'ours, enabled' });
        continue;
      }
      // D-02 / T-08-18: re-enable is one call, and it is the steady state rather than a
      // repair — Linear auto-disables an endpoint whose URL went stale, which an ephemeral
      // domain guarantees on every restart.
      await client.updateWebhook(webhook.id, { enabled: true });
      const message = 'ours, was auto-disabled by Linear — re-enabled';
      log(`~ ${webhook.url}: ${message}`);
      findings.push({ ...base, action: 'reenabled', message });
      continue;
    }

    if (!NGROK_URL.test(webhook.url)) continue;

    const message =
      'an ngrok-looking webhook this daemon does not own (different label) — it may belong ' +
      'to another tool in this workspace';
    log(`! ${webhook.url}: ${message}`);

    // Report first, ask second, and default to NO. Nothing above this line can delete.
    if (await confirmDelete({ ...base, message })) {
      await client.deleteWebhook(webhook.id);
      findings.push({ ...base, action: 'deleted', message: `${message} — deleted on request` });
    } else {
      findings.push({ ...base, action: 'reported', message });
    }
  }

  if (findings.length === 0) log('no webhooks to report');
  return findings;
}
