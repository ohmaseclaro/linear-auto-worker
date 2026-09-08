---
task: "`ALLOWED_TOOLS` under-grants (Skill, Read) and the probe that would prove it crashes"
id: 260908-bms
type: quick
severity: P1
created: 2026-09-08
branch: main
files_modified:
  - scripts/probe-gsd-allowlist.ts
  - src/execution/event-router.ts
  - src/execution/event-router.test.ts
  - src/execution/supervisor.ts
  - src/execution/agent-args.ts
  - src/execution/agent-args.test.ts
  - docs/agent-invocation.md
  - docs/TRAPS.md
  - .planning/TRAPS.md
  - README.md
gate: npm run verify   # 654/654 + boot smoke green before; 657/657 + smoke after
must_haves:
  truths:
    - "`npx tsx scripts/probe-gsd-allowlist.ts` reports zero permission denials on a real GSD-shaped run, and its output is pasted verbatim in the SUMMARY."
    - "A denial carrying no `tool_input` prints its name and reason and the run still reaches the `suggested:` line."
    - "The probe's denial COUNT equals the number of distinct refusals, not double it."
    - "`npm run verify` never spawns `claude`."
  artifacts:
    - "src/execution/agent-args.ts — ALLOWED_TOOLS widened, comment replaced with what was measured, naming CLI 2.1.263 and 2026-09-08."
    - "src/execution/event-router.ts — `pickDenials`, the one owner of the two-source selection rule."
    - ".planning/TRAPS.md rows T116 and T117; docs/TRAPS.md prose for both."
  key_links:
    - "probe → `buildClaudeArgs` / `ALLOWED_TOOLS` / `pickDenials` — the probe must exercise the PRODUCT's values, never its own copies."
    - "supervisor.ts:535 → `pickDenials` — the rule the probe mirrors must be the same function, not a second copy."
---

<objective>
`ALLOWED_TOOLS` is `['Write','Edit','Bash']`. It under-grants, and under-granting is
invisible in every signal this system emits: the agent is refused, routes around the
refusal through `Bash`, and the run exits 0 with a real PR. Two independent measurements
now prove `Skill` and `Read` are denied.

The instrument that exists to catch this — `scripts/probe-gsd-allowlist.ts` — had never
been run, and when it was, it crashed while printing its own conclusion.

Three changes, in this order and no other:

1. **Repair the instrument.** Fix the crash, fix a second defect found in the same place
   (every denial is counted twice), and prove the fix on real data.
2. **Widen the allowlist**, then run the probe until it reports zero denials.
3. **Record what was measured** — in the constant's comment, in both trap ledgers, and in
   the operator docs — replacing text that this task makes false.

The probe is the authority, not the argument. This task is not complete until a probe run
reports **zero denials** and the executor has pasted its real output.
</objective>

<measured_facts>
Everything below was measured against the real binary. Nothing is recalled.

**M1 — the live run.** COD-7 → `dzfweb/miracle-shop`, delivered 2026-09-08, run log
`~/.linear-auto-worker/runs/19c0b7c7-e96b-4860-902f-bd2a24ed1605.jsonl`. Two tools were
refused: `Skill` and `Read`, both `decision_reason_type: "mode"`, message *"Permission to
use Skill has been denied because Claude Code is running in don't ask mode."* The agent
substituted `head`/`cat` through `Bash` and still shipped a correct PR. Exit 0, PR opened,
Linear comment posted, `npm run verify` green — **every signal the system produces said
success.** The gap was visible only inside the run's own event log.

**M2 — the two denial sources have DIFFERENT SHAPES.** Parsed from that same log:

| Source | Keys present |
|---|---|
| `system/permission_denied` event | `decision_reason_type`, `message`, `session_id`, `subtype`, `tool_name`, `tool_use_id`, `type`, `uuid` — **no `tool_input`** |
| `result.permission_denials[]` entry | `tool_input`, `tool_name`, `tool_use_id` — **no `decision_reason_type`** |

Both sources describe the SAME two refusals. This single fact explains both probe defects:
the crash at `:183` (`JSON.stringify(undefined)` returns the VALUE `undefined`, so `.slice`
throws) and the double count, because `scripts/probe-gsd-allowlist.ts` pushes both sources
into one array. The product already has the right rule — `supervisor.ts:535` prefers the
event source and falls back to the result's — and the probe re-derived it wrongly.

