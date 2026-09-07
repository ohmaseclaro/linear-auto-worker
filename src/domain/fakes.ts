/**
 * One in-memory fake per port in `ports.ts`, with no exceptions. This is the file that
 * makes horizontal parallelism work: Phases 2-6 build and unit-test against these fakes
 * alone, with no sibling layer, no filesystem, no network, no child process and no timer.
 *
 * Naming is fixed by `research/ARCHITECTURE.md` and `01-03-PLAN.md`'s naming contract —
 * `FakeTunnel`, not `FakeTunnelManager`. Every class takes an optional constructor argument
 * and no required ones, so a test can write `new FakeThing()` and get a working fixture.
 */

import type {
  Config,
  IssueId,
  MappingToggles,
  PendingQuestion,
  ProjectMapping,
  RepoMapping,
  Run,
  RunEventRow,
  RunId,
  RunState,
  SessionId,
} from './types.js';
import { holdsSlot, isTerminal } from './state-machine.js';
import type {
  AgentRunner,
  AgentSpawnRequest,
  ConfigLoader,
  Deliverer,
  DomainEvent,
  EngineEvent,
  IngressEvent,
  EventRouter,
  LinearClient,
  WorkflowStateType,
  LinearComment,
  LinearIssue,
  Logger,
  Notifier,
  PullRequest,
  Receiver,
  RunEngine,
  RunEvent,
  Scheduler,
  Store,
  TunnelManager,
  WebhookDelivery,
  WebhookRegistrar,
  Worktree,
  WorktreeManager,
} from './ports.js';
import type { AgentResult } from './agent-result.js';
import { LinearApiError } from './errors.js';

// ── L0 ───────────────────────────────────────────────────────────────────────

/**
 * `Store` fake. Maps keyed by id, plus separate insertion-order arrays so the queue and
 * question sweeps read back in arrival order the way a real `SELECT ... ORDER BY` would.
 */
export class InMemoryStore implements Store {
  private runs: Map<RunId, Run>;
  private runOrder: RunId[];
  private events: RunEventRow[];
  private questions: Map<string, PendingQuestion>;
  private questionOrder: string[];
  private deliveries: Map<string, number>;
  private kv: Map<string, string>;

  constructor(seed?: { runs?: Run[]; questions?: PendingQuestion[] }) {
    this.runs = new Map((seed?.runs ?? []).map((r) => [r.id, r]));
    this.runOrder = (seed?.runs ?? []).map((r) => r.id);
    this.events = [];
    this.questions = new Map((seed?.questions ?? []).map((q) => [q.id, q]));
    this.questionOrder = (seed?.questions ?? []).map((q) => q.id);
    this.deliveries = new Map();
    this.kv = new Map();
  }

  private allRuns(): Run[] {
    return this.runOrder.map((id) => this.runs.get(id)!);
  }

  private allQuestions(): PendingQuestion[] {
    return this.questionOrder.map((id) => this.questions.get(id)!);
  }

