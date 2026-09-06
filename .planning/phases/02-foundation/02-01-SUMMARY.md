---
phase: 02-foundation
plan: 01
subsystem: infra
tags: [zod, better-sqlite3, pino, sqlite, config, logging, redaction]

# Dependency graph
requires:
  - phase: 01-domain-contract-state-machine-schema
    provides: "RunState literals, table names, Config type shape, src/domain/ module paths (binding ADDENDUM, not yet on this branch — rush mode)"
provides:
  - "loadFoundation() — the single composition point wiring config -> secrets -> logger -> store"
  - "openStore()/runMigrations() — WAL + busy_timeout SQLite store with idempotent PRAGMA user_version migrations"
  - "001-init.ts migration creating all five ADDENDUM tables (runs, questions, deliveries, kv, run_events) plus required indexes"
  - "createLogger() — single pino sink with key-pattern + value-level secret redaction and registerSecret() for post-boot secrets"
  - "Full CONF-02 ConfigSchema, resolveMapping() (project-then-team fallback), loadSecrets() (0600-enforced .env)"
affects: [03-ingress, 04-execution, 05-outbound, 06-orchestration, 07-integration-daemon-lifecycle, 08-setup-wizard-safety-pass]

# Tech tracking
tech-stack:
  added: ["zod@4.5.4", "better-sqlite3@13.0.3", "pino@10.3.1", "pino-pretty (dev)"]
  patterns:
    - "Sink-level log redaction only — one pino() call site, all other loggers are child() of it"
    - "PRAGMA user_version migration runner, one TypeScript module per migration exporting {version, sql}"
    - "Config validated via zod safeParse then cast to the domain Config type, never redefined locally"

key-files:
  created:
    - package.json
    - src/infra/config.ts
    - src/infra/config.test.ts
    - src/infra/logger.ts
    - src/infra/store/db.ts
    - src/infra/store/migrations/001-init.ts
    - src/infra/index.ts
  modified: []

key-decisions:
  - "Redaction is two independent halves in one sink: formatters.log() walks the object recursively for key-pattern matches (/(token|secret|key|authorization)/i), and a custom Writable stream string-replaces known secret values — covers both an {authorization: '...'} shape and a secret embedded inside an unrelated string (T23, T-02-01, D-05)"
  - "Task 1 shipped a tracer-minimal ConfigSchema (defaults/mappings as loose records) so the three-piece wiring (config -> secrets -> logger -> store) could be proven and committed before the full toggle/mapping validation landed in Task 2, per the plan's staged tracer-then-expand structure"
  - "loadSecrets() hand-parses KEY=value lines — no dependency for two keys, per STACK.md's alternatives-considered guidance"

patterns-established:
  - "Every later phase's Logger use goes through createLogger()'s single pino instance via child() — do not construct a second pino() anywhere"

requirements-completed: [SETUP-10]

coverage:
  - id: D1
    description: "loadConfig()/ConfigSchema rejects a config.json missing or misshaping a required field, naming the field via z.prettifyError()"
    requirement: "SETUP-10"
    verification:
      - kind: unit
        ref: "src/infra/config.test.ts#missing defaults.baseBranch fails safeParse and prettifyError names the field"
        status: unknown
    human_judgment: true
    rationale: "RUSH mode: config.test.ts is written but not run (no npm install/node --test on this branch). Coverage not determined at authoring time — the milestone's single integration gate must run node --test and reclassify."
  - id: D2
    description: "openStore() sets WAL + busy_timeout before any migration SQL runs; running the migration twice is a no-op"
    verification: []
    human_judgment: true
    rationale: "No runtime execution possible under RUSH mode (no better-sqlite3 installed on this branch yet); verified structurally via grep in <verify> only. Needs a real run at the integration gate."
  - id: D3
    description: "001-init.ts creates all five ADDENDUM tables (runs, questions, deliveries, kv, run_events) plus idx_runs_state and idx_questions_deadline_at"
    verification:
      - kind: other
        ref: "grep -c 'CREATE TABLE <name>' / 'idx_*' over src/infra/store/migrations/001-init.ts (all 7 checks passed, see Self-Check)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Logger redacts every secret from output via one sink-level serializer, not per-call-site convention"
    verification:
      - kind: other
        ref: "grep -c 'REDACTED'/'registerSecret'/pino( over src/infra/logger.ts (all checks passed, see Self-Check); no runtime log-line assertion possible without node_modules"
        status: pass
    human_judgment: true
    rationale: "Structural grep confirms the shape exists; the actual no-secret-in-output property can only be proven by running createLogger() against real data at the integration gate."

