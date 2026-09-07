/**
 * Which Linear user is the operator — the human the bot works for.
 *
 * `Config.operatorUserId` was declared, validated, and written by nothing. The run engine
 * reads it to add the operator as a subscriber (INTK-03) and, finding it unset, logged a
 * warning and skipped. The consequence is not cosmetic: pickup works by ASSIGNMENT, so the
 * moment the bot takes a ticket it leaves the operator's "Assigned to me" view for the
 * whole run. Without the subscription they lose sight of their own ticket, which reads
 * exactly like the bot having dropped it.
 *
 * It cannot be inferred. The daemon authenticates as the BOT, so `viewer()` returns the bot
 * (07-CONTEXT P8) — asking is the only way to know, which is why this is a wizard step and
 * not a lookup.
 *
 * Skippable on purpose. An operator running an unattended box may not want to be subscribed
 * to every ticket, and a setup that cannot be completed without answering is worse than a
 * feature that stays off.
 */
import type { WizardPrompts } from './deps.js';

/** The two fields this step reads. Structural, so a test needs no SDK. */
export interface UserCandidate {
  id: string;
  name: string;
  email?: string;
  active?: boolean;
  /** Linear's own flag. A bot/integration user is not a person to subscribe. */
  isMe?: boolean;
}

interface UsersLinearClient {
  users(vars: { first: number; after?: string }): Promise<{
    nodes: UserCandidate[];
    pageInfo: { hasNextPage: boolean; endCursor?: string | null };
  }>;
}

const PAGE_SIZE = 50;
/** The sentinel for "do not subscribe me". */
export const NO_OPERATOR = '__no_operator__';

/**
 * TRAPS T22: never `fetchNext()` — it mutates and returns `this`, appending into the same
 * `nodes` array, so the intuitive loop double-counts every page. Explicit cursors, as
 * `mapping.ts` does for teams and projects.
 */
async function pageAllUsers(client: UsersLinearClient): Promise<UserCandidate[]> {
  const out: UserCandidate[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await client.users({ first: PAGE_SIZE, after });
    out.push(...page.nodes);
    if (!page.pageInfo.hasNextPage || !page.pageInfo.endCursor) return out;
    after = page.pageInfo.endCursor;
  }
}

export interface OperatorStepDeps {
  prompts: WizardPrompts;
  /** The bot's own user id, so it is never offered as the operator. */
  botUserId?: string;
  /** The value already in `config.json`, kept when the operator declines to change it. */
  existing?: string;
}

/**
 * Returns the chosen user id, or `undefined` for "do not subscribe".
 *
 * Never throws. A workspace whose key cannot list users still completes setup — the
 * subscription is a convenience, and failing the whole wizard over it would trade a missing
 * nicety for an unusable product.
 */
export async function chooseOperator(
  linearClient: unknown,
  deps: OperatorStepDeps,
): Promise<string | undefined> {
  let users: UserCandidate[];
  try {
    users = await pageAllUsers(linearClient as UsersLinearClient);
  } catch {
    return deps.existing;
  }

  const candidates = users.filter((u) => u.active !== false && u.id !== deps.botUserId);
  if (candidates.length === 0) return deps.existing;

  const label = (u: UserCandidate): string => (u.email ? `${u.name} <${u.email}>` : u.name);
  const known = deps.existing ? candidates.find((u) => u.id === deps.existing) : undefined;

  const choice = await deps.prompts.select<string>({
    message:
      'Which Linear user are you? The bot subscribes you to each ticket it picks up, so ' +
      'assignment to the bot does not take it out of your "Assigned to me" view.',
    choices: [
      // The current value first when there is one, so a re-run's default is one Return.
      ...(known ? [{ name: `${label(known)} (current)`, value: known.id }] : []),
      ...candidates.filter((u) => u.id !== known?.id).map((u) => ({ name: label(u), value: u.id })),
      { name: "Don't subscribe me", value: NO_OPERATOR },
    ],
  });

  return choice === NO_OPERATOR ? undefined : choice;
}
