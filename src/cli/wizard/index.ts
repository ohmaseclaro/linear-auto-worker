/**
 * The setup wizard orchestrator: one command takes a fresh machine to a working,
 * webhook-registered daemon.
 *
 * Step order is fixed by 08-CONTEXT ("registration last"), and the last step is what makes
 * this a wizard rather than a config generator — `law setup` ends with a webhook already
 * registered, not with a file the operator still has to act on (SETUP-09).
 *
 * Two conventions hold across every step, and neither is negotiable (D-08):
 *  - nothing here ever prints a stack trace. Every failure is a named, actionable fix.
 *  - a WARNING never halts, a hard failure always does. Preflight `fail`, a missing secret
 *    and a failed registration halt; repo-safety warnings are printed and the wizard
 *    continues, because a repo with no branch protection is still a usable mapping.
 */
import { input } from '@inquirer/prompts';
import { readFile } from 'node:fs/promises';

import {
  CONFIG_PATH,
  ENV_PATH,
  type Config,
  type TunnelManager,
  type WebhookRegistrar,
} from '../../domain/index.js';
import { LinearClientImpl } from '../../outbound/linear-client.js';
import { assembleConfig, toWizardMappings, writeConfig } from './config-writer.js';
import { buildMappings } from './mapping.js';
import { runPreflight, type PreflightResult } from './preflight.js';
import { discoverRepos } from './repo-discovery.js';
import { annotateRepoSafety, type SafetyWarning } from './repo-safety.js';
import { doctorWebhooks, reconcileWebhook } from './register.js';
import { acquireLinearKey, acquireNgrokToken, readSecretsEnv, writeSecretsEnv } from './secrets.js';

const STATUS_PREFIX: Record<PreflightResult['status'], string> = {
  pass: '✓',
  warn: '⚠',
  fail: '✗',
};

function printResult(result: PreflightResult): void {
  console.log(`${STATUS_PREFIX[result.status]} ${result.name}: ${result.detail}`);
  if (result.fix) console.log(`  fix: ${result.fix}`);
}

/** The one shape a halting failure takes: a name, and the exact thing to do about it. */
function fail(name: string, fix: string): number {
  console.log(`✗ ${name}`);
  console.log(`  fix: ${fix}`);
  return 1;
}

function printWarning(warning: SafetyWarning): void {
  console.log(`⚠ ${warning.kind}: ${warning.message}`);
}

/**
 * Phase 7's composition root owns the real ngrok tunnel and the real Linear-backed
 * registrar; this module only ever sees the ports. Supplying them is what turns the last
 * step from a no-op into the registration SETUP-09 is about.
 */
export interface WizardDeps {
  tunnel?: TunnelManager;
  registrar?: WebhookRegistrar;
  /** Local port the webhook receiver listens on. */
  port?: number;
  configPath?: string;
  envPath?: string;
  /** Test seam for the one path the operator IS allowed to type (D-02). */
  promptRoot?: () => Promise<string>;
}

const REGISTRATION_NOT_WIRED_FIX =
  'Webhook registration needs a live tunnel and registrar, which the daemon composition ' +
  'root (Phase 7) passes into runSetupWizard({ tunnel, registrar, port }). Until that is ' +
  'merged, config.json is written but no webhook is registered — see 08-HUMAN-UAT.md';

/** A missing or unreadable config.json is simply "first run". A corrupt one is handled by
 *  `assembleConfig`'s field-by-field guards (T-08-19), not by trusting the parse. */
async function readExistingConfig(configPath: string): Promise<Config | undefined> {
  try {
    return JSON.parse(await readFile(configPath, 'utf8')) as Config;
  } catch {
    return undefined;
  }
}

/**
 * D-02: the repo-discovery root is the ONE path the operator is allowed to type, because
 * it is the only one that cannot be discovered. Every path after this is picked from a
 * list — a typed repo path becomes a mapping that fails at first run rather than at setup.
 */
const promptRootDir = (): Promise<string> =>
  input({ message: 'Directory to scan for repos (depth 2):' });

