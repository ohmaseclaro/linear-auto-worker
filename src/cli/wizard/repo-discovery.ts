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

async function hasGitEntry(dir: string): Promise<boolean> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.some((entry) => entry.name === '.git');
  } catch {
    // unreadable directory — treat as "no .git here", caller skips per-entry
    return false;
  }
}

async function scan(dir: string, depth: number, results: DiscoveredRepo[]): Promise<void> {
  let isRepo: boolean;
  try {
    isRepo = await hasGitEntry(dir);
  } catch {
    return; // best-effort: skip this directory, do not abort the whole scan
  }

  if (isRepo) {
    results.push({ path: dir, name: basename(dir) });
    return; // do not descend further under a repo we already recorded
  }

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
