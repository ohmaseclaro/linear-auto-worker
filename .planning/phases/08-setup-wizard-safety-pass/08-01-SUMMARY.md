---
phase: 08-setup-wizard-safety-pass
plan: 01
subsystem: infra
tags: [cli, node-util-parseargs, execa, wizard, preflight, node-test]

# Dependency graph
requires: []
provides:
  - "law setup|start|status CLI entry point via node:util parseArgs"
  - "runSetupWizard() orchestrator (preflight-only in this plan)"
  - "runPreflight(): 6 checks — Node, git identity, gh auth, claude on PATH, GSD install, resource headroom"
  - "discoverRepos(rootDir): depth-2 .git scan primitive for repo mapping"
affects: [08-02, 08-03, 08-04, 08-05]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "PreflightResult { name, status: pass|warn|fail, detail, fix? } — every failure path returns this shape, never throws"
    - "execa for all subprocess calls (argv-array safety, no child_process)"
    - "node:test + mock.method for stubbing execa in unit tests, written but not run under rush mode"

key-files:
  created:
    - src/cli/index.ts
    - src/cli/wizard/index.ts
    - src/cli/wizard/preflight.ts
    - src/cli/wizard/preflight.test.ts
    - src/cli/wizard/repo-discovery.ts
    - src/cli/wizard/repo-discovery.test.ts
  modified: []

key-decisions:
  - "runPreflight() became async in Task 2 (git/gh/claude/GSD/headroom checks all shell out via execa); index.ts's runSetupWizard() awaits it — a natural extension of Task 1's sync single-check signature, not a plan deviation, since Task 1 explicitly scoped runPreflight() to 'the latter calls the former only, in this task'"

patterns-established:
  - "Actionable-fix-never-a-stack-trace: every preflight check function catches its own execa/fs error internally and returns a PreflightResult with a fix string"

requirements-completed: [SETUP-01]

coverage:
  - id: D1
    description: "law setup CLI entry parses setup|start|status via node:util parseArgs, no new CLI dependency"
    requirement: "SETUP-01"
    verification:
      - kind: unit
        ref: "grep-based structural check (RUSH MODE — no node_modules to execute against): parseArgs present in src/cli/index.ts"
        status: pass
    human_judgment: true
    rationale: "Cannot execute `node src/cli/index.ts setup` end to end until the milestone-end integration gate installs dependencies; structural verification only at this stage."
  - id: D2
    description: "6 preflight checks (Node, git identity, gh auth, claude on PATH, GSD install, resource headroom) each return pass/warn/fail plus an actionable fix, never a stack trace"
    requirement: "SETUP-01"
    verification:
      - kind: unit
        ref: "src/cli/wizard/preflight.test.ts (13 tests, written complete, not run per RUSH MODE)"
        status: unknown
    human_judgment: true
    rationale: "Test file cannot be run in this worktree (no package.json/node_modules on this branch per rush-mode fan-out); status becomes determinate only at the milestone integration gate."
  - id: D3
    description: "discoverRepos() depth-2 .git scan skips node_modules/dotdirs/symlinks and degrades per-entry on error"
    requirement: "SETUP-01"
    verification:
      - kind: unit
        ref: "src/cli/wizard/repo-discovery.test.ts (4 tests against a real temp fixture tree, written complete, not run per RUSH MODE)"
        status: unknown
    human_judgment: true
    rationale: "Test file cannot be run in this worktree (no node_modules on this branch); status becomes determinate only at the milestone integration gate."

duration: 25min
completed: 2026-09-06
status: complete
---

# Phase 8 Plan 1: CLI Entry, Preflight, and Repo Discovery Summary

**`law setup|start|status` CLI via node:util parseArgs, a 6-check toolchain preflight (Node/git/gh/claude/GSD/RAM) that never surfaces a raw error, and a depth-2 `.git` scanner for later interactive repo mapping**

## Performance

- **Duration:** ~25 min
- **Completed:** 2026-09-06
- **Tasks:** 3
- **Files modified:** 6 (all created)

## Accomplishments
- `law setup` end-to-end tracer: CLI argv parsing → `runSetupWizard()` orchestrator → real `checkNodeVersion()` result, printed with ✓/⚠/✗ and a `fix` line, exit code reflects any hard failure
- Full D-08 preflight suite: git identity, `gh auth status` (+ `workflow` scope probe per Pitfall 12), `claude --version` on PATH, global GSD install (`~/.claude/skills` or `~/.claude/gsd-core`), and an informational RAM/ulimit-derived concurrency suggestion — every check catches its own execa error and returns an actionable fix, never a stack trace
- `discoverRepos()`: depth-2 `.git` scan of one operator-named directory, stops descending once a repo is found, skips `node_modules`/dotfiles/symlinked directories, and degrades per-entry (unreadable directory) rather than aborting the whole scan — satisfies threats T-08-01 (DoS via unbounded traversal) and T-08-02 (tampering via one adversarial entry)

## Task Commits

