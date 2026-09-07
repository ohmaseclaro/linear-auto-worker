import type Database from 'better-sqlite3';

/**
 * Typed CRUD over the five ADDENDUM tables (`runs`, `questions`, `deliveries`,
 * `kv`, `run_events`), and nothing else. This module holds zero state-machine
 * knowledge: `updateRun`/`updateQuestion` write whatever patch they are given,
 * with no check on what `state`/`status` currently is or is allowed to become.
 * Phase 6's `RunEngine.transition()` is the sole legality check in this
 * codebase (CONTEXT.md risk 3) -- if this file grows one, two components own
 * the state machine and they will eventually disagree.
 *
 * These row shapes are this plan's own local types, NOT an import from
 * `src/domain/`. `src/domain/ports.ts` does not exist on this branch yet
 * (Phase 1's), and 02-CONTEXT.md leaves "Store method surface" to this plan's
 * discretion. The exact shape below is recorded in `02-02-SUMMARY.md` under
 * `Contract additions requested` for Phase 1/7 to fold into `domain/ports.ts`.
 */

export interface RunRow {
  id: string;
  parentRunId: string | null;
  kind: 'ticket' | 'repo';
  issueId: string | null;
  issueKey: string | null;
  issueTitle: string | null;
  issueUrl: string | null;
  repoDir: string | null;
  repoSlug: string | null;
  branch: string | null;
  worktreePath: string | null;
  sessionId: string | null;
  pid: number | null;
  /** Unvalidated here on purpose -- see the module doc comment. */
  state: string | null;
  attempt: number;
  questionRound: number;
  prUrl: string | null;
  failureReason: string | null;
  /**
   * Gap D6. What the agent's session cost, off the result event's `total_cost_usd`, and
   * how many tokens it moved (input + output + both cache counts — see `usageTokens` in
   * `cli/adapters.ts`).
   *
   * Optional on the WRITE side only: both columns are `NOT NULL DEFAULT 0` (migration
   * 002), so an insert that omits them is correct, and every read returns a number. Same
   * shape as `cancelRequested`.
   */
  costUsd?: number;
  tokensUsed?: number;
  createdAt: number | string;
  updatedAt: number | string;
}

export interface QuestionRow {
  id: string;
  runId: string;
  text: string;
  assumption: string | null;
  linearCommentId: string | null;
  askedAt: number | string;
  deadlineAt: number | string | null;
  status: string;
  answer: string | null;
  /** `null` for a deadline expiry; the answering human's display name otherwise. */
  answeredBy?: string | null;
}

export interface RunEventInsert {
  runId: string;
  from: string | null;
  to: string;
  at: number | string;
  detail?: string | null;
}

export interface RunEventRow {
  id: number;
  runId: string;
  from: string | null;
  to: string;
  at: number | string;
  detail: string | null;
}

export interface Store {
  // Runs
  insertRun(row: RunRow): void;
  getRun(id: string): RunRow | undefined;
  /** Generic column-by-column patch -- see the module doc comment. Never
   *  inspects `patch.state`. */
  updateRun(id: string, patch: Partial<RunRow>): void;
  /**
   * A *terminal-value* filter ("is this row's state one of the values that
   * mean the run is over"), NOT a transition check ("may this row legally
   * move to another state"). This method never asks the second question --
   * only `RunEngine.transition()` (Phase 6) does. Conflating the two is
   * exactly the risk CONTEXT.md calls out; the two are kept explicitly
   * distinct here so a future reader cannot miss it.
   */
  findActiveRunByIssue(issueId: string): RunRow[];
  listByState(...states: string[]): RunRow[];
  nextQueued(limit: number): RunRow[];
  childRuns(parentRunId: string): RunRow[];

  // Questions
  insertQuestion(row: QuestionRow): void;
  getQuestion(id: string): QuestionRow | undefined;
  openQuestionsForIssue(issueId: string): QuestionRow[];
  findQuestionByCommentId(linearCommentId: string): QuestionRow | undefined;
  /** Correlation tier 2: the short code carried in a question comment's marker is
   *  the first 8 characters of the question id (`domain/types.ts:questionMarker`). */
  findQuestionByShortCode(code: string): QuestionRow | undefined;
  /** Generic column-by-column patch -- same no-validation rule as `updateRun`. */
  updateQuestion(id: string, patch: Partial<QuestionRow>): void;
  expiredQuestions(now: number | string): QuestionRow[];

