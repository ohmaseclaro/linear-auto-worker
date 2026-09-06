/**
 * Multi-repo fan-out (D-12, DELV-06, DELV-07).
 *
 * One ticket over N repos becomes one parent run and N child runs -- not one
 * session with `--add-dir`. Each child is a first-class run with its own repo,
 * branch, worktree, session and state, so each is a real `claude` process and
 * each costs one concurrency slot (D-03). The scheduler needs nothing new for
 * that: it counts runs, not tickets.
 *
 * The load-bearing property of this module is that **the parent's status is
 * derived from its children and never stored** (D-12, Phase 1 D-04). That is
 * not a normalisation preference. A stored parent status can disagree with its
 * children, and the disagreement resolves in whichever direction the last
 * writer happened to run -- which is exactly how one repo's failure ends up
 * discarding another repo's already-shipped pull request (DELV-07).
 *
 * So both exports here are pure functions. There is no writer for the parent's
 * status anywhere in this file, and nothing in `src/orchestration/` may add
 * one. Purity is what makes "never stored" enforceable rather than merely
 * intended: a total function from children to a status cannot drift from its
 * inputs.
 *
 * This module deliberately imports no port and no sibling engine. Its inputs
 * are the narrow structural shapes below, which `LinearIssue` and a config
 * mapping already satisfy -- so a store or a Linear client cannot reach it even
 * by accident.
 */
import { randomUUID } from 'node:crypto';
import { RUN_STATE_TABLE } from '../domain/state-machine.js';
import type { Run, RunId, RunState } from '../domain/types.js';

/** The slice of a mapping's `repos[]` entry the fan-out actually reads. */
export interface FanoutRepo {
  readonly repoDir: string;
  readonly repoSlug: string;
}

/** The slice of a config mapping the fan-out actually reads. */
export interface FanoutMapping {
  readonly repos: readonly FanoutRepo[];
}

/** The slice of `LinearIssue` the fan-out actually reads. */
export interface FanoutIssue {
  readonly id: string;
  readonly identifier: string;
  readonly title: string;
  readonly url: string;
  readonly branchName: string;
}

/**
 * The parent row. Its `state` column is `null` and stays `null` for the row's
 * whole life (D-12, Phase 1 D-04) -- the parent is a row, not a runnable thing.
 * It never acquires a slot, never gets a worktree and never spawns a process.
 *
 * Typing it as `null` rather than casting is deliberate. If Phase 1 lands
 * `Run.state` as non-nullable this stops compiling at the integration gate,
 * which surfaces the schema requirement instead of burying it under a cast.
 * See `Contract additions requested` in 06-05-SUMMARY.md.
 */
export type ParentRun = Omit<Run, 'state'> & { readonly state: null };

export interface FanoutPlan {
  /** `null` for a single-repo ticket: the common case is not wrapped. */
  readonly parent: ParentRun | null;
  /** The runnable rows. Exactly these get enqueued. */
  readonly children: readonly Run[];
}

/**
 * The parent has no terminal state until every child has one, and "still in
 * flight" is reported as such rather than squeezed into a run state. There is
 * no tenth state here: `settled: false` is the absence of an answer, not a new
 * name for one.
 */
export type DerivedParentStatus =
  | { readonly settled: false }
  | { readonly settled: true; readonly state: 'delivered' | 'partial' | 'failed' | 'cancelled' };

/** States in which a run shipped something reviewable. */
const SHIPPED: ReadonlyArray<RunState> = ['delivered', 'partial'];

/**
 * `org/api` -> `org-api`. The full slug is used, not just its trailing
 * segment: `orgA/api` and `orgB/api` are different repositories and must not
 * derive the same branch (T-06-25).
 */
function branchSuffix(repoSlug: string): string {
  return (
    repoSlug
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'repo'
  );
}

/**
 * One ticket, one run per mapped repo.
 *
 * A mapping with one repo returns one run with no parent, byte-identical in
 * shape to what plan 02 produced -- the single-repo path is not wrapped in a
 * degenerate parent of one.
 *
 * A mapping with N repos returns one parent (`kind: 'ticket'`) and N children
 * (`kind: 'repo'`), each child carrying its own repo, its own branch, its own
 * pre-assigned session id (T4) and the id of its parent.
 *
 * `worktreePath` is left `null` on every row, exactly as plan 02 leaves it.
 * The worktree is keyed by run id and its path is returned by
 * `WorktreeManager.create()`, so each child gets a distinct worktree by
 * construction. Guessing the path here would make this the second source of
 * truth for it, and the two would eventually disagree.
 */
