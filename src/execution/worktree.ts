/**
 * Worktree lifecycle. AGNT-01, AGNT-02, AGNT-03, D-11, Pitfall 6.
 *
 * The tracer (plan 01) created one worktree for one run and removed it on success. This
 * plan adds everything that makes that safe under real conditions: collision suffixing so
 * a retry never destroys a previous attempt's commits, a per-repo mutex so two runs
 * against the same repository do not race `git`'s repo-wide index lock, a verdict-gated
 * removal policy, and the boot-time reconcile that prunes crash-orphaned worktrees.
 */
import * as path from 'node:path';
import { WorktreeError } from '../domain/errors.js';
import type { RunCommand, ExecutionVerdict } from './execute-run.js';

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
  /** Fetched before branching off `base`. Defaults to 'origin'. */
  remote?: string;
}

/**
 * A repository-wide `index.lock` means two simultaneous `fetch` / branch-create
 * sequences against ONE repository fail randomly, and the failure surfaces on whichever
 * run lost the race rather than on the one that caused it (Pitfall 6). Serializing here,
 * in-process, keyed by the resolved repo path, is what makes success criterion 1 — two
 * simultaneous runs against one repository — actually hold, without a global lock that
 * would serialize the whole daemon across UNRELATED repositories.
 */
const repoMutexes = new Map<string, Promise<unknown>>();

function withRepoMutex<T>(repoPath: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(repoPath);
  const previous = repoMutexes.get(key) ?? Promise.resolve();
  // Chain onto the previous link regardless of whether it resolved or rejected — a
  // failed preparation must not deadlock every later preparation against the same repo.
  const result = previous.then(fn, fn);
  // The tracked link is a never-rejecting shadow of `result`, so a rejection here never
  // becomes an unhandled rejection independent of whatever the caller does with `result`.
  const tracked = result.then(
    () => undefined,
    () => undefined
  );
  repoMutexes.set(key, tracked);
  void tracked.then(() => {
    // Only this call's own drain removes the entry — a later call may already have
    // replaced it, and removing that one early would let a third call skip the queue.
    if (repoMutexes.get(key) === tracked) repoMutexes.delete(key);
  });
  return result;
}

/** Bounded so a pathological run of collisions cannot loop forever forking `git`. */
const MAX_BRANCH_SUFFIX_ATTEMPTS = 50;

async function branchExists(runCommand: RunCommand, repoPath: string, branch: string): Promise<boolean> {
  const result = await runCommand(
    'git',
    ['-C', repoPath, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`],
    { reject: false }
  );
  return result.exitCode === 0;
}

/**
 * Find a free branch name starting from Linear's own `branchName`. Linear's branch and PR
 * auto-linking keys off the exact string, so it is used verbatim when free; only a
 * collision gets a numeric suffix, never a rewrite of the base name.
 */
async function resolveBranchName(runCommand: RunCommand, repoPath: string, branchName: string): Promise<string> {
  for (let n = 1; n <= MAX_BRANCH_SUFFIX_ATTEMPTS; n++) {
    const candidate = n === 1 ? branchName : `${branchName}-${n}`;
    if (!(await branchExists(runCommand, repoPath, candidate))) return candidate;
  }
  throw new WorktreeError(
    `could not find a free branch name based on "${branchName}" after ${MAX_BRANCH_SUFFIX_ATTEMPTS} attempts`
  );
}

/** Resolved-path containment with a trailing separator, so `/a/bc` never matches root `/a/b`. */
function isUnderRoot(candidate: string, root: string): boolean {
  const resolvedRoot = path.resolve(root) + path.sep;
  const resolvedCandidate = path.resolve(candidate) + path.sep;
  return resolvedCandidate.startsWith(resolvedRoot);
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
  return withRepoMutex(o.repoPath, async () => {
    // Fetch before branching so a run does not fork off whatever the operator last
    // happened to have pulled. Not fatal: a base that already exists locally is enough to
    // work offline, and refusing to work offline would be worse than a stale base.
    try {
      await o.runCommand('git', ['-C', o.repoPath, 'fetch', '--quiet', o.remote ?? 'origin']);
    } catch {
      // ponytail: swallowed on purpose — see comment above. Nothing to log to here; the
      // caller's own logger already records the surrounding run.
    }

    // D-11 / AGNT-01: a colliding branch name is suffixed, never reused. The capital-B
    // force variant of the create flag resets an existing branch to the base commit and
    // destroys the previous attempt's commits — the entire reason D-11 names it. Do not
    // reintroduce it by reaching for the "obvious" idempotent create.
    const branch = await resolveBranchName(o.runCommand, o.repoPath, o.branchName);
    const worktreePath = path.join(o.daemonDir, 'worktrees', o.repoSlug, branch);

    if (!isUnderRoot(worktreePath, o.daemonDir)) {
      // Defense in depth: `branchName` is Linear-supplied text (T-04-11). git itself
      // rejects a ref containing `..` or control characters, but this check fails closed
      // before any subprocess runs at all, rather than relying solely on git's own ref
      // validation.
      throw new WorktreeError(`resolved worktree path ${worktreePath} escapes the daemon root ${o.daemonDir}`);
    }

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
  });
}

export interface RemoveWorktreeInput {
  runCommand: RunCommand;
  repoPath: string;
  path: string;
}

/**
 * Remove a worktree unconditionally. Kept for the tracer's callers; `finishWorktree`
 * below is the verdict-gated entry point new callers should use.
 */
export async function removeWorktree(o: RemoveWorktreeInput): Promise<void> {
  await o.runCommand('git', ['-C', o.repoPath, 'worktree', 'remove', '--force', o.path]);
}

export interface FinishWorktreeInput {
  verdict: ExecutionVerdict;
  runCommand: RunCommand;
  repoPath: string;
  path: string;
}

/**
 * The full retention policy (AGNT-02): remove on `delivered` only. A `partial`, `failed`,
 * or `needs_input` run leaves its worktree exactly where it is — that directory is the
 * only artifact the operator can take over in, and a failed run whose evidence was
 * deleted is indistinguishable from a run that never started.
 *
 * `git worktree remove` refuses a dirty tree, so removal passes `--force`; this is the
 * one place in this module where that is correct, because the tree being removed is one
 * this daemon created and has already judged delivered.
 */
export async function finishWorktree(o: FinishWorktreeInput): Promise<void> {
  if (o.verdict !== 'delivered') return;
  await removeWorktree(o);
}
