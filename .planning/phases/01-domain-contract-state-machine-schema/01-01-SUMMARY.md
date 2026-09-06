---
phase: 01-domain-contract-state-machine-schema
plan: 01
subsystem: domain
tags: [typescript, esm, nodenext, state-machine, node-test, tsconfig, npm-pins]

requires: []
provides:
  - "package.json with the full pinned dependency set and the canonical D-13 verify script"
  - "tsconfig.json — NodeNext ESM, strict, erasableSyntaxOnly"
  - "src/domain/types.ts — RunId/IssueId/SessionId, the nine RunState literals, TERMINAL/HOLDS_SLOT/HAS_CHILD"
  - "src/domain/errors.ts — LawError hierarchy shared by all five parallel layers"
  - "src/domain/state-machine.ts — twelve-member Trigger union, full transition table, predicates, deriveParentState"
  - "src/domain/state-machine.test.ts — table-driven suite over all nine states"
affects: [01-02, 01-03, 01-04, phase-02, phase-03, phase-04, phase-05, phase-06, phase-07, phase-08]

tech-stack:
  added:
    - "@linear/sdk 93.0.1 (exact pin)"
    - "@ngrok/ngrok 1.7.0"
    - "better-sqlite3 13.0.3"
    - "zod 4.5.4"
    - "execa 10.0.1"
    - "pino 10.3.1"
    - "@inquirer/prompts 8.7.1"
    - "typescript ~5.9, tsx 4.23.13, pino-pretty ^13, @types/node ^22, @types/better-sqlite3 ^9"
  patterns:
    - "NodeNext ESM: every relative import inside src/ carries a .js extension"
    - "erasableSyntaxOnly: no enums, no namespaces, no constructor parameter properties anywhere in src/"
    - "Pure domain module: src/domain/ imports nothing outside itself"
    - "Table-driven tests with node:test + node:assert/strict, zero test dependencies"

key-files:
  created:
    - package.json
    - tsconfig.json
    - src/domain/types.ts
    - src/domain/errors.ts
    - src/domain/state-machine.ts
    - src/domain/state-machine.test.ts
  modified:
    - .gitignore
    - .planning/TRAPS.md

key-decisions:
  - "Classification arrays are typed ReadonlyArray<RunState> rather than ARCHITECTURE.md's readonly RunState[] — identical type, but the bracket-free annotation is what the plan's own region-scoped verify regex requires"
  - "IllegalTransitionError types its trigger as string rather than Trigger, avoiding a types/errors/state-machine import cycle"
  - "Kept .js relative specifiers despite proving node --test cannot resolve them — the extension convention is binding contract text on seven parallel branches; the gate fix belongs to Phase 7 (T32)"
  - "Added @types/better-sqlite3 ^9 (Rule 2): better-sqlite3@13.0.3 ships no declarations, and STACK.md names the package in its Installation block even though its Recommended Stack table omits it — so it was inside the verified-clean install set all along"
  - "@types/node held at ^22 rather than STACK.md's ^24, per the plan and T15 — this machine runs Node v22.23.1 and ^24 types would advertise APIs the runtime lacks"

patterns-established:
  - "Errors: every deliberate throw is a LawError subclass carrying a readonly string code and setting this.name"
  - "Transition table is a const Record<RunState, Partial<Record<Trigger, RunState>>>; nextState reads it, assertTransition throws on null"
  - "Compile-time exhaustiveness: test files derive their state/trigger arrays from the exported unions via Exclude<>, so a new union member fails tsc rather than passing silently"

requirements-completed: [CONF-01, CONF-02]

