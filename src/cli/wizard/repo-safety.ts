/**
 * Repo safety pass for every mapped repo (SETUP-07/08, D-03/D-07/D-09).
 *
 * Consumes the `Mapping[]` 08-03's `buildMappings()` produces and enriches it in place with
 * the remote/branch fields four other layers read (Delivery's `--base`, the push refusal
 * check, the worktree base, and the PR body — Pitfall 12). Every gap this module finds
 * (missing agent docs, no/ambiguous remote, submodules, missing branch protection) becomes a
 * non-throwing `SafetyWarning` — a repo with warnings is still usable, just flagged, and one
 * repo's check failure never aborts checks for the rest (T-08-15).
 */
import { defaultRunCommand, realPrompts, type RunCommand, type WizardPrompts } from './deps.js';
import { access, constants, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import type { Mapping } from './mapping.js';

export interface SafetyWarning {
  repoPath: string;
  kind: string;
  message: string;
  fixOffered: boolean;
}

/**
 * Per-repo fields resolved onto a mapping's matching `repos[]` entry (D-07). `remoteName`
 * has no home in `src/domain/types.ts`'s canonical `RepoMapping` (only `repoSlug` and
 * `baseBranch` do) — see this plan's SUMMARY under "Contract additions requested" for the
 * exact field-name reconciliation 08-05 needs.
 */
export interface RepoSafetyInfo {
  repoPath: string;
  remoteName?: string;
  defaultBranch?: string;
  ownerRepo?: string;
}

/** `Mapping` enriched with the per-repo safety info this module resolves. Structurally a
 *  `Mapping` (every required field is present) with one additional field, so it satisfies
 *  the plan's stated `Mapping[]` return shape without 08-04 editing 08-03's `mapping.ts`. */
export interface EnrichedMapping extends Mapping {
  repoSafety: RepoSafetyInfo[];
}

const AGENT_DOC_NAMES = ['CLAUDE.md', 'AGENTS.md'];

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function starterProjectName(repoPath: string): Promise<string> {
  try {
    const raw = await readFile(join(repoPath, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as { name?: string };
    if (pkg.name) return pkg.name;
  } catch {
    // no package.json here, or it doesn't parse — fall back to the directory name
  }
  return basename(repoPath);
}

async function writeStarterAgentDoc(repoPath: string): Promise<void> {
  const name = await starterProjectName(repoPath);
  const starter = `# ${name}\n\n## Conventions\n\n_Add project conventions here._\n\n## Architecture\n\n_Add architecture notes here._\n`;
  // T-08-12: only ever called from the "neither file exists" branch below, and only after
  // an explicit confirm — never overwrites an existing CLAUDE.md or AGENTS.md.
  await writeFile(join(repoPath, 'CLAUDE.md'), starter, 'utf8');
}

/**
 * SETUP-07/D-03: a repo missing both `CLAUDE.md` and `AGENTS.md` gets a prominent warning
 * plus an offer to generate a starter file. Research names this the single highest-leverage
 * success factor for the spawned agent — a warning whose fix is a separate project never
 * gets acted on, so the offer to write it right here is what makes the warning useful. An
 * existing repo under either name is silently passed: this is a warning-and-offer, not a
 * gate, so a repo the operator already trusts is never blocked from mapping.
 */
export async function checkAgentDocs(
  repoPath: string,
  prompts: WizardPrompts = realPrompts,
): Promise<SafetyWarning | null> {
  for (const name of AGENT_DOC_NAMES) {
    if (await fileExists(join(repoPath, name))) return null;
  }

  const message =
    `no CLAUDE.md/AGENTS.md found — the spawned agent starts with zero project context, ` +
    `which research names the single highest-leverage factor in whether a run produces ` +
    `something mergeable`;
  console.log(`⚠ "${repoPath}": ${message}`);

  const wantsStarter = await prompts.confirm({
    message: `Generate a starter CLAUDE.md for "${repoPath}"?`,
    default: true,
  });

  let fixOffered = false;
  if (wantsStarter) {
    await writeStarterAgentDoc(repoPath);
    fixOffered = true;
  }

  return { repoPath, kind: 'missing-agent-docs', message, fixOffered };
}

/**
 * Pitfall 6 / research: `.gitmodules` at the repo root gets a warning, never a silent skip —
 * git upstream documents multi-worktree-checkout submodule support as unsupported, and this
 * daemon's worktree-per-run model is exactly that shape. T-08-14 accepts a false negative for
 * a `.gitmodules` nested deeper than the repo root as a known, documented gap.
 */
async function checkSubmodules(repoPath: string): Promise<SafetyWarning | null> {
  if (!(await fileExists(join(repoPath, '.gitmodules')))) return null;
  return {
    repoPath,
    kind: 'submodules',
    message:
      `"${repoPath}" uses git submodules, which upstream git documents as unsupported ` +
      `across multiple worktree checkouts — runs against this repo may see missing or ` +
      `stale submodule content.`,
    fixOffered: false,
  };
}

/** Exactly one remote resolved, or a `SafetyWarning` naming the exact fix (zero remotes /
 *  ambiguous remotes). Never throws — an unreadable repo also becomes a warning. */
async function resolveRemote(
  repoPath: string,
  run: RunCommand,
): Promise<{ remoteName?: string; warning?: SafetyWarning }> {
  try {
    const { stdout } = await run('git', ['remote', '-v'], { cwd: repoPath });
    const names = new Set(
      (stdout ?? '')
        .split('\n')
        .map((line) => line.trim().split(/\s+/)[0])
        .filter((n): n is string => Boolean(n)),
    );
    if (names.size === 0) {
      return {
        warning: {
          repoPath,
          kind: 'no-remote',
          message: `"${repoPath}" has no remote — add one with \`git remote add origin <url>\``,
          fixOffered: false,
        },
      };
    }
    if (names.size > 1) {
      return {
        warning: {
          repoPath,
          kind: 'ambiguous-remote',
          message:
            `multiple remotes found on "${repoPath}" (${[...names].join(', ')}) — the ` +
            `wizard cannot guess which one to push to; confirm/rename so exactly one ` +
            `remote exists`,
          fixOffered: false,
        },
      };
    }
    return { remoteName: [...names][0] };
  } catch {
    return {
      warning: {
        repoPath,
        kind: 'no-remote',
        message: `"${repoPath}" — could not read git remotes; is this a git repository?`,
        fixOffered: false,
      },
    };
  }
}

interface GhRepoView {
  defaultBranchRef?: { name?: string } | null;
  nameWithOwner?: string;
}

/**
 * Run from inside the repo directory so `gh` resolves `nameWithOwner` itself from the local
 * remote, rather than this code parsing a `git@host:owner/repo.git` URL by hand (D-07 /
 * Pitfall 12 — Phase 4's Delivery needs this exact string for `gh pr create -R OWNER/REPO`).
 */
async function resolveDefaultBranch(
  repoPath: string,
  run: RunCommand,
): Promise<{ defaultBranch?: string; ownerRepo?: string; warning?: SafetyWarning }> {
  try {
    const { stdout } = await run(
      'gh',
      ['repo', 'view', '--json', 'defaultBranchRef,nameWithOwner'],
      { cwd: repoPath },
    );
    const parsed = JSON.parse(stdout ?? '{}') as GhRepoView;
    const defaultBranch = parsed.defaultBranchRef?.name;
    const ownerRepo = parsed.nameWithOwner;
    if (!defaultBranch || !ownerRepo) {
      return {
        warning: {
          repoPath,
          kind: 'unresolved-default-branch',
          message:
            `"${repoPath}" — \`gh repo view\` did not return a default branch and owner; ` +
            `check that its remote points at a GitHub repo \`gh\` can read`,
          fixOffered: false,
        },
      };
    }
    return { defaultBranch, ownerRepo };
  } catch {
    return {
      warning: {
        repoPath,
        kind: 'unresolved-default-branch',
        message:
          `"${repoPath}" — \`gh repo view\` failed; check that its remote points at a ` +
          `GitHub repo \`gh\` can read`,
        fixOffered: false,
      },
    };
  }
}

/**
 * D-09 / Pitfall 10: branch protection is the one control that survives even if the spawned
 * agent circumvents local push guards — it is server-side, out of the agent's reach. A 404
 * (not found) and a 403 (insufficient permission) are both surfaced as the same conservative
 * "absent or unknown" warning (T-08-13) rather than guessing which, so a permission gap is
 * never reported as "protected".
 */
async function checkBranchProtection(
  repoPath: string,
  ownerRepo: string,
  branch: string,
  run: RunCommand,
): Promise<SafetyWarning | null> {
  try {
    await run('gh', ['api', `repos/${ownerRepo}/branches/${branch}/protection`], {
      cwd: repoPath,
    });
    return null;
  } catch {
    return {
      repoPath,
      kind: 'no-branch-protection',
      message:
        `no branch protection detected on \`${branch}\` for "${ownerRepo}" — this is the ` +
        `one control that survives even if the spawned agent circumvents local push ` +
        `guards; consider adding a protection rule in GitHub repo settings`,
      fixOffered: false,
    };
  }
}

async function annotateOneRepo(
  repoPath: string,
  deps: { run: RunCommand; prompts: WizardPrompts },
): Promise<{ info: RepoSafetyInfo; warnings: SafetyWarning[] }> {
  const warnings: SafetyWarning[] = [];
  const info: RepoSafetyInfo = { repoPath };

  const docsWarning = await checkAgentDocs(repoPath, deps.prompts);
  if (docsWarning) warnings.push(docsWarning);

  const submoduleWarning = await checkSubmodules(repoPath);
  if (submoduleWarning) warnings.push(submoduleWarning);

  const remoteResult = await resolveRemote(repoPath, deps.run);
  if (remoteResult.warning) warnings.push(remoteResult.warning);
  if (remoteResult.remoteName) info.remoteName = remoteResult.remoteName;

  const branchResult = await resolveDefaultBranch(repoPath, deps.run);
  if (branchResult.warning) warnings.push(branchResult.warning);
  if (branchResult.defaultBranch) info.defaultBranch = branchResult.defaultBranch;
  if (branchResult.ownerRepo) info.ownerRepo = branchResult.ownerRepo;

  if (info.ownerRepo && info.defaultBranch) {
    const protectionWarning = await checkBranchProtection(
      repoPath,
      info.ownerRepo,
      info.defaultBranch,
      deps.run,
    );
    if (protectionWarning) warnings.push(protectionWarning);
  }

  return { info, warnings };
}

/**
 * Enrich every mapped repo with its resolved remote/default branch/owner, and collect every
 * gap as a `SafetyWarning`. Every check is wrapped per-repo (T-08-15): one repo's unexpected
 * failure (e.g. an unreadable directory) is itself turned into a warning rather than
 * aborting checks for the rest of the mapped repos.
 */
export async function annotateRepoSafety(
  mappings: Mapping[],
  deps: { run?: RunCommand; prompts?: WizardPrompts } = {},
): Promise<{ mappings: EnrichedMapping[]; warnings: SafetyWarning[] }> {
  const resolved = { run: deps.run ?? defaultRunCommand, prompts: deps.prompts ?? realPrompts };
  const allWarnings: SafetyWarning[] = [];
  const enrichedMappings: EnrichedMapping[] = [];

  for (const mapping of mappings) {
    const repoSafety: RepoSafetyInfo[] = [];
    for (const repoPath of mapping.repos) {
      try {
        const { info, warnings } = await annotateOneRepo(repoPath, resolved);
        repoSafety.push(info);
        allWarnings.push(...warnings);
      } catch (err) {
        repoSafety.push({ repoPath });
        allWarnings.push({
          repoPath,
          kind: 'check-failed',
          message: `"${repoPath}" — safety checks failed unexpectedly: ${String(
            (err as Error)?.message ?? err,
          )}`,
          fixOffered: false,
        });
      }
    }
    enrichedMappings.push({ ...mapping, repoSafety });
  }

  return { mappings: enrichedMappings, warnings: allWarnings };
}