**M3 — the probe run at HEAD, 2026-09-08, verbatim:**
```
allowlist under test: Write Edit Bash
requested permission mode: dontAsk
init: 113 skills, permissionMode=dontAsk
DENIED Skill (mode)
exit code:        0   (0 means nothing — see D-06/T1)
result:           subtype=success is_error=false
turns / cost:     8 turns, $0.4355455
new commits:      1
denials:          2
  Skill  reason=mode
TypeError: Cannot read properties of undefined (reading 'slice')
    at main (scripts/probe-gsd-allowlist.ts:183:64)
```
Note `denials: 2` for ONE distinct tool — M2's double count. The `suggested:` line at `:185`,
the single line the whole script exists to produce, is never reached.

**M4 — an unknown name in `--allowedTools` is INERT, not an error.** Measured twice today
on CLI 2.1.263. (a) `claude --allowedTools NotARealTool Write --permission-mode dontAsk
--output-format stream-json --input-format stream-json --verbose --max-turns 1 -p
< /dev/null` → exit 0, no validation error at parse (contrast `--max-turns notanumber`,
which does error). (b) The same with `--allowedTools NotARealTool Glob Grep TodoWrite Write`
and one NDJSON user message → `system/init` reached with `permissionMode=dontAsk`, result
`subtype=success is_error=false`, `permission_denials: []`, $0.51858.

**The consequence is the important half:** if a vendor update renames or removes a tool we
grant, the CLI says nothing. The allowlist silently narrows and the product silently
produces less. Only the probe can see that.

**M5 — the tool list is environment-dependent.** The real daemon run (M1, under
`buildChildEnv`) enumerated 30 tools: Task, Bash, CronCreate, CronDelete, CronList,
DesignSync, Edit, EnterWorktree, ExitWorktree, ListAgents, ListMcpResourcesTool, Monitor,
NotebookEdit, PushNotification, Read, ReadMcpResourceDirTool, ReadMcpResourceTool,
RemoteTrigger, ReportFindings, ScheduleWakeup, SendMessage, Skill, StructuredOutput,
TaskOutput, TaskStop, ToolSearch, WebFetch, WebSearch, Workflow, Write. **`Glob`, `Grep`
and `TodoWrite` are absent.** The M4(b) probe, run from an operator shell with its own MCP
servers, reported `tools=132`. So the only authoritative enumeration is one taken under
`buildChildEnv` — which is what `scripts/probe-gsd-allowlist.ts` does and why it is the
instrument of record.

**M6 — CLI version under test: 2.1.263** (`claude --version`).
</measured_facts>

<design>
## What goes into the allowlist, and why

Final value: `['Write', 'Edit', 'Bash', 'Read', 'Skill', 'Task']` — appended, not
reordered, so the diff reads as "what was added when".

- **`Read`, `Skill`** — proven denied by two independent measurements (M1, M3). Not a
  judgement call.
- **`Task`** — GRANTED, and this is the one judgement call. It is in the CLI's tool list
  (M5). GSD's skills are built on delegating to planner/executor/checker subagents; refuse
  `Task` and every GSD skill degrades to the parent doing everything inline, which is
  exactly the invisible degradation this whole task exists to remove. PROJECT.md's cap on
  simultaneous spawned Claude sessions (default 3, for local RAM) is not what bounds it:
  Agent-tool subagents run INSIDE the parent `claude` process and consume no OS session
  slot. What they consume is parent-process memory and dollars, and both are already
  bounded — `--max-budget-usd` (remaining-budget, per session) and `--max-turns`.
  **The probe arbitrates.** If the run with `Task` granted comes back `error_max_turns` or
  at a materially higher cost than M3's $0.4355, that is a finding to record, not a
  blocker: `classifyOutcome` already reads a non-`success` subtype as truncated and ships a
  draft PR as `partial`.
- **`Glob`, `Grep`, `TodoWrite`** — NOT added. They are not in this CLI's tool list (M5).
  M4 says adding them would be inert rather than an error, and that is precisely the
  argument against: an inert name in a measured list is indistinguishable from a measured
  one to the next reader.

## Repairing the instrument

Two defects, one cause (M2). The fix follows the product rather than inventing a rule:

