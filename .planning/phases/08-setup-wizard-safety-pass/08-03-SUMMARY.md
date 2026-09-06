---
phase: 08-setup-wizard-safety-pass
plan: 03
subsystem: infra
tags: [cli, wizard, mapping, linear-sdk, inquirer, node-test]

# Dependency graph
requires:
  - phase: 08-01
    provides: "discoverRepos() -> DiscoveredRepo[], the repo checklist source"
  - phase: 08-02
    provides: "acquireLinearKey()'s returned, already admin-validated LinearClient"
provides:
  - "listMappingCandidates(linearClient) -> paginated {teams, projects} for the checklist"
  - "buildMappings(linearClient, discovered, existing?) -> Mapping[] via interactive
    checklist + select prompts, reusable for first-run and re-run (D-04)"
  - "Mapping / MappingKey / ToggleName / ToggleOverrides local types (not yet in
    src/domain/ — see Contract additions requested)"
affects: [08-04, 08-05]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Explicit after-cursor pagination, never connection.fetchNext() (T22) — every SDK
      connection call in this module pages to completion before returning"
    - "promptOneMapping() as the single prompt sequence shared by fresh-add and re-run-edit
      paths, so the two never drift apart (the plan's own stated risk)"
    - "Sparse override: an unselected toggle produces no key at all in the returned object,
      never an empty-valued one"

key-files:
  created:
    - src/cli/wizard/mapping.ts
    - src/cli/wizard/mapping.test.ts
  modified: []

key-decisions:
  - "Mapping / MappingKey / ToggleName / ToggleOverrides are defined locally in mapping.ts,
    not in src/domain/types.ts — Phase 1 has not landed a Mapping export under RUSH MODE's
    simultaneous fan-out. Per the plan's own instruction, the exact shape used here is
    recorded below for 08-05 and Phase 1's owner to reconcile at the integration gate."
  - "The six CONF-02 toggle names chosen: linearComments, slackNotifications, baseBranch,
    draftPr, questionTimeoutMs, maxRunTimeMs. questionTimeoutMs and baseBranch match the two
    names 06-01 already requested on Config.defaults (01-CONTEXT.md ADDENDUM); the other
    four are this plan's best-fit names for D-09's prose list (\"Linear comments, Slack,
    base branch, draft vs ready PR, question flow, max run time\") — also recorded below."
  - "A project's `teams()` connection is paged and only its FIRST team is taken as the
    mapping's teamId, to match the plan's flat {id, name, teamId} ProjectCandidate shape.
    No node_modules exist on this branch to confirm the real @linear/sdk v93 Project shape
    (single team field vs. multi-team connection) — flagged for the integration gate."
  - "repos on a Mapping are plain repo path strings (DiscoveredRepo.path), not
    DiscoveredRepo objects — 08-04's repo-safety pass and 08-05's Config assembly both need
    only the path to run git checks / build worktrees against."

patterns-established:
  - "Every @linear/sdk connection this module reads is paged via an explicit after-cursor
    loop (pageAll), matching src/outbound/linear-client.ts's own established pattern —
    never connection.fetchNext()."

requirements-completed: [SETUP-05, SETUP-06]

coverage:
  - id: D1
    description: "listMappingCandidates pages teams()/projects() past the 50-item connection default"
    requirement: "SETUP-05"
    verification:
      - kind: unit
        ref: "mapping.test.ts — 'pages teams/projects past the 50-item connection default (Pitfall 11)' (62-team fixture; written complete, not run per RUSH MODE)"
        status: unknown
    human_judgment: true
    rationale: "No node_modules on this branch under rush-mode fan-out; determinate only at the milestone integration gate."
  - id: D2
    description: "buildMappings() builds a mapping purely from listed picks — no hand-typed path, no hand-edited JSON"
    requirement: "SETUP-05"
    verification:
      - kind: unit
        ref: "mapping.test.ts — 'builds one mapping and stops' + 'builds two mappings' (written complete, not run per RUSH MODE)"
        status: unknown
    human_judgment: true
    rationale: "Prompts are stubbed via mock.method; a live terminal run belongs on the HUMAN-UAT checklist."
  - id: D3
    description: "Slack URL and toggle overrides are captured optionally and sparsely"
    requirement: "SETUP-06"
    verification:
      - kind: unit
        ref: "mapping.test.ts — 'no override keys at all' + 'selecting exactly one toggle overrides only that key' (written complete, not run per RUSH MODE)"
        status: unknown
    human_judgment: false
  - id: D4
    description: "Re-running with existing mappings edits in place; 'keep as-is' is byte-identical"
    requirement: "SETUP-06"
    verification:
      - kind: unit
        ref: "mapping.test.ts — 're-run \"keep as-is\" leaves an existing mapping byte-identical' + 're-run \"edit repos\" changes only that mapping's repos' (written complete, not run per RUSH MODE)"
        status: unknown
    human_judgment: false

duration: 35min
completed: 2026-09-06
status: complete
---

# Phase 8 Plan 3: Interactive Project-to-Repo Mapping Summary

**`buildMappings()` turns Linear teams/projects and discovered local repos into an interactive checklist — project-keyed with a team-level fallback, sparse Slack/toggle overrides, and re-run edit-in-place — with the no-trust-prompt repo disclosure printed on every newly-mapped repo**

## Performance

- **Duration:** ~35 min
- **Completed:** 2026-09-06
- **Tasks:** 2
- **Files modified:** 2 (both created)

## Accomplishments

- `listMappingCandidates()`: pages Linear's `teams()`/`projects()` connections to completion
  via explicit `after` cursors (never `fetchNext()` — T22), so a workspace with more than 50
  teams or projects is never silently truncated (Pitfall 11). Requests only `id`/`name`/
  `teamId`, never full SDK objects.
- `buildMappings()`: the whole reason SETUP-05 exists — the operator picks a project (or,
  via the explicit "no project" choice, a team — D-07's fallback so an issue filed directly
  onto a team is never silently dropped) and checkbox-selects which discovered local repos
  attach to it. No path is ever typed, no JSON is ever hand-edited.
- Every newly-selected repo prints the no-trust-prompt accepted-risk disclosure (PITFALLS.md
  Pitfall 10 item 3 / threat T-08-21) immediately after selection — once per repo, as
  disclosure rather than a second confirm gate.
- Slack webhook URL and the six CONF-02 toggle overrides are captured per mapping, both
  optional: an empty Slack answer stores `undefined` (never `""`), and toggles the operator
  does not select are absent keys entirely (never empty-valued ones).
- `promptOneMapping()` factors the whole key/repos/Slack/toggle prompt sequence into one
  function shared by both the fresh-add loop and the re-run "edit" paths, so the two cannot
  drift apart — the plan's own stated risk of a second, slightly different copy.
- Re-running with `existing: Mapping[]` reviews each mapping (`keep as-is | edit repos | edit
  Slack/toggles | remove`); "keep as-is" returns the exact same object reference untouched
  (threat T-08-10 — no code path can partially mutate a mapping the operator did not choose
  to edit), and a re-displayed Slack URL is masked to host-only (threat T-08-09). After
  reviewing all existing mappings the operator can still add brand-new ones through the same
  "Add another mapping?" prompt.

## Task Commits

Each task committed atomically with `git commit -n` per RUSH MODE:

1. **Task 1 (tracer): list teams/projects + discovered repos into one interactive checklist** — `6222983` (feat)
2. **Task 2: multi-mapping loop, Slack + toggle capture, re-run-in-place editing** — `64eb20a` (feat+test, single commit — see Deviations)

_Note: Task 2 is `tdd="true"` in the plan but its test file could not be run to observe a
genuine RED failure — RUSH MODE forbids `node --test` on this branch (no `package.json`/
`node_modules` exist). Test and implementation were written together and committed as one
`feat+test` commit, matching the precedent already set by 08-01's plan (see its SUMMARY,
"Deviations from Plan")._

## Files Created/Modified

- `src/cli/wizard/mapping.ts` (383 lines) — `listMappingCandidates()`, `buildMappings()`,
  `Mapping`/`MappingKey`/`ToggleName`/`ToggleOverrides` types, `TOGGLE_NAMES` const, and all
  private prompt helpers (`promptMappingKey`, `promptRepoSelection`, `promptSlackAndToggles`,
  `promptToggleOverrides`, `promptOneMapping`, `reviewExistingMapping`, `maskSlackUrl`,
  `printExistingMapping`, `printRepoTrustDisclosure`, `pageAll`)
- `src/cli/wizard/mapping.test.ts` (233 lines) — 7 `node:test` cases: connection pagination,
  fresh single-mapping build, fresh multi-mapping build, re-run keep-as-is, re-run edit-repos,
  sparse-toggle (none selected), sparse-toggle (one selected); `@inquirer/prompts` exports
  stubbed via `mock.method`, matching the pattern `preflight.test.ts` already established for
  `execa`. Written complete, not run (RUSH MODE).

## Decisions Made

- **`Mapping`/`MappingKey`/`ToggleName`/`ToggleOverrides` live in `mapping.ts`, not
  `src/domain/`.** Phase 1's ADDENDUM names `Config`'s `mappings` field in prose
  ("project- or team-keyed, each with `repos[]` and optional `slackWebhookUrl` and a sparse
  toggle override") but exports no `Mapping` type. Per the plan's own instruction this module
  defines the closest reasonable shape locally rather than inventing a competing `Config`
  export; the exact fields are recorded below under "Contract additions requested".
- **Toggle names:** `linearComments`, `slackNotifications`, `baseBranch`, `draftPr`,
  `questionTimeoutMs`, `maxRunTimeMs`. Two of these (`questionTimeoutMs`, `baseBranch`)
  are already-requested `Config.defaults` field names from 06-01's contract addition; the
  other four are this plan's best-fit names for D-09's six-item prose list and are
  correspondingly less certain — flagged for reconciliation.
- **A project's mapping `teamId` is its FIRST team**, read via a one-item `teams({first: 1})`
  page on the project node. The current Linear schema supports multi-team projects, and this
  plan cannot confirm the real `@linear/sdk` v93 `Project` shape (single scalar `team` vs. a
  paged `teams()` connection) without `node_modules` on this branch. Whichever it turns out
  to be, the fix is localized to `listMappingCandidates`'s project-mapping loop.
- **`repos: string[]`, not `DiscoveredRepo[]`.** 08-04 (repo safety pass) and 08-05 (Config
  assembly) both operate on repo paths, not the discovery metadata (`name` is only a display
  convenience during the checklist prompt).
- **`promptOneMapping()` factored out in Task 2** exactly as instructed, so the fresh-add and
  re-run-edit prompt sequences cannot diverge.

## Trap Compliance

| Trap / Pitfall | How this plan complies |
|------|------------------------|
| **T22** | `pageAll()` uses explicit `after` cursors; `fetchNext()` is never called anywhere in this module. |
| **Pitfall 11** | Both `teams()` and `projects()` are paged to completion; `listMappingCandidates` requests only `id`/`name`/`teamId`. |
| **Pitfall 10, item 3 / T-08-21** | `printRepoTrustDisclosure()` fires once per newly-selected repo, every time, stating the no-trust-prompt fact plainly rather than silently accepting the risk. |
| **T-08-09** | `maskSlackUrl()` reduces a re-displayed Slack webhook URL to `host/…` — never the full URL — on re-run. |
| **T-08-10** | "Keep as-is" returns the identical object reference; `reviewExistingMapping`'s other three branches only ever spread-and-override the one field the operator chose to edit. |

## Deviations from Plan

### Auto-fixed / process-level

**1. [Rule 3 — process-level, RUSH MODE] Combined test+implementation commit for Task 2**
- **Found during:** Task 2
- **Issue:** Task 2 is marked `tdd="true"`, which normally requires a failing-RED `test(...)`
  commit observed before the `feat(...)` GREEN commit. RUSH MODE forbids running
  `node --test` on this branch (no `package.json`/`node_modules` exist), so no genuine RED
  state could be observed.
- **Fix:** Wrote `mapping.test.ts` and the Task 2 extension to `mapping.ts` together,
  committed as one `feat(08-03): ...` commit. Matches the precedent already documented in
  08-01's SUMMARY for the identical constraint.
- **Files modified:** `src/cli/wizard/mapping.ts`, `src/cli/wizard/mapping.test.ts`
- **Committed in:** `64eb20a`

---

**Total deviations:** 1 auto-fixed (process-level, Rule 3 — RUSH MODE test-execution constraint), 0 bugs, 0 architectural.
**Impact on plan:** No scope or correctness change. The test file is complete and will run at the milestone-end integration gate exactly as the plan specifies.

## Issues Encountered

None blocking. One open question flagged above (project → team relation shape in the real
`@linear/sdk` v93 `.d.ts`) is isolated to a single loop and cannot be resolved without
`node_modules` on this branch.

## Contract additions requested

**1. `Mapping` / `MappingKey` / `ToggleName` / `ToggleOverrides` — candidates for `src/domain/types.ts`.**

The ADDENDUM fixes `Config.mappings` in prose but names no `Mapping` type. This plan defines,
locally in `src/cli/wizard/mapping.ts`:

```ts
export interface MappingKey {
  kind: 'project' | 'team';
  id: string;
  name: string;
}

export interface Mapping {
  key: MappingKey;
  repos: string[];              // local repo paths (DiscoveredRepo.path)
  slackWebhookUrl?: string;
  toggles?: ToggleOverrides;    // sparse override of the six CONF-02 toggles
}

export const TOGGLE_NAMES = [
  'linearComments',
  'slackNotifications',
  'baseBranch',
  'draftPr',
  'questionTimeoutMs',
  'maxRunTimeMs',
] as const;
export type ToggleName = (typeof TOGGLE_NAMES)[number];
export type ToggleOverrides = Partial<Record<ToggleName, boolean | string | number>>;
```

08-05 assembles a `Config.mappings` Record (keyed by project id, then team id, per 06-01's
contract addition) from a `Mapping[]` array like this one — 08-05's SUMMARY should record how
it bridges array → Record. Phase 1's owner should confirm the six toggle names above against
whatever it independently derives from D-09's prose list, and reconcile with the two names
(`questionTimeoutMs`, `baseBranch`) 06-01 already requested on `Config.defaults`.

**2. Confirm `@linear/sdk` v93's `Project` → team relation shape.**

This plan assumes `Project` exposes a paged `teams()` connection and takes the first team as
the mapping key's `teamId`. If the real SDK instead exposes a single scalar `team` (getter or
field), `listMappingCandidates`'s project-mapping loop needs a one-line change. Cannot be
confirmed without `node_modules` on this branch (RUSH MODE).

## User Setup Required

None — the operator is prompted interactively at wizard runtime, which is the feature.

## Next Phase Readiness

- 08-04 (repo safety pass) can take this plan's `Mapping[]` directly — `repos` is already a
  plain path array, exactly what `annotateRepoSafety()`'s git checks need.
- 08-05 (Config assembly) has `buildMappings()` ready to compose with `acquireLinearKey()`'s
  `linearClient` and `discoverRepos()`'s output; it still needs to decide how it converts this
  plan's `Mapping[]` into `Config.mappings`'s `Record` shape (see Contract additions requested
  #1).
- Blocker: none. All verification in this plan is structural per RUSH MODE; the 7-case suite
  runs at the milestone integration gate once dependencies are installed.

## Self-Check: PASSED

Both created files confirmed present on disk (`src/cli/wizard/mapping.ts`,
`src/cli/wizard/mapping.test.ts`). Both commit hashes (`6222983`, `64eb20a`) confirmed in
`git log --oneline --all`. All Task 1 and Task 2 structural `<verify>` greps re-run above and
passing.

---
*Phase: 08-setup-wizard-safety-pass*
*Completed: 2026-09-06*
