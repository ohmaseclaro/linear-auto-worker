/**
 * Config assembly and idempotent write (SETUP-09, D-04).
 *
 * This is the one place the wizard's three data-producing steps converge: 08-03's
 * `Mapping[]`, 08-04's per-repo `RepoSafetyInfo`, and the six CONF-02 toggle defaults,
 * assembled into the canonical `Config` that `~/.linear-auto-worker/config.json` holds and
 * four other layers read.
 *
 * Two rules this module exists to enforce:
 *  - **D-04, idempotency.** A second run MERGES. A mapping the operator did not touch this
 *    run comes back byte-identical; a default the operator did not change keeps its value.
 *    Re-running the wizard to add one mapping must never silently drop the others.
 *  - **T-08-19, the existing file is untrusted input.** A hand-edited or corrupt
 *    `config.json` is read field by field through type guards; anything unrecognised or
 *    wrongly-typed falls back to the default rather than propagating garbage forward.
 *
 * Neither PROMPTED secret reaches this file (D-08): `LINEAR_API_KEY` and `NGROK_AUTHTOKEN`
 * live in the mode-0600 `.env` beside it, and the webhook signing secret lives in SQLite.
 * The file is still mode 0600 and is NOT safe to paste — a mapping's `slackWebhookUrl` is a
 * bearer credential, and anyone holding it can post to that channel.
 */
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import * as z from 'zod';

import {
  CONFIG_ROOT,
  DB_PATH,
  type Config,
  type MappingToggles,
  type ProjectMapping,
  type RepoMapping,
} from '../../domain/index.js';
import { ConfigError } from '../../domain/errors.js';
import { ConfigSchema } from '../../infra/config.js';
import type { Mapping, ToggleName, ToggleOverrides } from './mapping.js';
import type { EnrichedMapping, RepoSafetyInfo } from './repo-safety.js';

/**
 * The six CONF-02 toggles, at their shipped defaults.
 *
 * Named against `src/domain/types.ts`'s canonical `MappingToggles`, NOT against the
 * wizard-local names 08-03 used, and not against the names 08-05's own plan text used —
 * the domain contract wins over both (see this plan's SUMMARY, "Deviations from Plan").
 *
 * `maxRunMs` is 45 minutes per Pitfall 5c's 45-60 minute guidance: long enough for a real
 * GSD run, short enough that a wedged agent does not hold a concurrency slot all afternoon.
 * `questionTimeoutMs` is 30 minutes — a parked run holds no slot (see `HOLDS_SLOT`), so the
 * only cost of waiting is latency, and answering with the agent's own stated assumption is
 * strictly worse than an operator's real answer.
 */
export const DEFAULT_TOGGLES: MappingToggles = {
  postLinearComments: true,
  updateLinearIssue: true,
  notifySlack: false,
  baseBranch: 'main',
  draftPr: true,
  questionsEnabled: true,
  maxRunMs: 45 * 60 * 1000,
  questionTimeoutMs: 30 * 60 * 1000,
};

/** Global cap on simultaneous spawned Claude sessions — RAM-bound, never per-mapping. */
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_MAX_QUESTION_ROUNDS = 3;
const DEFAULT_MAX_TURNS = 200;

/** Derived from CONFIG_ROOT rather than re-deriving the root itself (T40). */
const DEFAULT_WORKTREE_ROOT = `${CONFIG_ROOT}/worktrees`;

// ---------------------------------------------------------------------------
// Untrusted-existing-file guards (T-08-19)
// ---------------------------------------------------------------------------

function pickString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value : fallback;
}

function pickNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function pickBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Merge an existing `defaults` block over the shipped defaults, one recognised field at a
 * time. A field that is missing, misspelled, or of the wrong type reverts to the shipped
 * default instead of reaching the four layers that read it (T-08-19).
 *
 * **A field this function does not NAME is a field a `law setup` re-run DELETES.** That is
 * deliberate for garbage and catastrophic for a real toggle: for the operator's second,
 * silent instance it would mean a re-run turning a quiet daemon loud in a workspace his
 * colleagues can see. Add the field here in the same commit that adds it to
 * `MappingToggles`, or the round-trip test below goes red — which is the point of it.
 */
