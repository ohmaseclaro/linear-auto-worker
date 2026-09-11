/**
 * The silence gate — a `LinearClient` decorator applied ONCE, in the composition root.
 *
 * ## Why here and not at the call sites
 *
 * Six code paths in the daemon write to Linear: three inside `run-engine.acknowledge`
 * (`createComment`, `setIssueState`, `addSubscriber`), the queue-position `updateComment`,
 * the terminal comment, the multi-repo rollup, and three more through `questions.post()` —
 * one of which fires precisely when `questionsEnabled` is FALSE and announces that the
 * question flow is off. Six guards is six chances to be wrong now, and a seventh call site
 * would arrive LOUD. Gating the client makes the guard structural: a comment that is never
 * sent cannot be forgotten about.
 *
 * ## It reads `config.defaults` only, and that is a real limitation
 *
 * These write methods are handed an ISSUE ID, not a repo slug, so resolving a per-mapping
 * override would cost a Linear round trip per comment. So these two toggles are
 * INSTANCE-level: silence is a property of the daemon, not of one of its mappings. That is
 * exactly right for the operator's two instances — one loud, one silent — but it means a
 * per-mapping `overrides.postLinearComments` would be inert, which is the very defect this
 * module exists to fix, in miniature.
 *
 * So it is REFUSED rather than ignored: `assertInstanceLevelToggles` below fails the boot
 * when a mapping's overrides DISAGREE with `defaults` on either toggle. An override that
 * agrees is inert and harmless and is left alone — which is what keeps this from breaking
 * the live config, whose wizard-written overrides may carry `postLinearComments: true`.
 *
 * `assertInstanceLevelToggles` also guards a THIRD field, `prAttribution`, for a different
 * reason than the round-trip cost above: it is resolved at `cli/adapters.ts:createDeliverer`,
 * which already has a `RepoMapping` in hand, so it is genuinely per-mapping RESOLVABLE at its
 * actual read site. It is pinned to instance-level anyway, by product decision — a silent
 * workspace must not have one repo's PRs speak while a sibling's stay quiet.
 *
 * ## Every suppression logs
 *
 * Silence that cannot be observed is indistinguishable from breakage — the same reasoning
 * that gives `guards.ts` its per-guard drop counters.
 */
import type {
  Config,
  IssueId,
  LinearClient,
  LinearComment,
  LinearIssue,
  Logger,
  WorkflowStateType,
} from '../domain/ports.js';

/** The two toggles this gate reads. Narrower than `MappingToggles` on purpose — a wider
 *  parameter is an invitation to read more than `config.defaults` can honestly answer. */
export interface SilenceToggles {
  postLinearComments: boolean;
  updateLinearIssue: boolean;
}

/**
 * The id a suppressed `createComment` hands back.
 *
 * Two callers consume it: `run-engine.ts:329` writes it to `kv` as the ack comment id, and
 * `questions.ts:322` stores it on the question row for answer correlation. Neither ever
 * dereferences it AGAINST Linear — the only method that would is `updateComment`, which is
 * suppressed by the same toggle. The prefix makes it recognisable in a log and impossible
 * to confuse with a real Linear comment id.
 */
const SUPPRESSED_ID_PREFIX = 'suppressed-comment-';

export function quietLinear(
  inner: LinearClient,
  toggles: SilenceToggles,
  log: Logger,
): LinearClient {
  let suppressed = 0;

  const drop = (method: string, issueId: string): void => {
    log.info({ method, issueId }, 'Linear write suppressed by an instance-level toggle');
  };

  // Every member delegated explicitly. NOT a spread of `inner`: the real client is a class
  // instance and a spread would drop every prototype method on the floor.
  return {
    // ── reads and the registration path: never gated ────────────────────────
    // The silent instance still has to FIND work — that is how a poll-only daemon works
    // at all — and a poll-only instance never reaches the webhook methods anyway.
    viewer: () => inner.viewer(),
    getIssue: (id: IssueId): Promise<LinearIssue> => inner.getIssue(id),
    listAssignedOpenIssues: (botUserId: string) => inner.listAssignedOpenIssues(botUserId),
    listComments: (issueId: IssueId, since?: string): Promise<LinearComment[]> =>
      inner.listComments(issueId, since),
    resolveWorkflowStateId: (teamId: string, stateType: WorkflowStateType) =>
      inner.resolveWorkflowStateId(teamId, stateType),
    listWebhooks: () => inner.listWebhooks(),
    createWebhook: (i) => inner.createWebhook(i),
    updateWebhook: (id, i) => inner.updateWebhook(id, i),
    deleteWebhook: (id) => inner.deleteWebhook(id),

    // ── the comment thread ──────────────────────────────────────────────────
    createComment(issueId: IssueId, body: string, parentId?: string): Promise<{ id: string }> {
      if (toggles.postLinearComments) return inner.createComment(issueId, body, parentId);
      drop('createComment', issueId);
      suppressed += 1;
      return Promise.resolve({ id: `${SUPPRESSED_ID_PREFIX}${suppressed}` });
    },
    updateComment(commentId: string, body: string): Promise<void> {
      if (toggles.postLinearComments) return inner.updateComment(commentId, body);
      // `issueId` is not in scope here; the comment id is what a reader can correlate.
      drop('updateComment', commentId);
      return Promise.resolve();
    },

    // ── the issue RECORD ────────────────────────────────────────────────────
    setIssueState(id: IssueId, stateType: WorkflowStateType): Promise<void> {
      if (toggles.updateLinearIssue) return inner.setIssueState(id, stateType);
      drop('setIssueState', id);
      return Promise.resolve();
    },
    addSubscriber(issueId: IssueId, userId: string): Promise<void> {
      if (toggles.updateLinearIssue) return inner.addSubscriber(issueId, userId);
      drop('addSubscriber', issueId);
      return Promise.resolve();
    },
  };
}

/**
 * Fail the boot when a mapping tries to override an instance-level toggle to a DIFFERENT
 * value than `defaults` holds.
 *
 * Called before the first Linear call, for the same reason `resolveStartedStates` is: a
 * misconfigured instance should fail at `law start` with the mapping named, not thirty
 * seconds into its first ticket — or, worse for this particular knob, never, by quietly
 * doing the opposite of what the file says.
 */
export function assertInstanceLevelToggles(config: Config): void {
  const fields = ['postLinearComments', 'updateLinearIssue', 'prAttribution'] as const;
  for (const [key, mapping] of Object.entries(config.mappings)) {
    for (const field of fields) {
      const override = mapping.overrides?.[field];
      if (override === undefined || override === config.defaults[field]) continue;
      throw new Error(
        `mapping ${mapping.displayName ?? key} overrides \`${field}\` to ${String(override)}, ` +
          `but defaults says ${String(config.defaults[field])}. \`${field}\` is ` +
          'instance-level: resolved once from `defaults` rather than per mapping. Move the ' +
          'value to `defaults`, or drop the override.',
      );
    }
  }
}
