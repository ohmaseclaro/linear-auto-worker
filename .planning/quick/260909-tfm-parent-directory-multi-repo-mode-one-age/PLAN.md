---
task: "Parent-directory multi-repo mode: one agent session, one PR per repo"
id: 260909-tfm
type: quick
severity: P2
created: 2026-09-09
branch: main
files_modified:
  - src/domain/types.ts
  - src/domain/ports.ts
  - src/domain/agent-result.ts
  - src/domain/fakes.ts
  - src/infra/config.ts
  - src/infra/config.test.ts
  - src/execution/worktree.ts
  - src/execution/worktree.test.ts
  - src/execution/deliver.ts
  - src/execution/deliver.test.ts
  - src/execution/prompt.ts
  - src/execution/prompt.test.ts
  - src/execution/agent-args.ts
  - src/execution/agent-args.test.ts
  - src/orchestration/fanout.ts
  - src/orchestration/fanout.test.ts
  - src/orchestration/run-engine.ts
  - src/orchestration/run-engine.test.ts
  - src/cli/adapters.ts
  - src/cli/adapters.worktree.test.ts
  - src/cli/resolve-run.ts
  - src/cli/resolve-run.test.ts
  - src/cli/watch.ts
  - src/cli/watch.test.ts
  - src/cli/say.ts
  - src/cli/say.test.ts
  - src/cli/daemon-fixture.ts
  - src/cli/wizard/repo-discovery.ts
  - src/cli/wizard/repo-discovery.test.ts
  - docs/agent-invocation.md
  - README.md
  - docs/TRAPS.md
  - .planning/TRAPS.md
gate: npm run verify   # 709/709 + boot smoke green before; report the exact number after
must_haves:
  truths:
    - "A ticket mapped to N repos runs ONE `claude` session, in a daemon-owned directory whose only contents are the N worktrees, and opens one pull request per repo that session left commits in."
    - "That session costs ONE concurrency slot, not N."
    - "Every existing isolation property survives: no run works inside the operator's clone, every worktree is under the daemon root, and every branch is cut from the remote-tracking ref after a fetch."
    - "Which repos the run may write to is decided by the operator's mapping. A discovery session may only NARROW that set — a name it invents is dropped, and a discovery that returns nothing falls back to the mapping's own list."
    - "One run row still records at most one pull request. The run with N pull requests is the ticket PARENT, which has no `prUrl` column and never had one."
    - "`law watch` and `law say` reach the one live session from ANY of the ticket's rows, and every line a disambiguation listing prints still resolves to exactly one run (T118)."
    - "A run's branch is cut from, and its diff measured against, the SAME ref — the mapped repo's own base branch, defaulting to `Config.defaults.baseBranch`, at origin."
    - "The live Código 18 instance's behaviour is unchanged, and that is demonstrated by loading its real config and printing that every mapping holds exactly one repo — the multi-repo path is unreachable there."
  artifacts:
    - "src/execution/worktree.ts — `PrepareWorktreeInput.parentDir` (a shared, daemon-owned parent) and `PreparedWorktree.base` (the ref actually branched from)."
    - "src/orchestration/run-engine.ts — `driveTicket`: one slot, N worktrees under one parent, one spawn, per-child deliver-or-cancel judged from git."
    - "src/execution/prompt.ts — the multi-repo brief, and `buildRepoDiscoveryPrompt`."
    - "src/domain/agent-result.ts — `RepoDiscoverySchema` + `parseRepoDiscovery`; the dead `changedRepos` field deleted."
    - "src/cli/resolve-run.ts — `sessionOwner`: the one run of a ticket that owns the session, marked rather than positional."
    - "src/cli/wizard/repo-discovery.ts — a directory whose `.git` is a FILE is a linked worktree or a submodule, not a repo to map."
    - ".planning/TRAPS.md T125/T126/T127; docs/TRAPS.md prose; README count 124 → 127."
  key_links:
    - "`run-engine.handle('run.requested')` → `driveTicket` — the one site both producers reach, and the branch that decides one session instead of N."
    - "`run-engine.repoOf` / `worktreeOf` → `repoMappingFor(config, repoSlug)` → the SAME base ref `gatherEvidence` measures against. Two answers to that question is what shipped."
    - "`createWorktreeManager` → `prepareWorktree({ parentDir })` — the composition-root half, visible only to `adapters.worktree.test.ts` and its real git."
    - "`AgentRunner.discoverRepos` → intersect with `mapping.repos` slugs → `planSubRuns`. The intersection IS the privilege boundary."
---

<objective>
Make one Linear ticket over N repositories cost ONE `claude` session instead of N, working in a
daemon-owned parent directory that contains only that ticket's worktrees, and still open one
pull request per repository the session actually changed.

This is item 5, deferred from quick task 260909-nh6. That task's `<deferred>` section scoped it
and named its blocking question; the operator has since answered it, and the answers are
`<decisions>` below. This plan does not re-derive M9–M11 from that task and does not re-open
what he settled.
</objective>

<scope_decision>
**Four tasks. Task 1 is heavy on purpose and the alternatives are worse.**

The four decompose cleanly:

1. the shape change — one session, N repos, N pull requests, over every repo the mapping names;
2. the discovery session that NARROWS that repo set before any worktree exists;
3. the operator-facing surfaces — `law watch` / `law say` targeting, and the repo picker that
   currently offers 33 directories where 12 are repositories;
4. the ledger, the docs and the counts.

Task 1 is the biggest single task this repo has planned. I looked for a split and rejected two:

- **"worktrees under a shared parent first, one session second."** The intermediate ships a
  changed worktree layout with no user-visible benefit and then has its drive path rewritten
  one commit later. Churn for churn's sake.
- **"one session first, per-repo delivery second."** The intermediate is a session that works in
  three repositories and delivers one. That is not releasable; it is a data-loss shape.

So Task 1 stays whole, and this is the honest warning: if it overruns, the split point is
NOT "spawn vs deliver" — it is "keep `driveTicket` behind a two-repo fixture and land the base-ref
fix (M2/M3) as its own commit first". Say so and split there rather than shipping half a drive path.

**What is NOT in this task, and why:**

- **A parent-level `AGENTS.md` injection.** Measured (M9): there is no `AGENTS.md` and no
  `CLAUDE.md` at `~/ohmaseclaro/lahzo` today. Building discovery for a file that does not exist
  is the definition of speculative. Reported with its upgrade path, not built.
- **An uncommitted per-repo `AGENTS.md`.** Still never reaches a worktree, by construction —
  `git worktree add` checks out a commit. Reported, not fixed. Fixing it means copying
  uncommitted operator files into a daemon-owned tree, which is a bigger decision than this task.
- **A per-mapping toggle for the new mode.** See D-07: the live instance cannot reach the
  multi-repo path at all, so a toggle would exist only to be set to one value.
</scope_decision>

<decisions>
Settled by the operator. Implement them; do not re-litigate them in the SUMMARY.

**D-01 — two phases: discover, then isolate.** A cheap read-only `claude` session reads the
ticket and names which repos it needs. Worktrees are then created for exactly those, inside a
daemon-owned parent, and the real session runs with its cwd at that parent. Every existing
isolation property survives (`worktree.ts:100-106`, ASVS V12 / threat T-04-06), `prepareWorktree`
and the per-repo `deliver` are reused, and the extra short session per ticket is accepted.

**D-02 — uncommitted work in the operator's checkouts is ignored, not consulted.** The worktree
is born from the base branch's latest commit. His WIP neither travels into the run nor is touched
by it. Unchanged from today.