- **The selection rule gets ONE owner.** `supervisor.ts:535` already holds it as an inline
  ternary with a paragraph of comment and, per `grep denials src/execution/supervisor.test.ts`,
  no test. Move it to `pickDenials()` in `event-router.ts` (where `PermissionDenial`
  already lives), call it from `supervisor.ts`, call it from the probe. The probe's own
  header says a probe with its own copy of the flag list verifies nothing about the thing
  that ships; a probe with its own copy of the denial rule is the same defect, and
  T72/T92/T96 are all that defect.
- **The crash gets the guard the fact suggests.** `JSON.stringify(undefined) === undefined`
  is what threw; it is also a perfectly good presence test. Print the input line only when
  the source carried one.

## Deliberately NOT doing

- **Not surfacing denials in the daemon's own output.** `adapters.ts` already reports a
  denial phrase on failure paths; making a SUCCESSFUL run warn on denials is a real idea
  and a separate change with its own wiring proof. Out of scope here.
- **Not touching `.planning/phases/**` or `.planning/research/**`.** Those are historical
  records of what was believed at the time. Only live surfaces get corrected.
- **Not adding a flag to the probe.** It takes no arguments today; keep it that way.

## Keeping the probe out of `npm run verify` — both properties preserved

The gate is `npm run clean && tsc && npm run assets && node --test "dist/**/*.test.js" &&
npm run smoke`. Two independent things keep the probe away from it, and this task changes
neither:

1. **It imports nothing from `node:test`.** After this change it imports `execa`,
   `node:crypto`, `node:fs/promises`, `node:os`, `node:path` and four modules from `src/` —
   no test runner, no test registration.
2. **It lives outside `src/`.** `tsconfig.json` sets `"include": ["src", "test"]`, so
   `scripts/` is never compiled into `dist/` and the `dist/**/*.test.js` glob cannot reach
   it. `npm run smoke` runs `scripts/boot-smoke.ts` specifically, by name.

Adding `pickDenials` to `src/execution/event-router.ts` is what makes the fix testable by
the gate while leaving the money-spending half in `scripts/`.
</design>

<constraints>
- Stay on `main`. Three commits, one per task.
- `npm run verify` is 654/654 plus a boot smoke and must stay green. Expect 657/657 after
  the three tests below; report the exact number the runner prints.
- **Never `mock.method`** (T88).
- Tests colocated in `src/` as `*.test.ts`.
- **Falsify every new check** (T71/T76) and paste the RED text actually seen. A check that
  has never been observed failing has not been shown to check anything.
- The probe costs ~$0.44 and several minutes per run. That is approved. Budget for 2–4 runs.
</constraints>

<tasks>