  // runs
  insertRun(r: Run): void {
    this.runs.set(r.id, r);
    this.runOrder.push(r.id);
  }
  getRun(id: RunId): Run | undefined {
    return this.runs.get(id);
  }
  updateRun(id: RunId, patch: Partial<Run>): void {
    const cur = this.runs.get(id);
    if (!cur) return;
    this.runs.set(id, { ...cur, ...patch } as Run);
  }
  /** Non-terminal runs, filtered via `isTerminal` so a tenth state cannot escape it. */
  findActiveRunByIssue(issueId: IssueId): Run[] {
    return this.allRuns().filter((r) => {
      if (r.issueId !== issueId) return false;
      if (r.kind === 'ticket') return true; // derived status, never itself terminal
      return !isTerminal(r.state);
    });
  }
  /** Every run for the issue, terminal included: the history question (T107). */
  findRunsByIssue(issueId: IssueId): Run[] {
    return this.allRuns().filter((r) => r.issueId === issueId);
  }
  listByState(...s: RunState[]): Run[] {
    return this.allRuns().filter((r) => r.kind === 'repo' && s.includes(r.state));
  }
  /** ORDER BY createdAt ASC, capped at `limit`. */
  nextQueued(limit: number): Run[] {
    return this.allRuns()
      .filter((r) => r.kind === 'repo' && r.state === 'queued')
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, limit);
  }
  childRuns(parentId: RunId): Run[] {
    return this.allRuns().filter((r) => r.parentRunId === parentId);
  }

  // run events (D-03)
  appendRunEvent(e: RunEventRow): void {
    this.events.push(e);
  }
  listRunEvents(runId: RunId): RunEventRow[] {
    return this.events.filter((e) => e.runId === runId);
  }

  // questions
  insertQuestion(q: PendingQuestion): void {
    this.questions.set(q.id, q);
    this.questionOrder.push(q.id);
  }
  getQuestion(id: string): PendingQuestion | undefined {
    return this.questions.get(id);
  }
  openQuestionsForIssue(issueId: IssueId): PendingQuestion[] {
    return this.allQuestions().filter((q) => q.status === 'open' && this.getRun(q.runId)?.issueId === issueId);
  }
  findQuestionByCommentId(parentCommentId: string): PendingQuestion | undefined {
    return this.allQuestions().find((q) => q.linearCommentId === parentCommentId);
  }
  findQuestionByShortCode(code: string): PendingQuestion | undefined {
    return this.allQuestions().find((q) => q.id.slice(0, 8) === code);
  }
  updateQuestion(id: string, patch: Partial<PendingQuestion>): void {
    const cur = this.questions.get(id);
    if (!cur) return;
    this.questions.set(id, { ...cur, ...patch });
  }
  /** Deadlines are absolute; the fake takes no clock of its own so a test drives `now`. */
  expiredQuestions(now: number): PendingQuestion[] {
    return this.allQuestions().filter((q) => q.status === 'open' && q.deadlineAt <= now);
  }

  // deliveries — insert-if-absent, atomically (no read-then-write gap), returns true iff new.
  //
  // ONE name (T46), matching `sqlite-store.ts`. There used to be a `tryInsertDelivery`
  // alias here; it made this fake MORE permissive than the real store, which is how a
  // `receiver.ts` call to a method the real store does not have stayed green through six
  // phases. A fake that accepts what production rejects hides the bug it exists to catch.
  recordDelivery(deliveryId: string, receivedAt: number): boolean {
    if (this.deliveries.has(deliveryId)) return false;
    this.deliveries.set(deliveryId, receivedAt);
    return true;
  }
  pruneDeliveries(olderThan: number): void {
    for (const [id, at] of this.deliveries) {
      if (at < olderThan) this.deliveries.delete(id);
    }
  }

  // kv
  kvGet(k: string): string | undefined {
    return this.kv.get(k);
  }
  kvSet(k: string, v: string): void {
    this.kv.set(k, v);
  }

  /** Snapshot-and-restore. Cheap enough at unit-test data volumes; no cleverer scheme needed. */
  transaction<T>(fn: () => T): T {
    const snapshot = {
      runs: new Map(this.runs),
      runOrder: [...this.runOrder],
      events: [...this.events],
      questions: new Map(this.questions),
      questionOrder: [...this.questionOrder],
      deliveries: new Map(this.deliveries),
      kv: new Map(this.kv),
    };
    try {
      return fn();
    } catch (err) {
      this.runs = snapshot.runs;
      this.runOrder = snapshot.runOrder;
      this.events = snapshot.events;
      this.questions = snapshot.questions;
      this.questionOrder = snapshot.questionOrder;
      this.deliveries = snapshot.deliveries;
      this.kv = snapshot.kv;
      throw err;
    }
  }

  close(): void {
    // no-op — nothing here ever opened a handle
  }
}

const DEFAULT_TOGGLES: MappingToggles = {
  postLinearComments: true,
  notifySlack: true,
  baseBranch: 'main',
  draftPr: true,
  questionsEnabled: true,
  maxRunMs: 30 * 60_000,
  questionTimeoutMs: 60 * 60_000,
};