**D-03 — always start from the repository's default branch at origin, latest.** Never whatever
branch he happens to have checked out. `baseBranch` defaults to `Config.defaults.baseBranch`
(which is `main` on his machine and on a fresh wizard run) and stays overridable per repo. T112
already made `prepareWorktree` branch from `refs/remotes/<remote>/<base>` after fetching; what
this task adds is that the rest of the pipeline agrees with it (M2, M3).
</decisions>

<measured_facts>
Read from source at HEAD and from this machine today. Nothing recalled. Verify anything you lean on.

**M1 — `prUrl` is one column and it is already the RIGHT shape. Nothing about it changes.**
The sub-question assumed the run that owns N pull requests is a `RepoRun`. It is not. Children
survive this change: one `RepoRun` per repo, each with its own `repoDir`, `repoSlug`, `branch`,
`worktreePath` and `prUrl`. The run that owns N pull requests is the ticket PARENT — and
`TicketRun` (`types.ts:126-136`) has **no `prUrl` field at all**, deliberately, and its N pull
requests are already rendered by `announceTicketRollup` → `rollupLine` (`run-engine.ts:517-556`)
reading each child's own column.

Every production reader, checked:

| site | reads | still correct |
|---|---|---|
| `status.ts:65` | `RunRow.prUrl` | one row, one PR |
| `watch.ts:244` | `fresh.prUrl` | one row, one PR |
| `run-engine.ts:479,481` | `run.prUrl` in `terminalText` | only reached for a run with NO parent (`:498`) |
| `run-engine.ts:519` | `child.prUrl` in `rollupLine` | this IS the N-PR renderer |
| `notify/linear-channel.ts:64,67` | `e.prUrl` | per-run event |
| `notify/log-channel.ts:52` | `e.prUrl` | per-run event |
| `adapters.ts:574` | `result.prUrl` | one delivery |

So the answer to "how is that recorded" is: **exactly as it is recorded today**, and the work is
to prove it rather than to change it.

**M2 — the base ref is resolved TWICE, differently, on one run — and delivery reads the wrong one.**
`run-engine.repoOf` (`:726-734`) and `worktreeOf` (`:736-744`) both hardcode
`baseBranch: config.defaults.baseBranch`, discarding `RepoMapping.baseBranch` — which
`config-writer.ts:196` fills from `safety?.defaultBranch`, i.e. the repository's REAL default
branch. Meanwhile `gatherEvidence` (`adapters.ts:238-240`) resolves the mapped repo and reads
`repos.find(r => r.repoSlug === repoSlug)?.baseBranch` — the real one.

So a repo whose default branch is `master` is branched from `main`, pushed with `--base main`,
and has its commit count measured against `master`. **`RepoMapping.baseBranch` is inert on the
entire delivery path.** `types.ts:230` says "Required on the row; the loader fills it from
`Config.defaults.baseBranch`" — the loader does no such thing (`config.ts:44` requires it), so
that comment is a second false claim in the same three lines.

Invisible on the live instance for one reason only: M4.

**M3 — and the diff range disagrees with the fork point.** `prepareWorktree` branches from
`refs/remotes/<remote>/<base>` when it exists and falls back to the bare name (`worktree.ts:128-129`,
T112). It returns only `{ branch, path }` — the ref it actually used is discarded. `deliver.ts:78`
then computes `range = \`${o.base}..HEAD\`` from `Worktree.baseBranch`, the bare `"main"`. A local
`refs/heads/main` that is 18 commits behind its own origin (T112 measured exactly that) makes the
pull request's diff, its file list and the secret-scan input all wrong — and `runPrePushGates`
(`deliver.ts:89-94`) reads that same file list, so a stale local base widens what the gates scan
rather than narrowing it. Not a security hole; a correctness one, in the module where correctness
is irreversible.

**M4 — the multi-repo path is UNREACHABLE on the live Código 18 instance.** Measured by reading
only repo counts out of `~/.linear-auto-worker/config.json`:

```
mapping repos= 1 baseBranches= ["main"]   (x4)
defaults.baseBranch= main   concurrency= 3
```

Four mappings, one repo each, every base `main`. `planSubRuns` with one repo returns
`{ parent: null, children: [one] }` (`fanout.ts:153-155`) — no parent, no fan-out, no ticket path.
**That is what makes a toggle unnecessary** (D-07) and it is also why M2 has never bitten him.

**M5 — "the first child" is not a stable notion.** `sqlite-store.ts:248-251`:
`SELECT * FROM runs WHERE parent_run_id = ?` with **no `ORDER BY`**. So the run that owns the
shared session must be MARKED, not positional.

**M6 — `AgentResultSchema.changedRepos` is a wire field nothing reads.** `agent-result.ts:72`
declares it under a comment saying "present iff status === 'complete'"; the `complete` arm of
`parseAgentResult` (`:104-110`) reads `summary`, `prTitle` and `prBody` only, and the
`AgentResult` union has no such member. The agent can return it and it is discarded. It is also
exactly the field a careless implementation of this task would reach for — and it must not be
reached for: which repos got a pull request is judged from git, never from the agent's claim
(the whole rule of `verdict.ts`).

**M7 — `~/ohmaseclaro/lahzo` holds 12 repositories presented as 33.** Measured today:

```
12 DIR    # .git is a directory  -> a real clone
21 FILE   # .git is a file       -> a linked worktree (or a submodule)
12        # unique `git rev-parse --path-format=absolute --git-common-dir`
```

`discoverRepos`'s `hasGitEntry` (`repo-discovery.ts:22-29`) asks only whether an entry NAMED
`.git` exists — `readdir` gives it `withFileTypes`, and the type is not consulted. So the wizard
offers the operator 33 checkboxes of which 21 map onto the same 12 repositories. Two of those
mapped as separate repos share one `repoSlug`, which makes `mappingIndex` collide and
`gatherEvidence`'s `repos.find(...)` pick whichever came first.

**M8 — all 12 resolve `origin/HEAD` to `main`.** So D-03's default is correct for every repository
he owns today, and the per-repo override is a future need rather than a present one. Do not
hardcode `main` anywhere; default to `Config.defaults.baseBranch`, which is already `main`.

**M9 — there is no parent-level agent instruction file.** `~/ohmaseclaro/lahzo` holds 65 entries
(33 directories, 32 loose markdown files) and **neither `AGENTS.md` nor `CLAUDE.md` is among
them**. The prior task established by probe that CLI 2.1.263 honours both natively; there is
nothing at that level for it to honour. Build no injection.

**M10 — `preparing → delivering` is ILLEGAL.** `state-machine.ts:37-69`: `preparing` accepts
`worktree_ready`, `spawned`, `error`, `requeue`, `cancel`. Only `running → delivering` exists.
So a sibling child cannot skip `running` on its way to a pull request, and the design must put it
there honestly rather than route around the table.

**M11 — `HOLDS_SLOT` counts rows, not processes.** `types.ts:47` lists `preparing`, `running`,
`delivering`; `scheduler.syncFromStore` recomputes the admitted set from run rows. N children in
`running` under ONE session therefore over-count the cap after a boot recovery. Over-counting is
conservative — it never over-spawns — but it must be written down rather than discovered.

