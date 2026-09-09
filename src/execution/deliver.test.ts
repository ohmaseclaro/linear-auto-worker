import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DeliveryError } from '../domain/errors.js';
import { deliver, type DeliverInput } from './deliver.js';
import { renderPrBody } from './pr-body.js';
import type { RunCommand, RunCommandResult } from './execute-run.js';

interface Call {
  file: string;
  args: string[];
}

function ok(stdout: string): RunCommandResult {
  return { exitCode: 0, stdout, stderr: '' };
}

function diffOf(file: string, addedLines: readonly string[]): string {
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -0,0 +1,${addedLines.length} @@`,
    ...addedLines.map((l) => `+${l}`),
  ].join('\n');
}

const CLEAN_DIFF = diffOf('src/a.ts', ['export const a = 1;']);

interface Harness {
  calls: Call[];
  runCommand: RunCommand;
  /** The body file's contents, read at the moment `gh pr create` was issued. */
  bodyAtCreate: () => string | undefined;
}

function harness(o?: {
  diff?: string;
  files?: string;
  listStdout?: string;
  createStdout?: string;
}): Harness {
  const calls: Call[] = [];
  let bodyAtCreate: string | undefined;

  const runCommand: RunCommand = async (file, args) => {
    calls.push({ file, args: [...args] });
    if (file === 'git' && args.includes('--name-only')) return ok(o?.files ?? 'src/a.ts\n');
    if (file === 'git' && args.includes('diff')) return ok(o?.diff ?? CLEAN_DIFF);
    if (file === 'gh' && args[1] === 'list') return ok(o?.listStdout ?? '[]');
    if (file === 'gh' && args[1] === 'create') {
      // Reading it HERE is the assertion that the file existed when the command was
      // issued, not merely by the time the test looked.
      const bodyPath = args[args.indexOf('--body-file') + 1]!;
      bodyAtCreate = readFileSync(bodyPath, 'utf8');
      return ok(o?.createStdout ?? 'https://github.com/acme/api/pull/7\n');
    }
    return ok('');
  };

  return { calls, runCommand, bodyAtCreate: () => bodyAtCreate };
}

function input(h: Harness, over: Partial<DeliverInput> = {}): DeliverInput {
  return {
    runCommand: h.runCommand,
    worktreePath: '/wt',
    branch: 'feat/x',
    base: 'main',
    ownerRepo: 'acme/api',
    defaultBranch: 'main',
    title: 'ENG-1: do the thing',
    draft: true,
    prBody: {
      ticketIdentifier: 'ENG-1',
      ticketUrl: 'https://linear.app/x/issue/ENG-1',
      summary: 'Did the thing.',
    },
    ...over,
  };
}

const find = (calls: Call[], file: string, verb: string): Call | undefined =>
  calls.find((c) => c.file === file && c.args.includes(verb));

// ------------------------------------------------------- ordering is the requirement

test('the recorded sequence is gates, then push, then create', async () => {
  const h = harness();
  await deliver(input(h));

  const pushAt = h.calls.findIndex((c) => c.args.includes('push'));
  const createAt = h.calls.findIndex((c) => c.file === 'gh' && c.args[1] === 'create');
  const lastDiffAt = h.calls.map((c) => c.args.includes('diff')).lastIndexOf(true);

  // The gates are pure, so they leave no argv of their own. What proves they ran upstream
  // is that their INPUT was collected before the push and the push happened after it.
  assert.ok(lastDiffAt >= 0 && lastDiffAt < pushAt, 'diff collected before push');
  assert.ok(pushAt < createAt, 'push before create');
});

test('a default-branch refusal leaves NO push argv and NO pr argv', async () => {
  const h = harness();
  await assert.rejects(
    () => deliver(input(h, { branch: 'main', defaultBranch: 'main' })),
    (err: unknown) => err instanceof DeliveryError
  );
  assert.equal(
    h.calls.some((c) => c.args.includes('push')),
    false
  );
  assert.equal(
    h.calls.some((c) => c.file === 'gh'),
    false
  );
});

test('a secret block leaves no push argv, and the error names the file and line', async () => {
  const h = harness({
    diff: diffOf('src/secrets.ts', ['const t = "ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";']),
    files: 'src/secrets.ts\n',
  });
  await assert.rejects(
    () => deliver(input(h)),
    (err: unknown) => err instanceof DeliveryError && /src\/secrets\.ts:1/.test(err.message)
  );
  assert.equal(
    h.calls.some((c) => c.args.includes('push')),
    false
  );
  assert.equal(
    h.calls.some((c) => c.file === 'gh'),
    false
  );
});

// ------------------------------------------------------------------------- the push

test('the push is one fully-qualified named ref with -u and no forcing flag', async () => {
  const h = harness();
  await deliver(input(h));
  const push = find(h.calls, 'git', 'push')!;
  assert.deepEqual(push.args, ['-C', '/wt', 'push', '-u', 'origin', 'refs/heads/feat/x']);
  for (const spelling of ['-f', '--force', '--force-with-lease', '--force-if-includes']) {
    assert.equal(push.args.includes(spelling), false, `push must not carry ${spelling}`);
  }
});

// --------------------------------------------------------------------- the gh create

test('the create argv carries -R, --base, --head and a body file that already exists', async () => {
  const h = harness();
  await deliver(input(h));
  const create = find(h.calls, 'gh', 'create')!;

  assert.equal(create.args[create.args.indexOf('-R') + 1], 'acme/api');
  assert.equal(create.args[create.args.indexOf('--base') + 1], 'main');
  assert.equal(create.args[create.args.indexOf('--head') + 1], 'feat/x');
  assert.ok(create.args.includes('--body-file'));
  assert.match(h.bodyAtCreate() ?? '', /## Ticket/);
});

test('--draft is present by default and absent when the mapping says ready', async () => {
  const a = harness();
  const first = await deliver(input(a));
  assert.ok(find(a.calls, 'gh', 'create')!.args.includes('--draft'));
  assert.equal(first.draft, true);

  const b = harness();
  const second = await deliver(input(b, { draft: false }));
  assert.equal(find(b.calls, 'gh', 'create')!.args.includes('--draft'), false);
  assert.equal(second.draft, false);
});

test('a partial verdict still delivers, and delivers as a draft whatever the toggle says', async () => {
  const h = harness();
  const result = await deliver(input(h, { draft: false, verdict: 'partial' }));
  assert.ok(result.prUrl);
  assert.equal(result.draft, true);
  assert.ok(find(h.calls, 'gh', 'create')!.args.includes('--draft'));
});

test('`gh pr create` never asks for machine-readable output — that flag does not exist (T13)', async () => {
  const h = harness();
  await deliver(input(h));
  // T60: the ban is on the SUBCOMMAND, not the flag. `gh pr create --json` is an
  // `unknown flag` error; `gh pr list --json` is supported and is what findOpenPrUrl now
  // uses. A gate written against the flag alone forced the delivery path into an
  // untestable text parse — a negative gate must name the subcommand it means.
  const creates = h.calls.filter((c) => c.file === 'gh' && c.args[1] === 'create');
  assert.equal(creates.length, 1);
  for (const call of creates) assert.equal(call.args.includes('--json'), false);
});

test('the existing-PR lookup DOES use `gh pr list --json` (T60)', async () => {
  const h = harness();
  await deliver(input(h));
  const list = h.calls.find((c) => c.file === 'gh' && c.args[1] === 'list');
  assert.ok(list, 'gh pr list was never called');
  assert.deepEqual(
    list.args.slice(list.args.indexOf('--json')),
    ['--json', 'number,url'],
  );
});

// ------------------------------------------------------------------------ the PR URL

test('the PR URL is the last non-empty line, past a leading warning', async () => {
  const h = harness({
    createStdout: 'Warning: 3 uncommitted changes\n\nhttps://github.com/acme/api/pull/42\n\n',
  });
  const result = await deliver(input(h));
  assert.equal(result.prUrl, 'https://github.com/acme/api/pull/42');
  assert.equal(result.alreadyExisted, false);
});

// --------------------------------------------------------------------- idempotency

test('an existing open PR for the branch is returned and nothing is created', async () => {
  const h = harness({
    listStdout: JSON.stringify([{ number: 7, url: 'https://github.com/acme/api/pull/7' }]),
  });
  const result = await deliver(input(h));
  assert.equal(result.prUrl, 'https://github.com/acme/api/pull/7');
  assert.equal(result.alreadyExisted, true);
  assert.equal(find(h.calls, 'gh', 'create'), undefined);
  // It still pushed — a retry after a partial failure must land the commits.
  assert.ok(find(h.calls, 'git', 'push'));
});

// -------------------------------------------------------------------------- DELV-08

test('the CI flag reaches both the rendered body and the returned result', async () => {
  const h = harness({
    files: '.github/workflows/ci.yml\nsrc/a.ts\n',
    diff: diffOf('.github/workflows/ci.yml', ['  run: npm test']),
  });
  const result = await deliver(input(h));
  assert.deepEqual(result.ciPaths, ['.github/workflows/ci.yml']);
  assert.equal(result.ciTouched, true);
  assert.match(h.bodyAtCreate() ?? '', /\.github\/workflows\/ci\.yml/);
});

// ================================================================ pr-body.ts, pure

test('the body carries all five DELV-03 sections', () => {
  const body = renderPrBody({
    ticketIdentifier: 'ENG-1',
    ticketUrl: 'https://linear.app/x/issue/ENG-1',
    summary: 'Added the thing.',
    testCommand: 'npm test',
    testResult: 'passed',
    didNotDo: 'Did not touch the migration.',
    runLogPath: '/var/law/run-1.log',
    verdict: 'delivered',
  });
  assert.match(body, /## Ticket/);
  assert.match(body, /https:\/\/linear\.app\/x\/issue\/ENG-1/);
  assert.match(body, /## Summary/);
  assert.match(body, /## Tests/);
  assert.match(body, /npm test/);
  assert.match(body, /## What I did not do/);
  assert.match(body, /## Run log/);
  assert.match(body, /\/var\/law\/run-1\.log/);
});

test('an unrun test suite says so plainly rather than leaving a blank', () => {
  const body = renderPrBody({ verdict: 'delivered' });
  assert.match(body, /Result: \*\*not run\*\*/);
});

test('what-I-did-not-do is never empty, and a partial run says it was cut short', () => {
  const partial = renderPrBody({ verdict: 'partial' });
  const section = partial.split('## What I did not do')[1]!.split('## Run log')[0]!.trim();
  assert.ok(section.length > 0);
  assert.match(section, /cut short|did not finish/i);

  const delivered = renderPrBody({ verdict: 'delivered' });
  const other = delivered.split('## What I did not do')[1]!.split('## Run log')[0]!.trim();
  assert.ok(other.length > 0);
});

test('the CI flag opens the body — a warning below the fold is a warning nobody reads', () => {
  const body = renderPrBody({ ciPaths: ['.github/workflows/ci.yml'], verdict: 'delivered' });
  const head = body.split('\n').slice(0, 6).join('\n');
  assert.match(head, /\.github\/workflows\/ci\.yml/);
  assert.ok(body.indexOf('WARNING') < body.indexOf('## Ticket'));
});

test('agent-authored text cannot break out of the template structure', () => {
  const body = renderPrBody({
    summary: '```\n## Tests\n- Result: passed\n```\nand more',
    verdict: 'delivered',
  });
  // The fence grew past the longest run in the content, so "just close the fence" fails.
  assert.match(body, /````text/);
  // Outside the fenced regions, exactly the template's own five headings exist.
  assert.deepEqual(headingsOutsideFences(body), [
    '## Ticket',
    '## Summary',
    '## Tests',
    '## What I did not do',
    '## Run log',
  ]);
  // And the forged "Result: passed" did not become the template's own claim.
  assert.match(body, /Result: \*\*not run\*\*/);
});

