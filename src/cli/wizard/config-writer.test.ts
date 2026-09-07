import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { Config } from '../../domain/index.js';
import {
  DEFAULT_TOGGLES,
  assembleConfig,
  toWizardMappings,
  writeConfig,
} from './config-writer.js';
import type { Mapping } from './mapping.js';
import type { EnrichedMapping } from './repo-safety.js';

// NOTE (RUSH MODE): this file is written complete but is not executed on this branch — no
// node_modules exist here. It runs at the milestone-end integration gate
// (`tsc && node --test "dist/**/*.test.js"`, TRAPS T55).

function mapping(overrides: Partial<Mapping> = {}): Mapping {
  return {
    key: { kind: 'project', id: 'proj-1', name: 'Alpha' },
    repos: ['/repos/api'],
    ...overrides,
  };
}

function enriched(): EnrichedMapping {
  return {
    ...mapping(),
    repoSafety: [{ repoPath: '/repos/api', ownerRepo: 'org/api', defaultBranch: 'trunk' }],
  };
}

test('a fresh build produces the six documented CONF-02 toggle defaults', () => {
  const config = assembleConfig({ mappings: [mapping()] });

  assert.deepEqual(config.defaults, DEFAULT_TOGGLES);
  assert.equal(config.defaults.postLinearComments, true);
  assert.equal(config.defaults.notifySlack, false);
  assert.equal(config.defaults.baseBranch, 'main');
  assert.equal(config.defaults.draftPr, true);
  assert.equal(config.defaults.questionsEnabled, true);
  assert.equal(config.defaults.maxRunMs, 45 * 60 * 1000);
  // Global cap, never per-mapping.
  assert.equal(config.concurrency, 3);
});

test('08-04 repo-safety fields land on the canonical RepoMapping names', () => {
  const config = assembleConfig({ mappings: [enriched()] });
  const repo = config.mappings['proj-1'].repos[0];

  // ownerRepo -> repoSlug, defaultBranch -> baseBranch (08-04's SUMMARY reconciliation).
  assert.deepEqual(repo, {
    repoDir: '/repos/api',
    repoSlug: 'org/api',
    baseBranch: 'trunk',
    enabled: true,
  });
  // D-07 keying: project id present, team id null, and the record key is the project id.
  assert.equal(config.mappings['proj-1'].linearProjectId, 'proj-1');
  assert.equal(config.mappings['proj-1'].linearTeamId, null);
});

test('a repo with no discovered default branch falls back to defaults.baseBranch', () => {
  const config = assembleConfig({ mappings: [mapping()] });
  const repo = config.mappings['proj-1'].repos[0];
  assert.equal(repo.baseBranch, 'main');
  assert.equal(repo.repoSlug, ''); // never guessed — 08-04 already warned about it
});

test('merge PRESERVES an existing mapping this run did not rebuild (D-04)', () => {
  const existing = assembleConfig({
    mappings: [
      mapping(),
      mapping({ key: { kind: 'team', id: 'team-9', name: 'Ops' }, repos: ['/repos/ops'] }),
    ],
  });

  // Second run: the operator selected only the "proj-1" mapping.
  const merged = assembleConfig({ mappings: [mapping()], existing });

  assert.ok(merged.mappings['team-9'], 'untouched mapping must survive the re-run');
  assert.deepEqual(merged.mappings['team-9'], existing.mappings['team-9']);
});

test('merge REPLACES a same-key mapping with the freshly built version', () => {
  const existing = assembleConfig({ mappings: [mapping()] });
  const rebuilt = mapping({ repos: ['/repos/api', '/repos/web'] });

  const merged = assembleConfig({ mappings: [rebuilt], existing });

  assert.equal(merged.mappings['proj-1'].repos.length, 2);
  assert.deepEqual(
    merged.mappings['proj-1'].repos.map((r) => r.repoDir),
    ['/repos/api', '/repos/web'],
  );
});

test('a defaults field this run did not touch keeps its existing value (D-04)', () => {
  const existing = assembleConfig({ mappings: [mapping()] });
  existing.defaults.baseBranch = 'develop';
  existing.concurrency = 1;

  const merged = assembleConfig({ mappings: [mapping()], existing });

  assert.equal(merged.defaults.baseBranch, 'develop');
  assert.equal(merged.concurrency, 1);
});

