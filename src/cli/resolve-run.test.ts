/**
 * Target resolution, against a real SQLite file seeded the way `usage.test.ts` does.
 *
 * The ambiguous cases are the point. `questions.ts:88-91` records what recency-based
 * matching costs the day two runs share a ticket, so "several matches" must be an ERROR
 * that names the candidates, never a guess.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { openStore } from '../infra/store/db.js';
import { createSqliteStore, type RunRow, type Store } from '../infra/store/sqlite-store.js';
import { ACTIVE, resolveRunTarget } from './resolve-run.js';

const dir = mkdtempSync(join(tmpdir(), 'law-resolve-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));

function row(o: Partial<RunRow> & { id: string }): RunRow {
  return {
    parentRunId: null,
    kind: 'repo',
    issueId: 'issue-1',
    issueKey: 'LAW-1',
    issueTitle: 't',
    issueUrl: 'https://linear.app/x/LAW-1',
    repoDir: '/tmp/r',
    repoSlug: 'o/r',
    branch: 'b',
    worktreePath: null,
    sessionId: null,
    pid: null,
    state: 'running',
    attempt: 0,
    questionRound: 0,
    prUrl: null,
    failureReason: null,
    createdAt: 1,
    updatedAt: 1,
    ...o,
  };
}

/** A fresh database per case: resolution reads the WHOLE table, so leftovers change answers. */
function storeWith(...rows: RunRow[]): Store {
  const file = join(dir, `${Math.random().toString(36).slice(2)}.db`);
  const store = createSqliteStore(openStore(file));
  for (const r of rows) store.insertRun(r);
  return store;
}

test('the ACTIVE list is the five non-terminal states', () => {
  assert.deepEqual([...ACTIVE], [
    'queued',
    'preparing',
    'running',
    'awaiting_answer',
    'delivering',
  ]);
});

test('no target, one active run: that run', () => {
  const store = storeWith(row({ id: 'aaaa1111-0000-0000-0000-000000000000' }));
  const result = resolveRunTarget(store);
  assert.ok('run' in result);
  assert.equal(result.run.id, 'aaaa1111-0000-0000-0000-000000000000');
  store.close();
});

test('no target, nothing active: an actionable error, not a throw', () => {
  const store = storeWith(row({ id: 'dead1111', state: 'delivered' }));
  const result = resolveRunTarget(store);
  assert.ok('error' in result);
  assert.match(result.error, /no active run/);
  store.close();
});

test('no target, several active: the error NAMES every candidate', () => {
  const store = storeWith(
    row({ id: 'aaaa1111', issueKey: 'LAW-1', repoSlug: 'o/api' }),
    row({ id: 'bbbb2222', issueKey: 'LAW-2', repoSlug: 'o/web', state: 'preparing' }),
  );
  const result = resolveRunTarget(store);
  assert.ok('error' in result);
  // Typeable straight back in. An error that says "ambiguous" and stops is a second
  // command the operator has to compose by hand.
  assert.match(result.error, /LAW-1 o\/api running/);
  assert.match(result.error, /LAW-2 o\/web preparing/);
  store.close();
});

test('an exact id, a case-insensitive issue key, and a 4+ char id prefix all resolve', () => {
  const store = storeWith(row({ id: 'abcd1234-ffff', issueKey: 'LAW-42' }));
  for (const target of ['abcd1234-ffff', 'LAW-42', 'law-42', 'abcd']) {
    const result = resolveRunTarget(store, target);
    assert.ok('run' in result, `${target} did not resolve`);
    assert.equal(result.run.id, 'abcd1234-ffff');
  }
  store.close();
});

test('a 3-character prefix is below the floor and does not match', () => {
  const store = storeWith(row({ id: 'abcd1234', issueKey: 'LAW-42' }));
  const result = resolveRunTarget(store, 'abc');
  assert.ok('error' in result);
  store.close();
});

test('a LIVE run beats a finished one sharing the ticket', () => {
  const store = storeWith(
    row({ id: 'old00000', issueKey: 'LAW-7', state: 'delivered', updatedAt: 9_000 }),
    row({ id: 'new00000', issueKey: 'LAW-7', state: 'running', updatedAt: 1_000 }),
  );
  const result = resolveRunTarget(store, 'LAW-7');
  assert.ok('run' in result);
  // Deliberately NOT the most recently updated one — the live run wins on liveness, and
  // the seed puts the terminal row later on purpose so recency would give the wrong answer.
  assert.equal(result.run.id, 'new00000');
  store.close();
});

