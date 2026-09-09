---
task: "A second, silent, poll-only daemon instance for the Lahzo workspace"
id: 260909-nh6
type: quick
severity: P2
created: 2026-09-09
branch: main
files_modified:
  - src/domain/types.ts
  - src/domain/fakes.ts
  - src/infra/config.ts
  - src/infra/config.test.ts
  - src/infra/index.ts
  - src/outbound/quiet-linear.ts
  - src/outbound/quiet-linear.test.ts
  - src/orchestration/run-engine.ts
  - src/orchestration/run-engine.test.ts
  - src/cli/daemon.ts
  - src/cli/daemon-fixture.ts
  - src/cli/index.ts
  - src/cli/bin.test.ts
  - src/cli/wizard/config-writer.ts
  - src/cli/wizard/config-writer.test.ts
  - scripts/boot-smoke.ts
  - scripts/probe-agents-md.ts
  - README.md
  - docs/TRAPS.md
  - .planning/TRAPS.md
  # plus every test fixture `tsc` names when `MappingToggles` gains a required key
gate: npm run verify   # 679/679 + boot smoke green before; report the exact number after
must_haves:
  truths:
    - "A second daemon, pointed at its own config root, boots with no tunnel, no webhook registration, and no `NGROK_AUTHTOKEN` on disk — and picks work up on the tick that already exists."
    - "With comments off, no code path in the daemon can post or edit a Linear comment: the gate is on the Linear client itself, not on the six call sites, so a seventh call site added later is silent by construction."
    - "With issue mutation off, the daemon changes no issue state and adds no subscriber."
    - "A mapping may name the workflow states it picks up from, by state id or by state TYPE — never by name — and a value that is neither is a config load error, not a filter that silently never matches."
    - "`law start|status|watch|say --config-dir <dir>` all read that root, so a second instance has its own store, its own run log directory and its own `say.sock`."
    - "Every new field is optional with a default equal to today's behaviour, and `law setup` round-trips all three instead of erasing them on a re-run."
    - "The live Código 18 instance's behaviour is verified unchanged by loading its real config through the new schema and printing the resolved toggles — not asserted."
  artifacts:
    - "src/outbound/quiet-linear.ts — a `LinearClient` decorator that drops comment writes and issue mutations per `config.defaults`, logging each suppression."
    - "src/domain/types.ts — `MappingToggles.updateLinearIssue`, `ProjectMapping.pickupStates`, `Config.ingress`, `LINEAR_STATE_TYPES` (the READ vocabulary, deliberately wider than ports.ts's write-side `WorkflowStateType`)."
    - "src/orchestration/run-engine.ts — the pickup-state filter at the one site both producers pass through."
    - "src/cli/daemon.ts — `ingress: 'poll'` skips the tunnel, the registrar and the shutdown steps that pair with them."
    - "scripts/boot-smoke.ts — a poll-only phase that boots with no ngrok token and asserts `tunnel.probes.length === 0` and that no webhook was created."
    - "scripts/probe-agents-md.ts — executes `claude` against a scratch `AGENTS.md` and reports whether it was honoured."
    - ".planning/TRAPS.md T122/T123/T124; docs/TRAPS.md prose; README count 121 → 124."
  key_links:
    - "`daemon.ts` composition root → `quietLinear(...)` → every comment and issue write in the daemon. One wrapper, six write sites, no per-site guard to forget."
    - "`run-engine.handle('run.requested')` → the pickup filter — the single site the webhook mapper (`daemon.ts:262`) and the poll (`recovery.ts:275`) both reach."
    - "`daemon.ts` tick (`TICK_INTERVAL_MS`) → `recovery.reconcile` → `linear.listAssignedOpenIssues` — the poll-only instance's ONLY trigger, already built and already wired."
    - "`config-writer.mergeToggles` / `toProjectMapping` / `assembleConfig` → the three new fields. A field the wizard does not name is a field a `law setup` re-run deletes."
---

<objective>
Make it possible to run a SECOND daemon instance against the Lahzo workspace, silent and
poll-driven, without changing one byte of the live Código 18 instance's behaviour.

Four of the operator's six work items ship here. The fifth — parent-directory multi-repo mode
— does not fit and is proposed as its own task in `<deferred>` below, with the design
question it turns on stated rather than guessed at. The sixth collapses to a measurement plus
two paragraphs of documentation, because the thing it asks for already exists.
</objective>

<scope_decision>
**This does not fit one task. The split is 1/2/3/4/6 here, 5 next.**

Items 1–4 share one shape: a config field, read at one place, defaulting to today's
behaviour. Together they are ~4 small commits and they deliver a Lahzo instance the operator
can actually start today — pointed at a handful of Lahzo repos rather than all 33.

Item 5 (one run, one agent, cwd = the parent directory, N pull requests) is not a knob. It
changes what a run IS. Measured against the code (M9): it touches `fanout.ts`, the `RepoRun`
row's `repoDir`/`repoSlug`/`branch`/`worktreePath`/`prUrl` columns, `worktree.ts`,
`gatherEvidence`, `verdict.ts`, `deliver.ts`, `run-engine.dispatch`, `resolve-run.ts`,
`status.ts`, `watch.ts` and `say.ts`. And it turns on a decision nobody has made yet: **what
replaces worktree isolation when the working directory is 33 of the operator's live
checkouts.** That is a data-loss question about the operator's own work in progress, not a
sizing question. It gets its own task with its own measured facts.

Item 5 is NOT deferred because it is hard. It is deferred because (a) its context cost is a
whole task on its own and (b) it is blocked on one decision from the operator. Both reasons
are named in `<deferred>` with the options laid out.

**Consequence, stated plainly:** after this task the Lahzo instance works, silently, over
whatever repos its mapping lists — but N repos still means N runs and N agent sessions
(M9). Listing all 33 would produce 33 sessions per ticket. Do not do that until item 5
ships. The plan does not pretend otherwise.
</scope_decision>

<measured_facts>
Read from source at HEAD and from the tools on this machine. Nothing recalled.

**M1 — the brief's central citation is to dead code, and the live poll is somewhere else.**
`grep -rn 'pollForMissedWork' src/ scripts/ | grep -v '\.test\.'` returns exactly two lines:
its own declaration at `src/ingress/poll.ts:74`, and a doc-comment mention in
`src/orchestration/recovery.ts:49`. **There is no production caller.** The whole of
`src/ingress/poll.ts` is unreached outside its own test.

What actually runs is `reconcile()` at `src/orchestration/recovery.ts:242`, aliased
`sweepMissedWork` in `daemon.ts:59`, called at boot (`daemon.ts:711`) and on every tick
(`daemon.ts:860`). Its query is `recovery.ts:261` → `linear.listAssignedOpenIssues(config.botUserId)`
→ `linear-client.ts:240-252`:

```
filter: { assignee: { id: { eq: botUserId } },
          state:    { type: { nin: ['completed', 'canceled'] } } }
```

Same trigger the brief wanted ("assigned to me"), already wired, already on a 60-second timer
(`TICK_INTERVAL_MS = 60_000`, `daemon.ts:438`; `setInterval` at `:738`; guarded against
overlap at `:849`). **A poll-only instance therefore needs no new trigger and no new timer.**
That is the single biggest simplification in this plan and it comes from reading, not writing.

**M2 — the unconditional Linear writes are SIX sites, not three.** The brief names three:
`run-engine.ts:326` (`createComment`), `:331` (`setIssueState`), `:338` (`addSubscriber`) —
all inside `acknowledge()` at `:324-348`. Three more exist:

