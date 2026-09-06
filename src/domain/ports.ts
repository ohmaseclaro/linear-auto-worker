/**
 * Every cross-layer boundary in the project, in one file. No layer declares its own copy
 * of any of these; a layer that needs a method this file does not have records the exact
 * signature it wants in its SUMMARY under `Contract additions requested` rather than
 * inventing one.
 *
 * The config and run types live in `types.ts`, but they are re-exported here as well, so
 * that a sibling importing `Config` or `Run` or `AgentResult` from either path compiles.
 * The redundancy is deliberate: seven branches are writing these imports against a file
 * they cannot see.
 */

import type {
  Config,
  IssueId,
  PendingQuestion,
  RepoMapping,
  Run,
  RunEventRow,
  RunId,
  RunState,
  SessionId,
} from './types.js';
import type { AgentResult } from './agent-result.js';

// Re-exports — kept as short lines so every shared name is reachable from this module too.
export type { Config, ConfigPaths, MappingToggles, RepoMapping, ProjectMapping } from './types.js';
export type { Run, RepoRun, TicketRun, RunId, RunState, RunEventRow } from './types.js';
export type { PendingQuestion, IssueId, SessionId } from './types.js';
export type { AgentResult } from './agent-result.js';
export { AgentResultSchema, parseAgentResult } from './agent-result.js';
export {
  BOT_COMMENT_MARKER_PREFIX,
  QUESTION_MARKER_PREFIX,
  isBotAuthoredBody,
  resolveToggles,
} from './types.js';

// ── L0 ───────────────────────────────────────────────────────────────────────

export interface ConfigLoader {
  /** Throws `ConfigError` carrying the zod path. */
  load(): Promise<Config>;
  path(): string;
}

/**
 * The only door to SQLite. Named methods only, no raw-SQL escape hatch: that keeps every
 * statement inside the Phase 2 implementation and stops a second writer to the run state
 * growing in another layer (T-01-07).
 */
export interface Store {
  // runs
  insertRun(r: Run): void;
  getRun(id: RunId): Run | undefined;
  updateRun(id: RunId, patch: Partial<Run>): void;
  /** Non-terminal runs for an issue. */
  findActiveRunByIssue(issueId: IssueId): Run[];
  listByState(...s: RunState[]): Run[];
  /** ORDER BY createdAt. */
  nextQueued(limit: number): Run[];
  childRuns(parentId: RunId): Run[];

  // run events (D-03) — appended in the same transaction as the state write
  appendRunEvent(e: RunEventRow): void;
  listRunEvents(runId: RunId): RunEventRow[];

  // questions
  insertQuestion(q: PendingQuestion): void;
  getQuestion(id: string): PendingQuestion | undefined;
  openQuestionsForIssue(issueId: IssueId): PendingQuestion[];
  findQuestionByCommentId(parentCommentId: string): PendingQuestion | undefined;
  findQuestionByShortCode(code: string): PendingQuestion | undefined;
  updateQuestion(id: string, patch: Partial<PendingQuestion>): void;
  expiredQuestions(now: number): PendingQuestion[];

  // deliveries — the webhook dedupe table
  /**
   * Insert-if-absent, atomically, returning true iff the row was new. The atomicity is the
   * whole point: a check-then-insert would let two concurrent deliveries of the same id
   * both pass.
   */
  recordDelivery(deliveryId: string, receivedAt: number): boolean;
  pruneDeliveries(olderThan: number): void;

  // kv
  kvGet(k: string): string | undefined;
  /** `kvSet`, not `kvPut` — this is the pair `src/infra/store/sqlite-store.ts` implements. */
  kvSet(k: string, v: string): void;

  transaction<T>(fn: () => T): T;
  close(): void;
}

export interface Logger {
  child(bindings: Record<string, unknown>): Logger;
  info(objOrMsg: unknown, msg?: string): void;
  warn(objOrMsg: unknown, msg?: string): void;
  error(objOrMsg: unknown, msg?: string): void;
  debug(objOrMsg: unknown, msg?: string): void;
}

// ── L1 INGRESS ───────────────────────────────────────────────────────────────

export interface TunnelManager {
  /** Resolves to the public https URL. Throws `TunnelError` if it is absent (T19). */
  open(port: number): Promise<string>;
  url(): string | null;
  close(): Promise<void>;
}

export interface WebhookRegistrar {
  /** Idempotent create-or-update by label. Returns the signing secret. */
  reconcile(publicUrl: string): Promise<{ webhookId: string; secret: string }>;
  /** Best-effort, on shutdown. */
  disable(): Promise<void>;
}

export interface WebhookDelivery {
  deliveryId: string; // Linear-Delivery
  eventType: string; // Linear-Event: "Issue" | "Comment"
  action: 'create' | 'update' | 'remove';
  timestamp: number; // Linear-Timestamp, unix MILLISECONDS (T20)
  /** Parsed, but treated as a HINT only — the router re-fetches the canonical issue. */
  body: unknown;
}

