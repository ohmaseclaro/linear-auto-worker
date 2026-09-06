import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { LinearClient as SdkLinearClient } from '@linear/sdk';

import { LinearClientImpl, type LogFn } from './linear-client.js';
import { RateLimitedError } from './rate-limit.js';
import { selfEventGuards } from '../ingress/guards.js';

/**
 * These tests drive LinearClientImpl against a hand-rolled stand-in for `@linear/sdk`,
 * injected through the constructor's `sdk` test seam. Nothing here touches the network.
 */
const asSdk = (fake: unknown): SdkLinearClient => fake as unknown as SdkLinearClient;

const API_KEY = 'lin_api_TEST_KEY_MUST_NEVER_BE_LOGGED';

function fakeIssue(over: Record<string, unknown> = {}) {
  return {
    id: 'issue-1',
    identifier: 'ENG-42',
    title: 'Fix login',
    description: 'the description',
    url: 'https://linear.app/acme/issue/ENG-42',
    branchName: 'eng-42-fix-login',
    updatedAt: new Date('2026-09-06T12:00:00.000Z'),
    assignee: Promise.resolve({ id: 'user-bot' }),
    project: Promise.resolve({ id: 'proj-1' }),
    team: Promise.resolve({ id: 'team-1' }),
    state: Promise.resolve({ id: 'state-todo', type: 'unstarted' }),
    ...over,
  };
}

const onePage = <N>(nodes: N[]) => ({ nodes, pageInfo: { hasNextPage: false } });

describe('getIssue', () => {
  it('maps the SDK Issue onto LinearIssue, using Linear’s own branchName', async () => {
    const client = new LinearClientImpl({
      apiKey: API_KEY,
      sdk: asSdk({ issue: async () => fakeIssue() }),
    });

    assert.deepEqual(await client.getIssue('issue-1'), {
      id: 'issue-1',
      identifier: 'ENG-42',
      title: 'Fix login',
      description: 'the description',
      url: 'https://linear.app/acme/issue/ENG-42',
      branchName: 'eng-42-fix-login',
      updatedAt: '2026-09-06T12:00:00.000Z',
      assigneeId: 'user-bot',
      projectId: 'proj-1',
      teamId: 'team-1',
      stateId: 'state-todo',
      stateType: 'unstarted',
    });
  });

  it('maps an unassigned, projectless issue to nulls rather than throwing', async () => {
    const client = new LinearClientImpl({
      apiKey: API_KEY,
      sdk: asSdk({
        issue: async () =>
          fakeIssue({ assignee: undefined, project: undefined, description: null }),
      }),
    });

    const issue = await client.getIssue('issue-1');
    assert.equal(issue.assigneeId, null);
    assert.equal(issue.projectId, null);
    assert.equal(issue.description, null);
  });
});

