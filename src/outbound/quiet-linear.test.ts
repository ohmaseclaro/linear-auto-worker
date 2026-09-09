/**
 * The silence gate, at the client.
 *
 * These prove the DECORATOR. They cannot prove the WIRING — a wrapper that returns the
 * same interface still compiles when the composition root stops calling it, which is why
 * `run-engine.test.ts` carries the engine-level half and why T109's procedure names this
 * file as the suite that must stay GREEN while that one goes RED.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeLinearClient } from '../domain/fakes.js';
import type { Config, Logger } from '../domain/ports.js';
import { quietLinear, assertInstanceLevelToggles } from './quiet-linear.js';

interface Line {
  fields: Record<string, unknown>;
  msg: string | undefined;
}

function recordingLog(): { log: Logger; lines: Line[] } {
  const lines: Line[] = [];
  const log: Logger = {
    child: () => log,
    info: (fields: unknown, msg?: string) => {
      lines.push({ fields: fields as Record<string, unknown>, msg });
    },
    warn: () => {},
    error: () => {},
    debug: () => {},
  };
  return { log, lines };
}

const ISSUE = {
  id: 'issue-1',
  identifier: 'LAW-1',
  title: 'A ticket',
  description: null,
  url: 'https://linear.app/x/issue/LAW-1',
  branchName: 'law-1',
  assigneeId: 'bot',
  projectId: null,
  teamId: 'team-1',
  stateId: 'state-todo',
  stateType: 'unstarted',
  updatedAt: new Date().toISOString(),
};

function wrap(toggles: { postLinearComments: boolean; updateLinearIssue: boolean }) {
  const inner = new FakeLinearClient({ issues: [ISSUE] });
  const { log, lines } = recordingLog();
  return { inner, lines, quiet: quietLinear(inner, toggles, log) };
}

const BOTH_ON = { postLinearComments: true, updateLinearIssue: true };
const BOTH_OFF = { postLinearComments: false, updateLinearIssue: false };

test('with comments off, createComment writes nothing and still returns a usable id', async () => {
  const { inner, quiet } = wrap({ postLinearComments: false, updateLinearIssue: true });

  const first = await quiet.createComment('issue-1', 'picked up');
  const second = await quiet.createComment('issue-1', 'done');

  assert.equal(inner.comments.length, 0, 'nothing reached Linear');
  assert.ok(first.id.length > 0, 'run-engine.ts:329 writes this to kv');
  assert.notEqual(first.id, second.id, 'question correlation needs DISTINCT ids');
});

test('a suppressed comment id can never collide with a real Linear comment id', async () => {
  const { quiet } = wrap(BOTH_OFF);
  const { id } = await quiet.createComment('issue-1', 'x');
  assert.match(id, /^suppressed-comment-/);
});

test('with comments off, updateComment records nothing and does not throw', async () => {
  const { inner, quiet } = wrap(BOTH_OFF);
  // The real fake REJECTS an unknown comment id. Handing it the synthetic id the suppressed
  // create returned is exactly what `refreshQueuePositions` would do, so this is the case
  // that would surface as an unhandled rejection if the gate were create-only.
  const { id } = await quiet.createComment('issue-1', 'queued, position 2');
  await quiet.updateComment(id, 'queued, position 1');
  assert.equal(inner.comments.length, 0);
});

test('comments off does not silence issue writes — the two toggles are independent', async () => {
  const { inner, quiet } = wrap({ postLinearComments: false, updateLinearIssue: true });
  await quiet.setIssueState('issue-1', 'started');
  await quiet.addSubscriber('issue-1', 'operator-1');
  assert.deepEqual(inner.stateChanges, [{ id: 'issue-1', stateType: 'started' }]);
  assert.equal(inner.subscribers.length, 1);
});

test('with issue mutation off, neither the state change nor the subscribe reaches Linear', async () => {
  const { inner, quiet } = wrap({ postLinearComments: true, updateLinearIssue: false });
  await quiet.setIssueState('issue-1', 'started');
  await quiet.addSubscriber('issue-1', 'operator-1');
  assert.deepEqual(inner.stateChanges, []);
  assert.deepEqual(inner.subscribers, []);
  assert.equal(inner.comments.length, 0, 'and nothing was posted about it either');
});

test('with both on, all four delegate unchanged — the live instance is not touched', async () => {
  const { inner, quiet } = wrap(BOTH_ON);

  const { id } = await quiet.createComment('issue-1', 'picked up');
  await quiet.updateComment(id, 'picked up, position 1');
  await quiet.setIssueState('issue-1', 'started');
  await quiet.addSubscriber('issue-1', 'operator-1');

  assert.equal(inner.comments.length, 1);
  assert.equal(inner.comments[0]!.body, 'picked up, position 1', 'the EDIT landed');
  assert.deepEqual(inner.stateChanges, [{ id: 'issue-1', stateType: 'started' }]);
  assert.deepEqual(inner.subscribers, [{ issueId: 'issue-1', userId: 'operator-1' }]);
});

test('every suppression logs, naming the method and the issue', async () => {
  const { quiet, lines } = wrap(BOTH_OFF);
  const { id } = await quiet.createComment('issue-1', 'x');
  await quiet.updateComment(id, 'y');
  await quiet.setIssueState('issue-1', 'started');
  await quiet.addSubscriber('issue-1', 'operator-1');

  // Silence that cannot be observed is indistinguishable from breakage — the same
  // reasoning that gives `guards.ts` its per-guard drop counters.
  assert.equal(lines.length, 4);
  assert.deepEqual(
    lines.map((l) => l.fields.method),
    ['createComment', 'updateComment', 'setIssueState', 'addSubscriber'],
  );
  assert.equal(lines[0]!.fields.issueId, 'issue-1');
  assert.equal(lines[2]!.fields.issueId, 'issue-1');
});

test('reads are never gated — the silent instance still has to find work', async () => {
  const { quiet } = wrap(BOTH_OFF);

  assert.equal((await quiet.getIssue('issue-1')).id, 'issue-1');
  assert.equal((await quiet.listAssignedOpenIssues('bot')).length, 1);
  assert.deepEqual(await quiet.listComments('issue-1'), []);
  assert.equal((await quiet.viewer()).id, 'fake-bot-user');
  assert.equal(await quiet.resolveWorkflowStateId('team-1', 'started'), 'fake-state-team-1-started');
});

// ---------------------------------------------------------------------------
// The boot-time refusal that keeps the instance-level limitation honest
// ---------------------------------------------------------------------------

function configWith(overrides?: Record<string, unknown>): Config {
  return {
    defaults: { postLinearComments: false, updateLinearIssue: false },
    mappings: {
      'proj-1': {
        displayName: 'Alpha',
        ...(overrides ? { overrides } : {}),
      },
    },
  } as unknown as Config;
}

test('a mapping override that DISAGREES with defaults refuses the boot, naming both', () => {
  assert.throws(
    () => assertInstanceLevelToggles(configWith({ postLinearComments: true })),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /Alpha/, 'names the mapping');
      assert.match(err.message, /postLinearComments/, 'names the field');
      assert.match(err.message, /instance-level/);
      return true;
    },
  );
  assert.throws(
    () => assertInstanceLevelToggles(configWith({ updateLinearIssue: true })),
    /updateLinearIssue/,
  );
});

test('an override that AGREES is inert and is left alone', () => {
  // This is what keeps the refusal from breaking the live config, whose wizard-written
  // overrides may well carry `postLinearComments: true` (config-writer.ts:158).
  assertInstanceLevelToggles(configWith({ postLinearComments: false, draftPr: true }));
  assertInstanceLevelToggles(configWith({ draftPr: false }));
  assertInstanceLevelToggles(configWith());
});
