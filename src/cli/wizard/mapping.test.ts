import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LinearClient } from '@linear/sdk';

import { buildMappings, listMappingCandidates } from './mapping.js';
import type { Mapping } from './mapping.js';
import type { WizardPrompts } from './deps.js';
import type { DiscoveredRepo } from './repo-discovery.js';

// First executed by plan 07-06. Originally written against
// `mock.method(prompts, 'select', …)`, which threw `Cannot redefine property: select` on all
// six cases — an ESM namespace binding is non-configurable by specification. `buildMappings`
// now takes the prompt bag as a default parameter (`deps.ts`), so a scripted operator is
// just an argument.

const DISCOVERED: DiscoveredRepo[] = [
  { path: '/repos/alpha', name: 'alpha' },
  { path: '/repos/beta', name: 'beta' },
];

/**
 * Minimal stand-in for the two `LinearClient` connections this module pages. `teams`/
 * `projects` mirror the real SDK's `{first, after}` → `{nodes, pageInfo}` connection shape;
 * each project node exposes its own `teams()` connection, matching `SdkProjectNode`.
 */
function fakeLinearClient(
  teams: { id: string; name: string }[],
  projects: { id: string; name: string; teamId: string }[],
): LinearClient {
  function page<N>(all: N[], vars: { first: number; after?: string }) {
    const start = vars.after ? Number(vars.after) : 0;
    const slice = all.slice(start, start + vars.first);
    const end = start + slice.length;
    return {
      nodes: slice,
      pageInfo: { hasNextPage: end < all.length, endCursor: String(end) },
    };
  }

  const client = {
    teams: async (vars: { first: number; after?: string }) => page(teams, vars),
    projects: async (vars: { first: number; after?: string }) => {
      const result = page(projects, vars);
      return {
        ...result,
        nodes: result.nodes.map((p) => ({
          id: p.id,
          name: p.name,
          teams: async (teamVars: { first: number }) =>
            page([{ id: p.teamId, name: 'team-for-' + p.id }], { first: teamVars.first }),
        })),
      };
    },
  };
  return client as unknown as LinearClient;
}

/** Pop the next queued value on each call; fails loudly (not silently `undefined`) once the
 *  queue is exhausted — an over-eager prompt call is a real bug, not a fixture gap. */
function queue<T>(name: string, values: readonly T[]): () => Promise<T> {
  let i = 0;
  return () => {
    if (i >= values.length) {
      return Promise.reject(
        new Error(`${name}() called more times than the test queued values for (call #${i + 1})`),
      );
    }
    return Promise.resolve(values[i++] as T);
  };
}

/**
 * A scripted operator. Anything the case did not queue REJECTS rather than returning
 * `undefined` — a prompt sequence that drifts is the bug these cases exist to catch.
 *
 * The casts are structural, not escapes: each prompt is generic over its own value type and
 * a single queue answers one call site with one concrete type.
 */
function scripted(script: {
  select?: readonly unknown[];
  checkbox?: readonly unknown[];
  input?: readonly string[];
  confirm?: readonly boolean[];
}): WizardPrompts {
  const select = queue('select', script.select ?? []);
  const checkbox = queue('checkbox', script.checkbox ?? []);
  const input = queue('input', script.input ?? []);
  const confirm = queue('confirm', script.confirm ?? []);
  return {
    select: <T>() => select() as Promise<T>,
    checkbox: <T>() => checkbox() as Promise<T[]>,
    input: () => input(),
    confirm: () => confirm(),
  };
}

test('listMappingCandidates: pages teams/projects past the 50-item connection default (Pitfall 11)', async () => {
  const teams = Array.from({ length: 62 }, (_, i) => ({ id: `team-${i}`, name: `Team ${i}` }));
  const projects = Array.from({ length: 5 }, (_, i) => ({
    id: `proj-${i}`,
    name: `Project ${i}`,
    teamId: 'team-0',
  }));
  const client = fakeLinearClient(teams, projects);

  const result = await listMappingCandidates(client);

  assert.equal(result.teams.length, 62, 'must not silently truncate at the 50-item default');
  assert.equal(result.projects.length, 5);
  assert.equal(result.projects[0]?.teamId, 'team-0');
});

test('buildMappings: builds one mapping and stops when the operator declines another', async () => {
  const client = fakeLinearClient(
    [{ id: 'team-1', name: 'Team One' }],
    [{ id: 'proj-1', name: 'Project One', teamId: 'team-1' }],
  );

  const result = await buildMappings(
    client,
    DISCOVERED,
    undefined,
    scripted({
      select: ['proj-1'],
      checkbox: [['/repos/alpha']],
      input: [''],
      confirm: [false /* wantsOverrides */, false /* addAnother */],
    }),
  );

  assert.equal(result.length, 1);
  assert.deepEqual(result[0], {
    // `teamId` is carried since the release pass: the candidate lister always fetched the
    // project's team and `promptMappingKey` discarded it, so `config.json` had no record of
    // which team a project-keyed mapping belonged to.
    key: { kind: 'project', id: 'proj-1', name: 'Project One', teamId: 'team-1' },
    repos: ['/repos/alpha'],
    slackWebhookUrl: undefined,
    toggles: undefined,
  });
});

