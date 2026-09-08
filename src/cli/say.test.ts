/**
 * `law say`'s three refusals and its one success, against a real store and a real socket.
 *
 * Every branch here produces a line an operator reads at 2am, so the lines themselves are
 * the assertions — not just the exit codes.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createInjector, serveInjections } from '../execution/inject.js';
import { openStore } from '../infra/store/db.js';
import { createSqliteStore, type RunRow, type Store } from '../infra/store/sqlite-store.js';
import { runSay } from './say.js';
import type { Logger } from '../infra/logger.js';

const silent = {
  child: () => silent,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as unknown as Logger;

const RUN_ID = 'aaaa1111-2222';

function workspace(state: string): { root: string; store: Store } {
  const root = mkdtempSync(join(tmpdir(), 'law-say-'));
  const store = createSqliteStore(openStore(join(root, 'store.db')));
  const row: RunRow = {
    id: RUN_ID,
    parentRunId: null,
    kind: 'repo',
    issueId: 'issue-1',
    issueKey: 'LAW-9',
    issueTitle: 't',
    issueUrl: 'https://linear.app/x/LAW-9',
    repoDir: '/tmp/r',
    repoSlug: 'o/r',
    branch: 'b',
    worktreePath: null,
    sessionId: null,
    pid: null,
    state,
    attempt: 0,
    questionRound: 0,
    prUrl: null,
    failureReason: null,
    createdAt: 1,
    updatedAt: 1,
  };
  store.insertRun(row);
  store.close();
  return { root, store };
}

test('a finished run is refused with its state, and never exits 0', async () => {
  const { root } = workspace('delivered');
  const lines: string[] = [];
  const code = await runSay({ root, target: 'LAW-9', text: 'hi', print: (l) => lines.push(l) });
  assert.equal(code, 1);
  assert.match(lines.join('\n'), /already finished \(delivered\) — nothing to say to/);
  rmSync(root, { recursive: true, force: true });
});

test('a PARKED run is redirected to Linear, which is the durable channel', async () => {
  // The Q&A boundary, at the only place an operator meets it. An agent question IS a
  // `result` event, and stdin closes on a result — so by the time a question exists this
  // channel is already shut. The two paths are disjoint in time by construction.
  const { root } = workspace('awaiting_answer');
  const lines: string[] = [];
  const code = await runSay({ root, target: 'LAW-9', text: 'hi', print: (l) => lines.push(l) });
  assert.equal(code, 1);
  assert.match(lines.join('\n'), /parked awaiting an answer — reply to the bot's comment on LAW-9/);
  rmSync(root, { recursive: true, force: true });
});

test('a live run with no daemon says so rather than hanging', async () => {
  const { root } = workspace('running');
  const lines: string[] = [];
  const code = await runSay({ root, target: 'LAW-9', text: 'hi', print: (l) => lines.push(l) });
  assert.equal(code, 1);
  assert.match(lines.join('\n'), /daemon is not running/);
  rmSync(root, { recursive: true, force: true });
});

test('FLAG-C: a delivered message reports QUEUED, not sent, and points at `law watch`', async () => {
  // `injector.send` returning ok means the bytes were accepted by the pipe, NOT that the
  // agent consumed them. The only proof of consumption is the CLI replaying the message
  // back, which is what `law watch` shows. Saying "sent" would claim what this process
  // cannot know.
  const { root } = workspace('running');
  const injector = createInjector();
  const said: string[] = [];
  injector.register(RUN_ID, (text) => {
    said.push(text);
    return true;
  });
  const server = await serveInjections({ injector, root, log: silent });
  try {
    const lines: string[] = [];
    const code = await runSay({
      root,
      target: 'LAW-9',
      text: 'stop and run the tests',
      print: (l) => lines.push(l),
    });
    assert.equal(code, 0);
    assert.deepEqual(said, ['stop and run the tests']);
    assert.match(lines.join('\n'), /^queued to LAW-9 o\/r — `law watch LAW-9` to see it land$/);
    assert.ok(!lines.join('\n').includes('sent to'), 'must not claim delivery it cannot see');
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a run whose turn has ended is told so, rather than told ok', async () => {
  const { root } = workspace('running');
  const injector = createInjector();
  injector.register(RUN_ID, () => false);
  const server = await serveInjections({ injector, root, log: silent });
  try {
    const lines: string[] = [];
    const code = await runSay({ root, target: 'LAW-9', text: 'too late', print: (l) => lines.push(l) });
    assert.equal(code, 1);
    assert.match(lines.join('\n'), /no longer accepting input/);
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
