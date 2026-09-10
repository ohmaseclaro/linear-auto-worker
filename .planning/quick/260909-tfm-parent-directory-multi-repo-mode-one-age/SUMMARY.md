---
task: "Parent-directory multi-repo mode: one agent session, one PR per repo"
id: 260909-tfm
type: quick
severity: P2
completed: 2026-09-09
branch: main
status: complete
gate: "npm run verify — 765/765 + boot smoke + poll-only smoke green"
commits:
  - "02258c4 fix(260909-tfm): one run, one answer to which ref it forked from"
  - "f625ecd feat(260909-tfm): one ticket, one agent session, one PR per repo"
  - "862563e feat(260909-tfm): a read-only discovery session that can only NARROW the repo set"
  - "d0d3fa5 feat(260909-tfm): reach the one session from any of a ticket's rows, and a picker that counts repositories"
  - "95ef561 docs(260909-tfm): T125-T127, and how a multi-repo ticket actually runs"
---

# 260909-tfm — Parent-directory multi-repo mode

A ticket mapped to N repositories now runs **one** `claude` session, in
`${daemonDir}/tickets/<parentRunId>/` — a daemon-owned directory whose only contents are
that ticket's N worktrees — costing **one** concurrency slot, and opening **one pull request
per repository the session left commits in**.

**Five commits, not four.** BLOCK 1's named split point was taken: the base-ref fix (M2+M3)
landed first, on its own, before the shape change. That was the right order — it is a live
bug on the single-repo path, and shipping it inside the shape change would have made it
indistinguishable from new behaviour.

---

## The gate

| | |
|---|---|
| Before | **709/709** + boot smoke + poll-only smoke |
| After | **765/765** + boot smoke + poll-only smoke |

Both smokes printed `SMOKE PASSED` / `POLL-ONLY PHASE PASSED`. Every number here is what the
runner printed, not a claim.

## The live instance was not restarted and not reconfigured

Executed through a throwaway `node -e` that reads `~/.linear-auto-worker/config.json` and
prints counts only — never a mapping, never a Slack URL:

```
defaults.baseBranch= main  concurrency= 3  ingress= webhook
mapping #1  repos=1  baseBranches=["main"]
mapping #2  repos=1  baseBranches=["main"]
mapping #3  repos=1  baseBranches=["main"]
mapping #4  repos=1  baseBranches=["main"]
mappings total= 4  multi-repo mappings= 0
```

`planSubRuns` returns `{parent: null, children: [one]}` for a one-repo mapping, so **the
fan-out path is unreachable on the live Código 18 instance** and no toggle is needed to
protect it.

**The running daemon was not stopped, restarted, reconfigured, or written to at any point
during this task.** Its config file was read once, read-only, by the command above. The only
process check run was a read-only `pgrep`.

### Correction to truth #8, as BLOCK 2 required

The plan's truth #8 said the live instance's behaviour is unchanged. As written that is
**false**, and the proof obligation it carried (per-mapping repo counts) does not cover it.
The honest statement, which is what was implemented:

- **The fan-out path is unreachable on the live config.** Proven by the counts above.
- **The base-ref correction applies to N=1 as well, and is intended.** `Worktree.baseBranch`
  is now the resolved `refs/remotes/origin/main` rather than the bare `main`, so
  `deliver.ts`'s diff range changes on *every* run — the PR diff, the file list, and
  `runPrePushGates`' secret-scan input with it. That is the point of M3: on a clone behind
  its own origin the old range was wrong.
- **What genuinely is byte-identical is worktree PATH CONSTRUCTION.** `worktree.ts` is
  untouched when `parentDir` is absent, asserted directly
  (`without parentDir the path is byte-identical to the single-repo layout`).

The executor-facing "GREEN at HEAD, do not repair it" instruction was applied only to that
path-construction case, which is the only one it can hold for.

---

## BLOCK 1 — the base-ref fix, done in full

The plan's Task 1 unified the *config lookup* (M2) and left `gatherEvidence` on the wrong
ref. It is now the resolved ref end to end.

**Three sites answered "which branch did this fork from" three ways:**

