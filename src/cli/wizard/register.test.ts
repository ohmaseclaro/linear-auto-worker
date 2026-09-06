import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { TunnelManager, WebhookRegistrar } from '../../domain/index.js';
import {
  WEBHOOK_LABEL,
  type DoctorClient,
  type DoctorFinding,
  doctorWebhooks,
  reconcileWebhook,
} from './register.js';

// NOTE (RUSH MODE): written complete, not executed on this branch — no node_modules here.
// Runs at the milestone-end integration gate (`tsc && node --test "dist/**/*.test.js"`).
//
// `src/domain/fakes.ts` does not exist on this branch even though `src/domain/index.ts`
// already re-exports it, so the port doubles below are local. See this plan's SUMMARY under
// "Contract additions requested" — these are the exact shapes a shared fake should provide.

type Webhook = { id: string; label: string | null; url: string; enabled: boolean; resourceTypes: string[] };

function fakeTunnel(url: string | Error): TunnelManager {
  let opened: string | null = null;
  return {
    async open() {
      if (url instanceof Error) throw url;
      opened = url;
      return url;
    },
    url: () => opened,
    async close() {
      opened = null;
    },
  };
}

/**
 * A registrar that models the ONE property this plan exists to prove: ownership is keyed on
 * the label, so a second reconcile against a DIFFERENT url updates the same registration
 * rather than adding a second one.
 */
function fakeRegistrar(state: { webhooks: Map<string, { id: string; url: string; secret: string }> }) {
  let created = 0;
  const registrar: WebhookRegistrar & { createdCount: () => number; labelsUsed: string[] } = {
    labelsUsed: [],
    createdCount: () => created,
    async reconcile(publicUrl: string) {
      registrar.labelsUsed.push(WEBHOOK_LABEL);
      const existing = state.webhooks.get(WEBHOOK_LABEL);
      if (existing) {
        existing.url = publicUrl; // update, never a second create
        return { webhookId: existing.id, secret: existing.secret };
      }
      created += 1;
      const fresh = { id: `wh-${created}`, url: publicUrl, secret: 'sekrit-hex' };
      state.webhooks.set(WEBHOOK_LABEL, fresh);
      return { webhookId: fresh.id, secret: fresh.secret };
    },
    async disable() {},
  };
  return registrar;
}

function fakeClient(webhooks: Webhook[]): DoctorClient & { deleted: string[]; enabled: string[] } {
  const deleted: string[] = [];
  const enabled: string[] = [];
  return {
    deleted,
    enabled,
    async listWebhooks() {
      return webhooks;
    },
    async updateWebhook(id, input) {
      if (input.enabled) enabled.push(id);
    },
    async deleteWebhook(id) {
      deleted.push(id);
    },
  };
}

const silent = () => {};

test('a clean reconcile returns the webhook id and secret, keyed on the label', async () => {
  const state = { webhooks: new Map<string, { id: string; url: string; secret: string }>() };
  const registrar = fakeRegistrar(state);

  const result = await reconcileWebhook(fakeTunnel('https://abc.ngrok.app'), registrar, 4711);

  assert.equal(result.ok, true);
  assert.ok(result.ok && result.webhookId === 'wh-1');
  assert.ok(result.ok && result.secret === 'sekrit-hex');
  assert.ok(result.ok && result.publicUrl === 'https://abc.ngrok.app');
  assert.deepEqual(registrar.labelsUsed, [WEBHOOK_LABEL]);
});

test('re-running with a DIFFERENT ephemeral url updates rather than duplicating (Pitfall 2)', async () => {
  const state = { webhooks: new Map<string, { id: string; url: string; secret: string }>() };
  const registrar = fakeRegistrar(state);

  const first = await reconcileWebhook(fakeTunnel('https://one.ngrok.app'), registrar, 4711);
  // The whole point: the domain is different on the second boot, by design.
  const second = await reconcileWebhook(fakeTunnel('https://two.ngrok.app'), registrar, 4711);

  assert.ok(first.ok && second.ok);
  assert.equal(registrar.createdCount(), 1, 'a URL match would have created a second webhook');
  assert.equal(state.webhooks.size, 1);
  assert.equal(first.webhookId, second.ok ? second.webhookId : '');
  assert.equal(state.webhooks.get(WEBHOOK_LABEL)?.url, 'https://two.ngrok.app');
});

test('a rejected ngrok authtoken becomes a named fix, never the raw message (T24)', async () => {
  const state = { webhooks: new Map<string, { id: string; url: string; secret: string }>() };
  // The real error echoes the token back inside its own message.
  const err = new Error('ERR_NGROK_105: authentication failed: the token 2abcSECRETtoken is invalid');

  const result = await reconcileWebhook(fakeTunnel(err), fakeRegistrar(state), 4711);

  assert.equal(result.ok, false);
  assert.ok(!result.ok && /NGROK_AUTHTOKEN/.test(result.fix));
  assert.equal(!result.ok && result.fix.includes('2abcSECRETtoken'), false);
  assert.equal(state.webhooks.size, 0, 'no registration attempt after a tunnel failure');
});