function mergeToggles(existing: unknown): MappingToggles {
  const e = isRecord(existing) ? existing : {};
  return {
    postLinearComments: pickBoolean(e.postLinearComments, DEFAULT_TOGGLES.postLinearComments),
    updateLinearIssue: pickBoolean(e.updateLinearIssue, DEFAULT_TOGGLES.updateLinearIssue),
    notifySlack: pickBoolean(e.notifySlack, DEFAULT_TOGGLES.notifySlack),
    baseBranch: pickString(e.baseBranch, DEFAULT_TOGGLES.baseBranch),
    draftPr: pickBoolean(e.draftPr, DEFAULT_TOGGLES.draftPr),
    questionsEnabled: pickBoolean(e.questionsEnabled, DEFAULT_TOGGLES.questionsEnabled),
    maxRunMs: pickNumber(e.maxRunMs, DEFAULT_TOGGLES.maxRunMs),
    questionTimeoutMs: pickNumber(e.questionTimeoutMs, DEFAULT_TOGGLES.questionTimeoutMs),
  };
}

// ---------------------------------------------------------------------------
// Wizard shape -> domain shape
// ---------------------------------------------------------------------------

/**
 * 08-03's wizard-local toggle names translated to the canonical `MappingToggles` keys.
 *
 * The two vocabularies were derived independently under rush mode from the same D-09 prose
 * list, so this table is the reconciliation — recorded in the SUMMARY under "Contract
 * additions requested" as well, because Phase 1's owner may prefer to collapse the two.
 * Note 08-03 has no name for `questionsEnabled`: it rendered D-09's "question flow" as
 * `questionTimeoutMs`, so `questionsEnabled` is settable only as a global default today.
 */
function toDomainOverrides(toggles?: ToggleOverrides): Partial<MappingToggles> | undefined {
  if (!toggles) return undefined;
  const out: Partial<MappingToggles> = {};
  for (const [rawName, value] of Object.entries(toggles)) {
    if (value === undefined) continue;
    const name = rawName as ToggleName;
    switch (name) {
      case 'linearComments':
        out.postLinearComments = Boolean(value);
        break;
      case 'slackNotifications':
        out.notifySlack = Boolean(value);
        break;
      case 'baseBranch':
        out.baseBranch = String(value);
        break;
      case 'draftPr':
        out.draftPr = Boolean(value);
        break;
      case 'questionTimeoutMs':
        out.questionTimeoutMs = Number(value);
        break;
      case 'maxRunTimeMs':
        out.maxRunMs = Number(value);
        break;
      default:
        break; // an unrecognised toggle name is dropped, never written through
    }
  }
  // Sparse by construction (D-09): an empty override object is `undefined`, not `{}`.
  return Object.keys(out).length > 0 ? out : undefined;
}