| site | answered | now |
|---|---|---|
| `run-engine.repoOf` / `worktreeOf` | `config.defaults.baseBranch` | `repoMappingFor(...)`, then `run.baseRef` for the diff range |
| `adapters.gatherEvidence` | its own copy of the mapping lookup | `run.baseRef`, falling back to `repoMappingFor` |
| `adapters.worktreeFromStore` | `togglesFor(...).baseBranch` — a **third** answer | `run.baseRef`, same fallback |

The carrying mechanism is the one the plan preferred: `prepareWorktree` now **returns the ref
it actually checked out** (`PreparedWorktree.base` — the same variable, not a re-derivation),
the driver writes it to `RepoRun.baseRef` (migration 003) in the same `store.updateRun` that
already records the resolved branch and path, and both readers read that one string. No
second implementation of the remote-ref probe exists.

The behaviour assertion is the one BLOCK 1 asked for — *the commit count and the diff range
use the same ref string* — not "two lookups return the same config value":

```
T125: the commit count is measured against the ref the run was branched from
  -> ranges === ['refs/remotes/origin/main..HEAD']
T125: the RESOLVED ref is recorded on the run row and is what delivery measures against
  -> run.baseRef === 'refs/remotes/origin/master'
  -> deliverer.calls[0].wt.baseBranch === 'refs/remotes/origin/master'
  -> deliverer.calls[0].repo.baseBranch === 'master'   (gh --base stays a GitHub branch)
```

**The live bug, measured against real git** (`adapters.worktree.test.ts`): a clone one commit
behind its origin, `main..HEAD` inside the fresh worktree returns **1** commit for a run that
committed nothing. `verdict.ts:175` gates on `commitCount === 0`, so before this the verdict
declared the agent had committed. T112 measured the real case at 18 commits.

### Deviation: `worktreeFromStore` was fixed, not just reported

The plan's output section asked for it as a finding. Once `baseRef` was on the row,
correcting it was one line at the site all its callers route through, and leaving a
known-wrong third answer in place is how the next reader reaches for it. **Reachability, as
asked:** it is called only from `exists()` and `gc()`, and both read `.path` only — so the
wrong `baseBranch` was **not reachable in production**. Fixed anyway.

---

## Both T109 pairs — with the RED text actually seen

### Pair B — the composition root. **Discriminates exactly as planned.**

Deleted only the `parentDir` pass-through in `createWorktreeManager`, rebuilt, ran the two
suites separately:

```
dist/src/execution/worktree.test.js        # pass 22   # fail 0     GREEN
dist/src/cli/adapters.worktree.test.js     # pass 3    # fail 1     RED
```

RED text, verbatim:

```
not ok 4 - three repos of one ticket land under one parent whose only entries are those three
    Expected values to be strictly equal:
    + actual - expected
    + '/var/folders/.../law-wt-parent-QeWIly/daemon/worktrees/org-api/ENG-9-0'
    - '/var/folders/.../law-wt-parent-QeWIly/daemon/tickets/parent-uuid/org-api'
```

**Why it discriminates:** the module still honours the parameter, so `worktree.test.js`
cannot see the deletion at all. `adapters.worktree.test.js` is the only instrument that
drives real git through the factory `daemon.ts:539` constructs (M12), so it is the only one
that can. Restored; both green.

### Pair A — the drive branch. **Does NOT discriminate as planned. Reporting what happened.**

Deleted only the ticket branch in `handle` so it fell back to `plan.children.forEach(drive)`:

```
dist/src/orchestration/fanout.test.js      # pass 21   # fail 2     RED  (expected GREEN)
dist/src/orchestration/run-engine.test.js  # pass 36   # fail 4     RED  (as expected)
```

RED text from `run-engine.test.js`, verbatim:

```
not ok 34 - a three-repo ticket produces exactly ONE agent session, at the shared parent
    one session for the ticket, not one per repository
    3 !== 1

not ok 35 - a three-repo ticket costs ONE concurrency slot, so a second ticket is not starved
    Expected values to be strictly equal:
    1 !== 3
```

RED from `fanout.test.js` (the two that were supposed to stay green):

```
not ok 17 - one ticket over three repos inserts one parent, three children, and one acknowledgement
not ok 19 - a three-repo ticket occupies ONE slot, so an unrelated run is not starved
```

