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
  /**
   * T125. The ref the checkout ACTUALLY used — `refs/remotes/<remote>/<base>` when it
   * existed, the bare `base` when it did not. It is the same variable `worktree add`
   * received, not a second derivation, so the fork point and every later diff range are
   * one string by construction. This function used to discard it, which is how
   * `deliver.ts` came to measure `<bare-local-name>..HEAD` against a base that T112
   * measured sitting 18 commits behind its own origin.
   */
  base: string;
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
  /**
   * A shared, daemon-owned parent directory a whole ticket's worktrees land side by side
   * in, so ONE `claude` session can be started with its cwd there and see exactly those
   * repositories and nothing else.
   *
   * Absent — the single-repo path, which is every run the live instance makes — keeps
   * today's `${daemonDir}/worktrees/${repoSlug}/${branch}` layout byte-identical.
   */
  parentDir?: string;
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

/** One probe for every namespace. Takes a FULL ref; `--quiet` means exit code IS the answer. */
async function refExists(runCommand: RunCommand, repoPath: string, ref: string): Promise<boolean> {
  const result = await runCommand('git', ['-C', repoPath, 'show-ref', '--verify', '--quiet', ref], { reject: false });
  return result.exitCode === 0;
}

async function branchExists(runCommand: RunCommand, repoPath: string, branch: string): Promise<boolean> {
  return refExists(runCommand, repoPath, `refs/heads/${branch}`);
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
    // Fetch, then branch off the REMOTE-TRACKING ref — not the bare base name. T112: a
    // fetch advances `refs/remotes/<remote>/<base>` and never moves `refs/heads/<base>`,
    // so branching from the bare name forks off whatever the operator last pulled and
    // makes the fetch inert. Measured live: one clone sat 18 commits behind its own
    // origin/main because it was checked out on another branch.
    const remote = o.remote ?? 'origin';
    try {
      await o.runCommand('git', ['-C', o.repoPath, 'fetch', '--quiet', remote]);
    } catch {
      // ponytail: swallowed on purpose — see comment above. Nothing to log to here; the
      // caller's own logger already records the surrounding run.
    }

    // Falling back to the bare name is REQUIRED, not a nicety, for two reasons: a clone
    // with no remote at all, and an offline run whose fetch just failed. Refusing to work
    // in either case would be worse than a stale base. Do not "tighten" this into a hard
    // failure. The probed ref string itself is what gets checked out, so there is no
    // second resolution step where the probe and the checkout could disagree.
    const remoteRef = `refs/remotes/${remote}/${o.base}`;
    const base = (await refExists(o.runCommand, o.repoPath, remoteRef)) ? remoteRef : o.base;

    // D-11 / AGNT-01: a colliding branch name is suffixed, never reused. The capital-B
    // force variant of the create flag resets an existing branch to the base commit and
    // destroys the previous attempt's commits — the entire reason D-11 names it. Do not
    // reintroduce it by reaching for the "obvious" idempotent create.
    const branch = await resolveBranchName(o.runCommand, o.repoPath, o.branchName);
    // Under a shared parent the leaf is the REPOSITORY, not the branch: the whole point is
    // a directory whose entries are the ticket's repositories, which is what the agent
    // reads and what the brief names. `repoSlug` arrives already flattened (`org-api`) so
    // the leaf is one segment AND is unique across organisations — `orgA/api` and
    // `orgB/api` in one mapping get `orgA-api` and `orgB-api` rather than colliding on
    // `api` and failing one child.
    const worktreePath = o.parentDir
      ? path.join(o.parentDir, o.repoSlug)
      : path.join(o.daemonDir, 'worktrees', o.repoSlug, branch);

    // Checked on BOTH branches, and NOT relaxed for the new one. `parentDir` is composed
    // by the caller from `daemonDir` and a run id, so it should already be inside the
    // root — this is what makes that a fact rather than an assumption, and it is the guard
    // standing between a bug here and `git worktree remove --force` running against the
    // operator's own clone (`reconcileWorktrees`'s `isUnderRoot` trusts it).
    if (!isUnderRoot(worktreePath, o.daemonDir)) {
      // Defense in depth: `branchName` is Linear-supplied text (T-04-11). git itself
      // rejects a ref containing `..` or control characters, but this check fails closed
      // before any subprocess runs at all, rather than relying solely on git's own ref
      // validation.
      throw new WorktreeError(`resolved worktree path ${worktreePath} escapes the daemon root ${o.daemonDir}`);
    }

    try {
      await o.runCommand('git', ['-C', o.repoPath, 'worktree', 'add', '-b', branch, worktreePath, base]);
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

    // `base`, not `o.base`: the RESOLVED ref, so no reader has to redo the probe above.
    return { branch, path: worktreePath, base };
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

export interface NonTerminalRun {
  runId: string;
  worktreePath: string;
}

export interface ReconcileWorktreesInput {
  runCommand: RunCommand;
  daemonDir: string;
  /** Every mapped repository's local clone path. */
  repoPaths: readonly string[];
  /** The caller's own non-terminal run rows. This module reads no database (Phase 6/7 own it). */
  nonTerminalRuns: readonly NonTerminalRun[];
}

export interface ReconcileResult {
  /** Worktree paths removed because no non-terminal run row referenced them. */
  pruned: string[];
  /** Run ids whose recorded worktree path is no longer a real worktree. */
  orphanedRuns: string[];
}

/**
 * Parse `git worktree list --porcelain` into the one field this module needs. Written
 * against the porcelain format rather than the human-readable one — the human format's
 * columns are not stable and a path containing a space silently mis-splits it. Each
 * worktree's path is carried on a single `worktree <path>` line with no further escaping,
 * so slicing off the known prefix is sufficient even when the path has a space in it.
 */
function parseWorktreePaths(porcelain: string): string[] {
  const paths: string[] = [];
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('worktree ')) {
      paths.push(line.slice('worktree '.length));
    }
    // `HEAD <sha>`, `branch <ref>`, `detached`, `bare`, `locked`, `prunable` and the
    // blank line separating records carry no information this decision needs.
  }
  return paths;
}