describe('setIssueState', () => {
  /**
   * Adversarial fixture: the state literally *named* "In Progress" is typed `unstarted`,
   * and the state we actually want has been renamed to "Doing". Any implementation that
   * matches on name picks the wrong one.
   */
  const teamStates = [
    { id: 'state-misnamed', name: 'In Progress', type: 'unstarted', position: 0 },
    { id: 'state-doing', name: 'Doing', type: 'started', position: 1 },
    { id: 'state-review', name: 'In Review', type: 'started', position: 2 },
    { id: 'state-done', name: 'Done', type: 'completed', position: 3 },
  ];

  function stubTeam() {
    const calls = { team: 0, states: 0, updates: [] as Array<{ issueId: string; stateId: string }> };
    const sdk = {
      team: async (id: string) => {
        calls.team += 1;
        assert.equal(id, 'team-1');
        return {
          states: async () => {
            calls.states += 1;
            return onePage(teamStates);
          },
        };
      },
      updateIssue: async (issueId: string, input: { stateId: string }) => {
        calls.updates.push({ issueId, stateId: input.stateId });
        return { success: true };
      },
      // `setIssueState` takes no teamId — the run engine has none — so it reads the team
      // back off the issue. That is what makes this stub necessary.
      issue: async () => fakeIssue(),
    };
    return { calls, sdk };
  }

  it('resolves the state by type, never by name', async () => {
    const { calls, sdk } = stubTeam();
    const client = new LinearClientImpl({ apiKey: API_KEY, sdk: asSdk(sdk) });

    await client.setIssueState('issue-1', 'started');

    assert.deepEqual(calls.updates, [{ issueId: 'issue-1', stateId: 'state-doing' }]);
  });

  it('prefers the lowest-position state when a team has several of one type', async () => {
    // "Doing" (position 1) and "In Review" (position 2) are both `started`; picking the
    // later one would park the issue in review before any work happened.
    const { calls, sdk } = stubTeam();
    const client = new LinearClientImpl({ apiKey: API_KEY, sdk: asSdk(sdk) });

    await client.setIssueState('issue-1', 'started');

    assert.equal(calls.updates[0]?.stateId, 'state-doing');
  });

  it('memoizes per team so a second call queries nothing', async () => {
    const { calls, sdk } = stubTeam();
    const client = new LinearClientImpl({ apiKey: API_KEY, sdk: asSdk(sdk) });

    await client.setIssueState('issue-1', 'started');
    await client.setIssueState('issue-2', 'completed');

    assert.equal(calls.team, 1);
    assert.equal(calls.states, 1);
    assert.deepEqual(calls.updates, [
      { issueId: 'issue-1', stateId: 'state-doing' },
      { issueId: 'issue-2', stateId: 'state-done' },
    ]);
  });

  it('registers the write with loop guard 3 so the bot does not answer its own transition (T49)', async () => {
    const { sdk } = stubTeam();
    const client = new LinearClientImpl({ apiKey: API_KEY, sdk: asSdk(sdk) });
    const payload = { actor: { id: 'a-human', type: 'user' }, type: 'Issue', data: { id: 'issue-1' } };

    // Falsification first (T71): with no self-write recorded, the guard must PASS the
    // event. A check that cannot be shown to go red proves nothing about the green.
    assert.equal(selfEventGuards(payload, 'user-bot').drop, false);

    await client.setIssueState('issue-1', 'started');

    const after = selfEventGuards(payload, 'user-bot');
    assert.equal(after.drop, true);
    assert.equal(after.guard, 'suppression:self-write');
  });

  it('throws naming the team when it has no state of the requested type', async () => {
    const { sdk } = stubTeam();
    const client = new LinearClientImpl({ apiKey: API_KEY, sdk: asSdk(sdk) });

    await assert.rejects(() => client.setIssueState('issue-1', 'canceled'), (err: Error) => {
      assert.match(err.message, /team-1/);
      assert.match(err.message, /canceled/);
      return true;
    });
  });
});

describe('createComment', () => {
  it('passes parentId straight through so replies thread', async () => {
    let received: Record<string, unknown> | undefined;
    const client = new LinearClientImpl({
      apiKey: API_KEY,
      sdk: asSdk({
        createComment: async (input: Record<string, unknown>) => {
          received = input;
          return { comment: Promise.resolve({ id: 'comment-9' }) };
        },
      }),
    });

    const result = await client.createComment('issue-1', 'the answer', 'comment-parent');

    assert.deepEqual(result, { id: 'comment-9' });
    assert.deepEqual(received, {
      issueId: 'issue-1',
      body: 'the answer',
      parentId: 'comment-parent',
    });
  });

  it('omits parentId for a top-level comment', async () => {
    let received: Record<string, unknown> | undefined;
    const client = new LinearClientImpl({
      apiKey: API_KEY,
      sdk: asSdk({
        createComment: async (input: Record<string, unknown>) => {
          received = input;
          return { comment: Promise.resolve({ id: 'comment-1' }) };
        },
      }),
    });

    await client.createComment('issue-1', 'picked this up');

    assert.equal(received?.parentId, undefined);
  });
});

describe('listAssignedOpenIssues', () => {
  it('filters to the bot and excludes terminal states', async () => {
    let filter: unknown;
    const client = new LinearClientImpl({
      apiKey: API_KEY,
      sdk: asSdk({
        issues: async (args: { filter: unknown }) => {
          filter = args.filter;
          return onePage([fakeIssue()]);
        },
      }),
    });

    const issues = await client.listAssignedOpenIssues('user-bot');

    assert.equal(issues.length, 1);
    assert.equal(issues[0]?.identifier, 'ENG-42');
    assert.deepEqual(filter, {
      assignee: { id: { eq: 'user-bot' } },
      state: { type: { nin: ['completed', 'canceled'] } },
    });
  });

  it('pages past the first 50 rather than truncating the boot sweep', async () => {
    const cursors: Array<string | undefined> = [];
    const client = new LinearClientImpl({
      apiKey: API_KEY,
      sdk: asSdk({
        issues: async (args: { after?: string }) => {
          cursors.push(args.after);
          return args.after === undefined
            ? {
                nodes: [fakeIssue({ id: 'a' })],
                pageInfo: { hasNextPage: true, endCursor: 'cur-1' },
              }
            : onePage([fakeIssue({ id: 'b' })]);
        },
      }),
    });

    const issues = await client.listAssignedOpenIssues('user-bot');

    assert.deepEqual(cursors, [undefined, 'cur-1']);
    assert.deepEqual(
      issues.map((i) => i.id),
      ['a', 'b'],
    );
  });
});

