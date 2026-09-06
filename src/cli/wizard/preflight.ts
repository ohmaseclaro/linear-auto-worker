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

  if (!Number.isFinite(major)) {
    return {
      name: 'Node version',
      status: 'fail',
      detail: `Could not parse Node version from "${raw}"`,
      fix: 'Install Node >=22 (24 recommended, Active LTS) — this project targets better-sqlite3@13 and execa@10, both of which require >=22',
    };
  }

  if (major < 22) {
    return {
      name: 'Node version',
      status: 'fail',
      detail: `Running Node ${raw}`,
      fix: 'Install Node >=22 (24 recommended, Active LTS) — this project targets better-sqlite3@13 and execa@10, both of which require >=22',
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

export function runPreflight(): PreflightResult[] {
  return [checkNodeVersion()];
}
