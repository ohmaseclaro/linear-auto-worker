import type { Migration } from '../db.js';

/**
 * Phase 1 ADDENDUM: the five tables, exactly, are runs, questions, deliveries,
 * kv, run_events. `state` is checked against the nine RunState literals as a
 * value-legality check only — this migration asserts a state is one of the
 * nine strings, never which state may legally follow which.
 */
export const migration001: Migration = {
  version: 1,
  sql: `
CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  parent_run_id TEXT REFERENCES runs(id),
  kind TEXT NOT NULL CHECK (kind IN ('ticket', 'repo')),
  issue_id TEXT,
  issue_key TEXT,
  issue_title TEXT,
  issue_url TEXT,
  repo_dir TEXT,
  repo_slug TEXT,
  branch TEXT,
  worktree_path TEXT,
  session_id TEXT,
  pid INTEGER,
  state TEXT CHECK (
    state IS NULL OR state IN (
      'queued', 'preparing', 'running', 'awaiting_answer',
      'delivering', 'delivered', 'partial', 'failed', 'cancelled'
    )
  ),
  attempt INTEGER NOT NULL DEFAULT 0,
  question_round INTEGER NOT NULL DEFAULT 0,
  pr_url TEXT,
  failure_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE questions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  text TEXT NOT NULL,
  assumption TEXT,
  linear_comment_id TEXT,
  asked_at TEXT NOT NULL,
  deadline_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('open', 'answered', 'timed_out', 'cancelled')),
  answer TEXT
);

CREATE TABLE deliveries (
  id TEXT PRIMARY KEY,
  received_at TEXT NOT NULL
);

CREATE TABLE kv (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT,
  at TEXT NOT NULL,
  detail TEXT
);

CREATE INDEX idx_runs_state ON runs(state);
CREATE INDEX idx_questions_deadline_at ON questions(deadline_at);
CREATE INDEX idx_runs_issue_id ON runs(issue_id);
CREATE INDEX idx_runs_parent_run_id ON runs(parent_run_id);
CREATE INDEX idx_run_events_run_id ON run_events(run_id);
`,
};
