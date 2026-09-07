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

import { CONFIG_PATH, ENV_PATH, type Config } from '../../domain/index.js';
import { LinearClientImpl } from '../../outbound/linear-client.js';
import type { LinearClient } from '@linear/sdk';
import { assembleConfig, toWizardMappings, writeConfig } from './config-writer.js';
import { buildMappings } from './mapping.js';
import { runPreflight, type PreflightResult } from './preflight.js';
import { chooseOperator } from './operator.js';
import { defaultRunCommand, realPrompts, type RunCommand, type WizardPrompts } from './deps.js';
import { discoverRepos } from './repo-discovery.js';
import { annotateRepoSafety, type SafetyWarning } from './repo-safety.js';
import { doctorWebhooks, registerAtSetup } from './register.js';
import { acquireLinearKey, acquireNgrokToken, readSecretsEnv, writeSecretsEnv } from './secrets.js';

const STATUS_PREFIX: Record<PreflightResult['status'], string> = {
  pass: '✓',
  warn: '⚠',
  fail: '✗',
};

/**
 * Where this module's operator-facing lines go.
 *
 * Same seam and same reason as `mapping.ts` and `repo-safety.ts`: since `runSetupWizard`
 * became test-reachable, a bare `console.log` here leaks into `node --test`'s worker
 * channel, desynchronises the parent-side V8 frame parser, and surfaces as "Unable to
 * deserialize cloned data" with no failing assertion to point at. The default is still the
 * terminal — in production that IS the interface.
 */
type Report = (message: string) => void;

const consoleReport: Report = (message) => console.log(message);

function printResult(result: PreflightResult, report: Report): void {
  report(`${STATUS_PREFIX[result.status]} ${result.name}: ${result.detail}`);
  if (result.fix) report(`  fix: ${result.fix}`);
}

/** The one shape a halting failure takes: a name, and the exact thing to do about it. */
function fail(name: string, fix: string, report: Report): number {
  report(`✗ ${name}`);
  report(`  fix: ${fix}`);
  return 1;
}

function printWarning(warning: SafetyWarning, report: Report): void {
  report(`⚠ ${warning.kind}: ${warning.message}`);
}

/**
 * Every seam this wizard threads, each defaulted at its call site to the real thing.
 *
 * `runSetupWizard()` with no arguments is the correct production call and always was —
 * `src/cli/index.ts` never needed changing. What was wrong was the callee: it had an
 * unreachable "registration not wired" branch guarded by two optional dependencies that
 * had no defaults, so `law setup` could not complete on any machine. The registrar and the
 * tunnel are now composed by `registerAtSetup` itself.
 *
 * Everything below exists so ONE test can walk the whole wizard. Nothing here is mocked at
 * the module level: an ESM namespace binding is non-configurable by specification, so
 * `mock.method` on one cannot work (T88). Default parameters only.
 */