test('buildMappings: builds two mappings when the operator opts to add another', async () => {
  const client = fakeLinearClient(
    [{ id: 'team-1', name: 'Team One' }],
    [
      { id: 'proj-1', name: 'Project One', teamId: 'team-1' },
      { id: 'proj-2', name: 'Project Two', teamId: 'team-1' },
    ],
  );

  const result = await buildMappings(
    client,
    DISCOVERED,
    undefined,
    scripted({
      select: ['proj-1', 'proj-2'],
      checkbox: [['/repos/alpha'], ['/repos/beta']],
      input: ['', ''],
      confirm: [
        false /* wantsOverrides mapping 1 */,
        true /* add another? */,
        false /* wantsOverrides mapping 2 */,
        false /* add another? */,
      ],
    }),
  );

  assert.equal(result.length, 2);
  assert.equal(result[0]?.key.id, 'proj-1');
  assert.equal(result[1]?.key.id, 'proj-2');
});

test('buildMappings: re-run "keep as-is" leaves an existing mapping byte-identical (D-04, T-08-10)', async () => {
  const client = fakeLinearClient([], []);
  const existingMapping: Mapping = {
    key: { kind: 'project', id: 'proj-1', name: 'Project One' },
    repos: ['/repos/alpha'],
    slackWebhookUrl: 'https://hooks.slack.com/services/abc',
    toggles: { draftPr: true },
  };

  const result = await buildMappings(
    client,
    DISCOVERED,
    [existingMapping],
    scripted({ select: ['keep'], confirm: [false /* add another? */] }),
  );

  assert.equal(result.length, 1);
  assert.equal(result[0], existingMapping, 'must be the exact same object — no partial mutation');
});

test('buildMappings: re-run "edit repos" changes only that mapping\'s repos', async () => {
  const client = fakeLinearClient([], []);
  const existingMapping: Mapping = {
    key: { kind: 'project', id: 'proj-1', name: 'Project One' },
    repos: ['/repos/alpha'],
    slackWebhookUrl: 'https://hooks.slack.com/services/abc',
    toggles: { draftPr: true },
  };

  const result = await buildMappings(
    client,
    DISCOVERED,
    [existingMapping],
    scripted({
      select: ['edit-repos'],
      checkbox: [['/repos/beta']],
      confirm: [false /* add another? */],
    }),
  );

  assert.equal(result.length, 1);
  assert.deepEqual(result[0]?.repos, ['/repos/beta']);
  assert.equal(result[0]?.key, existingMapping.key, 'key must be untouched');
  assert.equal(result[0]?.slackWebhookUrl, existingMapping.slackWebhookUrl, 'slack must be untouched');
  assert.deepEqual(result[0]?.toggles, existingMapping.toggles, 'toggles must be untouched');
});

test('buildMappings: a mapping with no toggle overrides selected has no override keys at all (sparse, not empty-valued)', async () => {
  const client = fakeLinearClient(
    [{ id: 'team-1', name: 'Team One' }],
    [{ id: 'proj-1', name: 'Project One', teamId: 'team-1' }],
  );

  const result = await buildMappings(
    client,
    DISCOVERED,
    undefined,
    scripted({
      select: ['proj-1'],
      checkbox: [
        ['/repos/alpha'] /* repo selection */,
        [] /* toggle names: none chosen even though overrides were opted into */,
      ],
      input: [''],
      confirm: [true /* wantsOverrides */, false /* add another? */],
    }),
  );

  assert.equal(result.length, 1);
  assert.equal(result[0]?.toggles, undefined, 'no toggles object at all, not one with empty keys');
});

test('buildMappings: selecting exactly one toggle overrides only that key, sparsely', async () => {
  const client = fakeLinearClient(
    [{ id: 'team-1', name: 'Team One' }],
    [{ id: 'proj-1', name: 'Project One', teamId: 'team-1' }],
  );

  const result = await buildMappings(
    client,
    DISCOVERED,
    undefined,
    scripted({
      select: ['proj-1'],
      checkbox: [
        ['/repos/alpha'] /* repo selection */,
        ['draftPr'] /* toggle names: only draftPr */,
      ],
      input: [''],
      confirm: [
        true /* wantsOverrides */,
        true /* draftPr override value */,
        false /* add another? */,
      ],
    }),
  );

  assert.equal(result.length, 1);
  assert.deepEqual(result[0]?.toggles, { draftPr: true }, 'exactly one override key, no others');
});