coverage:
  - id: D1
    description: "package.json exposes `verify` as exactly `tsc --noEmit && node --test` (D-13), the gate every one of the eight phases runs"
    requirement: CONF-01
    verification:
      - kind: other
        ref: "node -e byte-equality assertion on p.scripts.verify"
        status: pass
    human_judgment: false
  - id: D2
    description: "The full pinned dependency set from STACK.md, with @linear/sdk exact-pinned and typescript held to the ~5.9 line"
    requirement: CONF-01
    verification:
      - kind: other
        ref: "node -e pin assertions on dependencies['@linear/sdk'] and devDependencies.typescript"
        status: pass
    human_judgment: false
  - id: D3
    description: "RunState is exactly the nine ADDENDUM literals; no stale claimed/worktree_ready/agent_running/done/abandoned state name survives"
    requirement: CONF-01
    verification:
      - kind: other
        ref: "node -e nine-literal presence check on src/domain/types.ts; grep -rE over src/ for the five dead names"
        status: pass
    human_judgment: false
  - id: D4
    description: "HOLDS_SLOT is preparing/running/delivering and excludes the parked state; HAS_CHILD is running alone (D-02)"
    requirement: CONF-01
    verification:
      - kind: unit
        ref: "src/domain/state-machine.test.ts#the nine states partition into slot / child / terminal as D-02 requires"
        status: pass
      - kind: other
        ref: "node -e region-scoped negative check on the HOLDS_SLOT and HAS_CHILD declarations"
        status: pass
    human_judgment: false
  - id: D5
    description: "Every legal transition of the nine-state table is accepted and a representative set of illegal ones rejected, table-driven (D-12)"
    requirement: CONF-01
    verification:
      - kind: unit
        ref: "src/domain/state-machine.test.ts#every legal transition resolves to its stated target state"
        status: pass
      - kind: unit
        ref: "src/domain/state-machine.test.ts#no transition exists outside the legal table"
        status: pass
    human_judgment: false
  - id: D6
    description: "Cancel is accepted from every non-terminal state, deferred for the two states with irreversible side effects (D-05)"
    requirement: CONF-02
    verification:
      - kind: unit
        ref: "src/domain/state-machine.test.ts#cancel is deferred for exactly the two states with irreversible side effects"
        status: pass
    human_judgment: false
  - id: D7
    description: "A ticket-kind parent run's status is a pure function of its children's states (D-04)"
    requirement: CONF-01
    verification:
      - kind: unit
        ref: "src/domain/state-machine.test.ts#a parent's state is a pure function of its children (D-04)"
        status: pass
    human_judgment: false

duration: 30min
completed: 2026-09-06
status: complete
---

# Phase 1 Plan 01: Domain Contract, State Machine & Skeleton Summary

**The nine-state run vocabulary, its full transition table, the shared error hierarchy, and the canonical `tsc --noEmit && node --test` gate that all eight phases run — plus two verified traps that would otherwise have detonated at the integration gate.**

## Performance

- **Duration:** ~30 min
- **Completed:** 2026-09-06T16:42:01Z
- **Tasks:** 3/3
- **Files modified:** 8

## Accomplishments

- **The canonical verify script exists.** `package.json` `scripts.verify` is byte-identical to D-13's `tsc --noEmit && node --test`. Every later phase gate now has something to run.
- **The nine state literals are committed** exactly as the ADDENDUM fixes them, together with the classification arrays encoding D-02's slot/child rule. `awaiting_answer` holds neither a slot nor a child — the property the whole scheduler rests on.
- **The transition table is complete and executable.** 22 legal transitions across all nine states, a twelfth `delivered_partial` trigger, deferred-cancel semantics (D-05), and `deriveParentState` (D-04).
- **The suite was actually executed.** Rush mode forbids running the gate in-repo, so the domain module was copied to a scratch directory with specifiers rewritten and run there: **9 tests, 9 pass, 0 fail.** This is otherwise the only Phase 1 code nobody would run until the end of the milestone.
- **Two milestone-wide traps found and recorded** (T32, T33 in `.planning/TRAPS.md`). Both were proven against live tools and the registry, not guessed.

## Task Commits

