---
task: "A second, silent, poll-only daemon instance for the Lahzo workspace"
id: 260909-nh6
type: quick
severity: P2
completed: 2026-09-09
status: complete
gate: "npm run verify — 709/709, boot smoke + poll-only phase green (679/679 at start)"
commits:
  - 24d05a7  # feat: the three config fields
  - b04973c  # feat: silence at the client, pickup filter at the one site
  - e8cf1f6  # feat: poll-only boot, --config-dir
  - 6f07bf8  # docs: the AGENTS.md probe, T122-T124
---

# 260909-nh6 — A second, silent, poll-only instance

Four config fields nobody has to think about, one decorator, one filter, one flag, and a
probe that answers a question by running the binary. **Items 1, 2, 3, 4 and 6 shipped.
Item 5 (parent-directory multi-repo mode) did not, and until it does N mapped repos still
cost N runs and N `claude` sessions.**

---

## The live instance was not touched

**Executed, not asserted.** The operator's real `~/.linear-auto-worker/config.json` loaded
through the new schema, printing resolved booleans only — never the mappings, never a
Slack URL (`types.ts:266-276` calls it a bearer secret):

```
top-level  ingress            = undefined
top-level  postLinearComments = true
top-level  updateLinearIssue  = true
mapping[0]  postLinearComments = true  updateLinearIssue = true  pickupStates present = false  overrides present = false
mapping[1]  postLinearComments = true  updateLinearIssue = true  pickupStates present = false  overrides present = false
mapping[2]  postLinearComments = true  updateLinearIssue = true  pickupStates present = false  overrides present = false
mapping[3]  postLinearComments = true  updateLinearIssue = true  pickupStates present = false  overrides present = false
```

Every line reads as today's behaviour: webhook ingress, comments on, issue mutation on, no
pickup filter. **The running Código 18 daemon was not restarted, not reconfigured, and its
config file was neither edited nor copied into this repository.** It picks these changes up
only when the operator restarts it, and at that moment every new field resolves to what it
does now — which is what the output above demonstrates rather than claims.

The `overrides present = false` column is the second half of that: no mapping carries an
`overrides` object at all, so the boot-time refusal added in Task 2 cannot fire against the
live config.

---

## The gate

| | count |
|---|---|
| before | **679/679**, boot smoke green |
| after | **709/709**, boot smoke green + poll-only phase green |

Both numbers are what the runner printed, not what was expected.

---

## The T109 pair: what the plan named, what I observed, and the repair

The plan named the pair as *decorator suite GREEN / engine suite RED*. **Run exactly as
specified, it came back neither-red**, which the plan pre-declares as normal rather than as
evidence of error — and then requires repairing before the fix is claimed.

Deleted the wrapping call in `daemon.ts` so the raw client passes through. It still
compiles, exactly as predicted — the wrapper returns the same interface:

```
=== decorator suite (must stay GREEN) ===
# tests 10
# pass 10
# fail 0
=== engine suite (expected RED) ===
# tests 31
# pass 31
# fail 0
```

**Why, and it is not a flaw in the assertions.** `run-engine.test.ts` builds its own engine
and wraps the client in its own harness. It can never see `daemon.ts`'s wire, because it
never calls `bootDaemon`. The plan's own M13 says exactly this — *"no test boots the
daemon… the composition-root wiring of anything added here can only be proven by the
smoke"* — and Task 2's `<verify>` named a suite that structurally cannot do it. M13 is the
half that was right.

**Repair: the wiring assertion moved to the boot smoke**, the only instrument that boots the
daemon. Same procedure, re-run against the repaired pair:

```
=== decorator suite (must stay GREEN) ===
# tests 10
# pass 10
# fail 0
=== boot smoke (must go RED) ===
SMOKE FAILED
Error: nothing posted a Linear comment with comments off (got 2)
    at check (scripts/boot-smoke.ts:67:18)
    at pollOnlyPhase (scripts/boot-smoke.ts:436:5)
```

Decorator GREEN, wiring instrument RED. Restored, both green.

The engine suite still earns its place — it proves no engine path holds a second, unwrapped
reference to the client — but it is a claim about the engine, not about the composition
root. Saying otherwise would have been the T109 defect committed while performing the T109
procedure.

---

## Every RED, verbatim

### Task 1 — all TYPE ERRORS, not assertion failures

`npx tsc --noEmit` at HEAD, with the new assertions written and nothing implemented:

