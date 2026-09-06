/**
 * The single typed facade over `@linear/sdk`. Every outbound Linear call in the daemon
 * goes through this module, and every method here goes through `call()` — that is what
 * makes rate-limit handling and per-response complexity logging impossible to forget.
 *
 * Two rules this file exists to enforce:
 *  - Rate limiting is detected ONLY by the GraphQL error's `extensions.code === 'RATELIMITED'`
 *    (05-CONTEXT D-07 / TRAPS T7). No branch anywhere in this file inspects a transport
 *    status code — such a branch would be dead code.
 *  - The raw SDK error and response objects are NEVER logged (threat T-05-02): they can
 *    carry the Authorization header and the full GraphQL query text.
 */

import {
  LinearClient as SdkLinearClient,
  type Issue,
  type Webhook as SdkWebhook,
} from '@linear/sdk';

import {
  RateLimitedError,
  computeBackoffMs,
  extractRateLimitInfo,
  isRateLimitedError,
} from './rate-limit.js';

/**
 * Linear's own connection default. It is also the complexity multiplier for a connection,
 * so raising it makes every paged query proportionally more expensive.
 */
const PAGE_SIZE = 50;

/**
 * Wait to report when a RATELIMITED error arrives with no reset header. Linear's buckets
 * are hourly, so we cannot know the real instant; 60s is a conservative floor that the
 * caller may extend. This facade never retries on its own (threat T-05-01) — it reports
 * the wait and lets the scheduler decide.
 */
const DEFAULT_BACKOFF_MS = 60_000;

/** Minimal structured-log sink. Phase 2 owns the real pino logger; default is a no-op. */
export type LogFn = (fields: Record<string, unknown>, msg: string) => void;

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  branchName: string;
  assigneeId: string | null;
  projectId: string | null;
  teamId: string;
  stateId: string;
  stateType: string;
}

/**
 * The workflow-state *types* this daemon transitions issues into. Linear fixes these
 * strings; only the human-facing `name` is renameable, which is why nothing here ever
 * matches on a name (05-CONTEXT D-06 / INTK-04).
 */
export type WorkflowStateType = 'started' | 'completed' | 'canceled';

export interface LinearClient {
  /** Preflight: who does this API key authenticate as? */
  viewer(): Promise<{ id: string; name: string }>;
  getIssue(issueId: string): Promise<LinearIssue>;
  /** Boot sweep: everything still open and assigned to the bot. */
  listAssignedOpenIssues(botUserId: string): Promise<LinearIssue[]>;
  setIssueState(issueId: string, teamId: string, stateType: WorkflowStateType): Promise<void>;
  createComment(issueId: string, body: string, parentId?: string): Promise<{ id: string }>;

  // Webhook CRUD, consumed only by Phase 3's registrar.
  listWebhooks(): Promise<LinearWebhookSummary[]>;
  createWebhook(input: CreateWebhookInput): Promise<{ id: string }>;
  updateWebhook(id: string, input: UpdateWebhookInput): Promise<void>;
  deleteWebhook(id: string): Promise<void>;
}

/**
 * A webhook, projected down to the fields the registrar reconciles against.
 *
 * TRAPS T23: the SDK's `Webhook` object carries its signing `secret`, so a single
 * `log.info({ webhooks })` would write every signing secret to disk. Nothing outside this
 * module ever holds a raw Webhook — this shape is what listWebhooks hands back.
 */
export interface LinearWebhookSummary {
  id: string;
  label: string | null;
  url: string;
  enabled: boolean;
  resourceTypes: string[];
}

export interface CreateWebhookInput {
  label: string;
  url: string;
  teamId: string;
  /** Caller-supplied. This facade never generates a secret and never reads one back. */
  secret: string;
  resourceTypes: string[];
}

export interface UpdateWebhookInput {
  url?: string;
  enabled?: boolean;
  resourceTypes?: string[];
}

export interface LinearClientOptions {
  apiKey: string;
  log?: LogFn;
  /** Test seam: inject a stubbed SDK client. ponytail: cheaper than a DI container. */
  sdk?: SdkLinearClient;
}

/** The fields of a WorkflowState this facade actually reads. */
interface TeamWorkflowState {
  id: string;
  type: string;
  position: number;
}