| site | call | when |
|---|---|---|
| `run-engine.ts:365` | `updateComment` | queue position moved |
| `run-engine.ts:513` | `createComment` | terminal comment, every run |
| `run-engine.ts:552` | `createComment` | multi-repo ticket rollup |
| `questions.ts:255-258` | `post` → `createComment` | **`questionsEnabled: false`** |
| `questions.ts:279-283` | `post` → `createComment` | question round cap reached |
| `questions.ts:322` | `post` → `createComment` | a real question |

**`questionsEnabled: false` does not mean silence — it posts a comment saying the question
flow is off** (`questions.ts:254-258`). The brief assumed turning questions off would be
enough for the Lahzo instance; it is not.

`refreshQueuePositions` (`:356-368`) is the one that is free: it reads the ack row from `kv`
and `continue`s when there is none, and `acknowledge` only writes that row `if (created)`
(`:329`). Suppress the create and this suppresses itself.

**M3 — `postLinearComments` has no production consumer at all.**
`grep -rn 'postLinearComments' src/ | grep -v '\.test\.'` →
`domain/types.ts:204` (declaration), `infra/config.ts:21` (schema),
`cli/wizard/config-writer.ts:53,98,129,158` (default, merge, override translation, review
label), `domain/fakes.ts:218`, `cli/daemon-fixture.ts:105`, and
`outbound/notify/notifier.ts:45` — **a doc comment, not code**. The channel that comment
refers to, `outbound/notify/linear-channel.ts`, contains no `createComment` call and writes
no comment (established and corrected in the `260909-lvl` SUMMARY, finding M11). Setting
`postLinearComments: false` today therefore changes nothing observable anywhere. It is a knob
that lies to the operator, and the wizard surfaces it in the review prompt
(`config-writer.ts:158`).

**M4 — `LinearIssue` already carries the state, so the pickup filter needs no new fetch.**
`ports.ts:367-368` declares `stateId: string` and `stateType: string`; `toLinearIssue`
populates both from `issue.state` (`linear-client.ts:139,142,155-156`). Note `stateType` is
typed `string` and NOT `WorkflowStateType` — deliberately, because `WorkflowStateType`
(`ports.ts:398`) is `'started' | 'completed' | 'canceled'`, the **write** vocabulary: the
three states the daemon is allowed to move an issue *to*. Lahzo's Todo is `unstarted`, which
that union does not contain. The read vocabulary is wider and this plan adds it separately
(see `<design>`).

**M5 — there is exactly one site both work producers pass through.**
`run-engine.handle()` case `'run.requested'`, `run-engine.ts:962-1044`. The webhook path
reaches it via `daemon.ts:639-651` (router `onEvent`) → `createIngressMapper` (`:262`) →
`engine.handle`. The poll path reaches it via `recovery.ts:275` → `engine.handle`. The issue
is fetched at `:1005` and the mapping resolved at `:1006`, both before `planSubRuns` at
`:1029`. A filter between those two lines covers both producers with one check.

**M6 — the `trigger: 'reconcile'` guard already handles "the ticket never leaves Todo".**
`run-engine.ts:1017-1024`: for a poll-sourced request, **any** prior run for the issue is
disqualifying (T107). Since the Lahzo instance will never move a ticket out of Todo (issue
mutation off), the ticket stays matching the pickup filter forever — and this guard is what
stops the poll re-running it every minute. It is already correct; nothing to add. The
operator's retry gesture stays "unassign, re-assign", which arrives as `trigger: 'assignment'`
— but only on the webhook path, which a poll-only instance does not have. **For a poll-only
instance the retry gesture is: delete the run row, or move the ticket out of and back into a
pickup state after clearing the run.** State this in the SUMMARY; do not build a retry.

**M7 — the four commands already take a root; only the CLI refuses to pass one.**
`bootDaemon(opts.configDir)` — `daemon.ts:87-88`, used at `:489`.
`runStatus(deps: StatusDeps = {})` with `root?` — `status.ts:83-96`.
`runWatch(deps: WatchDeps)` with `root?` — `watch.ts:141-142`.
`runSay(deps: SayDeps)` with `root?` — `say.ts:19-24`.
`index.ts:77,92,94,105` call all four with no root. Item 4 is a `parseArgs` option and four
argument sites.

**M8 — the ngrok token is demanded before the mode is known, and twice.**
`loadSecrets` (`config.ts:152-177`) throws `ConfigError` at `:175` on a missing
`NGROK_AUTHTOKEN`. `loadFoundation` (`infra/index.ts:16-24`) loads **config first**, then
secrets, then the logger — so the mode is already in hand when the check runs.
`tunnel.ts:47-49` separately re-checks `process.env.NGROK_AUTHTOKEN` (the environment, not
the token it was handed — `createTunnelManager(secrets.ngrokAuthtoken, log)` at
`daemon.ts:677`). Both checks must be reachable only in webhook mode.

The operator measured the second-instance failure: opening a second tunnel returns
`The endpoint 'https://given-relapsing-plop.ngrok-free.dev' is already online. ERR_NGROK_334`
— a **static-domain** conflict from the ngrok account configuration, not a tunnel-count
limit. `tunnel.ts:41` passes no `domain`, so the static domain comes from the account. A
poll-only instance opens no tunnel and never meets it.

**M9 — parent-directory mode, and why it is a task and not a knob.**
`find ~/ohmaseclaro/lahzo -maxdepth 2 -name .git | wc -l` → **33**.
`planSubRuns` (`fanout.ts:113`) produces one `RepoRun` per mapped repo;
`run-engine.ts:1029-1042` acquires one scheduler slot and calls `drive()` once per child.
33 repos is 33 runs, 33 worktrees, 33 `claude` sessions.
`prepareWorktree` (`worktree.ts:107`) shells `git -C <repoPath> worktree add`; the parent
directory is not a git repository, so the worktree model has nothing to attach to.
`RepoRun.prUrl` (`types.ts:99`) is one nullable column written once (`run-engine.ts:667`,
`:704`) — one run structurally records one pull request.

**M10 — `AGENTS.md` is already a convention the spawned `claude` honours.** Not built here,
found here. `strings` over the installed binary
(`/Users/augustoclaro/.local/share/claude/versions/2.1.263`, CLI 2.1.263) returns six
occurrences of `AGENTS.md`, including this verbatim string from the Codex-importer's
unmappable list:

```
Claude Code hardcodes CLAUDE.md / AGENTS.md discovery.
```

`CLAUDE.md` occurs 199 times; `LAW.md` occurs zero. So inventing `LAW.md` would be creating a
second convention next to a working one — the defect shape this repo has recorded six times.
**This is strong evidence and it has not been executed.** Task 4 executes it.

Two consequences that follow from the code without a probe: a repo's *committed*
`AGENTS.md`/`CLAUDE.md` is present in the worktree by construction (`git worktree add -b
branch path base` checks out `base`), so it is already discovered from the agent's cwd today;
and the operator's own `~/.claude/CLAUDE.md` already reaches every spawned agent, because
`--bare` is forbidden (TRAPS T2) precisely to keep `~/.claude` loaded.

**M11 — `law setup` erases fields it does not name, and this is the sharpest hazard in the
task.** `config-writer.ts` rebuilds `config.json` from a whitelist:
`mergeToggles` (`:196-208`) enumerates the seven toggles one at a time and drops anything
else, deliberately (T-08-19); `toProjectMapping` (`:200-236`) constructs a fresh
`ProjectMapping` carrying only `linearProjectId`, `linearTeamId`, `repos`, `displayName`,
`ownerTeamId`, `slackWebhookUrl`, `overrides`; `toWizardMappings` (`:245-283`) reads back the
same set. A top-level field like `ingress` has no round-trip at all.