1. **Task 1 (tracer): Repo skeleton wired end-to-end through one state transition** — `92fe8fc` (feat)
2. **Task 2: Complete transition table, slot/child classification, parent derivation** — `72d4469` (feat)
3. **Task 3: Table-driven transition test over all nine states** — `3725cc9` (test)
4. **Traps ledger: T32, T33 recorded** — `66a9543` (docs)
5. **Rule 2 auto-fix: `@types/better-sqlite3`, T33 corrected** — `3c80920` (fix)

## Files Created/Modified

- `package.json` — D-13 verify script, full pinned dependency set, `type: module`, `engines.node >=22` (T15: left at 22; Phase 8's preflight decides warn-vs-fail on <24)
- `tsconfig.json` — strict, ES2023, NodeNext both, `verbatimModuleSyntax` and `erasableSyntaxOnly` on, with an in-file comment explaining why the latter is load-bearing rather than stylistic
- `.gitignore` — added `*.tsbuildinfo` to the existing entries
- `src/domain/types.ts` — id aliases, the nine `RunState` literals, `TERMINAL` / `HOLDS_SLOT` / `HAS_CHILD`
- `src/domain/errors.ts` — `LawError` base plus nine subclasses
- `src/domain/state-machine.ts` — `Trigger` union (12), `TRANSITIONS`, `nextState`, `assertTransition`, `holdsSlot`, `hasLiveChild`, `isTerminal`, `acceptsCancel`, `cancelIsDeferred`, `deriveParentState`
- `src/domain/state-machine.test.ts` — table-driven suite, 9 tests
- `.planning/TRAPS.md` — appended T32 and T33

## Decisions Made

- **`ReadonlyArray<RunState>` instead of `readonly RunState[]`** for the three classification arrays. Identical type; ARCHITECTURE.md's spelling puts a `[` inside the annotation, which terminates the plan's own region-scoped verify regex early and makes a correct declaration fail its own check. No consumer sees a difference.
- **`IllegalTransitionError.trigger` is typed `string`, not `Trigger`.** Typing it `Trigger` makes `errors.ts` import from `state-machine.ts`, which already imports `errors.ts`. A type-only cycle would erase cleanly, but `string` costs nothing and keeps `errors.ts` depending on `types.ts` alone.
- **Kept `.js` relative specifiers** even after proving `node --test` cannot resolve them (T32). The extension convention is binding contract text that seven branches are writing against right now; unilaterally flipping it here is exactly the kind of rename that breaks the merge with no attribution.
- **Added `@types/better-sqlite3@^9`** once STACK.md's Installation block turned out to name it. `@types/node` stays at `^22` per the plan and T15, not STACK.md's `^24`, because the runtime here is v22.23.1.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical functionality] Added `@types/better-sqlite3@^9` to devDependencies**

- **Found during:** final plan-level verification ("no dependency name appears that STACK.md does not name")
- **Issue:** `better-sqlite3@13.0.3` ships no type declarations — registry metadata for the pinned version has neither a `types` nor a `typings` field. Every `import Database from 'better-sqlite3'` therefore fails `tsc --noEmit` with TS7016 under `strict`, breaking plan 01-04's migration runner and all of Phase 2 at the integration gate. The plan's devDependencies list omits it.
- **Fix:** added `"@types/better-sqlite3": "^9"`. This is **not** a new dependency: STACK.md's `## Installation` block lists it on the dev install line (its Recommended Stack *table* does not, which is why the plan missed it), so it was part of the 87-package verified-clean install of 2026-09-06. `^9` matches the registry latest, 9.6.0 — what STACK.md's unversioned install line resolves to.
- **Files modified:** `package.json`
- **Verification:** the plan's Task 1 package.json gate re-run and passing. No pin bumped, no unnamed package added.
- **Committed in:** `3c80920`

---

**Total deviations:** 1 auto-fixed (1 × Rule 2)
**Impact on plan:** necessary for the milestone's own gate to compile. No scope creep — the package was already inside STACK.md's sanctioned, install-verified set.

