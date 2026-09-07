import * as z from 'zod';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Config, MappingToggles, RepoMapping } from '../domain/types.js';
import { resolveToggles } from '../domain/types.js';
import { ConfigError } from '../domain/errors.js';

/**
 * The zod schemas below spell the DOMAIN's field names, not this module's own. That is
 * load-bearing rather than tidy: `loadConfig` used to end in `result.data as Config`, and
 * that one cast collapsed a four-field name mismatch (`slackNotify`/`questionFlowEnabled`/
 * `maxRunTimeMs`, and mappings as an array rather than a record) into a single diagnostic.
 * `src/cli/wizard/config-writer.ts` writes the domain shape; this reads it. There is no
 * cast left here, so the next drift is a compile error instead of a runtime surprise.
 */

/** CONF-02's toggles. Used both as `Config.defaults` and, partial, as a mapping's sparse
 * overrides (D-09). */
export const TogglesSchema = z.object({
  postLinearComments: z.boolean(),
  notifySlack: z.boolean(),
  baseBranch: z.string().min(1).max(255),
  draftPr: z.boolean(),
  questionsEnabled: z.boolean(),
  maxRunMs: z
    .number()
    .int()
    .positive()
    .max(24 * 60 * 60 * 1000),
  questionTimeoutMs: z.number().int().positive(),
}) satisfies z.ZodType<MappingToggles>;

const RepoMappingSchema = z.object({
  repoDir: z.string().min(1),
  repoSlug: z.string().min(1),
  baseBranch: z.string().min(1),
  enabled: z.boolean(),
}) satisfies z.ZodType<RepoMapping>;

/** Phase 1 D-07: project keying with a team-level fallback — exactly one of
 * linearProjectId/linearTeamId is set, never both, never neither. */
const ProjectMappingSchema = z
  .object({
    linearProjectId: z.string().min(1).nullable(),
    linearTeamId: z.string().min(1).nullable(),
    // Both optional: an existing config.json predates them and must still load.
    ownerTeamId: z.string().min(1).optional(),
    displayName: z.string().min(1).optional(),
    repos: z.array(RepoMappingSchema).min(1),
    slackWebhookUrl: z.url().optional(),
    overrides: TogglesSchema.partial().optional(),
  })
  .refine((m) => Boolean(m.linearProjectId) !== Boolean(m.linearTeamId), {
    message: 'exactly one of linearProjectId or linearTeamId must be set',
    path: ['linearProjectId'],
  });

export const ConfigSchema = z.object({
  botUserId: z.string(),
  teamId: z.string(),
  /** Global cap on simultaneous spawned Claude sessions. Never per-mapping. */
  concurrency: z.number().int().positive(),
  maxQuestionRounds: z.number().int().nonnegative(),
  maxTurns: z.number().int().positive(),
  maxBudgetUsd: z.number().positive().optional(),
  operatorUserId: z.string().min(1).optional(),
  worktreeRoot: z.string().min(1),
  dbPath: z.string().min(1),
  defaults: TogglesSchema,
  /** Keyed by Linear project id first, then Linear team id (D-07). */
  mappings: z.record(z.string(), ProjectMappingSchema),
});

/** D-01/D-06: config, secrets, database, and logs all resolve under here.
 * Uses os.homedir(), never process.env.HOME (unset in some spawned-process
 * contexts). */
export function defaultRoot(): string {
  return path.join(os.homedir(), '.linear-auto-worker');
}

export function loadConfig(root: string = defaultRoot()): Config {
  const configPath = path.join(root, 'config.json');
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigError(`Invalid config at ${configPath}:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export interface ResolvedMapping extends MappingToggles {
  repos: RepoMapping[];
  slackWebhookUrl?: string;
}

/** Phase 1 D-07: an issue filed directly on a team with no project must not be silently
 * dropped — try the project key first, then fall back to the team key. */
export function resolveMapping(
  config: Config,
  issue: { projectId: string | null; teamId: string | null },
): ResolvedMapping | undefined {
  const match =
    (issue.projectId ? config.mappings[issue.projectId] : undefined) ??
    (issue.teamId ? config.mappings[issue.teamId] : undefined);
  if (!match) return undefined;

  return {
    ...resolveToggles(config.defaults, match),
    repos: match.repos,
    ...(match.slackWebhookUrl === undefined ? {} : { slackWebhookUrl: match.slackWebhookUrl }),
  };
}

/**
 * The team `webhookCreate` is registered against.
 *
 * Lives here, beside `resolveMapping`, because it is derived from `Config` and nothing
 * else — `law start` and `law setup` both need it, and the wizard must not have to pull in
 * the daemon's whole module graph to ask a question about a config file.
 *
 * Resolved up front rather than inside the registrar so the failure is one actionable line
 * before any network call instead of a GraphQL validation error from inside reconciliation.
 */
export function webhookTeamId(config: Config): string {
  const teamId =
    config.teamId ||
    Object.values(config.mappings)
      // `ownerTeamId` is the repair: the operator's live config has a PROJECT-keyed
      // mapping, so `linearTeamId` is null on every entry and this threw before the
      // daemon could register anything. Every project-keyed mapping already records the
      // team it belongs to, so the value was on disk the whole time — a config written
      // by an older wizard heals here without a setup re-run.
      .map((m) => m.linearTeamId ?? m.ownerTeamId ?? null)
      .find((t): t is string => Boolean(t));
  if (!teamId) {
    throw new Error(
      'no Linear team is configured. Linear requires a team on webhook creation. ' +
        'Set `teamId`, or give at least one mapping a `linearTeamId`, in config.json.',
    );
  }
  return teamId;
}

export interface Secrets {
  linearApiKey: string;
  ngrokAuthtoken: string;
}

/** D-01/Phase 1 D-08: the two secrets live in a sibling .env, mode 0600,
 * never inside config.json. */
export function loadSecrets(root: string = defaultRoot()): Secrets {
  const envPath = path.join(root, '.env');
  const stat = fs.statSync(envPath);
  const mode = stat.mode & 0o777;
  if (mode !== 0o600) {
    throw new ConfigError(
      `${envPath} must be mode 0600, found ${mode.toString(8).padStart(3, '0')}`
    );
  }

  const content = fs.readFileSync(envPath, 'utf8');
  const values: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    values[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }

  const linearApiKey = values.LINEAR_API_KEY;
  const ngrokAuthtoken = values.NGROK_AUTHTOKEN;
  if (!linearApiKey) throw new ConfigError(`${envPath} is missing LINEAR_API_KEY`);
  if (!ngrokAuthtoken) throw new ConfigError(`${envPath} is missing NGROK_AUTHTOKEN`);

  return { linearApiKey, ngrokAuthtoken };
}
