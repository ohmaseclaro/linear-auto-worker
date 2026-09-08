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

export type ResolveResult = { run: RunRow } | { error: string };

function ms(value: number | string): number {
  return typeof value === 'number' ? value : Number(value);
}

/** `LAW-123 org/api running`, one candidate per line, typeable straight back in. */
function listing(runs: readonly RunRow[]): string {
  return runs
    .map((run) => `  ${run.issueKey ?? run.id.slice(0, 8)} ${run.repoSlug ?? '-'} ${run.state ?? '?'}`)
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
 * With no target: the one active run, or an error naming every candidate.
 * With a target: an exact id, a case-insensitive issue key, or a 4+ character id prefix.
 *
 * Active runs are searched BEFORE terminal ones so a live run always beats a finished one
 * sharing a ticket. Beyond that it never guesses and never picks "the newest" —
 * `questions.ts:88-91` records what recency-based matching costs the day two runs share a
 * ticket.
 */
export function resolveRunTarget(store: Store, target?: string): ResolveResult {
  const active = store.listByState(...ACTIVE).sort(byRecency);

  if (target === undefined || target.length === 0) {
    if (active.length === 1) return { run: active[0] as RunRow };
    if (active.length === 0) return { error: 'no active run — try `law status`' };
    return {
      error: `${active.length} active runs — name one:\n${listing(active)}`,
    };
  }

  for (const pool of [active, store.listByState(...TERMINAL).sort(byRecency)]) {
    const hits = pool.filter((run) => matches(run, target));
    if (hits.length === 1) return { run: hits[0] as RunRow };
    if (hits.length > 1) {
      return { error: `\`${target}\` matches ${hits.length} runs — name one:\n${listing(hits)}` };
    }
  }

  return { error: `no run matching \`${target}\` — try \`law status\`` };
}
