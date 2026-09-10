/**
 * `renderEvent` per branch, and `runWatch` end to end against a real temp root.
 *
 * `print` is injected for the reason `status.ts` records: a `node --test` child shares its
 * stdout with the runner, and a test that logs into it corrupts the TAP stream.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { openStore } from '../infra/store/db.js';
import { createSqliteStore, type RunRow } from '../infra/store/sqlite-store.js';
import { runLogDir, runLogPath } from '../execution/run-log.js';
import { renderEvent, runWatch } from './watch.js';

// ── renderEvent ───────────────────────────────────────────────────────────────

test('system/init renders the session, the skill count and the mode', () => {
  assert.equal(
    renderEvent({
      type: 'system',
      subtype: 'init',
      session_id: '8f14e045-fceb-4dc7',
      skills: ['a', 'b'],
      permissionMode: 'dontAsk',
    }),
    'session 8f14e045 · 2 skills · dontAsk',
  );
});

test('an assistant text block renders its text; a tool_use renders a digest', () => {
  assert.equal(
    renderEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'on it' }] } }),
    'on it',
  );
  assert.equal(
    renderEvent({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: 'a.ts' } }] },
    }),
    '⚙ Write {"file_path":"a.ts"}',
  );
});

test('a user tool_result renders ↳ and a replayed user message renders » (M11)', () => {
  assert.equal(
    renderEvent({
      type: 'user',
      message: { content: [{ type: 'tool_result', content: 'File created\nmore' }] },
    }),
    '↳ File created',
  );
  assert.equal(
    renderEvent({
      type: 'user',
      message: { content: [{ type: 'text', text: 'stop and run the tests' }] },
    }),
    '» stop and run the tests',
    'the operator\'s own words, so `law watch` shows both halves of the conversation',
  );
});

test('the summaries, a denial, a result, and the two law.* markers each render', () => {
  assert.equal(
    renderEvent({ type: 'system', subtype: 'task_summary', detail: 'Writing parser' }),
    '· Writing parser',
  );
  assert.equal(
    renderEvent({ type: 'system', subtype: 'post_turn_summary', status_detail: 'Wrote 1 file' }),
    '· Wrote 1 file',
  );
  assert.equal(
    renderEvent({ type: 'system', subtype: 'permission_denied', tool_name: 'Bash' }),
    '✗ denied Bash',
  );
  assert.equal(
    renderEvent({ type: 'result', subtype: 'success', num_turns: 3, total_cost_usd: 0.24 }),
    '── result success turns=3 $0.2400',
  );
  assert.match(renderEvent({ type: 'law.truncated', bytes: 99 }) ?? '', /size cap/);
  assert.match(renderEvent({ type: 'law.badline', line: 'not json' }) ?? '', /unparseable/);
});

test('an unknown event type, a null detail and a non-object are all null', () => {
  assert.equal(renderEvent({ type: 'system', subtype: 'hook_started' }), null);
  assert.equal(renderEvent({ type: 'system', subtype: 'task_summary', detail: null }), null);
  assert.equal(renderEvent({ type: 'rate_limit_event' }), null);
  assert.equal(renderEvent('nonsense'), null);
  assert.equal(renderEvent(null), null);
  assert.equal(renderEvent({ type: 'assistant', message: { content: 'not an array' } }), null);
});

test('FLAG-F: control characters in agent output do not reach the terminal', () => {
  // The agent has been reading attacker-controlled ticket text all run (T99). An ANSI
  // escape here would let that text rewrite the operator's scrollback and forge this
  // command's own status lines — a run could print its own `── result success`.
  const attack = '\u001B[2Kfake\u001B[1;31m';
  const rendered = renderEvent({
    type: 'assistant',
    message: { content: [{ type: 'text', text: attack }] },
  });
  assert.ok(rendered !== null);
  assert.ok(!rendered.includes('\u001B'), 'ESC survived into the rendered line');
  assert.equal(rendered, '[2Kfake[1;31m');
});

test('a very long line is truncated rather than wrapped across the terminal', () => {
  const rendered = renderEvent({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'x'.repeat(500) }] },
  });
  assert.ok(rendered !== null);
  assert.ok(rendered.length <= 160);
  assert.ok(rendered.endsWith('…'));
});

// ── runWatch, end to end ──────────────────────────────────────────────────────

function workspace(): { root: string; store: ReturnType<typeof createSqliteStore> } {
  const root = mkdtempSync(join(tmpdir(), 'law-watch-'));
  const store = createSqliteStore(openStore(join(root, 'store.db')));
  return { root, store };
}

function seed(store: ReturnType<typeof createSqliteStore>, o: Partial<RunRow>): RunRow {
  const run: RunRow = {
    id: 'aaaa1111-2222',
    parentRunId: null,
    kind: 'repo',
    issueId: 'issue-1',
    issueKey: 'LAW-9',
    issueTitle: 't',
    issueUrl: 'https://linear.app/x/LAW-1',
    repoDir: '/tmp/r',
    repoSlug: 'o/r',
    branch: 'b',
    worktreePath: null,
    sessionId: null,
    pid: null,
    state: 'delivered',
    attempt: 0,
    questionRound: 0,
    prUrl: null,
    failureReason: null,
    createdAt: 1,
    updatedAt: 1,
    ...o,
  };
  store.insertRun(run);
  return run;
}

test('a finished run replays its whole log and exits 0 with a footer', async () => {
  const { root, store } = workspace();
  const run = seed(store, { prUrl: 'https://github.com/o/r/pull/7' });
  store.close();

  mkdirSync(runLogDir(root), { recursive: true });
  writeFileSync(
    runLogPath(root, run.id),
    [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess', skills: ['a'], permissionMode: 'dontAsk' }),
      JSON.stringify({ type: 'system', subtype: 'hook_started' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } }),
      JSON.stringify({ type: 'result', subtype: 'success', num_turns: 2, total_cost_usd: 0.5 }),
    ].join('\n') + '\n',
  );

  const lines: string[] = [];
  // Named, not defaulted: with no target `law watch` follows the ACTIVE run, and this one
  // has finished. Replaying a finished run means naming it.
  const code = await runWatch({ root, target: 'LAW-9', print: (l) => lines.push(l), pollMs: 1 });
  assert.equal(code, 0);
  assert.deepEqual(lines, [
    'session sess · 1 skills · dontAsk',
    'working',
    '── result success turns=2 $0.5000',
    '── delivered LAW-9 o/r https://github.com/o/r/pull/7',
  ]);
  rmSync(root, { recursive: true, force: true });
});

test('a finished run with no log prints one actionable line and exits 1', async () => {
  const { root, store } = workspace();
  seed(store, {});
  store.close();

  const lines: string[] = [];
  const code = await runWatch({ root, target: 'LAW-9', print: (l) => lines.push(l), pollMs: 1 });
  assert.equal(code, 1);
  assert.match(lines.join('\n'), /no activity log/);
  rmSync(root, { recursive: true, force: true });
});

test('a target that resolves to nothing exits 1 without touching the filesystem', async () => {
  const { root, store } = workspace();
  seed(store, {});
  store.close();

  const lines: string[] = [];
  const code = await runWatch({ root, target: 'LAW-404', print: (l) => lines.push(l), pollMs: 1 });
  assert.equal(code, 1);
  assert.match(lines.join('\n'), /no run matching/);
  rmSync(root, { recursive: true, force: true });
});

test('no store at all is exit 1 with the setup line, not a stack trace', async () => {
  const root = mkdtempSync(join(tmpdir(), 'law-watch-empty-'));
  const lines: string[] = [];
  const code = await runWatch({ root, print: (l) => lines.push(l) });
  assert.equal(code, 1);
  assert.match(lines[0] ?? '', /law setup/);
  rmSync(root, { recursive: true, force: true });
});

test('a live run is followed: appended lines are picked up, and the terminal state ends it', async () => {
  const { root, store } = workspace();
  const run = seed(store, { state: 'running' });
  const file = runLogPath(root, run.id);
  mkdirSync(runLogDir(root), { recursive: true });
  writeFileSync(file, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'one' }] } }) + '\n');

  const lines: string[] = [];
  const watching = runWatch({ root, print: (l) => lines.push(l), pollMs: 5 });

  // Appended AFTER the first read, and deliberately in two writes that split a JSON
  // object mid-line — the case `makeLineParser` exists for.
  await new Promise((r) => setTimeout(r, 40));
  const second = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'two' }] } });
  const { appendFileSync } = await import('node:fs');
  appendFileSync(file, second.slice(0, 20));
  await new Promise((r) => setTimeout(r, 20));
  appendFileSync(file, second.slice(20) + '\n');
  await new Promise((r) => setTimeout(r, 20));

  const live = createSqliteStore(openStore(join(root, 'store.db')));
  live.updateRun(run.id, { state: 'failed', failureReason: 'it broke\nsecond line' });
  live.close();

  const code = await watching;
  assert.equal(code, 0);
  assert.deepEqual(lines, ['one', 'two', '── failed LAW-9 o/r it broke']);
  rmSync(root, { recursive: true, force: true });
});

// ── the shared session, reached from any of a ticket's rows ───────────────────

/** A ticket parent and three children; only the lead has a session and a log. */
function seedTicket(store: ReturnType<typeof createSqliteStore>) {
  const parent = seed(store, { id: 'p0000000-0000', kind: 'ticket', state: null, repoSlug: null, branch: null });
  const lead = seed(store, {
    id: 'c1111111-1111',
    parentRunId: parent.id,
    repoSlug: 'o/api',
    sessionId: 'sess-lead',
    state: 'running',
    issueKey: 'LAW-9',
  });
  const sibling = seed(store, {
    id: 'c2222222-2222',
    parentRunId: parent.id,
    repoSlug: 'o/web',
    state: 'running',
    issueKey: 'LAW-9',
  });
  seed(store, {
    id: 'c3333333-3333',
    parentRunId: parent.id,
    repoSlug: 'o/infra',
    state: 'delivered',
    issueKey: 'LAW-9',
  });
  return { lead, sibling };
}

