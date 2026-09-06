/**
 * The connection fake mutates and returns `this`, exactly as the real SDK does (T22). A
 * fake that returned a fresh page per call would let the double-counting pagination bug
 * through — and that bug is what makes the registrar delete its own live webhook.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { pollForMissedWork, POLL_WATERMARK_KEY, type Connection, type PollClient } from './poll.js';

const BOT = 'bot-user-id';
const LATER = new Date('2030-01-01T00:00:00.000Z');

function connection<T>(pages: T[][]): Connection<T> {
  let i = 0;
  const conn: Connection<T> = {
    nodes: [...(pages[0] ?? [])],
    pageInfo: { hasNextPage: pages.length > 1 },
    async fetchNext() {
      i += 1;
      conn.nodes.push(...(pages[i] ?? []));
      conn.pageInfo.hasNextPage = i < pages.length - 1;
      return conn; // T22: appends into the same connection, returns `this`
    },
  };
  return conn;
}

const issueAt = (id: string, updatedAt: string) => ({ id, updatedAt: new Date(updatedAt) });

function clientWith(
  issuePages: Array<Array<{ id: string; updatedAt: Date }>>,
  commentPages: Array<Array<{ id: string; createdAt: Date; parent?: { id: string } }>> = [],
) {
  const filters: Array<Record<string, unknown>> = [];
  const client: PollClient = {
    async issues({ filter }) {
      filters.push(filter);
      return connection(issuePages);
    },
    async comments({ filter }) {
      filters.push(filter);
      return connection(commentPages);
    },
  };
  return { client, filters };
}

/** Wider than `Pick<Store, 'kvGet'>` on purpose: a write here is a bug (D-12/D-04). */
function storeWith(watermark?: string) {
  const writes: string[] = [];
  return {
    store: {
      kvGet: (k: string) => (k === POLL_WATERMARK_KEY ? watermark : undefined),
      kvSet: (k: string) => {
        writes.push(k);
      },
    },
    writes,
  };
}

const base = { botUserId: BOT, openQuestionIssueIds: [], now: () => LATER };

test('no watermark in kv: queries from the epoch and returns every bot-assigned issue', async () => {
  const { client, filters } = clientWith([[issueAt('i1', '2026-09-01T10:00:00.000Z'), issueAt('i2', '2026-09-02T10:00:00.000Z')]]);
  const { store } = storeWith(undefined);

  const { events } = await pollForMissedWork({ ...base, client, store });

  assert.deepEqual(filters[0]?.updatedAt, { gt: new Date(0) });
  assert.deepEqual(events, [
    { kind: 'issue.assigned', issueId: 'i1' },
    { kind: 'issue.assigned', issueId: 'i2' },
  ]);
});

test('watermark present: the query asks only for issues updated strictly after it', async () => {
  const mark = '2026-09-05T00:00:00.000Z';
  const { client, filters } = clientWith([[issueAt('i9', '2026-09-06T09:00:00.000Z')]]);
  const { store } = storeWith(mark);

  const { events } = await pollForMissedWork({ ...base, client, store });

  assert.deepEqual(filters[0]?.updatedAt, { gt: new Date(mark) }, 'strictly greater');
  assert.deepEqual(filters[0]?.assignee, { id: { eq: BOT } });
  assert.deepEqual(events, [{ kind: 'issue.assigned', issueId: 'i9' }]);
});

test('an issue the caller already knows about is still emitted — dedupe belongs to run records', async () => {
  const { client } = clientWith([[issueAt('already-running', '2026-09-06T09:00:00.000Z')]]);
  const { store } = storeWith('2026-09-05T00:00:00.000Z');

  const { events } = await pollForMissedWork({ ...base, client, store });

  assert.deepEqual(events, [{ kind: 'issue.assigned', issueId: 'already-running' }]);
});

test('comments on issues holding an open question come back as comment.created (D-05)', async () => {
  // The reason this pass exists: an issue-level diff cannot see a threaded answer, because
  // a comment is not an issue field.
  const { client, filters } = clientWith(
    [[]],
    [[{ id: 'c1', createdAt: new Date('2026-09-06T11:00:00.000Z'), parent: { id: 'question-comment' } }]],
  );
  const { store } = storeWith('2026-09-06T10:00:00.000Z');

  const { events } = await pollForMissedWork({
    ...base,
    client,
    store,
    openQuestionIssueIds: ['parked-issue'],
  });

  assert.deepEqual(filters[1]?.issue, { id: { eq: 'parked-issue' } });
  assert.deepEqual(filters[1]?.createdAt, { gt: new Date('2026-09-06T10:00:00.000Z') });
  assert.deepEqual(events, [
    {
      kind: 'comment.created',
      issueId: 'parked-issue',
      commentId: 'c1',
      parentId: 'question-comment',
    },
  ]);
});

test('returns the newest updatedAt observed and does not write it back to kv', async () => {
  const { client } = clientWith([
    [issueAt('i1', '2026-09-06T09:00:00.000Z'), issueAt('i2', '2026-09-06T12:30:00.000Z')],
  ]);
  const { store, writes } = storeWith('2026-09-05T00:00:00.000Z');

  const { watermark } = await pollForMissedWork({ ...base, client, store });

  assert.equal(watermark, '2026-09-06T12:30:00.000Z');
  assert.deepEqual(writes, [], 'the caller persists, and only after the events are consumed');
});

test('an empty result leaves the watermark exactly where it was', async () => {
  const { client } = clientWith([[]]);
  const { store } = storeWith('2026-09-05T00:00:00.000Z');

  const { events, watermark } = await pollForMissedWork({ ...base, client, store });

  assert.deepEqual(events, []);
  assert.equal(watermark, '2026-09-05T00:00:00.000Z', 'never advanced to "now" on an empty poll');
});

test('two pages of three yield six issues, not nine (T22)', async () => {
  const { client } = clientWith([
    [issueAt('a', '2026-09-06T01:00:00.000Z'), issueAt('b', '2026-09-06T02:00:00.000Z'), issueAt('c', '2026-09-06T03:00:00.000Z')],
    [issueAt('d', '2026-09-06T04:00:00.000Z'), issueAt('e', '2026-09-06T05:00:00.000Z'), issueAt('f', '2026-09-06T06:00:00.000Z')],
  ]);
  const { store } = storeWith(undefined);

  const { events } = await pollForMissedWork({ ...base, client, store });

  assert.equal(events.length, 6);
  assert.deepEqual(
    events.map((e) => (e.kind === 'issue.assigned' ? e.issueId : e.kind)),
    ['a', 'b', 'c', 'd', 'e', 'f'],
  );
});
