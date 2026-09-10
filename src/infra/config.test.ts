// RUSH mode: written, not run. No node_modules on this branch yet — a single
// integration gate runs `node --test` at the end of the milestone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as z from 'zod';
import type { Config } from '../domain/types.js';
import { resolveToggles } from '../domain/types.js';
import { ConfigError } from '../domain/errors.js';
import { ConfigSchema, loadConfig, loadSecrets, resolveMapping, webhookTeamId } from './config.js';

function makeTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'law-config-'));
}

const validDefaults = {
  postLinearComments: true,
  updateLinearIssue: true,
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

// ---------------------------------------------------------------------------
// 260909-nh6 — the three fields a second, silent, poll-only instance needs
//
// Every one of them is optional and defaults to today's behaviour, because the live
// Código 18 daemon picks these changes up on its next restart and must not notice.
// ---------------------------------------------------------------------------

/** `loadConfig` reads a real file, and only `loadConfig` wraps a parse failure in
 *  `ConfigError` — so the rejection assertions below go through the loader, not through
 *  `safeParse`, which returns rather than throws. */
function loadFromDisk(raw: unknown): Config {
  const root = makeTempRoot();
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(raw), 'utf8');
  return loadConfig(root);
}

test('a config written before today loads and resolves to today\'s behaviour', () => {
  // No `ingress`, no `updateLinearIssue`, no `pickupStates` — the operator's live file.
  // `updateLinearIssue` is stripped rather than omitted from the shared fixture, so this
  // stays a test about the SCHEMA DEFAULT and not about what the fixture happens to hold.
  const { updateLinearIssue: _dropped, ...preTodayDefaults } = validDefaults;
  const parsed = loadFromDisk({
    ...config({
      'proj-1': { linearProjectId: 'proj-1', linearTeamId: null, repos: [repo('/r', 'org/r')] },
    }),
    defaults: preTodayDefaults,
  });

  assert.equal(parsed.ingress, undefined, 'absent ingress means webhook, not poll');
  const resolved = resolveToggles(parsed.defaults, parsed.mappings['proj-1']);
  assert.equal(resolved.postLinearComments, true);
  assert.equal(resolved.updateLinearIssue, true, 'the new toggle defaults to today: issues move');
  assert.equal(parsed.mappings['proj-1'].pickupStates, undefined, 'no pickup filter');
});

test('a pickupStates entry may be a workflow-state TYPE', () => {
  const parsed = loadFromDisk(
    config({
      'proj-1': {
        linearProjectId: 'proj-1',
        linearTeamId: null,
        repos: [repo('/r', 'org/r')],
        pickupStates: ['unstarted'],
      },
    }),
  );
  assert.deepEqual(parsed.mappings['proj-1'].pickupStates, ['unstarted']);
});

test('a pickupStates entry may be a workflow-state ID', () => {
  const parsed = loadFromDisk(
    config({
      'proj-1': {
        linearProjectId: 'proj-1',
        linearTeamId: null,
        repos: [repo('/r', 'org/r')],
        pickupStates: ['43876da4-7abe-4268-8559-e4db36ca4247'],
      },
    }),
  );
  assert.deepEqual(parsed.mappings['proj-1'].pickupStates, [
    '43876da4-7abe-4268-8559-e4db36ca4247',
  ]);
});

test('a pickupStates entry that is neither is a LOAD ERROR, not a filter that never matches', () => {
  // The assertion that matters most in this file. A typo here would otherwise disable the
  // mapping forever and silently — indistinguishable from a bot that is ignoring you.
  assert.throws(
    () =>
      loadFromDisk(
        config({
          'proj-1': {
            linearProjectId: 'proj-1',
            linearTeamId: null,
            repos: [repo('/r', 'org/r')],
            pickupStates: ['Todo'],
          },
        }),
      ),
    (err: unknown) => {
      assert.ok(err instanceof ConfigError);
      assert.match(err.message, /Todo/, 'names the value it rejected');
      assert.match(err.message, /unstarted/, 'names the TYPE form');
      assert.match(err.message, /id/i, 'names the ID form');
      return true;
    },
  );
});

test('ingress accepts only "webhook" and "poll"', () => {
  assert.equal(loadFromDisk({ ...config({}), ingress: 'poll' }).ingress, 'poll');
  assert.equal(loadFromDisk({ ...config({}), ingress: 'webhook' }).ingress, 'webhook');
  assert.throws(
    () => loadFromDisk({ ...config({}), ingress: 'polling' }),
    (err: unknown) => {
      assert.ok(err instanceof ConfigError);
      assert.match(err.message, /ingress/);
      return true;
    },
  );
});

test('the ngrok token is required only when the instance opens a tunnel', () => {
  const root = makeTempRoot();
  const envPath = path.join(root, '.env');
  fs.writeFileSync(envPath, 'LINEAR_API_KEY=abc\n');
  fs.chmodSync(envPath, 0o600);

  // Poll-only: no tunnel, so no token, and that is a supported configuration.
  const secrets = loadSecrets(root, false);
  assert.equal(secrets.linearApiKey, 'abc');
  assert.equal(secrets.ngrokAuthtoken, undefined);

  // Webhook mode, and the default for every existing caller: still a hard failure.
  assert.throws(
    () => loadSecrets(root, true),
    (err: unknown) => {
      assert.ok(err instanceof ConfigError);
      assert.match(err.message, /NGROK_AUTHTOKEN/);
      return true;
    },
  );
  assert.throws(() => loadSecrets(root), /NGROK_AUTHTOKEN/, 'required by default');
});

// ── T125: a repo row with no `baseBranch` ────────────────────────────────────
//
// `types.ts` claimed "Required on the row; the loader fills it from
// `Config.defaults.baseBranch`" while the schema required it, so the sentence was false
// and every repo row had to carry a branch name the operator never chose.

test('a repo row with no baseBranch loads, filled from defaults.baseBranch', () => {
  const root = makeTempRoot();
  fs.writeFileSync(
    path.join(root, 'config.json'),
    JSON.stringify({
      ...validTop,
      defaults: { ...validDefaults, baseBranch: 'trunk' },
      mappings: {
        'proj-1': {
          linearProjectId: 'proj-1',
          linearTeamId: null,
          // No `baseBranch` on this one; the next carries its own.
          repos: [
            { repoDir: '/repos/api', repoSlug: 'org/api', enabled: true },
            { repoDir: '/repos/legacy', repoSlug: 'org/legacy', baseBranch: 'master', enabled: true },
          ],
        },
      },
    }),
  );

  const loaded = loadConfig(root);
  const repos = loaded.mappings['proj-1']!.repos;
  assert.equal(repos[0]!.baseBranch, 'trunk', 'the omitted row takes the instance default');
  assert.equal(repos[1]!.baseBranch, 'master', 'an explicit override is left alone');
});
