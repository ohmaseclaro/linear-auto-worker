/**
 * Interactive project→repo mapping (SETUP-05/06).
 *
 * The operator builds the map by PICKING from listed Linear teams/projects and discovered
 * local repos — never by hand-typing a path or hand-editing JSON (SETUP-05 rules that out
 * explicitly). This module returns data only; it never touches disk. 08-05 assembles the
 * returned `Mapping[]` into the final `Config` and writes it.
 *
 * `Mapping` is not yet an export of `src/domain/types.ts` (Phase 1 has not landed it under
 * RUSH MODE's simultaneous fan-out), so it is defined locally here per the plan's own
 * instruction to "use the closest reasonable name and record the exact addition wanted" —
 * see this plan's SUMMARY under "Contract additions requested".
 */
import { checkbox, confirm, input, select } from '@inquirer/prompts';
import type { LinearClient } from '@linear/sdk';

import type { DiscoveredRepo } from './repo-discovery.js';

// ---------------------------------------------------------------------------
// Candidate listing
// ---------------------------------------------------------------------------

export interface TeamCandidate {
  id: string;
  name: string;
}

export interface ProjectCandidate {
  id: string;
  name: string;
  teamId: string;
}

/** Structural shape of any `@linear/sdk` connection this module pages. */
interface SdkPage<N> {
  nodes: N[];
  pageInfo: { hasNextPage: boolean; endCursor?: string | null };
}

interface SdkTeamNode {
  id: string;
  name: string;
}

/**
 * The project fields this module reads, plus its `teams()` connection.
 *
 * A project can span multiple teams in the current Linear schema; this module takes the
 * FIRST team as the project's mapping `teamId`, matching the plan's flat `{id, name,
 * teamId}` shape. No `node_modules` exists on this branch to confirm the real `.d.ts`
 * against (RUSH MODE) — flagged under "Contract additions requested" for the integration
 * gate to verify.
 */
interface SdkProjectNode {
  id: string;
  name: string;
  teams(vars: { first: number; after?: string }): Promise<SdkPage<SdkTeamNode>>;
}

/** The two SDK connections this module needs, kept minimal and local rather than imported —
 *  same pattern as `src/outbound/linear-client.ts`'s own `Page<N>`. */
interface MappingLinearClient {
  teams(vars: { first: number; after?: string }): Promise<SdkPage<SdkTeamNode>>;
  projects(vars: { first: number; after?: string }): Promise<SdkPage<SdkProjectNode>>;
}

const PAGE_SIZE = 50;

/**
 * Page a connection to completion via explicit `after` cursors.
 *
 * TRAPS T22 / PITFALLS.md Pitfall 11: never use `connection.fetchNext()` — it mutates and
 * returns `this`, appending into the same `page.nodes` array, so the intuitive loop
 * double-counts every page. Every connection here defaults to 50 and silently truncates
 * without this (Pitfall 11).
 */
async function pageAll<N>(fetchPage: (after?: string) => Promise<SdkPage<N>>): Promise<N[]> {
  const out: N[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await fetchPage(after);
    out.push(...page.nodes);
    if (!page.pageInfo.hasNextPage) return out;
    const next = page.pageInfo.endCursor ?? undefined;
    if (next === undefined || next === after) return out; // truthy hasNextPage, no usable cursor
    after = next;
  }
}

/**
 * List every Linear team and project the operator can pick from, fully paginated.
 * Requests only `id`/`name`/`teamId` — never full objects.
 */
export async function listMappingCandidates(
  linearClient: LinearClient,
): Promise<{ teams: TeamCandidate[]; projects: ProjectCandidate[] }> {
  const client = linearClient as unknown as MappingLinearClient;

  const teamNodes = await pageAll<SdkTeamNode>((after) =>
    client.teams({ first: PAGE_SIZE, after }),
  );
  const projectNodes = await pageAll<SdkProjectNode>((after) =>
    client.projects({ first: PAGE_SIZE, after }),
  );

  const projects: ProjectCandidate[] = [];
  for (const node of projectNodes) {
    const teamPage = await node.teams({ first: 1 });
    const teamId = teamPage.nodes[0]?.id ?? '';
    projects.push({ id: node.id, name: node.name, teamId });
  }

  return {
    teams: teamNodes.map((t) => ({ id: t.id, name: t.name })),
    projects,
  };
}

// ---------------------------------------------------------------------------
// Mapping shape
// ---------------------------------------------------------------------------

/** D-07: a mapping is keyed by Linear project, with a team-level fallback — an issue filed
 *  directly onto a team with no project would otherwise match nothing and be silently
 *  dropped, indistinguishable from the bot ignoring the operator. */
export interface MappingKey {
  kind: 'project' | 'team';
  id: string;
  name: string;
}

