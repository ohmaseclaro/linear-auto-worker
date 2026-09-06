import test from 'node:test';
import assert from 'node:assert/strict';
import { DeliveryError } from '../domain/errors.js';
import {
  assertPushAllowed,
  findSecrets,
  runPrePushGates,
  touchesCiPaths,
  type SecretHit,
} from './gates.js';

/**
 * Every value below is a FAKE of the right SHAPE. None is a credential. The shapes are what
 * the scanner matches on, so the tests have to carry them.
 */

function diffOf(file: string, addedLines: readonly string[], startLine = 1): string {
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -0,0 +${startLine},${addedLines.length} @@`,
    ...addedLines.map((l) => `+${l}`),
  ].join('\n');
}

// ---------------------------------------------------------------- DELV-04

test('assertPushAllowed refuses the default branch with a named error', () => {
  assert.throws(
    () => assertPushAllowed({ branch: 'main', defaultBranch: 'main' }),
    // The caller distinguishes a refusal from a failure, so the TYPE is the assertion.
    (err: unknown) => err instanceof DeliveryError && err.code === 'DELIVERY'
  );
});

test('assertPushAllowed compares exactly — main-something is an ordinary branch', () => {
  assert.doesNotThrow(() => assertPushAllowed({ branch: 'main-something', defaultBranch: 'main' }));
  assert.doesNotThrow(() => assertPushAllowed({ branch: 'feature/main', defaultBranch: 'main' }));
});

test('runPrePushGates carries the refusal rather than throwing', () => {
  const r = runPrePushGates({ branch: 'main', defaultBranch: 'main', diff: '', files: [] });
  assert.ok(r.refusal);
  assert.equal(r.block, undefined);
});

// ---------------------------------------------------------------- DELV-09

const SECRET_CASES: readonly { name: string; pattern: string; line: string }[] = [
  {
    name: 'github classic PAT',
    pattern: 'github-pat-classic',
    line: 'const token = "ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";',
  },
  {
    name: 'github fine-grained PAT',
    pattern: 'github-pat-fine-grained',
    line: 'GITHUB_TOKEN=github_pat_11AAAAAAA0BBBBBBBBBB_ccccccccccccccc',
  },
  {
    name: 'anthropic key',
    pattern: 'anthropic-api-key',
    line: 'ANTHROPIC_API_KEY=sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA',
  },
  {
    name: 'linear key',
    pattern: 'linear-api-key',
    line: 'LINEAR_API_KEY=lin_api_AAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  },
  {
    name: 'slack bot token',
    pattern: 'slack-bot-token',
    // Assembled at runtime rather than written as a literal. The value below is the real
    // shape a Slack bot token has, which is the point — but a source file containing that
    // shape verbatim is itself flagged by GitHub's push protection (it blocked the very
    // first push of this repository) and by every contributor's local scanner. Splitting
    // the `xoxb` prefix removes the literal without weakening the case: the string this
    // test hands to `findSecrets` is byte-identical to the one it replaced.
    line: `slackToken: "${'xox' + 'b'}-1111111111-2222222222-${'a'.repeat(24)}",`,
  },
  {
    name: 'aws access key id',
    pattern: 'aws-access-key-id',
    line: 'aws_access_key_id = AKIAIOSFODNN7EXAMPLE',
  },
  {
    name: 'pem private key',
    pattern: 'pem-private-key',
    line: '-----BEGIN RSA PRIVATE KEY-----',
  },
  {
    name: 'openai-style key',
    pattern: 'openai-style-api-key',
    line: 'OPENAI_API_KEY=sk-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  },
];

for (const c of SECRET_CASES) {
  test(`findSecrets blocks on ${c.name} and locates it`, () => {
    const hits = findSecrets(diffOf('src/config.ts', ['const a = 1;', c.line], 10));
    assert.equal(hits.length, 1);
    const hit: SecretHit = hits[0]!;
    assert.equal(hit.pattern, c.pattern);
    // "a secret was found" with no location is a report the operator cannot act on.
    assert.equal(hit.file, 'src/config.ts');
    assert.equal(hit.line, 11);
    // The report never echoes the value.
    assert.equal(JSON.stringify(hit).includes(c.line), false);
  });
}

test('a REMOVED secret line does not block — that is the agent cleaning up', () => {
  const diff = [
    'diff --git a/src/config.ts b/src/config.ts',
    '--- a/src/config.ts',
    '+++ b/src/config.ts',
    '@@ -1,2 +1,1 @@',
    '-const token = "ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";',
    ' const other = 1;',
  ].join('\n');
  assert.deepEqual(findSecrets(diff), []);
});

test('the +++ header itself is not scanned as an added line', () => {
  const diff = [
    'diff --git a/notes.md b/notes.md',
    '--- a/notes.md',
    '+++ b/notes.md',
    '@@ -0,0 +1,1 @@',
    '+ordinary prose',
  ].join('\n');
  assert.deepEqual(findSecrets(diff), []);
});

test('a .env file is blocked by path even when its contents match nothing', () => {
  const hits = findSecrets(diffOf('.env', ['PORT=3000'], 1));
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.pattern, 'environment-file');
  assert.equal(hits[0]!.file, '.env');
});

test('.env.local is blocked; .env.example is not', () => {
  assert.equal(findSecrets(diffOf('.env.local', ['A=1'])).length, 1);
  assert.deepEqual(findSecrets(diffOf('.env.example', ['A=1'])), []);
});

test('runPrePushGates sets block, names file and line, and echoes no value', () => {
  const secret = 'AKIAIOSFODNN7EXAMPLE';
  const r = runPrePushGates({
    branch: 'feat/x',
    defaultBranch: 'main',
    diff: diffOf('infra/aws.tf', [`access_key = "${secret}"`], 4),
    files: ['infra/aws.tf'],
  });
  assert.equal(r.refusal, undefined);
  assert.ok(r.block);
  assert.match(r.block!, /infra\/aws\.tf:4/);
  assert.equal(r.block!.includes(secret), false);
});

// ---------------------------------------------------------------- DELV-08

test('a CI path flags without blocking', () => {
  const r = runPrePushGates({
    branch: 'feat/x',
    defaultBranch: 'main',
    diff: diffOf('.github/workflows/ci.yml', ['  run: npm test']),
    files: ['.github/workflows/ci.yml', 'src/a.ts'],
  });
  assert.deepEqual(r.ciPaths, ['.github/workflows/ci.yml']);
  assert.equal(r.block, undefined);
  assert.equal(r.refusal, undefined);
});

test('a file matching nothing sets neither flag nor block', () => {
  const r = runPrePushGates({
    branch: 'feat/x',
    defaultBranch: 'main',
    diff: diffOf('src/a.ts', ['export const a = 1;']),
    files: ['src/a.ts'],
  });
  assert.deepEqual(r.ciPaths, []);
  assert.equal(r.block, undefined);
});

test('.claude/settings.json sets the CI flag — the agent editing its own settings counts', () => {
  assert.deepEqual(touchesCiPaths(['.claude/settings.json']), ['.claude/settings.json']);
});

test('CI matching is on path segments, not substrings', () => {
  assert.deepEqual(touchesCiPaths(['docs/circleci-notes.md']), []);
  assert.deepEqual(touchesCiPaths(['.circleci/config.yml']), ['.circleci/config.yml']);
  assert.deepEqual(touchesCiPaths(['.github/workflows/ci.yml']), ['.github/workflows/ci.yml']);
  assert.deepEqual(touchesCiPaths(['.github/ISSUE_TEMPLATE/bug.md']), []);
});

test('the named CI files match at any depth', () => {
  assert.deepEqual(touchesCiPaths(['.gitlab-ci.yml']), ['.gitlab-ci.yml']);
  assert.deepEqual(touchesCiPaths(['Jenkinsfile']), ['Jenkinsfile']);
});

test('runPrePushGates composes all three so the caller checks one thing', () => {
  const r = runPrePushGates({
    branch: 'main',
    defaultBranch: 'main',
    diff: diffOf('.github/workflows/ci.yml', ['  token: ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA']),
    files: ['.github/workflows/ci.yml'],
  });
  assert.ok(r.refusal);
  assert.ok(r.block);
  assert.deepEqual(r.ciPaths, ['.github/workflows/ci.yml']);
});