**The plan's M12 is wrong on this point, and the mis-claim is worth recording.** M12 says
`fanout.test.ts` "targets the pure planner, which this change does not touch". It does not:
`fanout.test.ts` carries **six engine-driving integration tests** (`fanoutHarness`,
`createRunEngine`, `engine.handle({kind:'run.requested'})`) alongside its `planSubRuns` unit
tests. So the pair discriminates **within the file, not between files** — the pure-planner
cases stayed green, the engine cases went red with the engine suite. Per T109 this is a first
pass that came back not-as-predicted, and it is reported rather than dressed up: **the
intended pair does not exist as described.** The discrimination that does hold is pair B's
shape (module vs composition root), and it was measured.

### A third falsification, of the privilege boundary itself (Task 2)

Deleted the intersection so the discovery session's answer was used verbatim:

```
not ok 42 - a name discovery INVENTS is dropped, and the run proceeds over the names that are mapped
    only the mapped name survives
    + actual - expected
      [ 'org/api',
    +   'attacker/exfil',
    +   '../../etc' ]

not ok 43 - discovery naming ONLY unmapped repos falls back to the whole mapping
    fail-open TOWARD the operator's own list — never toward a name a ticket invented
    +   'attacker/exfil'
```

Restored. A validation with no falsification is a comment.

### And of the discovery call site (Task 2's own T109 pair) — **discriminates**

Deleted only the `discoverRepos` call so the full mapping is used:

```
dist/src/domain/agent-result.discovery.test.js + prompt.test.js   # pass 28  # fail 0   GREEN
dist/src/orchestration/run-engine.test.js                          # pass 45  # fail 2   RED
```

RED: `not ok 41 — discovery naming two of three mapped repos ... 0 !== 1`. The module suites
test functions; the engine suite tests the one place they are reached from, which lives in
`run-engine.ts` and not in the composition root, so `run-engine.test.ts` can see it (M12, the
part that IS correct).

---

## Every RED text, with type errors labelled as type errors

**Type errors (`tsc`), not assertion failures:**

```
src/domain/types.test.ts(12,10): error TS2724: '"./types.js"' has no exported member 'repoMappingFor'.
src/execution/worktree.test.ts(232,25): error TS2339: Property 'base' does not exist on type 'PreparedWorktree'.
src/execution/worktree.test.ts(247,7):  error TS2353: 'parentDir' does not exist in type 'PrepareWorktreeInput'.
src/domain/fakes.ts(668,3): error TS2416: Property 'deliver' in type 'FakeDeliverer' is not assignable ...
    Type 'Promise<PullRequest | null>' is not assignable to type 'Promise<PullRequest>'.
src/domain/agent-result.discovery.test.ts(12,29): error TS2305: no exported member 'RepoDiscoverySchema'.
src/domain/agent-result.discovery.test.ts(12,50): error TS2305: no exported member 'parseRepoDiscovery'.
src/execution/agent-args.test.ts(16,3):  error TS2305: no exported member 'DISCOVERY_MAX_TURNS'.
src/execution/agent-args.test.ts(17,3):  error TS2305: no exported member 'DISCOVERY_TIMEOUT_MS'.
src/execution/agent-args.test.ts(23,3):  error TS2305: no exported member 'buildDiscoveryArgs'.
src/cli/resolve-run.test.ts(16,36): error TS2305: no exported member 'sessionOwner'.
src/cli/resolve-run.test.ts(16,50): error TS2305: no exported member 'sharedWith'.
src/cli/adapters.ts(422,3): error TS2741: Property 'discoverRepos' is missing ... but required in type 'AgentRunner'.
```

**Assertion failures:**

```
a repo row with no baseBranch loads, filled from defaults.baseBranch
    Invalid config at .../config.json:
    x Invalid input: expected string, received undefined
      -> at mappings["proj-1"].repos[0].baseBranch
        <- the zod error naming the missing field, quoted as the plan asked

the ref actually branched from reaches Worktree.baseBranch, not the bare config name
    + 'main'   - 'refs/remotes/origin/main'

T125: the commit count is measured against the ref the run was branched from
    + [ 'main..HEAD' ]   - [ 'refs/remotes/origin/main..HEAD' ]

T125: a repo whose own baseBranch differs from the default is branched from ITS OWN
    the mapping is the answer, not defaults . 'main' !== 'master'

T125: the RESOLVED ref is recorded on the run row ...
    + undefined   - 'refs/remotes/origin/master'

a three-repo ticket produces exactly ONE agent session ... 3 !== 1
a three-repo ticket costs ONE concurrency slot ... 1 !== 3
one pull request per repository ... The input did not match /no commits/. Input: ''
an empty diff range delivers nothing ... + { alreadyExisted: false, ciPaths: [], ... }  - null
a real clone and a linked worktree OF IT: only the clone is offered
    + [ 'app', 'app-feature-x' ]   - [ 'app' ]
discovery naming two of three mapped repos creates exactly those two children . 0 !== 1
```

