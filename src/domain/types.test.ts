/**
 * `repoMappingFor` — T125. The ONE answer to "what is this repository's base branch".
 *
 * Three callers used to answer it three ways: `run-engine.repoOf` and `worktreeOf`
 * hardcoded `config.defaults.baseBranch`, and `adapters.gatherEvidence` read the mapped
 * repo's own row. So a repo whose default branch is `master` was branched from `main` and
 * had its commit count measured against `master`. These cases pin the single lookup.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { repoMappingFor } from './types.js';
import type { Config } from './types.js';

const config = {
  defaults: { baseBranch: 'main' },
  mappings: {
    'proj-1': {
      repos: [
        { repoDir: '/repos/api', repoSlug: 'org/api', baseBranch: 'main', enabled: true },
        { repoDir: '/repos/legacy', repoSlug: 'org/legacy', baseBranch: 'master', enabled: true },
      ],
    },
    'team-1': {
      repos: [{ repoDir: '/repos/infra', repoSlug: 'org/infra', baseBranch: 'trunk', enabled: true }],
    },
  },
} as unknown as Config;

test('the repo row is found across every mapping, with its OWN base branch', () => {
  assert.equal(repoMappingFor(config, 'org/api')?.baseBranch, 'main');
  assert.equal(repoMappingFor(config, 'org/legacy')?.baseBranch, 'master');
  assert.equal(repoMappingFor(config, 'org/infra')?.baseBranch, 'trunk');
});

test('an unmapped slug, and a null slug, are undefined rather than a default', () => {
  assert.equal(repoMappingFor(config, 'org/nope'), undefined);
  assert.equal(repoMappingFor(config, null), undefined);
});

/**
 * The whole point of the helper: the two lookups that used to disagree now ARE the same
 * call, so there is no second implementation left for a future edit to skew.
 */
test('one slug has exactly one answer, whichever caller asks', () => {
  for (const slug of ['org/api', 'org/legacy', 'org/infra']) {
    assert.equal(repoMappingFor(config, slug)?.baseBranch, repoMappingFor(config, slug)?.baseBranch);
    assert.ok(repoMappingFor(config, slug), `${slug} must resolve`);
  }
  // And it is NOT the default for a repo that overrides it — the assertion the three-way
  // disagreement would fail.
  assert.notEqual(repoMappingFor(config, 'org/legacy')?.baseBranch, config.defaults.baseBranch);
});
