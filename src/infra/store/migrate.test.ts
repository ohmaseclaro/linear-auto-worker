/**
 * The migration runner against a real database.
 *
 * `node:sqlite` rather than the production driver: nothing is installed on this branch, the
 * built-in needs no install, and its synchronous surface satisfies the runner's structural
 * database type — which is the whole reason that type is structural. Its experimental
 * warning does not fail a test. Phase 2's store tests exercise the real driver.
 *
 * Everything is driven through the exported `migrate` and `readUserVersion`. Executing the
 * SQL blob directly would prove the schema is valid without proving the runner applies it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { migrate, readUserVersion, type MigratableDb } from './migrate.js';
import { MIGRATIONS } from './migrations/index.js';

const LATEST = MIGRATIONS[MIGRATIONS.length - 1]!.version;

function fresh(): DatabaseSync & MigratableDb {
  return new DatabaseSync(':memory:') as DatabaseSync & MigratableDb;
}

function names(db: DatabaseSync, type: 'table' | 'index'): string[] {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%'`)
    .all(type) as Array<{ name: string }>;
  return rows.map((r) => r.name).sort();
}

/** A valid repo-kind row, so each constraint test varies exactly one thing. */
function insertRun(db: DatabaseSync, over: Record<string, unknown> = {}): void {
  const row: Record<string, unknown> = {
    id: `run-${Math.random().toString(16).slice(2)}`,
    kind: 'repo',
    issue_id: 'issue-1',
    issue_key: 'ENG-42',
    issue_title: 'title',
    issue_url: 'https://linear.app/x/issue/ENG-42',
    state: 'queued',
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
    ...over,
  };
  const cols = Object.keys(row);
  db.prepare(
    `INSERT INTO runs (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
  ).run(...(cols.map((c) => row[c]) as never[]));
}

test('an empty database migrates to the latest version', () => {
  const db = fresh();
  assert.equal(readUserVersion(db), 0);

  const result = migrate(db);

  assert.equal(result.from, 0);
  assert.equal(result.to, LATEST);
  assert.deepEqual([...result.applied], [LATEST]);
  assert.equal(readUserVersion(db), LATEST);
});

test('exactly the five tables exist, and every declared index', () => {
  const db = fresh();
  migrate(db);

  assert.deepEqual(names(db, 'table'), ['deliveries', 'kv', 'questions', 'run_events', 'runs']);

  const indexes = names(db, 'index');
  for (const expected of [
    'idx_runs_state',
    'idx_runs_issue_id',
    'idx_runs_parent_run_id',
    'idx_runs_state_created',
    'idx_questions_status_deadline',
    'idx_questions_run_status',
    'idx_questions_comment_id',
    'idx_deliveries_received_at',
    'idx_run_events_run_at',
  ]) {
    assert.ok(indexes.includes(expected), `missing index ${expected}`);
  }
});

// ROADMAP Phase 1 success criterion 4.
test('a second migration applies nothing and leaves the version untouched', () => {
  const db = fresh();
  migrate(db);
  const tablesAfterFirst = names(db, 'table');

  const second = migrate(db);

  assert.deepEqual([...second.applied], []);
  assert.equal(second.from, LATEST);
  assert.equal(second.to, LATEST);
  assert.equal(readUserVersion(db), LATEST);
  assert.deepEqual(names(db, 'table'), tablesAfterFirst);
});

test('a delivery id can be inserted at most once', () => {
  const db = fresh();
  migrate(db);
  const insert = db.prepare('INSERT INTO deliveries (delivery_id, received_at) VALUES (?, ?)');

  insert.run('delivery-1', 1_700_000_000_000);

  assert.throws(() => insert.run('delivery-1', 1_700_000_000_001), /UNIQUE|constraint/i);
});

// D-04, enforced by the database rather than by convention.
test('a ticket-kind run cannot store a state, and a repo-kind run cannot omit one', () => {
  const db = fresh();
  migrate(db);

  assert.throws(() => insertRun(db, { kind: 'ticket', state: 'queued' }), /CHECK|constraint/i);
  assert.throws(() => insertRun(db, { kind: 'repo', state: null }), /CHECK|constraint/i);

  insertRun(db, { kind: 'ticket', state: null });
  insertRun(db, { kind: 'repo', state: 'running' });
});

test('a state outside the nine literals is rejected', () => {
  const db = fresh();
  migrate(db);

  assert.throws(() => insertRun(db, { state: 'parked' }), /CHECK|constraint/i);
});
