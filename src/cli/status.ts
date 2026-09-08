/**
 * `law status` — what the daemon is doing right now, read straight out of the store.
 *
 * This is the only read-only command, and it is deliberately a SEPARATE process from the
 * daemon rather than a query endpoint on it: the daemon has no HTTP surface beyond the
 * webhook receiver (PROJECT.md rules out a web UI), and SQLite in WAL mode already gives a
 * second process a consistent read while the daemon writes. That means `law status` also
 * works when the daemon is NOT running — which is exactly when an operator most wants it,
 * because a crashed daemon leaves its runs mid-flight and the next boot's recovery sweep
 * has not yet touched them.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

import { defaultRoot } from '../infra/config.js';
import { openStore } from '../infra/store/db.js';
import { createSqliteStore, type QuestionRow, type RunRow } from '../infra/store/sqlite-store.js';
import { HOLDS_SLOT, TERMINAL } from '../domain/types.js';
// Moved to `resolve-run.ts` when `law watch` and `law say` needed the same list. Three
// copies of the non-terminal states is how they drift; this file imports the one.
import { ACTIVE } from './resolve-run.js';

/** How many finished runs to show once there is nothing in flight. */
const RECENT_LIMIT = 5;

function ms(value: number | string): number {
  return typeof value === 'number' ? value : Number(value);
}

/** A millisecond span as the coarsest unit that still reads as a number. */
function span(millis: number): string {
  const seconds = Math.max(0, Math.round(millis / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86_400)}d`;
}

function ago(at: number | string, now: number): string {
  return span(now - ms(at));
}

/**
 * `LAW-123 org/api  Fix the login redirect`, truncated to fit one terminal line.
 *
 * The repo slug is not decoration: only `kind = 'repo'` rows carry a state (the schema's
 * CHECK enforces it), so one Linear issue mapped to three repos shows up here as three
 * rows sharing an issue key. Without the slug they are indistinguishable.
 */
function label(run: RunRow): string {
  const parts = [run.issueKey ?? run.id.slice(0, 8), run.repoSlug, run.issueTitle].filter(
    (part): part is string => Boolean(part),
  );
  const line = parts.join('  ');
  return line.length > 58 ? `${line.slice(0, 57)}…` : line;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function describe(run: RunRow, now: number): string {
  const bits = [pad(run.state ?? '?', 16), pad(label(run), 58), pad(`${ago(run.updatedAt, now)} ago`, 8)];
  const tail =
    run.prUrl ??
    (run.failureReason ? run.failureReason.split('\n')[0] : undefined) ??
    run.branch ??
    '';
  return `  ${bits.join(' ')} ${tail}`.trimEnd();
}

function describeQuestion(question: QuestionRow, now: number): string {
  const deadline =
    question.deadlineAt === null || question.deadlineAt === undefined
      ? 'no deadline'
      : ms(question.deadlineAt) <= now
        ? 'DEADLINE PASSED'
        : `${span(ms(question.deadlineAt) - now)} left`;
  const text = question.text.length > 70 ? `${question.text.slice(0, 69)}…` : question.text;
  return `      ↳ ${text.replace(/\s+/g, ' ')}  (${deadline})`;
}

export interface StatusDeps {
  /** Where `config.json`, `.env` and `store.db` live. */
  root?: string;
  /** Injected so the tests do not write to the shared stdout of a `node --test` child —
   *  see the header of `wizard/repo-safety.test.ts` for what that costs. */
  print?: (line: string) => void;
  now?: () => number;
}

/**
 * Returns the process exit code: `1` when there is no store to read (setup was never run),
 * `0` otherwise — including when the daemon is idle, which is not an error.
 */
export function runStatus(deps: StatusDeps = {}): number {
  const root = deps.root ?? defaultRoot();
  const print = deps.print ?? ((line: string) => console.log(line));
  const now = (deps.now ?? Date.now)();

  const dbFile = path.join(root, 'store.db');
  if (!existsSync(dbFile)) {
    print(`no store at ${dbFile} — run \`law setup\` first`);
    return 1;
  }

  // `openStore` migrates on open. That is intentional and safe to do from here: the
  // migrations are idempotent (PRAGMA user_version) and a status read on a database the
  // daemon has never opened would otherwise fail on a missing table.
  const db = openStore(dbFile);
  try {
    const store = createSqliteStore(db);
    const active = store
      .listByState(...ACTIVE)
      .sort((a, b) => ms(b.updatedAt) - ms(a.updatedAt));

    const slots = active.filter((run) => HOLDS_SLOT.includes(run.state as never)).length;
    print(`${root}`);
    print(`${active.length} active run(s), ${slots} holding a concurrency slot`);

    if (active.length === 0) {
      const recent = store
        .listByState(...TERMINAL)
        .sort((a, b) => ms(b.updatedAt) - ms(a.updatedAt))
        .slice(0, RECENT_LIMIT);
      if (recent.length === 0) {
        print('');
        print('nothing has run yet — `law start` to begin');
        return 0;
      }
      print('');
      print(`most recent ${recent.length}:`);
      for (const run of recent) print(describe(run, now));
      return 0;
    }

    print('');
    for (const run of active) {
      print(describe(run, now));
      // Only a parked run has a question worth showing, and only that run's issue is
      // queried — there is no "all open questions" index and a single-operator daemon
      // never has enough parked runs for that to matter.
      if (run.state === 'awaiting_answer' && run.issueId) {
        for (const question of store.openQuestionsForIssue(run.issueId)) {
          print(describeQuestion(question, now));
        }
      }
    }
    return 0;
  } finally {
    db.close();
  }
}