export interface Mapping {
  key: MappingKey;
  /** Discovered local repo paths attached to this mapping. */
  repos: string[];
  /** Bearer-secret-shaped (posting needs no other auth) — never echoed in full on re-run. */
  slackWebhookUrl?: string;
  /** Sparse override of the six CONF-02 toggles (Phase 1 D-09). Absent key = "use default",
   *  never an empty-valued key. */
  toggles?: ToggleOverrides;
}

/** The six CONF-02 toggles (Phase 1 D-09). `concurrency` is NOT one of them — it is a
 *  global cap that lives at `Config` top level, not in this per-mapping override set. */
export const TOGGLE_NAMES = [
  'linearComments',
  'slackNotifications',
  'baseBranch',
  'draftPr',
  'questionTimeoutMs',
  'maxRunTimeMs',
] as const;
export type ToggleName = (typeof TOGGLE_NAMES)[number];
export type ToggleOverrides = Partial<Record<ToggleName, boolean | string | number>>;

const NO_PROJECT_VALUE = '__no_project__';

async function promptMappingKey(candidates: {
  teams: TeamCandidate[];
  projects: ProjectCandidate[];
}): Promise<MappingKey> {
  const projectChoice = await select({
    message: 'Which Linear project should this mapping key off?',
    choices: [
      ...candidates.projects.map((p) => ({ name: p.name, value: p.id })),
      { name: 'No project — map to a team instead (D-07 fallback)', value: NO_PROJECT_VALUE },
    ],
  });

  if (projectChoice !== NO_PROJECT_VALUE) {
    const project = candidates.projects.find((p) => p.id === projectChoice);
    if (!project) throw new Error(`Selected project "${projectChoice}" not found in candidates`);
    return { kind: 'project', id: project.id, name: project.name };
  }

  const teamId = await select({
    message: 'Which Linear team should this mapping key off?',
    choices: candidates.teams.map((t) => ({ name: t.name, value: t.id })),
  });
  const team = candidates.teams.find((t) => t.id === teamId);
  if (!team) throw new Error(`Selected team "${teamId}" not found in candidates`);
  return { kind: 'team', id: team.id, name: team.name };
}

/**
 * PITFALLS.md Pitfall 10, item 3 / threat T-08-21: without `--bare` (forbidden — PROJECT.md),
 * a spawned `claude -p` session runs a mapped repo's own `.claude/settings.json` hooks and
 * connects its `.mcp.json` servers with NO trust prompt. Printed once per newly-mapped repo
 * as disclosure, not a second gate — the operator already consented by selecting it above.
 */
function printRepoTrustDisclosure(repoPath: string): void {
  console.log(
    `⚠ "${repoPath}": mapping this repo means fully trusting it. Without --bare, a spawned ` +
      `claude -p session runs its .claude/settings.json hooks and connects its .mcp.json ` +
      `servers with no trust prompt.`,
  );
}

async function promptRepoSelection(discovered: DiscoveredRepo[]): Promise<string[]> {
  const selected = await checkbox({
    message: 'Which local repos attach to this mapping?',
    choices: discovered.map((r) => ({ name: `${r.name} (${r.path})`, value: r.path })),
  });
  for (const repoPath of selected) {
    printRepoTrustDisclosure(repoPath);
  }
  return selected;
}

// ---------------------------------------------------------------------------
// Slack + toggle capture
// ---------------------------------------------------------------------------

interface ToggleSpec {
  message: string;
  kind: 'boolean' | 'string' | 'number';
}

const TOGGLE_SPECS: Record<ToggleName, ToggleSpec> = {
  linearComments: { message: 'Post progress comments to Linear for this mapping?', kind: 'boolean' },
  slackNotifications: { message: 'Send Slack notifications for this mapping?', kind: 'boolean' },
  baseBranch: { message: 'Base branch override:', kind: 'string' },
  draftPr: { message: 'Open pull requests as draft for this mapping?', kind: 'boolean' },
  questionTimeoutMs: { message: 'Question timeout override (ms):', kind: 'number' },
  maxRunTimeMs: { message: 'Max run time override (ms):', kind: 'number' },
};

async function promptToggleOverrides(): Promise<ToggleOverrides | undefined> {
  const wantsOverrides = await confirm({
    message: 'Override any default behavior for this mapping?',
    default: false,
  });
  if (!wantsOverrides) return undefined;

  const chosen = await checkbox({
    message: 'Which toggles should this mapping override?',
    choices: TOGGLE_NAMES.map((name) => ({ name, value: name })),
  });
  if (chosen.length === 0) return undefined; // sparse: nothing selected, nothing overridden

  const toggles: ToggleOverrides = {};
  for (const name of chosen) {
    const spec = TOGGLE_SPECS[name];
    if (spec.kind === 'boolean') {
      toggles[name] = await confirm({ message: spec.message });
    } else if (spec.kind === 'number') {
      const raw = await input({ message: spec.message });
      toggles[name] = Number(raw);
    } else {
      toggles[name] = await input({ message: spec.message });
    }
  }
  return toggles;
}

