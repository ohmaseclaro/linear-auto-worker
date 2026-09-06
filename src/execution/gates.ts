/**
 * Pre-push gates. DELV-04, DELV-08, D-13.
 *
 * Plan 06 adds the secret scan (DELV-09) here. The tracer ships the one gate that has to
 * exist from the very first commit, because a push to the default branch cannot be undone.
 */
import { DeliveryError } from '../domain/errors.js';

/**
 * DELV-04 / D-13. Called by `deliver()` before the push arguments are constructed — a
 * gate downstream of the push is not a gate.
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
 * DELV-08. A diff touching CI configuration is flagged prominently rather than blocked.
 * `.claude/**` is in the list because a diff that edits the agent's own settings deserves
 * exactly the same prominence as one that edits a workflow.
 */
export const CI_PATH_PREFIXES: readonly string[] = [
  '.github/workflows/',
  '.github/actions/',
  '.circleci/',
  '.claude/',
];

export const CI_PATH_FILES: readonly string[] = ['.gitlab-ci.yml', 'Jenkinsfile'];

export function touchesCiPaths(files: readonly string[]): boolean {
  return files.some(
    (file) =>
      CI_PATH_PREFIXES.some((prefix) => file.startsWith(prefix)) || CI_PATH_FILES.includes(file)
  );
}