```
src/cli/wizard/config-writer.test.ts(392,12): error TS2339: Property 'ingress' does not exist on type 'Config'.
src/cli/wizard/config-writer.test.ts(393,21): error TS2339: Property 'updateLinearIssue' does not exist on type 'MappingToggles'.
src/cli/wizard/config-writer.test.ts(395,31): error TS2339: Property 'pickupStates' does not exist on type 'ProjectMapping'.
src/cli/wizard/config-writer.test.ts(400,28): error TS2339: Property 'pickupStates' does not exist on type 'Mapping'.
src/infra/config.test.ts(270,23): error TS2339: Property 'ingress' does not exist on type 'Config'.
src/infra/config.test.ts(273,25): error TS2339: Property 'updateLinearIssue' does not exist on type 'MappingToggles'.
src/infra/config.test.ts(284,9): error TS2353: Object literal may only specify known properties, and 'pickupStates' does not exist in type 'ProjectMapping'.
src/infra/config.test.ts(352,37): error TS2554: Expected 0-1 arguments, but got 2.
src/infra/config.test.ts(358,29): error TS2554: Expected 0-1 arguments, but got 2.
```

Line 400 is FLAG 2 caught by the compiler: `Mapping` in `cli/wizard/mapping.ts` is the
intermediate type of the `law setup` round trip, and without `pickupStates` on it the
round-trip assertion cannot pass whatever `config-writer.ts` does.

The last two are `loadSecrets(root, false)` before it took a second parameter.

### Task 2 — an assertion failure, and it says so

```
not ok 24 - pickupStates naming a state the issue is not in drops it (assignment)
  error: |-
    no run row was created

    true !== false

  code: 'ERR_ASSERTION'
```

Falsified afterwards by deleting the `return` from the non-matching branch and rebuilding —
the same two cases (`assignment` and `reconcile`) went red with the same text. Restored.

### Task 3 — the poll-only mode, before it existed

```
── phase 2: the silent, poll-only instance ──
SMOKE FAILED
Error: the tunnel was never opened (got 1)
```

And the ngrok-token half, falsified by forcing `loadSecrets(root, true)` — the pre-Task-1
behaviour — on a workspace whose `.env` holds only `LINEAR_API_KEY`:

```
SMOKE FAILED
ConfigError: …/law-smoke-KClXP4/.env is missing NGROK_AUTHTOKEN. Set it, or set
`ingress: "poll"` in config.json — a poll-only instance opens no tunnel and needs no token.
    at loadSecrets (src/infra/config.ts:222:11)
    at loadFoundation (src/infra/index.ts:22:19)
    at bootDaemon (src/cli/daemon.ts:522:43)
```

Falsification of the tunnel skip, by replacing the `if (!pollOnly)` guard with `if (true)`:
same `the tunnel was never opened (got 1)`. Restored.

### Task 4 — the probe's own falsification

The control case, which runs with no instruction file at all, came back **NOT HONOURED**
with `"Directory empty. No project token anywhere — no AGENTS.md, no config, no files."` A
probe that cannot fail is not a probe.

---

## FLAG 1 — `LINEAR_STATE_TYPES` has SEVEN members, and the SDK contradicts itself

`@linear/sdk@93.0.1` declares `WorkflowState.type: string`. There is **no exported union**,
so the plan's "read the union from the `.d.ts`" was unfollowable as written. Two doc
comments in one file disagree:

- `node_modules/@linear/sdk/dist/index.d.mts:16314` (the `WorkflowState` class doc) —
  *"…a type that categorizes them (triage, backlog, unstarted, started, completed,
  canceled)…"* — **six**.