**One falsification produced a HANG rather than a failure, and that is worth naming.**
Deleting the `sessionOwner` redirect from `watch.ts` does not make `law watch <sibling>` fail
— it makes it **never return**: the sibling is non-terminal and has no log, so the follow
loop prints `waiting for the agent to start...` and polls forever. The test had to be killed.
That is a stronger signal than red, and it is what an operator would have hit.

---

## The five answers this task was asked for

1. **`prUrl` needs no change, and why.** One `RepoRun` is one repository is one pull request;
   the run that owns N pull requests is the ticket **parent**, and `TicketRun` has no `prUrl`
   field at all — its N URLs are already rendered by `rollupLine` reading each child's own
   column. Proven by assertion (`three DISTINCT prUrls on three rows, and the parent has
   none`), not changed.
2. **`law watch` / `law say` targeting, and how T118 survived.** `sessionOwner` redirects to
   the run carrying the `sessionId` mark, **strictly after** `resolveRunTarget` and touching
   neither `matches` nor `runTarget` — T118's guarantee is about *resolution*, not about what
   a command does with the run it resolved. Its round-trip oracle: **13/13 green before,
   18/18 green after**, including a new case that feeds a three-sibling ticket's listing back
   through the resolver.
3. **The two `AGENTS.md` cases, and why nothing was built for either.** A *committed* per-repo
   file works for free — each worktree is a subdirectory of the session's cwd, and native
   discovery reaches it. A *parent-level* file is **structurally out of reach**, not merely
   deferred: discovery walks up from cwd, which is now `${daemonDir}/tickets/<parentRunId>/`,
   an entirely different tree from `~/ohmaseclaro/lahzo`. And measured today,
   `~/ohmaseclaro/lahzo` holds **neither `AGENTS.md` nor `CLAUDE.md`**. An *uncommitted*
   per-repo file still never reaches a worktree, by construction — `git worktree add` checks
   out a commit.
4. **Discovery naming an unmapped repo, and naming none.** An invented name is **dropped**,
   logged by name against the mapped list, and the run proceeds over the names that are
   mapped. Naming *only* unmapped names, naming nothing, crashing, timing out, or returning
   garbage all fall back to **every mapped repo**, each arm logged distinctly. The operator's
   mapping is the privilege boundary; the intersection is the enforcement that discovery
   cannot widen it.
5. **A partial delivery is `partial`, by a function that already existed.**
   `deriveParentStatus` (`fanout.ts:225`) maps "some shipped, some not" to `partial`. Two
   asserted cases: one repo left untouched (`cancelled`), and one repo whose worktree could
   not be prepared (`failed`) — both settle `partial` with the other two delivered, and no
   shipped pull request is reclassified by a sibling's outcome.

---

## The flags, folded in

**FLAG 1 — the `prUrl` reader table is 8, not 7.** `src/cli/daemon.ts:505`
(`...(run.prUrl ? { prUrl: run.prUrl } : {})`, the terminal notify event) is a production
reader missing from M1. It reads a **single row**, so M1's conclusion stands; the "all seven"
claim does not. Verified present at HEAD.

**FLAG 4 — M9's entry breakdown is wrong, and the checker's correction is now stale too.**
Measured today at `~/ohmaseclaro/lahzo`:

```
root entries total= 70   directories= 41   loose .md= 26   other files= 3
directories bearing a .git entry= 33   of which .git is a DIRECTORY= 12   a FILE= 21
unique --git-common-dir= 12
AGENTS.md present= false   CLAUDE.md present= false
```

The plan said "65 entries (33 directories, 32 loose markdown)". The checker corrected it to
"65 entries, 37 directories, 26 loose `.md`". Today it is **70 entries, 41 directories, 26
loose `.md`, 3 other files** — the directory count drifts as the operator works, so it is not
a stable number and nothing should be re-derived from it. **`33` is correct only as
"directories bearing a `.git` entry"**, and that is how the code comment and T127 phrase it.
The load-bearing numbers — **12 real clones / 21 linked worktrees / 12 unique common-dirs** —
reproduce **exactly**.