/** Structural shape of any `@linear/sdk` connection we page over. */
interface Page<N> {
  nodes: N[];
  pageInfo: { hasNextPage: boolean; endCursor?: string | null };
}

/**
 * Page a connection to completion by re-querying with the previous page's `endCursor`.
 *
 * TRAPS T22: we deliberately do NOT use `connection.fetchNext()`. It mutates and returns
 * `this`, appending into the same `page.nodes` array — so the intuitive
 * `while (hasNextPage) { out.push(...page.nodes); page = await page.fetchNext() }` loop
 * double-counts every page. Explicit `after` cursors have no such hazard.
 */
async function pageAll<N>(fetchPage: (after?: string) => Promise<Page<N>>): Promise<N[]> {
  const out: N[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await fetchPage(after);
    out.push(...page.nodes);
    if (!page.pageInfo.hasNextPage) return out;
    const next = page.pageInfo.endCursor ?? undefined;
    // A truthy hasNextPage with no usable cursor would otherwise spin forever.
    if (next === undefined || next === after) return out;
    after = next;
  }
}

async function toLinearIssue(issue: Issue): Promise<LinearIssue> {
  const [assignee, project, team, state] = await Promise.all([
    issue.assignee,
    issue.project,
    issue.team,
    issue.state,
  ]);
  if (!team) throw new Error(`Linear issue ${issue.identifier} has no team`);
  if (!state) throw new Error(`Linear issue ${issue.identifier} has no workflow state`);
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description ?? null,
    url: issue.url,
    // Linear supplies the suggested branch name; slugifying the title ourselves would
    // break Linear's own branch/PR auto-linking.
    branchName: issue.branchName,
    assigneeId: assignee?.id ?? null,
    projectId: project?.id ?? null,
    teamId: team.id,
    stateId: state.id,
    stateType: state.type,
  };
}

export class LinearClientImpl implements LinearClient {
  private readonly sdk: SdkLinearClient;
  private readonly log: LogFn;
  /** teamId -> that team's workflow states. Populated on first use, never re-queried. */
  private readonly statesByTeam = new Map<string, TeamWorkflowState[]>();

  constructor(opts: LinearClientOptions) {
    // 05-CONTEXT D-08 / TRAPS T9: the personal API key header carries NO `Bearer` prefix.
    // Constructing the SDK with `{ apiKey }` sets the correct header for us. Never
    // hand-roll a fetch or an Authorization header here — that is how the Bearer bug
    // gets reintroduced (threat T-05-03).
    this.sdk = opts.sdk ?? new SdkLinearClient({ apiKey: opts.apiKey });
    this.log = opts.log ?? (() => {});
  }

  /**
   * The one wrapper every public method routes through. Named `op` only so the structured
   * log line says which call hit the limit — with no dashboard, the log is the UI.
   */
  private async call<T>(op: string, fn: () => Promise<T>): Promise<T> {
    try {
      const result = await fn();
      // D-07 asks for X-Complexity per response. `@linear/sdk@93.0.1` exposes no confirmed
      // hook onto the raw HTTP response from a resolved value, so this is a best-effort
      // probe: if the value happens to carry headers we log them, otherwise it is a silent
      // no-op. ponytail: not guessing at SDK internals we cannot inspect on this branch.
      const info = extractRateLimitInfo(result);
      if (info.resetAtMs !== undefined || info.complexity !== undefined) {
        this.log({ op, ...info }, 'linear.response.budget');
      }
      return result;
    } catch (err) {
      if (!isRateLimitedError(err)) throw err;
      const info = extractRateLimitInfo(err);
      const waitMs =
        info.resetAtMs !== undefined
          ? computeBackoffMs(info.resetAtMs, Date.now())
          : DEFAULT_BACKOFF_MS;
      // Threat T-05-02: log ONLY these allow-listed scalars. `err` itself can carry the
      // Authorization header and the full query text.
      this.log({ op, waitMs, complexity: info.complexity }, 'linear.ratelimited');
      throw new RateLimitedError(waitMs);
    }
  }

  async viewer(): Promise<{ id: string; name: string }> {
    return this.call('viewer', async () => {
      const me = await this.sdk.viewer;
      return { id: me.id, name: me.name };
    });
  }

  async getIssue(issueId: string): Promise<LinearIssue> {
    // The relation fetches inside toLinearIssue are themselves Linear calls, so they run
    // inside call() rather than after it.
    return this.call('getIssue', async () => toLinearIssue(await this.sdk.issue(issueId)));
  }