test('a registrar failure names the workspace-admin fix and never throws', async () => {
  const registrar: WebhookRegistrar = {
    async reconcile() {
      throw new Error('GraphQL: ACCESS_DENIED for query { createWebhook(input: ...) }');
    },
    async disable() {},
  };

  const result = await reconcileWebhook(fakeTunnel('https://abc.ngrok.app'), registrar, 4711);

  assert.equal(result.ok, false);
  assert.ok(!result.ok && /WORKSPACE ADMIN/.test(result.fix));
  assert.equal(!result.ok && /GraphQL/.test(result.fix), false);
});

test('an empty tunnel url fails loudly rather than registering "null/linear/webhook" (T19)', async () => {
  const state = { webhooks: new Map<string, { id: string; url: string; secret: string }>() };
  const result = await reconcileWebhook(fakeTunnel(''), fakeRegistrar(state), 4711);

  assert.equal(result.ok, false);
  assert.equal(state.webhooks.size, 0);
});

test('doctor reports a foreign ngrok webhook and does NOT delete it un-confirmed (T-08-16)', async () => {
  const client = fakeClient([
    { id: 'wh-foreign', label: 'some-other-tool', url: 'https://x.ngrok-free.app/hook', enabled: true, resourceTypes: ['Issue'] },
  ]);

  const findings = await doctorWebhooks(client, { confirmDelete: async () => false, log: silent });

  assert.deepEqual(client.deleted, []);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].action, 'reported');
  assert.equal(findings[0].webhookId, 'wh-foreign');
});

test('doctor deletes a foreign ngrok webhook only after an explicit per-item confirm', async () => {
  const client = fakeClient([
    { id: 'wh-a', label: 'other', url: 'https://a.ngrok.app/hook', enabled: true, resourceTypes: [] },
    { id: 'wh-b', label: 'other', url: 'https://b.ngrok.app/hook', enabled: true, resourceTypes: [] },
  ]);

  const asked: string[] = [];
  const findings = await doctorWebhooks(client, {
    log: silent,
    confirmDelete: async (f) => {
      asked.push(f.webhookId);
      return f.webhookId === 'wh-a'; // one yes, one no — never a blanket delete
    },
  });

  assert.deepEqual(asked, ['wh-a', 'wh-b'], 'every candidate is confirmed individually');
  assert.deepEqual(client.deleted, ['wh-a']);
  assert.deepEqual(
    findings.map((f: DoctorFinding) => f.action),
    ['deleted', 'reported'],
  );
});

test('doctor re-enables a disabled same-label webhook and never deletes ours (T-08-18)', async () => {
  const client = fakeClient([
    { id: 'wh-ours', label: WEBHOOK_LABEL, url: 'https://old.ngrok.app/linear/webhook', enabled: false, resourceTypes: ['Issue'] },
  ]);

  const findings = await doctorWebhooks(client, { confirmDelete: async () => true, log: silent });

  assert.deepEqual(client.enabled, ['wh-ours']);
  assert.deepEqual(client.deleted, [], 'our own webhook is never a deletion candidate');
  assert.equal(findings[0].action, 'reenabled');
});

test('doctor leaves an unrelated non-ngrok webhook completely alone', async () => {
  const client = fakeClient([
    { id: 'wh-ci', label: 'ci-bot', url: 'https://ci.example.com/linear', enabled: true, resourceTypes: [] },
    { id: 'wh-ours', label: WEBHOOK_LABEL, url: 'https://n.ngrok.app/linear/webhook', enabled: true, resourceTypes: [] },
  ]);

  const findings = await doctorWebhooks(client, { confirmDelete: async () => true, log: silent });

  assert.deepEqual(client.deleted, []);
  assert.deepEqual(client.enabled, []);
  assert.deepEqual(
    findings.map((f) => f.webhookId),
    ['wh-ours'],
  );
  assert.equal(findings[0].action, 'ok');
});

test('no doctor finding ever carries a signing secret', async () => {
  const client = fakeClient([
    { id: 'wh-ours', label: WEBHOOK_LABEL, url: 'https://n.ngrok.app/linear/webhook', enabled: false, resourceTypes: [] },
  ]);

  const findings = await doctorWebhooks(client, { log: silent, confirmDelete: async () => false });

  // T23: the port's listWebhooks() projection has no `secret`, and nothing here adds one.
  assert.equal(JSON.stringify(findings).includes('secret'), false);
});
