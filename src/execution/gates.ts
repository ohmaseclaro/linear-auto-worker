/**
 * Pre-push gates. DELV-04, DELV-08, DELV-09, D-13.
 *
 * Every gate here is a PURE FUNCTION OVER TEXT. None of them runs git. The caller collects
 * the diff and the changed-file list and passes them in.
 *
 * That is not a testability nicety, it is the safety property: a gate that cannot execute
 * a command cannot accidentally be reordered below the push it gates. `deliver()` has to
 * have the diff in hand — i.e. has to have already called git — before it can even ask
 * these functions a question.
 */
import { DeliveryError } from '../domain/errors.js';

/**
 * DELV-04 / D-13. Called by `deliver()` before the push arguments are constructed — a
 * gate downstream of the push is not a gate.
 *
 * Exact string comparison, deliberately: `main-something` is a perfectly ordinary feature
 * branch. This is a hard precondition rather than a warning because a push to the default
 * branch cannot be undone, and GitHub branch protection — the control that actually holds
 * — may or may not be configured on any given mapped repo.
 */
export function assertPushAllowed(o: { branch: string; defaultBranch: string }): void {
  if (o.branch === o.defaultBranch) {
    throw new DeliveryError(
      `refusing to push: the working branch (${o.branch}) is the repository default ` +
        `branch. Agent-authored commits never go straight to the default branch.`
    );
  }
}

/**
 * DELV-09. The honest limit, stated here so nobody later reads a pass as proof:
 *
 * This is a GUARDRAIL AGAINST AN AGENT COMMITTING A FIXTURE. It is not a defence against
 * an adversary. A fixed regex set misses anything base64'd, split across lines, or issued
 * by a provider not on this list. A clean result means "no obviously-shaped credential was
 * added", nothing stronger.
 *
 * Order matters: the specific prefixes come before the broad `sk-`, so a hit reports the
 * narrowest name that matched.
 */
const SECRET_PATTERNS: readonly { name: string; re: RegExp }[] = [
  { name: 'github-pat-classic', re: /ghp_[A-Za-z0-9]{20,}/ },
  { name: 'github-pat-fine-grained', re: /github_pat_[A-Za-z0-9_]{20,}/ },
  { name: 'anthropic-api-key', re: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'linear-api-key', re: /lin_api_[A-Za-z0-9]{20,}/ },
  { name: 'slack-bot-token', re: /xoxb-[A-Za-z0-9-]{10,}/ },
  { name: 'aws-access-key-id', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'pem-private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'openai-style-api-key', re: /sk-[A-Za-z0-9]{20,}/ },
];

/**
 * Environment files are blocked by PATH, whatever their contents. DELV-09 names them
 * alongside credential patterns for the obvious reason: the whole point of a `.env` is
 * that it holds the things this scanner is looking for.
 *
 * `.env.example` and friends are the documented, deliberately-checked-in shape and are not
 * blocked.
 */
const ENV_FILE_ALLOWED_SUFFIXES: readonly string[] = ['.example', '.sample', '.template'];

function isEnvFile(filePath: string): boolean {
  const base = filePath.split('/').pop() ?? '';
  if (base !== '.env' && !base.startsWith('.env.')) return false;
  return !ENV_FILE_ALLOWED_SUFFIXES.some((suffix) => base.endsWith(suffix));
}

/**
 * A located hit. `line` is the line number in the NEW file.
 *
 * There is deliberately no field carrying the matched value: a report that echoes the
 * secret writes it to a second place (a log, a Linear comment, a PR body) and makes the
 * disclosure worse than the commit did.
 *
 * `line: 0` means "the file itself", used for the by-path environment-file block.
 */
export interface SecretHit {
  file: string;
  line: number;
  pattern: string;
}

/**
 * DELV-09. Scan a unified diff and return every hit.
 *
 * Only ADDED lines are scanned — a line beginning with a single `+` that is not the `+++`
 * file header. A diff that REMOVES a secret is the agent cleaning up, and blocking it would
 * make the guardrail punish the fix.
 */
export function findSecrets(diff: string): SecretHit[] {
  const hits: SecretHit[] = [];
  let file = '';
  let newLine = 0;
  const seenEnvFiles = new Set<string>();

  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ ')) {
      // `+++ /dev/null` is a deletion; there is no new-side file to blame.
      const target = raw.slice(4).trim();
      file = target === '/dev/null' ? '' : target.replace(/^b\//, '');
      if (file && isEnvFile(file) && !seenEnvFiles.has(file)) {
        seenEnvFiles.add(file);
        hits.push({ file, line: 0, pattern: 'environment-file' });
      }
      continue;
    }
    if (raw.startsWith('--- ') || raw.startsWith('diff --git')) continue;

    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(raw);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }

    if (raw.startsWith('+')) {
      const content = raw.slice(1);
      const match = SECRET_PATTERNS.find((p) => p.re.test(content));
      if (match) hits.push({ file, line: newLine, pattern: match.name });
      newLine += 1;
    } else if (raw.startsWith('-')) {
      // Removed line: consumes an old-side line number, not a new-side one.
    } else {
      newLine += 1;
    }
  }

  return hits;
}

