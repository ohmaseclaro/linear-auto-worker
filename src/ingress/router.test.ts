/**
 * The fake `client` deliberately returns issue state that DIFFERS from the payload. A fake
 * that echoed the payload back could not tell a correct router from one that skipped the
 * re-fetch entirely, and the re-fetch (INTK-05) is the thing under test.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { DomainEvent, Logger } from '../domain/ports.js';
import { createRouter, type FetchedIssue, type WebhookPayload } from './router.js';

const BOT = 'bot-user-id';
const SOMEONE_ELSE = 'human-user-id';
const ISSUE = 'issue-uuid';

const errors: Array<Record<string, unknown>> = [];
const log: Logger = {
  child: () => log,
  info: () => {},
  warn: () => {},
  error: (o) => {
    errors.push(o as Record<string, unknown>);
  },
  debug: () => {},
};

/** `assignee` on the SDK's Issue is a lazy fetch, so the fake resolves one too. */
const freshIssue = (assigneeId: string | null): FetchedIssue => ({
  id: ISSUE,
  assignee: Promise.resolve(assigneeId === null ? undefined : { id: assigneeId }),
});

function harness(fresh: FetchedIssue | Error) {
  const events: DomainEvent[] = [];
  const fetched: string[] = [];
  const router = createRouter({
    client: {
      issue: async (id) => {
        fetched.push(id);
        if (fresh instanceof Error) throw fresh;
        return fresh;
      },
    },
    log,
    botUserId: BOT,
    onEvent: (e) => events.push(e),
  });
  return { router, events, fetched };
}

const issueUpdate = (updatedFrom: Record<string, unknown> | null, data: Record<string, unknown> = {}): WebhookPayload => ({
  action: 'update',
  type: 'Issue',
  data: { id: ISSUE, ...data },
  updatedFrom,
});

test('assigning the bot produces exactly one issue.assigned (INTK-01)', async () => {
  // Payload claims nobody is assigned; the fetch says the bot. The fetch wins.
  const { router, events, fetched } = harness(freshIssue(BOT));

  await router.enqueue(issueUpdate({ assigneeId: null }, { assigneeId: null }), 'd-1');

  assert.deepEqual(fetched, [ISSUE]);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { kind: 'issue.assigned', issueId: ISSUE, deliveryId: 'd-1' });
});

test('a later unrelated edit produces no pickup, even though the bot is still the assignee', async () => {
  // ROADMAP criterion 5, and the single most important row in this file. The edge is
  // 'assigneeId' in updatedFrom — absent here — and NOT "the assignee is the bot",
  // which would re-fire on every edit of this issue forever including the bot's own writes.
  const { router, events, fetched } = harness(freshIssue(BOT));

  await router.enqueue(issueUpdate({ title: 'old title' }, { assigneeId: BOT }), 'd-2');

  assert.deepEqual(events, []);
  assert.deepEqual(fetched, [], 'no edge ⇒ not even a fetch');
});

test('an assigneeId edge whose fresh assignee is someone else emits issue.unassigned', async () => {
  const { router, events } = harness(freshIssue(SOMEONE_ELSE));

  await router.enqueue(issueUpdate({ assigneeId: BOT }, { assigneeId: BOT }), 'd-3');

  assert.deepEqual(events, [{ kind: 'issue.unassigned', issueId: ISSUE, deliveryId: 'd-3' }]);
});

test('the fetch beats the payload: payload says bot, fresh state says otherwise (INTK-05)', async () => {
  const { router, events, fetched } = harness(freshIssue(SOMEONE_ELSE));

  await router.enqueue({ action: 'create', type: 'Issue', data: { id: ISSUE, assigneeId: BOT } }, 'd-4');

  assert.deepEqual(fetched, [ISSUE], 'the router looked');
  assert.deepEqual(events, [], 'and then believed what it saw, not what it was told');
});

test('create with the bot pre-assigned emits issue.assigned — there is no updatedFrom on a create', async () => {
  const { router, events } = harness(freshIssue(BOT));

  await router.enqueue({ action: 'create', type: 'Issue', data: { id: ISSUE, assigneeId: BOT } }, 'd-5');

  assert.deepEqual(events, [{ kind: 'issue.assigned', issueId: ISSUE, deliveryId: 'd-5' }]);
});

test('comment create emits comment.created carrying issueId, commentId and parentId', async () => {
  const { router, events, fetched } = harness(freshIssue(BOT));

  await router.enqueue(
    {
      action: 'create',
      type: 'Comment',
      data: { id: 'comment-uuid', issueId: ISSUE, parentId: 'parent-uuid', body: 'ignored here' },
    },
    'd-6',
  );

  assert.deepEqual(events, [
    {
      kind: 'comment.created',
      issueId: ISSUE,
      commentId: 'comment-uuid',
      parentId: 'parent-uuid',
      deliveryId: 'd-6',
    },
  ]);
  assert.deepEqual(fetched, [], 'identifiers are not decisions — no second fetch needed');
});

test('a rejecting fetch is logged with the delivery id, emits nothing, and never throws', async () => {
  errors.length = 0;
  const { router, events } = harness(new Error('Linear 500'));

  // enqueue runs after the 200 has been written, so an escaping throw is an unhandled
  // rejection in the receiver's deferred callback, not a failed ACK.
  await router.enqueue(issueUpdate({ assigneeId: null }), 'd-7');

  assert.deepEqual(events, []);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.deliveryId, 'd-7');
  assert.equal(errors[0]?.err, 'Linear 500', 'the message, never the raw error object');
});
