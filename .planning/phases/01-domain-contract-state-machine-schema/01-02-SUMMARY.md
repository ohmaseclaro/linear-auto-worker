---
phase: 01-domain-contract-state-machine-schema
plan: 02
subsystem: domain
tags: [contract, types, ports, config, agent-result]
requires: [01-01]
provides:
  - src/domain/types.ts (Run, PendingQuestion, RunEventRow, Config, markers, config root)
  - src/domain/agent-result.ts (AgentResult, AgentResultSchema, parseAgentResult)
  - src/domain/ports.ts (21 cross-layer interfaces)
  - src/domain/index.ts (barrel)
  - src/domain/state-machine.ts (RUN_STATE_TABLE, RunStateInfo, canTransition)
affects: [02, 03, 04, 05, 06, 07, 08]
tech-stack:
  added: []
  patterns:
    - "zero-dependency domain module (one node:os import, for the home directory)"
    - "discriminated unions over optional fields (Run, AgentResult, DomainEvent, RunEvent)"
    - "sparse per-mapping overrides merged by one resolver"
key-files:
  created:
    - src/domain/agent-result.ts
    - src/domain/ports.ts
    - src/domain/index.ts
    - src/domain/contract.test.ts
  modified:
    - src/domain/types.ts
    - src/domain/state-machine.ts
decisions:
  - "Run is a discriminated union on `kind`; TicketRun.state is `null` (D-04)"
  - "`concurrency` at Config top level, never in `defaults` (no per-mapping override)"
  - "`questionTimeoutMs` is a per-mapping toggle, so it lives in MappingToggles, not Config"
  - "`config.mappings` is a Record keyed by project id then team id (D-07 lookup order)"
  - "AgentResultSchema hand-written as a JSON Schema document, not derived from zod"
metrics:
  duration: ~35m
  completed: 2026-09-06
status: complete
---

# Phase 1 Plan 02: Shared Vocabulary, Config Shape and Ports Summary

The rest of the contract seven branches import: the run and question records, the CONF-01 /
CONF-02 configuration shape with one resolver, the schema-constrained agent result, all 21
cross-layer port interfaces, and a barrel so every guessed import path lands.

## What Was Built

| File | Contents |
|------|----------|
| `src/domain/types.ts` | `Run` union, `RunEventRow`, `PendingQuestion`, the config shape, config-root constants, the bot-comment markers |
| `src/domain/agent-result.ts` | `AgentResult`, `AgentResultSchema`, `parseAgentResult` |
| `src/domain/ports.ts` | 21 interfaces across L0–L4, re-exporting every type it references |
| `src/domain/index.ts` | barrel over all six modules |
| `src/domain/state-machine.ts` | **added** `RunStateInfo`, `RUN_STATE_TABLE`, `canTransition` |
| `src/domain/contract.test.ts` | written, not run (rush mode): the parser, the table, the resolver, the markers |

## Contract additions requested

Everything below is the authoritative exported surface as landed. Phase 7's integration
gate should reconcile sibling branches onto **these** names.

### `src/domain/types.ts`