**M12 — the three instruments, and what each can and cannot see.**
`src/cli/adapters.worktree.test.ts` drives REAL git, no doubles, through
`createWorktreeManager` — "the same factory `daemon.ts:539` constructs" (its own header). It is
the only thing that can see the worktree adapter's wiring.
`src/orchestration/run-engine.test.ts` builds its own engine and wraps its own client, so it
CANNOT see `daemon.ts`'s composition root — but `handle`'s `run.requested` branch lives inside
`run-engine.ts` itself, which that suite genuinely exercises.
`scripts/boot-smoke.ts` is the only caller of `bootDaemon` outside `index.ts`
(`grep -n bootDaemon src/cli/*.test.ts` → nothing).

**M13 — `rollupLine` shows a detail only for a pull request or a failed child.**
`run-engine.ts:517-521`: `child.prUrl ?? (child.state === 'failed' ? child.failureReason : '')`.
A `cancelled` child renders as a bare state with no explanation.

**M14 — every child with a parent reports through the rollup.** `announceTerminal` (`:496-513`)
returns early into `announceTicketRollup` for any run with `parentRunId`, and the rollup is
kv-guarded and posted by whichever child settles last. So per-child terminal comments do not
multiply, and this task inherits that for free.
</measured_facts>

<design>

## The shape

Today: `planSubRuns` → N `RepoRun` children → `plan.children.forEach(drive)` → N slots, N
worktrees scattered under `${daemonDir}/worktrees/<slug>/<branch>`, N `claude` sessions, N pull
requests.

After: `planSubRuns` → N `RepoRun` children → **one** `driveTicket` → one slot, N worktrees under
`${daemonDir}/tickets/<parentRunId>/<repo>`, **one** `claude` session with its cwd at that parent,
N pull requests.

**The children survive, and that is the whole reason this is affordable.** Every per-repo column
the product already has — repo, slug, branch, worktree path, state, `prUrl`, `failureReason`,
cost, tokens — keeps meaning exactly what it meant. `deriveParentStatus`, `announceTicketRollup`,
`rollupLine`, `status.ts`, `watch.ts` and the notifier need no new concept. What changes is who
spawns the agent, not what a run is.

## D-04 — `prUrl` needs no change, and the sub-question dissolves

Per M1. One `RepoRun` is one repository is one pull request; the ticket parent has no `prUrl`
field to overload and already renders N of them. Task 1 proves this with an assertion rather than
changing anything: a three-repo ticket ends with three distinct `prUrl` values on three rows, and
one rollup comment naming all three.

## D-05 — the worktrees, and where they land

`prepareWorktree` gains **one optional field**:

```
PrepareWorktreeInput.parentDir?: string   // absent -> today's ${daemonDir}/worktrees/${repoSlug}/${branch}
```