/** The inverse, so a re-run's "keep as-is" mapping round-trips without losing overrides. */
function fromDomainOverrides(overrides?: Partial<MappingToggles>): ToggleOverrides | undefined {
  if (!overrides) return undefined;
  const out: ToggleOverrides = {};
  if (overrides.postLinearComments !== undefined) out.linearComments = overrides.postLinearComments;
  if (overrides.notifySlack !== undefined) out.slackNotifications = overrides.notifySlack;
  if (overrides.baseBranch !== undefined) out.baseBranch = overrides.baseBranch;
  if (overrides.draftPr !== undefined) out.draftPr = overrides.draftPr;
  if (overrides.questionTimeoutMs !== undefined) out.questionTimeoutMs = overrides.questionTimeoutMs;
  if (overrides.maxRunMs !== undefined) out.maxRunTimeMs = overrides.maxRunMs;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 08-04's `RepoSafetyInfo` field names mapped onto the canonical `RepoMapping`, exactly as
 * 08-04's SUMMARY requested: `ownerRepo` -> `repoSlug`, `defaultBranch` -> `baseBranch`.
 * `remoteName` is wizard-time diagnostic context with no canonical slot, so it is dropped
 * here rather than smuggled into `Config` under an invented field name.
 *
 * `enabled` is 08-05's to set (08-04 deliberately left it alone): a repo the operator just
 * selected is enabled.
 */
function toRepoMapping(
  repoPath: string,
  safety: RepoSafetyInfo | undefined,
  fallbackBaseBranch: string,
): RepoMapping {
  return {
    repoDir: repoPath,
    // An unresolved slug stays empty rather than guessed — 08-04 already emitted a
    // SafetyWarning naming the fix, and a wrong slug would send `gh pr create` at the
    // wrong repository.
    repoSlug: safety?.ownerRepo ?? '',
    // A discovered per-repo default branch beats the global guess (08-04's SUMMARY).
    baseBranch: safety?.defaultBranch ?? fallbackBaseBranch,
    enabled: true,
  };
}

/**
 * One wizard `Mapping` as a domain `ProjectMapping`, plus the record key it files under.
 *
 * D-07's keying: project id first, team id as the fallback. `MappingKey` carries only the
 * id it was keyed by, so the other of the two is null — the record key itself is what the
 * lookup uses, and both fields are carried so a reader never has to guess which form it is.
 */
function toProjectMapping(
  mapping: Mapping,
  fallbackBaseBranch: string,
): { key: string; value: ProjectMapping } {
  const safetyByPath = new Map<string, RepoSafetyInfo>();
  for (const info of (mapping as EnrichedMapping).repoSafety ?? []) {
    safetyByPath.set(info.repoPath, info);
  }

  const value: ProjectMapping = {
    linearProjectId: mapping.key.kind === 'project' ? mapping.key.id : null,
    linearTeamId: mapping.key.kind === 'team' ? mapping.key.id : null,
    repos: mapping.repos.map((repoPath) =>
      toRepoMapping(repoPath, safetyByPath.get(repoPath), fallbackBaseBranch),
    ),
  };

  // The two fields the wizard knew and used to discard. `displayName` is what a re-run
  // shows instead of a UUID; `ownerTeamId` records which team a project-keyed mapping
  // belongs to. Both omitted rather than set to '' — see the note on conditional
  // assignment below, and the schema's `.min(1)`.
  if (mapping.key.name && mapping.key.name !== mapping.key.id) {
    value.displayName = mapping.key.name;
  }
  if (mapping.key.kind === 'project' && mapping.key.teamId) {
    value.ownerTeamId = mapping.key.teamId;
  }

  // Conditional assignment, not `x: y ?? undefined` — an `undefined`-valued key survives
  // in the object even though JSON.stringify drops it, which breaks the round-trip
  // equality this plan asserts on. Omit rather than null.
  const slack = mapping.slackWebhookUrl?.trim();
  if (slack) value.slackWebhookUrl = slack;
  // Same conditional-assignment discipline as `slackWebhookUrl` directly above, and for
  // the same reason: an `undefined`-valued key survives in the object and breaks the
  // round-trip equality this module's tests assert on. The wizard never asks for this —
  // it carries it so a re-run does not delete it (M11).
  if (mapping.pickupStates && mapping.pickupStates.length > 0) {
    value.pickupStates = [...mapping.pickupStates];
  }
  const overrides = toDomainOverrides(mapping.toggles);
  if (overrides) value.overrides = overrides;

  return { key: mapping.key.id, value };
}

/**
 * The inverse: an already-written `Config` back into the `Mapping[]` shape 08-03's
 * `buildMappings(client, discovered, existing)` reviews on a re-run (D-04's edit-in-place).
 *
 * `Config` stores no human-readable mapping name, so the id doubles as the display name.
 * ponytail: re-fetching every project/team name just to label a review prompt is a round
 * trip for cosmetics; the operator is picking between ids they just created.
 */
export function toWizardMappings(config: Config | undefined): Mapping[] | undefined {
  if (!config || !isRecord(config.mappings)) return undefined;
  const out: Mapping[] = [];
  for (const [key, entry] of Object.entries(config.mappings)) {
    if (!isRecord(entry)) continue;
    const kind = entry.linearProjectId ? 'project' : 'team';
    const repos = Array.isArray(entry.repos)
      ? entry.repos
          .filter(isRecord)
          .map((r) => (typeof r.repoDir === 'string' ? r.repoDir : ''))
          .filter((p) => p !== '')
      : [];
    // `name: key` was the whole of gap 5: with no name persisted, a re-run listed every
    // existing mapping by its raw Linear UUID and asked the operator to choose between
    // them. `displayName` is now written at setup time; the id remains the fallback for a
    // config written before it existed.
    const displayName = typeof entry.displayName === 'string' ? entry.displayName : key;
    const ownerTeamId = typeof entry.ownerTeamId === 'string' ? entry.ownerTeamId : undefined;
    const mapping: Mapping = {
      key: {
        kind,
        id: key,
        name: displayName,
        ...(kind === 'project' && ownerTeamId ? { teamId: ownerTeamId } : {}),
      },
      repos,
    };
    if (typeof entry.slackWebhookUrl === 'string') mapping.slackWebhookUrl = entry.slackWebhookUrl;
    if (Array.isArray(entry.pickupStates)) {
      const states = entry.pickupStates.filter((s): s is string => typeof s === 'string');
      if (states.length > 0) mapping.pickupStates = states;
    }
    const toggles = fromDomainOverrides(entry.overrides as Partial<MappingToggles> | undefined);
    if (toggles) mapping.toggles = toggles;
    out.push(mapping);
  }
  return out.length > 0 ? out : undefined;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export interface AssembleConfigInput {
  mappings: Mapping[];
  /** From the authenticated Linear viewer — the account the bot posts as. */
  botUserId?: string;
  /** Best-effort: the team a workspace-scoped call needs. May be empty on a project-keyed setup. */
  teamId?: string;
  /**
   * The Linear user to subscribe to each picked-up ticket (INTK-03), or undefined for
   * "don't subscribe". Chosen by `chooseOperator`; it cannot be inferred, because the
   * daemon authenticates as the BOT and `viewer()` returns the bot.
   */
  operatorUserId?: string;
  /** The already-written config, if any. Untrusted input (T-08-19). */
  existing?: Config;
}

/**
 * Build the `Config` to write, merging over whatever is already on disk (D-04).
 *
 * Merge semantics, stated once so the three callers cannot each assume something different:
 *  - a mapping whose record key matches an existing one is REPLACED by the freshly built
 *    version (the operator just reconfirmed or edited it);
 *  - an existing mapping absent from this run's build is PRESERVED untouched (re-running
 *    setup with a subset selected must not delete the rest);
 *  - a `defaults` field not touched this run keeps its existing value;
 *  - anything unrecognised or wrongly typed in the existing file reverts to the shipped
 *    default rather than being carried forward.
 */
/**
 * The team id `webhookCreate` needs, derived from the mappings rather than taken on trust.
 *
 * The caller's hint only ever looked at TEAM-keyed mappings, so an operator who mapped a
 * PROJECT got `teamId: ''` written to disk and `law start` then refused to register a
 * webhook at all. A project-keyed mapping has always carried `key.teamId` (the owning
 * team, fetched at pick time), so the answer was available and simply not asked for.
 *
 * Order is deliberate: a team-keyed mapping names the team directly, a project-keyed one
 * names it by ownership, and only then does the previous file's value stand in.
 */
function deriveTeamId(mappings: Mapping[], existingTeamId: string): string {
  const teamKeyed = mappings.find((m) => m.key.kind === 'team')?.key.id;
  if (teamKeyed) return teamKeyed;
  const owning = mappings.find((m) => m.key.kind === 'project' && m.key.teamId)?.key.teamId;
  if (owning) return owning;
  return existingTeamId;
}

export function assembleConfig(input: AssembleConfigInput): Config {
  const existing = (input.existing ?? {}) as Partial<Config> & Record<string, unknown>;
  const defaults = mergeToggles(existing.defaults);

  const mappings: Record<string, ProjectMapping> = {};
  // Existing first, so a same-key mapping built this run overwrites it below.
  if (isRecord(existing.mappings)) {
    for (const [key, value] of Object.entries(existing.mappings)) {
      if (isRecord(value)) mappings[key] = value as unknown as ProjectMapping;
    }
  }
  for (const mapping of input.mappings) {
    const { key, value } = toProjectMapping(mapping, defaults.baseBranch);
    mappings[key] = value;
  }

  const config: Config = {
    botUserId: pickString(input.botUserId, pickString(existing.botUserId, '')),
    teamId: pickString(input.teamId, deriveTeamId(input.mappings, pickString(existing.teamId, ''))),
    concurrency: pickNumber(existing.concurrency, DEFAULT_CONCURRENCY),
    maxQuestionRounds: pickNumber(existing.maxQuestionRounds, DEFAULT_MAX_QUESTION_ROUNDS),
    maxTurns: pickNumber(existing.maxTurns, DEFAULT_MAX_TURNS),
    worktreeRoot: pickString(existing.worktreeRoot, DEFAULT_WORKTREE_ROOT),
    dbPath: pickString(existing.dbPath, DB_PATH),
    defaults,
    mappings,
  };

  // Optional by contract: present only when it has a real value, never as an explicit
  // `undefined` key (see the round-trip note in `toProjectMapping`).
  if (typeof existing.maxBudgetUsd === 'number' && Number.isFinite(existing.maxBudgetUsd)) {
    config.maxBudgetUsd = existing.maxBudgetUsd;
  }

  // `ingress` has no wizard prompt — it is a property of the instance the operator writes
  // by hand. Preserved, never invented: a re-run against the second instance's root must
  // not silently turn a poll-only daemon back into one that demands an ngrok token.
  if (existing.ingress === 'poll' || existing.ingress === 'webhook') {
    config.ingress = existing.ingress;
  }

  // This run's answer wins over what is on disk, INCLUDING when this run's answer is
  // "don't subscribe me" — an operator who re-runs setup to turn the subscription off must
  // not have the old id merged back in. `input.operatorUserId` being undefined therefore
  // has to mean "no operator", not "keep whatever was there", so the caller passes the
  // existing value back in when the step is skipped rather than relying on a merge here.
  if (input.operatorUserId) config.operatorUserId = input.operatorUserId;

  return config;
}

/**
 * Write `config.json`, creating `~/.linear-auto-worker/` if it is not there yet (D-06).
 *
 * ## It validates against the loader's own schema first
 *
 * The wizard wrote a config `loadConfig` throws on, and nothing noticed until `law start`
 * three days later. `ConfigSchema` is the daemon's gate; running it HERE, at the one funnel
 * every config write goes through, is what makes that impossible rather than unlikely —
 * for the zero-repo case today and for whatever field is added next. Nothing is written
 * when it fails.
 *
 * ## It is mode 0600, and it is NOT secret-free
 *
 * A mapping's `slackWebhookUrl` is a bearer credential: anyone who can read it can post to
 * that channel. Three places in this repo claimed the opposite and all three were wrong.
 * The two PROMPTED secrets do still live only in `.env` — that part was always true.
 *
 * `mode` on `writeFile` applies only at CREATION, so the `chmod` is the load-bearing half:
 * the operator already has a 0644 file on disk that this has to repair.
 */
export async function writeConfig(configPath: string, config: Config): Promise<void> {
  const result = ConfigSchema.safeParse(config);
  if (!result.success) {
    throw new ConfigError(
      `refusing to write an invalid config to ${configPath}:\n${z.prettifyError(result.error)}`,
    );
  }

  await mkdir(dirname(configPath), { recursive: true });
  // Pretty-printed: the operator is expected to read this file, and is explicitly NOT
  // expected to hand-edit it (SETUP-05).
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await chmod(configPath, 0o600);
}