/**
 * Boot reconcile (AGNT-03). Prunes worktrees a crashed process orphaned and reports run
 * rows whose worktree vanished, so the caller can fail them with a diagnosis rather than
 * silently dropping or replaying them.
 *
 * Never removes the main working tree and never removes a worktree outside the daemon
 * root — both are the same condition, since the main working tree never lives under the
 * daemon-owned root in the first place. That containment check is the only thing standing
 * between a bug in this function and deleting the operator's own work.
 */
export async function reconcileWorktrees(o: ReconcileWorktreesInput): Promise<ReconcileResult> {
  const referenced = new Set(o.nonTerminalRuns.map((r) => path.resolve(r.worktreePath)));
  const seen = new Set<string>();
  const pruned: string[] = [];

  for (const repoPath of o.repoPaths) {
    // `worktree prune` first: a crashed process leaves stale administrative files that
    // make an already-deleted directory still list as a worktree. Pruning clears them so
    // the listing below reflects reality.
    await o.runCommand('git', ['-C', repoPath, 'worktree', 'prune']);

    const listing = await o.runCommand('git', ['-C', repoPath, 'worktree', 'list', '--porcelain']);
    for (const worktreePath of parseWorktreePaths(listing.stdout)) {
      const resolved = path.resolve(worktreePath);
      seen.add(resolved);

      if (!isUnderRoot(resolved, o.daemonDir)) {
        // Not this daemon's to delete — includes the main working tree itself, which is
        // never under the daemon-owned root.
        continue;
      }
      if (referenced.has(resolved)) continue;

      await o.runCommand('git', ['-C', repoPath, 'worktree', 'remove', '--force', worktreePath]);
      pruned.push(worktreePath);
    }
  }

  const orphanedRuns = o.nonTerminalRuns
    .filter((r) => !seen.has(path.resolve(r.worktreePath)))
    .map((r) => r.runId);

  return { pruned, orphanedRuns };
}