const DEFAULT_MAPPINGS: Record<string, ProjectMapping> = {
  'fake-project-id': {
    linearProjectId: 'fake-project-id',
    linearTeamId: null,
    repos: [
      { repoDir: '/repos/api', repoSlug: 'org/api', baseBranch: 'main', enabled: true },
      { repoDir: '/repos/web', repoSlug: 'org/web', baseBranch: 'main', enabled: true },
    ],
    slackWebhookUrl: 'https://hooks.slack.com/services/fake',
  },
  // D-07's fallback path: keyed by team, no project, carrying a sparse D-09 override.
  'fake-team-id': {
    linearProjectId: null,
    linearTeamId: 'fake-team-id',
    repos: [{ repoDir: '/repos/infra', repoSlug: 'org/infra', baseBranch: 'main', enabled: true }],
    overrides: { draftPr: false },
  },
};

const DEFAULT_CONFIG: Config = {
  botUserId: 'fake-bot-user',
  teamId: 'fake-team-id',
  concurrency: 3,
  maxQuestionRounds: 3,
  maxTurns: 40,
  worktreeRoot: '/fake/worktrees',
  dbPath: '/fake/store.db',
  defaults: DEFAULT_TOGGLES,
  mappings: DEFAULT_MAPPINGS,
};

/**
 * `ConfigLoader` fake. The built-in default is not a stub: it exercises CONF-01/CONF-02's
 * full shape (a project-keyed mapping with two repos and a slack url, a team-keyed fallback
 * mapping, and a sparse one-toggle override), because five layers use this default as their
 * fixture and a fixture without a sparse override never exercises `resolveToggles`.
 */
export class FakeConfigLoader implements ConfigLoader {
  private readonly config: Config;

  constructor(partial?: Partial<Config>) {
    this.config = { ...DEFAULT_CONFIG, ...partial };
  }

  load(): Promise<Config> {
    return Promise.resolve(this.config);
  }
  path(): string {
    return '/fake/config.json';
  }
}

interface RecordedLine {
  level: 'info' | 'warn' | 'error' | 'debug';
  bindings: Record<string, unknown>;
  objOrMsg: unknown;
  msg?: string;
}

/**
 * `Logger` fake. Retains every call on a public array so a test can assert that no line
 * anywhere carries an API key or an authtoken (Phase 2's success criterion) — a logger that
 * discards its input cannot be used to prove that negative.
 */
export class RecordingLogger implements Logger {
  readonly lines: RecordedLine[];
  private readonly bindings: Record<string, unknown>;

  constructor(bindings: Record<string, unknown> = {}, lines: RecordedLine[] = []) {
    this.bindings = bindings;
    this.lines = lines;
  }

  child(bindings: Record<string, unknown>): Logger {
    return new RecordingLogger({ ...this.bindings, ...bindings }, this.lines);
  }

  private record(level: RecordedLine['level'], objOrMsg: unknown, msg?: string): void {
    this.lines.push({ level, bindings: this.bindings, objOrMsg, msg });
  }

  info(objOrMsg: unknown, msg?: string): void {
    this.record('info', objOrMsg, msg);
  }
  warn(objOrMsg: unknown, msg?: string): void {
    this.record('warn', objOrMsg, msg);
  }
  error(objOrMsg: unknown, msg?: string): void {
    this.record('error', objOrMsg, msg);
  }
  debug(objOrMsg: unknown, msg?: string): void {
    this.record('debug', objOrMsg, msg);
  }
}

// ── L1 INGRESS ───────────────────────────────────────────────────────────────

/**
 * `TunnelManager` fake. `openCount` gives Phase 3's "restarting the worker ten times
 * leaves exactly one tunnel" test something to assert against.
 */
export class FakeTunnel implements TunnelManager {
  openCount = 0;
  private currentUrl: string | null;

  constructor() {
    this.currentUrl = null;
  }

  open(port: number): Promise<string> {
    this.openCount += 1;
    this.currentUrl = `https://fake-${port}.ngrok-free.app`;
    return Promise.resolve(this.currentUrl);
  }
  url(): string | null {
    return this.currentUrl;
  }
  close(): Promise<void> {
    this.currentUrl = null;
    return Promise.resolve();
  }
}