**FLAG 5 — the discovery session has its own named deadline.**
`DISCOVERY_TIMEOUT_MS = 90_000` in `agent-args.ts`, with the reasoning at the constant and
restated in Task 2's action: it is **not** `defaults.maxRunMs`, because that is the *work*
session's budget (45 minutes on a default install, hours if raised) and a discovery that
hangs for it burns the ticket's whole window before the real session starts — which a large
or adversarial ticket body is exactly how to induce. `DISCOVERY_MAX_TURNS = 3`. Both pinned
by an assertion.

**FLAG 6 — the mislabel is fixed.** Every comment and doc line now says: the **operator's
mapping** is the privilege boundary; the **intersection is the enforcement** that discovery
cannot widen it. `buildRepoDiscoveryPrompt`'s doc comment says so explicitly, and
`parseRepoDiscovery`'s says "this is NOT the privilege boundary ... this is only the parse".

**FLAG 2/3 — reported, and the behaviour was chosen and asserted.**

- **Nothing dedupes by `--git-common-dir`.** The implemented rule is the `.git`-is-a-FILE
  type check. Both rules were measured on the operator's root and agree exactly
  (12 / 21 / 12), so the target is hit — but they are **not the same rule**, and this SUMMARY
  does not claim common-dir dedupe. The code comment says the same. The upgrade path (resolve
  `--git-common-dir`, offer the clone at its real path) is recorded as a `ponytail:` note.
- **The shadowing question was decided, not discovered.** A directory whose `.git` is a file
  is **skipped AND not descended into**, so a clone nested inside a worktree stays shadowed
  exactly as before. Asserted with a fixture built by real `git worktree add` containing a
  real nested clone (`a nested clone inside a linked worktree stays shadowed, not newly
  surfaced`), and falsified: restoring the type-blind check turns it red.

---

## Executed, not asserted

**The repo picker, against the operator's real root:**

```
HEAD:  discoverRepos count = 33
       agent-core agent-core-os335 common infra internal-hub lahzo-dataform
       lahzo-dataform-common lahzo-integrations lahzo-monorepo lahzo-monorepo-os335
       lahzo-monorepo-prod199-wt lahzo-monorepo-rh-parity lahzo-monorepo-tfbump
       lahzo-monorepo-wt-debouncer multiverse multiverse-agents multiverse-integrations
       multiverse-integrations-compaction mv-549 mv-585 mv-constitution mv-int-156
       mv-int-main mv-int113 mv-mig126 mv-mig129 mv-os597 pr559 pr560 pr561 ui-core
       wt-mig126 wt-mig129

AFTER: discoverRepos count = 12
       agent-core common infra internal-hub lahzo-dataform lahzo-dataform-common
       lahzo-integrations lahzo-monorepo multiverse multiverse-agents
       multiverse-integrations ui-core
```

**A three-repo ticket driven end to end through the real engine** (fakes only at the worktree
and Linear ports):

```
agent.run calls = 1
cwd            = /tmp/law/tickets/fa9ec0d8-2d93-4382-bb78-5a545f1e1309
LAW_REPO       = "org/api,org/web,org/infra"
LAW_ISSUE_KEY  = COD-9
```

and the brief it received opens:

```
You are working on Linear issue COD-9. The working directory you were
started in is a directory this worker owns, holding one git worktree per
repository this ticket maps to. Each is already checked out on its own branch.
...
Your working directory holds 3 git repositories, one per
subdirectory: org-api, org-web, org-infra. ...
  - Commit inside EACH repository you change. A commit at the top level is not
    a commit in any of them.
  - The working directory itself is NOT a git repository and must not be made
    one. Running git init there turns these repositories into nested untracked
    directories of one, and nothing you did can then be delivered.
```

**Counts read back after the edit:** `docs/TRAPS.md` line 3 -> "One hundred and twenty-seven
footguns", line 18 -> "all 127 rows"; `README.md` line 201 -> "**127 verified footguns**".
`grep -c '^| T' .planning/TRAPS.md`: **126 -> 129**, exactly three.
`grep -rn 'changedRepos' src/` returns no code — only the tombstone comment recording why it
was deleted, one cross-reference in `run-engine.ts`, and the guard test that asserts its
absence.

