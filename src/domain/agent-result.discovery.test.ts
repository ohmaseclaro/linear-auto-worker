/**
 * The repo-discovery reply, and the deletion of the wire field it must never be confused
 * with (T126).
 *
 * `parseRepoDiscovery`'s output decides which repositories the real session may WRITE to,
 * so it is narrowed exactly as strictly as `parseAgentResult`: the shape is matched, never
 * inferred, and a partly-valid answer is a rejection rather than a partial acceptance.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AgentResultSchema, RepoDiscoverySchema, parseRepoDiscovery } from './agent-result.js';

test('a well-formed reply parses to its list of names', () => {
  assert.deepEqual(parseRepoDiscovery({ repos: ['org/api', 'org/web'] }), ['org/api', 'org/web']);
  assert.deepEqual(parseRepoDiscovery({ repos: [] }), [], 'an empty list is VALID — it is the caller’s fallback, not a parse error');
});

test('a missing field, a non-array and a non-string member each throw, naming what was wrong', () => {
  for (const [raw, pattern] of [
    [{}, /"repos"/],
    [{ repos: 'org/api' }, /array/],
    [{ repos: ['org/api', 7] }, /string/],
    [null, /not an object/],
    [['org/api'], /not an object/],
  ] as const) {
    assert.throws(() => parseRepoDiscovery(raw), pattern, `for ${JSON.stringify(raw)}`);
  }
});

test('the discovery schema forbids anything it does not list, like its sibling', () => {
  assert.equal(RepoDiscoverySchema.additionalProperties, false);
  assert.deepEqual(RepoDiscoverySchema.required, ['repos']);
});

/**
 * T126. `AgentResultSchema.changedRepos` was a wire field the agent could return that
 * nothing read — and it is exactly the lever a careless implementation of the multi-repo
 * feature reaches for. Asserted on the SCHEMA OBJECT so re-adding it is a red test rather
 * than a code review nobody runs.
 */
test('T126: the agent has no way to tell the worker which repositories it changed', () => {
  assert.ok(
    !('changedRepos' in AgentResultSchema.properties),
    'which repositories got a pull request is judged from git — never from the agent’s claim',
  );
  assert.equal(AgentResultSchema.additionalProperties, false, 'so an unlisted field cannot be returned at all');
});
