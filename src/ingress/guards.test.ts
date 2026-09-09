import test from 'node:test';
import assert from 'node:assert/strict';

import { BOT_COMMENT_MARKER } from '../domain/index.js';
import type { GuardPayload } from './guards.js';
import {
  SELF_WRITE_SUPPRESSION_MS,
  incSelfEventDrop,
  noteSelfWrite,
  selfEventDropCounts,
  selfEventGuards,
} from './guards.js';

const BOT = 'bot-user-id';
const HUMAN = 'human-user-id';

const user = (id: string) => ({ id, type: 'user' });

const comment = (id: string, body: string, actor: GuardPayload['actor']): GuardPayload => ({
  actor,
  type: 'Comment',
  data: { id, body },
});

const issue = (id: string, actor: GuardPayload['actor']): GuardPayload => ({
  actor,
  type: 'Issue',
  data: { id },
});

/** The marker value is Phase 1's; never hardcode a literal copy of it here (T32). */
const botBody = (text: string) => `${BOT_COMMENT_MARKER}\n\n${text}`;

const count = (guard: string): number => selfEventDropCounts[guard] ?? 0;

/**
 * One row per case. Assert the guard NAME, not just the boolean: a suite that only checks
 * `drop === true` cannot tell you which layer caught it, and D-09 exists precisely because
 * a layer that never fires looks identical to a layer that works.
 */
type Row = {
  name: string;
  payload: GuardPayload;
  expectedGuard?: string;
  expectedActorType?: string;
  setup?: () => void;
};

const rows: Row[] = [
  {
    name: 'null actor is untrusted, not "not the bot"',
    payload: { ...comment('c-null', 'hello', null) },
    expectedGuard: 'actor:null-untrusted',
  },
  {
    name: 'undefined actor hits the same guard',
    payload: { type: 'Comment', data: { id: 'c-undef', body: 'hello' } },
    expectedGuard: 'actor:null-untrusted',
  },
  {
    name: 'user actor with the bot id drops on identity alone',
    payload: comment('c-self', 'hello', user(BOT)),
    expectedGuard: 'actor:self',
    expectedActorType: 'user',
  },
  {
    name: 'user actor that is someone else passes',
    payload: comment('c-human', 'hello', user(HUMAN)),
    expectedActorType: 'user',
  },
  {
    name: 'integration actor carrying the bot id passes layer 1 — A6, and actorType exposes it',
    payload: comment('c-integration', 'hello', { id: BOT, type: 'integration' }),
    expectedActorType: 'integration',
  },
  {
    name: 'bot marker in the body drops regardless of actor',
    payload: comment('c-marked', botBody('a question'), user(HUMAN)),
    expectedGuard: 'marker:bot-authored',
    expectedActorType: 'user',
  },
  {
    // T119. The ingress leg has to see the marker in the form the writers now emit, or
    // layer 2 quietly stops existing the day the marker changes shape.
    name: 'the NEW link-reference marker drops at layer 2',
    payload: comment('c-lrd', `[//]: # (law-bot)\n\na status update`, user(HUMAN)),
    expectedGuard: 'marker:bot-authored',
    expectedActorType: 'user',
  },
  {
    // The migration arm, at the ingress boundary rather than only in the unit test.
    name: 'a comment carrying the LEGACY marker still drops at layer 2',
    payload: comment('c-legacy', '<!-' + '- law-bot\n\nposted last month', user(HUMAN)),
    expectedGuard: 'marker:bot-authored',
    expectedActorType: 'user',
  },
  {
    name: 'ordinary comment body passes',
    payload: comment('c-plain', 'just a normal comment', user(HUMAN)),
    expectedActorType: 'user',
  },
  {
    name: 'Issue payload has no body — the marker layer does not apply and does not throw',
    payload: issue('i-1', user(HUMAN)),
    expectedActorType: 'user',
  },
  {
    name: 'a write this process just made is suppressed',
    payload: comment('c-selfwrite', 'posted by us', user(HUMAN)),
    expectedGuard: 'suppression:self-write',
    expectedActorType: 'user',
    setup: () => noteSelfWrite('Comment', 'c-selfwrite'),
  },
  {
    name: 'a different entity is not suppressed by a neighbouring self-write',
    payload: comment('c-other', 'not ours', user(HUMAN)),
    expectedActorType: 'user',
    setup: () => noteSelfWrite('Comment', 'c-neighbour'),
  },
];