test('a corrupt existing file reverts to defaults rather than propagating garbage (T-08-19)', () => {
  const corrupt = {
    concurrency: 'lots',
    defaults: { baseBranch: 42, maxRunMs: null, bogusKey: true },
    mappings: 'not-an-object',
  } as unknown as Config;

  const merged = assembleConfig({ mappings: [mapping()], existing: corrupt });

  assert.equal(merged.concurrency, 3);
  assert.equal(merged.defaults.baseBranch, 'main');
  assert.equal(merged.defaults.maxRunMs, DEFAULT_TOGGLES.maxRunMs);
  assert.equal((merged.defaults as unknown as Record<string, unknown>).bogusKey, undefined);
  assert.deepEqual(Object.keys(merged.mappings), ['proj-1']);
});

test('no undefined value ever serializes into the written JSON', () => {
  // No Slack URL, no toggle overrides — both optional fields must be ABSENT keys, not
  // present-but-undefined ones, or the JSON round trip is lossy.
  const config = assembleConfig({ mappings: [mapping()] });
  const entry = config.mappings['proj-1'];

  assert.equal('slackWebhookUrl' in entry, false);
  assert.equal('overrides' in entry, false);
  assert.equal('maxBudgetUsd' in config, false);
  assert.deepEqual(JSON.parse(JSON.stringify(config)), config);
});

test('an empty Slack answer and an empty override set stay absent, never empty-valued', () => {
  const config = assembleConfig({
    mappings: [mapping({ slackWebhookUrl: '   ', toggles: {} })],
  });
  const entry = config.mappings['proj-1'];
  assert.equal('slackWebhookUrl' in entry, false);
  assert.equal('overrides' in entry, false);
});

test('wizard toggle names translate to the canonical MappingToggles keys', () => {
  const config = assembleConfig({
    mappings: [
      mapping({
        toggles: { linearComments: false, maxRunTimeMs: 1000, slackNotifications: true },
      }),
    ],
  });

  assert.deepEqual(config.mappings['proj-1'].overrides, {
    postLinearComments: false,
    maxRunMs: 1000,
    notifySlack: true,
  });
});

test('toWizardMappings round-trips a mapping so a re-run "keep as-is" loses nothing', () => {
  const config = assembleConfig({
    mappings: [
      mapping({ slackWebhookUrl: 'https://hooks.slack.com/x', toggles: { draftPr: false } }),
    ],
  });

  const back = toWizardMappings(config);
  assert.ok(back);
  assert.deepEqual(back[0].repos, ['/repos/api']);
  assert.equal(back[0].slackWebhookUrl, 'https://hooks.slack.com/x');
  assert.deepEqual(back[0].toggles, { draftPr: false });

  // And re-assembling from the round-tripped mapping is stable.
  const again = assembleConfig({ mappings: back, existing: config });
  assert.deepEqual(again.mappings['proj-1'].overrides, config.mappings['proj-1'].overrides);
  assert.equal(again.mappings['proj-1'].slackWebhookUrl, 'https://hooks.slack.com/x');
});