/**
 * DELV-08. Directories whose contents are CI, plus `.claude/` — a diff that edits the
 * agent's own settings deserves exactly the same prominence as one that edits a workflow.
 */
export const CI_PATH_DIRS: readonly string[] = [
  '.github/workflows',
  '.github/actions',
  '.circleci',
  '.claude',
];

/** Matched on basename, at any depth. */
export const CI_PATH_FILES: readonly string[] = ['.gitlab-ci.yml', 'Jenkinsfile'];

/**
 * DELV-08. FLAG, never block — the two dispositions are different on purpose. Conflating
 * them either blocks legitimate CI work or, worse, invites someone to relax the secret
 * block to unblock it.
 *
 * Returns the matching paths rather than a boolean, because both the PR body and the
 * terminal Linear comment name them.
 *
 * Matching is on path SEGMENTS: `docs/circleci-notes.md` is a document about CircleCI, not
 * CI configuration. A substring match would flag it and train the operator to ignore flags.
 *
 * Note this flag is about making a human LOOK, not about preventing the write: GitHub
 * separately rejects a push that touches `.github/workflows/` unless the token carries the
 * `workflow` scope.
 */
export function touchesCiPaths(files: readonly string[]): string[] {
  return files.filter((file) => {
    const segments = file.split('/').filter((s) => s.length > 0);
    const base = segments[segments.length - 1] ?? '';
    if (CI_PATH_FILES.includes(base)) return true;
    return CI_PATH_DIRS.some((dir) => {
      const dirSegments = dir.split('/');
      return dirSegments.every((seg, i) => segments[i] === seg) && segments.length > dirSegments.length;
    });
  });
}

export interface PrePushGateInput {
  branch: string;
  defaultBranch: string;
  /** The unified diff of the work about to be pushed. */
  diff: string;
  /** The changed-file list for the same range. */
  files: readonly string[];
}

export interface PrePushGateResult {
  /** DELV-04: set when the push must be refused outright. */
  refusal?: string;
  /** DELV-09: set when a secret or environment file blocks the push. */
  block?: string;
  hits: SecretHit[];
  /** DELV-08: flagged, not blocking. */
  ciPaths: string[];
}

/**
 * All three gates, one call, one result. The caller has ONE thing to check rather than
 * three it might forget one of — which is the whole reason this composition exists.
 */
export function runPrePushGates(o: PrePushGateInput): PrePushGateResult {
  let refusal: string | undefined;
  try {
    assertPushAllowed({ branch: o.branch, defaultBranch: o.defaultBranch });
  } catch (err) {
    refusal = err instanceof Error ? err.message : String(err);
  }

  const hits = findSecrets(o.diff);
  const block =
    hits.length > 0
      ? `refusing to push: ${hits.length} possible secret(s) in the diff — ` +
        hits.map((h) => `${h.pattern} at ${h.file}:${h.line}`).join(', ')
      : undefined;

  return { refusal, block, hits, ciPaths: touchesCiPaths(o.files) };
}