**So a `law setup` re-run against the Lahzo root would silently delete `ingress`,
`pickupStates` and `updateLinearIssue` — turning the silent instance loud in a workspace the
operator's colleagues can see.** Teaching the writer to round-trip the three fields is not
polish; it is the difference between a supported second instance and a landmine.

**M12 — the instruments this plan asserts through already exist.**
`FakeLinearClient` (`fakes.ts:677-688`) records `comments`, `stateChanges`, `stateLookups`
and `subscribers`. `RecordingLinear` (`daemon-fixture.ts:152`) extends it, so the boot smoke
already has all four arrays. `probingTunnel()` (`daemon-fixture.ts:182`) exposes
`probes: number[]` — `probes.length === 0` is a direct proof that `tunnel.open` was never
called. `makeWorkspace` (`daemon-fixture.ts:93-136`) writes the config and a 0600 `.env`
carrying both secrets at `:133`.

**M13 — no test boots the daemon.** `grep -n 'bootDaemon' src/cli/*.test.ts` returns nothing;
`scripts/boot-smoke.ts` is the only caller besides `index.ts`. So the composition-root wiring
of anything added here can only be proven by the smoke — which is exactly what TRAPS T109
says the smoke is for.

**M14 — the live instance is running right now.** `~/.linear-auto-worker/` holds the Código
18 config with four mappings. `npm run clean && tsc` rewrites `dist/`, which the running
process does not re-read: node resolved its modules at boot. **Do not restart it as part of
this task.** It picks up these changes only when the operator restarts it, and at that moment
every new field must resolve to today's behaviour — which is what Task 1's real-config check
proves.
</measured_facts>

<design>

## The three new config fields, and why each defaults to today

```
Config.ingress?: 'webhook' | 'poll'            // absent → 'webhook'
MappingToggles.updateLinearIssue: boolean      // zod .default(true)
ProjectMapping.pickupStates?: string[]         // absent → no filter
```

`ingress` is on `Config`, not a CLI flag: it is a property of the instance, not of an
invocation. An operator who can start the daemon two different ways has two ways to be wrong.

`updateLinearIssue` sits in `MappingToggles` beside `postLinearComments` because it is the
same kind of thing, and it is **one** toggle covering both `setIssueState` and
`addSubscriber` rather than two. The justification the brief asked for: both are writes to
the issue RECORD (as opposed to writes to its comment thread), nobody has asked for the
combination "change the state but do not subscribe" or its inverse, and `addSubscriber` is
already inert on both instances anyway — it is gated on `config.operatorUserId`
(`run-engine.ts:336-345`), which no wizard step writes (`types.ts:283-294`). A second knob
would exist only to be set to the same value as the first.

`pickupStates` sits on `ProjectMapping` beside `slackWebhookUrl`, not in `MappingToggles`,
because `MappingToggles` is a **full** set on `Config.defaults` — putting it there would force
every config to state a value for a filter almost nobody wants.

## `pickupStates`: two accepted forms, one field, and a loud rejection of anything else

Each entry is **either** a Linear workflow-state UUID **or** a Linear workflow-state TYPE.
Never a name — `linear-client.ts:257-262` records why (teams rename "In Progress" to "Doing"
freely). The match is:

```
pickupStates.includes(issue.stateType) || pickupStates.includes(issue.stateId)
```

The load-bearing half is the validation, not the match. A typo'd entry that matches neither
form would disable the mapping **forever, silently** — the mapping would simply never pick
anything up, which is indistinguishable from a bot that is ignoring you. So `ConfigSchema`
refines `pickupStates`: every entry must be a member of `LINEAR_STATE_TYPES` or match a UUID,
and anything else is a `ConfigError` at load naming the offending value and the two accepted
forms.

`LINEAR_STATE_TYPES` goes in `src/domain/types.ts` (which imports nothing) as the **READ**
vocabulary, with a doc comment stating that it is deliberately wider than `ports.ts`'s
`WorkflowStateType` and must never be collapsed into it: that union is the three states the
daemon may write, this list is the six Linear may report. Two overlapping-but-different
vocabularies is this repo's signature defect; naming the difference in the file is what makes
keeping both safe.

**Confirm the six members against the shipped `.d.ts` before hardcoding them** — this
project's methodology is to read the installed package, not to recall. `grep` the SDK for the
workflow-state type union rather than trusting this plan's list.

For Lahzo, recommend the explicit id `43876da4-7abe-4268-8559-e4db36ca4247`. The type form
`unstarted` also works and is more durable across a workflow edit; the id is unambiguous
today. Say both in the operator instructions and let him choose.

The filter goes at `run-engine.ts:1006`, between `resolveMapping(issue)` and the
`planSubRuns` call — the one site both producers reach (M5) — and logs the drop with
`issueId`, `stateType`, `stateId` and the configured list. A filter that drops silently is
the same defect as a filter that never matches.

## Silence: one wrapper on the client, not six guards at six call sites

Six write sites (M2), in two modules, and `questions.ts:163`'s `post()` does not have the run
in scope. Guarding each of them is six chances to be wrong now and a seventh the next time
someone adds a comment site — the shape this codebase has produced repeatedly.

Instead: **`src/outbound/quiet-linear.ts`, a `LinearClient` decorator applied once in the
composition root.** It delegates everything, and drops four methods when their toggle is off:

| method | gated by |
|---|---|
| `createComment` | `postLinearComments` |
| `updateComment` | `postLinearComments` |
| `setIssueState` | `updateLinearIssue` |
| `addSubscriber` | `updateLinearIssue` |

`createComment` must still return a plausible `{ id }` — `run-engine.ts:329` writes it to
`kv` and `questions.ts:322` stores it for answer correlation. Return a synthetic id prefixed
so it is recognisable in a log and can never collide with a real Linear comment id. Nothing
downstream dereferences it against Linear except `updateComment`, which is also suppressed.

**Every suppression logs**, at `info`, with the method name and the issue id. Silence that
cannot be observed is indistinguishable from breakage — the same reasoning that gives
`guards.ts` its per-guard drop counters (`guards.ts:52-64`).

### The limitation this buys, stated rather than hidden

The wrapper sees an `issueId`, not a repo slug, so it cannot resolve a per-mapping override
without a Linear round trip per comment. **It reads `config.defaults` only: these two toggles
are instance-level.** That is exactly right for the operator's two instances — silence is a
property of the Lahzo daemon, not of one of its mappings — but it means a per-mapping
`overrides.postLinearComments` would be inert, which is the very defect being fixed, in
miniature.

So it is rejected rather than ignored: at boot, if any mapping's `overrides` sets
`postLinearComments` or `updateLinearIssue` to a value that **disagrees with**
`config.defaults`, refuse to start, naming the mapping and the field and saying the two are
instance-level. An override that *agrees* is inert and harmless and is left alone — which is
what keeps this from breaking the live config, whose wizard-written overrides may well carry
`postLinearComments: true` (`config-writer.ts:158`).

### What the wrapper does NOT gate

`getIssue`, `listAssignedOpenIssues`, `listComments`, `viewer`, `resolveWorkflowStateId` and
every webhook method: all reads, or the registration path a poll-only instance never reaches.
The Lahzo instance must keep reading Linear — that is how it gets work.

## Poll-only boot

In `bootDaemon`, `const pollOnly = config.ingress === 'poll'`. Then:

