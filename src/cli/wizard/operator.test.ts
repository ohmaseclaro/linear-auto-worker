/**
 * `Config.operatorUserId` — declared, validated, written by nothing.
 *
 * The run engine reads it to add the operator as a subscriber (INTK-03), found it unset,
 * logged a warning and skipped, for the whole milestone. Pickup works by ASSIGNMENT, so the
 * ticket leaves the operator's "Assigned to me" view the moment the bot takes it; without
 * the subscription that is indistinguishable from the bot having dropped the ticket.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { chooseOperator, NO_OPERATOR, type UserCandidate } from './operator.js';
import { realPrompts, type WizardPrompts } from './deps.js';

const BOT = 'bot-user-id';

/** A `select` that records what it was offered and answers with `answer`. */
function picking(answer: string): { prompts: WizardPrompts; offered: string[][] } {
  const offered: string[][] = [];
  const prompts: WizardPrompts = {
    ...realPrompts,
    select: <T,>(config: { message: string; choices: ReadonlyArray<{ name: string; value: T }> }) => {
      offered.push(config.choices.map((c) => c.name));
      return Promise.resolve(answer as T);
    },
  };
  return { prompts, offered };
}

/** A `select` that fails loudly — for the cases where the prompt must not be reached. */
const noPrompts: WizardPrompts = {
  ...realPrompts,
  select: () => Promise.reject(new Error('select() must not be called in this case')),
};

function client(pages: UserCandidate[][]): unknown {
  let call = 0;
  return {
    users: () => {
      const nodes = pages[call] ?? [];
      const hasNextPage = call < pages.length - 1;
      call += 1;
      return Promise.resolve({
        nodes,
        pageInfo: { hasNextPage, endCursor: hasNextPage ? `cursor-${call}` : null },
      });
    },
  };
}

const ADA: UserCandidate = { id: 'u-ada', name: 'Ada', email: 'ada@example.com' };
const GRACE: UserCandidate = { id: 'u-grace', name: 'Grace' };

test('the chosen user id is returned', async () => {
  const { prompts } = picking('u-ada');
  assert.equal(await chooseOperator(client([[ADA, GRACE]]), { prompts, botUserId: BOT }), 'u-ada');
});

test('the bot is never offered as the operator', async () => {
  const { prompts, offered } = picking('u-ada');
  await chooseOperator(client([[ADA, { id: BOT, name: 'The Bot' }]]), { prompts, botUserId: BOT });
  assert.ok(
    !offered[0]?.some((name) => name.includes('The Bot')),
    'subscribing the bot to its own ticket achieves nothing',
  );
});

test('a deactivated user is not offered', async () => {
  const { prompts, offered } = picking('u-ada');
  await chooseOperator(client([[ADA, { id: 'u-old', name: 'Departed', active: false }]]), {
    prompts,
    botUserId: BOT,
  });
  assert.ok(!offered[0]?.some((name) => name.includes('Departed')));
});

test('declining returns undefined, and that is not an error', async () => {
  const { prompts } = picking(NO_OPERATOR);
  assert.equal(
    await chooseOperator(client([[ADA]]), { prompts, botUserId: BOT }),
    undefined,
    'an unattended box must be able to complete setup without subscribing anyone',
  );
});

test('every page of users is offered, and none twice (T22)', async () => {
  // `fetchNext()` mutates and returns `this`, appending into the same array — the trap
  // this module pages around with explicit cursors. A workspace with 60 members would
  // otherwise show the first 50 twice and the last 10 never.
  const page1 = Array.from({ length: 50 }, (_, i) => ({ id: `u-${i}`, name: `User ${i}` }));
  const page2 = [{ id: 'u-50', name: 'User 50' }];
  const { prompts, offered } = picking('u-50');
  await chooseOperator(client([page1, page2]), { prompts, botUserId: BOT });

  const names = offered[0] ?? [];
  assert.ok(names.includes('User 50'), 'the second page was never fetched');
  assert.equal(new Set(names).size, names.length, 'a name appeared twice — pagination double-counted');
});

test('the current value is offered first, so a re-run is one keystroke', async () => {
  const { prompts, offered } = picking('u-grace');
  await chooseOperator(client([[ADA, GRACE]]), { prompts, botUserId: BOT, existing: 'u-grace' });
  assert.match(offered[0]?.[0] ?? '', /Grace.*\(current\)/);
});

test('a workspace whose key cannot list users keeps the existing value and never prompts', async () => {
  // Failing the whole wizard over a convenience feature would trade a missing nicety for an
  // unusable product. `noPrompts` rejects, so reaching the prompt at all fails this case.
  const failing = { users: () => Promise.reject(new Error('403')) };
  assert.equal(
    await chooseOperator(failing, { prompts: noPrompts, botUserId: BOT, existing: 'u-ada' }),
    'u-ada',
  );
});
