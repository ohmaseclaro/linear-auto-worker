---
task: "`ALLOWED_TOOLS` under-grants (Skill, Read) and the probe that would prove it crashes"
id: 260908-bms
type: quick
status: complete
completed: 2026-09-08
branch: main
commits:
  - c81df58 "fix(probe): one denial per refusal, and report one that carries no tool_input"
  - 2c0b700 "fix(agent-args): grant Read, Skill and Task — measured denials on CLI 2.1.263"
  - 988b037 "docs: T116/T117, and the allowlist as measured rather than assumed"
gate: "npm run verify — 654/654 + smoke before, 657/657 + smoke after"
---

# Quick task 260908-bms: `ALLOWED_TOOLS` under-grants, and the probe repair — Summary

The allowlist was widened from `Write Edit Bash` to `Write Edit Bash Read Skill Task` and a
real probe run confirmed **zero denials** — but only after repairing the instrument that
measures it, which at HEAD crashed while printing its own conclusion and double-counted every
refusal.

## The completion gate: probe runs, verbatim

Three runs. Order was mandated and followed: repair the instrument, exercise its crash path
against the UN-widened allowlist on real data, then widen.

### Run 0 — at HEAD, from the plan (M3). Not re-run; this is why the instrument was repaired first.

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

`denials: 2` for ONE named tool, and the `suggested:` line never reached.

### Run 1 — repaired instrument, allowlist still UN-widened. The RED→GREEN on real data.

```
probe repository: /var/folders/zd/zsvfvvrd0xq2k52gzr51r1tw0000gn/T/law-gsd-probe-JPOwyt
allowlist under test: Write Edit Bash
requested permission mode: dontAsk

init: 113 skills, permissionMode=dontAsk
DENIED Skill (mode)
DENIED Read (mode)

--- report ---
exit code:        0   (0 means nothing — see D-06/T1)
result:           subtype=success is_error=false
turns / cost:     10 turns, $0.49411250000000007
new commits:      1
denials:          2

These are the tools the allowlist is missing. Add them to
ALLOWED_TOOLS in src/execution/agent-args.ts and run this again:

  Skill  reason=mode
      input: {"skill":"gsd-fast","args":"Add NOTES.md with one sentence describing this repo (throwaway probe fixture, README-only), then commit. No push, no PR."}
  Read  reason=mode
      input: {"file_path":"/Users/augustoclaro/.claude/skills/gsd-fast/SKILL.md"}

  suggested: Skill Read

probe repository left in place for inspection: /var/folders/zd/zsvfvvrd0xq2k52gzr51r1tw0000gn/T/law-gsd-probe-JPOwyt

FAIL: 2 permission denial(s)
```

Same two refusals as run 0, now BOTH named, `denials: 2` for **two** distinct tools rather
than double-counting one, `suggested:` reached, exit 1 with no TypeError.

This run is also FLAG 1's proof on real data: every `input:` line here comes from the RESULT
source and every `reason=` from the EVENT source. A prefer-events rule would have printed
neither `input:` line — the field whose absence caused the original crash is one the preferred
source never carries.

Note what the denial entries themselves say: the agent asked for `Skill(gsd-fast)`, was
refused, tried to `Read` that skill's own `SKILL.md` to work around it, and was refused that
too. It still committed. `new commits: 1`, `subtype=success`, exit 0. That is T116 in one run.

### Run 2 — widened allowlist. THE GATE. Zero denials.

```
probe repository: /var/folders/zd/zsvfvvrd0xq2k52gzr51r1tw0000gn/T/law-gsd-probe-dCeOPX
allowlist under test: Write Edit Bash Read Skill Task
requested permission mode: dontAsk

init: 113 skills, permissionMode=dontAsk

--- report ---
exit code:        0   (0 means nothing — see D-06/T1)
result:           subtype=success is_error=false
turns / cost:     11 turns, $0.5074569999999999
new commits:      1
denials:          0

PASS: zero denials, GSD skills present, mode echoed, work committed.
```

One widening round was enough — no further denied tools surfaced.

**This is evidence about one run, not a proof for all runs.** The probe asks an agent to do a
small GSD task; a different run may reach for a tool none of these three saw. Zero denials here
means the six names were sufficient for this task, on this CLI, on this day.

## The cost/turn delta