export function planSubRuns(
  issue: FanoutIssue,
  mapping: FanoutMapping,
  opts: { readonly now?: () => number } = {},
): FanoutPlan {
  const now = opts.now ?? Date.now;
  const at = now();
  const repos = mapping.repos;
  if (repos.length === 0) return { parent: null, children: [] };

  const single = repos.length === 1;

  function row(repo: FanoutRepo, branch: string, parentRunId: RunId | null): Run {
    return {
      id: randomUUID(),
      parentRunId,
      kind: 'repo',
      issueId: issue.id,
      issueKey: issue.identifier,
      issueTitle: issue.title,
      issueUrl: issue.url,
      repoDir: repo.repoDir,
      repoSlug: repo.repoSlug,
      branch,
      worktreePath: null,
      // T4: pre-assigned and persisted before any spawn, never parsed out of
      // the event stream. One per child -- two children sharing a session id
      // would resume into each other's conversation.
      sessionId: randomUUID(),
      pid: null,
      state: 'queued',
      attempt: 0,
      questionRound: 0,
      prUrl: null,
      failureReason: null,
      createdAt: at,
      updatedAt: at,
    };
  }

  if (single) {
    return { parent: null, children: [row(repos[0], issue.branchName, null)] };
  }

  const parent: ParentRun = {
    id: randomUUID(),
    parentRunId: null,
    kind: 'ticket',
    issueId: issue.id,
    issueKey: issue.identifier,
    issueTitle: issue.title,
    issueUrl: issue.url,
    // The parent owns no repository, no branch, no worktree and no session,
    // because it is never executed. Every one of these belongs to a child.
    repoDir: null,
    repoSlug: null,
    branch: null,
    worktreePath: null,
    sessionId: null,
    pid: null,
    state: null,
    attempt: 0,
    questionRound: 0,
    prUrl: null,
    failureReason: null,
    createdAt: at,
    updatedAt: at,
  };

  // Distinct branch per child (T-06-25). Two mapped repos with the same slug
  // is a config error, but it must not silently produce two children racing on
  // one branch name, so identical suffixes are numbered rather than collided.
  const seen = new Map<string, number>();
  const children = repos.map((repo) => {
    const base = branchSuffix(repo.repoSlug);
    const nth = (seen.get(base) ?? 0) + 1;
    seen.set(base, nth);
    const suffix = nth === 1 ? base : `${base}-${nth}`;
    return row(repo, `${issue.branchName}-${suffix}`, parent.id);
  });

  return { parent, children };
}

/**
 * The ticket-level outcome, computed on every read (D-12, Phase 1 D-04).
 *
 * Partial success is the normal case, not an edge case: repo A ships its pull
 * request even when repo B fails. This function is the only place that says
 * so, and it says so without touching a single row -- reading a parent cannot
 * alter, clear or reclassify a delivered child's pull request URL, because
 * reading a parent is this call and this call writes nothing (DELV-07).
 *
 * The mapping, in order:
 *  - any child still non-terminal      -> not settled; the ticket is in flight
 *  - every child `delivered`           -> `delivered`
 *  - anything shipped, but not all     -> `partial`
 *  - nothing shipped, all `cancelled`  -> `cancelled`
 *  - nothing shipped, otherwise        -> `failed`
 *
 * `partial` is not a new name invented here. Phase 1 D-01 already carries it
 * for a run that shipped something incomplete, and a ticket where some repos
 * shipped and some did not is the same answer to the same question -- "did
 * this ship anything" -- which is what the state vocabulary was chosen for.
 */
export function deriveParentStatus(
  children: readonly { readonly state: RunState }[],
): DerivedParentStatus {
  if (children.length === 0) return { settled: false };
  if (children.some((c) => !RUN_STATE_TABLE[c.state].terminal)) return { settled: false };
  if (children.every((c) => c.state === 'delivered')) return { settled: true, state: 'delivered' };
  if (children.some((c) => SHIPPED.includes(c.state))) return { settled: true, state: 'partial' };
  if (children.every((c) => c.state === 'cancelled')) return { settled: true, state: 'cancelled' };
  return { settled: true, state: 'failed' };
}

/**
 * The repo list every child needs in its brief, so a child knows it is one
 * repo of a coordinated change rather than the whole ticket.
 *
 * Composing and writing the brief into the worktree is Phase 4's prompt work.
 * This plan supplies the list and nothing else -- deliberately no cross-run
 * agent messaging, which for a single-operator tool is speculative complexity
 * with a coordination-failure mode attached.
 */
export function ticketBriefRepos(plan: FanoutPlan): readonly string[] {
  return plan.children.map((c) => c.repoSlug!).filter(Boolean);
}
