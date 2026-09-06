import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { BOT_COMMENT_MARKER_PREFIX } from '../../domain/index.js';
import { LinearCommentChannel, composeBody } from './linear-channel.js';
import type { LinearClient } from '../linear-client.js';
import type { RunEvent } from './notifier.js';

interface PostedComment {
  issueId: string;
  body: string;
  parentId: string | undefined;
}

function stubClient(posted: PostedComment[], id = 'comment-1'): LinearClient {
  const notImplemented = () => {
    throw new Error('not used by LinearCommentChannel');
  };
  return {
    viewer: notImplemented,
    getIssue: notImplemented,
    listAssignedOpenIssues: notImplemented,
    setIssueState: notImplemented,
    createComment: async (issueId: string, body: string, parentId?: string) => {
      posted.push({ issueId, body, parentId });
      return { id };
    },
    listWebhooks: notImplemented,
    createWebhook: notImplemented,
    updateWebhook: notImplemented,
    deleteWebhook: notImplemented,
  } as unknown as LinearClient;
}

const BASE = {
  runId: 'run-1',
  issueId: 'issue-uuid-1',
  issueIdentifier: 'ENG-42',
  issueUrl: 'https://linear.app/acme/issue/ENG-42',
  mappingId: 'map-1',
  at: 1_700_000_000_000,
};

const KINDS: RunEvent[] = [
  { ...BASE, kind: 'picked_up' },
  { ...BASE, kind: 'worktree_ready' },
  { ...BASE, kind: 'agent_started' },
  { ...BASE, kind: 'question_asked', question: 'Postgres or SQLite for the new table?' },
  {
    ...BASE,
    kind: 'terminal',
    state: 'delivered',
    costUsd: 0.4231,
    tokensUsed: 12_345,
    prUrl: 'https://github.com/acme/app/pull/7',
  },
];

describe('LinearCommentChannel — the self-event marker (T32 / threat T-05-04)', () => {
  it('prefixes every kind it emits with the marker imported from the domain barrel', async () => {
    for (const event of KINDS) {
      const posted: PostedComment[] = [];
      const channel = new LinearCommentChannel({
        client: stubClient(posted),
        postLinearComments: () => true,
      });
      await channel.emit(event);
      assert.equal(posted.length, 1);
      assert.ok(
        posted[0]!.body.startsWith(BOT_COMMENT_MARKER_PREFIX),
        `${event.kind} comment must start with the marker`,
      );
    }
  });

  it('posts top-level — no parentId, since none of these kinds is a reply', async () => {
    const posted: PostedComment[] = [];
    await new LinearCommentChannel({
      client: stubClient(posted),
      postLinearComments: () => true,
    }).emit(KINDS[0]!);
    assert.equal(posted[0]!.parentId, undefined);
  });
});

describe('LinearCommentChannel — the per-mapping toggle (NOTF-05)', () => {
  it('is disabled exactly when postLinearComments says so, per mapping', () => {
    const channel = new LinearCommentChannel({
      client: stubClient([]),
      postLinearComments: (mappingId) => mappingId === 'on',
    });
    assert.equal(channel.enabled({ ...BASE, mappingId: 'on', kind: 'picked_up' }), true);
    assert.equal(channel.enabled({ ...BASE, mappingId: 'off', kind: 'picked_up' }), false);
  });

  it('does not gate on kind — every milestone reaches Linear, unlike Slack', () => {
    const channel = new LinearCommentChannel({
      client: stubClient([]),
      postLinearComments: () => true,
    });
    for (const event of KINDS) {
      assert.equal(channel.enabled(event), true, `${event.kind} must reach Linear`);
    }
  });
});

describe('LinearCommentChannel — terminal message content', () => {
  it('carries the PR url, cost and tokens for a delivered run (DELV-05, NOTF-06)', async () => {
    const posted: PostedComment[] = [];
    await new LinearCommentChannel({
      client: stubClient(posted),
      postLinearComments: () => true,
    }).emit(KINDS[4]!);

    const body = posted[0]!.body;
    assert.match(body, /https:\/\/github\.com\/acme\/app\/pull\/7/);
    assert.match(body, /\$0\.4231/);
    assert.match(body, /12,345 tokens/);
  });

  it('carries cost and tokens even when there is no PR — a failed run still reports spend', () => {
    const body = composeBody({
      ...BASE,
      kind: 'terminal',
      state: 'failed',
      costUsd: 1.5,
      tokensUsed: 40_000,
      reason: 'The agent could not resolve the build.',
    });
    assert.match(body, /\$1\.50/);
    assert.match(body, /40,000 tokens/);
    assert.match(body, /could not resolve the build/);
  });

  it('includes the draft PR for a partial run', () => {
    const body = composeBody({
      ...BASE,
      kind: 'terminal',
      state: 'partial',
      costUsd: 0.2,
      tokensUsed: 100,
      prUrl: 'https://github.com/acme/app/pull/9',
    });
    assert.match(body, /pull\/9/);
  });
});

describe('LinearCommentChannel — question correlation', () => {
  it('returns the posted comment id for a question so Phase 6 can match the reply', async () => {
    const result = await new LinearCommentChannel({
      client: stubClient([], 'comment-xyz'),
      postLinearComments: () => true,
    }).emit(KINDS[3]!);
    assert.deepEqual(result, { linearCommentId: 'comment-xyz' });
  });

  it('returns nothing for a non-question kind — there is no reply to correlate', async () => {
    const result = await new LinearCommentChannel({
      client: stubClient([], 'comment-xyz'),
      postLinearComments: () => true,
    }).emit(KINDS[0]!);
    assert.deepEqual(result, {});
  });
});

describe('LinearCommentChannel — content safety (threat T-05-05)', () => {
  it('renders only from RunEvent fields, so an unrelated secret cannot reach the ticket', async () => {
    const posted: PostedComment[] = [];
    await new LinearCommentChannel({
      client: stubClient(posted),
      postLinearComments: () => true,
    }).emit({
      ...BASE,
      kind: 'terminal',
      state: 'failed',
      costUsd: 0,
      tokensUsed: 0,
      reason: 'Build failed.',
    });

    const body = posted[0]!.body;
    // No filesystem path, no stack frame — those are the two carriers the threat names.
    assert.doesNotMatch(body, /\/Users\/|\/home\/|at Object\.<anonymous>/);
  });

  it('rejects upward on a Linear failure so the notifier can apply bounded retry', async () => {
    const failing = {
      createComment: async () => {
        throw new Error('RATELIMITED');
      },
    } as unknown as LinearClient;
    await assert.rejects(
      new LinearCommentChannel({ client: failing, postLinearComments: () => true }).emit(KINDS[0]!),
      /RATELIMITED/,
    );
  });
});
