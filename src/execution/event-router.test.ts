/**
 * `event-router.ts` is pure — no process, no socket, no filesystem beyond the fixture
 * read below. AGNT-07, D-05, T31.
 *
 * NOTE (written, not run — RUSH rule 2): this file has never been executed. The
 * milestone's single integration gate (`tsc && node --test dist`) is the first run.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  makeEventRouter,
  assertSessionUsable,
  pickDenials,
  REQUIRED_GSD_SKILLS,
} from './event-router.js';
import type { ProgressUpdate, PermissionDenial, SystemInitEvent } from './event-router.js';
import { PERMISSION_MODE } from './agent-args.js';
import type { Logger } from '../infra/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dirname, 'fixtures', 'stream-events.jsonl');

function silentLogger(): Logger {
  const log: Logger = {
    child: () => log,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  };
  return log;
}

function readFixtureEvents(): unknown[] {
  return readFileSync(FIXTURE_PATH, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

function baseInit(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'system',
    subtype: 'init',
    session_id: 'test-session',
    uuid: 'test-uuid',
    cwd: '/tmp/worktree',
    skills: [...REQUIRED_GSD_SKILLS, 'gsd-quick', 'gsd-debug'],
    permissionMode: PERMISSION_MODE,
    ...overrides,
  };
}

// --- AGNT-07: the loud GSD assertion -------------------------------------------------

test('an init whose skills omit one required GSD entry throws, naming the skill, the count, and both causes', () => {
  const skills = REQUIRED_GSD_SKILLS.filter((s) => s !== 'gsd-plan-phase').concat(['gsd-quick']);
  const init = baseInit({ skills });

  assert.throws(
    () => assertSessionUsable(init as unknown as SystemInitEvent),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      const message = err.message;
      assert.match(message, /gsd-plan-phase/);
      assert.match(message, new RegExp(String(skills.length)));
      assert.match(message, /--bare/);
      assert.match(message, /~\/\.claude/);
      return true;
    }
  );
});

test('an init with all three required skills present and the expected permissionMode does not throw', () => {
  const init = baseInit();
  assert.doesNotThrow(() => assertSessionUsable(init as unknown as SystemInitEvent));
});

test('an init whose permissionMode is manual throws — trap T1 caught at init time', () => {
  const init = baseInit({ permissionMode: 'manual' });

  assert.throws(
    () => assertSessionUsable(init as unknown as SystemInitEvent),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /manual/);
      assert.match(err.message, new RegExp(PERMISSION_MODE));
      return true;
    }
  );
});

test('an init with skills absent entirely (not empty) throws rather than passing on a nullish default', () => {
  const init = baseInit();
  delete (init as Record<string, unknown>)['skills'];

  assert.throws(() => assertSessionUsable(init as unknown as SystemInitEvent));
});

test('an init with an empty skills array still throws, naming all three required skills', () => {
  const init = baseInit({ skills: [] });

  assert.throws(
    () => assertSessionUsable(init as unknown as SystemInitEvent),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      for (const skill of REQUIRED_GSD_SKILLS) {
        assert.match(err.message, new RegExp(skill));
      }
      return true;
    }
  );
});

// --- Replaying the fixture: every pre-init event routes without incident ------------

test('every event before init is routed without error, and the router survives the sixteen pre-init events', () => {
  const events = readFixtureEvents();
  const router = makeEventRouter({ log: silentLogger() });

  let routedInit = false;
  for (const event of events) {
    router.route(event);
    if (
      typeof event === 'object' &&
      event !== null &&
      (event as Record<string, unknown>)['type'] === 'system' &&
      (event as Record<string, unknown>)['subtype'] === 'init'
    ) {
      routedInit = true;
    }
  }

  assert.ok(routedInit, 'the fixture must contain a system/init event');
  assert.ok(router.routed.init, 'router.routed.init must be set after replay');
  assert.ok(router.routed.result, 'router.routed.result must be set after replay');
});

// --- Progress: task_summary and post_turn_summary ------------------------------------

test('system/task_summary invokes the progress callback with its detail', () => {
  const updates: ProgressUpdate[] = [];
  const router = makeEventRouter({ log: silentLogger(), onProgress: (u) => updates.push(u) });

  router.route({ type: 'system', subtype: 'task_summary', detail: 'Writing a file' });

  assert.deepEqual(updates, [{ kind: 'task_summary', detail: 'Writing a file' }]);
});

test('a task_summary detail of null does not invoke the progress callback with null', () => {
  const updates: ProgressUpdate[] = [];
  const router = makeEventRouter({ log: silentLogger(), onProgress: (u) => updates.push(u) });

  router.route({ type: 'system', subtype: 'task_summary', detail: null });

  assert.deepEqual(updates, []);
});

test('system/post_turn_summary invokes the progress callback with status_category, status_detail and needs_action', () => {
  const updates: ProgressUpdate[] = [];
  const router = makeEventRouter({ log: silentLogger(), onProgress: (u) => updates.push(u) });

  router.route({
    type: 'system',
    subtype: 'post_turn_summary',
    status_category: 'completed',
    status_detail: 'Wrote 1 file, ready to commit',
    needs_action: null,
  });

  assert.deepEqual(updates, [
    {
      kind: 'post_turn_summary',
      status_category: 'completed',
      status_detail: 'Wrote 1 file, ready to commit',
      needs_action: null,
    },
  ]);
});

test('a post_turn_summary with status_category "blocked" is surfaced distinctly', () => {
  const updates: ProgressUpdate[] = [];
  const router = makeEventRouter({ log: silentLogger(), onProgress: (u) => updates.push(u) });

  router.route({
    type: 'system',
    subtype: 'post_turn_summary',
    status_category: 'blocked',
    status_detail: 'Write + Bash tools denied; cannot create probe.txt',
    needs_action: 'enable Write tool or reconfigure don\'t-ask mode',
  });

  assert.equal(updates.length, 1);
  assert.equal(updates[0]?.kind, 'post_turn_summary');
  assert.equal((updates[0] as { status_category?: string }).status_category, 'blocked');
});

// --- The denial tally -----------------------------------------------------------------

test('each system/permission_denied increments the tally and records tool_name and decision_reason_type', () => {
  const router = makeEventRouter({ log: silentLogger() });

  router.route({
    type: 'system',
    subtype: 'permission_denied',
    tool_name: 'Write',
    tool_use_id: 'toolu_1',
    tool_input: { file_path: 'src/x.ts' },
    decision_reason_type: 'mode',
  });
  router.route({
    type: 'system',
    subtype: 'permission_denied',
    tool_name: 'Bash',
    tool_use_id: 'toolu_2',
    tool_input: { command: 'git commit | cat' },
    decision_reason_type: 'subcommandResults',
  });

  const denials: readonly PermissionDenial[] = router.denials;
  assert.equal(denials.length, 2);
  assert.equal(denials[0]?.tool_name, 'Write');
  assert.equal(denials[0]?.decision_reason_type, 'mode');
  assert.equal(denials[1]?.tool_name, 'Bash');
  assert.equal(denials[1]?.decision_reason_type, 'subcommandResults');
});

// --- pickDenials: the two-source union ------------------------------------------------

// The shapes below are the ones measured on the COD-7 run (2026-09-08): the SAME
// `tool_use_id` reported twice, once by a `system/permission_denied` event carrying
// `decision_reason_type` and no `tool_input`, once by `result.permission_denials[]`
// carrying `tool_input` and no `decision_reason_type`.
test('pickDenials reports one entry per tool_use_id and keeps the field each source alone carries', () => {
  const fromEvents: PermissionDenial[] = [
    { tool_name: 'Skill', tool_use_id: 'toolu_01V2', tool_input: undefined, decision_reason_type: 'mode' },
    { tool_name: 'Read', tool_use_id: 'toolu_01Un', tool_input: undefined, decision_reason_type: 'mode' },
  ];
  const fromResult: PermissionDenial[] = [
    { tool_name: 'Skill', tool_use_id: 'toolu_01V2', tool_input: { command: 'graphify' } },
    { tool_name: 'Read', tool_use_id: 'toolu_01Un', tool_input: { file_path: 'README.md' } },
  ];

  const picked = pickDenials(fromEvents, fromResult);

  // Two refusals, not four: concatenating the sources is the double count.
  assert.equal(picked.length, 2);
  assert.deepEqual(
    picked.map((d) => d.tool_name),
    ['Skill', 'Read']
  );
  // Both diagnostic fields survive — that is what a union buys over a preference.
  assert.equal(picked[0]?.decision_reason_type, 'mode');
  assert.deepEqual(picked[0]?.tool_input, { command: 'graphify' });
  assert.equal(picked[1]?.decision_reason_type, 'mode');
  assert.deepEqual(picked[1]?.tool_input, { file_path: 'README.md' });
});

test('pickDenials falls back to each source alone, and to [] when the result event is absent', () => {
  const eventOnly: PermissionDenial[] = [
    { tool_name: 'Skill', tool_use_id: 'toolu_01V2', tool_input: undefined, decision_reason_type: 'mode' },
  ];
  const resultOnly: PermissionDenial[] = [
    { tool_name: 'Read', tool_use_id: 'toolu_01Un', tool_input: { file_path: 'x' } },
  ];

  // A REAPED run has no result event at all — the events are the only witness.
  assert.deepEqual(pickDenials(eventOnly, undefined), eventOnly);
  // A run whose events were unparsable still reports what the result carried.
  assert.deepEqual(pickDenials([], resultOnly), resultOnly);
  assert.deepEqual(pickDenials([], undefined), []);
});

// --- The result event: structured_output, never a second parse ------------------------

test("the result event's structured_output is captured deep-equal, with no JSON.parse needed", () => {
  const events = readFixtureEvents();
  const resultEvent = events.find(
    (e) => typeof e === 'object' && e !== null && (e as Record<string, unknown>)['type'] === 'result'
  ) as Record<string, unknown>;
  assert.ok(resultEvent, 'fixture must contain a result event');

  const router = makeEventRouter({ log: silentLogger() });
  router.route(resultEvent);

  assert.deepEqual(router.routed.result?.structured_output, resultEvent['structured_output']);
  // The parsed object is already an object — proof that no re-parse of the string field
  // was needed to get there. structuredOutput must not itself be a JSON string.
  assert.notEqual(typeof router.routed.result?.structured_output, 'string');
});

// --- Forward compatibility --------------------------------------------------------------

test('an unknown event type is ignored without throwing', () => {
  const router = makeEventRouter({ log: silentLogger() });

  assert.doesNotThrow(() =>
    router.route({ type: 'some_future_event_kind', payload: { anything: true } })
  );
  assert.deepEqual(router.routed, {});
  assert.deepEqual(router.denials, []);
});

test('a non-object or null event is ignored without throwing', () => {
  const router = makeEventRouter({ log: silentLogger() });

  assert.doesNotThrow(() => router.route(null));
  assert.doesNotThrow(() => router.route(undefined));
  assert.doesNotThrow(() => router.route('not an object'));
  assert.doesNotThrow(() => router.route(42));
});
