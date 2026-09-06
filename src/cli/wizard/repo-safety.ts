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
import { confirm } from '@inquirer/prompts';
import { access, constants, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

export interface SafetyWarning {
  repoPath: string;
  kind: string;
  message: string;
  fixOffered: boolean;
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
export async function checkAgentDocs(repoPath: string): Promise<SafetyWarning | null> {
  for (const name of AGENT_DOC_NAMES) {
    if (await fileExists(join(repoPath, name))) return null;
  }

  const message =
    `no CLAUDE.md/AGENTS.md found — the spawned agent starts with zero project context, ` +
    `which research names the single highest-leverage factor in whether a run produces ` +
    `something mergeable`;
  console.log(`⚠ "${repoPath}": ${message}`);

  const wantsStarter = await confirm({
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