- **skip** `createTunnelManager` / `tunnel.open(port)` (`daemon.ts:677-689`);
- **skip** `webhookTeamId(config)`, `createWebhookRegistrar` and `registrar.reconcile`
  (`:696-700`) — and therefore also skip a boot failure mode for a config with no team;
- **skip** `tunnel.close()` and `registrar.disable()` in `shutdown` (`:804,810`);
- `publicUrl` becomes `''`, and `index.ts:86` prints an honest line for the empty case.

**Keep the loopback bind.** It costs nothing (127.0.0.1, ephemeral port, HMAC-verified
receiver), it keeps `DaemonHandle.port` a `number` so the smoke, `law start` and the whole
shutdown sequence are unchanged, and it makes poll-only a strict subset of webhook mode —
flipping one config field and restarting is the entire difference. Deleting the bind would
mean `port: number | null` and a branch at every consumer: more code, for a socket that is
not a surface.

**Keep the tick exactly as it is.** It is already the poll (M1). Nothing to add.

`loadSecrets` gains a second parameter for whether ngrok is required; `loadFoundation` already
has the config in hand before it calls secrets (`infra/index.ts:17-18`) and passes
`config.ingress !== 'poll'`. `Secrets.ngrokAuthtoken` becomes `string | undefined` and
`createLogger` registers it only when present. `tunnel.ts`'s own `process.env` check
(`:47-49`) is left alone — it is unreachable in poll mode because nothing constructs a tunnel.

`resolveStartedStates` (`daemon.ts:338-362`) is deliberately **left running** even when issue
mutation is off. It is one Linear call per team, it passes for the Client Onboarding team
(which has four `started` states), and removing it would mean the poll-only path skips a boot
check the webhook path keeps. Record it in the SUMMARY as a known no-op cost rather than
quietly special-casing it.

## `--config-dir`

One `parseArgs` option (`index.ts:49-59`), threaded to the four commands that already accept
a root (M7), plus USAGE. No environment variable: a shell alias
(`alias lawz='law --config-dir ~/.law-lahzo'`) covers the ergonomics without adding a second
way to configure the same thing. Say so in USAGE; add the env var only if the alias proves
insufficient.

## Agent instructions: nothing to build, one thing to measure

`AGENTS.md` is already discovered by the spawned `claude` (M10), and a repo's committed copy
is already in the worktree. **Do not invent `LAW.md`.** Do not add prompt injection for the
per-repo case — it would be a second mechanism next to a working one.

What is missing is proof by execution, which this project requires over inference. Task 4
adds `scripts/probe-agents-md.ts` alongside the two probe scripts that already exist. It is a
committed script rather than a shell one-liner for the reason T116/T117 record: a CLI upgrade
that silently drops `AGENTS.md` discovery is invisible in every other signal this system
emits, so the question needs to stay re-askable.

Known limitations to report, not fix: an **uncommitted** `AGENTS.md` never reaches a worktree;
and a **parent-level** `~/ohmaseclaro/lahzo/AGENTS.md` is only on the discovery path when the
cwd is the parent, which is item 5's mode. Both belong to the deferred task.

## Deliberately NOT doing

- **Not deleting `src/ingress/poll.ts`** (M1) despite it having no production caller. Deleting
  a module is a bigger decision than this task should make on its own, and T102 records that a
  dead export is not automatically a missing wire. It is reported as a finding and gets a
  TRAPS row.
- **Not adding wizard prompts** for the three new fields. The Lahzo `config.json` is
  hand-written by the operator (he supplies the Slack URL by hand anyway). The wizard learns
  to *preserve* them (M11); it does not learn to ask for them.
- **Not touching the live instance's config or process** (M14).
- **Not building multi-workspace support.** One instance, one Linear key, one bot user, one
  team — as chosen.
- **Not gating the notifier or Slack.** Slack stays on for Lahzo; that is the whole point of
  that instance's notification design, and `SlackChannel.enabled()`
  (`slack-channel.ts:56-58`) already gates itself on `notifySlack` plus a configured webhook.

</design>

<constraints>
- Stay on `main`. Four commits, one per task, each leaving the tree releasable.
- `npm run verify` is 679/679 plus a boot smoke and must stay green. **Report the exact number
  the runner prints — do not assume it.**
- **Never `mock.method`** (T88).
- Tests colocated in `src/` as `*.test.ts`.
- **Falsify every new check** (T71/T76) and paste the RED text actually seen. Where RED at
  HEAD is a `tsc` error rather than an assertion failure, say so and paste the compiler
  message — a type error is a legitimate RED, but calling it an assertion failure is not.
- **Apply the T109 wiring procedure to the silence gates.** The pair is named in Task 2.
- No fixture may carry a scannable credential literal — this is a public repository with
  unauthenticated CI. Slack webhook URLs and API keys never enter a test file or a SUMMARY.
- **Do not restart the live daemon** (M14). Do not read, edit or copy
  `~/.linear-auto-worker/config.json` into the repository — it holds a bearer secret
  (`types.ts:266-276`). The real-config check in Task 1 runs it through `loadConfig` in a
  throwaway `node -e` and prints only resolved booleans.
- Confirm `LINEAR_STATE_TYPES` against the installed `@linear/sdk` `.d.ts` before hardcoding.
</constraints>

<tasks>