/**
 * `WebhookRegistrar` fake. `reconcile` is idempotent create-or-update — repeated calls
 * return the SAME id, because a fake that minted a new one per call would make Phase 3's
 * idempotency test pass for the wrong reason.
 */
export class FakeWebhookRegistrar implements WebhookRegistrar {
  reconcileCount = 0;
  disabled = false;
  lastUrl: string | null;
  private readonly webhookId: string;
  private readonly secret: string;

  constructor(seed?: { webhookId?: string; secret?: string }) {
    this.lastUrl = null;
    this.webhookId = seed?.webhookId ?? 'fake-webhook-id';
    this.secret = seed?.secret ?? 'fake-webhook-secret';
  }

  reconcile(publicUrl: string): Promise<{ webhookId: string; secret: string }> {
    this.reconcileCount += 1;
    this.lastUrl = publicUrl;
    return Promise.resolve({ webhookId: this.webhookId, secret: this.secret });
  }
  disable(): Promise<void> {
    this.disabled = true;
    return Promise.resolve();
  }
}

/**
 * `Receiver` fake. `deliver()` is a test-only escape hatch that pushes a `WebhookDelivery`
 * straight through the stored callback, so a test never stands up a real HTTP server.
 */
export class FakeReceiver implements Receiver {
  secret: string | null;
  private onDelivery: ((d: WebhookDelivery) => void) | null;

  constructor() {
    this.secret = null;
    this.onDelivery = null;
  }

  listen(onDelivery: (d: WebhookDelivery) => void): Promise<number> {
    this.onDelivery = onDelivery;
    return Promise.resolve(0);
  }
  setSecret(secret: string): void {
    this.secret = secret;
  }
  close(): Promise<void> {
    this.onDelivery = null;
    return Promise.resolve();
  }
  /** Test helper: push a delivery through the seam with no HTTP server involved. */
  deliver(d: WebhookDelivery): void {
    this.onDelivery?.(d);
  }
}

/**
 * `EventRouter` fake. Scripted: returns queued `IngressEvent` values in order, then `null`
 * once drained — the same "this delivery produced nothing" the real router reports for a
 * dropped event. Records every delivery it was handed.
 */
export class FakeEventRouter implements EventRouter {
  readonly delivered: WebhookDelivery[];
  private readonly queue: IngressEvent[];

  constructor(scripted: IngressEvent[] = []) {
    this.delivered = [];
    this.queue = [...scripted];
  }

  route(d: WebhookDelivery): Promise<IngressEvent | null> {
    this.delivered.push(d);
    return Promise.resolve(this.queue.shift() ?? null);
  }
}

// ── L2 ORCHESTRATION ─────────────────────────────────────────────────────────

/**
 * `Scheduler` fake. A GENUINE counting semaphore, not a permissive stub — the property
 * Phase 6 must test is that three parked questions leave all three slots free, and a
 * scheduler that always says yes would let a slot-leak defect ship undetected.
 */
export class FakeScheduler implements Scheduler {
  private readonly cap: number;
  private inUseCount: number;
  private running: boolean;
  private readonly waitQueue: Array<{ runId: RunId; grant: () => void }>;

  constructor(capacity = 3) {
    this.cap = capacity;
    this.inUseCount = 0;
    this.running = false;
    this.waitQueue = [];
  }

  start(): void {
    this.running = true;
  }
  pause(): void {
    this.running = false;
  }

  acquire(runId: RunId): Promise<() => void> {
    return new Promise((resolve) => {
      const grant = () => {
        this.inUseCount += 1;
        let released = false;
        resolve(() => {
          if (released) return; // idempotent: a doubled release must not hand out a phantom slot
          released = true;
          this.inUseCount -= 1;
          const next = this.waitQueue.shift();
          next?.grant();
        });
      };
      if (this.inUseCount < this.cap) {
        grant();
      } else {
        this.waitQueue.push({ runId, grant });
      }
    });
  }

