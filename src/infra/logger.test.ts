// RUSH mode: written against plan 01's logger.ts. NOT run in this session --
// nothing is installed (no node_modules). Verified by inspection only.
//
// createLogger() has no destination-injection parameter, and this plan's
// files_modified scope excludes logger.ts (it belongs to plan 02-01), so
// capture works by swapping process.stdout.write for the duration of each
// test -- the only sink SecretScrubbingStream._write() writes to. This
// avoids a `Contract additions requested` entry for a constructor parameter
// that turned out not to be needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from './logger.js';

function captureStdout<T>(run: () => T): { result: T; lines: string[] } {
  const lines: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as any).write = (chunk: unknown) => {
    lines.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
    return true;
  };
  try {
    const result = run();
    return { result, lines };
  } finally {
    process.stdout.write = original;
  }
}

const FAKE_LINEAR_KEY = 'lin_api_fake_boot_time_secret_value';

test('a boot-time secret value never appears in a captured log line', () => {
  const { lines } = captureStdout(() => {
    const logger = createLogger([FAKE_LINEAR_KEY]);
    logger.info({ apiKey: FAKE_LINEAR_KEY }, 'booted');
  });
  const output = lines.join('');
  assert.ok(output.length > 0, 'expected at least one log line to be written');
  assert.ok(!output.includes(FAKE_LINEAR_KEY));
});

test('an authorization-named field is redacted independent of the value list (D-05 key-pattern half)', () => {
  const { lines } = captureStdout(() => {
    const logger = createLogger([]); // no initial secrets registered
    logger.info({ authorization: 'lin_api_should_not_appear' }, 'incoming request');
  });
  const output = lines.join('');
  assert.ok(!output.includes('lin_api_should_not_appear'));
});

test('registerSecret() called after the logger already exists redacts from its first subsequent log line (D-05/D-06 value-level half)', () => {
  const webhookSecretValue = 'whsec_generated_after_boot_by_phase_3';
  const { lines } = captureStdout(() => {
    const logger = createLogger([FAKE_LINEAR_KEY]); // only the boot-time secret known so far
    logger.registerSecret(webhookSecretValue);
    // The value rides inside an ordinary string field, not a key named
    // "secret" -- proves the value-level scrub, not the key-pattern half.
    logger.info(
      { context: `tunnel ready, registered webhook with signing config ${webhookSecretValue}` },
      'webhook registered'
    );
  });
  const output = lines.join('');
  assert.ok(!output.includes(webhookSecretValue));
});

test('child() carries runId/issueId bindings and inherits redaction with no per-child setup', () => {
  const secretValue = 'lin_api_child_inherited_secret';
  const { lines } = captureStdout(() => {
    const logger = createLogger([secretValue]);
    const child = logger.child({ runId: 'r1', issueId: 'ENG-1' });
    child.info({ note: `retry after ${secretValue}` }, 'child log line');
  });
  const output = lines.join('');
  assert.ok(output.includes('r1'));
  assert.ok(output.includes('ENG-1'));
  assert.ok(!output.includes(secretValue));
});

test('a circular object logged through the redaction walker does not throw and does not hang', () => {
  // TRAPS T48, filed by 02-02 as a known gap and CLOSED by 07-06 (the first run that could
  // observe it): `redact()` now carries a visited WeakSet. This is the log sink — every
  // layer calls it on every path — so a stack overflow here takes the daemon down over a
  // field that happens to hold a back-reference.
  const circular: Record<string, unknown> = { name: 'self-referencing' };
  circular.self = circular;

  let lines: string[] = [];
  assert.doesNotThrow(() => {
    lines = captureStdout(() => {
      const logger = createLogger([]);
      logger.info({ payload: circular }, 'circular test');
    }).lines;
  });

  // Not just "did not throw": the surviving line must still carry the non-circular fields,
  // or a guard that returned an empty object would pass the assertion above.
  const output = lines.join('\n');
  assert.match(output, /self-referencing/);
  assert.match(output, /\[CIRCULAR\]/);
});

test('a token COUNT is not mistaken for a token (the D6 false positive)', () => {
  // `SECRET_KEY_PATTERN` is a substring match, so `tokensUsed` matched `token` and every
  // terminal log line reported `"tokensUsed":"[REDACTED]"`. Invisible while gap D6 had it
  // hardcoded to `0`; the moment D6 gave it a real value, the value was unreadable.
  const { lines } = captureStdout(() => {
    createLogger([]).info({ tokensUsed: 61_626, costUsd: 1.23 }, 'run.terminal');
  });
  const output = lines.join('');
  assert.match(output, /"tokensUsed":61626/, 'a token count is a number, not a credential');
  assert.match(output, /"costUsd":1\.23/);
});

test('the exception list did not open a hole — secret-named fields still redact', () => {
  // The whole risk of fixing the above by loosening the pattern instead of listing one
  // exception. Over-redaction is the safe error for a log sink; these must stay redacted
  // whether or not their value was ever registered.
  const { lines } = captureStdout(() => {
    const logger = createLogger([]);
    logger.info(
      {
        apiKey: 'lin_api_never_print_me',
        webhookSecret: 'shhh_never_print_me',
        authtoken: 'ngrok_never_print_me',
        authorization: 'bearer_never_print_me',
      },
      'still redacted',
    );
  });
  const output = lines.join('');
  for (const value of [
    'lin_api_never_print_me',
    'shhh_never_print_me',
    'ngrok_never_print_me',
    'bearer_never_print_me',
  ]) {
    assert.ok(!output.includes(value), `${value} reached the log`);
  }
});