<task type="tracer" tdd="true">
  <name>Task 1: The three fields exist, are validated, and survive a `law setup` re-run</name>
  <read_first>
    - `src/domain/types.ts:190-302` — `MappingToggles` (`:203-212`), `RepoMapping`,
      `ProjectMapping` (`:232-264`, especially `slackWebhookUrl` `:261` and `overrides` `:263`),
      `Config` (`:277-302`), and `resolveToggles` (`:309-314`).
    - `src/domain/ports.ts:389-398` — `WorkflowStateType` and the 07-04 correction note that
      explains why it is the write vocabulary.
    - `src/infra/config.ts:18-90` — `TogglesSchema` and its `satisfies` clause,
      `RepoMappingSchema`, `ProjectMappingSchema` and its `.refine`, `ConfigSchema`,
      `loadConfig`; and `:145-177` — `Secrets` / `loadSecrets`.
    - `src/infra/index.ts:16-24` — `loadFoundation`'s ordering comment.
    - `src/cli/wizard/config-writer.ts:40-61` (`DEFAULT_TOGGLES`), `:190-208`
      (`mergeToggles`), `:200-236` (`toProjectMapping`), `:245-283` (`toWizardMappings`),
      `:296-320` (`AssembleConfigInput` and assembly).
    - `src/cli/wizard/config-writer.test.ts` — the existing round-trip assertions.
    - `src/domain/fakes.ts:210-225` and `src/cli/daemon-fixture.ts:96-130` — the two full
      `MappingToggles` literals that `tsc` will name.
    - `node_modules/@linear/sdk` — the workflow-state type union, read from the shipped
      `.d.ts` (M4 / methodology).
  </read_first>
  <behavior>
    Write these FIRST and watch them fail.

    - **A config written before today still loads, and resolves to today's behaviour.** Parse
      a fixture carrying no `ingress`, no `updateLinearIssue` and no `pickupStates`, then
      assert `resolveToggles(parsed.defaults, mapping)` yields `postLinearComments: true` and
      `updateLinearIssue: true`, and that `parsed.ingress` is absent. RED at HEAD: the field
      does not exist on the type.
    - **A pickup state may be a type.** A mapping with `pickupStates: ['unstarted']` parses.
    - **A pickup state may be an id.** A mapping with a UUID entry parses.
    - **Anything else is a load error.** A mapping with an entry that is neither a known type
      nor a UUID throws `ConfigError`, and the message contains the offending value and names
      both accepted forms. This is the assertion that matters most: without it a typo
      disables a mapping forever and silently.
    - **`ingress` accepts only the two values.** A third value is a `ConfigError`.
    - **A `law setup` re-run preserves all three.** Feed `assembleConfig` an `existing` config
      carrying `ingress: 'poll'`, a mapping with `pickupStates`, and
      `defaults.updateLinearIssue: false`, and assert all three survive into the output. RED
      at HEAD by construction — the writer's whitelist does not name them (M11).
    - **Secrets are optional only in poll mode.** `loadSecrets(root, false)` on a `.env`
      holding only `LINEAR_API_KEY` returns; `loadSecrets(root, true)` on the same file throws
      naming `NGROK_AUTHTOKEN`. Keep the existing 0600 mode check assertions untouched.
  </behavior>
  <action>
    In `src/domain/types.ts`: add `updateLinearIssue: boolean` to `MappingToggles` with a doc
    comment saying it covers the two issue-record writes and naming why they share one toggle
    (`<design>`). Add `pickupStates?: string[]` to `ProjectMapping` beside `slackWebhookUrl`,
    documenting the two accepted forms and that a name is never one of them, cross-referencing
    `linear-client.ts:257-262`. Add `ingress?: 'webhook' | 'poll'` to `Config`, documenting
    that absent means webhook and that it is a property of the instance rather than of an
    invocation. Add `LINEAR_STATE_TYPES` as the read vocabulary, with a doc comment stating it
    is deliberately wider than `ports.ts`'s `WorkflowStateType`, that the latter is the three
    states the daemon may WRITE, and that the two must not be unified. Populate it from the
    SDK's own union, read from the installed `.d.ts`.

    In `src/infra/config.ts`: add `updateLinearIssue: z.boolean().default(true)` to
    `TogglesSchema`. If the `satisfies z.ZodType<MappingToggles>` clause fights the defaulted
    field, report the exact compiler text in the SUMMARY before choosing a fallback — do not
    silently drop the `satisfies`, which is what keeps this schema and the domain contract from
    drifting (`config.ts:9-16`). Add `pickupStates` to `ProjectMappingSchema` as an optional
    array with a `.refine` implementing the validation above; write the message so it names
    the value it rejected and both accepted forms. Add `ingress` to `ConfigSchema` as an
    optional enum. Give `loadSecrets` a second parameter controlling whether the ngrok token is
    required, defaulting to required so every existing caller keeps today's behaviour, and make
    `Secrets.ngrokAuthtoken` optional.

    In `src/infra/index.ts`: pass the mode through — `loadSecrets(root, config.ingress !== 'poll')`
    — and register the ngrok token with the logger only when it is present. Leave the ordering
    comment's claim true: config is still read before secrets, which is what makes this
    possible at all.

    In `src/cli/wizard/config-writer.ts` (M11, and this half is not optional): teach
    `mergeToggles` the new toggle; carry `pickupStates` through `toProjectMapping` and
    `toWizardMappings` with the same conditional-assignment discipline `slackWebhookUrl` uses
    at `:231-232`; and preserve a top-level `ingress` from `existing` through assembly. Add a
    comment at `mergeToggles` recording that a field this function does not name is a field a
    `law setup` re-run deletes, and that for the second instance that would mean turning a
    silent daemon loud in a shared workspace.

    Update every full `MappingToggles` literal `tsc` names — at minimum `config-writer.ts`'s
    `DEFAULT_TOGGLES`, `fakes.ts` and `daemon-fixture.ts`.
  </action>
  <verify>
    <automated>npm run verify</automated>
    Into the SUMMARY:
    - The RED text for each of the seven new assertions, verbatim, at HEAD, with type errors
      labelled as type errors.
    - **The live-instance check, executed rather than asserted.** A throwaway
      `node -e` that imports the built `loadConfig` and `resolveToggles`, loads
      `~/.linear-auto-worker/config.json`, and prints for the top-level config and for each
      mapping: `ingress`, `postLinearComments`, `updateLinearIssue`, and whether
      `pickupStates` is present. Paste the output. Every line must read as today's behaviour:
      webhook ingress, comments on, issue mutation on, no pickup filter. **Print only these
      resolved values — never the mappings themselves, never a Slack URL.**
    - The exact `LINEAR_STATE_TYPES` members and the `.d.ts` path they were read from.
    - Whether the `satisfies` clause survived the defaulted field, with the compiler text if
      it did not.
  </verify>
  <done>
    All three fields exist, are validated with a loud rejection of an unrecognised pickup
    state, round-trip through `law setup`, and resolve to today's behaviour on the operator's
    real config — demonstrated by running it. Poll mode no longer requires an ngrok token at
    the loader. Nothing yet reads any of the three. `npm run verify` green. Committed.
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Silence, at the client; and the pickup filter, at the one site</name>
  <read_first>
    - `src/orchestration/run-engine.ts:244-254` (the `kv` key helpers and why the ack id lives
      there), `:283-300` (`botBody`, `attempt`), `:302-348` (`ackText`, `acknowledge` — all
      three writes), `:350-368` (`refreshQueuePositions` and its no-op on a missing ack),
      `:495-515` (`announceTerminal`), `:517-556` (`rollupLine`, `announceTicketRollup`),
      `:960-1044` (`handle`, case `run.requested` — especially the two guards at `:1007-1024`,
      the fetch at `:1005` and the mapping resolve at `:1006`).
    - `src/orchestration/questions.ts:146-175` (`botBody`, `post`), `:217-230` (`togglesFor`
      and the first `post` caller), `:244-262` (the disabled-questions branch that POSTS),
      `:276-290` (the round-cap branch that POSTS), `:315-325` (the real question).
    - `src/domain/ports.ts:399-430` — the `LinearClient` interface in full; the decorator must
      implement every member.
    - `src/outbound/linear-client.ts:284-292` — `setIssueState` and its `noteSelfWrite` call
      (T49); the decorator must not change what that means for the webhook instance.
    - `src/domain/fakes.ts:674-780` — `FakeLinearClient`'s four recording arrays.
    - `src/cli/daemon.ts:498-524` (client construction and the two identity resolutions),
      `:536-539` (`mappingIndex`, `adapterDeps`), `:560-580` (engine and questions wiring).
    - `src/cli/adapters.ts:47-71` — `mappingIndex` / `togglesFor`, for the shape of a
      slug→mapping lookup; the decorator does NOT use it (it has no slug), and the SUMMARY
      should say why.
  </read_first>
  <behavior>
    Write these FIRST.

    Unit, against the decorator alone (`src/outbound/quiet-linear.test.ts`), over a
    `FakeLinearClient`:
    - With comments off, `createComment` records nothing on the fake and still returns an
      object with a non-empty `id`; `updateComment` records nothing and does not throw.
    - With comments off but issue mutation on, `setIssueState` still records on the fake.
    - With issue mutation off, `setIssueState` and `addSubscriber` record nothing.
    - With both on, all four delegate unchanged — the non-regression that keeps the live
      instance's path identical.
    - Every suppression emits one log line naming the method.
    - Reads delegate: `getIssue`, `listAssignedOpenIssues`, `listComments`, `viewer`,
      `resolveWorkflowStateId` are unaffected by either toggle.

    Integration, at the engine (`src/orchestration/run-engine.test.ts`), which is what proves
    the wire rather than the function:
    - Drive one `run.requested` to a terminal outcome with the engine's Linear client wrapped
      and both toggles off. Assert the fake's `comments`, `stateChanges` and `subscribers` are
      all empty at the end — one assertion per array, so a failure says which one leaked.
    - Same run with both toggles on: `comments` is non-empty. RED at HEAD for the first case
      (three writes land); GREEN at HEAD for the second, and that one is the non-regression —
      do not "repair" it if it passes.

    The pickup filter, also at the engine:
    - A mapping with `pickupStates` naming a type the issue does not have: no run row is
      created, and the log line names the issue's `stateType` and `stateId`.
    - The same mapping, an issue whose `stateType` matches: a run row is created.
    - The same mapping, an issue whose `stateId` matches an entry: a run row is created.
    - A mapping with no `pickupStates` at all: a run row is created whatever the state. This
      is the live instance's case and must be GREEN at HEAD.
    - Both producers: run the matching and non-matching cases through
      `trigger: 'assignment'` and `trigger: 'reconcile'` and require the same outcome. One
      filter, both doors.

    Boot-time refusal:
    - A config whose mapping `overrides` disagrees with `defaults` on either toggle is
      refused with a message naming the mapping and the field.
    - An override that agrees is accepted. This is the assertion that stops the refusal from
      breaking the live config (M3, `config-writer.ts:158`).
  </behavior>
  <action>
    Create `src/outbound/quiet-linear.ts`. It exports one function returning a `LinearClient`
    that delegates to the wrapped client and drops the four write methods per the table in
    `<design>`. Its header must state, in this order: that the gate lives here rather than at
    the six call sites because six guards are six chances to forget and a seventh call site
    would arrive loud; that it reads `config.defaults` only, because the write methods are
    handed an issue id and resolving a mapping per comment would be a Linear round trip per
    comment; and that this instance-level limitation is enforced at boot rather than tolerated.
    Give the synthetic comment id a recognisable prefix and say in a comment which two callers
    consume it (`run-engine.ts:329`, `questions.ts:322`) and that neither dereferences it
    against Linear.

    In `src/cli/daemon.ts`, wrap the client once, immediately after it is constructed at
    `:505-510` and before anything takes a reference to it, so the registrar, the router, the
    recovery sweep, the engine and the questions module all receive the same wrapped instance.
    Add the boot-time override check beside it, before the first Linear call, so a
    misconfigured instance fails at start rather than on its first ticket — the same reasoning
    `resolveStartedStates` gives at `:329-337`.

    In `src/orchestration/run-engine.ts`, add the pickup filter between the mapping resolve and
    the fan-out plan. Read the list off the raw mapping the engine's own `resolveMapping`
    (`:239-242`) already returns. When the list is present and matches neither the issue's
    `stateType` nor its `stateId`, log at `info` with the issue id, both state fields and the
    configured list, and return. Absent list means no filter. Put a comment on the filter
    naming this as the one site both producers pass through, with the two paths from M5, so
    nobody adds a second copy at the poll.

    Change nothing in `questions.ts` and nothing at the six write sites. That is the point of
    the wrapper, and the SUMMARY should say so explicitly: the two `post()` calls at
    `questions.ts:255` and `:279` — including the one that fires precisely when questions are
    turned OFF — are silenced without being touched.
  </action>
  <verify>
    <automated>npm run verify</automated>
    Into the SUMMARY:
    - Every RED text, verbatim.
    - **The T109 wiring procedure, run exactly as specified.** Delete only the wrapping call in
      `daemon.ts` so the raw client is passed through — it still compiles, because the wrapper
      returns the same interface. Rebuild, then run the two suites SEPARATELY and paste both
      outcomes: `node --test dist/src/outbound/quiet-linear.test.js` must stay **GREEN** (the
      decorator itself is unchanged and correct), and the engine-level silence assertions must
      go **RED**. Restore the call. Both green, or both red, means the assertion targets the
      module rather than the wiring — say so and repair it before claiming the fix. Per T109 a
      first pass that goes neither-red is the normal outcome, not evidence the procedure was
      done wrong.
    - A second falsification for the filter: delete the `return` from the non-matching branch,
      rebuild, run `node --test dist/src/orchestration/run-engine.test.js`, paste the RED,
      restore.
    - A count, from the built output, of how many distinct daemon code paths reach
      `createComment` — and the statement that all of them are now behind one gate.
  </verify>
  <done>
    With `postLinearComments: false` in `defaults`, no daemon path posts or edits a Linear
    comment — proven by driving a real run and reading the fake's arrays, not by reading the
    guards. With `updateLinearIssue: false`, no issue state change and no subscriber. A
    mapping may restrict pickup to named states, and both producers honour it. The live
    instance's config resolves to both toggles on and no filter. `npm run verify` green.
    Committed.
  </done>