export interface WizardDeps {
  configPath?: string;
  envPath?: string;
  /** Test seam for the one path the operator IS allowed to type (D-02). */
  promptRoot?: () => Promise<string>;
  /** One seam for all six preflight checks, including the two that take no `run`. */
  preflight?: typeof runPreflight;
  prompts?: WizardPrompts;
  runCommand?: RunCommand;
  makeLinearClient?: (apiKey: string) => LinearClient;
  report?: Report;
  register?: typeof registerAtSetup;
}

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
  const report = deps.report ?? consoleReport;
  const prompts = deps.prompts ?? realPrompts;
  const run = deps.runCommand ?? defaultRunCommand;

  // ── 1. Preflight (D-08) ────────────────────────────────────────────────────
  const preflight = await (deps.preflight ?? runPreflight)(run);
  for (const result of preflight) printResult(result, report);
  if (preflight.some((r) => r.status === 'fail')) {
    return fail('Preflight', 'fix the failing checks above and re-run `law setup`', report);
  }

  // ── 2. Secrets (D-04/D-05) ─────────────────────────────────────────────────
  // One read, shared by both acquisitions: each skips a secret already present.
  const existingEnv = await readSecretsEnv(envPath);

  const linear = await acquireLinearKey(existingEnv, {
    ...(deps.makeLinearClient ? { makeClient: deps.makeLinearClient } : {}),
  });
  if (!linear.ok) return fail('Linear API key', linear.fix, report);

  const ngrok = await acquireNgrokToken(existingEnv);
  if (!ngrok.ok) return fail('ngrok authtoken', ngrok.fix, report);

  // Only secrets that are NOT already in `.env` are written back. Passing an 'existing'
  // value is harmless, but OMITTING a 'process-env' / 'yaml' / 'prompted' one is not —
  // the daemon would boot without it (08-02's SUMMARY).
  await writeSecretsEnv(envPath, {
    ...(linear.value.source === 'existing' ? {} : { LINEAR_API_KEY: linear.value.key }),
    ...(ngrok.value.source === 'existing' ? {} : { NGROK_AUTHTOKEN: ngrok.value.token }),
  });
  report('✓ Secrets: stored in ~/.linear-auto-worker/.env (mode 0600)');

  // ── 3. Repo discovery (D-02) ───────────────────────────────────────────────
  const rootDir = (await (deps.promptRoot ?? promptRootDir)()).trim();
  const discovered = await discoverRepos(rootDir);
  if (discovered.length === 0) {
    return fail(
      'Repo discovery',
      `no git repositories found under "${rootDir}" (scanned to depth 2) — re-run and name a directory that contains your repos`,
      report,
    );
  }
  report(`✓ Repo discovery: found ${discovered.length} repo(s) under ${rootDir}`);

  // ── 4. Mapping (D-04/D-07) ─────────────────────────────────────────────────
  const existingConfig = await readExistingConfig(configPath);
  const mappings = await buildMappings(
    linear.value.linearClient,
    discovered,
    toWizardMappings(existingConfig),
    prompts,
    report,
  );

  // A mapping with no repos is not a usable setup, and it is not a writable config either:
  // `ConfigSchema` requires `repos` to be non-empty, so the wizard would write a file its
  // own loader then rejects. Halt HERE, before `writeConfig`, not after.
  if (mappings.length === 0) {
    return fail(
      'Mapping',
      'no mapping has any repos — re-run `law setup` and select at least one repo for a mapping',
      report,
    );
  }

  // ── 5. Repo safety (D-03/D-07/D-09) — warnings never halt ──────────────────
  const safety = await annotateRepoSafety(mappings, { run, prompts, report });
  for (const warning of safety.warnings) printWarning(warning, report);
  report(
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

  // ── 6a. Who the operator is (INTK-03) ──────────────────────────────────────
  // Asked, never inferred: the key authenticates as the BOT, so `viewer()` above returned
  // the bot rather than the human. Skippable, and a workspace whose key cannot list users
  // simply keeps whatever was already configured.
  const operatorUserId = await chooseOperator(linear.value.linearClient, {
    prompts,
    botUserId,
    ...(existingConfig?.operatorUserId ? { existing: existingConfig.operatorUserId } : {}),
  });
  report(
    operatorUserId
      ? `✓ Operator: you will be subscribed to each ticket the bot picks up`
      : `✓ Operator: not subscribing — assignment to the bot will take tickets out of your view`,
  );

  const config = assembleConfig({
    mappings: safety.mappings,
    botUserId,
    teamId,
    ...(operatorUserId ? { operatorUserId } : {}),
    existing: existingConfig,
  });
  // `writeConfig` validates against `loadConfig`'s own schema and refuses rather than
  // writing a file the daemon will reject at boot. Surfaced as a named fix, never a stack.
  try {
    await writeConfig(configPath, config);
  } catch (err) {
    return fail(
      'Config',
      `the assembled config is not valid and was NOT written: ${
        err instanceof Error ? err.message : String(err)
      }`,
      report,
    );
  }
  report(`✓ Config: written to ${configPath} (mode 0600)`);

  // ── 7. Register the webhook — the step that makes setup mean something ──────
  // Called UNCONDITIONALLY. It registers rather than merely validating, because
  // `webhookCreate` is the workspace-admin-gated call and opening a tunnel is the only
  // proof the ngrok authtoken is live: a listing that succeeds proves neither.
  const registration = await (deps.register ?? registerAtSetup)({
    config,
    linearApiKey: linear.value.key,
    ngrokAuthtoken: ngrok.value.token,
  });
  if (!registration.ok) return fail('Webhook registration', registration.fix, report);

  // T-08-17: the signing secret is persisted by the registrar and confirmed here, never
  // printed. The URL is not a secret; the secret that signs its payloads is.
  report(`✓ Webhook registered at ${registration.publicUrl} (signing secret persisted)`);
  report('');
  // Say exactly what was proved and exactly what was not. The registration is real and
  // permanent; the URL behind it dies with this command. Claiming more here is half the
  // defect this fix exists to close.
  report('  this proves your ngrok authtoken works and your Linear key is a workspace admin.');
  report('  the tunnel closes when this command exits, so that URL is already dead —');
  report('  `law start` opens a fresh tunnel and re-points this same registration at it.');
  report(
    '  if a daemon is ALREADY RUNNING, restart it now (Ctrl-C, then `law start`): setup just ' +
      're-pointed its webhook at a tunnel that no longer exists, and it only reconciles at ' +
      'boot — until you restart it, it will receive nothing.',
  );
  report('');
  report('setup complete — webhook registered, run `law start` to begin');
  return 0;
}

/**
 * `law setup --doctor`: inspect the workspace's webhooks instead of running the full flow.
 *
 * This is the one destructive path in the phase, so it runs nothing else — no prompts for
 * secrets, no mapping, no config write. It needs only the Linear key already in `.env`.
 */
export async function runDoctor(deps: { envPath?: string; report?: Report } = {}): Promise<number> {
  const envPath = deps.envPath ?? ENV_PATH;
  const report = deps.report ?? consoleReport;
  const env = await readSecretsEnv(envPath);
  const apiKey = env.LINEAR_API_KEY?.trim();
  if (!apiKey) {
    return fail(
      'Linear API key',
      `no LINEAR_API_KEY found in ${envPath} — run \`law setup\` first`,
      report,
    );
  }

  const findings = await doctorWebhooks(new LinearClientImpl({ apiKey }), { log: report });
  report(`✓ Doctor: ${findings.length} webhook(s) inspected`);
  return 0;
}
