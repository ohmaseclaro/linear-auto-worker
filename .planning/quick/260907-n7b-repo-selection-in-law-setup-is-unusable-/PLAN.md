---
task: n7b — repo selection in `law setup` is unusable at scale
type: quick
files_modified:
  - src/cli/wizard/mapping.ts
  - src/cli/wizard/mapping.test.ts
gate: npm run verify
---

# Filter step for repo selection

`promptRepoSelection` renders every `DiscoveredRepo` in one `checkbox`. `~/ohmaseclaro`
discovers 277 repos; inquirer's checkbox `pageSize` defaults to **7**, so picking 4 of 277
is ~40 pages of arrowing. Add a filter loop in front of the checkbox for large sets.

Scope: one function (`promptRepoSelection`) plus the sink seam it needs. Nothing else.

## Decisions

**D1 — No new prompt type, no new dependency.** The flow composes `input` + `checkbox`,
both already on `WizardPrompts`. `deps.ts` is **not touched**, so the `scripted()` harness
and its seven existing cases keep working unchanged. (`@inquirer/prompts@8.7.1` has no
searchable multi-select; its `search` is single-select and would need adding to the
interface for no gain.)

**D2 — Threshold: 20. Below it, nothing changes.** `discovered.length <= 20` takes the
existing single-checkbox path verbatim. 20 ≈ 3 pages at `pageSize: 7` — about the point
where arrowing costs more than typing a term. Measured roots: `~/law-uat-sandbox` = 1 and
the existing test fixture = 2 (unfiltered, unchanged); `~` = 122 and `~/ohmaseclaro` = 277
(filtered). Constant stays module-private; tests pick counts either side of it.

**D3 — Match on name AND path, case-insensitive substring.** `t = term.trim().toLowerCase()`,
match `r.name.toLowerCase().includes(t) || r.path.toLowerCase().includes(t)`. Path matching
is what makes a depth-2 result (`~/work/acme/api`) reachable by its intermediate directory.
No regex (operator-supplied patterns are a footgun), no fuzzy matching (unpredictable
ordering on a security-relevant pick list).

**D4 — Interaction shape** (large sets only):

1. Prompt `input`: `Filter <N> repos by name or path (blank when done) — <k> selected: a, b`.
2. **Blank / whitespace-only term → finish.** Returns what has accumulated so far,
   possibly `[]`. `[]` is already valid (`printExistingMapping` renders `repos: (none)`)
   and is the operator's escape hatch out of the loop.
3. **Zero matches → report `no repo matches "<term>"` and re-prompt.** Never fall back to
   offering the full list — that is the defect.
4. Matches → `checkbox` over **only** the matches. **Select-all is free**: inquirer's
   checkbox binds `a` to toggle-all and `i` to invert (verified in
   `node_modules/@inquirer/checkbox/dist/index.js`: `{ all: 'a', invert: 'i' }`). No code.
5. Picked paths are added to an insertion-ordered `Set`; each newly added repo fires
   `printRepoTrustDisclosure` exactly once. Loop back to 1.
6. **Already-selected repos are removed from the candidate pool** on later passes and
   surfaced by name in the filter prompt's message (step 1). Loop header is
   `while (remaining.length > 0)`, so exhausting the pool ends the loop on its own.
   Trade-off: a repo cannot be *de*selected on a later pass — the operator re-runs the
   mapping's `edit repos` action for that. Adding `checked:` to the choices would require
   widening `WizardPrompts`; not worth it.

Return `Array.from(selected)` — deterministic, insertion-ordered.

**D5 — No cap on match-set size.** A term matching 100 repos still renders 100 choices;
the operator narrows again. Leave a `ponytail:` comment naming the ceiling.

**D6 — `discoverRepos` is not touched.** The depth-2 cap and symlink skip are a DoS /
traversal boundary (T-08-01). 277 results is a correct scan of a directory with 277 repos;
the defect is entirely in presentation.

## Task 1 — route library output through an injected `report` sink

**Files:** `src/cli/wizard/mapping.ts`, `src/cli/wizard/mapping.test.ts`