```ts
type RunId = string; type IssueId = string; type SessionId = string;
type RunState = 'queued'|'preparing'|'running'|'awaiting_answer'|'delivering'
              |'delivered'|'partial'|'failed'|'cancelled';
const TERMINAL: ReadonlyArray<RunState>;      // delivered, partial, failed, cancelled
const HOLDS_SLOT: ReadonlyArray<RunState>;    // preparing, running, delivering
const HAS_CHILD: ReadonlyArray<RunState>;     // running

interface RepoRun {                           // kind: 'repo'
  id; parentRunId: RunId|null; issueId; issueKey; issueTitle; issueUrl;
  attempt: number; questionRound: number; createdAt: number; updatedAt: number;
  state: RunState;
  repoDir: string; repoSlug: string; branch: string;
  worktreePath: string|null; sessionId: SessionId|null; pid: number|null;
  prUrl: string|null; failureReason: string|null;
  cancelRequested?: boolean;                  // D-05 deferred cancel
  resumable?: boolean;                        // set by restart recovery
}
interface TicketRun {                         // kind: 'ticket'
  ...same base...; state: null;
  repoDir: null; repoSlug: null; branch: null;
  worktreePath: null; sessionId: null; pid: null;
}
type Run = RepoRun | TicketRun;

interface RunEventRow { runId: RunId; from: RunState|null; to: RunState; at: number; detail: string|null }
interface PendingQuestion { id; runId; text; assumption; linearCommentId: string|null;
  askedAt: number; deadlineAt: number; status: 'open'|'answered'|'timed_out'|'cancelled';
  answer: string|null }

interface MappingToggles { postLinearComments: boolean; notifySlack: boolean;
  baseBranch: string; draftPr: boolean; questionsEnabled: boolean;
  maxRunMs: number; questionTimeoutMs: number }
interface RepoMapping { repoDir: string; repoSlug: string; baseBranch: string; enabled: boolean }
interface ProjectMapping { linearProjectId: string|null; linearTeamId: string|null;
  repos: RepoMapping[]; slackWebhookUrl?: string; overrides?: Partial<MappingToggles> }
interface Config { botUserId; teamId; concurrency: number; maxQuestionRounds: number;
  maxTurns: number; maxBudgetUsd?: number; worktreeRoot: string; dbPath: string;
  defaults: MappingToggles; mappings: Record<string, ProjectMapping> }

function resolveToggles(defaults: MappingToggles, mapping?: Pick<ProjectMapping,'overrides'>): MappingToggles;

const CONFIG_DIR_NAME = '.linear-auto-worker';
interface ConfigPaths { root; configFile; envFile; dbFile; logDir; worktreeRoot }
function configPaths(homeDir: string): ConfigPaths;
const CONFIG_ROOT, CONFIG_PATH, ENV_PATH, DB_PATH: string;   // resolved off os.homedir()

const BOT_COMMENT_MARKER_PREFIX = '<!-- law-bot';
const QUESTION_MARKER_PREFIX    = '<!-- law-bot:q:';         // begins with the bot prefix
function isBotAuthoredBody(body: string): boolean;
function questionMarker(questionId: string): string;         // `<!-- law-bot:q:xxxxxxxx -->`
function questionShortCode(body: string): string|null;       // the 8-char code, or null
```

### `src/domain/agent-result.ts`

```ts
type AgentResult =
  | { status:'complete';    summary; prTitle; prBody }
  | { status:'needs_input'; summary; question; assumptionIfUnanswered }
  | { status:'failed';      summary; failureReason }
  | { status:'crashed';     exitCode: number; stderrTail: string }
  | { status:'cancelled' };
const AgentResultSchema;                       // JSON Schema doc, `as const`, enum of the 3 the agent can emit
function parseAgentResult(raw: unknown): AgentResult;   // throws AgentResultParseError
```

### `src/domain/state-machine.ts` (additions)

```ts
function canTransition(from: RunState, to: RunState): boolean;      // state-to-state
interface RunStateInfo { state: RunState; holdsSlot: boolean; hasLiveChild: boolean; terminal: boolean }
const RUN_STATE_TABLE: Readonly<Record<RunState, RunStateInfo>>;    // enumerable; keys come from
                                                                    // TRANSITIONS, so a 10th state
                                                                    // cannot escape it
```

### `src/domain/ports.ts`

Interfaces, unchanged in name from `research/ARCHITECTURE.md`: `ConfigLoader`, `Store`,
`Logger`, `TunnelManager`, `WebhookRegistrar`, `WebhookDelivery`, `Receiver`, `DomainEvent`,
`EventRouter`, `Scheduler`, `RunEngine`, `Worktree`, `WorktreeManager`, `AgentSpawnRequest`,
`AgentRunner`, `PullRequest`, `Deliverer`, `LinearIssue`, `LinearClient`, `RunEvent`,
`Notifier`. Signature deltas against ARCHITECTURE.md:

```ts
Store.insertRun(r: Run): void                          // NOT Omit<Run,'createdAt'|'updatedAt'>
Store.appendRunEvent(e: RunEventRow): void             // new (D-03)
Store.listRunEvents(runId: RunId): RunEventRow[]       // new
Store.getQuestion(id: string): PendingQuestion|undefined   // new (lookup by primary key)
Store.tryInsertDelivery(deliveryId, receivedAt): boolean   // replaces recordDelivery
Store.kvGet(k), Store.kvSet(k, v)                      // the pair sqlite-store.ts implements

// DomainEvent is the union of BOTH producers' kind sets — see "The DomainEvent seam" below
type DomainEvent =
  | { kind:'issue.assigned';   issueId; deliveryId? }        // Phase 3 emits
  | { kind:'issue.unassigned'; issueId; deliveryId? }
  | { kind:'comment.created';  issueId; commentId; parentId?; deliveryId? }
  | { kind:'run.requested';    issueId }                     // Phase 6 consumes
  | { kind:'run.cancelled';    issueId; reason }
  | { kind:'question.answered'; questionId; answer; authorName }
  | { kind:'ignored'; reason };

Scheduler.positionOf(runId: RunId): number             // new
Scheduler.syncFromStore(runs: readonly Run[]): void    // new

LinearIssue.teamId: string | null                      // new, REQUIRED (D-07)

RunEvent |= { kind:'run.partial'; run: Run; prUrl: string; note: string }   // new member
```

