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
  EventRouter,
  LinearClient,
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
  tryInsertDelivery(deliveryId: string, receivedAt: number): boolean {
    if (this.deliveries.has(deliveryId)) return false;
    this.deliveries.set(deliveryId, receivedAt);
    return true;
  }
  /**
   * `recordDelivery` — TRAPS T46 settles on this name for the real store; `ports.ts` still
   * names the interface method `tryInsertDelivery`. Kept as an alias here rather than
   * renamed, since renaming the interface is Phase 1's own contract-reconciliation call,
   * not this file's. Flagged under `Contract additions requested`.
   */
  recordDelivery(deliveryId: string, receivedAt: number): boolean {
    return this.tryInsertDelivery(deliveryId, receivedAt);
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
