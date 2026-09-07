/**
 * Shared vocabulary. Every layer in this project imports from `src/domain/`, and
 * `src/domain/` imports nothing outside itself — the one exception is `node:os`, for the
 * operator's home directory, which the resolved config-root constants below need.
 */

import { homedir } from 'node:os';

export type RunId = string; // uuid v4
export type IssueId = string; // Linear uuid
export type SessionId = string; // uuid v4, pre-assigned to `claude --session-id`

/**
 * The nine run states (D-01). These exact strings appear in the SQL schema, in every log
 * line, in Linear comment bodies, and in all five parallel layers — renaming one is a
 * database migration plus a simultaneous edit to every layer.
 *
 * `partial` is a real state, not a rounding of `failed`: success is judged by evidence in
 * the worktree rather than by exit code, and a partial run still ships a draft PR. The
 * "barren" outcome — the agent produced no evidence at all — folds into `failed`.
 */
export type RunState =
  | 'queued'
  | 'preparing'
  | 'running'
  | 'awaiting_answer'
  | 'delivering'
  | 'delivered'
  | 'partial'
  | 'failed'
  | 'cancelled';

/**
 * Terminal states. Nothing leaves them, with exactly one documented exception:
 * `failed` accepts an explicit operator `requeue`.
 */
export const TERMINAL: ReadonlyArray<RunState> = ['delivered', 'partial', 'failed', 'cancelled'];

/**
 * States that occupy one of the daemon's concurrency slots (D-02).
 *
 * The parked state is deliberately absent, and that absence is load-bearing for the whole
 * scheduler: a run waiting on a human answer takes minutes to hours, so if it held a slot
 * three open questions would deadlock a three-slot laptop. Because it holds nothing, an
 * hours-long human wait costs the daemon nothing.
 */
export const HOLDS_SLOT: ReadonlyArray<RunState> = ['preparing', 'running', 'delivering'];

/**
 * States with a live `claude` child process (D-02).
 *
 * Only one qualifies. The Q&A design is exit-and-resume: the agent ends its turn to ask,
 * so the child process is already gone by the time the run parks. A parked run has no live
 * process any more than it has a slot.
 */
export const HAS_CHILD: ReadonlyArray<RunState> = ['running'];

// ── Runs ─────────────────────────────────────────────────────────────────────
//
// Every timestamp below is epoch MILLISECONDS, typed `number`. The matching SQLite columns
// must be declared INTEGER, not TEXT: a TEXT column compares lexicographically, which
// happens to order ms timestamps correctly only while they all share a digit width. The
// question deadline sweep is a range query over one of these, so that accident is holding
// up a real feature.

/** Fields common to both kinds of run. Not exported: consumers take `Run`. */
interface RunBase {
  id: RunId;
  /** null for a ticket-level parent and for a single-repo run. */
  parentRunId: RunId | null;
  issueId: IssueId;
  issueKey: string; // "ENG-42"
  issueTitle: string;
  issueUrl: string;
  /**
   * VESTIGIAL. Always 0: `fanout.ts` writes it once at insert and nothing ever increments
   * it or reads it. It is the counter of the bounded `failed -> queued` auto-retry that
   * OPS-04 / TRAPS T17 explicitly forbid building, so bounding anything by it would BE
   * that retry, arriving through whichever door needed a limit. Left in place rather than
   * deleted because removing it touches the migration, `RunRow`, `fanout.ts` twice and
   * five test fixtures for no behaviour change. Do not use it (T108).
   */
  attempt: number;
  questionRound: number;
  createdAt: number;
  updatedAt: number;
}

