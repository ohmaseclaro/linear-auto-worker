/**
 * The run log's three properties that are not obvious from reading it: the permissions
 * (T-VOH-02 — this file holds raw agent output, and filesystem mode is the ONLY containment
 * it has), the size cap's exactly-once marker, and the age prune.
 */
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  MAX_RUN_LOG_BYTES,
  openRunLog,
  pruneRunLogs,
  runLogDir,
  runLogPath,
  RUN_LOG_TTL_MS,
} from './run-log.js';

function root(): string {
  return mkdtempSync(join(tmpdir(), 'law-runlog-'));
}

/** The stream is async; `close()` only requests the flush. */
function flushed(log: { close(): void }, file: string): Promise<string> {
  log.close();
  return new Promise((resolve) => {
    setTimeout(() => resolve(readFileSync(file, 'utf8')), 50);
  });
}

test('a written event round-trips as exactly one JSON line', async () => {
  const dir = root();
  const log = openRunLog(dir, 'run-1');
  log.write({ type: 'system', subtype: 'init', skills: ['a'] });
  log.write({ type: 'result', subtype: 'success' });
  const text = await flushed(log, runLogPath(dir, 'run-1'));

  const lines = text.split('\n').filter((l) => l.length > 0);
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0] as string), {
    type: 'system',
    subtype: 'init',
    skills: ['a'],
  });
  rmSync(dir, { recursive: true, force: true });
});

test('T-VOH-02: the log is 0600 inside a 0700 directory', async () => {
  const dir = root();
  const log = openRunLog(dir, 'run-1');
  log.write({ type: 'x' });
  await flushed(log, runLogPath(dir, 'run-1'));

  // The mode is the whole containment. This file deliberately bypasses the logger's secret
  // scrubbing — anything the agent read is in it, including a `.env` it happened to cat.
  assert.equal(statSync(runLogDir(dir)).mode & 0o777, 0o700, 'the runs directory');
  assert.equal(statSync(runLogPath(dir, 'run-1')).mode & 0o777, 0o600, 'the log file');
  rmSync(dir, { recursive: true, force: true });
});

test('an existing loose directory is tightened, not left as it was found', async () => {
  const dir = root();
  // mkdir's mode is masked by umask and does nothing at all when the directory already
  // exists — which is the normal case from the second run onward.
  const runs = runLogDir(dir);
  mkdirSync(runs, { recursive: true });
  chmodSync(runs, 0o755);

  const log = openRunLog(dir, 'run-1');
  log.write({ type: 'x' });
  await flushed(log, runLogPath(dir, 'run-1'));
  assert.equal(statSync(runs).mode & 0o777, 0o700);
  rmSync(dir, { recursive: true, force: true });
});

test('T-VOH-03: the size cap writes exactly one truncation marker and then nothing', async () => {
  const dir = root();
  const log = openRunLog(dir, 'run-big');
  // One event just over the cap, then two more. Only the first oversized write may emit a
  // marker; a per-write marker on a busy stream is its own runaway file.
  log.write({ type: 'assistant', filler: 'x'.repeat(MAX_RUN_LOG_BYTES + 10) });
  log.write({ type: 'assistant', filler: 'y'.repeat(MAX_RUN_LOG_BYTES + 10) });
  log.write({ type: 'result' });
  const text = await flushed(log, runLogPath(dir, 'run-big'));

  const lines = text.split('\n').filter((l) => l.length > 0);
  assert.equal(lines.length, 1, 'exactly one line survives the cap');
  const marker = JSON.parse(lines[0] as string) as { type: string };
  assert.equal(marker.type, 'law.truncated');
  rmSync(dir, { recursive: true, force: true });
});

test('write never throws on an unserialisable event', async () => {
  const dir = root();
  const log = openRunLog(dir, 'run-circular');
  const circular: Record<string, unknown> = {};
  circular['self'] = circular;
  assert.doesNotThrow(() => log.write(circular));
  log.write({ type: 'result' });
  const text = await flushed(log, runLogPath(dir, 'run-circular'));
  assert.equal(text.split('\n').filter((l) => l.length > 0).length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test('pruneRunLogs deletes only .jsonl files older than the ttl, and returns them', () => {
  const dir = root();
  const runs = runLogDir(dir);
  const now = Date.now();
  mkdirSync(runs, { recursive: true });

  writeFileSync(join(runs, 'old.jsonl'), '{}\n');
  writeFileSync(join(runs, 'new.jsonl'), '{}\n');
  writeFileSync(join(runs, 'notes.txt'), 'x');
  const stale = (now - RUN_LOG_TTL_MS - 60_000) / 1000;
  utimesSync(join(runs, 'old.jsonl'), stale, stale);
  utimesSync(join(runs, 'notes.txt'), stale, stale);

  const deleted = pruneRunLogs(dir, RUN_LOG_TTL_MS, now);
  assert.deepEqual(deleted, ['old.jsonl']);
  assert.equal(statSync(join(runs, 'new.jsonl')).size > 0, true);
  assert.equal(statSync(join(runs, 'notes.txt')).size > 0, true, 'only *.jsonl is ours');
  rmSync(dir, { recursive: true, force: true });
});

test('a missing runs directory prunes to an empty list rather than throwing', () => {
  const dir = root();
  assert.deepEqual(pruneRunLogs(dir, RUN_LOG_TTL_MS, Date.now()), []);
  rmSync(dir, { recursive: true, force: true });
});