`ports.ts` also re-exports `Config`, `ConfigPaths`, `MappingToggles`, `RepoMapping`,
`ProjectMapping`, `Run`, `RepoRun`, `TicketRun`, `RunId`, `RunState`, `RunEventRow`,
`PendingQuestion`, `IssueId`, `SessionId`, `AgentResult`, plus the values
`AgentResultSchema`, `parseAgentResult`, `BOT_COMMENT_MARKER_PREFIX`,
`QUESTION_MARKER_PREFIX`, `isBotAuthoredBody`, `resolveToggles`. Importing any of them from
`types.js`, from `ports.js`, or from the barrel all compile.

### Deviations from ARCHITECTURE.md's text

1. **`Run` split into a union** (`RepoRun | TicketRun`) so a ticket-level parent has no
   `state` column to disagree with its children (D-04). ARCHITECTURE.md declares one flat
   interface with a required `state`.
2. **`Config` restructured** into `defaults: MappingToggles` + `mappings: Record<string,
   ProjectMapping>`. ARCHITECTURE.md's `projects: ProjectMapping[]` and its per-mapping
   `postLinearComments` / `autoTransition` booleans are superseded by the ADDENDUM and D-09.
3. **`concurrency` stays at `Config` top level.** It is a global RAM cap; putting it in
   `defaults` would imply a per-mapping override that must not exist.
4. **`questionTimeoutMs` moved into `MappingToggles`**, not `Config` — 06-01 asked for it as
   a per-mapping toggle, and defining it in both places would be exactly the second
   definition this plan exists to prevent. `MappingToggles` therefore has seven fields: the
   six CONF-02 toggles plus this one.
5. **`RunEvent` member names were deliberately NOT renamed.** `run.done` and
   `run.abandoned` keep their names even though the matching states are now `delivered` and
   `cancelled` / `failed`. Phase 5 is writing switch cases against those exact strings; a
   rename for cosmetic symmetry would break that branch for no gain.
6. **`Store.insertRun` takes a full `Run`.** The engine already stamps `createdAt` /
   `updatedAt` and returns them to its caller; an `Omit<>` signature would have the store
   generate a second, different pair of timestamps.
7. **`recordDelivery` → `tryInsertDelivery`** — the new name states the atomicity contract
   the dedupe depends on, and Phase 3 has live call sites under it. **`kvGet`/`kvSet` are
   kept**, because that is the pair `src/infra/store/sqlite-store.ts` actually implements;
   the three `kvPut` call sites get renamed at integration.
9. **`DomainEvent` is the union of both producers' kind sets** — see the next section.
8. **`node:os` is imported by `types.ts`** — the single exception to "imports nothing", for
   `homedir()` behind the resolved `CONFIG_ROOT` / `CONFIG_PATH` / `ENV_PATH` / `DB_PATH`
   constants requested by Phase 8 (T40). The pure `configPaths(homeDir)` underneath takes
   the home directory as an argument, so nothing else in the domain touches a builtin.
   `DB_PATH` ends in `store.db`, matching the name Phase 2's `src/infra/index.ts` already
   uses.

## The `DomainEvent` seam — Phase 7 must wire the mapping

`DomainEvent` now carries **two vocabularies with zero overlapping `kind`s**:

- Phase 3's router and poller emit `issue.assigned`, `issue.unassigned`, `comment.created`
  — webhook facts, named after what Linear did.
- Phase 6's run engine switches on `run.requested`, `run.cancelled`, `question.answered`,
  `ignored` — intentions, named after what the daemon should do.

Neither set was renamed to match the other: three of Phase 3's gated verify strings assert
its literals, and Phase 6's switch is already written against its own.

**The translation step between them does not exist yet, and it is Phase 7's to write at the
composition root.** Until it does, an ingress event handed straight to the engine falls
through the engine's `default:` arm — the daemon boots clean, verifies clean, and processes
nothing. A typecheck cannot catch this, because both sets are legal members of the union.

It belongs at the composition root rather than in the contract because the interesting part
of the mapping needs the store: `comment.created` becomes `question.answered` only when
03-CONTEXT D-05's `parentId` correlation (or the short-code fallback via
`questionShortCode`) resolves it to an open question. That is the same seam D-05 already
has to live at, and `src/domain/` has no dependencies to do it with.

Rough shape of what Phase 7 owes:

