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
  // KNOWN GAP (deferred, not fixed by this plan -- out of files_modified
  // scope; logger.ts belongs to plan 02-01): redact() in logger.ts recurses
  // over Object.entries() with no visited-set/cycle guard, so a genuinely
  // circular object will overflow the call stack rather than redact cleanly.
  // See .planning/phases/02-foundation/deferred-items.md. This assertion
  // documents the required contract per this plan's <behavior> block; it is
  // expected to fail until that gap is closed.
  const circular: Record<string, unknown> = { name: 'self-referencing' };
  circular.self = circular;

  assert.doesNotThrow(() => {
    captureStdout(() => {
      const logger = createLogger([]);
      logger.info({ payload: circular }, 'circular test');
    });
  });
});