  // Deliveries
  /**
   * One atomic `INSERT OR IGNORE` plus a `changes` check -- never a `SELECT`
   * first. A read-then-write dedupe races two near-simultaneous webhook
   * deliveries sharing an id (research PITFALLS.md Pitfall 1 / Pitfall 4).
   * Returns `true` only for the delivery that actually landed.
   */
  recordDelivery(deliveryId: string, receivedAt: number | string): boolean;
  pruneDeliveries(olderThan: number | string): void;

  // KV
  kvGet(key: string): string | undefined;
  kvSet(key: string, value: string): void;

  // Run events (Phase 1 D-03). Foundation only offers append/list; deciding
  // *when* to call them is Phase 6's job.
  appendRunEvent(event: RunEventInsert): void;
  listRunEvents(runId: string): RunEventRow[];

  transaction<T>(fn: () => T): T;
  close(): void;
}

/** camelCase (TS field) <-> snake_case (SQL column). Every column in the
 *  ADDENDUM's five tables follows this convention exactly, so one pair of
 *  generic converters covers runs/questions/deliveries/kv without a
 *  hand-maintained per-table map. `run_events`' `from_state`/`to_state`
 *  columns are the one pair that does not round-trip through this (the TS
 *  field names are `from`/`to`), so that table is handled explicitly below. */
function toSnake(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

function toCamel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_match, c: string) => c.toUpperCase());
}

function rowToCamel<T>(row: unknown): T | undefined {
  if (row === undefined) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
    out[toCamel(key)] = value;
  }
  return out as T;
}

function rowsToCamel<T>(rows: unknown[]): T[] {
  return rows.map((row) => rowToCamel<T>(row)!);
}

/** Builds `INSERT INTO table (...) VALUES (...)` from every key the caller's
 *  row object carries -- adding a column later needs no new insert method. */
function insertRow(db: Database.Database, table: string, row: Record<string, unknown>): void {
  const cols = Object.keys(row);
  const columnList = cols.map(toSnake).join(', ');
  const placeholders = cols.map(() => '?').join(', ');
  db.prepare(`INSERT INTO ${table} (${columnList}) VALUES (${placeholders})`).run(
    ...cols.map((c) => row[c])
  );
}

/** Builds `UPDATE table SET col = ?, ... WHERE id = ?` from whatever keys
 *  `patch` carries -- never a hand-written "legal fields" list, and never a
 *  check on what any value is allowed to be. */
function updateRow(
  db: Database.Database,
  table: string,
  id: string,
  patch: Record<string, unknown>
): void {
  const cols = Object.keys(patch);
  if (cols.length === 0) return;
  const setClause = cols.map((c) => `${toSnake(c)} = ?`).join(', ');
  db.prepare(`UPDATE ${table} SET ${setClause} WHERE id = ?`).run(
    ...cols.map((c) => patch[c]),
    id
  );
}

