/**
 * The reconciliation poll — the QUERY half only.
 *
 * D-12 settles a three-way ownership conflict: **Phase 3 owns the query, Phase 6 owns the
 * timer.** There is deliberately no scheduling primitive in this file. Wiring it to a
 * clock is Phase 6's job, and an unwired poll is not a cosmetic gap: D-08 drops
 * null-actor events as untrusted, and that drop is only *safe* because this poll
 * re-discovers the real work within one interval.
 *
 * It works at all only because the router never decides from `payload.data` — it
 * re-fetches and decides from fresh state, so this query reconstructs exactly the decision
 * a lost delivery would have produced (D-04). That is what turns a missed webhook into a
 * latency problem instead of a correctness one.
 *
 * Known limitation, recorded in 03-CONTEXT D-05: an issue-level diff cannot see a threaded
 * answer to an open question, because a comment is not an issue field. Hence the second
 * pass over `openQuestionIssueIds`. Correlating those answers back to a parked run is
 * Phase 6's.
 */
import type { DomainEvent, Store } from '../domain/ports.js';

/** Key in the `kv` table holding the last-seen watermark. */
export const POLL_WATERMARK_KEY = 'poll_watermark';

const EPOCH = new Date(0).toISOString();

/** A Linear SDK connection, narrowed to what pagination needs. */
export interface Connection<T> {
  nodes: T[];
  pageInfo: { hasNextPage: boolean };
  fetchNext(): Promise<Connection<T>>;
}

export interface PolledIssue {
  id: string;
  updatedAt: Date | string;
}

export interface PolledComment {
  id: string;
  createdAt: Date | string;
  /** Lazy on the SDK's Comment; what Phase 6 needs to thread an answer (D-05). */
  parent?: PromiseLike<{ id: string } | undefined> | { id: string } | undefined;
}

/** The slice of `@linear/sdk`'s `LinearClient` this module calls. */
export interface PollClient {
  issues(vars: { filter: Record<string, unknown> }): Promise<Connection<PolledIssue>>;
  comments(vars: { filter: Record<string, unknown> }): Promise<Connection<PolledComment>>;
}

export interface PollDeps {
  client: PollClient;
  store: Pick<Store, 'kvGet'>;
  botUserId: string;
  /** Issues holding an open question, from the caller's own store (D-05). */
  openQuestionIssueIds: string[];
  /** Injectable clock, for the watermark clamp below. */
  now?: () => Date;
}

const iso = (v: Date | string): string => new Date(v).toISOString();

/**
 * T22: `fetchNext()` appends into the SAME connection and returns `this`. Collecting
 * `nodes` across iterations therefore double-counts every earlier page — two pages of
 * three would read as nine. Exhaust first, read `nodes` exactly once.
 */
async function exhaust<T>(page: Connection<T>): Promise<T[]> {
  while (page.pageInfo.hasNextPage) await page.fetchNext();
  return page.nodes;
}

export async function pollForMissedWork(
  deps: PollDeps,
): Promise<{ events: DomainEvent[]; watermark: string }> {
  const { client, store, botUserId, openQuestionIssueIds } = deps;
  const startedAt = iso((deps.now ?? (() => new Date()))());
  const since = store.kvGet(POLL_WATERMARK_KEY) ?? EPOCH;

  const events: DomainEvent[] = [];
  let newest = since;
  const observe = (at: Date | string): void => {
    const s = iso(at);
    if (s > newest) newest = s;
  };

  // Pass 1 — bot-assigned issues touched since the watermark. No dedupe here: an issue the
  // caller already knows about is still emitted, because deduplication belongs to the
  // consumer's run records (T-03-17 accepts at-least-once deliberately).
  const issues = await client.issues({
    filter: { assignee: { id: { eq: botUserId } }, updatedAt: { gt: new Date(since) } },
  });
  for (const issue of await exhaust(issues)) {
    events.push({ kind: 'issue.assigned', issueId: issue.id });
    observe(issue.updatedAt);
  }

  // Pass 2 — D-05. Without this, a run sits in `awaiting_answer` until its deadline while
  // the operator's reply is already sitting in Linear.
  for (const issueId of openQuestionIssueIds) {
    const comments = await client.comments({
      filter: { issue: { id: { eq: issueId } }, createdAt: { gt: new Date(since) } },
    });
    for (const c of await exhaust(comments)) {
      // ponytail: one lazy `parent` fetch per new comment on a parked issue — a handful
      // per interval. Batch into the query selection if that ever shows up in the budget.
      const parent = await c.parent;
      events.push({
        kind: 'comment.created',
        issueId,
        commentId: c.id,
        parentId: parent?.id,
      });
      observe(c.createdAt);
    }
  }

  // The caller advances the watermark only AFTER the events are consumed — advancing it
  // here would silently discard work if the process died in between. Clamped to the query
  // start so an issue updated mid-poll is not skipped by a later comment's timestamp; the
  // cost is re-emitting that comment once, which the consumer already dedupes.
  return { events, watermark: newest > startedAt ? startedAt : newest };
}
