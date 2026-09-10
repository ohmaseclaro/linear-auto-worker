import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';

/**
 * D-02: repo discovery scans one operator-named directory to depth 2 for `.git`
 * and presents the results as a checklist — no filesystem-wide scan, no
 * hand-typed paths. This is also a DoS/traversal boundary (threat T-08-01): the
 * depth cap and symlink-skip are load-bearing, not just UX.
 */

export interface DiscoveredRepo {
  path: string;
  name: string;
}

const MAX_DEPTH = 2;

function isSkippable(entryName: string): boolean {
  return entryName === 'node_modules' || entryName.startsWith('.');
}

/**
 * What a `.git` entry says about a directory (T127).
 *
 * `.git` as a DIRECTORY is a real clone — a repository to map.
 * `.git` as a FILE is a linked worktree or a submodule. Both are checkouts OF a repository
 * that lives elsewhere, and neither is a repository to map: mapping a worktree points the
 * daemon at a directory whose `git worktree add` registers in the COMMON directory, so one
 * ticket would open several pull requests into one repository.
 *
 * `readdir` already returns the entry type, so this was a check that was AVAILABLE and not
 * made. Measured on the operator's own root: 33 directories bear a `.git` entry — 12 as a
 * directory, 21 as a file — and all 33 resolve to 12 unique
 * `git rev-parse --git-common-dir`. So the wizard offered 33 checkboxes for 12
 * repositories, and two picks that resolve to one repository share a `repoSlug`, which
 * makes `mappingIndex` collide and `gatherEvidence`'s `repos.find(...)` silently pick
 * whichever came first.
 *
 * ponytail: a repository whose main clone lives OUTSIDE the scanned root is now skipped
 * entirely rather than offered as a worktree. That is the right trade — offering it would
 * map the wrong directory — and the upgrade path is resolving `--git-common-dir` and
 * offering the clone at its real path. Nothing here dedupes by common-dir today; the type
 * check is a different rule that happens to reach the same 12 on this machine.
 */
type GitEntry = 'clone' | 'checkout-of-elsewhere' | 'none';

async function gitEntryKind(dir: string): Promise<GitEntry> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const dotGit = entries.find((entry) => entry.name === '.git');
    if (!dotGit) return 'none';
    return dotGit.isDirectory() ? 'clone' : 'checkout-of-elsewhere';
  } catch {
    // unreadable directory — treat as "no .git here", caller skips per-entry
    return 'none';
  }
}

async function scan(dir: string, depth: number, results: DiscoveredRepo[]): Promise<void> {
  let kind: GitEntry;
  try {
    kind = await gitEntryKind(dir);
  } catch {
    return; // best-effort: skip this directory, do not abort the whole scan
  }

  if (kind === 'clone') {
    results.push({ path: dir, name: basename(dir) });
    return; // do not descend further under a repo we already recorded
  }

  // Skipped AND not descended into, deliberately. The old code returned at ANY `.git`
  // entry, so a worktree shadowed whatever was nested inside it; descending now would start
  // surfacing clones vendored inside someone's worktree that the operator never asked
  // about. Not mapping it and not looking inside it are the same answer: this is a checkout
  // of a repository that lives somewhere else.
  if (kind === 'checkout-of-elsewhere') return;

  if (depth >= MAX_DEPTH) {
    return;
  }

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // permission error / ENOENT reading this directory — skip it
  }

  for (const entry of entries) {
    try {
      if (entry.isSymbolicLink()) continue; // never follow symlinked directories, even if they target one
      if (!entry.isDirectory()) continue;
      if (isSkippable(entry.name)) continue;
      await scan(join(dir, entry.name), depth + 1, results);
    } catch {
      continue; // one bad entry never aborts the sibling scan
    }
  }
}

export async function discoverRepos(rootDir: string): Promise<DiscoveredRepo[]> {
  const results: DiscoveredRepo[] = [];
  await scan(rootDir, 0, results);
  return results;
}