<task type="auto">
  <name>Task 1: Repair the probe — one denial rule, no crash — and prove it on a real run</name>
  <read_first>
    - `scripts/probe-gsd-allowlist.ts` — the local `Denial` interface (~:63-67), the single
      `denials` array (~:116), the parser callback (~:119-143), the report block (~:170-188).
    - `src/execution/event-router.ts` — `PermissionDenial` (~:32-45), the `denials` array
      (~:237) and the `system/permission_denied` branch (~:303-313).
    - `src/execution/supervisor.ts:526-540` — the inline ternary and its comment.
    - `src/execution/event-router.test.ts:200-260` — the existing denial-tally section, where
      the new tests belong.
  </read_first>
  <behavior>
    - `pickDenials(fromEvents, fromResult)` returns a copy of `fromEvents` when it is
      non-empty (a reaped run has no result event, so the events are the only witness).
    - It returns a copy of `fromResult` when `fromEvents` is empty, and `[]` when
      `fromResult` is undefined.
    - It never concatenates: the two sources describe the same refusals (M2), so summing
      them reports double.
  </behavior>
  <action>
    Add `pickDenials` to `src/execution/event-router.ts`, beside `PermissionDenial`. Signature:
    two parameters, a `readonly PermissionDenial[]` and a possibly-undefined
    `readonly PermissionDenial[]`, returning a new `PermissionDenial[]`. MOVE the existing
    justification comment from `supervisor.ts` onto it and extend it with M2: the two
    sources carry different fields — the event source is the only one with
    `decision_reason_type`, the result source the only one with `tool_input` — so the choice
    of source is also a choice of which diagnostic field survives. Preferring the events
    keeps the reason.

    In `src/execution/supervisor.ts`, replace the inline ternary on the `denials:` property
    with a call to `pickDenials(router.denials, resultEvent?.permission_denials)`. Behaviour
    identical; there is exactly one product call site and it is compile-enforced, so no
    wiring proof is needed beyond `tsc`.

    In `scripts/probe-gsd-allowlist.ts`:
    - DELETE the local `Denial` interface and import `PermissionDenial` and `pickDenials`
      from `../src/execution/event-router.js`. Fewer types, and the probe now exercises the
      product's rule instead of its own.
    - Replace the single `denials` array with two: one filled by the
      `system/permission_denied` branch, one filled from `permission_denials` on the result
      event. Derive the reported list with `pickDenials(...)` after the stream is exhausted,
      and use that one list for the count, the listing and the suggested names.
    - In the report loop, keep the `tool_name` / `decision_reason_type` line unchanged.
      Compute `JSON.stringify(d.tool_input)` into a local first and emit the `input:` line
      ONLY when that local is not `undefined` — the same `undefined` that threw at `:183` is
      the presence test. Add a short comment recording why: the preferred source carries no
      such field at all (M2), so absence is the normal case and must not be an error path.
    - Update the header comment: the report is now one entry per distinct refusal, and the
      `suggested:` line is reached whatever fields a denial carries.

    Then RUN THE PROBE ONCE, before touching `ALLOWED_TOOLS`:

        npx tsx scripts/probe-gsd-allowlist.ts

    This run is the deliberate exercise of the no-`tool_input` path on real data, and the
    RED→GREEN proof of the crash: at HEAD the identical run died at `:183` (M3); it must now
    print every denial and reach `suggested:` before exiting 1. Paste the whole output.

    If this run comes back with ZERO denials (M1 and M3 both had denials, so this is
    unlikely), the path is unexercised — in that case temporarily set `ALLOWED_TOOLS` to
    `['Bash']`, run once more to force refusals of `Write`/`Edit`, paste that output, and
    restore the array before Task 2.
  </action>
  <verify>
    <automated>npm run verify</automated>
    Plus, all of which must be pasted into the SUMMARY:
    - Falsification of the two new tests: invert the condition inside `pickDenials` so the
      empty source wins, re-run `node --test dist/src/execution/event-router.test.js`, paste
      the RED assertion text, restore.
    - `grep -c "tool_input" scripts/probe-gsd-allowlist.ts` — no bare unguarded
      `JSON.stringify(...).slice` remains on that field.
    - The probe run output described above, verbatim.
  </verify>
  <done>
    `pickDenials` exists in `event-router.ts` with two tests in `event-router.test.ts`
    (prefers a non-empty event list; falls back to the result list, and to `[]` when it is
    absent), both observed RED under an inverted condition. `supervisor.ts` calls it and
    behaves identically. A probe run against the UNWIDENED allowlist prints its denials —
    including at least one carrying no `tool_input` — reaches the `suggested:` line, exits 1
    without a TypeError, and reports a count equal to the number of distinct tools refused.
  </done>
</task>

