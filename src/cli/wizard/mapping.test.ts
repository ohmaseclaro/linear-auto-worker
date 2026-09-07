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
 * 30 repos — over `promptRepoSelection`'s filter threshold, and the reason the threshold
 * exists: at inquirer's default `pageSize` of 7 this is already five pages of arrowing.
 */
const MANY: DiscoveredRepo[] = ['alpha', 'beta', 'gamma'].flatMap((prefix) =>
  Array.from({ length: 10 }, (_, i) => ({ path: `/repos/${prefix}-${i}`, name: `${prefix}-${i}` })),
);

/** Swallows library output. Every case passes one: a `console.log` racing `node --test`'s
 *  worker teardown produces "Unable to deserialize cloned data" with nothing to point at. */
const sink = (): void => {};

/** The re-run "edit repos" action calls the same `promptRepoSelection` as a fresh add, and
 *  nothing else on that path consumes `input`/`checkbox` — so a case driving it can leave a
 *  queue empty and have an unexpected prompt call reject rather than silently pass. */
function editReposMapping(): Mapping {
  return { key: { kind: 'project', id: 'proj-1', name: 'Project One' }, repos: [] };
}

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
function scripted(
  script: {
    select?: readonly unknown[];
    checkbox?: readonly unknown[];
    input?: readonly string[];
    confirm?: readonly boolean[];
  },
  seen?: SeenPrompts,
): WizardPrompts {
  const select = queue('select', script.select ?? []);
  const checkbox = queue('checkbox', script.checkbox ?? []);
  const input = queue('input', script.input ?? []);
  const confirm = queue('confirm', script.confirm ?? []);
  return {
    select: <T>(config: ChoiceConfig<T>) => {
      seen?.select.push(config as ChoiceConfig<unknown>);
      return select() as Promise<T>;
    },
    checkbox: <T>(config: ChoiceConfig<T>) => {
      seen?.checkbox.push(config as ChoiceConfig<unknown>);
      return checkbox() as Promise<T[]>;
    },
    input: (config: { message: string }) => {
      seen?.input.push(config);
      return input();
    },
    confirm: (config: { message: string; default?: boolean }) => {
      seen?.confirm.push(config);
      return confirm();
    },
  };
}

/** What was *offered*, not what came back. Asserting on the returned value alone cannot
 *  distinguish "the filter narrowed the list" from "the whole list was rendered and the
 *  operator happened to pick these" — the entire defect n7b is about. */
interface ChoiceConfig<T> {
  message: string;
  choices: ReadonlyArray<{ name: string; value: T }>;
}

interface SeenPrompts {
  select: ChoiceConfig<unknown>[];
  checkbox: ChoiceConfig<unknown>[];
  input: { message: string }[];
  confirm: { message: string; default?: boolean }[];
}

function collector(): SeenPrompts {
  return { select: [], checkbox: [], input: [], confirm: [] };
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
    sink,
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
    sink,
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
    sink,
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
    sink,
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
    sink,
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
    sink,
  );

  assert.equal(result.length, 1);
  assert.deepEqual(result[0]?.toggles, { draftPr: true }, 'exactly one override key, no others');
});

test('buildMappings: the repo trust disclosure is reported once per newly selected repo (T-08-21)', async () => {
  const client = fakeLinearClient(
    [{ id: 'team-1', name: 'Team One' }],
    [{ id: 'proj-1', name: 'Project One', teamId: 'team-1' }],
  );
  const reported: string[] = [];

  await buildMappings(
    client,
    DISCOVERED,
    undefined,
    scripted({
      select: ['proj-1'],
      checkbox: [['/repos/alpha', '/repos/beta']],
      input: [''],
      confirm: [false /* wantsOverrides */, false /* add another? */],
    }),
    (message) => reported.push(message),
  );

  const disclosures = reported.filter((line) => line.includes('--bare'));
  assert.equal(disclosures.length, 2, 'one disclosure per newly mapped repo, no more, no less');
  assert.ok(disclosures.some((line) => line.includes('/repos/alpha')));
  assert.ok(disclosures.some((line) => line.includes('/repos/beta')));
});