describe('the call() rate-limit wrapper', () => {
  const ratelimited = (headers?: Record<string, string>) =>
    Object.assign(new Error('Bad Request'), {
      // Linear returns this inside an HTTP 400 body. Detection keys on the extension
      // code alone — the status is deliberately not consulted (TRAPS T7).
      status: 400,
      errors: [{ extensions: { code: 'RATELIMITED' } }],
      ...(headers ? { response: { headers } } : {}),
    });

  it('converts a RATELIMITED GraphQL error into a RateLimitedError honouring the reset header', async () => {
    const resetAtMs = Date.now() + 5_000;
    const client = new LinearClientImpl({
      apiKey: API_KEY,
      sdk: asSdk({
        issue: async () => {
          throw ratelimited({
            'X-RateLimit-Requests-Reset': String(resetAtMs),
            'X-Complexity': '318',
          });
        },
      }),
    });

    await assert.rejects(() => client.getIssue('issue-1'), (err: unknown) => {
      assert.ok(err instanceof RateLimitedError);
      assert.ok(err.retryAfterMs > 0 && err.retryAfterMs <= 5_000);
      return true;
    });
  });

  it('falls back to a conservative wait when no reset header is present', async () => {
    const client = new LinearClientImpl({
      apiKey: API_KEY,
      sdk: asSdk({
        issue: async () => {
          throw ratelimited();
        },
      }),
    });

    await assert.rejects(() => client.getIssue('issue-1'), (err: unknown) => {
      assert.ok(err instanceof RateLimitedError);
      assert.equal(err.retryAfterMs, 60_000);
      return true;
    });
  });

  it('logs only allow-listed scalars — never the raw error, which carries the API key', async () => {
    const lines: Array<{ fields: Record<string, unknown>; msg: string }> = [];
    const log: LogFn = (fields, msg) => lines.push({ fields, msg });
    const client = new LinearClientImpl({
      apiKey: API_KEY,
      log,
      sdk: asSdk({
        issue: async () => {
          throw Object.assign(ratelimited({ 'X-Complexity': '318' }), {
            request: { headers: { Authorization: API_KEY }, query: 'query Issue { ... }' },
          });
        },
      }),
    });

    await assert.rejects(() => client.getIssue('issue-1'));

    assert.equal(lines.length, 1);
    assert.deepEqual(Object.keys(lines[0]!.fields).sort(), ['complexity', 'op', 'waitMs']);
    assert.ok(!JSON.stringify(lines).includes(API_KEY));
  });

  it('rethrows a non-rate-limit error unchanged', async () => {
    const boom = new Error('network down');
    const client = new LinearClientImpl({
      apiKey: API_KEY,
      sdk: asSdk({
        issue: async () => {
          throw boom;
        },
      }),
    });

    await assert.rejects(() => client.getIssue('issue-1'), (err: unknown) => err === boom);
  });

  it('does not treat a bare transport status as a rate limit', async () => {
    const statusOnly = Object.assign(new Error('Bad Request'), { status: 400 });
    const client = new LinearClientImpl({
      apiKey: API_KEY,
      sdk: asSdk({
        issue: async () => {
          throw statusOnly;
        },
      }),
    });

    await assert.rejects(() => client.getIssue('issue-1'), (err: unknown) => err === statusOnly);
  });
});