  inUse(): number {
    return this.inUseCount;
  }
  capacity(): number {
    return this.cap;
  }
  /** 1-based place in the wait queue; 0 once admitted. */
  positionOf(runId: RunId): number {
    const idx = this.waitQueue.findIndex((w) => w.runId === runId);
    return idx < 0 ? 0 : idx + 1;
  }
  /** Boot recovery: recompute the admitted count from what the runs table says holds a slot. */
  syncFromStore(runs: readonly Run[]): void {
    this.inUseCount = runs.filter((r) => r.kind === 'repo' && holdsSlot(r.state)).length;
  }
}

/**
 * `RunEngine` fake. Records every event handed to `handle`, every `tick`, and whether
 * `recover`/`drain` were called, so Phase 3 can test its router without the real engine.
 */
export class FakeRunEngine implements RunEngine {
  readonly handled: EngineEvent[];
  readonly ticks: number[];
  recovered: boolean;
  drainedGraceMs: number | null;

  constructor() {
    this.handled = [];
    this.ticks = [];
    this.recovered = false;
    this.drainedGraceMs = null;
  }

  handle(e: EngineEvent): Promise<void> {
    this.handled.push(e);
    return Promise.resolve();
  }
  recover(): Promise<void> {
    this.recovered = true;
    return Promise.resolve();
  }
  tick(now: number): Promise<void> {
    this.ticks.push(now);
    return Promise.resolve();
  }
  drain(graceMs: number): Promise<void> {
    this.drainedGraceMs = graceMs;
    return Promise.resolve();
  }
}

// ── L3 EXECUTION ─────────────────────────────────────────────────────────────

/**
 * `WorktreeManager` fake. Synthesises a path string under a fixed root — no filesystem
 * touched, ever.
 */
export class FakeWorktreeManager implements WorktreeManager {
  private readonly worktrees: Map<RunId, Worktree>;
  private readonly root: string;

  constructor(root = '/fake/worktrees') {
    this.worktrees = new Map();
    this.root = root;
  }

  create(runId: RunId, repo: RepoMapping, branch: string): Promise<Worktree> {
    const wt: Worktree = {
      runId,
      repoDir: repo.repoDir,
      path: `${this.root}/${runId}`,
      branch,
      baseBranch: repo.baseBranch,
    };
    this.worktrees.set(runId, wt);
    return Promise.resolve(wt);
  }
  remove(runId: RunId): Promise<void> {
    this.worktrees.delete(runId);
    return Promise.resolve();
  }
  exists(runId: RunId): Promise<boolean> {
    return Promise.resolve(this.worktrees.has(runId));
  }
  /** Boot GC: drop worktrees with no non-terminal run, returning the paths dropped. */
  gc(liveRunIds: Set<RunId>): Promise<string[]> {
    const removed: string[] = [];
    for (const [runId, wt] of this.worktrees) {
      if (!liveRunIds.has(runId)) {
        removed.push(wt.path);
        this.worktrees.delete(runId);
      }
    }
    return Promise.resolve(removed);
  }
}

/**
 * `AgentRunner` fake — the highest-bug-density path in the project made testable with no
 * Claude process and no network. Scripted with an array of `AgentResult`s returned in
 * order, repeating the last once exhausted; scripting `needs_input` then `complete` drives
 * a run from running through the parked state and back.
 *
 * Honours the `AbortSignal` as an OUTCOME, not an error: aborted-before-call or
 * aborted-while-pending both resolve to `{ status: 'cancelled' }`, never a throw. The
 * pending window is a `queueMicrotask` tick, not a timer — long enough for a synchronous
 * `controller.abort()` right after `run()` to race the listener, never long enough to touch
 * a real clock.
 */
export class FakeAgentRunner implements AgentRunner {
  /** Every spawn this fake was asked for, in order. */
  readonly calls: AgentSpawnRequest[];
  private readonly script: AgentResult[];
  private cursor: number;
  private progressCb: ((runId: RunId, line: string) => void) | null;

  constructor(
    script: AgentResult[] = [{ status: 'complete', summary: 'fake run', prTitle: 'fake', prBody: 'fake' }],
  ) {
    this.calls = [];
    this.script = script;
    this.cursor = 0;
    this.progressCb = null;
  }