- `node_modules/@linear/sdk/dist/index.d.mts:16337` (the `type` field's own doc) —
  *"The type of the state. One of "triage", "backlog", "unstarted", "started",
  "completed", "canceled", "duplicate"."* — **seven**.

**The seven-member list wins**, and validation is what makes the choice load-bearing: an
entry that is neither a member nor a UUID is a `ConfigError`, so the six-member list would
turn a real Linear state type into a config load error. The operator's own Código 18 team
has a state named "Duplicate" typed `duplicate`. Both the disagreement and the reason are
recorded in the doc comment on the constant.

## FLAG 4 — adjacency won, and nothing had to give

`LINEAR_STATE_TYPES` sits in `src/domain/ports.ts`, immediately after `WorkflowStateType`,
not in `types.ts`. **No conflict arose**: the plan's reason for `types.ts` was that it
imports nothing, and `ports.ts` imports nothing third-party either — only type-only imports
from `types.ts` and `agent-result.ts`. `infra/config.ts` now imports the constant from
there, with a one-line note pointing at the warning.

The warning is the point of the adjacency: `WorkflowStateType` is the three states the
daemon may **write**; `LINEAR_STATE_TYPES` is the seven Linear may **report**. Separating
them across files is what would let the next person unify them without ever seeing why
they must not.

## FLAG 3 — narrowed, not asserted away

Making `Secrets.ngrokAuthtoken` optional broke exactly the call site the flag named:

```
src/cli/daemon.ts(677,53): error TS2345: Argument of type 'string | undefined' is not
assignable to parameter of type 'string'.
```

Narrowed inside the `if (!pollOnly)` branch, which already proves the token is required, and
carrying an actionable `ConfigError` rather than a `!`. The reason is in the code: the whole
point of making the field optional was to turn a missing token into a **mode**, and a
non-null assertion would have turned it straight back into a crash.

## The `satisfies` clause survived

`TogglesSchema … satisfies z.ZodType<MappingToggles>` compiles unchanged with
`updateLinearIssue: z.boolean().default(true)`. Zod 4's `ZodType`'s Input parameter is
covariant and defaulted to `unknown`, so a schema whose input type has the field optional
while its output has it required still satisfies the clause. Nothing had to be dropped, and
the schema-to-domain drift guard at `config.ts:9-16` is intact.

---

## The silence gate: instance-level, and refused rather than ignored

`src/outbound/quiet-linear.ts` is a `LinearClient` decorator wired **once**, in the
composition root, before anything takes a reference to the client. It gates four methods:

| method | gated by |
|---|---|
| `createComment` | `postLinearComments` |
| `updateComment` | `postLinearComments` |
| `setIssueState` | `updateLinearIssue` |
| `addSubscriber` | `updateLinearIssue` |

Reads (`getIssue`, `listAssignedOpenIssues`, `listComments`, `viewer`,
`resolveWorkflowStateId`) and the whole webhook path are never gated — a silent instance
still has to find work.

**`questions.ts` was not touched, and neither were the six write sites.** That is the point
of the wrapper. In particular `questions.ts:255` — the `post()` that fires precisely when
`questionsEnabled` is FALSE and announces that the question flow is off — is silenced
without a line changing in that file, and there is an engine-level test that drives a
`needs_input` run with questions disabled and asserts nothing was posted.

From the built output, the distinct daemon code paths that reach `createComment`:

```
dist/src/orchestration/run-engine.js:184   the acknowledgement
dist/src/orchestration/run-engine.js:356   the terminal comment
dist/src/orchestration/run-engine.js:393   the multi-repo ticket rollup
dist/src/orchestration/questions.js:103    post(), reached from FOUR callers
                                           (:228 expiry, :255 questions-off, :279 round cap, :322 a real question)
```

**Seven producers, four call expressions, one gate.** All of them are now behind the
decorator; none of them knows it exists.

### The limitation, and the refusal that keeps it honest

The wrapper is handed an **issue id**, not a repo slug, so resolving a per-mapping override
would cost a Linear round trip per comment. **It reads `config.defaults` only: these two
toggles are instance-level.** That is right for two instances — one loud, one silent — but
it means a per-mapping `overrides.postLinearComments` would be inert, which is T123 in
miniature.

So `assertInstanceLevelToggles` refuses the boot when a mapping's override **disagrees**
with `defaults`, naming the mapping and the field. An override that **agrees** is inert and
harmless and is left alone — which is what keeps this from breaking the live config, whose
wizard-written overrides may carry `postLinearComments: true`. Exercised through a real boot
in the smoke, not only as a unit call:

```
ok  a mapping override disagreeing with defaults refuses the boot (mapping T-smoke overrides
    `postLinearComments` to true, but defaults says false. These two toggles are
    instance-level: they are enforced at the Linear client, which is handed an issue id and
    cannot resolve a mapping without a round trip per comment. Move the value to `defaults`,
    or drop the override.)
```

---

## The boot smoke's second phase

The plan is right that this is the only instrument that can see these wires, and it is now
the instrument for both the silence wiring and poll-only mode. `makeWorkspace` took an
options parameter (config / defaults / mapping / `ngrokToken`) rather than being forked —
every existing caller passes nothing and gets exactly what it got before.

```
── phase 2: the silent, poll-only instance ──
  ok  the tunnel was never opened (got 0)
  ok  publicUrl is empty (got "")
  ok  no webhook was created against the Linear workspace
  ok  and no webhook id was persisted (got undefined)
  ok  the receiver is still bound and accepting on 61589
  ok  nothing posted a Linear comment with comments off (got 0)
  ok  no issue state was written with issue mutation off (got 0)
  ok  and no subscriber was added
  ok  the poll picked the ticket up (got 1 run rows)
  ok  the genesis run_events row records the insert at queued, in the real SQLite file
  ok  shutdown is clean with no tunnel and no registrar to close
  ok  and a second shutdown is safe
  ok  an issue outside pickupStates is not picked up (got 0 runs)
  ok  a mapping override disagreeing with defaults refuses the boot (…)
  ok  and the refusal says why the override could never have worked
POLL-ONLY PHASE PASSED — a daemon with no tunnel, no webhook and no ngrok token found
bot-assigned work on the tick that already existed, wrote nothing to Linear, and stopped
cleanly.
```

`tunnel.probes.length === 0` reads a **recorded fact** — the stub is handed over anyway and
the daemon never calls `open` — rather than the absence of a log line.

The `.env` in that phase holds `LINEAR_API_KEY` and nothing else. No ngrok token on disk at
all.

---

## `--config-dir`, demonstrated rather than parsed

```
$ law status --config-dir /var/folders/…/tmp.KmiSBem8Sf
no store at /var/folders/…/tmp.KmiSBem8Sf/store.db — run `law setup` first
  (exit 1)

$ law status                      # no flag — the default root
/Users/augustoclaro/.linear-auto-worker
0 active run(s), 0 holding a concurrency slot
```

`bin.test.ts` runs the **built binary** for `status`, `watch` and `say` against a throwaway
root and asserts each names that root and never mentions `.linear-auto-worker`; `start` is
asserted through the config path it tries to read. `main()` is not exported and importing it
would boot a daemon, so a unit test could only re-implement the threading it is meant to
check. T88 is undisturbed: `--config-dirr` still prints an actionable message and USAGE, no
stack trace.

The first line of `law start`, both modes (`readyLine` is exported beside `SHUTDOWN_NOTE`,
for the same reason — "some string containing the port" is not a contract):

```
webhook mode : listening on 127.0.0.1:61231 -> https://given-relapsing-plop.ngrok-free.dev
poll-only    : listening on 127.0.0.1:61589 — poll-only: no tunnel, no webhook
```

---

## The `AGENTS.md` probe

`npx tsx scripts/probe-agents-md.ts`, run 2026-09-09:

```
claude CLI: 2.1.263 (Claude Code)
permission mode: dontAsk

AGENTS.md                      HONOURED
  token ZORBLAT-CF40DCBE; answered: ZORBLAT-CF40DCBE

CLAUDE.md                      HONOURED
  token ZORBLAT-D8BDD2A0; answered: ZORBLAT-D8BDD2A0

control (no instruction file)  NOT HONOURED
  token ZORBLAT-CF179A7B; answered: Directory empty. No project token anywhere — no
  AGENTS.md, no config, no files.

Measured against claude 2.1.263 (Claude Code). A CLI upgrade invalidates it.
```

The token is minted per case, so a correct answer cannot come from training data or a cache.
**Nothing was built for this** — a repo's committed `AGENTS.md` is already in the worktree by
construction, and no `LAW.md` was invented. The two cases it does not cover (uncommitted
files, parent-directory files) are written down in `docs/agent-invocation.md` as not
covered, not glossed.

---

## Findings, reported rather than fixed

- **`src/ingress/poll.ts` has no production caller and never had one.** The live poll is
  `recovery.reconcile`, reached from `daemon.ts`'s tick. Reported, not deleted — T102 says a
  dead export is not automatically a missing wire, and deleting a module is a bigger decision
  than a knob-adding task should make. **T122.**
- **`questionsEnabled: false` POSTS a Linear comment saying the question flow is off**
  (`questions.ts:255-258`), which is the opposite of what the name suggests to an operator
  configuring a silent instance. Silenced here by the wrapper; the naming is left alone.
- **`run-engine.ts:239` carries a private `resolveMapping` beside `infra/config.ts`'s.** Two
  implementations of one lookup, differing in whether they resolve toggles. The pickup filter
  reads the raw mapping the engine's own copy returns; neither was touched.
- **`config.operatorUserId` is still written by no wizard step**, so `addSubscriber` is
  already inert on both instances — which is half the justification for `updateLinearIssue`
  being one toggle rather than two.
- **`resolveStartedStates` still runs at boot on a poll-only instance whose issue mutation is
  off**, resolving a state it will never write. Left deliberately: one Linear call per team,
  and removing it would mean the poll-only path skips a boot check the webhook path keeps.
  A known no-op cost, not an oversight.
- **`postLinearComments` was dead config for the whole milestone** before this task — six
  layers of schema, one production mention, and that mention a doc comment. **T123.**
- **The retry gesture on a poll-only instance is not "unassign, re-assign".** That arrives as
  `trigger: 'assignment'`, which only the webhook path has. T107's guard means any prior run
  disqualifies a poll-sourced request, so for the Lahzo instance the retry gesture is: delete
  the run row, or clear the run and move the ticket out of and back into a pickup state. No
  retry was built.

---

## What did NOT ship

**Item 5 — parent-directory multi-repo mode (one run, one agent, cwd = the parent, N pull
requests) is not in this task and nothing here encourages it.** After this change the Lahzo
instance works, silently, over whatever repos its mapping lists — but **N mapped repos still
mean N runs, N worktrees and N `claude` sessions.** Listing all 33 Lahzo repos would produce
33 sessions per ticket. It is deferred because it turns on a decision nobody has made —
what replaces worktree isolation when the working directory holds 33 of the operator's live
checkouts — and that is a data-loss question about his own work in progress, not a sizing
question. The options and the recommendation are in the plan's `<deferred>` section.

Also deliberately not done: no wizard prompts for the three new fields (the wizard learns to
*preserve* them, not to ask); no `LAW.md`; no multi-workspace support; no gating of Slack or
the notifier; `src/ingress/poll.ts` not deleted.

---

## TRAPS

`grep -c '^| T' .planning/TRAPS.md` went **123 → 126** — the +3 the plan predicted. (The
printed number exceeds the highest row id because T107 and T108 each appear twice.) Both
prose counts read 124: `docs/TRAPS.md`'s opening line and its "all 124 rows" pointer, and
`README.md`'s ledger line.

- **T122** — a dead module whose doc comment reads exactly like the live one.
- **T123** — a toggle the wizard writes, echoes back in its own review prompt, and nothing
  consults.
- **T124** — `ERR_NGROK_334` names a domain, not a quota; a second instance with no ingress
  tunnel never meets it.

`docs/TRAPS.md` says plainly that T122 and T123 are the **seventh and eighth** instances of
one shape in this repository, because the count is the lesson.

---

## Operator actions

None of this can be done by the executor, and none of it may be pasted into a chat.

1. **Create `~/.law-lahzo/`, mode 0700.**
2. **Write `~/.law-lahzo/.env` at mode 0600 with `LINEAR_API_KEY` only.** No
   `NGROK_AUTHTOKEN` — its absence is now a supported configuration rather than a boot
   failure, proven end to end by the smoke.
3. **Write `~/.law-lahzo/config.json` at mode 0600.** It is not safely shareable: a mapping's
   `slackWebhookUrl` is a bearer credential. Set:
   - `"ingress": "poll"`
   - `botUserId: "60d5a47c-b5f7-4492-a268-2c3b03660345"`,
     `teamId: "138d2d22-9687-4645-92af-4d0b62a81857"`
   - `dbPath` and `worktreeRoot` under `~/.law-lahzo/` — **not** under the live root. Two
     instances sharing a store are two daemons driving one queue.
   - `defaults.postLinearComments: false`, `defaults.updateLinearIssue: false`,
     `defaults.notifySlack: true`, `defaults.draftPr: true`,
     `defaults.questionsEnabled: false`. **These two silence toggles must be in `defaults`,
     not in a mapping's `overrides`** — the daemon refuses to start if an override disagrees,
     and says why.
   - one mapping keyed by the Client Onboarding team id, with
     `"pickupStates": ["43876da4-7abe-4268-8559-e4db36ca4247"]` (the Todo state id; the type
     form `"unstarted"` also works and survives a workflow edit better), a `slackWebhookUrl`
     set to his personal webhook, and a `repos` list.
   - **Keep that `repos` list short.** Until item 5 ships, every entry is another run and
     another `claude` session per ticket.
4. **Do not point the second instance at the live root, and do not re-run `law setup` against
   the live root** while checking any of this. (A re-run against either root now preserves
   `ingress`, `pickupStates` and `updateLinearIssue` — but the live instance has no reason to
   be touched at all.)
5. Consider `alias lawz='law --config-dir ~/.law-lahzo'`. USAGE names it as the intended
   ergonomics; there is deliberately no environment variable.
6. The branch name still comes from Linear's own `branchName` and is visible to colleagues,
   and Linear may auto-link and auto-move the ticket off the back of it. That was accepted;
   nothing here designs around it.

---

## Known stubs

None. No placeholder values, no unwired components, no `TODO`/`FIXME` introduced.

## Self-Check: PASSED

Files verified present: `src/outbound/quiet-linear.ts`, `src/outbound/quiet-linear.test.ts`,
`scripts/probe-agents-md.ts`. Commits verified in `git log`: `24d05a7`, `b04973c`, `e8cf1f6`,
`6f07bf8`.
