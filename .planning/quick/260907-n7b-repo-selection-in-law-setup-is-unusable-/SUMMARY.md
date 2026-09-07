---
task: n7b — repo selection in `law setup` is unusable at scale
type: quick
status: complete
gate: npm run verify — green (560 tests, 0 fail, smoke passed)
commits:
  - 1e2aea0 refactor(wizard): route mapping output through an injected report sink
  - 9949ceb feat(wizard): filter step in front of repo selection for large roots
files_modified:
  - src/cli/wizard/mapping.ts
  - src/cli/wizard/mapping.test.ts
---

# Summary

`promptRepoSelection` now puts a filter loop in front of the checkbox when the discovered
set is larger than 20. Below the threshold nothing changed at all. `deps.ts`, `index.ts`,
`discoverRepos` and the `WizardPrompts` interface were not touched — the flow composes the
`input` and `checkbox` that were already there.

## Falsification results (measured, not asserted)

Baseline before any change: **553 tests, 553 pass, 0 fail**.

### Task 1 — the report sink

| Break applied | Expected red | Measured |
|---|---|---|
| deleted the `for` loop that calls `printRepoTrustDisclosure` | disclosure case | `not ok 8` — 9 tests, 8 pass, **1 fail** |
| `printExistingMapping` writes to `console.log` instead of `report` | sink case | `not ok 9` — 9 tests, 8 pass, **1 fail** |

Restored: 9/9 green. The second break was not named in the plan; I ran it because the
instruction was to falsify *every* new check, and a sink assertion that has never gone red
does not prove the output stopped going to stdout.

### Task 2 — the filter loop

All four breaks the plan names, applied one at a time against the 14-case file:

| Break | Plan predicted | Measured |
|---|---|---|
| (a) `matches = remaining` — no filtering | case 2 red | `not ok 11, 12, 13` — 11 pass, **3 fail** |
| (b) zero matches falls through to the full list | case 3 red | `not ok 12` — 13 pass, **1 fail** |
| (c) drop the `remaining` exclusion | case 4 red | `not ok 13` — 13 pass, **1 fail** |
| (d) threshold set to 0 | case 1 red | `not ok 2, 3, 5, 6, 7, 8, 10` — 7 pass, **7 fail** |

Restored between each: 14/14 green.

Two of the four are wider than predicted, both correctly. (a) also reddens the zero-match
and exclusion cases because an unfiltered pool changes what those passes offer too. (d)
reddens six pre-existing cases as well as the new small-set case — every case whose fixture
is the 2-repo `DISCOVERED` set suddenly hits the filter loop and rejects on an unqueued
`input()`. That is the small-set regression guard working from more directions than the
plan claimed, not a miscount.

Every break was a real edit to `mapping.ts`, rebuilt through `tsc` and re-run — no case in
this file has gone green without also having been shown to go red.

## Where the plan mispredicted the real code

**1. Case 1's "leave the `input` queue empty" is impossible on the path the plan assumed.**
The plan wanted a fresh-add `buildMappings` run with no `input` queued, so that a stray
filter prompt would reject. But `promptSlackAndToggles` calls `p.input()` for the Slack
webhook URL on every fresh add, so that queue can never be empty — it would reject on the
Slack prompt regardless and prove nothing.

Fix: cases 1–5 drive the **re-run `edit repos`** action instead. It calls the same
`promptRepoSelection`, and nothing else on that path consumes `input` or `checkbox`, so an
empty queue really does mean "any call here is a bug". Case 1 leaves `input` empty and case
5 leaves `checkbox` empty, exactly as intended. This is a strictly better seam than the
plan's, and it needed no production change.

**2. Case 4's `alpha` then `beta` terms would have made its own key assertion vacuous.**
The plan asks for terms `alpha` then `beta`, then asserts `seen.checkbox[1].choices` does
not contain `alphaPath`. But a `beta` term never offers an alpha path in the first place —
the assertion would pass identically with the `remaining` exclusion deleted, i.e. it would
have been a check that cannot fail.

Fix: case 4 uses `alpha` twice. Pass 2 offers 9 choices instead of 10 and excludes the one
already picked. Verified load-bearing by break (c) above, which reddens it.

**3. `pageSize: 7` and the `a`/`i` keybindings both check out.** Read directly from
`node_modules/@inquirer/checkbox/dist/index.js`: `pageSize = 7`, `{ all: 'a', invert: 'i' }`.
Select-all inside a match set is free, no code.

## Deliberate additions beyond the plan

The four pre-existing re-run/toggle cases in `mapping.test.ts` were still triggering
`console.log` through the disclosure and `printExistingMapping`. Task 1 made a sink
available; leaving those cases leaking would have kept the exact stdout-during-`node --test`
hazard the task exists to remove. All six `buildMappings` call sites in the file now pass a
sink. No assertion was changed.

## Not done, per the plan

Fuzzy/regex matching, a match-set cap, de-select on a later pass, `checked:` defaults,
`discoverRepos` changes, `deps.ts` changes, a `search`-based flow, doc updates.

The match-set ceiling is marked in the source with a `ponytail:` comment: a term matching
100 repos still renders 100 choices and the operator narrows again.

## Known trade-off (documented, not a stub)

A repo selected on an earlier filter pass cannot be de-selected on a later one — it has left
the candidate pool. The operator takes one back off by re-running the mapping's `edit repos`
action, which starts from an empty selection. Adding `checked:` defaults would mean widening
`WizardPrompts`, which would break the `scripted()` harness's seven existing cases for no
functional gain.

## Gate

`npm run verify` — clean → `tsc` → assets → `node --test dist/**/*.test.js` → boot smoke.

```
# tests 560
# suites 20
# pass 560
# fail 0
# skipped 0
# todo 0
SMOKE PASSED
```

553 → 560: seven new cases (2 in task 1, 5 in task 2). No test was weakened, skipped or
deleted. No new dependency. Every seam is a default parameter — no `mock.method` on an ESM
namespace (T88).
