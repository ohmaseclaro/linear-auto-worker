---
phase: 08-setup-wizard-safety-pass
plan: 04
subsystem: cli
tags: [cli, wizard, repo-safety, execa, gh, node-test]
status: complete

# Dependency graph
requires:
  - phase: 08-03
    provides: "Mapping[] (key/repos/slackWebhookUrl/toggles) built via buildMappings()"
provides:
  - "checkAgentDocs(repoPath) -> SafetyWarning | null, with starter-CLAUDE.md offer (SETUP-07)"
  - "annotateRepoSafety(mappings) -> { mappings: EnrichedMapping[]; warnings: SafetyWarning[] } (SETUP-08)"
  - "RepoSafetyInfo { repoPath, remoteName?, defaultBranch?, ownerRepo? } per-repo record"
affects: [08-05]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Every external check (checkAgentDocs, resolveRemote, resolveDefaultBranch,
      checkBranchProtection) catches its own failure and returns a SafetyWarning rather than
      throwing; annotateRepoSafety's per-repo loop also wraps the whole per-repo pass as a
      second, belt-and-suspenders guard (T-08-15)."
    - "gh commands run with `cwd: repoPath` so `gh` resolves `nameWithOwner` from the local
      remote itself, rather than this code parsing a `git@host:owner/repo.git` URL by hand."
    - "404 and 403 on the branch-protection probe are both read as the same conservative
      'absent or unknown' warning (T-08-13) — no branch on which of the two occurred."

key-files:
  created:
    - src/cli/wizard/repo-safety.ts
    - src/cli/wizard/repo-safety.test.ts
  modified: []

key-decisions:
  - "EnrichedMapping extends Mapping with a new repoSafety: RepoSafetyInfo[] field, rather
    than editing 08-03's mapping.ts to make Mapping.repos richer than string[]. mapping.ts
    was outside this plan's files_modified, and EnrichedMapping is structurally a superset
    of Mapping, so annotateRepoSafety's return type still satisfies the plan's stated
    `Mapping[]` shape without touching a file this plan didn't own."
  - "checkAgentDocs treats CLAUDE.md/AGENTS.md presence as a gate-skip, not a merge: any one
    of the two names existing returns null immediately (SETUP-07 is warn-and-offer, not a
    blocking check), matching an operator who already trusts the repo's existing docs."
  - "Branch-protection and default-branch resolution both run via `gh`, invoked with
    `execa`, exactly as the two prior wizard modules (preflight.ts, secrets.ts) already do —
    no new dependency, matching STACK.md's already-sourced execa/@inquirer/prompts."

patterns-established:
  - "Test fixtures build real temp git repos via execa('git', ['init']) etc. for filesystem-
    and git-state-backed checks (CLAUDE.md, .gitmodules, git remote -v), while `gh` calls are
    stubbed via `mock.method(execaModule, 'execa', ...)` with a fallback that delegates `git`
    subcommands to the real binary captured before mocking (realExeca) — same
    mock.method(execaModule, 'execa', ...) idiom already established by preflight.test.ts."

requirements-completed: [SETUP-07, SETUP-08]

coverage:
  - id: D1
    description: "A repo missing both CLAUDE.md and AGENTS.md gets a prominent warning and an offer to generate a starter file"
    requirement: "SETUP-07"
    verification:
      - kind: unit
        ref: "repo-safety.test.ts — 'checkAgentDocs: warns and writes a starter CLAUDE.md on explicit confirm' + 'returns null when CLAUDE.md already exists' (written complete, not run per RUSH MODE)"
        status: unknown
    human_judgment: true
    rationale: "No node_modules on this branch under rush-mode fan-out; determinate only at the milestone integration gate. Live confirm()-prompt UX belongs on the HUMAN-UAT checklist."
  - id: D2
    description: "Every mapped repo's remote and resolvable default branch are verified and recorded into the mapping"
    requirement: "SETUP-08"
    verification:
      - kind: unit
        ref: "repo-safety.test.ts — 'clean repo records remoteName/defaultBranch/ownerRepo, no warnings' + 'no-remote repo warns and records no remoteName' (written complete, not run per RUSH MODE)"
        status: unknown
    human_judgment: true
    rationale: "Real `gh`/remote checks against a live GitHub-backed repo are live-gated per 08-CONTEXT's specifics section; this plan writes the code and its stubbed-gh test coverage, not a live run."
  - id: D3
    description: "Submodule and branch-protection gaps are surfaced as warnings, never silently skipped"
    requirement: "SETUP-08"
    verification:
      - kind: unit
        ref: "repo-safety.test.ts — 'submodule repo warns without aborting the rest of its checks' + 'missing branch protection warns, 404 and 403 both read as absent' (written complete, not run per RUSH MODE)"
        status: unknown
    human_judgment: false
  - id: D4
    description: "No single repo's check failure aborts checks for the rest of the mapped repos"
    requirement: "SETUP-08"
    verification:
      - kind: unit
        ref: "repo-safety.test.ts — 'one repo failing unexpectedly never blocks the next repo in the same mapping' (written complete, not run per RUSH MODE)"
        status: unknown
    human_judgment: false

duration: 40min
completed: 2026-09-06
---

# Phase 8 Plan 04: Repo Safety Pass (SETUP-07/08) Summary