  run(req: AgentSpawnRequest, signal: AbortSignal): Promise<AgentResult> {
    this.calls.push(req);
    const idx = Math.min(this.cursor, this.script.length - 1);
    const result = this.script[idx]!;
    this.cursor += 1;

    if (signal.aborted) {
      return Promise.resolve({ status: 'cancelled' });
    }
    return new Promise((resolve) => {
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        resolve({ status: 'cancelled' });
      };
      signal.addEventListener('abort', onAbort, { once: true });
      queueMicrotask(() => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      });
    });
  }

  onProgress(cb: (runId: RunId, line: string) => void): void {
    this.progressCb = cb;
  }
  /** Test helper: emit a progress line as if the child process wrote one. */
  emitProgress(runId: RunId, line: string): void {
    this.progressCb?.(runId, line);
  }
}

/**
 * `Deliverer` fake. A repeated call for the SAME worktree returns the same `PullRequest`
 * rather than minting a second one — the interface documents delivery as idempotent, and a
 * fake that double-delivered would hide the bug it exists to surface.
 */
export class FakeDeliverer implements Deliverer {
  readonly calls: Array<{ wt: Worktree; repo: RepoMapping; pr: { title: string; body: string } }>;
  private readonly byWorktreePath: Map<string, PullRequest>;
  private counter: number;

  constructor() {
    this.calls = [];
    this.byWorktreePath = new Map();
    this.counter = 0;
  }

  deliver(wt: Worktree, repo: RepoMapping, pr: { title: string; body: string }): Promise<PullRequest> {
    this.calls.push({ wt, repo, pr });
    const existing = this.byWorktreePath.get(wt.path);
    if (existing) return Promise.resolve(existing);
    this.counter += 1;
    const created: PullRequest = {
      url: `https://github.com/${repo.repoSlug}/pull/${this.counter}`,
      number: this.counter,
    };
    this.byWorktreePath.set(wt.path, created);
    return Promise.resolve(created);
  }
}

// ── L4 OUTBOUND ──────────────────────────────────────────────────────────────

/**
 * `LinearClient` fake. An in-memory issue map seeded through the constructor.
 * `createComment` returns and retains a DISTINCT id per call — question correlation depends
 * on the stored comment id and never on recency.
 */
export class FakeLinearClient implements LinearClient {
  readonly comments: Array<{
    issueId: IssueId;
    body: string;
    parentId?: string;
    id: string;
    createdAt: string;
  }>;
  readonly stateChanges: Array<{ id: IssueId; stateType: WorkflowStateType }>;
  /** Every `(teamId, stateType)` this fake was asked to resolve, in order. */
  readonly stateLookups: Array<{ teamId: string; stateType: WorkflowStateType }>;
  readonly subscribers: Array<{ issueId: IssueId; userId: string }>;
  private readonly issues: Map<IssueId, LinearIssue>;
  private readonly webhooks: Array<{
    id: string;
    label: string | null;
    url: string;
    enabled: boolean;
    resourceTypes: string[];
  }>;
  private readonly bot: { id: string; name: string };
  private commentCounter: number;
  private webhookCounter: number;

  constructor(seed?: { issues?: LinearIssue[]; botUser?: { id: string; name: string } }) {
    this.comments = [];
    this.stateChanges = [];
    this.stateLookups = [];
    this.subscribers = [];
    this.issues = new Map((seed?.issues ?? []).map((i) => [i.id, i]));
    this.webhooks = [];
    this.bot = seed?.botUser ?? { id: 'fake-bot-user', name: 'Fake Bot' };
    this.commentCounter = 0;
    this.webhookCounter = 0;
  }

  /**
   * Seed or REPLACE one issue, the way a human editing the ticket in Linear would.
   *
   * Needed because assignment is an event in time: a fixture seeded already-assigned is
   * picked up by the boot sweep, so a test about the WEBHOOK path cannot tell the run its
   * delivery produced from the run the sweep produced.
   */
  putIssue(issue: LinearIssue): void {
    this.issues.set(issue.id, issue);
  }

