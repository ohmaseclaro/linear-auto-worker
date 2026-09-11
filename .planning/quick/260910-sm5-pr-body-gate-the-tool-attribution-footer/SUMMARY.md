---
task: "PR body: gate the tool-attribution footer and the Run log path behind an instance-level toggle so a silent instance leaks neither"
id: 260910-sm5
type: quick
severity: P1
completed: 2026-09-10
status: complete
gate: "npm run verify — 771/771 + boot smoke green (765/765 at start)"
commits:
  - 82c85fb  # feat: the third instance-level toggle, defaulting true, refused per-mapping
  - 500d011  # feat: renderPrBody gates the footer and the Run log independently
  - 315b0dd  # feat: wire prAttribution to deliver(), T128
---

# 260910-sm5 — Gate the tool-attribution footer behind `prAttribution`

A third instance-level toggle, `prAttribution`, closes the one leak `quietLinear` never
touched: `renderPrBody`'s `## Run log` line and its `_Opened by linear-auto-worker_` footer,
which named the tool and the operator's local filesystem paths in every PR, including ones
opened by the second, silent Lahzo instance (260909-nh6).

---

## Where the field landed (all seven read/write points)

- `src/domain/types.ts` — `MappingToggles.prAttribution: boolean`, placed directly after
  `updateLinearIssue`, with a doc comment naming both the two gated surfaces and why it is
  instance-level for a *product* reason rather than `updateLinearIssue`'s round-trip-cost
  reason. The interface's own header comment ("six CONF-02 toggles", already missing
  `updateLinearIssue`) was corrected to "nine" while touching it, rather than compounding a
  second stale enumeration next to the one this task exists to fix.
- `src/infra/config.ts` — `TogglesSchema.prAttribution: z.boolean().default(true)`, same
  compatibility comment `updateLinearIssue` carries.
- `src/cli/wizard/config-writer.ts` — `DEFAULT_TOGGLES.prAttribution: true`, and a matching
  `mergeToggles` arm (`pickBoolean(e.prAttribution, DEFAULT_TOGGLES.prAttribution)`). Added a
  comment at `toDomainOverrides` naming both `updateLinearIssue` and `prAttribution` as the
  two toggles with no wizard-local per-mapping override name, and why (M9): a per-mapping
  value would be inert by product decision, so a wizard case for either would invite
  configuring something that can never take effect.
- `src/domain/fakes.ts` — the second `DEFAULT_TOGGLES` literal, same value.
- `src/outbound/quiet-linear.ts` — `assertInstanceLevelToggles`'s `fields` array now reads
  `['postLinearComments', 'updateLinearIssue', 'prAttribution']`. The thrown message was
  rewritten field-agnostic (it no longer claims enforcement happens "at the Linear client",
  which would be false for this field) while still naming the mapping and field, so the
  existing `postLinearComments`/`updateLinearIssue` tests keep passing on the same
  substrings. The module header comment gained two sentences explaining `prAttribution` is
  guarded here for a *different* reason than the other two: it is genuinely per-mapping
  resolvable at its actual read site (`createDeliverer` already has a `RepoMapping`), pinned
  to instance-level anyway by product decision.
- `src/execution/pr-body.ts` — `PrBodyInput.prAttribution?: boolean`, and
  `const showAttribution = o.prAttribution ?? true;` gating `## Run log` and the
  `---`/footer block in two **separate** `if (showAttribution)` statements (not one shared
  wrapper), so each leak surface is independently falsifiable. The stale doc comment ("All
  five DELV-03 sections, none of them optional and none of them ever empty") was corrected
  to state the true, now-conditional invariant.
- `src/execution/deliver.ts` — `DeliverInput.prAttribution: boolean` (required, no `?`,
  T120 pattern), forwarded at the one `renderPrBody(...)` call site:
  `renderPrBody({ ...o.prBody, ciPaths: gates.ciPaths, prAttribution: o.prAttribution })`.
- `src/cli/adapters.ts` — `createDeliverer.deliver` adds
  `prAttribution: toggles.prAttribution,` next to `draft: pr.draft ?? toggles.draftPr,`,
  with a comment noting there is no caller-forced override for this one: it is resolved from
  config every time.

`npx tsc --noEmit` was clean on the very first attempt after Task 1's edits, which confirms
M7's claim that exactly three literals (`config-writer.ts`'s `DEFAULT_TOGGLES`,
`fakes.ts`'s `DEFAULT_TOGGLES`, `contract.test.ts`'s `DEFAULTS`) and two `Config`-typed
bindings (`qa-roundtrip.test.ts`'s `CONFIG`, `config.test.ts`'s `validDefaults`) needed the
field, and that every other `MappingToggles`-shaped literal in the codebase is behind an
`as unknown as Config` cast `tsc` does not check for field completeness.