One further finding (T32) was recorded rather than fixed, deliberately; see Issues Encountered.

## Issues Encountered

### 1. `node --test` cannot resolve `.js` specifiers in `.ts` files — D-13's gate would run zero tests (T32)

**Proven, not assumed.** In a scratch directory on this machine (Node v22.23.1):

- `import { hi } from './lib.js'` inside `x.test.ts` → `ERR_MODULE_NOT_FOUND` for `lib.js`; the test fails.
- The identical import written `'./lib.ts'` → passes.

Node's type stripping does not remap `.js` to `.ts`. Since the whole milestone writes NodeNext `.js` specifiers, `tsc --noEmit && node --test` fails for **every** phase, and under rush mode nothing surfaces it until the integration gate — where it reads as a mass test failure rather than a module-resolution problem.

**Not fixed here, on purpose.** The `verify` string is locked by D-13, and the `.js` convention is locked both by this plan's own verify step and by seven parallel branches already writing it. Phase 7 already owns extending the gate; the two remedies are recorded in T32:

- (a) build first — `tsc && node --test dist`; or
- (b) flip source specifiers to `.ts` plus tsconfig `allowImportingTsExtensions` + `rewriteRelativeImportExtensions` (TS 5.7+), a mechanical repo-wide rewrite.

**Workaround used for this plan:** the domain module was copied into a scratch directory with specifiers rewritten by `sed`, and the suite run there — 9/9 pass. Nothing was executed inside the repo and no dependency was installed.

### 2. `better-sqlite3@13.0.3` ships no type declarations (T33)

Registry metadata for the pinned version has neither a `types` nor a `typings` field, so any `import Database from 'better-sqlite3'` fails `tsc --noEmit` with TS7016 under `strict` — hitting plan 01-04's migration runner and all of Phase 2's store.

**I first recorded this as "cannot fix, unsanctioned package" and was wrong.** STACK.md's Recommended Stack table omits `@types/better-sqlite3`, but its `## Installation` code block names it on the dev install line — so it was inside the sanctioned, verified-clean 87-package set all along. Added at `^9`. T33 in the ledger has been corrected to say so, carrying the generalisable lesson: **read STACK.md's Installation block, not just its table, before concluding a package is unsanctioned.**

## Contract additions requested

For Phase 7's integration gate.

### Exported surface of `src/domain/types.ts`

```ts
export type RunId = string;
export type IssueId = string;
export type SessionId = string;

export type RunState =
  | 'queued' | 'preparing' | 'running' | 'awaiting_answer' | 'delivering'
  | 'delivered' | 'partial' | 'failed' | 'cancelled';

export const TERMINAL: ReadonlyArray<RunState>;    // delivered, partial, failed, cancelled
export const HOLDS_SLOT: ReadonlyArray<RunState>;  // preparing, running, delivering
export const HAS_CHILD: ReadonlyArray<RunState>;   // running
```

`Run`, `PendingQuestion`, `Config` and the port interfaces are **not** in this plan — plan 01-02 owns them and appends to the same `types.ts`.

### Exported surface of `src/domain/errors.ts`

```ts
export class LawError extends Error {
  readonly code: string;
  constructor(code: string, message: string, options?: ErrorOptions);
}

export class IllegalTransitionError extends LawError {
  readonly from: RunState;
  readonly trigger: string;
  constructor(from: RunState, trigger: string, options?: ErrorOptions);
}

// each of these: constructor(message: string, options?: ErrorOptions)
export class ConfigError extends LawError {}            // code 'CONFIG'
export class AgentResultParseError extends LawError {}  // code 'AGENT_RESULT_PARSE'
export class MigrationError extends LawError {}         // code 'MIGRATION'
export class WorktreeError extends LawError {}          // code 'WORKTREE'
export class DeliveryError extends LawError {}          // code 'DELIVERY'
export class TunnelError extends LawError {}            // code 'TUNNEL'
export class LinearApiError extends LawError {}         // code 'LINEAR_API'
```

