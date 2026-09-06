/**
 * `stream-parser.ts` is pure and imports nothing but its own types, so every case here
 * runs with no `claude` binary, no child process, no filesystem beyond the one fixture
 * read below. AGNT-06, D-08.
 *
 * NOTE (written, not run — RUSH rule 2): this file has never been executed. The
 * milestone's single integration gate (`tsc && node --test dist`) is the first run.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeLineParser } from './stream-parser.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dirname, 'fixtures', 'stream-events.jsonl');

/** A representative event whose serialized form has a long string value to split inside. */
function midTokenEvent(): Record<string, unknown> {
  return {
    type: 'system',
    subtype: 'task_summary',
    detail: 'Writing a fairly long detail string so there are many byte offsets to split at',
    session_id: '8f14e045-fceb-4dc7-a1b2-8f3c9f5a2e10',
    uuid: '00000000-0000-4000-8000-0000000000aa',
  };
}

test('a JSON object split mid-token across two chunk boundaries parses into exactly one event', () => {
  const event = midTokenEvent();
  const line = JSON.stringify(event) + '\n';
  // Chosen to land inside the "detail" string value, not at a line/token boundary —
  // this is the exact bug D-08 names, not a convenient split point.
  const midTokenOffset = line.indexOf('fairly long') + 5;

  const events: unknown[] = [];
  const bad: string[] = [];
  const parser = makeLineParser(
    (e) => events.push(e),
    (l) => bad.push(l)
  );

  parser.push(line.slice(0, midTokenOffset));
  parser.push(line.slice(midTokenOffset));

  assert.equal(events.length, 1);
  assert.deepEqual(events[0], event);
  assert.equal(bad.length, 0);
});

test('every offset at which the event can be split across two chunks yields exactly one event', () => {
  const event = midTokenEvent();
  const line = JSON.stringify(event) + '\n';

  // The loop IS the test: a single hand-picked split point above only proves the case
  // that happened to be chosen. This proves every offset in the serialized string.
  for (let offset = 1; offset < line.length; offset++) {
    const events: unknown[] = [];
    const bad: string[] = [];
    const parser = makeLineParser(
      (e) => events.push(e),
      (l) => bad.push(l)
    );

    parser.push(line.slice(0, offset));
    parser.push(line.slice(offset));

    assert.equal(events.length, 1, `offset ${offset} did not yield exactly one event`);
    assert.deepEqual(events[0], event, `offset ${offset} corrupted the event`);
    assert.equal(bad.length, 0, `offset ${offset} produced a bad line`);
  }
});

test('several events in one chunk yield several events, in order', () => {
  const e1 = { type: 'system', subtype: 'task_summary', detail: 'first' };
  const e2 = { type: 'system', subtype: 'task_summary', detail: 'second' };
  const e3 = { type: 'system', subtype: 'task_summary', detail: 'third' };
  const chunk = [e1, e2, e3].map((e) => JSON.stringify(e)).join('\n') + '\n';

  const events: unknown[] = [];
  const parser = makeLineParser(
    (e) => events.push(e),
    () => {
      throw new Error('unexpected bad line');
    }
  );

  parser.push(chunk);

  assert.deepEqual(events, [e1, e2, e3]);
});

test('a chunk ending exactly on a newline leaves nothing in the carry', () => {
  const e1 = { type: 'system', subtype: 'task_summary', detail: 'first' };
  const e2 = { type: 'system', subtype: 'task_summary', detail: 'second' };

  const events: unknown[] = [];
  const parser = makeLineParser(
    (e) => events.push(e),
    () => {
      throw new Error('unexpected bad line');
    }
  );

  parser.push(JSON.stringify(e1) + '\n');
  assert.deepEqual(events, [e1]);

  // If anything survived in the carry, this second push would corrupt e2's parse.
  parser.push(JSON.stringify(e2) + '\n');
  assert.deepEqual(events, [e1, e2]);
});

test('blank and whitespace-only lines are skipped without reaching onEvent or onBad', () => {
  const e1 = { type: 'system', subtype: 'task_summary', detail: 'first' };

  const events: unknown[] = [];
  const bad: string[] = [];
  const parser = makeLineParser(
    (e) => events.push(e),
    (l) => bad.push(l)
  );

  parser.push('\n' + '   \n' + '\t\n' + JSON.stringify(e1) + '\n' + '\n');

  assert.deepEqual(events, [e1]);
  assert.equal(bad.length, 0);
});