export function createSqliteStore(db: Database.Database): Store {
  return {
    // ---- Runs ----
    insertRun(row) {
      insertRow(db, 'runs', row as unknown as Record<string, unknown>);
    },
    getRun(id) {
      const row = db.prepare('SELECT * FROM runs WHERE id = ?').get(id);
      return rowToCamel<RunRow>(row);
    },
    updateRun(id, patch) {
      updateRow(db, 'runs', id, patch as Record<string, unknown>);
    },
    // ALL active runs, not the newest one. A ticket fanned out over N repos has N
    // child runs (D-12), and `run.cancelled` cancels every one of them -- a LIMIT 1
    // here cancelled one child and silently left the rest running (DELV-07).
    findActiveRunByIssue(issueId) {
      const rows = db
        .prepare(
          `SELECT * FROM runs
           WHERE issue_id = ?
             AND state IS NOT NULL
             AND state NOT IN ('delivered', 'partial', 'failed', 'cancelled')
           ORDER BY created_at DESC`
        )
        .all(issueId);
      return rowsToCamel<RunRow>(rows);
    },
    listByState(...states) {
      if (states.length === 0) return [];
      const placeholders = states.map(() => '?').join(', ');
      const rows = db.prepare(`SELECT * FROM runs WHERE state IN (${placeholders})`).all(...states);
      return rowsToCamel<RunRow>(rows);
    },
    nextQueued(limit) {
      const rows = db
        .prepare(`SELECT * FROM runs WHERE state = 'queued' ORDER BY created_at ASC LIMIT ?`)
        .all(limit);
      return rowsToCamel<RunRow>(rows);
    },
    childRuns(parentRunId) {
      const rows = db.prepare('SELECT * FROM runs WHERE parent_run_id = ?').all(parentRunId);
      return rowsToCamel<RunRow>(rows);
    },

    // ---- Questions ----
    insertQuestion(row) {
      insertRow(db, 'questions', row as unknown as Record<string, unknown>);
    },
    getQuestion(id) {
      const row = db.prepare('SELECT * FROM questions WHERE id = ?').get(id);
      return rowToCamel<QuestionRow>(row);
    },
    openQuestionsForIssue(issueId) {
      // No `issue_id` column on `questions` (CONTEXT.md leaves this choice
      // open) -- join through the owning run instead.
      const rows = db
        .prepare(
          `SELECT questions.* FROM questions
           JOIN runs ON runs.id = questions.run_id
           WHERE runs.issue_id = ? AND questions.status = 'open'`
        )
        .all(issueId);
      return rowsToCamel<QuestionRow>(rows);
    },
    findQuestionByCommentId(linearCommentId) {
      const row = db
        .prepare('SELECT * FROM questions WHERE linear_comment_id = ?')
        .get(linearCommentId);
      return rowToCamel<QuestionRow>(row);
    },
    findQuestionByShortCode(code) {
      const row = db
        .prepare('SELECT * FROM questions WHERE substr(id, 1, 8) = ? LIMIT 1')
        .get(code);
      return rowToCamel<QuestionRow>(row);
    },
    updateQuestion(id, patch) {
      updateRow(db, 'questions', id, patch as Record<string, unknown>);
    },
    expiredQuestions(now) {
      const rows = db
        .prepare(`SELECT * FROM questions WHERE status = 'open' AND deadline_at < ?`)
        .all(now);
      return rowsToCamel<QuestionRow>(rows);
    },

    // ---- Deliveries ----
    recordDelivery(deliveryId, receivedAt) {
      // Column is `delivery_id`, not `id` — see migrations/001-init.ts. TypeScript cannot
      // check SQL column names, so this drift compiled clean and failed on the first
      // webhook delivery. Caught only by executing the store against the real schema.
      const result = db
        .prepare('INSERT OR IGNORE INTO deliveries (delivery_id, received_at) VALUES (?, ?)')
        .run(deliveryId, receivedAt);
      return result.changes > 0;
    },
    pruneDeliveries(olderThan) {
      db.prepare('DELETE FROM deliveries WHERE received_at < ?').run(olderThan);
    },

    // ---- KV ----
    // Columns are `k`/`v`/`updated_at` — see migrations/001-init.ts. `updated_at` is NOT NULL,
    // so an insert that omits it fails even once the names are right.
    kvGet(key) {
      const row = db.prepare('SELECT v FROM kv WHERE k = ?').get(key) as
        | { v: string }
        | undefined;
      return row?.v;
    },
    kvSet(key, value) {
      db.prepare(
        'INSERT INTO kv (k, v, updated_at) VALUES (?, ?, ?) ' +
          'ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at'
      ).run(key, value, Date.now());
    },

    // ---- Run events ----
    appendRunEvent(event) {
      db.prepare(
        'INSERT INTO run_events (run_id, from_state, to_state, at, detail) VALUES (?, ?, ?, ?, ?)'
      ).run(event.runId, event.from, event.to, event.at, event.detail ?? null);
    },
    listRunEvents(runId) {
      const rows = db
        .prepare('SELECT * FROM run_events WHERE run_id = ? ORDER BY id ASC')
        .all(runId) as Array<{
        id: number;
        run_id: string;
        from_state: string | null;
        to_state: string;
        at: number | string;
        detail: string | null;
      }>;
      return rows.map((row) => ({
        id: row.id,
        runId: row.run_id,
        from: row.from_state,
        to: row.to_state,
        at: row.at,
        detail: row.detail,
      }));
    },

    transaction(fn) {
      return db.transaction(fn)();
    },
    close() {
      db.close();
    },
  };
}