/**
 * Slack webhook URL (optional, empty input → `undefined`, never an empty string stored) plus
 * the sparse toggle-override capture. Factored out so both the fresh-add path and the
 * re-run "edit Slack/toggles" path call the same prompt sequence (D-04's edit-in-place has
 * to share code with fresh-add, or the two paths silently drift apart).
 */
async function promptSlackAndToggles(): Promise<{
  slackWebhookUrl?: string;
  toggles?: ToggleOverrides;
}> {
  const rawSlack = (
    await input({ message: 'Slack incoming-webhook URL (optional):' })
  ).trim();
  const slackWebhookUrl = rawSlack || undefined;
  const toggles = await promptToggleOverrides();
  return { slackWebhookUrl, toggles };
}

/** One full mapping's prompt sequence: key, repos, Slack + toggles. Shared by the fresh-add
 *  loop and (per-field) by the re-run edit paths — see `reviewExistingMapping`. */
async function promptOneMapping(
  candidates: { teams: TeamCandidate[]; projects: ProjectCandidate[] },
  discovered: DiscoveredRepo[],
): Promise<Mapping> {
  const key = await promptMappingKey(candidates);
  const repos = await promptRepoSelection(discovered);
  const { slackWebhookUrl, toggles } = await promptSlackAndToggles();
  return { key, repos, slackWebhookUrl, toggles };
}

// ---------------------------------------------------------------------------
// Re-run: edit in place (D-04)
// ---------------------------------------------------------------------------

/** A Slack webhook URL is bearer-secret-shaped (posting needs no other auth) even though it
 *  is not one of the two prompted secrets — masked to host-only on redisplay. */
function maskSlackUrl(url: string): string {
  try {
    return `${new URL(url).host}/…`;
  } catch {
    return '…';
  }
}

function printExistingMapping(mapping: Mapping): void {
  console.log(`- ${mapping.key.kind}: ${mapping.key.name}`);
  console.log(`  repos: ${mapping.repos.join(', ') || '(none)'}`);
  console.log(
    `  slack: ${mapping.slackWebhookUrl ? maskSlackUrl(mapping.slackWebhookUrl) : '(none)'}`,
  );
  console.log(`  toggles: ${mapping.toggles ? JSON.stringify(mapping.toggles) : '(none)'}`);
}

type ExistingMappingAction = 'keep' | 'edit-repos' | 'edit-slack' | 'remove';

/**
 * Re-run edit-in-place (D-04): "keep as-is" returns the mapping byte-for-byte untouched — no
 * code path may partially mutate a mapping the operator did not choose to edit (threat
 * T-08-10). Only the field the operator picks goes through `promptOneMapping`'s prompt
 * sequence again; everything else on the mapping is preserved via spread.
 */
async function reviewExistingMapping(
  mapping: Mapping,
  discovered: DiscoveredRepo[],
): Promise<Mapping | null> {
  printExistingMapping(mapping);
  const action = await select<ExistingMappingAction>({
    message: `What should happen to the "${mapping.key.name}" mapping?`,
    choices: [
      { name: 'keep as-is', value: 'keep' },
      { name: 'edit repos', value: 'edit-repos' },
      { name: 'edit Slack/toggles', value: 'edit-slack' },
      { name: 'remove', value: 'remove' },
    ],
  });

  if (action === 'keep') return mapping;
  if (action === 'remove') return null;
  if (action === 'edit-repos') {
    const repos = await promptRepoSelection(discovered);
    return { ...mapping, repos };
  }
  // 'edit-slack'
  const { slackWebhookUrl, toggles } = await promptSlackAndToggles();
  return { ...mapping, slackWebhookUrl, toggles };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Build (or edit) the operator's project→repo mapping set.
 *
 * No `existing` (first run): build one mapping via `promptOneMapping`, then loop "Add
 * another mapping?" until declined (D-04's fresh-build path).
 *
 * `existing` provided (re-run): every existing mapping is reviewed via
 * `reviewExistingMapping` — untouched mappings come back byte-for-byte identical, only the
 * ones the operator chooses to edit are re-prompted. After reviewing all of them, the
 * operator can still add brand-new mappings through the same "Add another mapping?" prompt.
 */
export async function buildMappings(
  linearClient: LinearClient,
  discovered: DiscoveredRepo[],
  existing?: Mapping[],
): Promise<Mapping[]> {
  const candidates = await listMappingCandidates(linearClient);
  const result: Mapping[] = [];

  if (existing && existing.length > 0) {
    for (const mapping of existing) {
      const outcome = await reviewExistingMapping(mapping, discovered);
      if (outcome) result.push(outcome);
    }
  } else {
    result.push(await promptOneMapping(candidates, discovered));
  }

  let addMore = await confirm({ message: 'Add another mapping?', default: false });
  while (addMore) {
    result.push(await promptOneMapping(candidates, discovered));
    addMore = await confirm({ message: 'Add another mapping?', default: false });
  }

  return result;
}