export interface Receiver {
  /** Binds 127.0.0.1:0. Resolves with the chosen ephemeral port. */
  listen(onDelivery: (d: WebhookDelivery) => void): Promise<number>;
  /** Callable after `reconcile()`. */
  setSecret(secret: string): void;
  close(): Promise<void>;
}

/**
 * Ingress's normalised output.
 *
 * **Two producers, two vocabularies, and a mapping step between them — do not tidy either
 * set away.** The first three members are what Phase 3's router and poller emit: webhook
 * facts, named after what Linear did. The last four are what Phase 6's run engine switches
 * on: intentions, named after what the daemon should do. They share no `kind`.
 *
 * That gap used to be free to ignore: both vocabularies were one flat union, so an
 * ingress event handed straight to the engine fell through its `default:` arm and the
 * daemon booted clean, verified clean and processed nothing (T45). The two halves are
 * therefore SPLIT — `EventRouter` produces an `IngressEvent`, `RunEngine.handle` consumes
 * an `EngineEvent`, and the two are not assignable. Skipping the translation is now a
 * compile error at the composition root instead of a silent no-op in production.
 *
 * The translation itself stays out of the contract, because deciding that a comment is an
 * answer requires the store and the contract has no dependencies. Its five cases:
 *
 * | ingress                        | engine                                       |
 * |--------------------------------|----------------------------------------------|
 * | `issue.assigned`               | `run.requested`                              |
 * | `issue.unassigned`             | `run.cancelled` (reason: bot unassigned)     |
 * | `comment.created` + open q.    | `question.answered` (parentId correlation)   |
 * | `comment.created`, no match    | `ignored`                                    |
 * | anything else                  | `ignored`                                    |
 */
export type IngressEvent =
  | { kind: 'issue.assigned'; issueId: IssueId; deliveryId?: string }
  | { kind: 'issue.unassigned'; issueId: IssueId; deliveryId?: string }
  | { kind: 'comment.created'; issueId: IssueId; commentId: string; parentId?: string; deliveryId?: string };

export type EngineEvent =
  | { kind: 'run.requested'; issueId: IssueId }
  | { kind: 'run.cancelled'; issueId: IssueId; reason: string }
  | { kind: 'question.answered'; questionId: string; answer: string; authorName: string | null }
  /**
   * Resume a run with an input that is NOT an answer to a stored question.
   * QA-07's disabled-question-flow branch has no question row by construction
   * (06-03), so it cannot key off `question.answered`, whose handler looks the
   * row up and requires status `open`.
   */
  | { kind: 'run.resumed'; runId: RunId; input: string; reason: 'question_flow_disabled' }
  | { kind: 'ignored'; reason: string };

export type DomainEvent = IngressEvent | EngineEvent;

export interface EventRouter {
  /**
   * Re-fetches canonical issue state; never decides from `delivery.body`.
   * `null` is "this delivery produced nothing" — a dropped self-event, a duplicate,
   * an action nobody subscribes to. That is what the real router does with a drop, and
   * it is deliberately not an `ignored` event: `ignored` is an ENGINE vocabulary word,
   * and ingress does not get to speak it.
   */
  route(d: WebhookDelivery): Promise<IngressEvent | null>;
}

// ── L2 ORCHESTRATION ─────────────────────────────────────────────────────────

export interface Scheduler {
  start(): void;
  pause(): void;
  /** Resolves when a slot is free; the returned fn releases it exactly once. */
  acquire(runId: RunId): Promise<() => void>;
  inUse(): number;
  capacity(): number;
  /** 1-based place in the wait queue; 0 once admitted. Side-effect free. */
  positionOf(runId: RunId): number;
  /** Recompute the admitted set from the runs table (boot recovery). */
  syncFromStore(runs: readonly Run[]): void;
}

export interface RunEngine {
  handle(e: EngineEvent): Promise<void>;
  /** Boot sweep: reconcile every non-terminal row against reality. */
  recover(): Promise<void>;
  /** 60s tick: expire questions past deadline and resume with the assumption. */
  tick(now: number): Promise<void>;
  drain(graceMs: number): Promise<void>;
}

// ── L3 EXECUTION ─────────────────────────────────────────────────────────────

export interface Worktree {
  runId: RunId;
  repoDir: string;
  path: string;
  branch: string;
  baseBranch: string;
}

export interface WorktreeManager {
  create(runId: RunId, repo: RepoMapping, branch: string): Promise<Worktree>;
  remove(runId: RunId): Promise<void>;
  exists(runId: RunId): Promise<boolean>;
  /** Boot GC: drop worktrees with no non-terminal run. */
  gc(liveRunIds: Set<RunId>): Promise<string[]>;
}