<task type="auto">
  <name>Task 2: Widen ALLOWED_TOOLS, then run the probe to zero denials</name>
  <read_first>
    - `src/execution/agent-args.ts:37-51` — the comment block and the constant.
    - `src/execution/agent-args.ts:149-160` — the `--allowedTools` emission and the T27 comment.
    - `src/execution/agent-args.test.ts:70-78, 168-178, 225-235` — the three existing
      assertions, all of which slice by `ALLOWED_TOOLS.length` and so are value-agnostic
      today.
  </read_first>
  <behavior>
    - `ALLOWED_TOOLS` deep-equals the six measured names in order; dropping any one turns
      the new test RED.
    - The three existing length-sliced assertions keep passing unchanged, since they were
      written against `.length`.
  </behavior>
  <action>
    Append `'Read'`, `'Skill'`, `'Task'` to `ALLOWED_TOOLS` in `src/execution/agent-args.ts`.

    Replace the constant's comment block. Keep the two paragraphs that are still true (one
    list for both the fresh and the resumed path; under-granting reproduces the
    silent-nothing failure). Delete the closing sentence that calls the array unverified —
    this task makes it false. In its place, record what was measured, and name **CLI 2.1.263**
    and **2026-09-08** in the text, because this is vendor surface that drifts weekly and a
    reader must be able to tell how stale the measurement is:
    - `Skill` and `Read` were refused with `decision_reason_type: "mode"` on a real delivered
      run; the agent substituted shell commands through `Bash` and still shipped a correct
      PR, so exit code, PR, Linear comment and the test gate all reported success while the
      agent was being refused. The run's own event log was the only witness.
    - `Task` is granted so GSD's skills can delegate; note that its subagents run inside the
      parent `claude` process and therefore do not consume a slot of the global session cap,
      and that cost and turns are what bound them.
    - `Glob`, `Grep` and `TodoWrite` are NOT granted because this CLI does not have them
      (M5), and note the measured reason that matters: an unknown name is accepted silently
      (M4), so a granted name that the vendor later removes narrows the allowlist without a
      single error — which is why the probe must be re-run after a CLI upgrade.
    - State plainly that the test below pins the VALUE of this array and can never establish
      its SUFFICIENCY; only `scripts/probe-gsd-allowlist.ts`, against a real GSD run, can.

    Add ONE test to `src/execution/agent-args.test.ts`, named for what it guards: a
    `deepEqual` of `ALLOWED_TOOLS` against the six literal names. Give it a two-line comment
    making the same value-not-sufficiency point, so a reader of the test never mistakes green
    here for a verified allowlist.

    Then RE-RUN the probe and report its actual output:

        npx tsx scripts/probe-gsd-allowlist.ts

    If it names further denied tools, add exactly those names to `ALLOWED_TOOLS` and to the
    test's literal array, and run it AGAIN. Repeat until it reports zero denials. **This task
    is not complete until a run reports zero denials**, and the final run's full output —
    exit code, subtype, turns, cost, new commits, denial count, and the PASS line — must be
    pasted into the SUMMARY. Every intermediate run's denial list gets pasted too: those are
    the measurements, and a summary that reports only the last one hides how the answer was
    reached.
  </action>
  <verify>
    <automated>npm run verify</automated>
    - `npx tsx scripts/probe-gsd-allowlist.ts` exits 0 and prints its PASS line. Output pasted.
    - Falsification: delete `'Skill'` from the constant, run
      `node --test dist/src/execution/agent-args.test.js`, paste the RED diff, restore, re-run green.
    - `grep -c "2.1.263" src/execution/agent-args.ts` returns at least 1.
    - `grep -c "an assumption" src/execution/agent-args.ts` returns 0.
  </verify>
  <done>
    A probe run reports **zero denials**, GSD skills present, `permissionMode` echoed, at
    least one new commit, exit 0 — and the output is in the SUMMARY. `ALLOWED_TOOLS` holds
    exactly the names that run granted; its comment records the measurement, the version and
    the date, and no longer claims the array is unverified. The value test fails when a name
    is dropped, observed.
  </done>
</task>

