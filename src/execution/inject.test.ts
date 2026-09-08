/**
 * The registry, and both ends of the real socket on a real `mkdtemp` root.
 *
 * No doubles anywhere: `serveInjections` and `sendInjection` are the shipping pair, a Unix
 * socket is a local resource, and the mode assertions are the ONLY authentication this
 * channel has (T-VOH-01).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createInjector,
  MAX_SAY_BYTES,
  sendInjection,
  serveInjections,
  socketPath,
  userMessageLine,
} from './inject.js';
import type { Logger } from '../infra/logger.js';

const silent = {
  child: () => silent,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as unknown as Logger;

function root(): string {
  // 0700-tightened by `serveInjections`; mkdtemp already gives 0700 on macOS/Linux.
  return mkdtempSync(join(tmpdir(), 'law-inject-'));
}

// ── the registry ──────────────────────────────────────────────────────────────

test('register / send / unregister, and an unknown run is a named refusal', () => {
  const injector = createInjector();
  const said: string[] = [];
  const unregister = injector.register('run-1', (text) => {
    said.push(text);
    return true;
  });

  assert.deepEqual(injector.send('run-1', 'hello'), { ok: true });
  assert.deepEqual(said, ['hello']);

  const missing = injector.send('run-2', 'hello');
  assert.equal(missing.ok, false);
  assert.match(missing.ok === false ? missing.error : '', /no live agent/);

  unregister();
  assert.equal(injector.send('run-1', 'hello').ok, false);
});

test('a send the supervisor refuses is reported as the turn having ended, not as success', () => {
  // `send` returns false once stdin has been closed — which happens on the first `result`
  // and again when the run ends. That is the injection window closing, and the operator
  // must be told, not told "ok".
  const injector = createInjector();
  injector.register('run-1', () => false);
  const outcome = injector.send('run-1', 'too late');
  assert.equal(outcome.ok, false);
  assert.match(outcome.ok === false ? outcome.error : '', /no longer accepting input/);
});

test('unregistering a stale registration does not tear down a newer one for the same run', () => {
  // A resumed session re-registers under the same run id. The old unregister must be inert.
  const injector = createInjector();
  const stale = injector.register('run-1', () => false);
  injector.register('run-1', () => true);
  stale();
  assert.deepEqual(injector.send('run-1', 'hi'), { ok: true });
});

// ── the socket, both ends ─────────────────────────────────────────────────────

test('T-VOH-01: the socket is 0600 inside a 0700 directory, and it answers', async () => {
  const dir = root();
  const injector = createInjector();
  const said: string[] = [];
  injector.register('run-1', (text) => {
    said.push(text);
    return true;
  });
  const server = await serveInjections({ injector, root: dir, log: silent });
  try {
    assert.equal(statSync(socketPath(dir)).mode & 0o777, 0o600, 'the socket');
    assert.equal(statSync(dir).mode & 0o777, 0o700, 'the directory it lives in');

    assert.deepEqual(await sendInjection({ root: dir, runId: 'run-1', text: 'go' }), {
      ok: true,
    });
    assert.deepEqual(said, ['go']);

    const refused = await sendInjection({ root: dir, runId: 'nope', text: 'go' });
    assert.equal(refused.ok, false);
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T-VOH-04: an oversize payload is refused and does not reach the agent', async () => {
  const dir = root();
  const injector = createInjector();
  let reached = 0;
  injector.register('run-1', () => {
    reached += 1;
    return true;
  });
  const server = await serveInjections({ injector, root: dir, log: silent });
  try {
    const outcome = await sendInjection({
      root: dir,
      runId: 'run-1',
      text: 'x'.repeat(MAX_SAY_BYTES + 1),
    });
    assert.equal(outcome.ok, false);
    assert.match(outcome.ok === false ? outcome.error : '', /too large/);
    assert.equal(reached, 0);
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a malformed line is refused without throwing into the daemon', async () => {
  const dir = root();
  const injector = createInjector();
  const server = await serveInjections({ injector, root: dir, log: silent });
  try {
    const { connect } = await import('node:net');
    const reply = await new Promise<string>((resolve) => {
      const socket = connect(socketPath(dir));
      socket.setEncoding('utf8');
      let buffer = '';
      socket.on('connect', () => socket.write('this is not json\n'));
      socket.on('data', (chunk: string) => {
        buffer += chunk;
      });
      socket.on('close', () => resolve(buffer));
    });
    assert.match(reply, /malformed request/);

    // And the server is still serving — a bad client must not take it down.
    const after = await sendInjection({ root: dir, runId: 'nope', text: 'hi' });
    assert.equal(after.ok, false);
    assert.match(after.ok === false ? after.error : '', /no live agent/);
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no socket at all resolves the "daemon is not running" failure rather than hanging', async () => {
  const dir = root();
  const outcome = await sendInjection({ root: dir, runId: 'run-1', text: 'hi' });
  assert.equal(outcome.ok, false);
  assert.match(outcome.ok === false ? outcome.error : '', /daemon is not running/);
  rmSync(dir, { recursive: true, force: true });
});

test('FLAG-E: a leftover REGULAR FILE at the socket path is replaced, not treated as a rival', async () => {
  // On macOS, connecting to a regular file answers ENOTSOCK, not ECONNREFUSED — and a
  // dangling path can answer ENOENT between the exists-check and the connect. A probe that
  // names only ECONNREFUSED and treats every other errno as "another daemon owns this
  // root" turns a stale file into a BOOT-BLOCKING false positive.
  const dir = root();
  writeFileSync(socketPath(dir), 'not a socket');
  const injector = createInjector();
  const server = await serveInjections({ injector, root: dir, log: silent });
  try {
    assert.equal(statSync(socketPath(dir)).isSocket(), true, 'the leftover was replaced');
    const outcome = await sendInjection({ root: dir, runId: 'nope', text: 'hi' });
    assert.equal(outcome.ok, false, 'and the replacement is serving');
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T-VOH-05: a LIVE socket is refused, never stolen', async () => {
  const dir = root();
  const first = await serveInjections({ injector: createInjector(), root: dir, log: silent });
  try {
    await assert.rejects(
      serveInjections({ injector: createInjector(), root: dir, log: silent }),
      /another law daemon is already listening/,
    );
  } finally {
    await first.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('close() unlinks the path, so the next boot has nothing to reason about', async () => {
  const dir = root();
  const server = await serveInjections({ injector: createInjector(), root: dir, log: silent });
  await server.close();
  assert.equal(
    (await sendInjection({ root: dir, runId: 'x', text: 'y' })).ok,
    false,
    'nothing answers once it is closed',
  );
  rmSync(dir, { recursive: true, force: true });
});

test('the envelope is agent-args\' own, not a second copy', () => {
  // T72/T92/T96 are all "two implementations of one rule". `inject.ts` re-exports
  // `userMessageLine`; it does not define one.
  assert.deepEqual(JSON.parse(userMessageLine('hi')), {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
  });
});