export async function runSetupWizard(deps: WizardDeps = {}): Promise<number> {
  const configPath = deps.configPath ?? CONFIG_PATH;
  const envPath = deps.envPath ?? ENV_PATH;

  // ── 1. Preflight (D-08) ────────────────────────────────────────────────────
  const preflight = await runPreflight();
  for (const result of preflight) printResult(result);
  if (preflight.some((r) => r.status === 'fail')) {
    return fail('Preflight', 'fix the failing checks above and re-run `law setup`');
  }

  // ── 2. Secrets (D-04/D-05) ─────────────────────────────────────────────────
  // One read, shared by both acquisitions: each skips a secret already present.
  const existingEnv = await readSecretsEnv(envPath);

  const linear = await acquireLinearKey(existingEnv);
  if (!linear.ok) return fail('Linear API key', linear.fix);

  const ngrok = await acquireNgrokToken(existingEnv);
  if (!ngrok.ok) return fail('ngrok authtoken', ngrok.fix);

  // Only secrets that are NOT already in `.env` are written back. Passing an 'existing'
  // value is harmless, but OMITTING a 'process-env' / 'yaml' / 'prompted' one is not —
  // the daemon would boot without it (08-02's SUMMARY).
  await writeSecretsEnv(envPath, {
    ...(linear.value.source === 'existing' ? {} : { LINEAR_API_KEY: linear.value.key }),
    ...(ngrok.value.source === 'existing' ? {} : { NGROK_AUTHTOKEN: ngrok.value.token }),
  });
  console.log('✓ Secrets: stored in ~/.linear-auto-worker/.env (mode 0600)');

  // ── 3. Repo discovery (D-02) ───────────────────────────────────────────────
  const rootDir = (await (deps.promptRoot ?? promptRootDir)()).trim();
  const discovered = await discoverRepos(rootDir);
  if (discovered.length === 0) {
    return fail(
      'Repo discovery',
      `no git repositories found under "${rootDir}" (scanned to depth 2) — re-run and name a directory that contains your repos`,
    );
  }
  console.log(`✓ Repo discovery: found ${discovered.length} repo(s) under ${rootDir}`);

  // ── 4. Mapping (D-04/D-07) ─────────────────────────────────────────────────
  const existingConfig = await readExistingConfig(configPath);
  const mappings = await buildMappings(
    linear.value.linearClient,
    discovered,
    toWizardMappings(existingConfig),
  );

  // ── 5. Repo safety (D-03/D-07/D-09) — warnings never halt ──────────────────
  const safety = await annotateRepoSafety(mappings);
  for (const warning of safety.warnings) printWarning(warning);
  console.log(
    `✓ Repo safety: ${safety.mappings.length} mapping(s) checked, ${safety.warnings.length} warning(s)`,
  );

  // ── 6. Assemble + write config (D-04/D-06/D-08) ────────────────────────────
  let botUserId = existingConfig?.botUserId ?? '';
  try {
    botUserId = (await linear.value.linearClient.viewer).id;
  } catch {
    // Non-fatal: the key already passed a live viewer probe in step 2, so a failure here is
    // transient. An existing botUserId is kept rather than blanked.
  }
  // Best-effort: only a team-keyed mapping carries a team id (a project-keyed one does not
  // record its team — see "Contract additions requested").
  const teamId =
    mappings.find((m) => m.key.kind === 'team')?.key.id ?? existingConfig?.teamId ?? '';

  const config = assembleConfig({
    mappings: safety.mappings,
    botUserId,
    teamId,
    existing: existingConfig,
  });
  await writeConfig(configPath, config);
  console.log(`✓ Config: written to ${configPath}`);

  // ── 7. Register the webhook — the step that makes setup mean something ──────
  if (!deps.tunnel || !deps.registrar) {
    return fail('Webhook registration', REGISTRATION_NOT_WIRED_FIX);
  }

  const registration = await reconcileWebhook(deps.tunnel, deps.registrar, deps.port ?? 0);
  if (!registration.ok) return fail('Webhook registration', registration.fix);

  // T-08-17: the signing secret is persisted by the registrar and confirmed here, never
  // printed. The URL is not a secret; the secret that signs its payloads is.
  console.log(`✓ Webhook registered at ${registration.publicUrl} (signing secret persisted)`);
  console.log('');
  console.log('setup complete — webhook registered, run `law start` to begin');
  return 0;
}

/**
 * `law setup --doctor`: inspect the workspace's webhooks instead of running the full flow.
 *
 * This is the one destructive path in the phase, so it runs nothing else — no prompts for
 * secrets, no mapping, no config write. It needs only the Linear key already in `.env`.
 */
export async function runDoctor(deps: { envPath?: string } = {}): Promise<number> {
  const envPath = deps.envPath ?? ENV_PATH;
  const env = await readSecretsEnv(envPath);
  const apiKey = env.LINEAR_API_KEY?.trim();
  if (!apiKey) {
    return fail(
      'Linear API key',
      `no LINEAR_API_KEY found in ${envPath} — run \`law setup\` first`,
    );
  }

  const findings = await doctorWebhooks(new LinearClientImpl({ apiKey }));
  console.log(`✓ Doctor: ${findings.length} webhook(s) inspected`);
  return 0;
}