| Run | Allowlist | Turns | Cost |
|---|---|---|---|
| M3 baseline (crashed) | Write Edit Bash | 8 | $0.4355455 |
| Run 1 (repaired probe) | Write Edit Bash | 10 | $0.4941125 |
| Run 2 (widened, `Task` granted) | + Read Skill Task | 11 | $0.5074570 |

Against M3: **+3 turns, +$0.0719 (+16.5%)**. Against run 1 — the cleaner comparison, same day,
same repaired probe, same prompt, only the allowlist differing: **+1 turn, +$0.0133 (+2.7%)**.

Read honestly, that delta is **not** attributable to `Task`. The probe is non-deterministic:
run 1 already drifted +2 turns / +$0.059 from M3 with an identical allowlist, so run-to-run
noise is larger than the widening's apparent effect. No `error_max_turns`. What can be said is
narrow: granting `Task` did not blow the turn budget on this run, and nothing here measures
whether subagent turns draw on the parent's `num_turns` at all.

## Deviations from plan

**1. [FLAG 1, folded in as instructed] `pickDenials` is a UNION keyed on `tool_use_id`, not a
source preference.** The plan's `<behavior>` specified prefer-events-with-fallback. Built as a
union instead. Run 1 vindicates it: both `input:` lines in its output come from the result
source, which prefer-events discards — the `input:` line repaired in Task 1 would have been
near-permanently dead code, and Task 3's doc sentence would have documented a branch that never
fires. The union also cannot under-report if an event line lands in `badLines`. The plan's real
reason for reading events at all (a reaped run has no result event, `supervisor.ts` P5) is
preserved and stated in the function's comment; the sources are merged rather than chosen
between. Falsification adjusted accordingly — all three RED texts below.

Edge case added beyond the plan: a denial with an empty `tool_use_id` cannot be correlated, so
it gets a key of its own rather than collapsing every such denial into one entry.

**2. [FLAG 2, folded in as instructed] The `Task` comment does not claim dollars are bounded.**
Verified before writing it: `src/infra/config.ts:66` is
`maxBudgetUsd: z.number().positive().optional()`; `src/cli/wizard/config-writer.test.ts:138`
asserts `'maxBudgetUsd' in config === false` for the wizard's default output;
`src/cli/adapters.ts:454,460` spread `--max-budget-usd` only when defined. **On a default
install the flag is never passed and there is no dollar ceiling.** The comment now says: turns
are bounded, dollars only if the operator configured `maxBudgetUsd`, and whether either bound
reaches inside a subagent is unmeasured (T114 established the turn budget is per user message;
nothing has measured subagent accounting).

**3. [Rule 3 — blocking] The plan said all three existing allowlist assertions were
value-agnostic. One was not.** `agent-args.test.ts:76` hardcoded `['Write', 'Edit', 'Bash']` as
the deepEqual expectation while slicing by `ALLOWED_TOOLS.length`, so widening turned it RED:

```
not ok 1 - T1/T27: the permission mode and its allowlist ship together, never apart
    buildClaudeArgs: each tool must be its own argv entry, not one space-joined string
    + actual - expected
      [ 'Write', 'Edit', 'Bash', + 'Read', + 'Skill', + 'Task' ]
```

Fixed by comparing against `[...ALLOWED_TOOLS]`. That assertion's subject is argv *shape* —
"each tool is its own entry, not one space-joined string" — and the new deepEqual test is now
the single owner of the array's VALUE. Two owners of the same literal is precisely the drift
this file warns about elsewhere.

## Falsifications — every new check observed RED (T71/T76)

