/**
 * The SQLite row shape ↔ domain shape seam, and the ONLY place the two vocabularies meet.
 *
 * `sqlite-store.ts` speaks `RunRow`/`QuestionRow`: every column loosely typed, every
 * timestamp `number | string`, every boolean an INTEGER, `state` a bare `string`. That is
 * correct for a module whose job is to move rows in and out of SQLite without opinions.
 * `domain/ports.ts` speaks `Run`/`PendingQuestion`: a discriminated union, real booleans,
 * numeric instants. Also correct, for everything above the database.
 *
 * They are not assignable, and the composition root needs the domain side. This file is
 * the conversion, in one place, rather than a cast at the boot seam — because the two
 * differences that a cast would have hidden are both real bugs:
 *
 *   1. `findActiveRunByIssue` returns MANY runs. A ticket fanned out over three repos has
 *      three active children and a cancel must reach all of them.
 *   2. better-sqlite3 REFUSES to bind a JavaScript boolean — `cancelRequested: true` is a
 *      `TypeError` at the driver, not a silently wrong write. `toRow` maps it to 0/1.
 *
 * The `as unknown as` casts below sit at a genuine trust boundary (07-CONTEXT P11): the
 * values come back from SQLite as `unknown`-shaped rows, and the schema's CHECK
 * constraints — not TypeScript — are what guarantee `kind` and `state` are in range.
 */
import type {
  IssueId,
  PendingQuestion,
  Run,
  RunEventRow,
  RunId,
  RunState,
  Store as DomainStore,
} from '../../domain/ports.js';
import type { QuestionRow, RunRow, Store as RowStore } from './sqlite-store.js';

/** SQLite has no boolean type; every writer stores 0/1 in an INTEGER column. */
const num = (v: number | string): number => (typeof v === 'number' ? v : Number(v));

function toRun(row: RunRow): Run {
  const base = {
    ...row,
    createdAt: num(row.createdAt),
    updatedAt: num(row.updatedAt),
  };
  return base as unknown as Run;
}

function toQuestion(row: QuestionRow): PendingQuestion {
  return {
    ...row,
    askedAt: num(row.askedAt),
    deadlineAt: row.deadlineAt === null ? 0 : num(row.deadlineAt),
    answeredBy: row.answeredBy ?? null,
  } as unknown as PendingQuestion;
}

/**
 * Domain object → column values. Booleans become 0/1 and nothing else changes: every other
 * domain field name is already the camelCase of its column (`001-init.ts`'s naming rule).
 */
function toRow<T extends object>(obj: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = typeof v === 'boolean' ? (v ? 1 : 0) : v;
  }
  return out;
}

/** Wrap the row-level SQLite store as the `Store` port every layer above it consumes. */
export function asDomainStore(raw: RowStore): DomainStore {
  return {
    insertRun: (r: Run) => raw.insertRun(toRow(r) as unknown as RunRow),
    getRun: (id: RunId) => {
      const row = raw.getRun(id);
      return row === undefined ? undefined : toRun(row);
    },
    updateRun: (id: RunId, patch: Partial<Run>) => raw.updateRun(id, toRow(patch) as Partial<RunRow>),
    findActiveRunByIssue: (issueId: IssueId) => raw.findActiveRunByIssue(issueId).map(toRun),
    listByState: (...s: RunState[]) => raw.listByState(...s).map(toRun),
    nextQueued: (limit: number) => raw.nextQueued(limit).map(toRun),
    childRuns: (parentId: RunId) => raw.childRuns(parentId).map(toRun),

    appendRunEvent: (e: RunEventRow) => raw.appendRunEvent(e),
    listRunEvents: (runId: RunId) =>
      raw.listRunEvents(runId).map((e) => ({
        runId: e.runId,
        from: e.from as RunState | null,
        to: e.to as RunState,
        at: num(e.at),
        detail: e.detail,
      })),

    insertQuestion: (q: PendingQuestion) => raw.insertQuestion(toRow(q) as unknown as QuestionRow),
    getQuestion: (id: string) => {
      const row = raw.getQuestion(id);
      return row === undefined ? undefined : toQuestion(row);
    },
    openQuestionsForIssue: (issueId: IssueId) => raw.openQuestionsForIssue(issueId).map(toQuestion),
    findQuestionByCommentId: (parentCommentId: string) => {
      const row = raw.findQuestionByCommentId(parentCommentId);
      return row === undefined ? undefined : toQuestion(row);
    },
    findQuestionByShortCode: (code: string) => {
      const row = raw.findQuestionByShortCode(code);
      return row === undefined ? undefined : toQuestion(row);
    },
    updateQuestion: (id: string, patch: Partial<PendingQuestion>) =>
      raw.updateQuestion(id, toRow(patch) as Partial<QuestionRow>),
    expiredQuestions: (now: number) => raw.expiredQuestions(now).map(toQuestion),

    recordDelivery: (deliveryId: string, receivedAt: number) =>
      raw.recordDelivery(deliveryId, receivedAt),
    pruneDeliveries: (olderThan: number) => raw.pruneDeliveries(olderThan),

    kvGet: (k: string) => raw.kvGet(k),
    kvSet: (k: string, v: string) => raw.kvSet(k, v),

    transaction: <T,>(fn: () => T) => raw.transaction(fn),
    close: () => raw.close(),
  };
}