---

## The two named ceilings

- **N children in `running` under one session over-count the concurrency cap after a boot
  recovery.** `HOLDS_SLOT` counts ROWS, and `scheduler.syncFromStore` recomputes the admitted
  set from run rows, so a recovered three-repo ticket reads as three occupied slots for one
  process. **Over-counting is conservative — it never over-spawns.** Written down in
  `fanout.ts`'s module header rather than discovered. `ponytail:` the upgrade path is a
  session-owner predicate in `syncFromStore`.
- **A crash between worktree creation and the spawn degrades the ticket to the old per-repo
  fan-out on the next boot.** Siblings are left at `preparing`, `BOOT_ACTION` requeues them
  (`recovery.ts:78`), and `dispatchQueued` then drives them individually — one session each,
  in their own worktrees. Graceful, and correct: those worktrees exist and their branches are
  cut. A crash *during* the session leaves every child at `running`, which `BOOT_ACTION` fails
  with a diagnosis — correct and unchanged.

---

## Deviations from the plan

**1. [BLOCK 1] The base-ref fix landed as its own commit, first.** The plan's named split
point, and BLOCK 1 argued it was the better order regardless. It is: `02258c4` is a
self-contained bug fix reviewable on its own, and the shape change on top of it is not
carrying an unrelated correctness fix.

**2. [BLOCK 1] `gatherEvidence` and `worktreeFromStore` both moved to the resolved ref.** The
plan touched only the config lookup. See BLOCK 1 above. `worktreeFromStore` was a third answer
the plan asked to be reported; it was fixed instead, and its (non-)reachability is reported as
asked.

**3. [Rule 2 — correctness] `finishCancel` now records its reason on the run row.** It was
already the parameter and already went into `run_events`, but `rollupLine` and `law watch`
both read `failureReason`, so a cancelled run rendered as a bare state (M13). Fixed at the one
choke point every cancel routes through rather than at the new caller that noticed — the
alternative is one caller that explains itself and three that do not. Improves every cancel,
not just the new one.

**4. [Design, documented] The worktree leaf is the FLATTENED slug (`org-api`), not the slug's
last segment (`api`).** The plan chose `api` and named a `ponytail:` ceiling — `orgA/api` and
`orgB/api` in one mapping collide on the directory name and one child fails loudly. Using the
slug `createWorktreeManager` already flattens costs nothing, is equally recognisable to the
operator and the agent (the brief names the directories explicitly), and **eliminates the
collision entirely** rather than documenting it. No upgrade path needed.

**5. [Scope] The multi-repo Q&A path had to be built, because omitting it would hang.** The
plan's D-09 has no `needs_input` arm. Left alone, a shared session that asks a question would
park the lead and leave its siblings at `running` forever, holding slots nothing releases.
Minimum honest handling: siblings park at `awaiting_answer` alongside the lead (a legal
transition), and `resumeAfterAnswer` brings them back with it. `dispatch` fans out over
`sessionRuns(runId)` once, at the head, so all four arms are covered by one resolution rather
than four.

**6. [Scope] Four `fanout.test.ts` integration tests and one fixture bug had to be rewritten.**
Those tests asserted the OLD behaviour (three sessions, three slots, per-repo agent scripting
keyed on `LAW_REPO`) — the behaviour this task deliberately changes. Their `agentByRepo`
helper became `oneSession` plus a per-repo **delivery** outcome, because that is where the
per-repository answer now genuinely lives. And `multiRepoConfig` had `concurrency` nested
under `defaults`, where nothing reads it, so every case in that file silently ran at the
default 3 — which is why the old three-slot assertion could pass without the number mattering.
Moved to the top level, and the `concurrency: 1` cases now mean what they say.

**7. [Scope] `migrate.test.ts`'s "upgrades to v2" case hardcoded `applied === [2]`.** It now
derives the expected list from `MIGRATIONS`, so a fourth migration does not fail a test for
the product being correct. It also asserts the new column reads `null` on a pre-migration
row — nullable is the point, because `''` would be a base ref.

**8. [Scope] `ScriptedAgent` in two integration suites needed a `discoverRepos` stub.** Both
fixtures map one repository, so the engine never reaches discovery; the stub returns
`undefined` (the "could not answer" arm) rather than throwing, which is the honest value.