When present the worktree lands at `${parentDir}/${leafName}` and the containment check still runs
against `daemonDir` — so the guard that stands between a bug here and deleting the operator's own
work (`worktree.ts:138-144`, `reconcileWorktrees`'s `isUnderRoot`) is unweakened. Everything else
is reused verbatim: the per-repo mutex, the fetch, the remote-tracking resolution, the branch
collision suffixing, the detached-HEAD assertion.

`leafName` is the last segment of `repoSlug`, because that is the name the operator and the agent
both recognise. `ponytail:` two repos in ONE mapping whose slugs share a trailing segment
(`orgA/api`, `orgB/api`) collide on the directory name; `git worktree add` refuses an existing
path, so that child fails loudly with a `WorktreeError` and the ticket continues with the rest.
Upgrade path if that ever fires: fall back to the full sanitised slug for the colliding pair.

`PreparedWorktree` also gains `base: string` — **the ref it actually branched from**, which is
either `refs/remotes/<remote>/<base>` or the bare fallback (M3). That value is what `Worktree.baseBranch`
carries and what `deliver.ts` uses for its diff range, so the fork point and the diff range are
the same string by construction rather than by two modules agreeing. `gh pr create --base` keeps
the plain branch name — it names a GitHub branch, not a local ref.

Cleanup: the ticket parent directory is `rmdir`'d (non-recursive, failure swallowed) once its
last child settles. Non-recursive on purpose — a directory that still holds a retained worktree
from a failed run must survive, and `finishWorktree`'s retention policy (`worktree.ts:189-202`)
is what decides that.

## D-06 — the base branch, once

Add to `src/domain/types.ts` (which imports nothing):

```
repoMappingFor(config, repoSlug): RepoMapping | undefined
```

`run-engine.repoOf` and `worktreeOf` call it and fall back to `config.defaults.baseBranch`;
`gatherEvidence` calls it instead of re-deriving the same lookup (M2). One definition, three
callers, and the compiler is what keeps them together.

And `RepoMappingSchema.baseBranch` becomes optional, filled from `Config.defaults.baseBranch` at
load — making `types.ts:230`'s existing claim true instead of false. D-03's "default to main,
overridable per repo" is then satisfied by machinery that already exists: `defaults.baseBranch`
is `main` (M4, M8), a mapping may override it, and a repo row may override that.

## D-07 — no toggle

A mapping with one repo does not fan out (`fanout.ts:123,153`), so the new path is reachable only
for a mapping with two or more repos, and the live instance has none (M4). A toggle would fork
the drive path permanently in exchange for protecting an instance that structurally cannot reach
it. The operator asked for one agent across the repos it needs — not for a switch. The proof
obligation replaces the toggle: load his real config and print the per-mapping repo count.

## D-08 — the discovery session, and the privilege boundary

Phase one is a `claude -p` session with:

- **cwd** = a daemon-owned scratch directory, empty. Never a repository, never his parent dir.
- **tools** = none of `Write`/`Edit`/`Bash`. It reads a ticket and answers; it does not need a
  shell, and granting one would put attacker-authored ticket text in front of a shell for the
  sake of a classification.
- **prompt** = the ticket inside the existing `<untrusted-ticket-data>` delimiter, the candidate
  repository slugs in the TRUSTED half.
- **schema** = `{ repos: string[] }`, its own, beside `AgentResultSchema` in `domain/agent-result.ts`.

Its answer is **untrusted input, and it decides where the real agent may write**. So:

| the discovery session says | what happens |
|---|---|
| a slug in the mapping | kept |
| a name not in the mapping | **dropped**, logged with the name it invented. Not a failure. |
| nothing valid, or an empty list | **every mapped repo**, logged loudly |
| it crashed, timed out, or returned garbage | **every mapped repo**, logged loudly |

The fallback is fail-open **toward the mapping's own list, which is the operator's own
declaration of what the bot may touch** — so it is not an escalation, and the worst case is the
wasteful-but-correct shape Task 1 already ships. The alternative, refusing to run, would let a
flaky classifier silently kill every ticket, which is the failure this product category is
judged on. The intersection is done in `run-engine`, before `planSubRuns`, and it is the only
thing standing between ticket text and a repository choice — it gets its own test and its own
falsification.

Its `changedRepos` cousin (M6) is DELETED from `AgentResultSchema` in the same commit. A field
the agent can return, that names repositories, and that nothing reads, is a loaded gun pointed at
exactly this feature: the next reader wires it up and delivery starts trusting the agent's claim
instead of git.

## D-09 — one session, N children, and the state each child is in

`driveTicket(parent, children, ackCommentId, slot)`:

1. **one** `scheduler.acquire`, on the parent's id. N children, one session, one slot.
2. every child `queued → preparing`; `worktrees.create(child.id, repoOf(child), child.branch, parentDir)`;
   record the RESOLVED branch and path on each child row (the same reason `drive` does at `:864`).
   A child whose worktree cannot be prepared is `failed` with the diagnosis and the rest continue.
   If NONE could be prepared, the ticket fails.
3. every child `preparing → running` (M10 — there is no other legal route to `delivering`, and
   it is honest: a live `claude` process is working in that worktree).
4. **one** `agent.run`, cwd = the parent, session id = the LEAD child's.
5. the same `AbortController` is registered in `aborts` under **every** child id, so
   `cancel(childId)`'s `aborts.get(runId)?.abort()` (`:619`) reaps the one session from any child.
6. per child: `deliverer.deliver(...)`. A child whose worktree holds no commits is not delivered.

**Which child gets a pull request is judged from git, and the judgement already lives in
`deliver.ts`.** It computes `git diff --name-only <base>..HEAD` as its very first act
(`:82-83`), before the gates and long before the push. It gains one early return: an empty file
list and an empty diff mean there is nothing to deliver, and the port returns `null` instead of
pushing an empty branch and opening an empty pull request. That is a strict improvement on the
single-repo path too, where today a barren `complete` that slipped past `verdict.ts` would open
an empty pull request. **No new port, no new git call, no agent self-report.**

A child that delivered nothing ends `cancelled`, with `failureReason` set to
`the agent left no commits in this repository`. `cancelled` is the least-wrong of the nine: it is
terminal, it is not a failure, and `deriveParentStatus` already maps "nothing shipped, all
cancelled" to `cancelled` and "some shipped, some not" to `partial`. `rollupLine` is widened to
`child.prUrl ?? child.failureReason ?? ''` so that reason is visible (M13) — which also fixes
`cancelled` and improves every state, rather than special-casing one.

**D-10 — the failure posture, which is already answered.** Two of three repos ship and one fails:
`deriveParentStatus` returns `partial` (`fanout.ts:225`), the rollup lists all three with their
own outcomes, and no shipped pull request is reclassified by a sibling's failure — the property
`fanout.ts` was written for (D-12/DELV-07). Nothing to decide. Task 1 verifies it.

**Known ceilings, named rather than discovered:**
- N children in `running` under one session over-count the concurrency cap after a boot recovery
  (M11). Conservative — it never over-spawns. `ponytail:` upgrade path is a `sessionOwner`
  predicate in `scheduler.syncFromStore`.
- a crash between worktree creation and the spawn leaves siblings at `preparing`, which
  `BOOT_ACTION` requeues (`recovery.ts:78`), and `dispatchQueued` then drives them individually.
  That degrades the ticket to **today's** per-repo fan-out on the next boot. Graceful, and worth
  one sentence in the SUMMARY rather than a mechanism.
- a crash DURING the session leaves every child at `running`, which `BOOT_ACTION` fails with a
  diagnosis (`:82`). Correct and unchanged.

## D-11 — `law watch` / `law say`, without regressing T118

Only the lead child gets a `sessionId`; siblings get `null` (`fanout.ts:141`). That is honest —
they have no session of their own — and it survives T4's rule literally, since no two rows share
an id. It is also a MARK rather than a position, which M5 says it has to be.

`resolve-run.ts` gains:

```
sessionOwner(store, run): RunRow   // the run itself, or its parent's one child with a sessionId
```

`watch.ts` and `say.ts` resolve exactly as they do today, then redirect through it and PRINT that
they did — `following COD-9's session, shared with org/web and org/infra`. **T118 is untouched:
every line the disambiguation listing prints still resolves to exactly one RUN through `matches()`,
because the redirect happens after resolution and changes nothing about `runTarget`. Its
round-trip test is the oracle; run it and say so.**

## D-12 — the brief

`buildAgentPrompt` gains `repoDirs?: readonly string[]` — replacing `siblingRepos` for the ticket
path, since there are no longer siblings to warn about. The trusted half must say, and the
untrusted delimiter stays exactly where it is:

- the working directory holds one git repository per subdirectory, named;
- work in as many or as few as the ticket needs;
- **commit inside each repository you change**, and the delivery contract is unchanged: do not
  push, do not open a pull request. The worker opens one per repository that has commits;
- the parent directory is not a git repository and must not be made one.

That last line is not decoration. An agent that runs `git init` at the parent turns N repositories
into nested untracked directories of one, and the delivery loop then measures nothing.

## Deliberately NOT doing

- **Not touching `prUrl`, `TicketRun`, `deriveParentStatus` or the rollup's structure** (M1, D-10).
  The sub-questions they raise are answered by what is already there.
- **Not building parent-level `AGENTS.md` discovery** (M9). No such file exists.
- **Not injecting uncommitted per-repo instruction files.** Still out of reach by construction.
- **Not using `changedRepos`** — deleting it (M6, D-08).
- **Not restarting or reconfiguring the live daemon.** Not reading, editing or copying
  `~/.linear-auto-worker/config.json` into the repository: it holds a bearer secret
  (`types.ts:266-276`). The live check runs through a throwaway `node -e` and prints counts only.
</design>

<constraints>
- Stay on `main`. Four commits, one per task, each leaving the tree releasable.
- `npm run verify` is 709/709 plus a boot smoke and must stay green. **Report the exact number the
  runner prints — do not assume it.**
- **Never `mock.method`** (T88).
- Tests colocated in `src/` as `*.test.ts`.
- **Falsify every new check** (T71/T76). Each task names the RED text expected at HEAD; paste what
  was actually seen. Where RED at HEAD is a `tsc` error rather than an assertion failure, say so
  and paste the compiler message — a type error is a legitimate RED, calling it an assertion
  failure is not.
- **Apply the T109 wiring procedure.** Each task names its pair and why that pair discriminates.
  Per T109 a first pass that comes back neither-red is the normal outcome, not evidence of
  malpractice — report it and repair the assertion.
- No fixture may carry a scannable credential literal — public repo, unauthenticated CI.
- Do not restart the live daemon. Its behaviour is verified by running its config through the
  loader, never by asserting.
- Read the anchor files named in each `<read_first>`. Do not guess line numbers; the ones quoted
  here were read at HEAD today and may move as you edit.
</constraints>

<tasks>

<task type="tracer" tdd="true">
  <name>Task 1: One ticket, one agent session, one pull request per repo</name>
  <read_first>
    - `src/orchestration/run-engine.ts:200-240` (`insertPlan`, `resolveMapping`), `:440-520`
      (`prBodyFor`, `diagnosis`, `terminalText`, `announceTerminal`), `:517-556` (`rollupLine`,
      `announceTicketRollup`), `:598-640` (`cancel` and its `aborts.get(...)?.abort()`),
      `:644-720` (`fail`, `dispatch` — all four arms), `:722-745` (`repoOf`, `worktreeOf`),
      `:772-800` (`briefFor`, `spawnRequest`), `:802-880` (`drive` in full — especially the
      `driving.add` comment at `:834` and the resolved-branch write at `:864`),
      `:1036-1070` (`handle`'s fan-out, the per-child `scheduler.acquire`, the single
      `acknowledge`, the `forEach(drive)`).
    - `src/orchestration/fanout.ts:96-196` — `planSubRuns` in full, especially the T4 comment at
      `:138-141` and the branch-collision suffixing at `:186-193`.
    - `src/execution/worktree.ts:100-166` — `prepareWorktree`, the T112 remote-ref resolution at
      `:110-129`, and the containment check at `:138-144`.
    - `src/execution/deliver.ts:24-58` (`DeliverInput`, `DeliveryResult`), `:76-108` (the two
      read-only commands, the gates, the push).
    - `src/cli/adapters.ts:82-112` (`createWorktreeManager.create`), `:170-185`
      (`worktreeFromStore`), `:226-263` (`gatherEvidence` and its base lookup), `:555-580`
      (`createDeliverer`).
    - `src/domain/ports.ts:255-275` (`Worktree`, `WorktreeManager`), and the `Deliverer` /
      `PullRequest` declarations.
    - `src/domain/types.ts:89-136` (`RepoRun`, `TicketRun`), `:227-233` (`RepoMapping` and its
      false doc comment at `:230`), `:307-345` (`Config`).
    - `src/domain/state-machine.ts:31-77` — the transition table (M10).
    - `src/infra/config.ts:39-45` (`RepoMappingSchema`), `:92-108` (`ConfigSchema`).
    - `src/cli/adapters.worktree.test.ts` in full — the real-git instrument this task extends.
    - `src/orchestration/run-engine.test.ts` — how it builds its engine and its fakes.
    - `src/domain/fakes.ts:540-560` (the worktree fake) and `:210-245` (the config fixtures).
  </read_first>
  <behavior>
    Write these FIRST and watch them fail.

    **The base ref, one answer (M2, M3).**
    - A mapped repo whose own `baseBranch` differs from `config.defaults.baseBranch` is branched
      from ITS OWN, not from the default. RED at HEAD: the worktree fake records the default.
    - The evidence lookup and the worktree lookup return the same string for the same slug — one
      assertion over the shared helper, so a future second lookup is a compile error rather than
      a silent divergence.
    - A repo row with no `baseBranch` loads, filled from `config.defaults.baseBranch`. RED at
      HEAD is a zod error naming the missing field; quote it.
    - In `adapters.worktree.test.ts`, against REAL git: the worktree's HEAD is the commit at
      `refs/remotes/origin/<base>` and `PreparedWorktree.base` is the ref string actually used —
      and the same string reaches `Worktree.baseBranch`. This is the one that catches M3.

    **The shared parent.**
    - `prepareWorktree` with `parentDir` lands at `${parentDir}/${leaf}` and still refuses a path
      outside `daemonDir`. Assert BOTH — the containment refusal is the one that must not be
      weakened by the new branch.
    - Without `parentDir`, the path is byte-identical to today. The non-regression that keeps
      every single-repo run unchanged; GREEN at HEAD, do not "repair" it.
    - Through `createWorktreeManager` with real git (`adapters.worktree.test.ts`): three repos,
      one parent, and `readdir(parent)` returns exactly three entries. That last assertion is the
      literal statement of "a directory containing only those worktrees".

    **One session.**
    - A three-repo ticket produces exactly ONE `agent.run` call, whose `cwd` is the parent and
      whose `sessionId` is the lead child's. RED at HEAD: three calls.
    - It takes exactly ONE scheduler slot. With `concurrency: 1`, a three-repo ticket and a
      one-repo ticket both make progress. RED at HEAD: the second ticket starves.
    - A ONE-repo mapping still takes today's path: no parent row, no ticket directory, cwd is the
      run's own worktree. GREEN at HEAD — this is the live instance's case (M4) and it is the
      non-regression this whole task rests on.

    **N pull requests, judged from git.**
    - Three repos, the deliverer reporting commits in two of them: two rows end `delivered` with
      two DISTINCT `prUrl` values, the third ends `cancelled` with a `failureReason` naming the
      absence of commits, and `deriveParentStatus` says `partial`.
    - The rollup comment names all three repos and shows the cancelled one's reason. RED at HEAD
      for the reason (M13).
    - Every repo delivering: all three `delivered`, status `delivered`.
    - One repo's worktree failing to prepare: that child `failed`, the others still deliver,
      status `partial`. **This is D-10's answer and it must be asserted, not assumed.**
    - `deliver` with an empty diff returns null and never reaches the push command. Assert on the
      recorded commands: no `push` and no `gh` appears. RED at HEAD: both do.

    **Cancel.**
    - Cancelling ANY child of a running ticket reaps the one session — assert the abort signal
      fired — and all three children end `cancelled`.

    Expected RED texts to quote verbatim in the SUMMARY (the exact wording will differ; these
    are the assertions that must be seen failing before they are made to pass): the three-vs-one
    spawn count, the starving second ticket, the two-distinct-`prUrl` count, the empty-diff push,
    and the `tsc` error for the newly-optional `baseBranch`.
  </behavior>
  <action>
    In `src/domain/types.ts`: add `repoMappingFor(config, repoSlug)`, a pure lookup over
    `config.mappings`, documented as the ONE answer to "what is this repository's base branch" and
    naming the two callers that used to disagree (M2). Do not add a second lookup anywhere.

    In `src/infra/config.ts`: make `RepoMappingSchema.baseBranch` optional and fill it from
    `Config.defaults.baseBranch` during parse, so `types.ts:230`'s existing sentence becomes true.
    If the `satisfies` clause fights the transform, report the exact compiler text before choosing
    a fallback — that clause is what keeps the schema and the domain contract from drifting
    (`config.ts:12-19`).

    In `src/execution/worktree.ts`: add the optional `parentDir` to `PrepareWorktreeInput` and
    `base` to `PreparedWorktree`. Keep the containment check against `daemonDir` on BOTH branches
    and say at the new branch why it is not relaxed. Return the ref string the checkout actually
    used — the same variable, not a re-derivation.

    In `src/domain/ports.ts` and `src/cli/adapters.ts`: thread `parentDir` through
    `WorktreeManager.create` and carry the resolved base onto `Worktree.baseBranch`. Point
    `gatherEvidence` at `repoMappingFor` instead of its private copy of the same lookup.

    In `src/execution/deliver.ts`: return null when the diff range is empty, before the push.
    Comment it with what it prevents — an empty branch pushed and an empty pull request opened for
    a repository the agent never touched — and note it is a strict improvement on the single-repo
    path too.

    In `src/orchestration/fanout.ts`: give only the lead child a `sessionId` when there is a
    parent. Amend the T4 comment at `:138-141` rather than deleting it: the rule it states — two
    rows must never share a session id — is UNCHANGED and is what makes `null` the right value for
    a sibling.

    In `src/orchestration/run-engine.ts`: point `repoOf` and `worktreeOf` at `repoMappingFor`.
    Widen `rollupLine` to show a `failureReason` for any state. Add `driveTicket` per D-09 and
    branch to it from `handle` when the plan has a parent, leaving the single-repo path calling
    `drive` untouched. Register the one `AbortController` under every child id and say why at that
    line. Put a comment on the branch in `handle` naming it as the one site both producers reach.

    In `src/execution/prompt.ts`: add `repoDirs` per D-12. Everything untrusted stays inside the
    existing delimiter; the repository names go in the trusted half, because they come from the
    operator's config, not from the ticket.
  </action>
  <verify>
    <automated>npm run verify</automated>
    Into the SUMMARY:
    - Every RED text, verbatim, with type errors labelled as type errors.
    - **T109 pair A — the drive branch.** Delete only the ticket branch in `handle` so it falls
      back to `plan.children.forEach(drive)`. Rebuild, then run the two suites SEPARATELY and
      paste both: `node --test dist/src/orchestration/fanout.test.js` must stay **GREEN** and
      `node --test dist/src/orchestration/run-engine.test.js` must go **RED**. It discriminates
      because `fanout.test.ts` targets the pure planner, which this change does not touch, while
      the branch being deleted lives inside `run-engine.ts` — which that suite genuinely
      exercises, unlike `daemon.ts`, which it cannot see (M12).
    - **T109 pair B — the composition root.** Delete only the `parentDir` pass-through in
      `createWorktreeManager`. Rebuild and paste both:
      `node --test dist/src/execution/worktree.test.js` must stay **GREEN** — the module still
      honours the parameter — and `node --test dist/src/cli/adapters.worktree.test.js` must go
      **RED**, because it is the only instrument that runs the real factory `daemon.ts`
      constructs against real git. Restore. Both green, or both red, means the assertion targets
      the module; say so and repair it before claiming the fix.
    - **The live-instance check, executed rather than asserted.** A throwaway `node -e` that
      loads `~/.linear-auto-worker/config.json` and prints, per mapping, only the repo COUNT and
      the set of base branches. Every line must show one repo, so the multi-repo path is
      unreachable there (M4). **Print only these counts — never the mappings, never a Slack URL.**
    - An executed statement that the live daemon was not restarted and not reconfigured.
  </verify>
  <done>
    A ticket over N mapped repos runs one `claude` session in a daemon-owned directory holding
    only that ticket's N worktrees, costs one concurrency slot, and opens one pull request per
    repository it left commits in — with the untouched ones recorded and explained rather than
    delivered empty. Every branch is cut from, and every diff measured against, the same ref: the
    mapped repository's own base branch at origin. The single-repo path is byte-for-byte
    unchanged. `npm run verify` green. Committed.
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: The discovery session — narrow the repo set before any worktree exists</name>
  <read_first>
    - `src/domain/agent-result.ts` in full — the schema, `parseAgentResult`, and the dead
      `changedRepos` at `:72` (M6).
    - `src/execution/agent-args.ts:106-226` — `ClaudeArgsInput`, `commonArgs`, `buildClaudeArgs`;
      and the three load-bearing comments at `:74`, `:90` and `:172` before touching any flag.
    - `src/execution/prompt.ts:24-49` (`sanitizeUntrustedText`, `defangDelimiter`, the two
      delimiter constants), `:81-129` (`buildAgentPrompt` and the trusted/untrusted split).
    - `src/domain/ports.ts` — the `AgentRunner` interface and `SpawnRequest`.
    - `src/cli/adapters.ts:380-450` — `createAgentRunner`'s budget check and arg assembly,
      `:454-545` — the run log, injector registration and evidence gathering.
    - `src/orchestration/run-engine.ts` at `handle`'s `run.requested`, as Task 1 left it —
      specifically the two guards, the `getIssue`, `resolveMapping`, the pickup filter and
      `planSubRuns`, in that order.
    - `src/orchestration/scheduler.ts:55-120` — what one `acquire` costs.
  </read_first>
  <behavior>
    Write these FIRST.

    Unit, on the parser:
    - a well-formed `{repos:[...]}` parses; a missing field, a non-array, and a non-string member
      each throw with a message naming what was wrong.
    - `changedRepos` no longer appears in `AgentResultSchema`. Assert on the schema object, so
      re-adding it is a red test rather than a code review.

    Unit, on the prompt: the ticket text sits inside `UNTRUSTED_OPEN`/`UNTRUSTED_CLOSE`, the
    candidate slugs sit outside it, and a ticket body containing a closing delimiter is defanged —
    the same three assertions `prompt.test.ts` already makes for `buildAgentPrompt`, because this
    is the same boundary reached by a new door.

    Unit, on the args: the discovery invocation grants none of `Write`, `Edit`, `Bash`. Assert on
    absence explicitly; a read-only session that quietly has a shell is the whole risk.

    Integration, at the engine — **these are the privilege boundary and they are the assertions
    that matter most in this task**:
    - discovery returns two of three mapped slugs: exactly two children are created, for those
      two, and no worktree is created for the third.
    - discovery returns a name that is not in the mapping: it is dropped, the log names it, and
      the run proceeds over the names that ARE in the mapping.
    - discovery returns ONLY names that are not in the mapping: every mapped repo is used
      (D-08's fallback), and the log says so.
    - discovery returns an empty list: same fallback.
    - discovery throws / crashes / times out: same fallback. One assertion per arm, so a failure
      says which door was left open.
    - a ONE-repo mapping runs no discovery session at all. There is nothing to narrow, and paying
      for a session to be told so is the cost the operator accepted for the multi-repo case only.

    Expected RED at HEAD for all of the above: the method does not exist, so most will be `tsc`
    errors. Say so, quote them, and do not describe a compiler error as an assertion failure.
  </behavior>
  <action>
    In `src/domain/agent-result.ts`: add `RepoDiscoverySchema` and `parseRepoDiscovery` beside
    their siblings, with `additionalProperties: false` for the same reason the existing schema has
    it. Delete `changedRepos` and put a comment where it was recording why: a wire field naming
    repositories that nothing reads is the field a future implementation of THIS feature would
    reach for, and delivery must never trust the agent's claim about what it changed — git decides
    (`verdict.ts`'s rule of the file).

    In `src/execution/agent-args.ts`: add the discovery invocation. It shares `commonArgs`'s
    non-negotiables — `--verbose`, the output format, the bare trailing `-p`, no `--bare` — and
    differs only in its schema, its turn budget and its allowlist. State in the comment that the
    allowlist is narrow BY DESIGN and what that costs: with no repository access the session
    decides from the ticket text and the repository names alone. `ponytail:` the upgrade path if
    accuracy proves insufficient is each repository's `AGENTS.md` first lines in the prompt, at
    the same trust level as the ticket body — inside the delimiter, never beside it.

    In `src/execution/prompt.ts`: `buildRepoDiscoveryPrompt`. Trusted half: the candidate slugs
    and the instruction to name only from that list. Untrusted half: the ticket, through the same
    sanitize-then-defang order `buildAgentPrompt` uses, and for the same reason stated there.

    In `src/domain/ports.ts` and `src/cli/adapters.ts`: `AgentRunner.discoverRepos`. It runs in a
    daemon-owned scratch directory, never a repository and never the operator's parent directory —
    say so at the line that computes the cwd. It writes a run log like any other session, so a
    discovery that went wrong is inspectable rather than a black box.

    In `src/orchestration/run-engine.ts`: call it after the pickup filter and before
    `planSubRuns`, only when the mapping holds more than one repo. Intersect its answer with the
    mapping's own slugs and comment that line as the privilege boundary — an unvalidated name
    from a ticket-steered session would be choosing which repository the daemon may write to.
    Implement every arm of D-08's table and log each one distinctly; a fallback that cannot be
    told from a success in the log is a fallback nobody will ever notice firing.
  </action>
  <verify>
    <automated>npm run verify</automated>
    Into the SUMMARY:
    - Every RED text, verbatim, type errors labelled as such.
    - **T109 pair.** Delete only the `discoverRepos` call site in `run-engine.ts` so the mapping's
      full repo list is used. Rebuild and paste both: `node --test dist/src/domain/agent-result.test.js`
      (and `prompt.test.js`) must stay **GREEN** — the parser and the prompt are unchanged and
      correct — while `node --test dist/src/orchestration/run-engine.test.js` goes **RED** on the
      narrowing assertion. It discriminates because the module suites test functions and the
      engine suite tests the one place the function is reached from; per M12, `run-engine.test.ts`
      can see this call site because it lives in `run-engine.ts`, not in the composition root.
    - **A falsification of the privilege boundary itself.** Delete the intersection so the
      session's answer is used verbatim, rebuild, and paste the RED from the
      invented-repo-name case. Restore. A validation with no falsification is a comment.
    - A grep showing `changedRepos` has no occurrence left outside the TRAPS ledger.
  </verify>
  <done>
    A multi-repo ticket runs one short read-only session that names the repositories it needs,
    and worktrees are created for exactly those. A name that session invents cannot reach a
    repository choice; a session that fails, times out or answers with nothing falls back to the
    operator's own mapping and says so in the log. A single-repo mapping pays for no discovery
    session. `npm run verify` green. Committed.
  </done>
</task>

<task type="auto">
  <name>Task 3: Reaching the one session, and a repo picker that counts repositories</name>
  <read_first>
    - `src/cli/resolve-run.ts` in full — `matches`, `runTarget`, `listing`, `resolveRunTarget`,
      and the T118 comment at `:54-68` explaining why uniqueness is decided BY `matches`.
    - `src/cli/resolve-run.test.ts` — especially the round-trip test T118 added; it is the oracle
      this task must not regress.
    - `src/cli/watch.ts:130-160` (`WatchDeps`, the root), `:190-255` (the follow loop, the log
      path, the terminal line).
    - `src/cli/say.ts` in full — the two refusals and the `law watch` suggestion at `:74-83`.
    - `src/cli/status.ts:43-70` — `label` and `describe`, and the comment at `:43-48` about why
      the repo slug is not decoration.
    - `src/execution/run-log.ts:33-40` — the per-run log path.
    - `src/cli/wizard/repo-discovery.ts` in full — `hasGitEntry` at `:22-29` and `scan`.
    - `src/cli/wizard/repo-discovery.test.ts` — its existing fixtures.
  </read_first>
  <behavior>
    **Targeting.**
    - `law watch <a sibling's token>` follows the shared session's log and says, on its first
      line, whose session it is following and which repositories share it. RED at HEAD: the
      sibling has no log and the command reports there is no activity log for it.
    - `law say <a sibling's token>` reaches the live session. RED at HEAD: `no live agent for run …`.
    - `law watch <the lead's token>` is unchanged, and `law watch` against a single-repo run is
      unchanged. Both GREEN at HEAD.
    - **T118's round trip still holds.** Run the existing oracle unmodified: split the
      ambiguity error on newlines, feed each line's first token back through `resolveRunTarget`,
      and require exactly one run per token and different runs for different lines. It must be
      GREEN both before and after; if it goes red, the redirect has leaked into resolution and
      belongs strictly after it.
    - The redirect is reported, never silent. Assert on the printed line — an operator who typed
      one repo's token and is shown another's session must be told why.

    **`prUrl`, proven rather than changed (M1, D-04).**
    - A three-repo ticket ends with three rows carrying three DISTINCT `prUrl` values, and
      `law status` renders one line per repository with its own URL. This is the assertion that
      answers the sub-question; it should be GREEN once Task 1 has landed, and its value is that
      it goes RED the day someone collapses the children.

    **The repo picker.**
    - A scan over a fixture containing a real clone and a linked worktree of it returns the clone
      only. RED at HEAD: it returns both.
    - A scan over a fixture containing a submodule returns the parent only.
    - A scan over ordinary clones is unchanged. GREEN at HEAD.
    - Build the worktree fixture with real `git worktree add`, not a hand-written `.git` file:
      the property under test is what git actually produces.
  </behavior>
  <action>
    In `src/cli/resolve-run.ts`: add `sessionOwner`. Document that it runs strictly AFTER
    resolution and touches neither `matches` nor `runTarget`, because T118's guarantee is that
    every printed token resolves to exactly one RUN — and that guarantee is about resolution, not
    about what the command then does with the run it resolved.

    In `src/cli/watch.ts` and `src/cli/say.ts`: redirect through it and print the redirect. In
    `say.ts` keep the `law watch` suggestion sourced from `resolved.target` (T118's second half —
    do not rebuild it from a run field).

    In `src/cli/wizard/repo-discovery.ts`: a directory whose `.git` is a FILE is a linked worktree
    or a submodule, not a repository to map. `readdir` already returns the entry type, so this is a
    check that was available and not made. Record the measurement in the comment (M7): the
    operator's own root offers 33 candidates of which 21 are worktrees of the other 12, and two
    such directories mapped as separate repos share one `repoSlug`, which makes `mappingIndex`
    collide. `ponytail:` a repository whose main clone lives OUTSIDE the scanned root is now
    skipped entirely rather than offered as a worktree; that is the right trade — offering it
    would map the wrong directory — and the upgrade path is resolving `--git-common-dir` and
    offering the clone at its real path.
  </action>
  <verify>
    <automated>npm run verify</automated>
    Into the SUMMARY:
    - Every RED text, verbatim.
    - The T118 round-trip test's result before AND after this task, quoted, with a sentence saying
      the redirect happens after resolution and why that is what keeps it green.
    - **Executed, not asserted:** run `discoverRepos` against `~/ohmaseclaro/lahzo` through a
      throwaway `node -e` and paste the count. It must be 12, against the 33 it returns at HEAD.
      Paste both numbers. Print counts and directory names only.
    - A falsification: restore the type-blind `.git` check, rebuild, paste the RED from the
      worktree fixture, restore.
  </verify>
  <done>
    `law watch` and `law say` reach the one live session from any of a ticket's rows and say that
    they redirected; T118's round-trip oracle is green on both sides of the change. A three-repo
    ticket demonstrably records three distinct pull request URLs on three rows. The wizard offers
    the operator 12 repositories where it offered 33. `npm run verify` green. Committed.
  </done>
</task>

<task type="auto">
  <name>Task 4: Write down what was measured</name>
  <read_first>
    - `.planning/TRAPS.md:124-130` — the third table's header row, for the five-column shape, and
      `:149` (the T109 row) as the model to match.
    - `.planning/TRAPS.md` rows T122–T124 — the most recent three, for tone and length.
    - `docs/TRAPS.md:1-22` — the count and the framing — and its section headings, to place each
      new entry.
    - `README.md:195-225` — the ledger count and the surrounding paragraph.
    - `docs/agent-invocation.md` in full — decide by reading whether the multi-repo section
      belongs there or in the README.
  </read_first>
  <behavior>
    The checks here are the counts and the greps, and each is falsifiable:
    - `grep -c '^| T' .planning/TRAPS.md` increases by exactly 3.
    - both count lines — `README.md` and `docs/TRAPS.md` — read back 127 after the edit. Paste
      both, read back rather than claimed.
    - `grep -rn 'changedRepos' src/` returns nothing.
  </behavior>
  <action>
    Three rows in `.planning/TRAPS.md`'s third table, five columns, matching T109's shape.

    **T125 — one run, two answers to "which branch did this fork from".** `run-engine.repoOf` and
    `worktreeOf` hardcoded `config.defaults.baseBranch` while `gatherEvidence` read the mapped
    repository's own `baseBranch`, which `config-writer.ts:196` fills from the repository's real
    default branch. And a third disagreement rode along: `prepareWorktree` branches from
    `refs/remotes/<remote>/<base>` (T112) and threw that ref away, so `deliver.ts` measured its
    diff range against the bare local name. Failure mode: a repository whose default branch is not
    `main` is branched from `main`, pushed with `--base main`, and has its commit count and its
    pull request diff computed against a third ref — with the secret scan reading that same
    wrong file list. Invisible on this machine because all four live mappings and all twelve of
    the operator's repositories are `main`. Correct move: one lookup (`repoMappingFor`), and make
    the function that CHOSE the ref return it, so the fork point and the diff range are the same
    string by construction rather than by two modules agreeing.

    **T126 — a wire-schema field the agent can return that nothing reads, sitting exactly where
    the next feature would reach for it.** `AgentResultSchema.changedRepos` was declared under a
    comment saying "present iff status === 'complete'"; the `complete` arm of `parseAgentResult`
    reads three other fields and the `AgentResult` union has no such member. Failure mode: it is
    the obvious lever for "one pull request per repo the agent touched", and taking it makes
    delivery trust the agent's own claim about what it changed — which is the single thing
    `verdict.ts` exists to refuse, in a codebase where `claude -p` has been measured exiting 0
    having been denied every edit. Correct move: delete it in the same commit that builds the
    feature it would have been misused for, and judge from git. `deliver.ts` already runs
    `git diff --name-only <base>..HEAD` as its first act, so the honest answer cost one early
    return and no new call.

    **T127 — 21 of 33 "repositories" were worktrees of the other 12, and the scanner could not
    tell.** `repo-discovery.ts`'s `hasGitEntry` asked only whether an entry named `.git` existed;
    `readdir` had already told it whether that entry was a file or a directory. Measured on the
    operator's own root: 12 directories with `.git` as a DIRECTORY, 21 with `.git` as a FILE, and
    12 unique `git rev-parse --git-common-dir`. Failure mode: the wizard offers 33 checkboxes; two
    picks that resolve to one repository share a `repoSlug`, so `mappingIndex` collides and
    `gatherEvidence`'s `repos.find(...)` silently picks whichever came first — and under the
    multi-repo mode this task builds, `git worktree add` from a linked worktree registers in the
    COMMON directory, so one ticket opens several pull requests into one repository. Correct move:
    consult the type `readdir` already returned. A linked worktree and a submodule both carry
    `.git` as a file, and neither is a repository to map.

    Then `docs/TRAPS.md`: T125 under the delivery/git section, T126 under the agent-contract
    section, T127 under the setup section — decide by reading the headings. Update the opening
    count from 124 to 127, and `README.md`'s ledger count likewise.

    Finally, a short section — in `docs/agent-invocation.md` or `README.md`, decide by reading
    what is already in each — recording how a multi-repo ticket now runs: one session, cwd at a
    daemon-owned directory holding only that ticket's worktrees, one pull request per repository
    with commits, one short discovery session ahead of it, and its concurrency cost. State the two
    agent-instruction gaps as gaps: a parent-level `AGENTS.md` is not on the discovery path (and
    none exists on this machine today — M9), and an uncommitted per-repo one never reaches a
    worktree. Do not describe either as handled.
  </action>
  <verify>
    <automated>npm run verify</automated>
    Plus, pasted into the SUMMARY:
    - `grep -c '^| T' .planning/TRAPS.md` before and after.
    - The two count lines, read back after the edit, both showing 127.
    - `grep -rn 'changedRepos' src/` returning nothing.
    - The exact `npm run verify` count the runner printed on this commit.
  </verify>
  <done>
    Three traps are in the ledger with their measurements and their falsifications; both counts
    read 127; the docs describe the multi-repo run as it is, including the two gaps it does not
    close. `npm run verify` green. Committed.
  </done>
</task>

</tasks>

<success_criteria>
- A ticket mapped to three repositories produces ONE `agent.run`, at a daemon-owned directory
  whose only contents are that ticket's three worktrees, holding ONE concurrency slot.
- It produces one pull request per repository that session left commits in, recorded as three
  distinct `prUrl` values on three rows — and a repository it did not touch is recorded and
  explained rather than delivered as an empty pull request.
- One repository failing to prepare or failing to deliver does not stop the others, and the ticket
  settles `partial` through `deriveParentStatus` with the rollup naming every repository's own
  outcome.
- A discovery session narrows the repository set; a name it invents cannot reach a repository
  choice; a discovery that fails or answers with nothing falls back to the operator's own mapping
  and says so.
- Every branch is cut from, and every diff measured against, the mapped repository's own base
  branch at origin — one lookup, no second answer.
- `law watch` and `law say` reach the one live session from any of the ticket's rows and say that
  they redirected. T118's round-trip oracle is green before and after.
- Loading the operator's real `~/.linear-auto-worker/config.json` prints one repo per mapping, so
  the multi-repo path is unreachable on the live instance — pasted output, not a claim. The live
  process is not restarted.
- `discoverRepos` against `~/ohmaseclaro/lahzo` returns 12, against 33 at HEAD — executed, both
  numbers pasted.
- Both T109 pairs are recorded with their two suite outcomes and a sentence on why each pair
  discriminates.
- `npm run verify` green with the exact count reported.
</success_criteria>

<operator_actions>
What the operator does by hand once this ships. None of it can be done by the executor.

1. **Re-run `law setup` against the Lahzo root** (`--config-dir ~/.law-lahzo`, from quick task
   260909-nh6) and re-pick the repositories. The picker now offers 12 rather than 33 (M7, T127);
   an existing mapping written from the 33-item list still holds worktree directories and should
   be rebuilt rather than edited.
2. **Do not re-run `law setup` against the live Código 18 root** while checking any of this.
3. **Keep his four Código 18 mappings at one repo each** unless he wants the new behaviour there.
   The moment a mapping holds two repositories it takes the shared-session path — which is what
   he asked for, and which is worth knowing before it happens rather than after.
4. If he wants a parent-level `AGENTS.md` honoured, say so: none exists today (M9), and the plan
   deliberately built nothing for a file that is not there. It is a small addition once there is
   a file to test against.
5. Note the cost shape: a multi-repo ticket now costs one short discovery session plus one work
   session, against N work sessions before. For a two-repo ticket that is roughly break-even on
   sessions and strictly better on the concurrency cap; for a five-repo ticket it is the whole
   point.
</operator_actions>

<output>
Write `.planning/quick/260909-tfm-parent-directory-multi-repo-mode-one-age/SUMMARY.md`.

It must state, at minimum:

- The pasted per-mapping repo counts from the live config, and an explicit sentence that the
  running Código 18 daemon was not restarted and not reconfigured.
- Both T109 pairs, with the two suite outcomes each and why each pair discriminates — and, if a
  pair came back neither-red, say so rather than reporting the intended outcome (T109).
- Every RED text quoted verbatim, with type errors labelled as type errors.
- The exact `npm run verify` count the runner printed.
- The five answers this task was asked for, each in one line: `prUrl` needs no change and why;
  `law watch`/`law say` targeting and how T118 survived; the two `AGENTS.md` cases and why nothing
  was built for either; what happens when the discovery session names a repo that is not in the
  mapping and when it names none; and that a partial delivery is `partial`, by a function that
  already existed.
- The two named ceilings: N children in `running` over-count the concurrency cap after a boot
  recovery, and a crash between worktree creation and the spawn degrades the ticket to the old
  per-repo fan-out on the next boot.

Report as findings, not fixes:

- `Worktree.baseBranch` is also reconstructed in `adapters.worktreeFromStore` from the toggles
  rather than from the resolved ref, so a recovery path can still see the old answer. Not touched
  here; say whether it is reachable.
- `run-engine.ts:239` still carries a private `resolveMapping` beside `infra/config.ts:99`'s.
- `RunBase.attempt` is still vestigial (T108) and this task did not use it.
- `src/ingress/poll.ts` still has no production caller (T122, reported not deleted).
- Whether `LAW_REPO` in the spawned session's environment still means anything for a session that
  covers N repositories, and what it was set to.
</output>
</content>
</invoke>