export interface AgentSpawnRequest {
  runId: RunId;
  /** Pre-assigned, passed as `--session-id`, never parsed out of the stream (T4). */
  sessionId: SessionId;
  cwd: string; // worktree path
  prompt: string;
  resume: boolean; // true → --resume <sessionId>
  /**
   * Built by allowlist, not inherited (T28). Making it an explicit caller-constructed
   * record is what lets Phase 4 withhold the daemon's secrets by construction.
   */
  env: Record<string, string>;
}

export interface AgentRunner {
  run(req: AgentSpawnRequest, signal: AbortSignal): Promise<AgentResult>;
  onProgress(cb: (runId: RunId, line: string) => void): void;
}

export interface PullRequest {
  url: string;
  number: number;
}

export interface Deliverer {
  /** Push the branch, then `gh pr create`. Idempotent: an existing PR is returned. */
  deliver(
    wt: Worktree,
    repo: RepoMapping,
    pr: { title: string; body: string },
  ): Promise<PullRequest>;
}

// ── L4 OUTBOUND ──────────────────────────────────────────────────────────────

export interface LinearIssue {
  id: IssueId;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  branchName: string;
  assigneeId: string | null;
  projectId: string | null;
  /**
   * Required, not optional. Without it the team-level mapping fallback (D-07) cannot be
   * implemented, and that fallback is the only reason an issue filed straight onto a team
   * is not silently dropped.
   */
  teamId: string | null;
  stateId: string;
  stateType: string; // "started" | ...
  /**
   * ISO 8601 UTC, compared lexicographically against the poll watermark. Without
   * it the reconciliation poll either re-enqueues every assigned issue every five
   * minutes or needs a second query (06-04).
   */
  updatedAt: string;
}

/** A Linear comment, projected to what answer correlation reads. */
export interface LinearComment {
  id: string;
  /** Threaded replies carry the parent comment id. */
  parentId: string | null;
  body: string;
  authorId: string | null;
  authorName: string | null;
  /** ISO 8601 UTC, compared lexicographically against the poll watermark. */
  createdAt: string;
}

export interface LinearClient {
  /** Preflight. */
  viewer(): Promise<{ id: string; name: string }>;
  /** The re-fetch: the webhook is a hint, this is the truth. */
  getIssue(id: IssueId): Promise<LinearIssue>;
  /** Boot sweep. */
  listAssignedOpenIssues(botUserId: string): Promise<LinearIssue[]>;
  setIssueState(id: IssueId, stateType: 'started' | 'review'): Promise<void>;
  createComment(issueId: IssueId, body: string, parentId?: string): Promise<{ id: string }>;
  /**
   * D-10 / INTK-06: the queue-position comment is EDITED, never re-posted. A queue
   * that moves three times must leave one comment on the ticket, not four.
   */
  updateComment(commentId: string, body: string): Promise<void>;
  /**
   * INTK-03. Assignee-based pickup takes the ticket out of the operator's
   * "Assigned to me" view for the whole run.
   */
  addSubscriber(issueId: IssueId, userId: string): Promise<void>;
  /**
   * D-05's comment half, for the reconciliation poll. `since` is the watermark:
   * comments at or before it were covered by a previous clean pass.
   */
  listComments(issueId: IssueId, since?: string): Promise<LinearComment[]>;
  // webhook CRUD, used only by WebhookRegistrar. Never log one of these objects — the
  // fragment selects the signing secret (T23).
  listWebhooks(): Promise<
    Array<{ id: string; label: string | null; url: string; enabled: boolean; resourceTypes: string[] }>
  >;
  createWebhook(i: {
    label: string;
    url: string;
    teamId: string;
    resourceTypes: string[];
  }): Promise<{ id: string; secret: string }>;
  updateWebhook(
    id: string,
    i: { url?: string; enabled?: boolean; resourceTypes?: string[] },
  ): Promise<void>;
  deleteWebhook(id: string): Promise<void>;
}

/**
 * What the notifier fans out.
 *
 * The member names deliberately do NOT track the state literals: `run.done` and
 * `run.abandoned` keep their names even though the corresponding states are now
 * `delivered` and `cancelled`/`failed`. Phase 5 is writing switch cases against these
 * strings today, and a rename for cosmetic symmetry would break that branch.
 */
export type RunEvent =
  | { kind: 'run.queued'; run: Run }
  | { kind: 'run.started'; run: Run }
  | { kind: 'run.question'; run: Run; question: PendingQuestion }
  | { kind: 'run.answered'; run: Run; answer: string; viaTimeout: boolean }
  | { kind: 'run.done'; run: Run; prUrl: string }
  /** A run that shipped something short of the whole job — a draft PR plus a note. */
  | { kind: 'run.partial'; run: Run; prUrl: string; note: string }
  | { kind: 'run.failed'; run: Run; reason: string }
  | { kind: 'run.abandoned'; run: Run; reason: string };

export interface Notifier {
  /** Fans out to log (always) + Linear + Slack (per config). NEVER throws. */
  emit(e: RunEvent): Promise<void>;
}