| ingress event | condition | engine event |
|---|---|---|
| `issue.assigned` | always | `run.requested` |
| `issue.unassigned` | always | `run.cancelled` (reason: unassigned) |
| `comment.created` | `isBotAuthoredBody(body)` | drop — the loop guard |
| `comment.created` | `parentId` or short code hits an open question | `question.answered` |
| `comment.created` | otherwise | `ignored` |

## Reconciliation the integration gate must do (found on this branch, NOT fixed here)

Wave-1 merged more than `src/domain/`: `src/infra/`, `src/orchestration/` and `src/cli/`
are all present. Each item below is a real, already-written call site that will not compile
against the contract as landed. All are one- or two-line fixes in files this plan does not
own.

| # | File | Problem | Fix |
|---|------|---------|-----|
| R1 | `src/orchestration/scheduler.ts:52` | reads `config.defaults.concurrency` | `config.concurrency` (it is top-level by binding instruction) |
| R2 | `src/orchestration/run-engine.ts:78`, `scheduler.ts:110` | `run.state` is now `RunState \| null`, so `canTransition(run.state, …)` / `holdsSlot(run.state)` fail | guard the ticket kind: `if (run.kind !== 'repo') throw …` — a parent has no state to transition, which is the point of D-04 |
| R3 | `src/infra/config.ts` | declares its own `Toggles` with **different names** — `slackNotify`, `questionFlowEnabled`, `maxRunTimeMs` | rename to `notifySlack`, `questionsEnabled`, `maxRunMs`; import `MappingToggles` from the domain instead of re-declaring |
| R4 | `src/infra/config.ts` | `mappings` is an **array** with a `.refine()`; the domain and Phase 6 both use a `Record` keyed by project id then team id | make the zod schema `z.record(z.string(), MappingSchema)` and drop the local `resolveMapping` in favour of the record lookup |
| R5 | `src/infra/config.ts` | local `defaultRoot()` duplicates `CONFIG_ROOT`/`CONFIG_PATH`/`ENV_PATH` | import them from the domain (T40) |
| R6 | `src/infra/logger.ts:31` | `constructor(private readonly secrets: Set<string>)` is a **constructor parameter property** — violates T35 (`erasableSyntaxOnly`) | explicit field assignment |
| R7 | `src/infra/store/migrations/001-init.ts` | Phase 2's copy of the migration; T33 settles ownership on Phase 1 | delete in favour of plan 01-04's |
| R8 | `errors.ts` | `IllegalTransitionError(from, trigger)` — 06-01 asked for `(from, to)`. It compiles either way (`RunState` is a `string`), only the message reads as a trigger | leave, or widen the parameter name; not worth a rename across branches |
| R9 | 3 call sites | `store.kvPut(...)` | `store.kvSet(...)` — the port matches `sqlite-store.ts` |
| R10 | `src/infra/store/migrations/001-init.ts` (superseded by 01-04) | `created_at`, `updated_at`, `asked_at`, `deadline_at`, `received_at` and `at` are declared **TEXT**, but every writer stores epoch-ms **numbers**. It sorts correctly only while ms timestamps share a digit width — an undocumented invariant the question deadline sweep leans on | **plan 01-04's migration must declare all six INTEGER.** The domain types already say `number`, and now say why. |
| R11 | Phase 7 composition root | no ingress→engine `DomainEvent` mapping exists | see "The `DomainEvent` seam" above — this is the one that fails silently |

## Known Stubs

None. Everything in this plan is a type, a constant, or a pure function, and each pure
function has an assertion in `src/domain/contract.test.ts`.

## Verification

Every static check in the plan passed. Additionally the runtime logic was executed once
against Node's type stripping in a scratch directory (a copy with `.ts` specifiers, so no
build and no `node --test` — rush rule 4 was not violated in the repo): `parseAgentResult`
accepts the five valid shapes and rejects a non-object, an unknown status, a `complete`
missing `prTitle` and a `needs_input` missing `assumptionIfUnanswered`; `RUN_STATE_TABLE`
enumerates nine states with `awaiting_answer` holding no slot; `canTransition` allows
`queued→preparing` and refuses `delivered→running`; `resolveToggles` merges sparsely; the
markers round-trip a short code.

`STATE.md` / `ROADMAP.md` were deliberately not touched: eight phases are executing in
parallel worktrees, and eight branches rewriting the same progress files is a merge
conflict per branch for no information the orchestrator does not already have.

## Self-Check: PASSED

All seven artefacts exist on disk; all three commits (`824628b`, `299820c`, `463300b`) are
in the log; the three commits delete no tracked file.