</task>

<task type="auto">
  <name>Task 3: Poll-only boot, and `--config-dir` on the four commands</name>
  <read_first>
    - `src/cli/daemon.ts:21-41` (the boot-order header — it must end this task still true),
      `:86-120` (`BootOptions`), `:122-150` (`DaemonHandle`, especially `publicUrl` `:134`),
      `:488-524` (boot steps 1-2b), `:654-700` (bind, tunnel, registrar), `:702-742` (sweep,
      scheduler start, tick, the ready log line), `:772-826` (`shutdown`, especially steps 3-5).
    - `src/ingress/tunnel.ts:33-60` — `openTunnel` and its `process.env` pre-check (M8).
    - `src/ingress/registrar.ts:205-232` — `createWebhookRegistrar`'s narrow port.
    - `src/cli/index.ts` in full — USAGE, `parseArgs`, and the four call sites (M7).
    - `src/cli/status.ts:83-96`, `src/cli/watch.ts:141-150`, `src/cli/say.ts:19-40` — the
      `root?` each already accepts.
    - `src/cli/bin.test.ts` — how the CLI surface is currently asserted.
    - `scripts/boot-smoke.ts:1-33` (what it claims to prove) and `:86-120` (setup and boot).
    - `src/cli/daemon-fixture.ts:93-150` (`makeWorkspace`), `:152-172` (`RecordingLinear`),
      `:182-215` (`probingTunnel` and its `probes` array).
  </read_first>
  <behavior>
    The instrument here is the boot smoke, because no test boots the daemon (M13). Extend
    `makeWorkspace` to take options for the config shape and for whether the `.env` carries an
    ngrok token, then add a poll-only phase to `scripts/boot-smoke.ts` on its own throwaway
    workspace. It must assert:

    - The daemon boots with `ingress: 'poll'` and an `.env` holding **only** `LINEAR_API_KEY`.
      RED at HEAD: `loadSecrets` throws on the missing token. (Task 1 made this possible; this
      is where it is exercised end to end.)
    - `tunnel.probes.length === 0` — `tunnel.open` was never called. This is the assertion the
      whole mode rests on, and it reads a recorded fact rather than an absence of a log line.
    - No webhook was created: the fake's webhook list is empty and no webhook id was persisted
      under the registrar's `kv` key.
    - The receiver is still bound and still accepting on its loopback port, and `publicUrl` is
      empty.
    - The poll still finds work: seed the fake with an issue already assigned to the bot, boot,
      and assert a `queued` run and its genesis `run_events` row land in the real SQLite file —
      through the store, against the real schema, exactly as the webhook phase does. **This is
      the assertion that proves a poll-only instance is a working instance and not just a
      quiet one.**
    - Shutdown is clean with no tunnel and no registrar to close: it completes, the port stops
      accepting, and a second call is safe.

    For the CLI: assert in `bin.test.ts` that the option is parsed and reaches each command,
    and separately — executed, in the verify output — run `law status --config-dir <tmpdir>`
    against a directory with no store and confirm it reports that root rather than the
    operator's. A flag that parses but does not reach the callee is precisely this repo's
    repeated defect.
  </behavior>
  <action>
    In `bootDaemon`, derive the mode once from the config and use it to skip the tunnel, the
    registrar and their two shutdown steps, per `<design>`. Keep the loopback bind and write
    the reason down at the skip site, so the next reader does not "finish the job" by deleting
    it. Keep `server.listening` assertion semantics intact for webhook mode. Update the
    boot-order header at `:21-41` to describe both modes — a header that describes one of two
    paths is worse than no header.

    Make the ready log line and `index.ts`'s printed line honest for the empty `publicUrl`
    case, naming poll-only and the absence of a tunnel and a webhook. An operator reading
    `law start`'s first line must be able to tell which of his two daemons he just started.

    In `src/cli/index.ts`, add the option to `parseArgs`, thread it to all four commands, and
    document it in USAGE — including one line saying a second instance needs its own root and
    that a shell alias is the intended ergonomics. Keep the T88 unknown-option handling intact:
    the new option must not change what `law --help` and an unknown flag do.

    Extend `makeWorkspace` with an options parameter rather than adding a second fixture
    function. Two workspace builders is two things to keep in step, and the existing callers
    must keep working with no argument.
  </action>
  <verify>
    <automated>npm run verify</automated>
    Into the SUMMARY:
    - The full boot-smoke output for both phases, so the poll-only assertions are visible as
      `ok` lines beside the existing ones.
    - The RED text from before the change for at least: booting with no ngrok token, and
      `tunnel.probes.length === 0`.
    - A falsification: re-enable the tunnel construction in poll mode, rebuild, run
      `npm run smoke`, paste the RED from the `probes` assertion, restore.
    - The executed `law status --config-dir <tmpdir>` output, and the same command with no flag
      showing it reads the default root. Two lines, pasted.
    - The exact `law start` first line for each mode.
  </verify>
  <done>
    A daemon boots poll-only with no tunnel, no webhook and no ngrok token, finds bot-assigned
    work through the tick that already existed, and shuts down cleanly — proven by the smoke on
    a real SQLite file. All four commands accept `--config-dir` and demonstrably read it.
    Webhook mode is byte-for-byte unchanged. `npm run verify` green. Committed.
  </done>
