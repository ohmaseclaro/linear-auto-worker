// RUSH mode: written, not run. No node_modules on this branch yet — a single
// integration gate runs `node --test` at the end of the milestone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as z from 'zod';
import type { Config } from '../domain/types.js';
import { ConfigSchema, loadSecrets, resolveMapping, webhookTeamId } from './config.js';

function makeTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'law-config-'));
}

const validDefaults = {
  postLinearComments: true,
  notifySlack: false,
  baseBranch: 'main',
  draftPr: true,
  questionsEnabled: true,
  maxRunMs: 60 * 60 * 1000,
  questionTimeoutMs: 4 * 60 * 60 * 1000,
};

/** Everything `Config` requires beside `defaults`/`mappings`. */
const validTop = {
  botUserId: 'bot-1',
  teamId: 'team-1',
  concurrency: 3,
  maxQuestionRounds: 3,
  maxTurns: 40,
  worktreeRoot: '/tmp/wt',
  dbPath: '/tmp/store.db',
};

function repo(repoDir: string, repoSlug: string) {
  return { repoDir, repoSlug, baseBranch: 'main', enabled: true };
}

function config(mappings: Config['mappings']): Config {
  return { ...validTop, defaults: validDefaults, mappings };
}

test('missing defaults.baseBranch fails safeParse and prettifyError names the field', () => {
  const { baseBranch: _drop, ...rest } = validDefaults;
  const result = ConfigSchema.safeParse({ ...validTop, defaults: rest, mappings: {} });
  assert.equal(result.success, false);
  if (!result.success) {
    const message = z.prettifyError(result.error);
    assert.match(message, /baseBranch/);
  }
});

test('slackWebhookUrl uses the top-level z.url() validator', () => {
  const result = ConfigSchema.safeParse({
    ...validTop,
    defaults: validDefaults,
    mappings: {
      'proj-1': {
        linearProjectId: 'proj-1',
        linearTeamId: null,
        repos: [repo('/repo', 'org/repo')],
        slackWebhookUrl: 'not-a-url',
      },
    },
  });
  assert.equal(result.success, false);
  if (!result.success) {
    assert.match(z.prettifyError(result.error), /slackWebhookUrl/);
  }
});

test('a mapping with both linearProjectId and linearTeamId fails', () => {
  const result = ConfigSchema.safeParse({
    ...validTop,
    defaults: validDefaults,
    mappings: {
      'proj-1': {
        linearProjectId: 'proj-1',
        linearTeamId: 'team-1',
        repos: [repo('/repo', 'org/repo')],
      },
    },
  });
  assert.equal(result.success, false);
});

test('a mapping with neither linearProjectId nor linearTeamId fails', () => {
  const result = ConfigSchema.safeParse({
    ...validTop,
    defaults: validDefaults,
    mappings: {
      'proj-1': { linearProjectId: null, linearTeamId: null, repos: [repo('/repo', 'org/repo')] },
    },
  });
  assert.equal(result.success, false);
});

test('a mapping with exactly one of linearProjectId/linearTeamId passes', () => {
  const result = ConfigSchema.safeParse({
    ...validTop,
    defaults: validDefaults,
    mappings: {
      'proj-1': {
        linearProjectId: 'proj-1',
        linearTeamId: null,
        repos: [repo('/repo', 'org/repo')],
      },
    },
  });
  assert.equal(result.success, true);
});

test('resolveMapping finds a project-keyed mapping when one matches', () => {
  const cfg = config({
    'proj-1': { linearProjectId: 'proj-1', linearTeamId: null, repos: [repo('/repo-a', 'org/a')] },
    'team-1': { linearProjectId: null, linearTeamId: 'team-1', repos: [repo('/repo-b', 'org/b')] },
  });

  const resolved = resolveMapping(cfg, { projectId: 'proj-1', teamId: 'team-1' });
  assert.ok(resolved);
  assert.equal(resolved?.repos[0].repoSlug, 'org/a');
});

test('resolveMapping falls back to a team-keyed mapping when no project match exists (Phase 1 D-07)', () => {
  const cfg = config({
    'team-1': { linearProjectId: null, linearTeamId: 'team-1', repos: [repo('/repo-b', 'org/b')] },
  });

  const resolved = resolveMapping(cfg, { projectId: 'proj-missing', teamId: 'team-1' });
  assert.ok(resolved);
  assert.equal(resolved?.repos[0].repoSlug, 'org/b');
});

test('resolveMapping returns undefined when neither project nor team matches', () => {
  const cfg = config({
    'team-1': { linearProjectId: null, linearTeamId: 'team-1', repos: [repo('/repo-b', 'org/b')] },
  });

  const resolved = resolveMapping(cfg, { projectId: null, teamId: 'team-missing' });
  assert.equal(resolved, undefined);
});

test("a mapping's sparse overrides merge over defaults for only the named toggles (Phase 1 D-09)", () => {
  const cfg = config({
    'proj-1': {
      linearProjectId: 'proj-1',
      linearTeamId: null,
      repos: [repo('/repo-a', 'org/a')],
      overrides: { draftPr: false },
    },
  });

  const resolved = resolveMapping(cfg, { projectId: 'proj-1', teamId: 'team-1' });
  assert.equal(resolved?.draftPr, false);
  assert.equal(resolved?.postLinearComments, validDefaults.postLinearComments);
  assert.equal(resolved?.notifySlack, validDefaults.notifySlack);
  assert.equal(resolved?.baseBranch, validDefaults.baseBranch);
  assert.equal(resolved?.questionsEnabled, validDefaults.questionsEnabled);
  assert.equal(resolved?.maxRunMs, validDefaults.maxRunMs);
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

// ---------------------------------------------------------------------------
// webhookTeamId — the P2 that blocks the P0 (this plan's D0)
// ---------------------------------------------------------------------------

test('webhookTeamId heals a config whose teamId is blank from a project mapping ownerTeamId', () => {
  // This is the operator's live config.json, byte for byte in shape: a project-keyed
  // mapping, `linearTeamId: null`, and `teamId: ''`. Before `ownerTeamId` was consulted
  // this threw, and `law start` could not register a webhook at all.
  const cfg = {
    ...config({
      'proj-1': {
        linearProjectId: 'proj-1',
        linearTeamId: null,
        ownerTeamId: 'team-abc',
        repos: [repo('/repo-a', 'org/a')],
      },
    }),
    teamId: '',
  };

  assert.equal(webhookTeamId(cfg), 'team-abc');
});

test('webhookTeamId prefers the explicit config.teamId over any mapping', () => {
  const cfg = config({
    'proj-1': {
      linearProjectId: 'proj-1',
      linearTeamId: null,
      ownerTeamId: 'team-abc',
      repos: [repo('/repo-a', 'org/a')],
    },
  });

  assert.equal(webhookTeamId(cfg), 'team-1', 'validTop.teamId wins');
});

test('webhookTeamId still throws the named error when no team id exists anywhere', () => {
  const cfg = {
    ...config({
      'proj-1': { linearProjectId: 'proj-1', linearTeamId: null, repos: [repo('/r', 'org/r')] },
    }),
    teamId: '',
  };

  assert.throws(
    () => webhookTeamId(cfg),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /no Linear team is configured/);
      assert.match(err.message, /config\.json/);
      return true;
    },
  );
});
