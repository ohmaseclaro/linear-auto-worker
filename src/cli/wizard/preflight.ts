import { execa } from 'execa';
import { access, constants } from 'node:fs/promises';
import { homedir, totalmem } from 'node:os';
import { join } from 'node:path';

/**
 * Preflight checks for `law setup`. Every check must catch its own failure and
 * convert it into a PreflightResult with an actionable `fix` string — nothing here
 * is allowed to throw a raw stack trace at the operator (08-CONTEXT D-08).
 */

export type PreflightStatus = 'pass' | 'warn' | 'fail';

export interface PreflightResult {
  name: string;
  status: PreflightStatus;
  detail: string;
  fix?: string;
}

/**
 * D-01: warn below Node 24, hard-fail only below Node 22. better-sqlite3@13 and
 * execa@10 both require >=22, so 22 genuinely works — 24 is the Active LTS
 * recommendation, not a dependency floor. This machine runs v22.23.1 (T15); hard
 * failing at 24 would make the wizard refuse to run on the operator's own box.
 */
export function checkNodeVersion(): PreflightResult {
  const raw = process.version; // e.g. "v22.23.1"
  const major = Number.parseInt(raw.replace(/^v/, '').split('.')[0] ?? '', 10);

  const nodeFix =
    'Install Node >=22 (24 recommended, Active LTS) — this project targets better-sqlite3@13 and execa@10, both of which require >=22';

  if (!Number.isFinite(major)) {
    return {
      name: 'Node version',
      status: 'fail',
      detail: `Could not parse Node version from "${raw}"`,
      fix: nodeFix,
    };
  }

  if (major < 22) {
    return {
      name: 'Node version',
      status: 'fail',
      detail: `Running Node ${raw}`,
      fix: nodeFix,
    };
  }

  if (major < 24) {
    return {
      name: 'Node version',
      status: 'warn',
      detail: `Running Node ${raw} — this works, but Node 24 (Active LTS) is recommended`,
    };
  }

  return {
    name: 'Node version',
    status: 'pass',
    detail: `Running Node ${raw}`,
  };
}

/** git config user.name and user.email must both resolve non-empty. */
export async function checkGitIdentity(): Promise<PreflightResult> {
  const name = 'Git identity';
  try {
    const [nameResult, emailResult] = await Promise.all([
      execa('git', ['config', 'user.name']),
      execa('git', ['config', 'user.email']),
    ]);
    const userName = nameResult.stdout?.trim();
    const userEmail = emailResult.stdout?.trim();
    if (userName && userEmail) {
      return { name, status: 'pass', detail: `${userName} <${userEmail}>` };
    }
    return {
      name,
      status: 'fail',
      detail: 'git user.name or user.email is empty',
      fix: 'git config --global user.name "Your Name" && git config --global user.email "you@example.com"',
    };
  } catch {
    return {
      name,
      status: 'fail',
      detail: 'git user.name or user.email is not set',
      fix: 'git config --global user.name "Your Name" && git config --global user.email "you@example.com"',
    };
  }
}

/**
 * `gh auth status` must exit 0. Additionally probes for the `workflow` OAuth
 * scope (Pitfall 12) — without it, pushes touching `.github/workflows/**` are
 * rejected. Missing scope downgrades to warn, not fail, since it's not required
 * for most repos.
 */
export async function checkGhAuth(): Promise<PreflightResult> {
  const name = 'GitHub CLI auth';
  try {
    const result = await execa('gh', ['auth', 'status']);
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    const scopesMatch = output.match(/Token scopes:\s*(.+)/i);
    if (scopesMatch && !scopesMatch[1].includes('workflow')) {
      return {
        name,
        status: 'warn',
        detail: `Authenticated, but token is missing the "workflow" scope (${scopesMatch[1].trim()})`,
        fix: 'gh auth refresh -h github.com -s workflow',
      };
    }
    return { name, status: 'pass', detail: 'gh is authenticated' };
  } catch (err) {
    const output = `${(err as any)?.stdout ?? ''}\n${(err as any)?.stderr ?? ''}`;
    const scopesMatch = output.match(/Token scopes:\s*(.+)/i);
    if (scopesMatch && !scopesMatch[1].includes('workflow')) {
      return {
        name,
        status: 'warn',
        detail: `Authenticated, but token is missing the "workflow" scope (${scopesMatch[1].trim()})`,
        fix: 'gh auth refresh -h github.com -s workflow',
      };
    }
    return {
      name,
      status: 'fail',
      detail: 'gh is not authenticated',
      fix: 'gh auth login',
    };
  }
}

/** `claude --version` must resolve on PATH. */
export async function checkClaudeOnPath(): Promise<PreflightResult> {
  const name = 'Claude CLI';
  try {
    const result = await execa('claude', ['--version']);
    return { name, status: 'pass', detail: (result.stdout ?? '').trim() };
  } catch {
    return {
      name,
      status: 'fail',
      detail: 'claude CLI not found on PATH',
      fix: 'install the claude CLI and ensure it is on PATH',
    };
  }
}

/** A global GSD install exists if ~/.claude/skills or ~/.claude/gsd-core is readable. */
export async function checkGsdInstall(): Promise<PreflightResult> {
  const name = 'Global GSD install';
  const candidates = [join(homedir(), '.claude', 'skills'), join(homedir(), '.claude', 'gsd-core')];
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.R_OK);
      return { name, status: 'pass', detail: `found ${candidate}` };
    } catch {
      // try next candidate
    }
  }
  return {
    name,
    status: 'fail',
    detail: 'no global GSD install found under ~/.claude',
    fix: 'this project depends on a global GSD install; see the GSD setup docs',
  };
}

/**
 * Informational only (Pitfall 8) — this never fails or warns. Derives a
 * concurrency suggestion from total RAM and flags a low open-file ulimit
 * without changing status.
 */
export async function checkResourceHeadroom(): Promise<PreflightResult> {
  const name = 'Resource headroom';
  const totalRamGiB = totalmem() / 1024 ** 3;
  const suggestedConcurrency = Math.max(1, Math.min(3, Math.floor(totalRamGiB / 4)));

  let ulimitN = Number.POSITIVE_INFINITY;
  try {
    const result = await execa('sh', ['-c', 'ulimit -n']);
    const parsed = Number.parseInt((result.stdout ?? '').trim(), 10);
    if (Number.isFinite(parsed)) ulimitN = parsed;
  } catch {
    // best-effort; leave ulimitN unset if the shell call fails
  }

  const detail = `${totalRamGiB.toFixed(1)} GiB RAM — suggested concurrency: ${suggestedConcurrency}`;

  if (ulimitN < 1024) {
    return {
      name,
      status: 'pass',
      detail,
      fix: 'ulimit -n 4096 (or the shell-appropriate persistent equivalent)',
    };
  }

  return { name, status: 'pass', detail };
}

export async function runPreflight(): Promise<PreflightResult[]> {
  return [
    checkNodeVersion(),
    await checkGitIdentity(),
    await checkGhAuth(),
    await checkClaudeOnPath(),
    await checkGsdInstall(),
    await checkResourceHeadroom(),
  ];
}