</task>

<task type="auto">
  <name>Task 4: Execute the AGENTS.md question, then write down what was learned</name>
  <read_first>
    - `scripts/probe-stream-input.ts` and `scripts/probe-gsd-allowlist.ts` in full — the shape,
      the output convention, and how each states what it did and did not establish.
    - `src/execution/agent-args.ts:30-104` — `PERMISSION_MODE`, `ALLOWED_TOOLS`,
      `OUTPUT_FORMAT`, `INPUT_FORMAT` and the T113 note that the prompt travels on stdin.
    - `src/execution/prompt.ts:81-129` — `buildAgentPrompt`, so the SUMMARY can state exactly
      where an injection would go if the deferred task needs one.
    - `.planning/TRAPS.md:126` — the third table's header row, for the five-column shape.
    - `docs/TRAPS.md:1-22` (the count and the framing) and its section headings, to place each
      new entry.
    - `README.md:199-221` — the count and the sample list.
  </read_first>
  <behavior>
    The probe is the check, and it must run the binary. Give it a scratch directory containing
    an `AGENTS.md` whose only content is an instruction to answer with one distinctive token,
    invoke `claude` non-interactively in that directory with this project's own permission
    mode, and report whether the token came back. It must print, unambiguously, one of:
    honoured, not honoured, or inconclusive — and it must survive the failure modes the two
    existing probes were bitten by (T117: a diagnostic that crashes while printing its own
    conclusion). Run the same shape a second time with the file named `CLAUDE.md`, so the
    output states which of the two names was honoured rather than assuming both.

    Delete the scratch directory afterwards. Print the CLI version the probe measured against,
    because that is the fact that goes stale.
  </behavior>
  <action>
    Add `scripts/probe-agents-md.ts`. Its header states what it establishes and what it cannot:
    it can show the file was read in a `-p` invocation from that working directory; it cannot
    show anything about a nested directory the agent never opens a file in, and it says so.
    Note in the header that it exists because a CLI upgrade silently dropping this discovery
    would be invisible in every other signal this daemon emits — the T116/T117 lesson.

    Run it. Then write the outcome into three places.

    `.planning/TRAPS.md`, three rows in the third table matching the five-column shape:

    **T122** — a dead module whose doc comment reads exactly like the live one. The whole of
    `src/ingress/poll.ts` has had no production caller since it was written; the live poll is
    `recovery.reconcile`, reached from the daemon's tick. Failure mode: the module's header
    describes itself as the reconciliation poll and defers only the *timer* to a later phase,
    so a reader — including the brief that commissioned this task — cites it as the live
    trigger and reasons about the wrong query. Correct move: when two modules claim one job,
    find the caller before reading either header; and per T102, a dead export is not
    automatically a missing wire — this one is reported, not deleted.

    **T123** — a toggle the wizard writes, surfaces in its review prompt, and nothing consults.
    `postLinearComments` reached six layers as a schema field and had exactly one mention in
    production code: a doc comment in `notifier.ts` referring to a channel that writes no
    comments. Failure mode: an operator sets it to false to make the bot quiet on a shared
    workspace and the bot keeps commenting, with every signal reporting success. Correct move:
    gate at the client, not at the call sites, so the guard is structural; and treat a toggle
    with no `grep` hit outside its own schema as unimplemented until proven otherwise.

    **T124** — a second ngrok tunnel fails with a message that names the wrong cause.
    `ERR_NGROK_334`, "the endpoint … is already online", reads as a free-plan tunnel-count
    limit and is a static-domain conflict: the account's reserved domain is already bound by
    the first process. Failure mode: an operator concludes a second instance is impossible on
    his plan and designs around a limit that does not exist. Correct move: read the endpoint in
    the message — it names the domain, not a quota — and note that an instance with no ingress
    tunnel never meets it at all.

    Then `docs/TRAPS.md`: T124 under the existing ngrok section; T122 and T123 under the
    process section, and the paragraph there should say plainly that these are the seventh and
    eighth instances of one shape in this repository, because the count is the lesson. Update
    the opening count from one hundred and twenty-one to one hundred and twenty-four, and
    `README.md`'s ledger count from 121 to 124.

    Finally, add a short section to `README.md` — or to `docs/agent-invocation.md` if it fits
    better there, decide by reading it — recording what the probe established about per-project
    agent instruction files: which filenames the spawned agent honours, that a committed one is
    already in the worktree and needs no wiring, and the two cases that are not covered
    (uncommitted files, and a parent-directory file outside the worktree). Do not describe the
    deferred parent-directory mode as though it exists.
  </action>
  <verify>
    <automated>npm run verify</automated>
    Plus, pasted into the SUMMARY:
    - The probe's full output for both filenames, and the CLI version it measured against.
    - `grep -c '^| T' .planning/TRAPS.md` increased by exactly 3.
    - The two count lines, read back after the edit, both showing 124.
    - A falsification of the probe itself: point it at a scratch directory with **no**
      instruction file and confirm it reports not-honoured rather than honoured. A probe that
      cannot fail is not a probe (T71/T76).
  </verify>
  <done>
    The `AGENTS.md` question is answered by running the binary, not by inference; the answer
    and its limits are written where a future reader will find them; three traps are in the
    ledger with their measurements; both counts read 124. `npm run verify` green. Committed.
  </done>
</task>