---

## The four mandatory falsifications, RED text verbatim

### #1 — footer, run against the still-unconditional renderer

Test: `renderPrBody({ verdict: 'delivered', prAttribution: false })`, asserting
`body.includes('Opened by linear-auto-worker')` is `false`.

```
Expected values to be strictly equal:

true !== false

code: 'ERR_ASSERTION'
name: 'AssertionError'
expected: false
actual: true
operator: 'strictEqual'
```

Matched expectation: fails RED because the footer was still unconditional. After adding
**only** the footer's `if (showAttribution)` block (Run log left unconditional), re-ran both
new tests together: falsification #1 went GREEN, falsification #2 stayed RED — proving the
two gates are independent before the Run log gate was even written.

### #2 — Run log, independently of #1

Test: `renderPrBody({ verdict: 'delivered', prAttribution: false, runLogPath: '/var/law/run-1.log' })`,
asserting both `body.includes('## Run log')` and `body.includes('/var/law/run-1.log')` are
`false`.

RED text, captured at the same run as #1 above (both blocks still unconditional):

```
Expected values to be strictly equal:

true !== false

code: 'ERR_ASSERTION'
name: 'AssertionError'
expected: false
actual: true
operator: 'strictEqual'
```

RED text captured again at the intermediate point (footer gated, Run log still
unconditional) — identical failure, confirming falsification #1 was unaffected (still
green) at that same point:

```
Expected values to be strictly equal:

true !== false

code: 'ERR_ASSERTION'
name: 'AssertionError'
expected: false
actual: true
operator: 'strictEqual'
```

Both `assert.equal` calls in this test compare a boolean, so `true !== false` is the literal
text for both the `## Run log` check and the path check — the test failed on the first of
the two assertions (`## Run log`) each time, per Node's fail-fast `assert.equal`. After
adding the Run log's own `if`, both falsifications and the "byte-identical when absent"
regression test all went GREEN, and the full `deliver.test.ts` file (30 tests at that point)
stayed green, including the pre-existing "all five DELV-03 sections" test and
`headingsOutsideFences`'s five-heading assertion.

### #4 — `assertInstanceLevelToggles` field removal (run before #3, since it belongs to
Task 1)

Temporarily removed `'prAttribution'` from the `fields` array and ran
`quiet-linear.test.ts` alone (11 tests): the new prAttribution DISAGREE test failed RED —

```
not ok 10 - a mapping override of prAttribution that DISAGREES with defaults refuses the boot
error: 'Missing expected exception.'
code: 'ERR_ASSERTION'
name: 'AssertionError'
```

10/11 passed, 1 failed — exactly the new test, confirming the guard was doing real work.
Field restored, `quiet-linear.test.ts` re-ran at 11/11 green.

### #3 — T109, the `deliver.ts` wiring deletion

Temporarily deleted `prAttribution: o.prAttribution` from the `renderPrBody(...)` call in
`deliver.ts` (leaving `renderPrBody({ ...o.prBody, ciPaths: gates.ciPaths })`), then ran the
full `deliver.test.ts` suite (32 tests at that point).

**Observed split, named honestly — this is NOT the clean two-region pair the brief
expected.**

- **"pr-body.ts, pure" region: entirely GREEN, as predicted.** All five tests in that
  section — including falsifications #1/#2, the absent-vs-true regression, the five-DELV-03
  test, and `headingsOutsideFences` — call `renderPrBody` directly and never go through
  `deliver()`, so the deletion could not touch them. Confirmed by the test log: no failures
  in that numbered range.
