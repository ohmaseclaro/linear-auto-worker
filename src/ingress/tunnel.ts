/**
 * TUN-01/02/03 — exactly one ngrok tunnel per worker process, with a URL that is
 * proven to exist before anything registers it.
 *
 * Every failure mode this module guards is silent by default: a null URL, an unset
 * env var and a leaked authtoken all produce a daemon that boots clean and reports
 * healthy. Each guard below is therefore a runtime assertion, not a review claim.
 *
 * TUN-02 needs no crash/restart machinery. The ngrok session is native and bound to
 * the OS process, so an orphaned tunnel is structurally impossible — the session dies
 * with the process whether the exit was graceful or not. No PID file, no lockfile.
 */

import ngrokSdk, { type Listener } from '@ngrok/ngrok';
import { TunnelError } from '../domain/errors.js';

/**
 * The slice of the ngrok SDK this module uses. Injectable so the tests can drive all
 * three verified failure paths without opening a real tunnel; production callers pass
 * nothing and get the real SDK.
 */
export interface NgrokApi {
  connect(config: { addr: number; authtoken_from_env: boolean }): Promise<Listener>;
  listeners(): Promise<Listener[]>;
  kill(): Promise<void>;
}

const ENV_HINT = 'Set it in ~/.linear-auto-worker/.env or re-run the setup wizard.';

/**
 * Open the process's one and only tunnel and return its non-null public URL.
 *
 * The returned url is what plan 03-02's reconciler registers with Linear.
 */
export async function openTunnel(
  port: number,
  ngrok: NgrokApi = ngrokSdk
): Promise<{ listener: Listener; url: string }> {
  // T25 — `authtoken_from_env: true` with the variable unset fails IDENTICALLY to a
  // revoked account (both ERR_NGROK_4018), so the SDK can never tell the operator
  // which one they are looking at. This pre-check is the only place TUN-03's
  // actionable message can come from, and it must run before any network call.
  if (!process.env.NGROK_AUTHTOKEN) {
    throw new TunnelError(`NGROK_AUTHTOKEN is not set. ${ENV_HINT}`);
  }

  let listener: Listener;
  try {
    // T10 — the SDK reads neither the bare environment variable nor the macOS agent
    // YAML on its own, so authtoken_from_env is mandatory, not a convenience.
    // D-01 — no domain key whatsoever; its absence is what makes the URL ephemeral.
    listener = await ngrok.connect({ addr: port, authtoken_from_env: true });
  } catch (e) {
    // T24 — the malformed-token failure ECHOES THE OPERATOR'S AUTHTOKEN inside its
    // own message. Any path that forwards, attaches or logs the caught object writes
    // a live credential to disk. Extract the code and drop everything else.
    // T25 — every ngrok error carries code "GenericFailure", so branching on the
    // error's code property is dead code. The message regex is the only working branch.
    const code = /ERR_NGROK_(\d+)/.exec(String((e as Error).message))?.[0] ?? 'unknown';
    throw new TunnelError(`ngrok tunnel failed to open (${code}). ${ENV_HINT}`);
  }

  // T19 — url() is typed `string | null`. Unchecked, the null flows into template
  // interpolation and 03-02 registers "null/linear/webhook": Linear accepts it as a
  // string and never delivers to it. The daemon then boots clean, logs healthy and
  // receives nothing — the worst failure shape in this project.
  const url = listener.url();
  if (!url) {
    await listener.close();
    throw new TunnelError(
      'ngrok returned a null tunnel URL; refusing to register an unreachable webhook.'
    );
  }

  // TUN-01 as a runtime assertion rather than a code-review claim.
  const all = await ngrok.listeners();
  if (all.length !== 1) {
    throw new TunnelError(`expected exactly 1 ngrok listener, found ${all.length}`);
  }

  return { listener, url };
}

/** Graceful close of a single tunnel. */
export function closeTunnel(listener: Listener): Promise<void> {
  return listener.close();
}

/**
 * There is deliberately NO `installTunnelShutdownHooks` here any more.
 *
 * It existed, exported, uncalled, with a comment saying "Phase 7 owns daemon lifecycle and
 * calls this once, explicitly". Phase 7 never did — and it was right not to. The function
 * registered `process.once('SIGINT'|'SIGTERM')` handlers that called `ngrok.kill()` and then
 * `process.exit(0)`. `daemon.ts` installs its own handlers for the same two signals and runs
 * an ordered shutdown: reap children, disable the webhook, close the tunnel, close the
 * server, mark in-flight runs, close the store. An immediate `process.exit(0)` racing that
 * would abandon the run marking, which is the single write that keeps a Ctrl-C from costing
 * a manual re-assignment of every live ticket (T18/T26).
 *
 * `ngrok.kill()` is also unnecessary: the tunnel is in-process by design, so its lifetime is
 * already bound to this process — that is the whole reason the SDK was chosen over the CLI.
 *
 * If you are about to add process-level cleanup here, add it to `daemon.ts`'s shutdown
 * instead, in order.
 */