  viewer(): Promise<{ id: string; name: string }> {
    return Promise.resolve(this.bot);
  }
  getIssue(id: IssueId): Promise<LinearIssue> {
    const issue = this.issues.get(id);
    if (!issue) return Promise.reject(new LinearApiError(`fake: no such issue ${id}`));
    return Promise.resolve(issue);
  }
  listAssignedOpenIssues(botUserId: string): Promise<LinearIssue[]> {
    return Promise.resolve([...this.issues.values()].filter((i) => i.assigneeId === botUserId));
  }
  /**
   * Deterministic, and non-empty for every team — a fake that could return '' would make
   * the composition root's boot assertion untestable in the direction that matters.
   */
  resolveWorkflowStateId(teamId: string, stateType: WorkflowStateType): Promise<string> {
    this.stateLookups.push({ teamId, stateType });
    return Promise.resolve(`fake-state-${teamId}-${stateType}`);
  }
  setIssueState(id: IssueId, stateType: WorkflowStateType): Promise<void> {
    this.stateChanges.push({ id, stateType });
    return Promise.resolve();
  }
  createComment(issueId: IssueId, body: string, parentId?: string): Promise<{ id: string }> {
    this.commentCounter += 1;
    const id = `fake-comment-${this.commentCounter}`;
    this.comments.push({ issueId, body, parentId, id, createdAt: new Date().toISOString() });
    return Promise.resolve({ id });
  }
  updateComment(commentId: string, body: string): Promise<void> {
    const c = this.comments.find((x) => x.id === commentId);
    if (!c) return Promise.reject(new LinearApiError(`fake: no such comment ${commentId}`));
    c.body = body;
    return Promise.resolve();
  }
  addSubscriber(issueId: IssueId, userId: string): Promise<void> {
    this.subscribers.push({ issueId, userId });
    return Promise.resolve();
  }
  listComments(issueId: IssueId, since?: string): Promise<LinearComment[]> {
    return Promise.resolve(
      this.comments
        .filter((c) => c.issueId === issueId && (since === undefined || c.createdAt > since))
        .map((c) => ({
          id: c.id,
          parentId: c.parentId ?? null,
          body: c.body,
          authorId: this.bot.id,
          authorName: this.bot.name,
          createdAt: c.createdAt,
        })),
    );
  }
  listWebhooks(): Promise<
    Array<{ id: string; label: string | null; url: string; enabled: boolean; resourceTypes: string[] }>
  > {
    return Promise.resolve([...this.webhooks]);
  }
  /** The secret is the CALLER's and is not read back (landmine #3) — hence `{ id }` only. */
  createWebhook(i: {
    label: string;
    url: string;
    teamId: string;
    secret: string;
    resourceTypes: string[];
  }): Promise<{ id: string }> {
    this.webhookCounter += 1;
    const id = `fake-webhook-${this.webhookCounter}`;
    this.webhooks.push({ id, label: i.label, url: i.url, enabled: true, resourceTypes: i.resourceTypes });
    return Promise.resolve({ id });
  }
  updateWebhook(id: string, i: { url?: string; enabled?: boolean; resourceTypes?: string[] }): Promise<void> {
    const wh = this.webhooks.find((w) => w.id === id);
    if (wh) Object.assign(wh, i);
    return Promise.resolve();
  }
  deleteWebhook(id: string): Promise<void> {
    const idx = this.webhooks.findIndex((w) => w.id === id);
    if (idx >= 0) this.webhooks.splice(idx, 1);
    return Promise.resolve();
  }
}

/**
 * `Notifier` fake. Never throws, under any circumstance — the real notifier's contract is
 * that a channel failing never fails the run, and a fake that CAN throw teaches the
 * opposite lesson to every layer built against it.
 */
export class RecordingNotifier implements Notifier {
  readonly events: RunEvent[];

  constructor() {
    this.events = [];
  }

  emit(e: RunEvent): Promise<void> {
    this.events.push(e);
    return Promise.resolve();
  }
}