test('buildMappings: re-run review prints the existing mapping through the sink, not console', async () => {
  const client = fakeLinearClient([], []);
  const existingMapping: Mapping = {
    key: { kind: 'project', id: 'proj-1', name: 'Project One' },
    repos: ['/repos/alpha'],
    slackWebhookUrl: 'https://hooks.slack.com/services/abc',
    toggles: { draftPr: true },
  };
  const reported: string[] = [];

  await buildMappings(
    client,
    DISCOVERED,
    [existingMapping],
    scripted({ select: ['keep'], confirm: [false /* add another? */] }),
    (message) => reported.push(message),
  );

  assert.ok(reported.some((line) => line.includes('Project One')), 'mapping header went to the sink');
  assert.ok(reported.some((line) => line.includes('repos: /repos/alpha')));
  assert.ok(
    reported.some((line) => line.includes('hooks.slack.com/…')),
    'the webhook URL is still masked to host-only on the sink path',
  );
});

test('promptRepoSelection: a small repo set still goes straight to one checkbox, unfiltered', async () => {
  const seen = collector();

  const result = await buildMappings(
    fakeLinearClient([], []),
    DISCOVERED,
    [editReposMapping()],
    // No `input` queued at all: if the filter loop ran on a 2-repo set, `input()` rejects.
    scripted({ select: ['edit-repos'], checkbox: [['/repos/alpha']], confirm: [false] }, seen),
    sink,
  );

  assert.equal(seen.checkbox.length, 1, 'exactly one checkbox, no filter round-trip');
  assert.deepEqual(
    seen.checkbox[0]?.choices.map((c) => c.value),
    ['/repos/alpha', '/repos/beta'],
    'the whole small set was offered',
  );
  assert.deepEqual(result[0]?.repos, ['/repos/alpha']);
});

test('promptRepoSelection: a large repo set offers only the case-insensitive matches for the term', async () => {
  const seen = collector();

  await buildMappings(
    fakeLinearClient([], []),
    MANY,
    [editReposMapping()],
    scripted(
      {
        select: ['edit-repos'],
        input: ['ALPHA', '' /* done */],
        checkbox: [['/repos/alpha-3']],
        confirm: [false],
      },
      seen,
    ),
    sink,
  );

  assert.equal(seen.checkbox.length, 1);
  assert.deepEqual(
    seen.checkbox[0]?.choices.map((c) => c.value),
    Array.from({ length: 10 }, (_, i) => `/repos/alpha-${i}`),
    'only the 10 matching repos were offered — not all 30, and matching is case-insensitive',
  );
});

test('promptRepoSelection: a term matching nothing re-prompts and never falls back to the full list', async () => {
  const seen = collector();
  const reported: string[] = [];

  await buildMappings(
    fakeLinearClient([], []),
    MANY,
    [editReposMapping()],
    scripted(
      {
        select: ['edit-repos'],
        input: ['zzz', 'alpha', '' /* done */],
        checkbox: [['/repos/alpha-0']],
        confirm: [false],
      },
      seen,
    ),
    (message) => reported.push(message),
  );

  assert.ok(
    reported.some((line) => line.includes('no repo matches "zzz"')),
    'the empty match set was reported',
  );
  assert.equal(seen.checkbox.length, 1, 'the zero-match pass offered no checkbox at all');
});

test('promptRepoSelection: repos picked on an earlier pass leave the pool and are disclosed once each', async () => {
  const seen = collector();
  const reported: string[] = [];

  const result = await buildMappings(
    fakeLinearClient([], []),
    MANY,
    [editReposMapping()],
    scripted(
      {
        select: ['edit-repos'],
        // The same term twice on purpose: a second term that could not have matched the
        // first pick would make the exclusion assertion below vacuous.
        input: ['alpha', 'alpha', '' /* done */],
        checkbox: [['/repos/alpha-0'], ['/repos/alpha-1']],
        confirm: [false],
      },
      seen,
    ),
    (message) => reported.push(message),
  );

  assert.deepEqual(result[0]?.repos, ['/repos/alpha-0', '/repos/alpha-1'], 'insertion-ordered');
  const secondPass = seen.checkbox[1]?.choices.map((c) => c.value) ?? [];
  assert.equal(secondPass.length, 9, 'the pool shrank by the one already picked');
  assert.ok(!secondPass.includes('/repos/alpha-0'), 'an already-selected repo is not re-offered');
  assert.equal(
    reported.filter((line) => line.includes('--bare')).length,
    2,
    'one trust disclosure per newly selected repo on the filtered path too (T-08-21)',
  );
});

