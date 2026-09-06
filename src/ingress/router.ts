/**
 * The event router: turns one verified webhook delivery into at most one normalised
 * `DomainEvent`. This is the end of the ingress phase boundary — nothing here knows what
 * a run is.
 *
 * Two rules govern this file, and both are load-bearing well beyond it:
 *
 * 1. **Edge-detect, then re-fetch.** `updatedFrom` decides *whether to look*; the fresh
 *    fetch decides *what happened* (INTK-05). Deciding from `payload.data` would be wrong
 *    under out-of-order deliveries, duplicate deliveries, and fields absent from the
 *    payload — one rule collapses all three. It is also what makes the D-04 reconciliation
 *    poll able to reproduce exactly the decision a lost delivery would have produced,
 *    which in turn is what makes an ephemeral ngrok domain safe.
 * 2. **The edge is key MEMBERSHIP in `updatedFrom`, not "the assignee is the bot".** The
 *    latter re-fires on every later edit of that issue forever, including the bot's own
 *    writes (loop surface 3, PITFALLS).
 *
 * `enqueue()` runs outside the request path — plan 03-05 calls it from a deferred callback
 * after the 200 is already written — so it must never throw and never block the ACK.
 */
import type { DomainEvent, Logger } from '../domain/ports.js';

/**
 * The slice of `@linear/sdk`'s `LinearClient` this module calls, declared structurally so
 * a test can pass a four-line fake instead of constructing the real client.
 * `Issue.assignee` is a lazy fetch in the SDK, hence the `PromiseLike` arm.
 */
export interface RouterClient {
  issue(id: string): Promise<FetchedIssue>;
}

export interface FetchedIssue {
  id: string;
  assignee?: PromiseLike<{ id: string } | undefined> | { id: string } | undefined;
}

/**
 * A Linear webhook payload, treated as a HINT and never as a source of truth. Typed loose
 * on purpose: any field we would be tempted to branch on is one we must re-fetch instead.
 */
export interface WebhookPayload {
  action: string;
  type?: string;
  data?: Record<string, unknown>;
  updatedFrom?: Record<string, unknown> | null;
}

export interface RouterDeps {
  client: RouterClient;
  log: Logger;
  botUserId: string;
  onEvent: (e: DomainEvent) => void;
}

export interface Router {
  /** Deferred hand-off. Never throws: a failure here must not become a failed ACK. */
  enqueue(payload: WebhookPayload, deliveryId?: string): Promise<void>;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

export function createRouter(deps: RouterDeps): Router {
  const { client, log, botUserId, onEvent } = deps;

  async function routeIssue(payload: WebhookPayload, deliveryId?: string): Promise<void> {
    const data = payload.data ?? {};
    const issueId = str(data.id);
    if (!issueId) return;

    // Step 1 — decide WHETHER to look. Key membership is the edge.
    const edge =
      payload.action === 'update'
        ? payload.updatedFrom != null && 'assigneeId' in payload.updatedFrom
        : // A create carries no prior-value object at all, so membership cannot be the
          // test there; a bot pre-assigned at creation is the edge instead.
          payload.action === 'create' && data.assigneeId != null;
    if (!edge) return;

    // Step 2 — decide WHAT happened, from the fetch and only from the fetch (INTK-05).
    const fresh = await client.issue(issueId);
    const assignee = await fresh.assignee;

    if (assignee?.id === botUserId) {
      onEvent({ kind: 'issue.assigned', issueId, deliveryId });
      return;
    }
    // The edge fired and the fresh assignee is not the bot ⇒ it was taken away. On a
    // `create` there was never an assignment to lose, so the payload simply lied and we
    // emit nothing.
    if (payload.action === 'update') {
      onEvent({ kind: 'issue.unassigned', issueId, deliveryId });
    }
  }

  function routeComment(payload: WebhookPayload, deliveryId?: string): void {
    if (payload.action !== 'create') return;
    const data = payload.data ?? {};
    const commentId = str(data.id);
    const issueId = str(data.issueId);
    if (!commentId || !issueId) return;

    // Identifiers, not decisions — no branch is taken on comment content here, so INTK-05
    // is satisfied without a second fetch; the consumer re-fetches the body when it needs
    // it. `parentId` is what Phase 6 needs for D-05 threaded-answer correlation.
    onEvent({
      kind: 'comment.created',
      issueId,
      commentId,
      parentId: str(data.parentId),
      deliveryId,
    });
  }

  return {
    async enqueue(payload: WebhookPayload, deliveryId?: string): Promise<void> {
      try {
        if (payload.type === 'Comment') {
          routeComment(payload, deliveryId);
          return;
        }
        if (payload.type === 'Issue') {
          await routeIssue(payload, deliveryId);
        }
      } catch (err) {
        // The delivery id is the only correlation key across the two halves of ingress
        // (assumption A1). Log the message, never the raw error object (T23/T24).
        log.error(
          { deliveryId, err: err instanceof Error ? err.message : String(err) },
          'router: dropped delivery',
        );
      }
    },
  };
}