Each task was committed atomically with `git commit -n` per RUSH MODE:

1. **Task 1: `law setup` end to end — CLI entry, orchestrator, one real preflight check** - `3ea8d1f` (feat)
2. **Task 2: Full toolchain preflight — git, gh, claude, GSD install, RAM/ulimit** - `9c33e29` (test+feat, single commit — see Deviations)
3. **Task 3: Local repo discovery — depth-2 `.git` scan** - `0eef1ef` (test+feat, single commit — see Deviations)

_Note: TDD tasks 2 and 3 combined their test and implementation commits (see Deviations from Plan) because RUSH MODE forbids running `node --test` on this branch (no `package.json`/`node_modules` exist yet) — there is no way to observe a genuine RED failure before writing GREEN, so splitting into separate unverified commits would not add information._

## Files Created/Modified
- `src/cli/index.ts` - `law setup|start|status` argv parsing via `node:util.parseArgs`; `setup` invokes the wizard and exits with its return code
- `src/cli/wizard/index.ts` - `runSetupWizard()` orchestrator; runs preflight, prints results, returns 1 on any hard fail
- `src/cli/wizard/preflight.ts` - `PreflightResult`/`PreflightStatus` types plus 6 check functions and `runPreflight()`
- `src/cli/wizard/preflight.test.ts` - 13 `node:test` cases covering all 6 checks (execa mocked via `mock.method`) plus `runPreflight()`'s shape; written complete, not run (RUSH MODE)
- `src/cli/wizard/repo-discovery.ts` - `DiscoveredRepo` type and `discoverRepos(rootDir)` depth-2 scanner
- `src/cli/wizard/repo-discovery.test.ts` - 4 `node:test` cases against a real temp fixture tree (depth 0/1/2/3-cap, node_modules/dotdir skip, symlink loop, unreadable dir); written complete, not run (RUSH MODE)

## Decisions Made
- `runPreflight()`'s return type moved from Task 1's sync `PreflightResult[]` to async `Promise<PreflightResult[]>` when Task 2 added execa-backed checks. This is the natural, plan-anticipated extension ("Task 2 adds the rest to the same array") rather than a deviation — `runSetupWizard()` was updated to `await` it in the same commit.
- Task 2 and Task 3's TDD test/implementation commits were combined into one commit each rather than split into separate RED/GREEN commits, because RUSH MODE explicitly forbids executing `node --test` on this branch — there is no real RED signal to record. This is documented under Deviations below rather than silently deviating from the `tdd_execution` protocol.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking, process-level] Combined RED/GREEN commits for TDD tasks under RUSH MODE**
- **Found during:** Task 2 and Task 3
- **Issue:** The standard TDD executor protocol requires a `test(...)` commit demonstrating a failing RED state, verified by actually running the test, before a `feat(...)` GREEN commit. RUSH MODE (this milestone's binding run constraint) forbids running `node --test` on this branch — no `package.json`/`node_modules` exist, and the plan's own text says explicitly: "do not run this test file (RUSH MODE)... write it complete and correct."
- **Fix:** Wrote each task's test file and implementation together, committed as a single `test(...)+feat(...)`-titled commit per task, since no genuine RED observation was possible to gate on.
- **Files modified:** `src/cli/wizard/preflight.ts`, `src/cli/wizard/preflight.test.ts`, `src/cli/wizard/repo-discovery.ts`, `src/cli/wizard/repo-discovery.test.ts`
- **Verification:** Plan's own structural `<verify>` grep checks (function names present, `mock.method`/`mkdtemp` present, test count thresholds met) — all passed for both tasks.
- **Committed in:** `9c33e29` (Task 2), `0eef1ef` (Task 3)

---

**Total deviations:** 1 auto-fixed (process-level, Rule 3 — RUSH MODE test-execution constraint)
**Impact on plan:** No scope or correctness change. Test files are complete and will run at the milestone-end integration gate exactly as the plan specifies.

## Issues Encountered
None.

## Contract additions requested

None. This plan does not import from `src/domain/` — preflight and repo discovery are pure infrastructure with no dependency on the domain contract, as noted in the plan's own `<context>` section.

## User Setup Required
None - no external service configuration required in this plan.

## Next Phase Readiness
- `runSetupWizard()` is ready for 08-02/08-03 to extend with secrets prompting and the interactive repo-mapping checklist built on `discoverRepos()`.
- `discoverRepos()`'s `DiscoveredRepo { path, name }` shape is the primitive 08-03's checklist UI will consume directly.
- No blockers. All verification in this plan is structural per RUSH MODE; full behavioral verification (both `.test.ts` files, plus the `node src/cli/index.ts setup` live run) happens at the milestone-end integration gate once dependencies are installed.

## Self-Check: PASSED

All 6 created files confirmed present on disk; all 3 task commit hashes (`3ea8d1f`, `9c33e29`, `0eef1ef`) confirmed in `git log --oneline --all`.

---
*Phase: 08-setup-wizard-safety-pass*
*Completed: 2026-09-06*
