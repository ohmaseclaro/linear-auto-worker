/**
 * One test per quiet misconfiguration. AGNT-04, AGNT-05, D-01, D-02, D-03, T1, T2, T3, T27.
 *
 * Every failure mode this file guards exits 0 with `is_error: false`. The happy path and
 * the three catastrophic misconfigurations are indistinguishable from the outside, so a
 * suite that only proves the happy path proves nothing at all. Each test below is named
 * for the trap it would catch on reintroduction.
 *
 * Pure: no child process, no filesystem, no `claude` binary.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ALLOWED_TOOLS,
  OUTPUT_FORMAT,
  PERMISSION_MODE,
  PERMISSION_PROMPTS,
  buildClaudeArgs,
  buildResumeArgs,
  type ClaudeArgsInput,
} from './agent-args.js';

const SESSION = '3f1a9c74-6d20-4b8e-9a51-0c7d2e5f8b13';
const SCHEMA = {
  type: 'object',
  properties: { status: { type: 'string', enum: ['complete', 'needs_input'] } },
  required: ['status'],
  additionalProperties: false,
};

const MAX_TURNS = 40;

function input(over: Partial<ClaudeArgsInput> = {}): ClaudeArgsInput {
  return {
    sessionId: SESSION,
    prompt: 'implement the ticket',
    schema: SCHEMA,
    maxTurns: MAX_TURNS,
    ...over,
  };
}

/** The entry immediately following `flag`, or undefined if the flag is absent. */
function after(args: readonly string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i < 0 ? undefined : args[i + 1];
}

function count(args: readonly string[], flag: string): number {
  return args.filter((a) => a === flag).length;
}

/** Both argument lists, so no assertion below can pass on one path and rot on the other. */
const BOTH: ReadonlyArray<[string, (o: ClaudeArgsInput) => string[]]> = [
  ['buildClaudeArgs', buildClaudeArgs],
  ['buildResumeArgs', buildResumeArgs],
];

test('T1/T27: the permission mode and its allowlist ship together, never apart', () => {
  // Asserted in ONE test on purpose. Two separate passing tests would both stay green
  // while the pair drifted apart, and `dontAsk` without the allowlist was MEASURED to
  // deny Write with decision_reason_type:"mode", create nothing, and exit 0 with
  // is_error:false — trap T1 reached through the very flag chosen to avoid T1.
  assert.equal(PERMISSION_MODE, 'dontAsk');

  for (const [name, build] of BOTH) {
    const args = build(input());

    assert.equal(after(args, '--permission-mode'), 'dontAsk', `${name}: mode`);

    const at = args.indexOf('--allowedTools');
    assert.ok(at >= 0, `${name}: the allowlist is absent — the mode alone produces nothing`);
    assert.deepEqual(
      args.slice(at + 1, at + 1 + ALLOWED_TOOLS.length),
      ['Write', 'Edit', 'Bash'],
      `${name}: each tool must be its own argv entry, not one space-joined string`
    );
  }
});

test('T2: the forbidden flag is emitted by nothing', () => {
  // --bare skips ~/.claude auto-discovery, where the operator's global GSD install lives.
  // Every run would silently produce generic non-GSD work and exit 0. Asserted on the
  // ARRAY, never on the source text: the source must mention it, in the D-02 comment
  // that stops a future contributor adding it back after reading the vendor docs.
  for (const [name, build] of BOTH) {
    for (const arg of build(input())) {
      assert.notEqual(arg, '--bare', `${name}: --bare is forbidden`);
      assert.ok(!arg.startsWith('--bare'), `${name}: no --bare variant either, got ${arg}`);
    }
  }
});

test('T3: stream-json output implies --verbose', () => {
  // Written as an implication rather than two unconditional presence checks, so the
  // pairing is still guarded if the output format ever becomes conditional. Omitting
  // --verbose is a hard startup error, not a warning.
  for (const [name, build] of BOTH) {
    const args = build(input());
    if (after(args, '--output-format') === OUTPUT_FORMAT) {
      assert.ok(args.includes('--verbose'), `${name}: stream-json without --verbose`);
    }
  }
  assert.equal(OUTPUT_FORMAT, 'stream-json');
});

test('the pre-assigned session id appears exactly once, unmodified', () => {
  // D-04 / T4: persisted to the run row before the spawn, never parsed back out of the
  // stream — 16 hook events precede system/init.
  const args = buildClaudeArgs(input());
  assert.equal(count(args, '--session-id'), 1);
  assert.equal(after(args, '--session-id'), SESSION);
});

test('--json-schema carries the caller schema and round-trips deep-equal', () => {
  const args = buildClaudeArgs(input());
  const payload = after(args, '--json-schema');
  assert.equal(typeof payload, 'string');
  assert.deepEqual(JSON.parse(payload as string), SCHEMA);
});

