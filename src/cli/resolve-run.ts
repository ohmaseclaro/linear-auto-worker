/**
 * "Which run did the operator mean?" — shared by `law watch` and `law say`.
 *
 * Two commands needing the same answer is exactly the point at which this repo has
 * historically grown two implementations of one rule (T72/T73/T92/T96/T99/T101). It gets
 * one, here, and `ACTIVE` — the non-terminal state list `status.ts` used to keep privately
 * — moves here with it rather than being copied a third time.
 */
import { TERMINAL } from '../domain/types.js';
import type { RunRow, Store } from '../infra/store/sqlite-store.js';

/**
 * Non-terminal states, newest work first. Mirrors `recovery.nonTerminalStates()` without
 * importing the recovery module, which pulls in the whole orchestration graph.
 */
export const ACTIVE = ['queued', 'preparing', 'running', 'awaiting_answer', 'delivering'] as const;

/** The shortest id prefix worth matching on. Below this, collisions are likely. */
const MIN_PREFIX = 4;

export type ResolveResult = { run: RunRow; target: string } | { error: string };

function ms(value: number | string): number {
  return typeof value === 'number' ? value : Number(value);
}

/**
 * One candidate per line, and the FIRST token on every line is a target: it is whatever
 * `runTarget` says reaches exactly this run, so retyping it resolves rather than
 * reproducing this same error. The rest of the line is description — an issue key when it
 * is not already the token, the repo slug, the state — so the operator still reads what he
 * recognises even though the slug is not itself a target.
 */
function listing(runs: readonly RunRow[], all: readonly RunRow[]): string {
  return runs
    .map((run) => {
      const target = runTarget(run, all);
      const rest = [run.issueKey === target ? null : run.issueKey, run.repoSlug ?? '-', run.state ?? '?'];
      return `  ${[target, ...rest].filter((f) => f !== null).join(' ')}`;
    })
    .join('\n');
}

function byRecency(a: RunRow, b: RunRow): number {
  return ms(b.updatedAt) - ms(a.updatedAt);
}

function matches(run: RunRow, target: string): boolean {
  if (run.id === target) return true;
  if (run.issueKey !== null && run.issueKey.toLowerCase() === target.toLowerCase()) return true;
  return target.length >= MIN_PREFIX && run.id.startsWith(target);
}

/**
 * The shortest thing an operator can type to reach exactly this run, given every run the
 * matcher could search. Uniqueness is decided BY `matches` itself — the token is grown
 * until `matches` accepts exactly one run — so the listing and the matcher cannot drift
 * apart: there is no second copy of the rule to keep in step.
 *
 * The issue key is tried first because it is what the operator recognises; failing that,
 * an id prefix of at least `MIN_PREFIX`, which the prefix clause accepts because the value
 * is a prefix of `run.id` by the way it is built, not because two constants agree.
 *
 * ponytail: no unique prefix exists when one run's id is a strict prefix of another's; we
 * fall back to the full id, which is then still ambiguous. Real ids are
 * `crypto.randomUUID()` — 36 chars, fixed length, never a prefix of another — so this is
 * reachable only from a hand-written fixture. Upgrade path if ids ever vary in length: an
 * exact-id-wins short circuit in `matches`.
 */
function runTarget(run: RunRow, all: readonly RunRow[]): string {
  const reachesOnlyThisRun = (token: string): boolean =>
    all.filter((candidate) => matches(candidate, token)).length === 1;

  if (run.issueKey !== null && reachesOnlyThisRun(run.issueKey)) return run.issueKey;
  for (let length = MIN_PREFIX; length <= run.id.length; length++) {
    const prefix = run.id.slice(0, length);
    if (reachesOnlyThisRun(prefix)) return prefix;
  }
  return run.id;
}

/**
 * With no target: the one active run, or an error naming every candidate.
 * With a target: an exact id, a case-insensitive issue key, or a 4+ character id prefix.
 *
 * Active runs are searched BEFORE terminal ones so a live run always beats a finished one
 * sharing a ticket. Beyond that it never guesses and never picks "the newest" —
 * `questions.ts:88-91` records what recency-based matching costs the day two runs share a
 * ticket.
 *
 * Every candidate an ambiguity error lists is named by a token that resolves back through
 * THIS function to exactly one run — see `runTarget`. The universe it is computed over is
 * active ∪ terminal, because that is what `matches` is applied to; a fourth accepted form
 * or a third pool must widen that universe too.
 */
export function resolveRunTarget(store: Store, target?: string): ResolveResult {
  const active = store.listByState(...ACTIVE).sort(byRecency);

  // Memoised: the common case (one active run, no target) must still cost one query.
  let terminalPool: RunRow[] | undefined;
  const terminal = (): RunRow[] => (terminalPool ??= store.listByState(...TERMINAL).sort(byRecency));
  const universe = (): RunRow[] => [...active, ...terminal()];

  if (target === undefined || target.length === 0) {
    if (active.length === 1) {
      const run = active[0] as RunRow;
      return { run, target: runTarget(run, universe()) };
    }
    if (active.length === 0) return { error: 'no active run — try `law status`' };
    return {
      error: `${active.length} active runs — name one:\n${listing(active, universe())}`,
    };
  }

  for (const pool of [active, terminal()]) {
    const hits = pool.filter((run) => matches(run, target));
    if (hits.length === 1) {
      const run = hits[0] as RunRow;
      return { run, target: runTarget(run, universe()) };
    }
    if (hits.length > 1) {
      return {
        error: `\`${target}\` matches ${hits.length} runs — name one:\n${listing(hits, universe())}`,
      };
    }
  }

  return { error: `no run matching \`${target}\` — try \`law status\`` };
}

/**
 * The run that owns the `claude` session behind `run` — the run itself, or, for a child of
 * a multi-repo ticket, whichever sibling carries the session id.
 *
 * A ticket over N repositories is worked by ONE session in a directory holding all N
 * worktrees, so only the LEAD child has a session of its own. An operator who types any of
 * the ticket's rows means that session; without this, `law watch` on a sibling reports
 * there is no activity log for it and `law say` reports no live agent — both true of that
 * ROW and useless as an answer.
 *
 * **It runs strictly AFTER resolution, and touches neither `matches` nor `runTarget`.**
 * T118's guarantee is about RESOLUTION — every token a listing prints reaches exactly one
 * run — and it says nothing about what a command then does with the run it resolved.
 * Folding this into `matches` would make two rows answer to one token, which is precisely
 * the ambiguity T118 exists to forbid.
 *
 * The owner is found by the session-id MARK, never by position: `childRuns` is
 * `SELECT * FROM runs WHERE parent_run_id = ?` with no `ORDER BY`, so "the first child" is
 * not a stable notion. With no sibling carrying one — every child still `queued`, no spawn
 * yet — it returns the run it was given, because there is nothing to redirect to and
 * inventing a target would send the operator somewhere emptier than where they typed.
 */
export function sessionOwner(store: Store, run: RunRow): RunRow {
  if (run.parentRunId === null) return run;
  const owner = store.childRuns(run.parentRunId).find((c) => c.sessionId !== null);
  return owner ?? run;
}

/** Every repository the one session covers, for the line that says the redirect happened. */
export function sharedWith(store: Store, run: RunRow): string[] {
  if (run.parentRunId === null) return [];
  return store
    .childRuns(run.parentRunId)
    .map((c) => c.repoSlug)
    .filter((slug): slug is string => slug !== null);
}