<task type="auto">
  <name>Task 3: File T116 and T117, and correct every doc this makes false</name>
  <read_first>
    - `.planning/TRAPS.md:124-155` — the "Discovered at open-source release" table, its
      five-column header at `:126`, the T109 row at `:149` for tone and density, and T115 at
      `:155` as the current last row.
    - `docs/TRAPS.md` — `## What only a live run finds` (~:423) and
      `## The one that is really about process` (~:514).
    - `docs/agent-invocation.md:19` (the `--allowedTools` row), `:88-96` (the probe intro),
      `:105-112` (the Fail bullet).
    - `README.md:200-206` — the footgun count and the sample list.
  </read_first>
  <action>
    **`.planning/TRAPS.md`** — append two rows after T115, five columns, matching T109's
    density (a measured claim per cell, no advice that was not paid for):

    - **T116** — an allowlist that under-grants is invisible in every signal the system
      emits. Failure mode: the agent is refused, substitutes shell commands through `Bash`,
      and delivers; exit 0, PR opened, Linear comment posted, gate green. Cite COD-7 →
      `dzfweb/miracle-shop`, 2026-09-08, `Skill` and `Read` refused with reason `mode`,
      found only by counting `system/permission_denied` in the run's own JSONL. Correct move:
      the allowlist is only ever established by a live probe under the product's own
      `buildChildEnv`; add that `--allowedTools` accepts unknown names silently (M4), so
      vendor drift narrows the grant without any error at all.
    - **T117** — the diagnostic crashed while printing its own conclusion. Failure mode:
      `JSON.stringify(undefined)` returns the VALUE `undefined`, so `.slice(0, 300)` threw
      at `scripts/probe-gsd-allowlist.ts:183` after naming one tool, and the `suggested:`
      line — the one line the script exists to produce — was never reached. Root cause: the
      two denial sources carry different fields (M2) and the probe merged them, which also
      double-counted every refusal. Correct move: an instrument needs its own failure path
      exercised, not just its happy path; and where the product already owns a rule, the
      instrument calls it instead of re-deriving it.

    Phase column for both: `quick 260908-bms`.

    **`docs/TRAPS.md`** — no new sections. Add T116's lesson as prose under
    `## What only a live run finds`, and append T117's to
    `## The one that is really about process`, which already argues that an instrument that
    has never failed is not known to work — T117 is that argument's next sentence.

    **`docs/agent-invocation.md`** — three edits:
    - `:19` — the flag row: update the granted list to the six names and replace the
      "not optional" text with the measurement, keeping the T27 point (the mode and the
      allowlist ship together) and adding that the set was verified against a real GSD run on
      2026-09-08, CLI 2.1.263.
    - `:88-96` — rewrite the probe intro. Delete the claim that the set is unverified against
      a GSD run, and the sentence calling the array unverified. Replace with: it HAS been
      verified, on that date and version, which names were added as a result, and that a CLI
      upgrade invalidates the measurement because unknown names are accepted silently.
    - `:105-112` — the Fail bullet: the report is one entry per distinct refusal, always
      carries the tool name and the reason, and shows `tool_input` only when the source
      carried one.

    **`README.md:201`** — the footgun count moves from 115 to 117. Leave the sample list alone.
  </action>
  <verify>
    <automated>npm run verify</automated>
    - `grep -c "^| T11[67] " .planning/TRAPS.md` returns 2.
    - `grep -c "an assumption" docs/agent-invocation.md` returns 0.
    - `grep -c "117 verified footguns" README.md` returns 1.
    - `grep -c "260908-bms" .planning/TRAPS.md` returns 2.
  </verify>
  <done>
    T116 and T117 are in the ledger in five-column form with the phase tag; both lessons
    appear as prose in `docs/TRAPS.md`; `docs/agent-invocation.md` states the measured
    allowlist with its version and date and no longer describes it as unproven; the README
    count is 117.
  </done>
</task>

</tasks>

<commits>
- `fix(probe): one denial per refusal, and report one that carries no tool_input`
- `fix(agent-args): grant Read, Skill and Task — measured denials on CLI 2.1.263`
- `docs: T116/T117, and the allowlist as measured rather than assumed`
</commits>

<success_criteria>
1. **A probe run reports zero denials**, and its full output is pasted in the SUMMARY. This
   is the completion gate. Nothing else substitutes for it — not a green `tsc`, not 657
   passing tests, not a reasoned argument that the list looks right.
2. Every intermediate probe run's denial list is pasted too, in order, so the SUMMARY shows
   how the answer was reached rather than only where it landed.
3. `npm run verify` green: 657/657 (or the exact number the runner prints, stated) plus the
   boot smoke.
4. All three new checks observed RED under a deliberate break, with the actual failure text
   pasted (T71/T76).
5. `npm run verify` still cannot spawn `claude`: the probe imports nothing from `node:test`
   and still lives outside `src/`, and the SUMMARY says so.
6. No source or doc still describes `ALLOWED_TOOLS` as unproven.
</success_criteria>

<open_risks>
- **The probe is non-deterministic.** It asks an agent to do a small GSD task; a different
  run may reach for a tool neither M1 nor M3 saw. That is the loop in Task 2, not a defect —
  but it means "zero denials" is evidence about one run, not a proof for all runs. Say so in
  the SUMMARY rather than overclaiming.
- **`Task` may change the cost or turn profile.** M3's baseline is 8 turns / $0.4356 without
  it. Report the new figures. `error_max_turns` with `Task` granted would mean subagent turns
  draw on the parent's budget — a finding worth a ledger row of its own, not a reason to
  revert.
- **M4's silence is permanent.** Nothing in the product can detect a vendor-side rename of a
  granted tool. The only mitigation shipped here is the comment telling the next reader to
  re-run the probe after a CLI upgrade.
</open_risks>