duration: 25min
completed: 2026-09-06
status: complete
---

# Phase 2 Plan 1: Foundation tracer — config, store, logger, wired Summary

**`loadFoundation()` composes a zod-4-validated Config loader, a WAL-mode SQLite store with idempotent `PRAGMA user_version` migrations, and a pino logger with sink-level key- and value-level secret redaction, in that order.**

## Performance

- **Duration:** 25 min
- **Started:** 2026-09-06T16:18:00Z
- **Completed:** 2026-09-06T16:43:00Z
- **Tasks:** 2
- **Files modified:** 7

## Accomplishments
- `loadFoundation()` in `src/infra/index.ts`: the single composition point — `loadConfig()` → `loadSecrets()` → `createLogger()` → `openStore()` — that Phase 7's daemon boot will import
- `src/infra/store/db.ts` + `store/migrations/001-init.ts`: WAL mode + `busy_timeout=5000` set before any table exists; migration runner reads/bumps `PRAGMA user_version` inside one transaction per migration, making a repeat run a no-op; all five ADDENDUM tables plus the two required indexes (`idx_runs_state`, `idx_questions_deadline_at`) and three discretionary ones
- `src/infra/logger.ts`: exactly one `pino()` instantiation; `formatters.log` recursively redacts any key matching `/(token|secret|key|authorization)/i`; a custom `Writable` stream string-replaces every known secret value; `registerSecret()` lets a secret discovered after boot (Phase 3's webhook signing secret) join the redaction set; `child()` returns a wrapped logger sharing the same secret set
- `src/infra/config.ts`: full `ConfigSchema` for all six CONF-02 toggles as `defaults` plus `TogglesSchema.partial()` `overrides`; `.refine()` enforces exactly one of `linearProjectId`/`linearTeamId` per mapping; `resolveMapping()` implements project-then-team fallback; `loadSecrets()` enforces `.env` mode `0600` and hand-parses the two keys; all error messages use `z.prettifyError()` (zod v4 idiom)
- `src/infra/config.test.ts`: written (not run, per RUSH mode) covering all six behaviors named in the plan

## Task Commits

1. **Task 1: loadFoundation() — config to store to logger, one path** - `106c341` (feat)
2. **Task 2: Full config validation — six toggles, sparse overrides, project/team fallback, secrets** - `984f968` (feat)

**Plan metadata:** pending (this commit)

_Note: RUSH mode overrides standard TDD RED/GREEN sequencing — `config.test.ts` was written alongside its implementation in a single commit per the plan's explicit "Write it; do not run it" instruction, since nothing on this branch can execute (no `node_modules`)._

## Files Created/Modified
- `package.json` - pins `zod@4.5.4`, `better-sqlite3@13.0.3`, `pino@10.3.1`; `pino-pretty` dev-only, unpinned
- `src/infra/config.ts` - `ConfigSchema`, `TogglesSchema`, `MappingSchema`, `loadConfig()`, `resolveMapping()`, `loadSecrets()`, `defaultRoot()`
- `src/infra/config.test.ts` - `node:test` coverage of all six behaviors from the plan's `<behavior>` block
- `src/infra/logger.ts` - `Logger` interface, `createLogger()`, sink-level dual redaction
- `src/infra/store/db.ts` - `openStore()`, `runMigrations()`, `Migration` interface
- `src/infra/store/migrations/001-init.ts` - `migration001`: all five tables plus five indexes
- `src/infra/index.ts` - `loadFoundation()`

## Decisions Made
- Split `config.ts` into a tracer-minimal Task 1 version (loose `defaults`/`mappings` records) and a fully-validated Task 2 version, matching the plan's explicit two-task structure and preserving a clean, reviewable commit history rather than landing the full schema in one commit.
- `resolveMapping()` types `config.mappings`/`config.defaults` via a local cast to the `Mapping`/`Toggles` types inferred from this file's own zod schemas, since the exact field-level shape of the domain `Config` type's `mappings` entries is not fixed by the ADDENDUM beyond `repos[]`/`slackWebhookUrl`/sparse-overrides. See Contract additions requested below.
- Chose `store.db` as the SQLite filename under the config root (Claude's Discretion per 02-CONTEXT.md) — not specified by the ADDENDUM.

## Deviations from Plan

None — plan executed exactly as written. Both tasks' `<verify>` grep checks (structural, per RUSH mode — no `tsc`/`node --test` run) all passed on the first attempt; see Self-Check below.

## Issues Encountered

None.

## Contract additions requested

Everything below is an assumption this plan made about an export from `src/domain/` that the ADDENDUM does not name by exact signature. Phase 7's integration gate should reconcile these against whatever Phase 1 actually wrote.

1. **`ConfigError` class, from `src/domain/errors.ts`.**
   Assumed signature: `export class ConfigError extends Error { constructor(message: string) }`.
   Used in `src/infra/config.ts` for both `loadConfig()`'s schema-validation failure and `loadSecrets()`'s mode/missing-key failures. If Phase 1's `errors.ts` does not export this name, either add it there or update `config.ts`'s two `throw new ConfigError(...)` call sites to the actual exported class.

2. **`Config` type shape, from `src/domain/types.ts`, beyond what the ADDENDUM names.**
   The ADDENDUM fixes `Config` as `{ defaults, mappings }` where `defaults` holds "the six CONF-02 toggles" and `mappings` are "project- or team-keyed, `repos[]`, optional `slackWebhookUrl`, a sparse toggle override" — but does not fix field names beyond that prose. This plan assumed:
   ```ts
   interface Toggles {
     postLinearComments: boolean;
     slackNotify: boolean;
     baseBranch: string;
     draftPr: boolean;
     questionFlowEnabled: boolean;
     maxRunTimeMs: number;
   }
   interface Mapping {
     linearProjectId?: string;
     linearTeamId?: string;
     repos: { repoDir: string; repoSlug: string }[];
     slackWebhookUrl?: string;
     overrides?: Partial<Toggles>;
   }
   interface Config {
     defaults: Toggles;
     mappings: Mapping[];
   }
   ```
   `src/infra/config.ts`'s `TogglesSchema`/`MappingSchema` (zod) are the source of truth for this assumption — if Phase 1's actual `Config` type disagrees on a field name, `resolveMapping()`'s internal casts (`config as unknown as { mappings: Mapping[] }` etc.) are the two lines to fix.

3. **A `Logger` port in `src/domain/ports.ts`.**
   Not required by anything in this plan (the `Logger` interface used throughout is defined locally in `src/infra/logger.ts`), but flagging in case a later phase's port set expects a `Logger` port matching this shape:
   ```ts
   interface Logger {
     child(bindings: Record<string, unknown>): Logger;
     info(objOrMsg: unknown, msg?: string, ...args: unknown[]): void;
     warn(objOrMsg: unknown, msg?: string, ...args: unknown[]): void;
     error(objOrMsg: unknown, msg?: string, ...args: unknown[]): void;
     debug(objOrMsg: unknown, msg?: string, ...args: unknown[]): void;
   }
   ```

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

`loadFoundation()` is ready for Phase 7's daemon boot to import. Plan 02 (this phase's second plan) builds the store's full CRUD surface and the logger's redaction edge cases on top of `openStore()`/`createLogger()` as committed here — no further changes to `db.ts`, `migrations/001-init.ts`, or `logger.ts`'s public shape should be needed from this plan.

Blocking concern for the milestone's integration gate: `config.test.ts` has never been executed (RUSH mode). Once `src/domain/` lands and `npm install` runs, `node --test src/infra/config.test.ts` must be run for the first time and any failures fixed before this plan's SETUP-10 coverage can be marked `pass` rather than `unknown`.

---
*Phase: 02-foundation*
*Completed: 2026-09-06*

## Self-Check: PASSED

All 7 created files and both task commit hashes (`106c341`, `984f968`) verified present on disk / in `git log`.