test('promptRepoSelection: a blank first term is the escape hatch — no selection, no checkbox', async () => {
  const seen = collector();

  const result = await buildMappings(
    fakeLinearClient([], []),
    MANY,
    [editReposMapping()],
    // No `checkbox` queued: if the loop offered a list anyway, `checkbox()` rejects.
    scripted({ select: ['edit-repos'], input: ['   '], confirm: [false] }, seen),
    sink,
  );

  assert.deepEqual(result[0]?.repos, [], 'whitespace-only finishes with nothing selected');
  assert.equal(seen.checkbox.length, 0);
});

// ---------------------------------------------------------------------------
// A mapping with no repos is refused, never saved (P0 defect 2)
// ---------------------------------------------------------------------------

/** Captures what the operator was told, so the refusal can be asserted on its REASON and
 *  not only on the return value. */
function lines(): { report: (m: string) => void; all: string[] } {
  const all: string[] = [];
  return { report: (m: string) => all.push(m), all };
}

test('buildMappings: a fresh mapping with no repos selected is discarded, with a reason', async () => {
  // The live failure: this wrote `repos: []` into config.json, and `loadConfig` — the
  // daemon's own loader — then threw on the file the wizard had just written.
  const client = fakeLinearClient(
    [{ id: 'team-1', name: 'Team One' }],
    [{ id: 'proj-1', name: 'Project One', teamId: 'team-1' }],
  );
  const out = lines();

  const result = await buildMappings(
    client,
    DISCOVERED,
    undefined,
    // No `input`/`confirm` for Slack/toggles queued: reaching them would reject, which is
    // the point — a discarded mapping must not go on asking about itself.
    scripted({ select: ['proj-1'], checkbox: [[]], confirm: [false /* addAnother */] }),
    out.report,
  );

  assert.deepEqual(result, []);
  assert.ok(
    out.all.some((l) => l.includes('mapping with no repos cannot be saved')),
    `the discard reason must be named; got ${JSON.stringify(out.all)}`,
  );
});

test('buildMappings: an empty first mapping is dropped and the second one is still kept', async () => {
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
      checkbox: [[], ['/repos/beta']],
      input: [''], // Slack, asked only for the mapping that survived
      confirm: [true /* addAnother */, false /* wantsOverrides */, false /* addAnother */],
    }),
    sink,
  );

  assert.equal(result.length, 1, 'exactly one mapping survives');
  assert.equal(result[0]?.key.id, 'proj-2', 'and it is the second one');
  assert.deepEqual(result[0]?.repos, ['/repos/beta']);
});

test('buildMappings: re-run "edit repos" with an empty selection keeps the existing repos', async () => {
  // Never a silent clear: "remove" is the action that already exists for that intent.
  const client = fakeLinearClient([], []);
  const existingRepos = ['/repos/alpha', '/repos/beta'];
  const existingMapping: Mapping = {
    key: { kind: 'project', id: 'proj-1', name: 'Project One' },
    repos: existingRepos,
  };
  const out = lines();

  const result = await buildMappings(
    client,
    DISCOVERED,
    [existingMapping],
    scripted({ select: ['edit-repos'], checkbox: [[]], confirm: [false] }),
    out.report,
  );

  assert.equal(result.length, 1);
  assert.deepEqual(result[0]?.repos, existingRepos, 'byte-identical to the input');
  assert.ok(
    out.all.some((l) => l.includes('choose "remove"')),
    `the operator must be pointed at the action that does remove it; got ${JSON.stringify(out.all)}`,
  );
});
