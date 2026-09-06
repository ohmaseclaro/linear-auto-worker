import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import * as prompts from '@inquirer/prompts';
import type { LinearClient } from '@linear/sdk';

import { buildMappings, listMappingCandidates } from './mapping.js';
import type { Mapping } from './mapping.js';
import type { DiscoveredRepo } from './repo-discovery.js';

// NOTE (RUSH MODE): this file is not executed during this milestone's parallel build — no
// package.json / node_modules exist on this branch yet. Written complete and correct for
// the single, milestone-end integration gate (`tsc --noEmit && node --test`) per
// 01-CONTEXT.md D-13.

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
function queueMock<T>(target: object, method: string, values: T[]) {
  let i = 0;
  return mock.method(target as never, method as never, async () => {
    if (i >= values.length) {
      throw new Error(`${method}() called more times than the test queued values for (call #${i + 1})`);
    }
    return values[i++];
  });
}

function restoreAll(mocks: { mock: { restore(): void } }[]) {
  for (const m of mocks) m.mock.restore();
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

  const selectMock = queueMock(prompts, 'select', ['proj-1']);
  const checkboxMock = queueMock(prompts, 'checkbox', [['/repos/alpha']]);
  const inputMock = queueMock(prompts, 'input', ['']);
  const confirmMock = queueMock(prompts, 'confirm', [false /* wantsOverrides */, false /* addAnother */]);

  try {
    const result = await buildMappings(client, DISCOVERED);

    assert.equal(result.length, 1);
    assert.deepEqual(result[0], {
      key: { kind: 'project', id: 'proj-1', name: 'Project One' },
      repos: ['/repos/alpha'],
      slackWebhookUrl: undefined,
      toggles: undefined,
    });
  } finally {
    restoreAll([selectMock, checkboxMock, inputMock, confirmMock]);
  }
});

test('buildMappings: builds two mappings when the operator opts to add another', async () => {
  const client = fakeLinearClient(
    [{ id: 'team-1', name: 'Team One' }],
    [
      { id: 'proj-1', name: 'Project One', teamId: 'team-1' },
      { id: 'proj-2', name: 'Project Two', teamId: 'team-1' },
    ],
  );

  const selectMock = queueMock(prompts, 'select', ['proj-1', 'proj-2']);
  const checkboxMock = queueMock(prompts, 'checkbox', [['/repos/alpha'], ['/repos/beta']]);
  const inputMock = queueMock(prompts, 'input', ['', '']);
  const confirmMock = queueMock(prompts, 'confirm', [
    false /* wantsOverrides mapping 1 */,
    true /* add another? */,
    false /* wantsOverrides mapping 2 */,
    false /* add another? */,
  ]);

  try {
    const result = await buildMappings(client, DISCOVERED);

    assert.equal(result.length, 2);
    assert.equal(result[0]?.key.id, 'proj-1');
    assert.equal(result[1]?.key.id, 'proj-2');
  } finally {
    restoreAll([selectMock, checkboxMock, inputMock, confirmMock]);
  }
});

test('buildMappings: re-run "keep as-is" leaves an existing mapping byte-identical (D-04, T-08-10)', async () => {
  const client = fakeLinearClient([], []);
  const existingMapping: Mapping = {
    key: { kind: 'project', id: 'proj-1', name: 'Project One' },
    repos: ['/repos/alpha'],
    slackWebhookUrl: 'https://hooks.slack.com/services/abc',
    toggles: { draftPr: true },
  };

  const selectMock = queueMock(prompts, 'select', ['keep']);
  const confirmMock = queueMock(prompts, 'confirm', [false /* add another? */]);

  try {
    const result = await buildMappings(client, DISCOVERED, [existingMapping]);

    assert.equal(result.length, 1);
    assert.equal(result[0], existingMapping, 'must be the exact same object — no partial mutation');
  } finally {
    restoreAll([selectMock, confirmMock]);
  }
});

test('buildMappings: re-run "edit repos" changes only that mapping\'s repos', async () => {
  const client = fakeLinearClient([], []);
  const existingMapping: Mapping = {
    key: { kind: 'project', id: 'proj-1', name: 'Project One' },
    repos: ['/repos/alpha'],
    slackWebhookUrl: 'https://hooks.slack.com/services/abc',
    toggles: { draftPr: true },
  };

  const selectMock = queueMock(prompts, 'select', ['edit-repos']);
  const checkboxMock = queueMock(prompts, 'checkbox', [['/repos/beta']]);
  const confirmMock = queueMock(prompts, 'confirm', [false /* add another? */]);

  try {
    const result = await buildMappings(client, DISCOVERED, [existingMapping]);

    assert.equal(result.length, 1);
    assert.deepEqual(result[0]?.repos, ['/repos/beta']);
    assert.equal(result[0]?.key, existingMapping.key, 'key must be untouched');
    assert.equal(result[0]?.slackWebhookUrl, existingMapping.slackWebhookUrl, 'slack must be untouched');
    assert.deepEqual(result[0]?.toggles, existingMapping.toggles, 'toggles must be untouched');
  } finally {
    restoreAll([selectMock, checkboxMock, confirmMock]);
  }
});

test('buildMappings: a mapping with no toggle overrides selected has no override keys at all (sparse, not empty-valued)', async () => {
  const client = fakeLinearClient(
    [{ id: 'team-1', name: 'Team One' }],
    [{ id: 'proj-1', name: 'Project One', teamId: 'team-1' }],
  );

  const selectMock = queueMock(prompts, 'select', ['proj-1']);
  const checkboxMock = queueMock(prompts, 'checkbox', [
    ['/repos/alpha'] /* repo selection */,
    [] /* toggle names: none chosen even though overrides were opted into */,
  ]);
  const inputMock = queueMock(prompts, 'input', ['']);
  const confirmMock = queueMock(prompts, 'confirm', [true /* wantsOverrides */, false /* add another? */]);

  try {
    const result = await buildMappings(client, DISCOVERED);

    assert.equal(result.length, 1);
    assert.equal(result[0]?.toggles, undefined, 'no toggles object at all, not one with empty keys');
  } finally {
    restoreAll([selectMock, checkboxMock, inputMock, confirmMock]);
  }
});

test('buildMappings: selecting exactly one toggle overrides only that key, sparsely', async () => {
  const client = fakeLinearClient(
    [{ id: 'team-1', name: 'Team One' }],
    [{ id: 'proj-1', name: 'Project One', teamId: 'team-1' }],
  );

  const selectMock = queueMock(prompts, 'select', ['proj-1']);
  const checkboxMock = queueMock(prompts, 'checkbox', [
    ['/repos/alpha'] /* repo selection */,
    ['draftPr'] /* toggle names: only draftPr */,
  ]);
  const inputMock = queueMock(prompts, 'input', ['']);
  const confirmMock = queueMock(prompts, 'confirm', [
    true /* wantsOverrides */,
    true /* draftPr override value */,
    false /* add another? */,
  ]);

  try {
    const result = await buildMappings(client, DISCOVERED);

    assert.equal(result.length, 1);
    assert.deepEqual(result[0]?.toggles, { draftPr: true }, 'exactly one override key, no others');
  } finally {
    restoreAll([selectMock, checkboxMock, inputMock, confirmMock]);
  }
});
