---
task: Worktree base must be the remote-tracking ref, not the local branch
id: 260907-szl
type: quick
severity: P1
completed: 2026-09-07
status: complete
files_modified:
  - src/execution/worktree.ts
  - src/execution/worktree.test.ts
  - src/cli/adapters.worktree.test.ts
  - .planning/TRAPS.md
  - docs/TRAPS.md
commits:
  - acf02b2 test(worktree) falsify branching from the local base ref
  - 8891a3f fix(worktree) branch from the remote-tracking ref, falling back to local
  - dcd047c docs(traps) T112 a fetch moves remote-tracking refs, not local branches
gate: npm run verify - 598/598 (594 existing + 4 new) plus the boot smoke
---

# Quick Task 260907-szl: Worktree base must be the remote-tracking ref

Every run's worktree now branches off `refs/remotes/<remote>/<baseBranch>` when that ref
exists, and off the bare local name when it does not.

## What was wrong

`prepareWorktree` fetched the remote and then branched from `o.base` — the bare config
string `"main"`, which resolves to `refs/heads/main`. A fetch advances
`refs/remotes/origin/main` and never moves a local branch, so the fetch was inert for its
own stated purpose and every run forked off whatever the operator last pulled.

Measured live on 2026-09-07 across the operator's three mapped clones: `instantchat` 0
behind `origin/main`, `pomboo` 0 behind, `kardun` **18 behind** (it is checked out on
`production`, so its local `main` only moves on an explicit fetch of that ref). A run in
`kardun` would have branched 18 commits stale and opened a PR against an outdated base.

## What changed

`src/execution/worktree.ts`:

- `branchExists` generalised into `refExists(runCommand, repoPath, fullRef)`, keeping the
  `{ reject: false }` + `exitCode === 0` contract. `branchExists` is now one line over it —
  one probe, one place (this repo's signature failure is two implementations of one rule:
  T72/T73/T92/T96/T99/T101).
- After the fetch `try/catch`, the base is resolved: `refs/remotes/${remote}/${o.base}` is
  probed with `refExists`, and that exact probed string is passed as the `worktree add`
  base when it exists — so the probe and the checkout cannot disagree via a second
  resolution step. Otherwise `o.base`, unchanged.
- The fetch comment now states what the code does and why the fallback exists (a clone with
  no remote, and an offline run whose fetch failed), so nobody later tightens it into a
  hard failure.

No new option, no new export, no signature change. `src/cli/adapters.ts` is untouched.

## Verification actually performed

**Task 1 — both checks observed RED at HEAD, for the right reason.**

Unit (`src/execution/worktree.test.ts`), scripting `show-ref` by ref NAMESPACE rather than
by the bare word `show-ref` — every pre-existing case answers exit 1 to every `show-ref`
and would have told the new probe "absent", which is what makes the obvious version of this
test vacuous:

```
not ok 8 - the base is the remote-tracking ref when it exists, not the bare local name
  + actual   'main'
  - expected 'refs/remotes/origin/main'
```

Integration (`src/cli/adapters.worktree.test.ts`), real git through `createWorktreeManager`,
with the upstream one commit ahead of the clone:

```
not ok 1 - a clone whose local main is behind origin/main gets a worktree at the REMOTE tip
  + actual   '44b91df62e8afddf8c9878003ce3a2aa7fab98c5'   (the clone's stale local main)
  - expected '3f5471cc68cdbe0a0bcb3c9de29446342d78ef84'   (the upstream tip)
```

Both fallback cases — no remote-tracking ref, and a repo with no `origin` at all — were
green at HEAD by construction, and stayed green after the fix.

**Task 2 — `npm run verify` green, then the T109 wiring procedure.**

`npm run verify`: 598 tests, 598 pass, 0 fail (594 existing + 4 new), plus `SMOKE PASSED`.

T109 procedure: `prepareWorktree`'s call inside `createWorktreeManager.create`
(`src/cli/adapters.ts:96`) was temporarily replaced with an inline naive
`git worktree add -b <branch> <path> <repo.baseBranch>` against the same `runCommand`.
Observed:

| suite | result | required |
|---|---|---|
| `dist/src/execution/worktree.test.js` | 17 pass / 0 fail — GREEN | GREEN |
| `dist/src/cli/adapters.worktree.test.js` | 1 pass / 1 fail — RED, `actual b2d226b` (clone's stale local main) vs `expected 3ce3766` (upstream tip) | RED |

The asymmetry is the proof: the integration case targets the wiring, not the module. The
probe was reverted, `git status` showed only `src/execution/worktree.ts` modified, and
`npm run verify` was re-run green (598/598 + smoke) before committing.

**Task 3 — both ledgers.**

`awk -F'|' '/^\| T112 /{print NF-2}' .planning/TRAPS.md` prints `5`, matching the header and
the T109 row. `grep -c 'remote-tracking' docs/TRAPS.md` returns `1` (at least 1 required).
T110 and T111's short three-column rows were left alone.

## Deviations from Plan

None. The plan executed as written, including both falsification steps and the T109 wiring
procedure, all with the required results.

## Known Stubs

None.

## Self-Check: PASSED

- `src/execution/worktree.ts` — FOUND (modified)
- `src/execution/worktree.test.ts` — FOUND (modified)
- `src/cli/adapters.worktree.test.ts` — FOUND (created)
- `.planning/TRAPS.md` — FOUND (T112 row present, 5 columns)
- `docs/TRAPS.md` — FOUND (prose paragraph present)
- commit `acf02b2` — FOUND
- commit `8891a3f` — FOUND
- commit `dcd047c` — FOUND
