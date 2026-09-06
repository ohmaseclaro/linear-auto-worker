/**
 * The five tables — runs, questions, deliveries, kv, run_events — and nothing else.
 *
 * D-11: the SQL is a template literal in a TypeScript module, never a `.sql` file. `tsc`
 * does not copy non-TS assets, so a `.sql` file would need both a build copy step and a
 * path resolved off `import.meta.url` — two things that work under `tsx` in development
 * and fail with ENOENT once built.
 *
 * Naming rule, and it is load-bearing: every column is the snake_case form of the
 * corresponding field in `src/domain/types.ts`, with no abbreviations. Phase 2 writes the
 * store's SQL on a branch that cannot see this file; the rule is the only thing that makes
 * both derivations land on the same names.
 *
 * Every timestamp column is INTEGER, holding epoch milliseconds, because that is what
 * every writer stores. A TEXT column would compare lexicographically and happens to order
 * ms timestamps correctly only while they all share a digit width — an accident that the
 * question deadline sweep and every ORDER BY would be resting on (TRAPS T47).
 *
 * Connection pragmas — journal mode, foreign keys, the lock wait — are deliberately absent:
 * those belong to the connection in `db.ts`, not to a migration.
 */

import type { Migration } from '../migrate.js';

export const migration001: Migration = {
  version: 1,
  name: 'init',
  sql: `
-- Every CREATE below is IF NOT EXISTS, so a partially applied database is recoverable.
CREATE TABLE IF NOT EXISTS runs (
  id            TEXT PRIMARY KEY,
  parent_run_id TEXT REFERENCES runs(id),
  kind          TEXT NOT NULL CHECK (kind IN ('ticket', 'repo')),

  issue_id      TEXT NOT NULL,
  issue_key     TEXT NOT NULL,
  issue_title   TEXT NOT NULL,
  issue_url     TEXT NOT NULL,

  repo_dir      TEXT,
  repo_slug     TEXT,
  branch        TEXT,
  worktree_path TEXT,
  session_id    TEXT,
  pid           INTEGER,

  state TEXT CHECK (state IS NULL OR state IN (
    'queued', 'preparing', 'running', 'awaiting_answer',
    'delivering', 'delivered', 'partial', 'failed', 'cancelled'
  )),

  cancel_requested INTEGER NOT NULL DEFAULT 0,
  resumable        INTEGER NOT NULL DEFAULT 0,
  attempt          INTEGER NOT NULL DEFAULT 0,
  question_round   INTEGER NOT NULL DEFAULT 0,

  pr_url         TEXT,
  failure_reason TEXT,

  -- Epoch milliseconds. INTEGER, not TEXT — see the module comment.
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  -- D-04: a ticket-kind parent row stores no state; a repo-kind row always does. Enforced
  -- here rather than in application code so that no layer can write a parent state by
  -- accident. A stored parent state could contradict its children, and that disagreement
  -- is the exact bug that would let one repo's failure discard another repo's
  -- already-shipped pull request (DELV-07).
  CHECK (
    (kind = 'ticket' AND state IS NULL) OR
    (kind = 'repo'   AND state IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_runs_state          ON runs(state);
CREATE INDEX IF NOT EXISTS idx_runs_issue_id       ON runs(issue_id);
CREATE INDEX IF NOT EXISTS idx_runs_parent_run_id  ON runs(parent_run_id);
-- The queue read: oldest run in a given state first.
CREATE INDEX IF NOT EXISTS idx_runs_state_created  ON runs(state, created_at);

CREATE TABLE IF NOT EXISTS questions (
  id                TEXT PRIMARY KEY,
  run_id            TEXT NOT NULL REFERENCES runs(id),
  text              TEXT NOT NULL,
  assumption        TEXT NOT NULL,
  linear_comment_id TEXT,
  -- Absolute epoch-millisecond instants, swept by a scheduler tick rather than held by
  -- in-process timers, which would not survive a restart. INTEGER so the sweep's range
  -- query is a numeric comparison.
  asked_at          INTEGER NOT NULL,
  deadline_at       INTEGER NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('open', 'answered', 'timed_out', 'cancelled')),
  answer            TEXT
);

-- The deadline sweep.
CREATE INDEX IF NOT EXISTS idx_questions_status_deadline ON questions(status, deadline_at);
CREATE INDEX IF NOT EXISTS idx_questions_run_status      ON questions(run_id, status);
-- Reply correlation is by stored comment id, so a duplicate would make it ambiguous.
-- Partial index: unset ids are many and must not collide.
CREATE UNIQUE INDEX IF NOT EXISTS idx_questions_comment_id
  ON questions(linear_comment_id) WHERE linear_comment_id IS NOT NULL;

-- The primary key IS the replay guarantee — the fourth and last webhook loop-prevention
-- layer. It must never become a plain column with an application-side check: that check
-- would race between its lookup and its insert, and this column exists precisely for the
-- case where the other three guards have already failed.
CREATE TABLE IF NOT EXISTS deliveries (
  delivery_id TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_deliveries_received_at ON deliveries(received_at);

CREATE TABLE IF NOT EXISTS kv (
  k          TEXT PRIMARY KEY,
  v          TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- D-03: every transition appends one row here in the same transaction that mutates
-- runs.state, so a transition that was not recorded is a missing row that restart recovery
-- and the terminal comment both notice. Exactly these five columns: the trigger name goes
-- in `detail`, and a sixth column would drift from D-03. from_state/to_state rather than
-- the bare words, which are SQL keywords needing quoting at every use site.
CREATE TABLE IF NOT EXISTS run_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id     TEXT NOT NULL REFERENCES runs(id),
  from_state TEXT,  -- null for the row recording the initial insert
  to_state   TEXT NOT NULL,
  at         INTEGER NOT NULL,
  detail     TEXT
);

CREATE INDEX IF NOT EXISTS idx_run_events_run_at ON run_events(run_id, at);
`,
};
