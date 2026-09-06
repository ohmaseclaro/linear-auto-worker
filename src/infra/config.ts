import * as z from 'zod';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Config } from '../domain/types.js';
// ConfigError does not exist on this branch yet (src/domain/ is Phase 1's, being
// written in parallel). If this export is missing at integration time, see
// `Contract additions requested` in 02-01-SUMMARY.md for the exact signature assumed.
import { ConfigError } from '../domain/errors.js';

/** CONF-02's six toggles. Used both as Config.defaults and, partial, as a
 * mapping's sparse overrides (D-09). */
export const TogglesSchema = z.object({
  postLinearComments: z.boolean(),
  slackNotify: z.boolean(),
  baseBranch: z.string().min(1).max(255),
  draftPr: z.boolean(),
  questionFlowEnabled: z.boolean(),
  maxRunTimeMs: z
    .number()
    .int()
    .positive()
    .max(24 * 60 * 60 * 1000),
});

export type Toggles = z.infer<typeof TogglesSchema>;

const RepoMappingEntrySchema = z.object({
  repoDir: z.string().min(1),
  repoSlug: z.string().min(1),
});

/** Phase 1 D-07: project keying with a team-level fallback — exactly one of
 * linearProjectId/linearTeamId, never both, never neither. */
const MappingSchema = z
  .object({
    linearProjectId: z.string().min(1).optional(),
    linearTeamId: z.string().min(1).optional(),
    repos: z.array(RepoMappingEntrySchema).min(1),
    slackWebhookUrl: z.url().optional(),
    overrides: TogglesSchema.partial().optional(),
  })
  .refine((mapping) => Boolean(mapping.linearProjectId) !== Boolean(mapping.linearTeamId), {
    message: 'exactly one of linearProjectId or linearTeamId must be set',
    path: ['linearProjectId'],
  });

export type Mapping = z.infer<typeof MappingSchema>;

export const ConfigSchema = z.object({
  defaults: TogglesSchema,
  mappings: z.array(MappingSchema),
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
  return result.data as Config;
}

export interface ResolvedMapping extends Toggles {
  repos: { repoDir: string; repoSlug: string }[];
  slackWebhookUrl?: string;
}

/** Phase 1 D-07: an issue filed directly on a team with no project must not
 * be silently dropped — try a project match first, then fall back to team. */
export function resolveMapping(
  config: Config,
  issue: { projectId: string | null; teamId: string }
): ResolvedMapping | undefined {
  const mappings = (config as unknown as { mappings: Mapping[] }).mappings;
  const defaults = (config as unknown as { defaults: Toggles }).defaults;

  const match =
    (issue.projectId ? mappings.find((m) => m.linearProjectId === issue.projectId) : undefined) ??
    mappings.find((m) => m.linearTeamId === issue.teamId);

  if (!match) return undefined;

  return {
    ...defaults,
    ...(match.overrides ?? {}),
    repos: match.repos,
    slackWebhookUrl: match.slackWebhookUrl,
  };
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