test('an unparseable line reaches onBad and does not stop the events after it', () => {
  const e1 = { type: 'system', subtype: 'task_summary', detail: 'before' };
  const e2 = { type: 'system', subtype: 'task_summary', detail: 'after' };
  const badLine = '{not valid json at all';

  const events: unknown[] = [];
  const bad: string[] = [];
  const parser = makeLineParser(
    (e) => events.push(e),
    (l) => bad.push(l)
  );

  parser.push(JSON.stringify(e1) + '\n' + badLine + '\n' + JSON.stringify(e2) + '\n');

  assert.deepEqual(bad, [badLine]);
  // The count after the bad line is the assertion that matters: a parser that silently
  // stops on a bad line is a hung run, not a reported one.
  assert.deepEqual(events, [e1, e2]);
});

test('flush() emits a trailing event with no newline', () => {
  const e1 = { type: 'system', subtype: 'task_summary', detail: 'trailing' };

  const events: unknown[] = [];
  const parser = makeLineParser(
    (e) => events.push(e),
    () => {
      throw new Error('unexpected bad line');
    }
  );

  parser.push(JSON.stringify(e1)); // no trailing newline
  assert.deepEqual(events, []);

  parser.flush();
  assert.deepEqual(events, [e1]);
});

test('flush() emits nothing when the carry is empty', () => {
  const events: unknown[] = [];
  const parser = makeLineParser(
    (e) => events.push(e),
    () => {
      throw new Error('unexpected bad line');
    }
  );

  parser.push(JSON.stringify({ type: 'system', subtype: 'task_summary' }) + '\n');
  events.length = 0; // that event already flowed through push(); clear before flushing

  parser.flush();
  assert.deepEqual(events, []);
});

test('calling flush() twice emits once', () => {
  const e1 = { type: 'system', subtype: 'task_summary', detail: 'trailing' };

  const events: unknown[] = [];
  const parser = makeLineParser(
    (e) => events.push(e),
    () => {
      throw new Error('unexpected bad line');
    }
  );

  parser.push(JSON.stringify(e1)); // no trailing newline
  parser.flush();
  parser.flush();

  assert.deepEqual(events, [e1]);
});

test('an unbounded line with no newline is reported and reset rather than growing forever', () => {
  const events: unknown[] = [];
  const bad: string[] = [];
  const parser = makeLineParser(
    (e) => events.push(e),
    (l) => bad.push(l)
  );

  // Well past the 8 MiB ceiling, with no newline anywhere in it.
  const runaway = 'x'.repeat(9 * 1024 * 1024);
  parser.push(runaway);

  assert.equal(events.length, 0);
  assert.equal(bad.length, 1);

  // The reset must actually have happened: a normal event pushed afterwards still parses.
  const e1 = { type: 'system', subtype: 'task_summary', detail: 'recovered' };
  parser.push(JSON.stringify(e1) + '\n');
  assert.deepEqual(events, [e1]);
});

test('replaying the fixture in randomly-sized chunks yields exactly the fixture event count, in order', () => {
  const raw = readFileSync(FIXTURE_PATH, 'utf8');
  const fixtureLines = raw.split('\n').filter((l) => l.trim().length > 0);
  const expected = fixtureLines.map((l) => JSON.parse(l));

  // Fixed, seeded sequence of chunk sizes — deterministic, not Math.random(), so the test
  // reproduces identically on every run while still crossing event boundaries at
  // arbitrary, non-line-aligned points.
  const CHUNK_SIZES = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233, 377];

  const events: unknown[] = [];
  const bad: string[] = [];
  const parser = makeLineParser(
    (e) => events.push(e),
    (l) => bad.push(l)
  );

  let offset = 0;
  let sizeIndex = 0;
  while (offset < raw.length) {
    const size = CHUNK_SIZES[sizeIndex % CHUNK_SIZES.length]!;
    parser.push(raw.slice(offset, offset + size));
    offset += size;
    sizeIndex++;
  }
  parser.flush();

  assert.equal(bad.length, 0);
  assert.equal(events.length, expected.length);
  assert.deepEqual(events, expected);
});