</tasks>

<success_criteria>
- A second daemon started with `law start --config-dir <lahzo-root>` boots with no tunnel, no
  webhook and no ngrok token, and picks up bot-assigned issues on the existing tick.
- With comments and issue mutation off, driving a run end to end leaves the fake Linear
  client's `comments`, `stateChanges` and `subscribers` arrays empty — including the branch
  that fires when the question flow is disabled.
- A mapping restricts pickup to named workflow states, by id or by type; an unrecognised
  entry is a load error naming the value and both accepted forms.
- All four commands accept and demonstrably use `--config-dir`.
- Loading the operator's real `~/.linear-auto-worker/config.json` through the new schema
  prints webhook ingress, comments on, issue mutation on and no pickup filter — pasted output,
  not a claim. The live process is not restarted.
- A `law setup` re-run preserves `ingress`, `pickupStates` and `updateLinearIssue`.
- The T109 pair for the silence wiring is recorded: decorator suite GREEN, engine suite RED.
- `npm run verify` green with the exact count reported.
- The SUMMARY states, in its own words, that parent-directory multi-repo mode did not ship and
  that until it does, N mapped repos still cost N agent sessions.
</success_criteria>

<operator_actions>
What the operator must do by hand once this ships. None of it can be done by the executor, and
none of it may be pasted into a chat.

1. **Create the second config root**, e.g. `~/.law-lahzo/`, mode 0700.
2. **Write `~/.law-lahzo/.env` at mode 0600 with `LINEAR_API_KEY` only.** No
   `NGROK_AUTHTOKEN` — a poll-only instance does not need one, and its absence is now a
   supported configuration rather than a boot failure. Either run `law setup` against that root
   and use its masked prompt, or write the file directly.
3. **Write `~/.law-lahzo/config.json` at mode 0600.** It is not a file that can be safely
   shared: a mapping's `slackWebhookUrl` is a bearer credential (`types.ts:266-276`). Set:
   - `ingress: "poll"`
   - `botUserId: "60d5a47c-b5f7-4492-a268-2c3b03660345"` and
     `teamId: "138d2d22-9687-4645-92af-4d0b62a81857"`
   - `dbPath` and `worktreeRoot` under `~/.law-lahzo/` — **not** under the live root. Two
     instances sharing a store would be two daemons driving one queue.
   - `defaults.postLinearComments: false`, `defaults.updateLinearIssue: false`,
     `defaults.notifySlack: true`, `defaults.draftPr: true`,
     `defaults.questionsEnabled: false`. These two silence toggles must be in `defaults`, not
     in a mapping's `overrides` — the daemon refuses to start if an override disagrees with
     `defaults`, and says why.
   - one mapping keyed by the Client Onboarding team id, with
     `pickupStates: ["43876da4-7abe-4268-8559-e4db36ca4247"]` (the Todo state id; the type form
     `"unstarted"` also works and survives a workflow edit better), a `slackWebhookUrl` set to
     his **personal** webhook, and a `repos` list.
   - **Keep that `repos` list short for now.** Until parent-directory mode ships, every entry
     is another run and another `claude` session per ticket.
4. **Do not point the second instance at the live root, and do not re-run `law setup` against
   the live root** while checking any of this.
5. Consider a shell alias: `alias lawz='law --config-dir ~/.law-lahzo'`.
6. Note that the branch name comes from Linear's own `branchName` and is visible to
   colleagues, and that Linear may auto-link and auto-move the ticket off the back of it. That
   was accepted; nothing here designs around it.
</operator_actions>

<deferred>
## Proposed follow-up task: parent-directory multi-repo mode

One run, one agent session, cwd = `~/ohmaseclaro/lahzo`, one pull request per repo the agent
actually touched. Deferred for two of the three legitimate reasons: its context cost is a full
task on its own (M9 lists twelve modules), and it is blocked on one decision only the operator
can make.

**The blocking question: what replaces worktree isolation?**

Today every run works in a daemon-owned worktree, deliberately never inside the operator's
clone (`worktree.ts:100-106`, ASVS V12 / threat T-04-06). A parent directory containing 33
live checkouts has no worktree to attach to, and those 33 directories hold the operator's own
work in progress. Three shapes, with what each costs:

**(a) Work directly in the operator's checkouts.** Cheapest to build, and the agent commits
onto whatever branch each repo currently has checked out — possibly `main`, possibly on top of
uncommitted work. `gates.ts`'s default-branch refusal fires only at push time, after the
commits exist. This is the option that can lose the operator's work, and it should be rejected
in writing rather than left as the default because it is the smallest diff.

**(b) Worktrees for all 33, up front, in a daemon-owned parent.** Preserves every existing
safety property and reuses `prepareWorktree` and `deliver` unchanged. Costs 33 `git fetch` +
33 `git worktree add` per ticket, and creates 33 branches per ticket across 33 repositories,
for a ticket that touches two.

**(c) Two phases — a cheap read-only session to name the repos, then worktrees for exactly
those.** One extra `claude` session per ticket. Keeps worktree isolation, keeps the per-repo
delivery path the operator asked to reuse, and pays the worktree cost only for repos the work
actually needs. **This is the recommended shape**, and it is what the follow-up should be
planned around unless the operator prefers (b)'s simplicity.

**The other questions the follow-up must answer, all named in the brief:** which base branch
per repo when the mapping declares one; what happens to a repo carrying uncommitted changes
when the run starts; how one run row records N pull requests when `prUrl` is one column (M11);
and how `law watch` / `law say` target a run that now maps to N PRs — without regressing T118,
which just made every disambiguation line a valid target.

It should also carry the two `AGENTS.md` cases this task leaves open (M10): a parent-level
instruction file, which is only on the discovery path once the cwd is the parent, and an
uncommitted per-repo file, which never reaches a worktree. If either needs explicit injection,
`buildAgentPrompt` (`prompt.ts:81`) is where it goes, and the file content is untrusted repo
text that belongs inside the existing delimiter — treated exactly like the ticket body, not
appended to the trusted half.
</deferred>

<output>
Write `.planning/quick/260909-nh6-second-stealth-poll-only-instance-for-la/SUMMARY.md`.

It must state, at minimum:

- The pasted output of the live-config check, and an explicit sentence that the running Código
  18 daemon was not restarted and not reconfigured.
- The T109 pair observed for the silence wiring, and every RED text quoted verbatim, with type
  errors labelled as type errors.
- The exact `npm run verify` count the runner printed.
- What the `AGENTS.md` probe returned, for both filenames, against which CLI version.
- Which of the operator's six work items shipped and which did not, and that N mapped repos
  still cost N agent sessions until the deferred task lands.
- The instance-level limitation of the silence toggles, and the boot-time refusal that keeps
  it from being silent.

Report as findings, not fixes:

- `src/ingress/poll.ts` has no production caller and never had one; the live poll is
  `recovery.reconcile`. Reported, not deleted (T102).
- `questionsEnabled: false` posts a Linear comment saying the question flow is off
  (`questions.ts:255-258`), which is the opposite of what the name suggests to an operator
  configuring a silent instance. Silenced here by the wrapper; the naming is left alone.
- `run-engine.ts:239` carries a private `resolveMapping` beside `infra/config.ts:99`'s. Two
  implementations of one lookup, differing in whether they resolve toggles. Not touched here.
- `config.operatorUserId` is still written by no wizard step (`types.ts:283-294`), so
  `addSubscriber` is already inert on both instances.
- `resolveStartedStates` still runs at boot on a poll-only instance whose issue mutation is
  off, resolving a state it will never write.
</output>