/** One repository's worth of work: the only kind that owns a child process and a slot. */
export interface RepoRun extends RunBase {
  kind: 'repo';
  state: RunState;
  repoDir: string;
  repoSlug: string; // "org/api", the form `gh pr create` wants
  branch: string; // from issue.branchName
  worktreePath: string | null;
  sessionId: SessionId | null; // pre-assigned before the first spawn
  pid: number | null;
  prUrl: string | null;
  failureReason: string | null;
  /**
   * D-05's deferred cancel. `running` and `delivering` do not transition on a cancel
   * request — a pushed branch cannot be un-pushed, so an instant transition would lie
   * about what happened. The supervisor honours this flag at its next checkpoint.
   * Optional so that an INSERT written before this field existed still type-checks;
   * absent reads as "no cancel requested", which is the safe default.
   */
  cancelRequested?: boolean;
  /**
   * Gap D6. What the agent's session cost and how many tokens it moved, recorded when the
   * run finishes so the terminal notification can report them.
   *
   * Optional for the same reason `cancelRequested` is: rows inserted before the column
   * existed (migration 002) read as absent, and `0` is the correct rendering of a run
   * whose cost was never recorded — which is what the daemon reported for every run until
   * these existed.
   */
  costUsd?: number;
  tokensUsed?: number;
}

/**
 * The parent of a multi-repo ticket. It has no columns that could disagree with its
 * children: no state, no repo, no worktree, no session, no pid.
 */
export interface TicketRun extends RunBase {
  kind: 'ticket';
  /** Always null — see the note on `Run`. */
  state: null;
  repoDir: null;
  repoSlug: null;
  branch: null;
  worktreePath: null;
  sessionId: null;
  pid: null;
}

/**
 * A run.
 *
 * A ticket-kind run's status is obtained by calling `deriveParentState` on its children
 * and is NEVER read from a column — there is no column to read (D-04). Deriving rather
 * than storing is what makes it impossible for parent and child to disagree, and that
 * disagreement is the exact bug that would let one repo's failure discard another repo's
 * already-shipped pull request (DELV-07).
 */
export type Run = RepoRun | TicketRun;

/**
 * One row of `run_events` (D-03). Every transition writes `runs.state` and appends one of
 * these in the same transaction, so a transition that was not recorded is a missing row
 * rather than a missing log line nobody greps for. `from` is null for the genesis row.
 */
export interface RunEventRow {
  runId: RunId;
  from: RunState | null;
  to: RunState;
  at: number;
  detail: string | null;
}

// ── Questions ────────────────────────────────────────────────────────────────

export interface PendingQuestion {
  /** uuid; the first 8 characters are the short code carried in the comment marker. */
  id: string;
  runId: RunId;
  text: string;
  /** The agent's own `assumption`, stated before it knew if anyone would answer. */
  assumption: string;
  linearCommentId: string | null; // set after the comment is posted
  askedAt: number;
  deadlineAt: number;
  status: 'open' | 'answered' | 'timed_out' | 'cancelled';
  answer: string | null;
  /**
   * Display name of the human whose comment was correlated to this question, or
   * `null` for a deadline expiry. It is the only record of WHO changed a run's
   * course mid-flight, so it is a column rather than a log line (`answered_by`).
   */
  answeredBy: string | null;
}

// ── Configuration (CONF-01, CONF-02) ─────────────────────────────────────────
//
// This is the definition the Phase 8 wizard writes and four layers read. Nothing here
// loads or validates anything — Phase 2 owns the loader and its zod schema, because
// `src/domain/` imports no third-party package, zod included.

/**
 * The six CONF-02 toggles — Linear comments, Slack notification, base branch, draft
 * versus ready pull requests, the question flow, and maximum run time — plus the question
 * deadline, which the orchestration layer reads per mapping.
 *
 * Named once, here, and nowhere else. `Config.defaults` holds a full set; a mapping's
 * `overrides` holds a sparse subset (D-09), so adding a seventh toggle later does not
 * require rewriting every existing mapping.
 *
 * `concurrency` is deliberately NOT one of these. It is a global cap bounding local RAM
 * across all runs and lives at `Config` top level; putting it here would imply a
 * per-mapping override that must not exist.
 */
export interface MappingToggles {
  postLinearComments: boolean;
  notifySlack: boolean;
  baseBranch: string;
  draftPr: boolean;
  questionsEnabled: boolean;
  maxRunMs: number;
  /** How long a question waits before the run resumes with the agent's own assumption. */
  questionTimeoutMs: number;
}

export interface RepoMapping {
  repoDir: string; // absolute
  repoSlug: string; // "org/name", the form `gh` wants
  /** Required on the row; the loader fills it from `Config.defaults.baseBranch`. */
  baseBranch: string;
  enabled: boolean;
}