test('`law watch` on a SIBLING follows the shared session and says whose it is', async () => {
  const { root, store } = workspace();
  const { lead, sibling } = seedTicket(store);
  store.close();

  mkdirSync(runLogDir(root), { recursive: true });
  writeFileSync(
    runLogPath(root, lead.id),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } }) + '\n',
  );

  const lines: string[] = [];
  // Watch the sibling, which has no log of its own. At HEAD this reported there was no
  // activity log for it — true of that ROW and useless as an answer.
  const watching = runWatch({ root, target: sibling.id.slice(0, 8), print: (l) => lines.push(l), pollMs: 5 });
  await new Promise((r) => setTimeout(r, 60));
  const live = createSqliteStore(openStore(join(root, 'store.db')));
  live.updateRun(lead.id, { state: 'delivered' });
  live.close();
  await watching;

  assert.match(lines[0]!, /following LAW-9 o\/api's session/, 'the redirect is announced, never silent');
  assert.match(lines[0]!, /o\/web/);
  assert.match(lines[0]!, /o\/infra/);
  assert.ok(lines.includes('working'), 'and it really followed the shared log');
  rmSync(root, { recursive: true, force: true });
});

test('`law watch` on the session OWNER, and on a single-repo run, prints no redirect', async () => {
  const { root, store } = workspace();
  const { lead } = seedTicket(store);
  store.close();
  mkdirSync(runLogDir(root), { recursive: true });
  writeFileSync(runLogPath(root, lead.id), JSON.stringify({ type: 'result', subtype: 'success', num_turns: 1, total_cost_usd: 0 }) + '\n');

  const lines: string[] = [];
  const watching = runWatch({ root, target: lead.id.slice(0, 8), print: (l) => lines.push(l), pollMs: 5 });
  await new Promise((r) => setTimeout(r, 40));
  const live = createSqliteStore(openStore(join(root, 'store.db')));
  live.updateRun(lead.id, { state: 'delivered' });
  live.close();
  await watching;

  assert.ok(!lines.some((l) => l.includes('session, shared with')), 'no redirect to announce');
  rmSync(root, { recursive: true, force: true });
});