**Check 1 — one entry per `tool_use_id`.** Break: concatenate the two sources (the original
probe's defect).

```
not ok 12 - pickDenials reports one entry per tool_use_id and keeps the field each source alone carries
    Expected values to be strictly equal:
    4 !== 2
```

**Check 1, second break — prefer-events instead of union.** FLAG 1's argument as a failing test:

```
not ok 12 - pickDenials reports one entry per tool_use_id and keeps the field each source alone carries
    Expected values to be strictly deep-equal:
    + actual - expected
    + undefined
    - { command: 'graphify' }
```

The `tool_input` vanishes — exactly the value run 1 printed on its `input:` line.

**Check 2 — the fallback to each source alone, and to `[]`.** Break: never read the result source.

```
not ok 13 - pickDenials falls back to each source alone, and to [] when the result event is absent
    Expected values to be strictly deep-equal:
    + actual - expected
    + []
    - [ { tool_input: { file_path: 'x' }, tool_name: 'Read', ...
```

**Check 3 — `ALLOWED_TOOLS` deep-equals the six measured names.** Break: delete `'Skill'`.

```
not ok 17 - ALLOWED_TOOLS holds exactly the six names a real GSD run was measured to need
    Expected values to be strictly deep-equal:
    + actual - expected
      [ 'Write', 'Edit', 'Bash', 'Read', - 'Skill', 'Task' ]
```

Restored to green after each break.

## The gate

| | Before | After |
|---|---|---|
| `npm run verify` | `# tests 654 / # pass 654 / # fail 0` + `SMOKE PASSED` | `# tests 657 / # pass 657 / # fail 0` + `SMOKE PASSED` |

657 exactly as predicted (+2 in `event-router.test.ts`, +1 in `agent-args.test.ts`).

**`npm run verify` still cannot spawn `claude`.** Both properties preserved and re-checked: the
probe imports nothing from `node:test` (its imports are `execa`, `node:crypto`,
`node:fs/promises`, `node:os`, `node:path`, and four modules from `src/`), and it still lives in
`scripts/`, outside tsconfig's `include: ["src", "test"]`, so it is never compiled into `dist/`
and the `dist/**/*.test.js` glob cannot reach it. `npm run smoke` names `scripts/boot-smoke.ts`
specifically.

## Value vs sufficiency, stated at both sites

- `src/execution/agent-args.ts` — "The test beside this constant pins its VALUE and can never
  establish its SUFFICIENCY. Only `scripts/probe-gsd-allowlist.ts`, against a real GSD run, can."
- `src/execution/agent-args.test.ts` — the new test's own comment makes the same point where a
  reader would otherwise mistake green for a verified allowlist.
- "Until it has passed once, this array is an assumption" is gone; the replacement names **CLI
  2.1.263** and **2026-09-08**.

## Known debt — recorded, deliberately NOT fixed here

**`scripts/` is not type-checked, and the probe just gained a dependency on a signature this
task created.** The probe now imports `pickDenials` and `PermissionDenial` from
`src/execution/event-router.js`. `tsconfig.json` sets `"include": ["src", "test"]`, so nothing
compiles `scripts/`. The file's own comment already records the previous instance of exactly
this: `maxTurns` became a required field of `ClaudeArgsInput` and the probe's call was never
updated, so it had not type-checked since, and nothing said so. A future signature change to
`pickDenials` breaks the probe silently the same way — and the probe is the only instrument
that can see the allowlist. A `tsc --noEmit` pass over `scripts/` is the fix, and it is a
separate change.

## Verification greps

```
grep -c "^| T11[67] " .planning/TRAPS.md            → 2
grep -c "260908-bms" .planning/TRAPS.md             → 2
grep -c "an assumption" docs/agent-invocation.md    → 0
grep -c "an assumption" src/execution/agent-args.ts → 0
grep -c "2.1.263" src/execution/agent-args.ts       → 3
grep -c "117 verified footguns" README.md           → 1
grep -c "tool_input" scripts/probe-gsd-allowlist.ts → 2 (one comment, one guarded local)
```

## Files changed

| File | Change | Commit |
|---|---|---|
| `src/execution/event-router.ts` | `pickDenials()` — the one owner of the two-source rule, a union keyed on `tool_use_id` | c81df58 |
| `src/execution/event-router.test.ts` | two tests for it, both observed RED | c81df58 |
| `src/execution/supervisor.ts` | inline ternary replaced by the call | c81df58 |
| `scripts/probe-gsd-allowlist.ts` | two denial lists instead of one; guarded `input:` line; header rewritten | c81df58, 2c0b700 |
| `src/execution/agent-args.ts` | `ALLOWED_TOOLS` widened; comment replaced with what was measured | 2c0b700 |
| `src/execution/agent-args.test.ts` | value test added; the shape assertion made value-agnostic | 2c0b700 |
| `.planning/TRAPS.md` | T116, T117 — five columns, phase `quick 260908-bms` | 988b037 |
| `docs/TRAPS.md` | prose folded into the two existing sections, no new headings | 988b037 |
| `docs/agent-invocation.md` | flag row, probe intro, Fail bullet | 988b037 |
| `README.md` | 115 → 117 verified footguns | 988b037 |

## Self-Check: PASSED

All ten files claimed above exist on disk; all three commits are present in `git log`.
