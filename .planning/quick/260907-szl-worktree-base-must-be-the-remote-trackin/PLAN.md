---
task: Worktree base must be the remote-tracking ref, not the local branch
id: 260907-szl
type: quick
severity: P1
created: 2026-09-07
files_modified:
  - src/execution/worktree.ts
  - src/execution/worktree.test.ts
  - src/cli/adapters.worktree.test.ts
  - .planning/TRAPS.md
  - docs/TRAPS.md
gate: npm run verify   # 594/594 + boot smoke green before; must stay green after
---

<objective>
Branch every run's worktree off `<remote>/<baseBranch>` when that remote-tracking ref
exists, falling back to the bare local name when it does not.

`prepareWorktree` fetches and then branches from the local base ref, which makes the fetch
inert. `git fetch` advances `refs/remotes/origin/main`; it never moves `refs/heads/main`.
So `git worktree add -b <branch> <path> main` cuts from whatever the operator last pulled
— precisely what the comment directly above it says the fetch exists to prevent.
</objective>

<diagnosis>
`src/execution/worktree.ts:112-117` fetches, under this comment (lines 109-111):

    Fetch before branching so a run does not fork off whatever the operator last
    happened to have pulled.

`src/execution/worktree.ts:135` then branches:

    await o.runCommand('git', ['-C', o.repoPath, 'worktree', 'add', '-b', branch, worktreePath, o.base]);

`o.base` is the plain config string. `src/cli/adapters.ts:104` passes `base: repo.baseBranch`
and `src/cli/adapters.ts:553` passes `base: wt.baseBranch`; `RepoMapping.baseBranch` comes
from `config.json` and the wizard writes `"main"`. A bare `"main"` resolves to
`refs/heads/main` — the LOCAL branch, which the fetch did not touch.

Measured live on 2026-09-07 with the operator's config repointed at three real clones:

| clone | local `main` vs `origin/main` |
|---|---|
| `~/ohmaseclaro/instantchat` | 0 behind |
| `~/ohmaseclaro/pomboo` | 0 behind |
| `~/ohmaseclaro/kardun` | **18 behind** |

`kardun` is checked out on `production`, so its local `main` only moves on an explicit
fetch of that ref. A run there branches 18 commits stale and opens a pull request against
an outdated base. The two clean clones are why this is invisible on a machine whose base
branches happen to be current — the same conditions under which all 594 tests pass.