/**
 * One entry of the project-to-repo map (CONF-01).
 *
 * Keying is by Linear project, with a team-level fallback (D-07): the lookup tries
 * `mappings[issue.projectId]` first and `mappings[issue.teamId]` second. The fallback
 * exists because an issue filed directly on a team with no project would otherwise match
 * nothing and be silently dropped — a failure that looks identical to the bot ignoring
 * you. Both ids are carried on the row as well as being the record key, so a mapping can
 * say which of the two forms it was keyed by without the reader guessing.
 */
export interface ProjectMapping {
  linearProjectId: string | null;
  linearTeamId: string | null;
  /**
   * The team a PROJECT-keyed mapping belongs to.
   *
   * Separate from `linearTeamId`, which is the mapping's KEY and is mutually exclusive with
   * `linearProjectId` — overloading it would break that invariant and make a project-keyed
   * mapping indistinguishable from a team-keyed one. The wizard already fetches this while
   * listing candidates and used to discard it, which left the daemon unable to say which
   * team a project mapping belonged to. Harmless while the registrar registers with
   * `allPublicTeams: true`; needed the moment webhook scoping narrows to one team.
   *
   * Optional so an existing `config.json` written before this field still validates.
   */
  ownerTeamId?: string;
  /**
   * The Linear project or team NAME, for showing the operator on a setup re-run.
   *
   * The wizard knows it at pick time and threw it away, so re-running `law setup` listed
   * each existing mapping by its raw id — an operator choosing which mapping to edit was
   * reading UUIDs. Stored rather than re-fetched because the review prompt must work
   * offline and before the Linear key is re-validated.
   *
   * Display only. Nothing keys, matches or routes on it, so a stale name after a rename in
   * Linear is cosmetic and is corrected on the next re-run.
   */
  displayName?: string;
  repos: RepoMapping[];
  slackWebhookUrl?: string;
  /** Sparse by construction (D-09): a mapping names only what it changes. */
  overrides?: Partial<MappingToggles>;
}

/**
 * The whole of `config.json`.
 *
 * Neither PROMPTED secret appears here, and neither may be added (D-08): `LINEAR_API_KEY`
 * and `NGROK_AUTHTOKEN` live in a mode-0600 `.env` beside `config.json`.
 *
 * This file is NOT credential-free, and it used to say it was. A mapping's
 * `slackWebhookUrl` is a bearer secret — posting to that channel needs nothing else — so
 * `config.json` is written mode 0600 and is not a file an operator can safely paste when
 * asking for help. Strip the Slack URLs first.
 */
export interface Config {
  botUserId: string;
  teamId: string;
  /** Global cap on simultaneous spawned Claude sessions. Default 3. Never per-mapping. */
  concurrency: number;
  maxQuestionRounds: number;
  /**
   * The single operator's Linear user id, subscribed to every picked-up ticket
   * (INTK-03) so assignee-based pickup does not take the ticket out of their
   * "Assigned to me" view.
   *
   * Optional, and the reason is worth reading before making it required: the
   * daemon authenticates as the BOT, so `viewer()` — the wizard's only source of
   * a user id — returns the bot, not the operator. Nothing writes this field
   * today. The subscribe call is skipped and WARNED when it is absent rather
   * than sent `undefined`; a wizard prompt is what closes it (07-CONTEXT P8).
   */
  operatorUserId?: string;
  maxTurns: number;
  maxBudgetUsd?: number;
  worktreeRoot: string;
  dbPath: string;
  defaults: MappingToggles;
  /** Keyed by Linear project id first, then Linear team id (D-07). */
  mappings: Record<string, ProjectMapping>;
}

/**
 * The one resolver. Four layers read these toggles; spreading the sparse overrides over
 * the defaults in exactly one place is what makes "exactly one definition" true rather
 * than aspirational.
 */
export function resolveToggles(
  defaults: MappingToggles,
  mapping?: Pick<ProjectMapping, 'overrides'>,
): MappingToggles {
  return { ...defaults, ...(mapping?.overrides ?? {}) };
}

// ── Config root (D-06) ───────────────────────────────────────────────────────

/** Everything the daemon owns lives under `~/.linear-auto-worker/`. */
export const CONFIG_DIR_NAME = '.linear-auto-worker';