test('two ACTIVE runs on one ticket is an error that lists both', () => {
  const store = storeWith(
    row({ id: 'aaaa1111', issueKey: 'LAW-7', repoSlug: 'o/api' }),
    row({ id: 'bbbb2222', issueKey: 'LAW-7', repoSlug: 'o/web' }),
  );
  const result = resolveRunTarget(store, 'LAW-7');
  assert.ok('error' in result);
  assert.match(result.error, /o\/api/);
  assert.match(result.error, /o\/web/);
  store.close();
});

test('a target matching nothing says so and points at `law status`', () => {
  const store = storeWith(row({ id: 'aaaa1111', issueKey: 'LAW-1' }));
  const result = resolveRunTarget(store, 'LAW-999');
  assert.ok('error' in result);
  assert.match(result.error, /law status/);
  store.close();
});

test('a finished run resolves when nothing live shares its key', () => {
  const store = storeWith(row({ id: 'dead1111', issueKey: 'LAW-5', state: 'delivered' }));
  const result = resolveRunTarget(store, 'LAW-5');
  assert.ok('run' in result);
  assert.equal(result.run.state, 'delivered');
  store.close();
});

// ---------------------------------------------------------------------------------------
// The round trip. Every line the listing prints must itself be a target that resolves to
// exactly ONE run, and different lines must resolve to different runs — otherwise the
// error that exists to disambiguate is a dead end. Asserting the FORMAT of the listing
// cannot see this defect; only feeding the output back in as input can.
// ---------------------------------------------------------------------------------------

/** Resolves every line of an ambiguity listing back through the resolver. Returns the ids. */
function roundTrip(store: Store, target?: string): string[] {
  const result = resolveRunTarget(store, target);
  assert.ok('error' in result, 'expected an ambiguity listing, got a run');
  const lines = result.error.split('\n').slice(1); // drop the header
  assert.ok(lines.length > 1, `expected several candidates, got:\n${result.error}`);
  const ids = lines.map((line) => {
    const token = line.trim().split(/\s+/)[0] as string;
    const back = resolveRunTarget(store, token);
    assert.ok(
      'run' in back,
      `the listing printed \`${token}\`; feeding it back gave: ` +
        `${'error' in back ? back.error : ''}`,
    );
    return back.run.id;
  });
  assert.equal(
    new Set(ids).size,
    ids.length,
    `two printed lines resolved to the SAME run: ${ids.join(', ')}`,
  );
  return ids;
}

const SIBLINGS = [
  row({
    id: 'a1b2c3d4-1111-4111-8111-000000000001',
    issueKey: 'COD-9',
    repoSlug: 'dzfweb/miracle-shop',
  }),
  row({
    id: 'e5f6a7b8-2222-4222-8222-000000000002',
    issueKey: 'COD-9',
    repoSlug: 'ohmaseclaro/api',
  }),
];

test('ambiguous target: every line the listing prints resolves to exactly one run', () => {
  // One ticket mapped to two repos is two ACTIVE runs sharing an issue key —
  // `config.ts:50` allows it and `status.ts:43-48` documents it. Retyping the key must
  // not reproduce the identical error.
  const store = storeWith(...SIBLINGS);
  const ids = roundTrip(store, 'COD-9');
  assert.equal(ids.length, 2);
  store.close();
});

test('no target: every line the listing prints resolves to exactly one run (siblings)', () => {
  const store = storeWith(...SIBLINGS);
  const ids = roundTrip(store);
  assert.equal(ids.length, 2);
  store.close();
});

test('no target: the same holds for two runs sharing a REPO across two tickets', () => {
  // The mirror image. Distinct keys already round-trip, so this passes at HEAD by
  // construction — it is the non-regression proving the id-prefix branch closes the
  // same-repo ambiguity without adding `repoSlug` as a fourth accepted target form.
  const store = storeWith(
    row({ id: 'c1c1c1c1-3333-4333-8333-000000000003', issueKey: 'LAW-1', repoSlug: 'o/api' }),
    row({
      id: 'd2d2d2d2-4444-4444-8444-000000000004',
      issueKey: 'LAW-2',
      repoSlug: 'o/api',
      state: 'preparing',
    }),
  );
  const ids = roundTrip(store);
  assert.equal(ids.length, 2);
  store.close();
});