describe('webhook CRUD', () => {
  const webhookPage = (
    nodes: Array<Record<string, unknown>>,
    endCursor?: string,
  ) => ({ nodes, pageInfo: { hasNextPage: endCursor !== undefined, endCursor } });

  it('pages listWebhooks to completion instead of trusting the first 50', async () => {
    const cursors: Array<string | undefined> = [];
    const client = new LinearClientImpl({
      apiKey: API_KEY,
      sdk: asSdk({
        webhooks: async (args: { after?: string }) => {
          cursors.push(args.after);
          if (args.after === undefined) {
            return webhookPage(
              [{ id: 'wh-1', label: 'law', url: 'https://a/x', enabled: true, resourceTypes: ['Issue'] }],
              'cur-1',
            );
          }
          return webhookPage([
            { id: 'wh-2', label: 'other', url: 'https://b/x', enabled: false, resourceTypes: ['Comment'] },
          ]);
        },
      }),
    });

    const webhooks = await client.listWebhooks();

    assert.deepEqual(cursors, [undefined, 'cur-1']);
    // Exactly two — not four. A loop built on fetchNext() (which mutates and returns
    // `this`, appending into page.nodes) double-counts every page (TRAPS T22), and the
    // registrar would then classify its own live webhook as a duplicate and delete it.
    assert.deepEqual(
      webhooks.map((w) => w.id),
      ['wh-1', 'wh-2'],
    );
  });

  it('never returns the signing secret, even when the SDK hands one over', async () => {
    const client = new LinearClientImpl({
      apiKey: API_KEY,
      sdk: asSdk({
        webhooks: async () =>
          webhookPage([
            {
              id: 'wh-1',
              label: 'law',
              url: 'https://a/x',
              enabled: true,
              resourceTypes: ['Issue'],
              secret: 'lin_wh_SIGNING_SECRET',
            },
          ]),
      }),
    });

    const webhooks = await client.listWebhooks();

    assert.deepEqual(Object.keys(webhooks[0]!).sort(), [
      'enabled',
      'id',
      'label',
      'resourceTypes',
      'url',
    ]);
    assert.ok(!JSON.stringify(webhooks).includes('SIGNING_SECRET'));
  });

  it('normalises the SDK’s optional label/url/resourceTypes', async () => {
    const client = new LinearClientImpl({
      apiKey: API_KEY,
      sdk: asSdk({
        webhooks: async () => webhookPage([{ id: 'wh-1', enabled: true }]),
      }),
    });

    assert.deepEqual(await client.listWebhooks(), [
      { id: 'wh-1', label: null, url: '', enabled: true, resourceTypes: [] },
    ]);
  });

  it('createWebhook passes the caller’s secret through and returns only the id', async () => {
    let received: Record<string, unknown> | undefined;
    const client = new LinearClientImpl({
      apiKey: API_KEY,
      sdk: asSdk({
        createWebhook: async (input: Record<string, unknown>) => {
          received = input;
          return {
            webhook: Promise.resolve({ id: 'wh-new', secret: 'lin_wh_SIGNING_SECRET' }),
          };
        },
      }),
    });

    const input = {
      label: 'linear-auto-worker',
      url: 'https://tunnel.ngrok-free.app/linear/webhook',
      teamId: 'team-1',
      secret: 'lin_wh_SIGNING_SECRET',
      resourceTypes: ['Issue', 'Comment'],
    };
    const result = await client.createWebhook(input);

    assert.deepEqual(received, input);
    assert.deepEqual(result, { id: 'wh-new' });
  });

  it('updateWebhook re-points and re-enables in one call', async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const client = new LinearClientImpl({
      apiKey: API_KEY,
      sdk: asSdk({
        updateWebhook: async (id: string, input: Record<string, unknown>) => {
          calls.push([id, input]);
          return { success: true };
        },
      }),
    });

    await client.updateWebhook('wh-1', { url: 'https://new/x', enabled: true });

    assert.deepEqual(calls, [['wh-1', { url: 'https://new/x', enabled: true }]]);
  });

  it('deleteWebhook forwards the id', async () => {
    const deleted: string[] = [];
    const client = new LinearClientImpl({
      apiKey: API_KEY,
      sdk: asSdk({
        deleteWebhook: async (id: string) => {
          deleted.push(id);
          return { success: true };
        },
      }),
    });

    await client.deleteWebhook('wh-1');

    assert.deepEqual(deleted, ['wh-1']);
  });

  it('routes webhook calls through call(), so a rate limit surfaces as RateLimitedError', async () => {
    const client = new LinearClientImpl({
      apiKey: API_KEY,
      sdk: asSdk({
        webhooks: async () => {
          throw Object.assign(new Error('Bad Request'), {
            status: 400,
            errors: [{ extensions: { code: 'RATELIMITED' } }],
          });
        },
      }),
    });

    await assert.rejects(() => client.listWebhooks(), RateLimitedError);
  });
});