export interface ConfigPaths {
  root: string;
  configFile: string;
  /** Mode 0600. The two secrets live here and never in `config.json` (D-08). */
  envFile: string;
  dbFile: string;
  logDir: string;
  worktreeRoot: string;
}

/**
 * Default paths under the operator's home directory. Pure: the caller passes the home
 * directory (`os.homedir()` — never `process.env.HOME`, which is unset in some spawned
 * contexts) because `src/domain/` imports nothing, not even node builtins.
 *
 * Config, secrets, database, logs and worktrees together under one root is what lets the
 * daemon run from any working directory, keeps state out of any repo by accident, and
 * puts it where a `git clean` cannot reach.
 */
export function configPaths(homeDir: string): ConfigPaths {
  // ponytail: POSIX join by hand — this is a macOS/Linux single-operator daemon.
  const root = `${homeDir}/${CONFIG_DIR_NAME}`;
  return {
    root,
    configFile: `${root}/config.json`,
    envFile: `${root}/.env`,
    dbFile: `${root}/store.db`,
    logDir: `${root}/logs`,
    worktreeRoot: `${root}/worktrees`,
  };
}

/**
 * The resolved defaults, as constants (T40).
 *
 * Phase 8's wizard, the daemon entry point and the store each need these paths, and three
 * independent derivations of "the config root" is three chances for one of them to differ.
 * These name *this product's* paths only — the wizard's lookup of ngrok's own
 * `~/Library/Application Support/ngrok/ngrok.yml` is a different concern and must not be
 * routed through here.
 */
const DEFAULT_PATHS = configPaths(homedir());
export const CONFIG_ROOT = DEFAULT_PATHS.root;
export const CONFIG_PATH = DEFAULT_PATHS.configFile;
export const ENV_PATH = DEFAULT_PATHS.envFile;
export const DB_PATH = DEFAULT_PATHS.dbFile;
// ponytail: `logDir` lives on ConfigPaths, and the run engine needs only the
// resolved default. Thread a whole ConfigPaths if the root ever stops being
// `~/.linear-auto-worker` — this is the same DEFAULT_PATHS, not a second guess.
export const LOG_DIR = DEFAULT_PATHS.logDir;

// ── Bot comment markers ──────────────────────────────────────────────────────
//
// One definition, in the only module both ingress and outbound can import. Research names
// duplicating this across two owners as a build-order failure, and TRAPS T32 records that
// two phases had already guessed different homes for it. Never re-declare or re-derive
// these; import them from `src/domain/`.

/**
 * Opens an HTML comment, which Linear renders invisibly. Phase 5 prefixes every comment
 * the bot writes with it; Phase 3 drops any comment carrying it regardless of actor. That
 * actor-independence is the point: the loop guard survives a null actor, a stale cached
 * bot id, and a re-created bot user.
 */
export const BOT_COMMENT_MARKER_PREFIX = '<!-- law-bot';

/**
 * A question comment's marker. Note it begins with `BOT_COMMENT_MARKER_PREFIX`, so a
 * question body is bot-authored by construction rather than by a second convention.
 */
export const QUESTION_MARKER_PREFIX = `${BOT_COMMENT_MARKER_PREFIX}:q:`;

/** The loop guard. True for anything the bot wrote, question comments included. */
export function isBotAuthoredBody(body: string): boolean {
  return body.includes(BOT_COMMENT_MARKER_PREFIX);
}

/** The marker to embed in a question comment. The short code is the question id's head. */
export function questionMarker(questionId: string): string {
  return `${QUESTION_MARKER_PREFIX}${questionId.slice(0, 8)} -->`;
}

/**
 * The short code carried by a question comment, or null. Correlation tier 2 matches a
 * reply to a pending question with it; built here so ingress and outbound cannot drift
 * on the marker's exact spelling.
 */
export function questionShortCode(body: string): string | null {
  const at = body.indexOf(QUESTION_MARKER_PREFIX);
  if (at < 0) return null;
  const code = body.slice(at + QUESTION_MARKER_PREFIX.length, at + QUESTION_MARKER_PREFIX.length + 8);
  return /^[0-9a-f]{8}$/.test(code) ? code : null;
}