  async listAssignedOpenIssues(botUserId: string): Promise<LinearIssue[]> {
    return this.call('listAssignedOpenIssues', async () => {
      const issues = await pageAll<Issue>((after) =>
        this.sdk.issues({
          first: PAGE_SIZE,
          after,
          filter: {
            assignee: { id: { eq: botUserId } },
            state: { type: { nin: ['completed', 'canceled'] } },
          },
        }),
      );
      return Promise.all(issues.map(toLinearIssue));
    });
  }

  async setIssueState(
    issueId: string,
    teamId: string,
    stateType: WorkflowStateType,
  ): Promise<void> {
    await this.call('setIssueState', async () => {
      const states = await this.resolveTeamStates(teamId);
      // 05-CONTEXT D-06 / INTK-04: matched on `type`, NEVER on `name` — operators rename
      // "In Progress" to "Doing"/"Active" freely — and never a hardcoded UUID, since state
      // ids are per-team and one would break the moment a ticket arrives from a second
      // team. Where a team has several states of one type (the stock Linear workspace has
      // both "In Progress" and "In Review" typed `started`) the lowest `position` wins:
      // the one earliest in the workflow.
      const [state] = states
        .filter((s) => s.type === stateType)
        .sort((a, b) => a.position - b.position);
      if (!state) {
        throw new Error(
          `Linear team ${teamId} has no workflow state of type "${stateType}"; ` +
            `cannot move issue ${issueId}`,
        );
      }
      await this.sdk.updateIssue(issueId, { stateId: state.id });
    });
  }

  /** A team's workflow states, fetched once per team and memoized for the process lifetime. */
  private async resolveTeamStates(teamId: string): Promise<TeamWorkflowState[]> {
    const cached = this.statesByTeam.get(teamId);
    if (cached) return cached;

    const team = await this.sdk.team(teamId);
    const states = await pageAll<TeamWorkflowState>((after) =>
      team.states({ first: PAGE_SIZE, after }),
    );
    this.statesByTeam.set(teamId, states);
    return states;
  }

  async createComment(
    issueId: string,
    body: string,
    parentId?: string,
  ): Promise<{ id: string }> {
    return this.call('createComment', async () => {
      // parentId goes straight through to CommentCreateInput — without it every bot
      // comment is top-level and reply matching degrades to guesswork.
      const payload = await this.sdk.createComment({ issueId, body, parentId });
      const comment = await payload.comment;
      if (!comment) throw new Error(`Linear returned no comment for issue ${issueId}`);
      return { id: comment.id };
    });
  }

  /**
   * Every webhook in the workspace. Paged to completion — the connection defaults to 50,
   * and a registrar that sees only the first page reconciles against a partial view and
   * happily registers a duplicate of a webhook it could not see.
   */
  async listWebhooks(): Promise<LinearWebhookSummary[]> {
    return this.call('listWebhooks', async () => {
      const webhooks = await pageAll<SdkWebhook>((after) =>
        this.sdk.webhooks({ first: PAGE_SIZE, after }),
      );
      // T23: project away `secret` here, at the only place raw Webhook objects exist.
      return webhooks.map((w) => ({
        id: w.id,
        label: w.label ?? null,
        url: w.url ?? '',
        enabled: w.enabled,
        resourceTypes: w.resourceTypes ?? [],
      }));
    });
  }

  async createWebhook(input: CreateWebhookInput): Promise<{ id: string }> {
    return this.call('createWebhook', async () => {
      // TRAPS T21: the SDK method is `createWebhook`. `webhookCreate` is the GraphQL
      // mutation name and does not exist on the client.
      const payload = await this.sdk.createWebhook(input);
      const webhook = await payload.webhook;
      if (!webhook) throw new Error(`Linear returned no webhook for "${input.label}"`);
      // Id only. The secret came from the caller and goes no further than the request.
      return { id: webhook.id };
    });
  }

  async updateWebhook(id: string, input: UpdateWebhookInput): Promise<void> {
    await this.call('updateWebhook', () => this.sdk.updateWebhook(id, input));
  }

  async deleteWebhook(id: string): Promise<void> {
    await this.call('deleteWebhook', () => this.sdk.deleteWebhook(id));
  }
}
