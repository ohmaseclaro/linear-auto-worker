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

const SIBLING_A = 'a1b2c3d4-1111-4111-8111-000000000001';
const SIBLING_B = 'e5f6a7b8-2222-4222-8222-000000000002';

/** Two ACTIVE runs of ONE ticket across two repos — what `config.ts:50` allows and the
 *  multi-repo product advertises. Deliberately not a widening of `workspace()`: every
 *  existing case above depends on its single-row shape. */
function siblingWorkspace(): { root: string } {
  const root = mkdtempSync(join(tmpdir(), 'law-say-'));
  const store = createSqliteStore(openStore(join(root, 'store.db')));
  const base: Omit<RunRow, 'id' | 'repoSlug'> = {
    parentRunId: null,
    kind: 'repo',
    issueId: 'issue-1',
    issueKey: 'COD-9',
    issueTitle: 't',
    issueUrl: 'https://linear.app/x/COD-9',
    repoDir: '/tmp/r',
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
  };
  store.insertRun({ ...base, id: SIBLING_A, repoSlug: 'dzfweb/miracle-shop' });
  store.insertRun({ ...base, id: SIBLING_B, repoSlug: 'ohmaseclaro/api' });
  store.close();
  return { root };
}

test('the ambiguity → retype → resolved loop closes through `runSay` itself', async () => {
  // The round trip is already a property of `resolve-run.ts`, and it is asserted again HERE
  // because a property proven inside the module is not proven on the path the operator
  // walks (T109). This drives the actual loop: `law say COD-9` fails, he copies a token off
  // the listing, types it back, and reaches one run.
  const { root } = siblingWorkspace();
  const injector = createInjector();
  const heard = new Map<string, string[]>();
  for (const id of [SIBLING_A, SIBLING_B]) {
    heard.set(id, []);
    injector.register(id, (text) => {
      (heard.get(id) as string[]).push(text);
      return true;
    });
  }
  const server = await serveInjections({ injector, root, log: silent });
  try {
    const listed: string[] = [];
    const code = await runSay({ root, target: 'COD-9', text: 'hi', print: (l) => listed.push(l) });
    assert.equal(code, 1);
    const tokens = listed
      .join('\n')
      .split('\n')
      .slice(1)
      .map((line) => line.trim().split(/\s+/)[0] as string);
    assert.equal(tokens.length, 2, `expected two candidates, got:\n${listed.join('\n')}`);

    for (const token of tokens) {
      const lines: string[] = [];
      const back = await runSay({ root, target: token, text: `for ${token}`, print: (l) => lines.push(l) });
      const out = lines.join('\n');
      assert.equal(back, 0, `the listing printed \`${token}\`; typing it back gave:\n${out}`);

      // And the `law watch` argument this success line suggests must ALSO be typeable —
      // it comes from the resolver, not from a second copy of the naming rule.
      const suggested = /`law watch (\S+)`/.exec(out)?.[1] as string;
      const again: string[] = [];
      const third = await runSay({ root, target: suggested, text: 'x', print: (l) => again.push(l) });
      assert.equal(
        third,
        0,
        `\`law say\` suggested \`law watch ${suggested}\`; that target gave:\n${again.join('\n')}`,
      );
    }

    // Two tokens, two different runs — not the same one twice.
    assert.equal((heard.get(SIBLING_A) as string[]).length, 2);
    assert.equal((heard.get(SIBLING_B) as string[]).length, 2);
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