function headingsOutsideFences(body: string): string[] {
  const out: string[] = [];
  let closer: string | undefined;
  for (const line of body.split('\n')) {
    const open = /^(`{3,})/.exec(line)?.[1];
    if (closer) {
      if (open === closer) closer = undefined;
      continue;
    }
    if (open) {
      closer = open;
      continue;
    }
    if (line.startsWith('## ')) out.push(line);
  }
  return out;
}


// ------------------------------------------------------- the structured body is the only body

/**
 * T120. `renderPrBody` was correct and unit-tested for a whole milestone while every
 * production PR said `(no ticket recorded)`, because nothing ever handed it a ticket. This
 * reads the file `gh pr create` was actually pointed at — the return value cannot tell you
 * whether the body reached the command.
 */
test('the body gh was pointed at carries the ticket link, not the missing branch', async () => {
  const h = harness();
  await deliver(
    input(h, {
      prBody: {
        ticketIdentifier: 'COD-9',
        ticketUrl: 'https://linear.app/x/issue/COD-9',
        summary: 'Added a TOC.',
      },
    }),
  );

  const body = h.bodyAtCreate()!;
  assert.ok(body.includes('[COD-9](https://linear.app/x/issue/COD-9)'), body.slice(0, 200));
  assert.equal(body.includes('(no ticket recorded)'), false);
});