for (const row of rows) {
  test(`selfEventGuards: ${row.name}`, () => {
    row.setup?.();
    const result = selfEventGuards(row.payload, BOT);
    assert.equal(result.drop, row.expectedGuard !== undefined);
    assert.equal(result.guard, row.expectedGuard);
    assert.equal(result.actorType, row.expectedActorType);
  });
}

test('null actor drops as untrusted, NOT as self (D-08)', () => {
  const result = selfEventGuards({ actor: null, type: 'Comment', data: { id: 'c-d08', body: 'hi' } }, BOT);
  assert.equal(result.drop, true);
  assert.equal(result.guard, 'actor:null-untrusted');
  assert.notEqual(result.guard, 'actor:self');
});

/**
 * D-06 locks the layers as independent. A suite whose fixtures all trip all three proves
 * nothing, so each case below is constructed so the other two layers would pass it.
 */
test('each layer drops alone, with the other two passing (D-06)', () => {
  assert.equal(selfEventGuards(comment('c-i1', 'ordinary', user(BOT)), BOT).guard, 'actor:self');

  assert.equal(
    selfEventGuards(comment('c-i2', botBody('ordinary'), user(HUMAN)), BOT).guard,
    'marker:bot-authored',
  );

  noteSelfWrite('Comment', 'c-i3');
  assert.equal(
    selfEventGuards(comment('c-i3', 'ordinary', user(HUMAN)), BOT).guard,
    'suppression:self-write',
  );
});

test('the suppression window expires', (t) => {
  t.mock.timers.enable({ apis: ['Date'] });

  noteSelfWrite('Comment', 'c-expiry');
  assert.equal(
    selfEventGuards(comment('c-expiry', 'ordinary', user(HUMAN)), BOT).guard,
    'suppression:self-write',
  );

  t.mock.timers.tick(SELF_WRITE_SUPPRESSION_MS);
  assert.equal(selfEventGuards(comment('c-expiry', 'ordinary', user(HUMAN)), BOT).drop, false);
});

/**
 * ROADMAP criterion 4: the counter must be readable while the bot is commenting, and it is
 * per-guard so a dead layer shows as a permanent zero rather than hiding behind a total.
 */
test('selfEventDropCounts increments per guard name (D-09)', () => {
  const before = {
    nullActor: count('actor:null-untrusted'),
    self: count('actor:self'),
    marker: count('marker:bot-authored'),
    suppression: count('suppression:self-write'),
    delivery: count('delivery:duplicate'),
  };

  selfEventGuards(comment('c-k1', 'hi', null), BOT);
  selfEventGuards(comment('c-k2', 'hi', user(BOT)), BOT);
  selfEventGuards(comment('c-k3', 'hi', user(BOT)), BOT);
  selfEventGuards(comment('c-k4', botBody('hi'), user(HUMAN)), BOT);
  noteSelfWrite('Comment', 'c-k5');
  selfEventGuards(comment('c-k5', 'hi', user(HUMAN)), BOT);
  selfEventGuards(comment('c-k6', 'hi', user(HUMAN)), BOT);

  // Layer 4 lives in the receiver (plan 03-05) but shares this counter.
  incSelfEventDrop('delivery:duplicate');

  assert.equal(count('actor:null-untrusted') - before.nullActor, 1);
  assert.equal(count('actor:self') - before.self, 2);
  assert.equal(count('marker:bot-authored') - before.marker, 1);
  assert.equal(count('suppression:self-write') - before.suppression, 1);
  assert.equal(count('delivery:duplicate') - before.delivery, 1);
});