Every subclass sets `this.name` to its own class name. A layer needing a tenth error class should request it here rather than defining one locally.

### Exported surface of `src/domain/state-machine.ts`

```ts
export type Trigger =
  | 'claim' | 'worktree_ready' | 'spawned' | 'needs_input' | 'answered'
  | 'timed_out' | 'agent_complete' | 'delivered' | 'delivered_partial'
  | 'cancel' | 'error' | 'requeue';

export function nextState(from: RunState, t: Trigger): RunState | null;
export function assertTransition(from: RunState, t: Trigger): RunState;  // throws IllegalTransitionError
export function holdsSlot(s: RunState): boolean;
export function hasLiveChild(s: RunState): boolean;
export function isTerminal(s: RunState): boolean;
export function acceptsCancel(s: RunState): boolean;      // true for every non-terminal state
export function cancelIsDeferred(s: RunState): boolean;   // true for exactly running and delivering
export function deriveParentState(children: readonly RunState[]): RunState;
```

The transition table itself is **not exported** — `nextState` is its only reader. A layer wanting to enumerate transitions should request an accessor rather than re-deriving one.

### `delivered_partial` is an addition to ARCHITECTURE.md's eleven triggers

ARCHITECTURE.md's `Trigger` union has eleven members and predates the `partial` state. `delivered_partial` (from `delivering` to `partial`) is the twelfth and the only addition. Its eleven siblings are transcribed verbatim and unrenamed.

### Two mechanical rewrites sibling phases may need at the gate

1. **NodeNext requires a `.js` extension on every relative import inside `src/`.** Any sibling phase that wrote extensionless relative specifiers needs a mechanical rewrite. See also T32 — the extension is correct for `tsc`, but the `node --test` half of the gate needs Phase 7's fix.
2. **`erasableSyntaxOnly` is on.** Any sibling phase that used a TypeScript `enum`, a `namespace`, or a constructor parameter property (`constructor(private readonly x: T)`) will fail `tsc --noEmit` and needs the same mechanical rewrite.

### Package set notes

- `@types/better-sqlite3@^9` **was added here** (Rule 2, T33). No sibling phase should add it again.
- `@types/node` is at `^22`, not STACK.md's table value of `^24`, per this plan's explicit instruction and T15 (this machine runs Node v22.23.1). If Phase 8's preflight ends up hard-failing on <24, bump it at the gate.
- **No other package may be added on a phase branch.** Phases 2-8 have no `package.json`; anything missing belongs in their own `Contract additions requested`.

## User Setup Required

None — no external service configuration required by this plan.

## Known Stubs

None. Every export in this plan is fully implemented; nothing returns a placeholder value.

## Threat Flags

None. This plan produces pure, I/O-free modules — no network, no filesystem, no child processes, and no untrusted input crosses any boundary it creates. The one trust boundary it does touch (npm registry → repository) is handled by transcribing every pin from STACK.md unchanged and adding no package name STACK.md does not list.

## Self-Check: PASSED

- All 8 declared artifacts exist on disk.
- All 5 commit hashes resolve in `git log`.
- No file deletions in any of the plan's commits.
- All 9 of the plan's automated verification steps re-run and pass.
- Plan-level verification: `verify` string byte-identical to D-13; no package name outside STACK.md; no stale state name (`claimed`, `agent_running`, `done`, `abandoned`) anywhere in `src/`; `src/domain/` imports only its own siblings plus `node:test`/`node:assert`; every relative import carries `.js`.

**STATE.md / ROADMAP.md were deliberately not modified.** Eight phases are executing in parallel worktrees off the same base commit; eight branches each rewriting `STATE.md` produces a guaranteed conflict on every merge for no gain. The `/auto-run-gsd` orchestrator owns milestone state in a fan-out run. (`gsd-tools` is also not present in this checkout.)