No architectural decisions were escalated. Nothing was auto-installed. Rules 1-3 covered
everything above.

---

## Reported as findings, not fixed

- **`adapters.worktreeFromStore` — fixed rather than reported.** See deviation 2. It was not
  reachable for `baseBranch` (only `exists()`/`gc()` call it, and both read `.path`).
- **`run-engine.ts:321` still carries a private `resolveMapping` beside
  `infra/config.ts:173`'s.** Two implementations of one rule, still. The engine's returns the
  raw `ProjectMapping`; the config module's returns a `ResolvedMapping` with toggles spread.
  Not the same return type, so unifying them is more than a deletion. Untouched here.
- **`RunBase.attempt` is still vestigial (T108).** Always `0`, written once by `fanout.ts`,
  read by nothing. `driveTicket` does not use it and nothing added a reader. A grep for
  `.attempt` in production code returns only `notifier.ts`'s unrelated retry loop.
- **`src/ingress/poll.ts` still has no production caller (T122).**
  `grep -rn 'pollForMissedWork' src/ scripts/ | grep -v '\.test\.'` returns two lines: its own
  declaration at `:74` and a doc-comment mention in `recovery.ts:49`. Reported, not deleted,
  exactly as T122 says.
- **`LAW_REPO` for a shared session.** It now carries **all** the repositories, comma-joined:
  `"org/api,org/web,org/infra"` (executed above). A single slug would have been a label that
  is wrong for every repository but one. Nothing in the daemon reads it back — it exists for
  the operator inspecting a live child's environment — so the join is safe, but a future
  reader must not parse it as a single slug.
- **`.planning/TRAPS.md` has two DUPLICATED trap ids at HEAD: `T107` and `T108` each appear
  twice**, with different content (lines 145/147 and 146/148). That is why
  `grep -c '^| T'` reads 126 while the prose count says 124. Pre-existing, out of this task's
  scope, not touched — but it means the ledger's row count and its highest id have been out of
  step since before this task, and anyone renumbering should start there.

## Known stubs

None. Every path added here is wired and exercised.

## Threat flags

| Flag | File | Description |
|------|------|-------------|
| threat_flag: new-agent-session | `src/cli/adapters.ts` | A second `claude` invocation surface (`discoverRepos`). Mitigated in place: empty allowlist, `dontAsk` mode, empty daemon-owned scratch cwd, own 90s deadline, ticket text inside the existing untrusted delimiter, and its output intersected with the operator's mapping before it can influence any repository choice. |
| threat_flag: new-write-path | `src/execution/worktree.ts` | A second worktree-path construction (`parentDir`). The `daemonDir` containment refusal runs on both branches and is asserted directly, so `reconcileWorktrees`' `isUnderRoot` assumption is unweakened. |

## Self-Check: PASSED

Files verified present: `src/domain/types.test.ts`,
`src/domain/agent-result.discovery.test.ts`,
`src/infra/store/migrations/003-run-base-ref.ts`, `docs/agent-invocation.md`,
`.planning/TRAPS.md` (T125/T126/T127 present), `README.md` (count 127).
Commits verified in `git log`: `02258c4`, `f625ecd`, `862563e`, `d0d3fa5`, `95ef561`.
Gate re-run on the final tree: **765/765**, both smokes passed.

---

## Operator actions

1. **Re-run `law setup` against the Lahzo root** (`--config-dir ~/.law-lahzo`) and re-pick the
   repositories. The picker now offers **12** rather than 33. An existing mapping written from
   the 33-item list still names worktree directories and should be **rebuilt, not edited** —
   two entries in it may share a `repoSlug`.
2. **Do not re-run `law setup` against the live Código 18 root** while checking any of this.
3. **Keep the four Código 18 mappings at one repo each** unless you want the new behaviour
   there. The moment a mapping holds two repositories it takes the shared-session path.
4. **The live daemon needs a restart to pick up the base-ref fix**, and that fix changes what
   its pull requests contain — the diff is now measured against `origin/<base>` rather than
   your local branch. That is the correction, but it is a visible change on the very next run.
5. **Cost shape:** a multi-repo ticket now costs one short discovery session plus one work
   session, against N work sessions before. Roughly break-even on sessions for two repos,
   strictly better on the concurrency cap, and the whole point at five.
