import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { SlackChannel, maskWebhookUrl } from './slack-channel.js';
import type { RunEvent } from './notifier.js';

const HOOK = 'https://hooks.slack.com/services/T000/B000/SuperSecretTokenAbcd';

const BASE = {
  runId: 'run-1',
  issueId: 'issue-uuid-1',
  issueIdentifier: 'ENG-42',
  issueUrl: 'https://linear.app/acme/issue/ENG-42',
  mappingId: 'map-1',
  at: 1_700_000_000_000,
};

const terminal: RunEvent = {
  ...BASE,
  kind: 'terminal',
  state: 'delivered',
  costUsd: 0.4231,
  tokensUsed: 12_345,
  prUrl: 'https://github.com/acme/app/pull/7',
};

const question: RunEvent = { ...BASE, kind: 'question_asked', question: 'Postgres or SQLite?' };
const progress: RunEvent[] = [
  { ...BASE, kind: 'picked_up' },
  { ...BASE, kind: 'worktree_ready' },
  { ...BASE, kind: 'agent_started' },
];

interface Post {
  url: string;
  body: unknown;
}

function fetchRecorder(status = 200): { posts: Post[]; fetch: typeof globalThis.fetch } {
  const posts: Post[] = [];
  const fetch = (async (input: unknown, init: { body?: string } = {}) => {
    posts.push({ url: String(input), body: JSON.parse(String(init.body)) });
    return { ok: status >= 200 && status < 300, status } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
  return { posts, fetch };
}

describe('SlackChannel — kind gating (D-02 / NOTF-04)', () => {
  const channel = new SlackChannel({ webhookUrl: () => HOOK, fetch: fetchRecorder().fetch });

  it('is enabled for terminal and question_asked', () => {
    assert.equal(channel.enabled(terminal), true);
    assert.equal(channel.enabled(question), true);
  });

  it('is disabled for every progress milestone — those go to Linear only', () => {
    for (const e of progress) {
      assert.equal(channel.enabled(e), false, `${e.kind} must not reach Slack`);
    }
  });

  it('is disabled when the mapping has no webhook configured, even for a terminal event', () => {
    const off = new SlackChannel({ webhookUrl: () => undefined, fetch: fetchRecorder().fetch });
    assert.equal(off.enabled(terminal), false);
    assert.equal(off.enabled(question), false);
  });

  it('resolves the webhook per mapping, not globally', () => {
    const perMapping = new SlackChannel({
      webhookUrl: (mappingId) => (mappingId === 'wired' ? HOOK : undefined),
      fetch: fetchRecorder().fetch,
    });
    assert.equal(perMapping.enabled({ ...terminal, mappingId: 'wired' }), true);
    assert.equal(perMapping.enabled({ ...terminal, mappingId: 'other' }), false);
  });
});

describe('SlackChannel — the POST', () => {
  it('posts one JSON payload to the configured URL', async () => {
    const { posts, fetch } = fetchRecorder();
    await new SlackChannel({ webhookUrl: () => HOOK, fetch }).emit(terminal);

    assert.equal(posts.length, 1);
    assert.equal(posts[0]!.url, HOOK);
    const text = (posts[0]!.body as { text: string }).text;
    assert.match(text, /ENG-42/);
    assert.match(text, /pull\/7/);
    assert.match(text, /12,345 tokens/);
    assert.match(text, /linear\.app\/acme\/issue\/ENG-42/);
  });

  it('carries the question text for a question_asked event', async () => {
    const { posts, fetch } = fetchRecorder();
    await new SlackChannel({ webhookUrl: () => HOOK, fetch }).emit(question);
    assert.match((posts[0]!.body as { text: string }).text, /Postgres or SQLite\?/);
  });

  it('rejects on a non-2xx so the notifier applies bounded retry', async () => {
    const { fetch } = fetchRecorder(500);
    await assert.rejects(
      new SlackChannel({ webhookUrl: () => HOOK, fetch }).emit(terminal),
      /returned 500/,
    );
  });
});

describe('SlackChannel — the webhook URL is a secret (threat T-05-06)', () => {
  it('masks the URL to a short tail', () => {
    assert.equal(maskWebhookUrl(HOOK), '***Abcd');
    assert.doesNotMatch(maskWebhookUrl(HOOK), /hooks\.slack\.com/);
  });

  it('never puts the full URL in a rejection message on a non-2xx', async () => {
    const { fetch } = fetchRecorder(403);
    await assert.rejects(new SlackChannel({ webhookUrl: () => HOOK, fetch }).emit(terminal), (err) => {
      assert.doesNotMatch((err as Error).message, /SuperSecretTokenAbcd/);
      assert.match((err as Error).message, /\*\*\*Abcd/);
      return true;
    });
  });

  it('never puts the full URL in a rejection message on a transport failure', async () => {
    // Node's fetch quotes the request URL in some failure messages — this is the case the
    // scrub exists for.
    const fetch = (async () => {
      throw new Error(`request to ${HOOK} failed, reason: ECONNREFUSED`);
    }) as unknown as typeof globalThis.fetch;

    await assert.rejects(new SlackChannel({ webhookUrl: () => HOOK, fetch }).emit(terminal), (err) => {
      assert.doesNotMatch((err as Error).message, /SuperSecretTokenAbcd/);
      assert.match((err as Error).message, /ECONNREFUSED/);
      return true;
    });
  });

  it('logs only the masked tail when Slack rejects the post', async () => {
    const lines: Array<{ fields: Record<string, unknown>; msg: string }> = [];
    const { fetch } = fetchRecorder(404);
    await assert.rejects(
      new SlackChannel({
        webhookUrl: () => HOOK,
        fetch,
        log: (fields, msg) => lines.push({ fields, msg }),
      }).emit(terminal),
    );

    assert.equal(lines.length, 1);
    assert.equal(lines[0]!.msg, 'notify.slack_rejected');
    assert.equal(lines[0]!.fields.webhook, '***Abcd');
    assert.doesNotMatch(JSON.stringify(lines[0]), /SuperSecretTokenAbcd/);
  });
});
