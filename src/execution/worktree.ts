/**
 * Worktree lifecycle. AGNT-01, AGNT-02, D-11.
 *
 * The tracer creates one worktree for one run and removes it on success. Plan 02 owns
 * collision suffixing (AGNT-01), the boot reconcile (AGNT-03), and the full
 * success/failure retention policy (AGNT-02).
 */
import * as path from 'node:path';
import { WorktreeError } from '../domain/errors.js';
import type { RunCommand } from './execute-run.js';

export interface PreparedWorktree {
  branch: string;
  path: string;
}

export interface PrepareWorktreeInput {
  runCommand: RunCommand;
  /** The operator's own clone. Nothing is ever written inside it except git metadata. */
  repoPath: string;
  /** Used only to namespace the daemon-owned worktree root. */
  repoSlug: string;
  daemonDir: string;
  /** Linear's `Issue.branchName`, verbatim. */
  branchName: string;
  /** The ref the new branch is cut from. */
  base: string;
}

/**
 * Create the run's worktree and hand back where it landed.
 *
 * The root is `${daemonDir}/worktrees/${repoSlug}/` — daemon-owned, deliberately NEVER
 * inside the operator's repository (ASVS V12, threat T-04-06). A worktree nested inside
 * the working copy shows up in the operator's own `git status` and can be committed by
 * accident.
 */
export async function prepareWorktree(o: PrepareWorktreeInput): Promise<PreparedWorktree> {
  // Linear's own branch and PR auto-linking keys off this exact string. Slugifying it
  // silently breaks the link between the ticket and the PR, which is the whole point.
  const branch = o.branchName;
  const worktreePath = path.join(o.daemonDir, 'worktrees', o.repoSlug, branch);

  // The tracer's single path assumes the branch does not already exist. Plan 02 adds the
  // `-2`, `-3` collision suffixing that makes retries safe.
  //
  // The capital-B force variant of this flag is FORBIDDEN (D-11): it resets an existing
  // branch to the base ref, which destroys the previous attempt's commits — the exact
  // evidence the operator needs when a run failed. Suffix a colliding name instead.
  try {
    await o.runCommand('git', ['-C', o.repoPath, 'worktree', 'add', '-b', branch, worktreePath, o.base]);
  } catch (cause) {
    throw new WorktreeError(`failed to create worktree at ${worktreePath}`, { cause });
  }

  // Assert we are on a branch and not detached. A detached HEAD means every commit the
  // agent makes lands nowhere; without this check that failure first surfaces minutes
  // later at push time, disguised as something else entirely.
  try {
    await o.runCommand('git', ['-C', worktreePath, 'symbolic-ref', '-q', 'HEAD']);
  } catch (cause) {
    throw new WorktreeError(
      `worktree ${worktreePath} is on a detached HEAD; the agent's commits would land nowhere`,
      { cause }
    );
  }

  return { branch, path: worktreePath };
}

export interface RemoveWorktreeInput {
  runCommand: RunCommand;
  repoPath: string;
  path: string;
}

/**
 * Remove a worktree. Called on a delivered run only — a failed run keeps its worktree so
 * the operator can read what the agent actually did (AGNT-02).
 */
export async function removeWorktree(o: RemoveWorktreeInput): Promise<void> {
  await o.runCommand('git', ['-C', o.repoPath, 'worktree', 'remove', '--force', o.path]);
}
