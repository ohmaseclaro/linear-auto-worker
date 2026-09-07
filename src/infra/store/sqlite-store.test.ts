// Originally written under RUSH mode against `openStore()`/`runMigrations()` with nothing
// installed, and verified by inspection only. It runs for real now; `runMigrations` is gone
// (there is one migration runner again — see `db.ts`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from './db.js';
import { migrate } from './migrate.js';
import { MIGRATIONS } from './migrations/index.js';
import { createSqliteStore } from './sqlite-store.js';
import type { RunRow, QuestionRow } from './sqlite-store.js';

function freshStore() {
  const db = openStore(':memory:');
  return { db, store: createSqliteStore(db) };
}

function makeRun(overrides: Partial<RunRow> = {}): RunRow {
  return {
    id: `run-${Math.random().toString(36).slice(2)}`,
    parentRunId: null,
    kind: 'repo',
    issueId: 'ENG-1',
    issueKey: 'ENG-1',
    issueTitle: 'Test issue',
    issueUrl: 'https://linear.app/eng/issue/ENG-1',
    repoDir: '/tmp/repo',
    repoSlug: 'org/repo',
    branch: 'eng-1',
    worktreePath: null,
    sessionId: null,
    pid: null,
    state: 'queued',
    attempt: 0,
    questionRound: 0,
    prUrl: null,
    failureReason: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeQuestion(overrides: Partial<QuestionRow> = {}): QuestionRow {
  return {
    id: `q-${Math.random().toString(36).slice(2)}`,
    runId: 'run-x',
    text: 'Which env?',
    assumption: 'staging',
    linearCommentId: null,
    askedAt: Date.now(),
    deadlineAt: Date.now() + 1000,
    status: 'open',
    answer: null,
    ...overrides,
  };
}

test('migrate() twice against the same file is a no-op the second time (D-10)', () => {
  const db = openStore(':memory:');
  const versionAfterOpen = db.pragma('user_version', { simple: true });
  assert.doesNotThrow(() => migrate(db));
  const versionAfterSecondRun = db.pragma('user_version', { simple: true });
  assert.equal(versionAfterSecondRun, versionAfterOpen);
});

test('openStore() sets WAL journal mode and a 5000ms busy timeout (OPS-02)', () => {
  // A FILE, not `:memory:` (TRAPS T75). SQLite reports `journal_mode = 'memory'` for an
  // in-memory database BY DEFINITION — there is no file to write a -wal alongside — so this
  // assertion could never have passed against `freshStore()`, and OPS-02's WAL requirement
  // was therefore never actually verified until 07-06 ran the suite.
  const dir = mkdtempSync(join(tmpdir(), 'law-wal-'));
  try {
    const db = openStore(join(dir, 'store.db'));
    try {
      assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
      assert.equal(db.pragma('busy_timeout', { simple: true }), 5000);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recordDelivery() is dedupe-safe: true once, false on repeat, one row total', () => {
  const { db, store } = freshStore();
  assert.equal(store.recordDelivery('delivery-1', Date.now()), true);
  assert.equal(store.recordDelivery('delivery-1', Date.now()), false);
  const count = db.prepare('SELECT COUNT(*) AS n FROM deliveries WHERE delivery_id = ?').get('delivery-1') as {
    n: number;
  };
  assert.equal(count.n, 1);
});

test('insertRun -> updateRun -> getRun round-trips, and the schema rejects a non-state', () => {
  const { store } = freshStore();
  const run = makeRun({ id: 'run-1', state: 'queued' });
  store.insertRun(run);

  // The store performs no TRANSITION-LEGALITY check — that is Phase 6's
  // `RunEngine.transition()`, not this file — so an illegal-but-real jump is written
  // without complaint.
  store.updateRun('run-1', { state: 'delivered' });
  assert.equal(store.getRun('run-1')?.state, 'delivered');

  store.updateRun('run-1', { state: 'preparing' });
  const preparing = store.getRun('run-1');
  assert.equal(preparing?.state, 'preparing');
  assert.equal(preparing?.id, 'run-1');

  // What it DOES enforce is membership, at the schema: Phase 1's migration carries a CHECK
  // constraint listing the nine states. The original form of this case asserted the
  // opposite ("any string round-trips") and was written before that constraint landed —
  // the constraint is the better contract, so the assertion is inverted rather than the
  // schema relaxed.
  assert.throws(
    () => store.updateRun('run-1', { state: 'not-a-real-state' }),
    /CHECK constraint failed/,
  );
  assert.equal(store.getRun('run-1')?.state, 'preparing', 'the rejected write changed nothing');
});

test('findActiveRunByIssue: terminal-value filter, not a transition check', () => {
  const { store } = freshStore();
  store.insertRun(makeRun({ id: 'run-active', issueId: 'ENG-9', state: 'running' }));
  store.insertRun(makeRun({ id: 'run-done', issueId: 'ENG-8', state: 'delivered' }));

  const active = store.findActiveRunByIssue('ENG-9');
  assert.equal(active.length, 1);
  assert.equal(active[0]?.id, 'run-active');
  assert.deepEqual(store.findActiveRunByIssue('ENG-8'), []);
});

test('findRunsByIssue: the history question — every row for the issue, terminals included', () => {
  const { store } = freshStore();
  store.insertRun(makeRun({ id: 'run-open', issueId: 'ENG-9', state: 'queued' }));
  store.insertRun(makeRun({ id: 'run-done', issueId: 'ENG-9', state: 'delivered' }));
  store.insertRun(makeRun({ id: 'run-other', issueId: 'ENG-8', state: 'delivered' }));

  assert.deepEqual(
    store
      .findRunsByIssue('ENG-9')
      .map((r) => r.id)
      .sort(),
    ['run-done', 'run-open'],
    'history: every row, terminal or not',
  );
  assert.equal(store.findActiveRunByIssue('ENG-9').length, 1, 'liveness: only the queued one');
  assert.equal(
    store.findRunsByIssue('ENG-9').some((r) => r.id === 'run-other'),
    false,
    "another issue's run is in neither answer",
  );
  assert.deepEqual(store.findActiveRunByIssue('ENG-8'), []);
});

test('listByState() and nextQueued() filter and cap as named', () => {
  const { store } = freshStore();
  store.insertRun(makeRun({ id: 'run-a', state: 'queued', createdAt: 1 }));
  store.insertRun(makeRun({ id: 'run-b', state: 'queued', createdAt: 2 }));
  store.insertRun(makeRun({ id: 'run-c', state: 'running', createdAt: 3 }));

  const queuedAndRunning = store.listByState('queued', 'running');
  assert.equal(queuedAndRunning.length, 3);

  const nextOne = store.nextQueued(1);
  assert.equal(nextOne.length, 1);
  assert.equal(nextOne[0]?.id, 'run-a');
});

test('insertQuestion, openQuestionsForIssue, expiredQuestions, updateQuestion round-trip', () => {
  const { store } = freshStore();
  store.insertRun(makeRun({ id: 'run-q1', issueId: 'ENG-5' }));
  const q = makeQuestion({ id: 'q-1', runId: 'run-q1', deadlineAt: 100 });
  store.insertQuestion(q);

  const open = store.openQuestionsForIssue('ENG-5');
  assert.equal(open.length, 1);
  assert.equal(open[0]?.id, 'q-1');

  const expired = store.expiredQuestions(200);
  assert.equal(expired.length, 1);
  assert.equal(expired[0]?.id, 'q-1');
  assert.equal(store.expiredQuestions(50).length, 0);

  store.updateQuestion('q-1', { status: 'answered', answer: 'staging' });
  const after = store.getQuestion('q-1');
  assert.equal(after?.status, 'answered');
  assert.equal(after?.answer, 'staging');
});

test('appendRunEvent() -> listRunEvents() returns events in insertion order', () => {
  const { store } = freshStore();
  store.insertRun(makeRun({ id: 'run-ev' }));
  store.appendRunEvent({ runId: 'run-ev', from: null, to: 'queued', at: 1, detail: 'created' });
  store.appendRunEvent({ runId: 'run-ev', from: 'queued', to: 'preparing', at: 2, detail: null });

  const events = store.listRunEvents('run-ev');
  assert.equal(events.length, 2);
  assert.deepEqual(
    events.map((e) => [e.from, e.to]),
    [
      [null, 'queued'],
      ['queued', 'preparing'],
    ]
  );
});

test('kvSet()/kvGet() round-trips a string value', () => {
  const { store } = freshStore();
  assert.equal(store.kvGet('missing'), undefined);
  store.kvSet('webhook-secret', 'abc123');
  assert.equal(store.kvGet('webhook-secret'), 'abc123');
  store.kvSet('webhook-secret', 'def456');
  assert.equal(store.kvGet('webhook-secret'), 'def456');
});

test('idx_runs_state and idx_questions_status_deadline exist', () => {
  const { db } = freshStore();
  const names = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
    .all()
    .map((row) => (row as { name: string }).name);
  assert.ok(names.includes('idx_runs_state'));
  assert.ok(names.includes('idx_questions_status_deadline'));
});

test('three sequential writers against one WAL/busy-timeout handle complete without a locking exception (OPS-02)', () => {
  const { store } = freshStore();
  assert.doesNotThrow(() => {
    store.insertRun(makeRun({ id: 'run-w1' }));
    store.insertRun(makeRun({ id: 'run-w2' }));
    store.insertRun(makeRun({ id: 'run-w3' }));
  });
  assert.equal(store.listByState('queued').length, 3);
});

test('openStore applies EVERY migration in the list, not just the first', () => {
  // The check that would have caught the real defect gap D6 walked into. `db.ts` carried a
  // SECOND, duplicate migration runner with its own hardcoded `[migration001]`, and
  // `openStore` used that one — so adding migration 002 to `migrations/index.ts`, the list
  // `migrate.test.ts`'s eight cases exercise, changed nothing at all. `tsc` passed, every
  // test passed, and the column did not exist.
  const dir = mkdtempSync(join(tmpdir(), 'law-openstore-'));
  const db = openStore(join(dir, 'store.db'));
  try {
    assert.equal(
      db.pragma('user_version', { simple: true }),
      MIGRATIONS[MIGRATIONS.length - 1]!.version,
      'openStore left the database behind the newest migration — it is reading a different list',
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