Precedent: GSD's own `quick.md` workflow cuts its branch from `origin/$DEFAULT_BRANCH`
rather than from HEAD, for this exact class of reason (its issue #2916).
</diagnosis>

<constraints>
- The fallback is REQUIRED, not optional. The `try/catch` around the fetch deliberately
  permits offline operation ("a base that already exists locally is enough to work
  offline"), and clones with no `origin` at all must keep working. A missing
  remote-tracking ref is never fatal.
- Work inside the existing structure: the body already runs under `withRepoMutex`,
  `resolveBranchName` owns collision suffixing, and `o.remote ?? 'origin'` is this file's
  established way to name the remote. Do not restructure.
- Never `mock.method` (T88).
- Tests are colocated in `src/` as `*.test.ts` and run from `dist/`.
- Falsify every new check (T71/T76): break it on purpose, observe RED, only then trust it.
</constraints>

<tasks>

<task type="auto">
  <name>Task 1: Two failing checks — one unit, one integration — observed RED at HEAD</name>
  <files>src/execution/worktree.test.ts, src/cli/adapters.worktree.test.ts</files>
  <read_first>
    src/execution/worktree.test.ts:1-140 — `makeRunner`, `BASE_INPUT`, and the existing
    `prepareWorktree` cases. Every existing handler answers `show-ref` with exit 1
    ("never exists"), which is what keeps them green across this change.

    src/cli/daemon-fixture.ts:305-330 — `makeScratchRepo(dir, branch)`: one real
    `git init` + one empty commit at `${dir}/repo`, committer identity set per-repo so it
    cannot disturb the operator's own.

    src/cli/adapters.ts:89-119 — `createWorktreeManager`, the live call path
    (`src/cli/daemon.ts:539`), and `daemonDirOf` = `path.dirname(config.worktreeRoot)`.

    src/cli/adapters.verdict.test.ts:20-60 — the established way to build a minimal
    `Config` and a stub store for an adapter test (`as unknown as Config`, `as never`).

    src/infra/store/sqlite-store.test.ts:6,7,74 — `mkdtemp(join(tmpdir(), 'law-…'))`.
  </read_first>
  <action>
    Write both checks. They target one claim at two altitudes; both must be RED before
    any production line changes.

    UNIT — append to the `describe('prepareWorktree')` block in
    `src/execution/worktree.test.ts`. Script a runner that distinguishes ref namespaces
    rather than matching the bare word `show-ref`: answer exit 0 for a ref under
    `refs/remotes/`, exit 1 for a ref under `refs/heads/`, exit 0 otherwise. Call
    `prepareWorktree` with `BASE_INPUT` (whose `base` is already `'main'`), find the
    recorded `worktree add` call, and assert its final argument names the remote-tracking
    ref for `origin` and `main` — and, separately, assert it is not the bare local name.
    Add a second case pinning the fallback: with every `show-ref` answering exit 1, the
    final argument is the bare name. That second case is green at HEAD by construction and
    exists to stop the fix from breaking offline and no-remote repos.

    INTEGRATION — new file `src/cli/adapters.worktree.test.ts`. Real git, no doubles,
    because no fake can tell you which commit a worktree actually landed on. Per case:
    `mkdtemp` a directory; `makeScratchRepo` it as the upstream; `git clone` that upstream
    into a sibling `clone` directory (this is what creates `origin` and
    `refs/remotes/origin/main`); then add one further commit in the UPSTREAM only, so the
    clone's local `main` is behind its own remote-tracking ref exactly as `kardun` was.
    Drive `createWorktreeManager({ store, config, log, index, runCommand })` — the same
    factory `daemon.ts:539` constructs — with `runCommand` left as the real
    `defaultRunCommand`, a `config` carrying `worktreeRoot` under the tmp directory (the
    daemon dir is its parent, and the containment check in `prepareWorktree` is asserted
    against it), and a `repo` of shape `{ repoDir: <clone>, repoSlug: 'o/r', baseBranch:
    'main', enabled: true }`. `create` reads neither `store` nor `log` nor `index`, so
    stub them as the verdict test does. Assert `git -C <returned worktree path> rev-parse
    HEAD` equals the UPSTREAM tip, not the clone's local `main`.

    Add a second integration case for the required fallback: `makeScratchRepo` alone —
    a repo with no `origin` at all — and assert `create` resolves rather than throws, and
    that the worktree's HEAD is that repo's single commit. The `fetch` failing there is
    the offline path, and it must stay swallowed.

    Clean up every tmp directory in an `after`/`finally` with `rm(dir, {recursive:true,
    force:true})`, matching `usage.test.ts:147`.

    Record the exact failure text of both RED runs; it goes into the TRAPS row in Task 3.
  </action>
  <verify>
    <automated>npm run build && node --test "dist/src/execution/worktree.test.js" ; node --test "dist/src/cli/adapters.worktree.test.js"</automated>
    Both must report FAILING assertions, and the failures must be about the base ref —
    not about a missing import, a bad tmp path, or a git invocation error. A test that
    errors for a setup reason is not a falsification. If either passes at HEAD it is
    vacuous: say so explicitly in the commit body and rewrite it before continuing.
  </verify>
  <done>
    `worktree.test.js` fails on the remote-tracking assertion; `adapters.worktree.test.js`
    fails because the worktree HEAD is the clone's stale local commit; the fallback cases
    in both files are already green; the two failure texts are captured verbatim.
  </done>
</task>

<task type="auto">
  <name>Task 2: Prefer the remote-tracking ref, and run the T109 wiring procedure</name>
  <files>src/execution/worktree.ts</files>
  <read_first>
    src/execution/worktree.ts:68-75 — `branchExists`, which already issues
    `show-ref --verify --quiet refs/heads/<b>` with `{ reject: false }`. That is the
    probe this change needs, one namespace over.
  </read_first>
  <action>
    Generalise `branchExists` into a `refExists(runCommand, repoPath, ref)` that takes a
    FULL ref and keeps the `{ reject: false }` + `exitCode === 0` contract; re-express
    `branchExists` as a one-line call to it with `refs/heads/${branch}`. One probe, one
    place — this repo's signature failure is two implementations of one rule
    (T72/T73/T92/T96/T99/T101).

    In `prepareWorktree`, immediately after the fetch `try/catch` and before
    `resolveBranchName`, resolve the base: name the remote once via the file's existing
    `o.remote ?? 'origin'` idiom, build the remote-tracking ref under `refs/remotes/`,
    probe it with `refExists`, and use that same verified ref string as the `worktree add`
    base when it exists — otherwise `o.base` unchanged. Pass the resolved value, not
    `o.base`, as the final argument of the `worktree add` argv at line 135. Use the exact
    ref string that was probed rather than the short `<remote>/<base>` form, so there is
    no second resolution step where the probe and the checkout could disagree.

    Replace the fetch comment's claim with one that is now true, and say why the bare name
    was wrong: a fetch advances remote-tracking refs only and never moves a local branch,
    so branching from the bare name forks off whatever the operator last pulled. State the
    fallback and its two reasons in the same breath — a clone with no remote, and an
    offline run whose fetch failed — so nobody later "tightens" it into a hard failure.
    Cite the trap id being filed in Task 3.

    Nothing else changes. No new option, no new export, no signature change:
    `PrepareWorktreeInput` already carries both `base` and `remote`.
  </action>
  <verify>
    <automated>npm run verify</automated>
    Then the T109 wiring procedure, which is the point of Task 1's integration case.
    Temporarily replace the `prepareWorktree(...)` call inside
    `createWorktreeManager.create` (src/cli/adapters.ts:96) with an inline naive
    `git worktree add -b <branch> <path> <repo.baseBranch>` against the same
    `runCommand`, then run the two suites separately:

    <automated>node --test "dist/src/execution/worktree.test.js"</automated>  # must stay GREEN
    <automated>node --test "dist/src/cli/adapters.worktree.test.js"</automated> # must go RED

    Both red means the integration test is targeting the module, not the wiring, and it
    must be rewritten to go through `createWorktreeManager`. Neither red means it is
    targeting nothing. Revert the temporary edit and re-run `npm run verify` before
    committing; `git status` must show `src/cli/adapters.ts` unmodified.
  </verify>
  <done>
    `npm run verify` is green: 594 existing tests plus the new cases, plus the boot smoke.
    The unit suite stays green and the integration suite goes red when the adapter's call
    is bypassed. `src/cli/adapters.ts` is untouched in the final diff.
  </done>
</task>

<task type="auto">
  <name>Task 3: File T112 in both ledgers</name>
  <files>.planning/TRAPS.md, docs/TRAPS.md</files>
  <read_first>
    .planning/TRAPS.md:124-127 — section `## Discovered at open-source release` and its
    five-column header `| # | Trap | Failure mode | Correct move | Phase |`.
    .planning/TRAPS.md:149 — T109, the last row that fills all five columns; match it.
    (T110 and T111 stop after three columns. That is a pre-existing inconsistency in rows
    that are not this task's subject — do not touch them.)
    docs/TRAPS.md:373-426 — `## What only a live run finds`, ending with the "Two things
    surfaced only because that re-run happened" paragraph, immediately before
    `## The one that cost the most`.
  </read_first>
  <action>
    LEDGER — append one row, `T112`, to the table in `## Discovered at open-source
    release`, filling all five columns, `Phase` = `live UAT`. Lead the `Trap` cell with
    the bolded lesson: a fetch updates remote-tracking refs only, so any code that fetches
    and then names a bare branch has not refreshed anything. Name the two lines involved
    (`worktree.ts:113` fetch, `worktree.ts:135` `worktree add … o.base`) and that
    `baseBranch` arrives from config as the bare string `"main"`. In `Failure mode`, give
    the measured evidence — instantchat and pomboo 0 behind, kardun 18 behind because it
    sits on `production` — and state that this is invisible on a machine whose base
    branches happen to be current, which is why 594 tests pass over it; add that the
    intent was stated CORRECTLY in the comment directly above the contradicting code, and
    that the comment is what made it look already-solved. In `Correct move`, record the
    fix (probe `refs/remotes/<remote>/<base>`, fall back to the bare name so a
    remote-less or offline clone still works), and the two verification results from Tasks
    1 and 2 with their actual failure texts: the unit test RED at HEAD, and the T109
    wiring result — unit GREEN, integration RED, with the adapter's call bypassed.

    PROSE — append one paragraph to `## What only a live run finds` in `docs/TRAPS.md`,
    after the "Two things surfaced only because that re-run happened" paragraph and before
    `## The one that cost the most`. Match the section's established voice: a bolded
    lesson sentence leading the paragraph, then declarative, concrete sentences with real
    numbers. Say the lesson, give the kardun number, and make the point that the comment
    above the code stated the correct intent — which is what stopped anyone reading the
    line below it. No bullet list; this section is prose.
  </action>
  <verify>
    <automated>awk -F'|' '/^\| T112 /{print NF-2}' .planning/TRAPS.md</automated>
    Must print `5`, matching the header at `.planning/TRAPS.md:127` and the T109 row.
    <automated>grep -c 'remote-tracking' docs/TRAPS.md</automated>
    Must be at least 1. Then read both additions back and confirm the claims match what
    Tasks 1 and 2 actually measured — a ledger row that overstates is worse than none.
  </verify>
  <done>
    `.planning/TRAPS.md` carries a well-formed five-column T112. `docs/TRAPS.md` carries
    one new prose paragraph at the end of `## What only a live run finds`, in the
    section's voice.
  </done>
</task>

</tasks>

<commits>
Three atomic commits, in task order:

1. `test(worktree): falsify branching from the local base ref` — the two RED checks, with
   both failure texts in the commit body.
2. `fix(worktree): branch from the remote-tracking ref, falling back to local` — the
   production change, with the T109 wiring result in the body.
3. `docs(traps): T112 — a fetch moves remote-tracking refs, not local branches`

`commit_docs` is true, so this PLAN.md ships with commit 1. Stay on the current branch.
</commits>

<success_criteria>
- A clone whose local `main` is behind `origin/main` produces a worktree at the
  remote-tracking commit, proven through `createWorktreeManager`, the live call path.
- A clone with no `origin`, and a clone whose fetch fails, still produce a worktree.
- `npm run verify` green: existing 594 plus the new cases, plus the boot smoke.
- The wiring is proven by difference, not by assertion: bypassing the adapter's
  `prepareWorktree` call turns the integration suite red while the unit suite stays green.
- T112 is filed in both `.planning/TRAPS.md` and `docs/TRAPS.md`.
</success_criteria>
