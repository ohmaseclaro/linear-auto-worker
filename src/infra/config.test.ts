// RUSH mode: written, not run. No node_modules on this branch yet — a single
// integration gate runs `node --test` at the end of the milestone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as z from 'zod';
import type { Config } from '../domain/types.js';
import { ConfigSchema, loadSecrets, resolveMapping } from './config.js';

function makeTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'law-config-'));
}

const validDefaults = {
  postLinearComments: true,
  slackNotify: false,
  baseBranch: 'main',
  draftPr: true,
  questionFlowEnabled: true,
  maxRunTimeMs: 60 * 60 * 1000,
};

test('missing defaults.baseBranch fails safeParse and prettifyError names the field', () => {
  const { baseBranch: _drop, ...rest } = validDefaults;
  const result = ConfigSchema.safeParse({ defaults: rest, mappings: [] });
  assert.equal(result.success, false);
  if (!result.success) {
    const message = z.prettifyError(result.error);
    assert.match(message, /baseBranch/);
  }
});

test('slackWebhookUrl uses the top-level z.url() validator', () => {
  const result = ConfigSchema.safeParse({
    defaults: validDefaults,
    mappings: [
      {
        linearProjectId: 'proj-1',
        repos: [{ repoDir: '/repo', repoSlug: 'org/repo' }],
        slackWebhookUrl: 'not-a-url',
      },
    ],
  });
  assert.equal(result.success, false);
  if (!result.success) {
    assert.match(z.prettifyError(result.error), /slackWebhookUrl/);
  }
});

test('a mapping with both linearProjectId and linearTeamId fails', () => {
  const result = ConfigSchema.safeParse({
    defaults: validDefaults,
    mappings: [
      {
        linearProjectId: 'proj-1',
        linearTeamId: 'team-1',
        repos: [{ repoDir: '/repo', repoSlug: 'org/repo' }],
      },
    ],
  });
  assert.equal(result.success, false);
});

test('a mapping with neither linearProjectId nor linearTeamId fails', () => {
  const result = ConfigSchema.safeParse({
    defaults: validDefaults,
    mappings: [{ repos: [{ repoDir: '/repo', repoSlug: 'org/repo' }] }],
  });
  assert.equal(result.success, false);
});

test('a mapping with exactly one of linearProjectId/linearTeamId passes', () => {
  const result = ConfigSchema.safeParse({
    defaults: validDefaults,
    mappings: [{ linearProjectId: 'proj-1', repos: [{ repoDir: '/repo', repoSlug: 'org/repo' }] }],
  });
  assert.equal(result.success, true);
});

test('resolveMapping finds a project-keyed mapping when one matches', () => {
  const config = {
    defaults: validDefaults,
    mappings: [
      { linearProjectId: 'proj-1', repos: [{ repoDir: '/repo-a', repoSlug: 'org/a' }] },
      { linearTeamId: 'team-1', repos: [{ repoDir: '/repo-b', repoSlug: 'org/b' }] },
    ],
  } as unknown as Config;

  const resolved = resolveMapping(config, { projectId: 'proj-1', teamId: 'team-1' });
  assert.ok(resolved);
  assert.equal(resolved?.repos[0].repoSlug, 'org/a');
});

test('resolveMapping falls back to a team-keyed mapping when no project match exists (Phase 1 D-07)', () => {
  const config = {
    defaults: validDefaults,
    mappings: [{ linearTeamId: 'team-1', repos: [{ repoDir: '/repo-b', repoSlug: 'org/b' }] }],
  } as unknown as Config;

  const resolved = resolveMapping(config, { projectId: 'proj-missing', teamId: 'team-1' });
  assert.ok(resolved);
  assert.equal(resolved?.repos[0].repoSlug, 'org/b');
});

test('resolveMapping returns undefined when neither project nor team matches', () => {
  const config = {
    defaults: validDefaults,
    mappings: [{ linearTeamId: 'team-1', repos: [{ repoDir: '/repo-b', repoSlug: 'org/b' }] }],
  } as unknown as Config;

  const resolved = resolveMapping(config, { projectId: null, teamId: 'team-missing' });
  assert.equal(resolved, undefined);
});

test("a mapping's sparse overrides merge over defaults for only the named toggles (Phase 1 D-09)", () => {
  const config = {
    defaults: validDefaults,
    mappings: [
      {
        linearProjectId: 'proj-1',
        repos: [{ repoDir: '/repo-a', repoSlug: 'org/a' }],
        overrides: { draftPr: false },
      },
    ],
  } as unknown as Config;

  const resolved = resolveMapping(config, { projectId: 'proj-1', teamId: 'team-1' });
  assert.equal(resolved?.draftPr, false);
  assert.equal(resolved?.postLinearComments, validDefaults.postLinearComments);
  assert.equal(resolved?.slackNotify, validDefaults.slackNotify);
  assert.equal(resolved?.baseBranch, validDefaults.baseBranch);
  assert.equal(resolved?.questionFlowEnabled, validDefaults.questionFlowEnabled);
  assert.equal(resolved?.maxRunTimeMs, validDefaults.maxRunTimeMs);
});

test('loadSecrets throws when the .env file mode is not 0600 (D-01, Phase 1 D-08)', () => {
  const root = makeTempRoot();
  const envPath = path.join(root, '.env');
  fs.writeFileSync(envPath, 'LINEAR_API_KEY=abc\nNGROK_AUTHTOKEN=def\n');
  fs.chmodSync(envPath, 0o644);
  assert.throws(() => loadSecrets(root));
});

test('loadSecrets returns { linearApiKey, ngrokAuthtoken } when the .env file is mode 0600', () => {
  const root = makeTempRoot();
  const envPath = path.join(root, '.env');
  fs.writeFileSync(envPath, '# comment\nLINEAR_API_KEY=abc\n\nNGROK_AUTHTOKEN=def\n');
  fs.chmodSync(envPath, 0o600);
  const secrets = loadSecrets(root);
  assert.deepEqual(secrets, { linearApiKey: 'abc', ngrokAuthtoken: 'def' });
});

test('loadSecrets throws when a required key is missing', () => {
  const root = makeTempRoot();
  const envPath = path.join(root, '.env');
  fs.writeFileSync(envPath, 'LINEAR_API_KEY=abc\n');
  fs.chmodSync(envPath, 0o600);
  assert.throws(() => loadSecrets(root));
});