`printRepoTrustDisclosure` and `printExistingMapping` write to `console.log` today, and
`mapping.test.ts` already triggers both — this is the exact stdout that desynchronises
Node 22's parent-side V8 frame parser (documented at the top of `repo-safety.test.ts`:
1/20 corrupted with the warning printed, 0/80 with it silenced). Task 2 also needs a sink
for its "no matches" line, so this lands first.

Follow the `repo-safety.ts` precedent exactly: a `report: (message: string) => void`
parameter defaulting to `(message) => console.log(message)`. Thread it as a **5th
positional parameter** on `buildMappings` and through `promptOneMapping`,
`reviewExistingMapping`, `promptRepoSelection`, `printRepoTrustDisclosure`,
`printExistingMapping`. Positional (not a deps object) so the `index.ts:140` call site and
all seven existing test cases stay byte-identical; `index.ts` keeps the console default,
where the terminal genuinely is the interface.

Extend the test harness in the same commit: `scripted(script, seen?)` where the optional
`seen` collector records each prompt config (`seen.checkbox.push(config)` etc.). Backwards
compatible — existing cases pass one argument. Task 2 needs `seen` to assert *what was
offered*, not just what came back.

**Assertions**
- `disclosure is reported once per newly selected repo` — select both fixture repos, assert
  the captured array has exactly 2 disclosure lines, one per path, each containing `--bare`.
  This is the first test of T-08-21 / Pitfall 10 that can exist at all; it was unreachable
  while the text went to `console`.
- `re-run review prints the existing mapping through the sink` — `keep as-is` case captures
  the `Project One` / `repos:` lines instead of leaking them to stdout.

**Falsify before trusting (T71):** delete the `for` loop body in `promptRepoSelection` that
calls the disclosure and confirm case 1 goes red; restore. A disclosure assertion that has
never gone red does not guard a security disclosure.

## Task 2 — filter loop in `promptRepoSelection`

**Files:** `src/cli/wizard/mapping.ts`, `src/cli/wizard/mapping.test.ts`

Implement D2–D5 inside `promptRepoSelection`. Nothing outside this function changes;
`edit repos` on a re-run gets the filter for free because it calls the same function.

**Assertions** (all in `mapping.test.ts`; fixture = 30 synthetic repos where noted)

| # | Case | Asserts | Goes red against |
|---|------|---------|------------------|
| 1 | 2 discovered repos (existing fixture) | exactly one `checkbox`, `input` queue left **empty** so any `input()` call rejects | threshold set to 0 / filter applied unconditionally — small-set regression |
| 2 | 30 repos, term `ALPHA` | `seen.checkbox[0].choices` values equal exactly the matching paths | filter not applied (all 30 offered); case-sensitive matching |
| 3 | 30 repos, terms `zzz` then `alpha` then blank | report captured a `no repo matches "zzz"` line; `seen.checkbox.length === 1` | zero matches falling through to the full list, or throwing |
| 4 | 30 repos, terms `alpha` then `beta` then blank | result is `[alphaPath, betaPath]` in order; `seen.checkbox[1].choices` does **not** contain `alphaPath`; report holds one disclosure line per accumulated repo | already-selected not excluded on pass 2; disclosure skipped on the new branch (T-08-21 regression); blank not terminating |
| 5 | 30 repos, first term blank | returns `[]`, `checkbox` queue empty so any `checkbox()` call rejects | no escape hatch / forced selection |

**Falsify before trusting (T71/T76):** break each of the four load-bearing behaviours once
and watch the named case go red, then restore — (a) return `discovered` unfiltered → case 2
red; (b) offer the full list on zero matches → case 3 red; (c) drop the `remaining`
exclusion → case 4 red; (d) set the threshold to 0 → case 1 red. These are behavioural
assertions on offered choices, not greps over prose (T76).

## Gate

`npm run verify` green (clean → `tsc` → assets → `node --test dist/**/*.test.js` → smoke).
No new dependency, no `mock.method` on an ESM namespace (T88) — every seam is a default
parameter.

## Not doing

- Fuzzy/regex matching, a match-set cap, deselect-on-later-pass, `checked:` defaults.
- `discoverRepos` changes, `deps.ts` changes, a `search`-based flow.
- Doc updates: no doc in `docs/` or `README.md` describes this prompt sequence.