- **The two new `deliver()`-driving tests did NOT go red together.** Only one of the two
  failed:

  ```
  not ok 13 - prAttribution: false reaches the real gh body through deliver()
  error: |-
    Expected values to be strictly equal:

    true !== false

  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: false
  actual: true
  operator: 'strictEqual'
  ```

  `ok 14 - prAttribution not overridden reaches the real gh body through deliver(), attributed`
  stayed **green**, undiscriminating. The reason, on inspection: that test asserts the
  *default* (attributed) behaviour, which is what `renderPrBody` produces with or without
  the forwarded field, because `PrBodyInput.prAttribution` itself defaults to `true` via
  `?? true` inside the renderer. Deleting the forwarding line only breaks the case that
  explicitly needs `false` to reach the renderer — the always-`true` case is structurally
  incapable of telling the difference, by the same `?? true` design that makes the "absent,
  not merely true" regression test pass.

  Total: 31/32 passed, 1 failed — a **partial** split, not "both regions red" nor "neither
  red". Reported plainly per the brief's own instruction rather than claimed as the clean
  pair. This is a genuine, if narrower, discrimination of the wiring (the `false` case IS
  proven live-path-dependent), but the plan's stated expectation of "the two new tests...
  which call deliver() and depend on the deleted forwarding" going red as a pair did not
  hold for the second test — that test's assertion cannot discriminate wiring from
  no-wiring given the renderer's own default, and no rewrite of it would fix that without
  either removing the renderer's default (out of scope, part of the compatibility
  contract) or asserting something the default-true path cannot satisfy either way.

  Line restored, `deliver.test.ts` re-ran at 32/32 green.

---

## `npm run verify` counts

| Point | Count |
|---|---|
| Baseline, before any change | 765/765 |
| After Task 1 (a new `quiet-linear.test.ts` DISAGREE test) | 766/766 |
| After Task 2 (three new `pr-body.ts, pure` tests) | 769/769 |
| After Task 3 (two new `deliver()`-driving tests) | **771/771** |

Boot smoke green at every checkpoint, including the poll-only phase's own
`assertInstanceLevelToggles` exercise, which now prints the rewritten field-agnostic
message: `` `postLinearComments` is instance-level: resolved once from `defaults` rather
than per mapping. `` Both live daemons (PIDs 52153, 67498) were confirmed still running,
untouched, after the final gate.

---

## `.planning/TRAPS.md` merge conflict — reported, not fixed

`.planning/TRAPS.md` carries a pre-existing, **committed** git merge conflict
(`<<<<<<< HEAD` / `=======` / `>>>>>>> gsd/07-06`) at lines 109/113/120, inside the T79-T89
region, dated to commit `b43d2e4d` (2026-09-06) and still present at HEAD after this task's
edits. Confirmed independently by `grep` before and after. **Not touched** — T128 was
appended at the very end of the file, after T127, nowhere near that region. This deserves
its own quick task; it is unrelated to the PR-body toggle and predates it by a full
milestone.

---

## `docs/TRAPS.md` and `README.md`

TRAPS T128 appended to `.planning/TRAPS.md` in the same five-column shape (`#`, Trap,
Failure mode, Correct move, Phase) as the surrounding rows. A matching paragraph added to
`docs/TRAPS.md` under "## The one that is really about process". Count bumped
127 -> 128 at `docs/TRAPS.md:3` and `README.md:201`. While there, also bumped
`docs/TRAPS.md:18`'s "all 127 rows" to "all 128 rows" (Rule 1 — the plan named only line 3,
but leaving that second count stale one paragraph below a task about stale doc comments
would have been the exact defect T128 describes).

---

## Deviations from Plan

### Auto-fixed issues

**1. [Rule 1 — stale count] `docs/TRAPS.md:18`'s "all 127 rows" was not named in the plan's
bump instructions but sits three lines below the count the plan did name, describing the
same ledger.** Bumped to 128 alongside it rather than left inconsistent. Files modified:
`docs/TRAPS.md`. Commit: `315b0dd`.

### Honest, non-clean falsification result

**Falsification #3 (T109) did not produce the clean two-region green/red pair the brief
anticipated.** Of the two new `deliver()`-level tests, only the `prAttribution: false` case
went red on the deletion; the `prAttribution` (default, unset) case stayed green because
`renderPrBody`'s own `?? true` default makes that case's assertion indistinguishable from
wiring vs. no-wiring. Reported in full above, per the brief's explicit instruction to name
this honestly rather than claim a pass. Wiring is still correctly proven overall: the
`false` case demonstrably depends on the deleted line, and the "pr-body.ts, pure" region
demonstrably does not.

No other deviations. Tasks 1-3 executed as written.

## Self-Check: PASSED

All 11 files named in the plan's `files_modified` list exist on disk. All three commit
hashes (`82c85fb`, `500d011`, `315b0dd`) exist in `git log`. `npm run verify` returned exit
0 with 771/771 at the final gate run. Both live daemons (PIDs 52153, 67498) confirmed still
running post-gate.