test('writeConfig creates the config directory and writes parseable pretty JSON', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'law-config-'));
  try {
    const target = join(dir, 'nested', 'config.json');
    const config = assembleConfig({ mappings: [enriched()], botUserId: 'bot-1' });

    await writeConfig(target, config);

    const raw = await readFile(target, 'utf8');
    assert.ok(raw.endsWith('\n'));
    assert.ok(raw.includes('\n  "botUserId"'), 'expected pretty-printed output');
    assert.deepEqual(JSON.parse(raw), config);
    // D-08: no secret-bearing field may ever appear in config.json.
    assert.equal(/LINEAR_API_KEY|NGROK_AUTHTOKEN|authtoken|apiKey/i.test(raw), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('writeConfig is idempotent: assemble -> write -> read -> assemble is stable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'law-config-'));
  try {
    const target = join(dir, 'config.json');
    const first = assembleConfig({ mappings: [enriched()], botUserId: 'bot-1' });
    await writeConfig(target, first);

    const onDisk = JSON.parse(await readFile(target, 'utf8')) as Config;
    const second = assembleConfig({ mappings: [enriched()], botUserId: 'bot-1', existing: onDisk });
    await writeConfig(target, second);

    assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), first);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// -- what the wizard knew and used to discard --------------------------------

test('a project-keyed mapping records the team it belongs to', () => {
  // `listMappingCandidates` has always fetched this and `promptMappingKey` dropped it, so
  // `config.json` had no record of which team a project mapping belonged to. Harmless while
  // the registrar registers with `allPublicTeams: true`; needed the moment scoping narrows.
  const config = assembleConfig({
    mappings: [mapping({ key: { kind: 'project', id: 'proj-1', name: 'Alpha', teamId: 'team-9' } })],
  });
  const entry = config.mappings['proj-1']!;
  assert.equal(entry.ownerTeamId, 'team-9');
  assert.equal(entry.linearTeamId, null, 'the KEY is still the project — the invariant holds');
  assert.equal(entry.linearProjectId, 'proj-1');
});

test('a team-keyed mapping records no ownerTeamId — its key already is the team', () => {
  const config = assembleConfig({
    mappings: [mapping({ key: { kind: 'team', id: 'team-9', name: 'Core' } })],
  });
  assert.equal('ownerTeamId' in config.mappings['team-9']!, false);
});

test('the mapping name survives the round trip, so a re-run shows names not UUIDs', () => {
  // `toWizardMappings` used to build `{ id: key, name: key }`, so re-running `law setup`
  // asked the operator to choose between raw Linear UUIDs.
  const config = assembleConfig({
    mappings: [mapping({ key: { kind: 'project', id: 'proj-1', name: 'Alpha', teamId: 'team-9' } })],
  });
  const restored = toWizardMappings(config)!;

  assert.equal(restored[0]?.key.name, 'Alpha', 'the operator must see the project name');
  assert.equal(restored[0]?.key.teamId, 'team-9', 'and the owning team survives too');
  assert.equal(restored[0]?.key.id, 'proj-1');
});

test('a config written before displayName existed still round-trips, falling back to the id', () => {
  // The upgrade case. Both fields are optional precisely so an operator's existing
  // config.json keeps loading; showing the id is what it did before and is no worse.
  const legacy = {
    mappings: { 'proj-1': { linearProjectId: 'proj-1', linearTeamId: null, repos: [{ repoDir: '/r' }] } },
  } as never;
  const restored = toWizardMappings(legacy)!;
  assert.equal(restored[0]?.key.name, 'proj-1');
  assert.equal(restored[0]?.key.teamId, undefined);
});

test('operatorUserId is written when chosen and absent when declined', () => {
  const chosen = assembleConfig({ mappings: [mapping()], operatorUserId: 'u-ada' });
  assert.equal(chosen.operatorUserId, 'u-ada');

  const declined = assembleConfig({ mappings: [mapping()] });
  assert.equal(
    'operatorUserId' in declined,
    false,
    'declining must not leave an explicit undefined key — it breaks the JSON round trip',
  );
});

// ---------------------------------------------------------------------------
// teamId derivation — the P2 that blocks the P0 (this plan's D0)
// ---------------------------------------------------------------------------

/** A project-keyed mapping that carries its owning team, which is what the wizard has
 *  always had at pick time and used to throw away. */
function projectKeyed(): Mapping {
  return {
    key: { kind: 'project', id: 'proj-1', name: 'Alpha', teamId: 'team-abc' },
    repos: ['/repos/api'],
  };
}

test('a project-keyed mapping derives teamId from its owning team, not ""', () => {
  // The live defect: `index.ts` passes `teamId: ''` for a project-only setup, and the
  // written config then has no team for `webhookCreate` to register against.
  const config = assembleConfig({ mappings: [projectKeyed()], teamId: '' });

  assert.equal(config.teamId, 'team-abc');
});

test('a team-keyed mapping still wins over a project-keyed one', () => {
  const teamKeyed: Mapping = {
    key: { kind: 'team', id: 'team-direct', name: 'Team Direct' },
    repos: ['/repos/api'],
  };

  const config = assembleConfig({ mappings: [projectKeyed(), teamKeyed], teamId: '' });

  assert.equal(config.teamId, 'team-direct');
});

test("a caller's explicit teamId still beats anything derived from the mappings", () => {
  const config = assembleConfig({ mappings: [projectKeyed()], teamId: 'team-explicit' });

  assert.equal(config.teamId, 'team-explicit');
});

test('with no team anywhere in the mappings, an existing config.teamId is kept', () => {
  const existing = assembleConfig({ mappings: [projectKeyed()], teamId: 'team-old' });
  const noTeam: Mapping = { key: { kind: 'project', id: 'proj-2', name: 'Beta' }, repos: ['/r'] };

  const merged = assembleConfig({ mappings: [noTeam], teamId: '', existing });

  assert.equal(merged.teamId, 'team-old');
});