test('--permission-prompts is none, because nobody is present to answer one', () => {
  assert.equal(PERMISSION_PROMPTS, 'none');
  for (const [name, build] of BOTH) {
    assert.equal(after(build(input()), '--permission-prompts'), 'none', name);
  }
});

test('argv-array safety: a hostile prompt reaches the array as exactly one entry', () => {
  // This is what makes injection from a Linear issue title structurally impossible rather
  // than filtered. No shell is involved anywhere on this path, so quoting is not a
  // concern that exists — but only for as long as the prompt stays a single entry.
  const hostile = 'line one\n"quoted"; $(rm -rf /) `whoami` --bare';
  const plain = buildClaudeArgs(input({ prompt: 'plain' }));
  const nasty = buildClaudeArgs(input({ prompt: hostile }));

  assert.equal(nasty.length, plain.length);
  assert.equal(after(nasty, '-p'), hostile);
  assert.equal(count(nasty, hostile), 1);
});

test('T57: buildResumeArgs keeps -p, drops --session-id, keeps the rest', () => {
  // The plan and the research both said "replace -p with --resume". Taken literally the
  // worker resumes the session and then says NOTHING to it — the human's answer never
  // arrives and the whole Q&A feature is inert while every log line looks healthy.
  // --session-id is the flag that actually hard-errors on reuse:
  // "Session ID <uuid> is already in use.", exit 1, empty stdout.
  const answer = 'use the existing migration runner';
  const args = buildResumeArgs(input({ prompt: answer }));

  assert.equal(after(args, '--resume'), SESSION);
  assert.ok(!args.includes('--session-id'), 'a spent session id is a hard error on reuse');
  assert.equal(after(args, '-p'), answer, 'without -p the resumed session is never told the answer');

  // The resumed turn is still a supervised, schema-constrained, non-interactive turn.
  assert.equal(after(args, '--permission-mode'), PERMISSION_MODE);
  assert.ok(args.includes('--allowedTools'));
  assert.ok(args.includes('--verbose'));
  assert.ok(args.includes('--json-schema'));
});

test('the fresh and resumed paths agree on every flag value they share', () => {
  // The drift is invisible until a resumed session silently produces nothing, which is to
  // say until an answered question silently produces nothing.
  const fresh = buildClaudeArgs(input());
  const resumed = buildResumeArgs(input());
  for (const flag of ['--output-format', '--permission-mode', '--permission-prompts', '--json-schema']) {
    assert.equal(after(resumed, flag), after(fresh, flag), flag);
  }
  const a = fresh.indexOf('--allowedTools');
  const b = resumed.indexOf('--allowedTools');
  assert.deepEqual(
    resumed.slice(b + 1, b + 1 + ALLOWED_TOOLS.length),
    fresh.slice(a + 1, a + 1 + ALLOWED_TOOLS.length)
  );
});

// -- the two caps, wired at the release pass ---------------------------------
//
// `Config.maxTurns` and `Config.maxBudgetUsd` were validated by the schema, written by the
// setup wizard, and read by nothing — the operator was told they had limits that did not
// exist. Both CLI flags were verified real on 2.1.259 by passing a non-numeric value:
// `--max-turns` is absent from `--help` but answers
// `option '--max-turns <turns>' argument 'notanumber' is invalid. must be a number`,
// which an unknown flag does not (it answers `unknown option`).

test('both paths carry --max-turns, and it is the configured value', () => {
  for (const [name, build] of BOTH) {
    const args = build(input({ maxTurns: 7 }));
    assert.equal(count(args, '--max-turns'), 1, name);
    assert.equal(after(args, '--max-turns'), '7', name);
  }
});

test('--max-budget-usd is present only when a budget is configured', () => {
  for (const [name, build] of BOTH) {
    assert.equal(
      count(build(input()), '--max-budget-usd'),
      0,
      `${name}: no budget configured must mean no flag — the CLI rejects a non-positive one`,
    );
    const args = build(input({ maxBudgetUsd: 2.5 }));
    assert.equal(count(args, '--max-budget-usd'), 1, name);
    assert.equal(after(args, '--max-budget-usd'), '2.5', name);
  }
});

test('a resumed session is capped exactly like a fresh one', () => {
  // The same reason the permission mode lives in `commonArgs`: a resumed session that
  // inherited no cap is an uncapped run reached through the Q&A path, and every log line
  // would look healthy.
  const o = input({ maxTurns: 12, maxBudgetUsd: 3 });
  for (const flag of ['--max-turns', '--max-budget-usd'] as const) {
    assert.equal(
      after(buildResumeArgs(o), flag),
      after(buildClaudeArgs(o), flag),
      `${flag} differs between a fresh and a resumed session`,
    );
  }
});
