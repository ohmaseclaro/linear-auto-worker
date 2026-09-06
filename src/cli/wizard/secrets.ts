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
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

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

// ---------------------------------------------------------------------------
// ngrok authtoken
// ---------------------------------------------------------------------------

const NGROK_TOKEN_FIX =
  'An ngrok authtoken is required. Copy it from https://dashboard.ngrok.com/get-started/your-authtoken ' +
  '(or run `ngrok config add-authtoken <token>` first) and re-run setup';

/**
 * Where the ngrok CLI keeps its config. The XDG path is the documented one; ngrok v3 on
 * macOS actually writes to Application Support, so both are checked in order.
 * The SDK reads NEITHER (T10) — whatever is found here must be copied into `.env`.
 */
export const NGROK_YAML_PATHS: readonly string[] = [
  join(homedir(), '.config', 'ngrok', 'ngrok.yml'),
  join(homedir(), 'Library', 'Application Support', 'ngrok', 'ngrok.yml'),
];

export interface NgrokTokenDeps {
  prompt?: () => Promise<string>;
  yamlPaths?: readonly string[];
}

const promptNgrokToken = (): Promise<string> =>
  password({ message: 'ngrok authtoken (dashboard.ngrok.com → Your Authtoken):', mask: true });

/**
 * Pull `authtoken:` out of an ngrok config file.
 *
 * ponytail: a regex, not a YAML parser — the key sits on its own line whether it is at the
 * top level or nested under `agent:`, and one scalar does not justify a new dependency.
 */
async function readAuthtokenFromYaml(path: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    // Best effort: a missing OR malformed config is simply "not found". The error is
    // swallowed rather than logged — this file's contents are themselves a secret.
    return null;
  }
  const match = /^[ \t]*authtoken:[ \t]*(\S+)/m.exec(raw);
  if (!match) return null;
  const [, captured = ''] = match;
  const token = captured.replace(/^["']|["']$/g, '').trim();
  return token || null;
}

/**
 * Obtain the ngrok authtoken, bothering the operator only as a last resort.
 *
 * As with the Linear key, `source === 'existing'` means the value is already in `.env`
 * and must not be handed to `writeSecretsEnv`; `'yaml'` and `'prompted'` must be.
 */
export async function acquireNgrokToken(
  existingEnv: Record<string, string>,
  deps: NgrokTokenDeps = {},
): Promise<SecretResult<{ token: string; source: 'existing' | 'yaml' | 'prompted' }>> {
  const existing = existingEnv.NGROK_AUTHTOKEN?.trim();
  if (existing) return { ok: true, value: { token: existing, source: 'existing' } };

  for (const path of deps.yamlPaths ?? NGROK_YAML_PATHS) {
    const token = await readAuthtokenFromYaml(path);
    if (token) return { ok: true, value: { token, source: 'yaml' } };
  }

  const typed = (await (deps.prompt ?? promptNgrokToken)()).trim();
  // Fail here, where the fix can be named. An empty or whitespace token reaches the tunnel
  // as `code: "GenericFailure"` — indistinguishable from having no credential at all (T25).
  if (!typed) return { ok: false, fix: NGROK_TOKEN_FIX };
  return { ok: true, value: { token: typed, source: 'prompted' } };
}

// ---------------------------------------------------------------------------
// .env persistence
// ---------------------------------------------------------------------------

const ENV_LINE = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*(.*)$/;

/** Parse an existing `.env` into the `existingEnv` both acquire functions take. Missing file → `{}`. */
export async function readSecretsEnv(envPath: string): Promise<Record<string, string>> {
  let raw: string;
  try {
    raw = await readFile(envPath, 'utf8');
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const [, name, value = ''] = ENV_LINE.exec(line) ?? [];
    if (name) out[name] = value.trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

/**
 * Merge the newly-obtained secrets into `.env` and leave it at mode 0600.
 *
 * Pass only secrets whose `source` was NOT `'existing'`. Unrelated lines a later phase may
 * have added are preserved; keys omitted from `secrets` are left exactly as they are.
 */
export async function writeSecretsEnv(
  envPath: string,
  secrets: { LINEAR_API_KEY?: string; NGROK_AUTHTOKEN?: string },
): Promise<void> {
  let existing = '';
  try {
    existing = await readFile(envPath, 'utf8');
  } catch {
    // New file.
  }
  const lines = existing ? existing.split('\n') : [];

  for (const [key, value] of Object.entries(secrets)) {
    if (value === undefined) continue;
    // ponytail: no quoting — Linear keys and ngrok tokens are `[A-Za-z0-9_]` only.
    const line = `${key}=${value}`;
    const at = lines.findIndex((l) => ENV_LINE.exec(l)?.[1] === key);
    if (at >= 0) lines[at] = line;
    else lines.push(line);
  }
  while (lines.at(-1)?.trim() === '') lines.pop();

  await mkdir(dirname(envPath), { recursive: true });
  await writeFile(envPath, `${lines.join('\n')}\n`, { mode: 0o600 });
  // Unconditional: `mode` above applies only when the file is CREATED, so a `.env` that
  // already existed at 0644 would otherwise stay world-readable after a merge.
  await chmod(envPath, 0o600);
}
