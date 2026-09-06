/**
 * Setup-wizard secret acquisition.
 *
 * The ONLY two secrets this project ever prompts for (D-05): `LINEAR_API_KEY` and
 * `NGROK_AUTHTOKEN`. Everything else is detected or generated elsewhere. Both are skipped
 * when already present (D-04/SETUP-04), and neither is ever written to a log, an error
 * message, or a terminal transcript — only `maskSecret()` output may be printed.
 */
import { password } from '@inquirer/prompts';
import { LinearClient } from '@linear/sdk';

/** Uniform outcome for both secret acquisitions: either a value, or an operator-actionable fix. */
export type SecretResult<T> = { ok: true; value: T } | { ok: false; fix: string };

const LINEAR_KEY_FIX =
  'Get a Linear personal API key from Settings → API → Personal API keys and re-run setup';

const LINEAR_ADMIN_FIX =
  'This Linear account is not a workspace admin, which webhookCreate requires. ' +
  'Ask a workspace admin to promote this account in Settings → Members, ' +
  'or generate a key from an admin account, then re-run setup';

/**
 * The only safe way to reference a secret in operator-facing output.
 * Never interpolate a raw key or token into a message, a log line, or an Error.
 */
export function maskSecret(secret: string): string {
  return secret.length <= 6 ? '…' : `${secret.slice(0, 6)}…`;
}

/**
 * The two `LinearClient` members the wizard needs, as a seam the tests can drive
 * without a network call. Note `viewer` is a GETTER on the real client
 * (`await client.viewer`) while `webhooks` is a method — the adapter below hides that.
 */
export interface LinearProbe {
  viewer(): Promise<unknown>;
  webhooks(vars: { first: number }): Promise<unknown>;
}

export interface LinearKeyDeps {
  prompt?: () => Promise<string>;
  makeClient?: (apiKey: string) => LinearClient;
  probe?: (client: LinearClient) => LinearProbe;
}

/** @linear/sdk v93: `viewer` is a getter returning a LinearFetch, NOT a callable method. */
function probeFromClient(client: LinearClient): LinearProbe {
  return {
    viewer: () => Promise.resolve(client.viewer),
    webhooks: (vars) => Promise.resolve(client.webhooks(vars)),
  };
}

/** `LinearClient` sets the personal-key auth header itself — no `Bearer` prefix (T9). */
function defaultMakeClient(apiKey: string): LinearClient {
  return new LinearClient({ apiKey });
}

const promptLinearKey = (): Promise<string> =>
  password({ message: 'Linear personal API key (Settings → API):', mask: true });

export type LinearKeySource = 'existing' | 'process-env' | 'prompted';

/**
 * Obtain a Linear API key that is both valid AND workspace-admin.
 *
 * A present key is never re-prompted, but IS re-validated: a key revoked or demoted since
 * the last wizard run must fail here rather than at first webhook registration (D-04).
 *
 * `source === 'existing'` means the value already sits in `.env` and must NOT be passed to
 * `writeSecretsEnv`; every other source must be, or the daemon process never sees it.
 */
export async function acquireLinearKey(
  existingEnv: Record<string, string>,
  deps: LinearKeyDeps = {},
): Promise<SecretResult<{ key: string; source: LinearKeySource; linearClient: LinearClient }>> {
  const fromEnvFile = existingEnv.LINEAR_API_KEY?.trim();
  const fromProcess = process.env.LINEAR_API_KEY?.trim();

  let key = fromEnvFile || fromProcess || '';
  const source: LinearKeySource = fromEnvFile ? 'existing' : fromProcess ? 'process-env' : 'prompted';

  if (!key) {
    key = (await (deps.prompt ?? promptLinearKey)()).trim();
    if (!key) return { ok: false, fix: LINEAR_KEY_FIX };
  }

  const linearClient = (deps.makeClient ?? defaultMakeClient)(key);
  const probe = (deps.probe ?? probeFromClient)(linearClient);

  try {
    await probe.viewer();
  } catch {
    // The raw SDK error is deliberately dropped: it is unactionable, and a GraphQL error
    // body can carry request detail into a transcript the operator may paste elsewhere.
    return { ok: false, fix: LINEAR_KEY_FIX };
  }

  try {
    // The admin probe: `createWebhook` requires workspace admin and a Member key fails
    // nowhere earlier (D-06). T23 — the result carries every webhook's signing secret,
    // so it is discarded here and MUST never be logged.
    await probe.webhooks({ first: 1 });
  } catch {
    return { ok: false, fix: LINEAR_ADMIN_FIX };
  }

  return { ok: true, value: { key, source, linearClient } };
}
