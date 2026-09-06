/**
 * `law status` against a real SQLite file — no store mock, because the thing most likely
 * to break here is a column name diverging from the schema (TRAPS T53: the store queried
 * `deliveries(id)` and `kv(key,value)` at `tsc` exit 0 while the migration had named them
 * `delivery_id` and `k`/`v`). Only a real round-trip catches that class.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { runStatus } from './status.js';
import { openStore } from '../infra/store/db.js';
import { createSqliteStore, type RunRow } from '../infra/store/sqlite-store.js';

const NOW = 1_700_000_000_000;

let root: string;
const lines: string[] = [];
const print = (line: string) => void lines.push(line);
const status = (r = root) => runStatus({ root: r, print, now: () => NOW });

function run(overrides: Partial<RunRow>): RunRow {
  return {
    id: 'run-0',
    parentRunId: null,
    // `repo`, not `ticket`: the schema's CHECK says a ticket-kind parent stores NO state,
    // so a ticket row can never appear in a state query. Only repo rows are units of work.
    kind: 'repo',
    // Every one of these is NOT NULL in the schema even though `RunRow` types them
    // nullable — the fixture matches the DATABASE, which is the stricter of the two.
    issueId: 'issue-0',
    issueKey: 'LAW-0',
    issueTitle: 'a ticket',
    issueUrl: 'https://linear.app/x/issue/LAW-0',
    repoDir: '/tmp/repo',
    repoSlug: 'org/api',
    branch: null,
    worktreePath: null,
    sessionId: null,
    pid: null,
    state: 'queued',
    attempt: 0,
    questionRound: 0,
    prUrl: null,
    failureReason: null,
    createdAt: NOW - 60_000,
    updatedAt: NOW - 60_000,
    ...overrides,
  };
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'law-status-'));
  // `law setup` is what normally creates this; the first case below asserts what happens
  // when it has NOT been run, against a path inside `root` that stays empty.
  openStore(join(root, 'store.db')).close();
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

test('no store yet: says so, points at setup, exits 1', () => {
  lines.length = 0;
  const missing = join(root, 'never-set-up');
  assert.equal(status(missing), 1);
  assert.match(lines.join('\n'), /run `law setup` first/);
});

test('empty store: exit 0 — an idle daemon is not an error', () => {
  lines.length = 0;
  assert.equal(status(), 0);
  assert.match(lines.join('\n'), /0 active run\(s\), 0 holding a concurrency slot/);
  assert.match(lines.join('\n'), /nothing has run yet/);
});

test('active runs: sorted newest-first, slot count excludes the parked run', () => {
  const db = openStore(join(root, 'store.db'));
  const store = createSqliteStore(db);
  store.insertRun(
    run({ id: 'r1', issueKey: 'LAW-1', issueTitle: 'oldest', state: 'queued', updatedAt: NOW - 300_000 }),
  );
  store.insertRun(
    run({
      id: 'r2',
      issueId: 'issue-2',
      issueKey: 'LAW-2',
      issueTitle: 'parked',
      state: 'awaiting_answer',
      updatedAt: NOW - 120_000,
    }),
  );
  store.insertRun(
    run({ id: 'r3', issueKey: 'LAW-3', issueTitle: 'newest', state: 'running', updatedAt: NOW - 30_000 }),
  );
  store.insertQuestion({
    id: 'q-abcdef12',
    runId: 'r2',
    text: 'Which auth provider should the callback trust?',
    assumption: 'assumed the existing one',
    linearCommentId: null,
    askedAt: NOW - 120_000,
    deadlineAt: NOW + 600_000,
    status: 'open',
    answer: null,
  });
  db.close();

  lines.length = 0;
  assert.equal(status(), 0);
  const out = lines.join('\n');

  // `running` holds a slot, `awaiting_answer` deliberately does not (types.ts HOLDS_SLOT).
  assert.match(out, /3 active run\(s\), 1 holding a concurrency slot/);
  assert.ok(
    out.indexOf('LAW-3') < out.indexOf('LAW-2') && out.indexOf('LAW-2') < out.indexOf('LAW-1'),
    'newest first, so the run that just moved is the one at the top of the terminal',
  );
  assert.match(out, /Which auth provider/, 'a parked run without its question is unactionable');
  assert.match(out, /10m left/);
});

test('a past deadline is called out, not rendered as a negative duration', () => {
  const db = openStore(join(root, 'store.db'));
  const store = createSqliteStore(db);
  store.updateQuestion('q-abcdef12', { deadlineAt: NOW - 1000 });
  db.close();

  lines.length = 0;
  status();
  assert.match(lines.join('\n'), /DEADLINE PASSED/);
});

test('once everything is terminal, the recent tail is shown instead', () => {
  const db = openStore(join(root, 'store.db'));
  const store = createSqliteStore(db);
  for (const id of ['r1', 'r2', 'r3']) store.updateRun(id, { state: 'delivered' });
  store.updateRun('r3', { prUrl: 'https://github.com/o/r/pull/9' });
  db.close();

  lines.length = 0;
  assert.equal(status(), 0);
  const out = lines.join('\n');
  assert.match(out, /0 active run\(s\)/);
  assert.match(out, /most recent 3:/);
  assert.match(out, /pull\/9/, 'the PR url is the whole point of a delivered run');
});
