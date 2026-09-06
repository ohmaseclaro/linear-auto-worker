import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { LinearClient } from '@linear/sdk';

import {
  acquireLinearKey,
  acquireNgrokToken,
  maskSecret,
  readSecretsEnv,
  writeSecretsEnv,
} from './secrets.js';

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

// ---------------------------------------------------------------------------
// ngrok authtoken
// ---------------------------------------------------------------------------

async function tmpFile(name: string, contents?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'law-secrets-'));
  const path = join(dir, name);
  if (contents !== undefined) await writeFile(path, contents);
  return path;
}

test('acquireNgrokToken: an existing token skips both the yaml read and the prompt (D-04)', async () => {
  const result = await acquireNgrokToken(
    { NGROK_AUTHTOKEN: 'existing_token' },
    {
      prompt: neverPrompt,
      yamlPaths: ['/nonexistent/should-not-be-read.yml'],
    },
  );

  assert.ok(result.ok);
  assert.equal(result.value.token, 'existing_token');
  assert.equal(result.value.source, 'existing');
});

test('acquireNgrokToken: copies the VALUE out of ngrok.yml, never a reference to the file (T10)', async () => {
  const yaml = await tmpFile(
    'ngrok.yml',
    'version: "3"\nagent:\n  authtoken: 2abcDEF_ngrokTokenValue\n  region: us\n',
  );
  const result = await acquireNgrokToken({}, { prompt: neverPrompt, yamlPaths: [yaml] });

  assert.ok(result.ok);
  assert.equal(result.value.token, '2abcDEF_ngrokTokenValue');
  assert.equal(result.value.source, 'yaml');
  assert.ok(
    !result.value.token.includes('ngrok.yml'),
    'the SDK reads only the environment — a path here fails at tunnel-open',
  );
});

test('acquireNgrokToken: strips quotes and ignores commented-out authtoken lines', async () => {
  const yaml = await tmpFile('ngrok.yml', '# authtoken: commented_out\nauthtoken: "quoted_token"\n');
  const result = await acquireNgrokToken({}, { prompt: neverPrompt, yamlPaths: [yaml] });

  assert.ok(result.ok);
  assert.equal(result.value.token, 'quoted_token');
});

test('acquireNgrokToken: a missing yaml file falls through to the prompt, it never aborts setup', async () => {
  let prompted = 0;
  const result = await acquireNgrokToken(
    {},
    {
      yamlPaths: ['/definitely/not/here/ngrok.yml'],
      prompt: async () => {
        prompted += 1;
        return ' typed_token ';
      },
    },
  );

  assert.equal(prompted, 1);
  assert.ok(result.ok);
  assert.equal(result.value.token, 'typed_token');
  assert.equal(result.value.source, 'prompted');
});

test('acquireNgrokToken: a yaml with no authtoken line falls through to the prompt', async () => {
  const yaml = await tmpFile('ngrok.yml', 'version: "3"\nregion: eu\n');
  const result = await acquireNgrokToken({}, { yamlPaths: [yaml], prompt: async () => 'typed' });

  assert.ok(result.ok);
  assert.equal(result.value.source, 'prompted');
});

test('acquireNgrokToken: an empty answer fails here rather than as an indiscriminable tunnel error (T25)', async () => {
  const result = await acquireNgrokToken({}, { yamlPaths: [], prompt: async () => '  ' });

  assert.ok(!result.ok);
  assert.match(result.fix, /dashboard\.ngrok\.com/);
});

// ---------------------------------------------------------------------------
// .env persistence
// ---------------------------------------------------------------------------

test('writeSecretsEnv: creates the .env at mode 0600', async () => {
  const envPath = join(await mkdtemp(join(tmpdir(), 'law-env-')), '.env');
  await writeSecretsEnv(envPath, { LINEAR_API_KEY: 'k1', NGROK_AUTHTOKEN: 't1' });

  assert.equal((await stat(envPath)).mode & 0o777, 0o600);
  const body = await readFile(envPath, 'utf8');
  assert.match(body, /^LINEAR_API_KEY=k1$/m);
  assert.match(body, /^NGROK_AUTHTOKEN=t1$/m);
});

test('writeSecretsEnv: merges in place, preserving unrelated lines, and re-chmods an existing file', async () => {
  const envPath = await tmpFile('.env', 'SOME_OTHER=keep-me\nLINEAR_API_KEY=old\n');
  const { chmod } = await import('node:fs/promises');
  await chmod(envPath, 0o644);

  await writeSecretsEnv(envPath, { LINEAR_API_KEY: 'new', NGROK_AUTHTOKEN: 't2' });

  const body = await readFile(envPath, 'utf8');
  assert.match(body, /^SOME_OTHER=keep-me$/m);
  assert.match(body, /^LINEAR_API_KEY=new$/m);
  assert.match(body, /^NGROK_AUTHTOKEN=t2$/m);
  assert.doesNotMatch(body, /LINEAR_API_KEY=old/);
  assert.equal(
    (await stat(envPath)).mode & 0o777,
    0o600,
    'chmod must run on merge too, not only on create',
  );
});

test('writeSecretsEnv: omitted keys are left untouched (an "existing"-sourced value is never rewritten)', async () => {
  const envPath = await tmpFile('.env', 'LINEAR_API_KEY=untouched\n');
  await writeSecretsEnv(envPath, { NGROK_AUTHTOKEN: 't3' });

  const body = await readFile(envPath, 'utf8');
  assert.match(body, /^LINEAR_API_KEY=untouched$/m);
  assert.match(body, /^NGROK_AUTHTOKEN=t3$/m);
});

test('readSecretsEnv: round-trips what writeSecretsEnv wrote, and returns {} for a missing file', async () => {
  const envPath = join(await mkdtemp(join(tmpdir(), 'law-env-')), '.env');
  assert.deepEqual(await readSecretsEnv(envPath), {});

  await writeSecretsEnv(envPath, { LINEAR_API_KEY: 'k9', NGROK_AUTHTOKEN: 't9' });
  const parsed = await readSecretsEnv(envPath);
  assert.equal(parsed.LINEAR_API_KEY, 'k9');
  assert.equal(parsed.NGROK_AUTHTOKEN, 't9');
});

test('maskSecret: never returns the whole secret', () => {
  assert.equal(maskSecret('lin_api_1234567890'), 'lin_ap…');
  assert.equal(maskSecret('short'), '…');
});
