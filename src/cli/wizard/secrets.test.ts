import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LinearClient } from '@linear/sdk';

import { acquireLinearKey } from './secrets.js';

// The real environment may carry a LINEAR_API_KEY for the operator's own daemon; the
// process.env fallback branch is exercised explicitly below, so clear it for everything else.
delete process.env.LINEAR_API_KEY;

/**
 * Minimal stand-in for the two `LinearClient` members this module touches.
 * `viewer` is a GETTER in @linear/sdk v93 (`await client.viewer`), `webhooks` is a method —
 * the fake mirrors that shape so the production adapter is under test too.
 */
function fakeClient(opts: { viewerFails?: boolean; webhooksFails?: boolean } = {}) {
  const calls = { viewer: 0, webhooks: 0 };
  const client = {
    get viewer() {
      calls.viewer += 1;
      return opts.viewerFails
        ? Promise.reject(new Error('Authentication required - GraphQL error 401'))
        : Promise.resolve({ id: 'user_1', name: 'bot' });
    },
    webhooks(_vars: { first: number }) {
      calls.webhooks += 1;
      return opts.webhooksFails
        ? Promise.reject(new Error("Access denied - you don't have permission: ADMIN"))
        : Promise.resolve({ nodes: [] });
    },
  };
  return { client: client as unknown as LinearClient, calls };
}

const neverPrompt = async (): Promise<string> => {
  assert.fail('prompted for a secret that was already present');
};

test('acquireLinearKey: an existing .env key is not re-prompted but IS re-validated (D-04)', async () => {
  const { client, calls } = fakeClient();
  const result = await acquireLinearKey(
    { LINEAR_API_KEY: 'lin_api_existing' },
    { prompt: neverPrompt, makeClient: () => client },
  );

  assert.equal(result.ok, true);
  assert.ok(result.ok);
  assert.equal(result.value.key, 'lin_api_existing');
  assert.equal(result.value.source, 'existing');
  assert.equal(result.value.linearClient, client);
  assert.equal(calls.viewer, 1, 'a cached key must still be validated live');
  assert.equal(calls.webhooks, 1, 'a cached key must still be admin-probed live');
});

test('acquireLinearKey: an existing key that fails viewer() returns the API-key fix, not the SDK error', async () => {
  const { client, calls } = fakeClient({ viewerFails: true });
  const result = await acquireLinearKey(
    { LINEAR_API_KEY: 'lin_api_revoked' },
    { prompt: neverPrompt, makeClient: () => client },
  );

  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.match(result.fix, /Personal API keys/);
  assert.doesNotMatch(result.fix, /GraphQL|401/, 'raw SDK error text must never reach the operator');
  assert.equal(calls.webhooks, 0, 'no admin probe once the key itself is invalid');
});

test('acquireLinearKey: a valid non-admin key returns the promote-to-admin fix (SETUP-03, D-06)', async () => {
  const { client } = fakeClient({ webhooksFails: true });
  const result = await acquireLinearKey(
    { LINEAR_API_KEY: 'lin_api_member' },
    { prompt: neverPrompt, makeClient: () => client },
  );

  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.match(result.fix, /workspace admin/);
  assert.match(result.fix, /Settings → Members/);
  assert.doesNotMatch(result.fix, /Access denied|permission: ADMIN/);
});

test('acquireLinearKey: with no key present it prompts, validates, and reports source=prompted', async () => {
  const { client, calls } = fakeClient();
  let prompted = 0;
  const result = await acquireLinearKey(
    {},
    {
      prompt: async () => {
        prompted += 1;
        return '  lin_api_typed  ';
      },
      makeClient: () => client,
    },
  );

  assert.equal(prompted, 1);
  assert.ok(result.ok);
  assert.equal(result.value.key, 'lin_api_typed', 'pasted keys are trimmed');
  assert.equal(result.value.source, 'prompted');
  assert.equal(calls.viewer, 1);
  assert.equal(calls.webhooks, 1);
});

test('acquireLinearKey: an empty answer at the prompt fails with the API-key fix', async () => {
  const result = await acquireLinearKey(
    {},
    {
      prompt: async () => '   ',
      makeClient: () => assert.fail('must not build a client from an empty key'),
    },
  );

  assert.ok(!result.ok);
  assert.match(result.fix, /Personal API keys/);
});

test('acquireLinearKey: falls back to process.env but marks it so the caller still persists it', async () => {
  process.env.LINEAR_API_KEY = 'lin_api_from_process';
  try {
    const { client } = fakeClient();
    const result = await acquireLinearKey({}, { prompt: neverPrompt, makeClient: () => client });

    assert.ok(result.ok);
    assert.equal(result.value.key, 'lin_api_from_process');
    assert.equal(
      result.value.source,
      'process-env',
      "must NOT be 'existing' — it is absent from .env, so the daemon would never see it",
    );
  } finally {
    delete process.env.LINEAR_API_KEY;
  }
});

test('acquireLinearKey: no failure message ever echoes the key back', async () => {
  const key = 'lin_api_supersecret_value';
  for (const opts of [{ viewerFails: true }, { webhooksFails: true }]) {
    const { client } = fakeClient(opts);
    const result = await acquireLinearKey(
      { LINEAR_API_KEY: key },
      { prompt: neverPrompt, makeClient: () => client },
    );
    assert.ok(!result.ok);
    assert.ok(!result.fix.includes(key), `fix message leaked the key: ${opts}`);
  }
});