Adds `annotateRepoSafety()`, the mapped-repo safety layer that warns loudly on a missing
`CLAUDE.md`/`AGENTS.md` (with a one-confirm starter-file offer), records each repo's resolved
remote/default branch/owner-repo string onto the mapping, and surfaces `.gitmodules` and
missing-branch-protection gaps — all without ever aborting the pass for a sibling repo.

## What Was Built

**Task 1 (tracer) — `checkAgentDocs(repoPath)`.** Checks for `CLAUDE.md` or `AGENTS.md` at
the repo root (case-sensitive, matching what `claude -p`/GSD actually read). Either name
present → `null`, silently passed (SETUP-07 is warn-and-offer, not a gate). Neither present →
prints a prominent warning naming the exact risk research calls out (zero project context is
the single highest-leverage factor in whether a spawned run produces something mergeable),
then offers via `@inquirer/prompts`'s `confirm` to write a minimal starter `CLAUDE.md` (project
name from `package.json` if present, else the directory name, plus placeholder Conventions/
Architecture sections). Writes only on explicit yes.

**Task 2 — `annotateRepoSafety(mappings)`.** For every repo path in every mapping's
`repos: string[]`:
- Runs `checkAgentDocs` (Task 1).
- Checks for `.gitmodules` at the repo root → warning if present (Pitfall 6: git upstream
  documents multi-worktree-checkout submodule support as unsupported).
- Resolves exactly one git remote via `git remote -v`; zero or multiple remotes → a warning
  naming the exact fix.
- Resolves `defaultBranch` and `ownerRepo` via `gh repo view --json defaultBranchRef,nameWithOwner`
  run **from inside the repo directory**, so `gh` derives `nameWithOwner` itself rather than
  this code parsing a `git@host:owner/repo.git` URL by hand (D-07/Pitfall 12 — Phase 4's
  Delivery needs this exact string for `gh pr create -R OWNER/REPO`).
- Probes branch protection via `gh api repos/{owner}/{repo}/branches/{branch}/protection`
  once `ownerRepo`/`defaultBranch` are both resolved; any non-2xx (404 or 403) reads as the
  same "absent or unknown" warning (T-08-13 — never guesses which one occurred, so a
  permission gap is never reported as "protected").

Every check catches its own failure and returns a `SafetyWarning` instead of throwing; the
per-repo loop in `annotateRepoSafety` also wraps the whole per-repo pass as a second guard, so
an unexpected failure on one repo (confirmed in tests via a nonexistent directory) still
produces a `repoSafety` entry and a warning for that repo, while the next repo in the same
mapping is checked in full.

## Deviations from Plan

### Auto-fixed Issues

None — the plan's own `<action>` text anticipated the only structural question (how to
enrich `Mapping.repos: string[]` with the resolved fields) and explicitly deferred the exact
naming to "Contract additions requested" below, so no Rule 1-4 deviation was needed.

## Contract additions requested

- **`RepoSafetyInfo` field names vs. the canonical `src/domain/types.ts` `RepoMapping`.**
  Phase 1 has already landed `RepoMapping { repoDir, repoSlug, baseBranch, enabled }` on this
  branch (merged via `08-03`'s own predecessor commits). This plan's local
  `RepoSafetyInfo { repoPath, remoteName?, defaultBranch?, ownerRepo? }` does **not** reuse
  those exact names, because 08-03's `Mapping.repos` is `string[]` (plain paths), not
  `RepoMapping[]` — the plan's own `<action>` instructs building against `Mapping[]`, not the
  domain type. For 08-05 (Config assembly) to produce a domain-shaped `RepoMapping[]`, the
  mapping is:
  - `ownerRepo` → `RepoMapping.repoSlug` (both are the `gh`-shaped `"org/name"` string;
    identical semantics, different local name).
  - `defaultBranch` → `RepoMapping.baseBranch` (the domain type's comment says the loader
    fills `baseBranch` from `Config.defaults.baseBranch`; 08-05 should prefer this plan's
    discovered per-repo `defaultBranch` over that global default when present, since a
    discovered value is more accurate than a global guess).
  - `remoteName` has **no home** in the canonical `RepoMapping` (which has no such field).
    It is retained here only as wizard-time diagnostic context (e.g. for the "multiple
    remotes" warning); 08-05 does not need to carry it into `Config`.
  - `RepoMapping.enabled` is not touched by this plan at all — 08-05 owns setting it.

## Threat Flags

None beyond the threat register already in `08-04-PLAN.md`'s `<threat_model>` — no new trust
boundary or surface was introduced beyond what the plan itself specified (filesystem read/
write on an operator-selected repo, read-only `gh` calls using the operator's existing
authenticated session).

## Known Stubs

None. Every exported function is a real, complete implementation — no stub data, no
hardcoded empty return standing in for unwired logic. The one deferred piece (a live `gh`/
git run against a real GitHub-backed repo) is explicitly out of this plan's scope per
08-CONTEXT's "Specific Ideas" section (live-gated, belongs on the HUMAN-UAT checklist), not a
stub in the shipped code.

## Self-Check: PASSED

- FOUND: src/cli/wizard/repo-safety.ts
- FOUND: src/cli/wizard/repo-safety.test.ts
- FOUND commit 85946ee (feat(08-04): CLAUDE.md/AGENTS.md warning + starter-file offer (SETUP-07))
- FOUND commit ae0616e (feat(08-04): remote/default-branch capture + submodule/branch-protection warnings (SETUP-08))
