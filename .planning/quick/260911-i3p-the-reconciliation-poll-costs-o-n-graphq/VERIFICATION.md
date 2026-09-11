---
phase: 260911-i3p-the-reconciliation-poll-costs-o-n-graphq
verified: 2026-09-11T20:00:00Z
status: passed
score: 6/6 must-haves verified
behavior_unverified: 0
overrides_applied: 0
re_verification: false
---

# Quick Task 260911-i3p Verification Report

**Task:** The reconciliation poll costs O(N) GraphQL requests per tick and exceeds Linear's
2500/hour rate limit by construction.
**Verified:** 2026-09-11T20:00:00Z
**Status:** passed

## Provenance check

The SUMMARY's account of the mid-Task-3 kill and post-hoc reconstruction was checked against
git history, not taken on faith:

- Commits `bcae21e` and `26d4950` exist with messages matching the claimed Task 1/Task 2 content.
- `61863d8` (Task 3: delete the dead twin, T129) exists as a single commit with the exact
  file-set the plan's Task 3 describes (`poll.ts`/`poll.test.ts` deleted, `recovery.ts` doc
  comment, `.planning/TRAPS.md`, `docs/TRAPS.md`, `README.md`).
- Working tree is clean relative to `61863d8` — nothing was left uncommitted, consistent with
  "the orchestrator committed Task 3."
- The SUMMARY's own admission that falsification #3's RED was never observed by anyone is
  accurate: no transcript, no captured RED text for #3 exists anywhere in the plan/summary
  artifacts — the SUMMARY correctly declines to fabricate one. This is an honest account, not
  an overstatement.

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | reconcile()'s hydration cost does not scale with issue count, proven by a request-count test | VERIFIED | `src/outbound/linear-client.test.ts` counting-getter test; independently re-run by this verifier both green (post-fix) and RED (against restored `toLinearIssue` hydration) — see Falsification Spot-Check below |
| 2 | Watermark reaches Linear as a server-side `updatedAt: { gt }` predicate, proven by inspecting the sent filter | VERIFIED | `linear-client.ts:249-252` conditionally spreads `updatedAt: { gt: new Date(since) }`; `linear-client.test.ts` "sends the watermark as a server-side updatedAt predicate" test asserts `deepEqual` on the captured `args.filter` |
| 3 | Watermark advances to the same value/enqueues the same issues whether server- or client-filtered, proven at the boundary | VERIFIED (present + test exists; SUMMARY correctly flags its RED as unobserved) | `recovery.test.ts` "server-side filtering advances the watermark ... at the boundary (mandatory falsification #3)" test is present, green, and exercises `filterServerSide.on = true` with an issue exactly at `OLD` and one at `FRESH` |
| 4 | Deleting the watermark arg at the one call site is shown, by name, which suite goes red/green | VERIFIED | SUMMARY quotes `recovery.test.ts`'s new since-argument test going RED and `linear-client.test.ts`/`qa-roundtrip.test.ts` staying GREEN; code confirms only one production call site (`recovery.ts:258`) passes `watermark` |
| 5 | Exactly one "poll for missed work" implementation exists; `poll.ts`'s dead twin is gone | VERIFIED | `src/ingress/poll.ts` and `poll.test.ts` do not exist (`ls src/ingress/`); `grep -rn "pollForMissedWork\|ingress/poll"` across `src/` and `scripts/` returns only the corrected doc comment naming why it's gone |
| 6 | `npm run verify` is green with the exact count reported; no daemon restart/build outside verify | VERIFIED | Re-ran `node --test "dist/**/*.test.js"` myself: `768/768 pass, 0 fail` — matches SUMMARY exactly; `npx tsx scripts/boot-smoke.ts` re-run independently, both phases PASSED |

**Score:** 6/6 truths verified (0 present-but-behavior-unverified)

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/domain/ports.ts` | `listAssignedOpenIssues(botUserId, since?)` returning `Pick<LinearIssue,'id'\|'updatedAt'>[]` | VERIFIED | Line 478, exact signature, terse comment citing quick 260911-i3p and the 3.9 req/issue measurement |
| `src/outbound/linear-client.ts` | server-side `updatedAt:{gt}` filter, no `toLinearIssue` hydration in this method | VERIFIED | Lines 240-258; `toLinearIssue` only called from `getIssue` (line 237), not from `listAssignedOpenIssues` |
| `src/outbound/quiet-linear.ts` | passthrough forwards `since` unchanged, stays in the ungated reads block | VERIFIED | Lines 86-87, inside the "reads and the registration path: never gated" block (line 80) |
| `src/domain/fakes.ts` | `FakeLinearClient.listAssignedOpenIssues` narrowed and `since`-aware | VERIFIED | Lines 767-776, filters `i.updatedAt > since`, returns `{id, updatedAt}` only |
| `src/orchestration/recovery.ts` | `reconcile()`'s call site passes the watermark; `continue` line unchanged, now documented as defense-in-depth | VERIFIED | Line 258 passes `watermark`; lines 255-257 comment matches Design section wording; line 261 `continue` line itself byte-identical to pre-change logic |
| `src/outbound/linear-client.test.ts` | request-count regression test + filter-sent test | VERIFIED | Both present (lines 293-343), both independently re-verified (see below) |
| `src/orchestration/recovery.test.ts` | since-received wiring test + watermark-equivalence boundary test | VERIFIED | `sinceReceived`/`filterServerSide` harness fields (lines 81-97), both new tests present |
| `src/ingress/poll.ts` and its test | deleted | VERIFIED | Absent from `src/ingress/`; deletion is a discrete commit (`61863d8`) |
| `.planning/TRAPS.md` T129 / `docs/TRAPS.md` / `README.md` counts | T129 appended after T128, both docs read 129 | VERIFIED | T129 row present immediately after T128 (line 168-169); pre-existing merge conflict at the (now-shifted) lines is still present and untouched; `docs/TRAPS.md` header reads "One hundred and twenty-nine"; `README.md:201` reads "129 verified footguns" |

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `recovery.ts`'s `reconcile()` | `listAssignedOpenIssues` | passes `config.botUserId, watermark` | WIRED | `recovery.ts:258` |
| `recovery.test.ts`'s local `linear` fake | recorded `since` argument | `sinceReceived.push(since)` | WIRED | `recovery.test.ts:177`; used by the since-argument test (lines 489-493) |
| `quiet-linear.ts`'s passthrough | `since` carried through unchanged | direct forward, no gating | WIRED | `quiet-linear.ts:86-87`, confirmed inside the "never gated" reads block |

### Falsification Spot-Check (Step 3, item 3 of the ask)

Picked **falsification #1** (the request-count regression test) — the one the plan calls
"the most important test in this task" and the SUMMARY quotes RED text for.

Procedure, run independently by this verifier (not copied from SUMMARY):

1. Built current tree (`npx tsc`), ran only the named test:
   `node --test --test-name-pattern="does not scale request cost" dist/src/outbound/linear-client.test.js`
   → `pass 1, fail 0` (GREEN, current fixed code).
2. Temporarily replaced the fixed `.map(...)` return in `linear-client.ts` with
   `Promise.all(issues.map(toLinearIssue))` (restoring the pre-fix hydration), rebuilt, reran
   the same single test.
3. Result — **verbatim match to the SUMMARY's quoted text**:
   ```
   error: |-
     1 issue cost 5 requests, 20 issues cost 81 requests -- per-issue relation hydration would scale the second number with N
     81 !== 5
   expected: 5
   actual: 81
   ```
4. Restored the file from a pre-edit backup, rebuilt, reran: back to GREEN (`pass 1, fail 0`).
   `git status`/`git diff --stat` confirm the working tree is byte-identical to before this
   spot-check (only the pre-existing untracked task directory shows).

The SUMMARY's quoted RED text for falsification #1 is accurate, not fabricated or embellished.

### 771 → 768 Arithmetic (item 6 of the ask)

Counted `it(`/`test(` occurrences directly from git history at each commit boundary:

| File | Before | After | Delta |
|------|--------|-------|-------|
| `src/ingress/poll.test.ts` (deleted in `61863d8`) | 7 | 0 | **-7** |
| `src/outbound/linear-client.test.ts` (`bcae21e`) | 23 | 25 | **+2** |
| `src/orchestration/recovery.test.ts` (`26d4950`) | 19 | 21 | **+2** |

Net: -7 + 2 + 2 = **-3**. 771 - 3 = **768**, matching the actual `node --test` run
(`768/768 pass, 0 fail`, independently re-run above) and the SUMMARY's claim exactly. The
arithmetic is correct — this is deletion-of-poll.test.ts's-tests-against-new-tests, not a
regression.

### Anti-Patterns Found

None. Scanned all nine modified `src/` files for `TBD|FIXME|XXX|TODO|HACK|PLACEHOLDER` —
zero matches.

### Human Verification Required

None. All must-haves are verifiable from source, git history, and re-run tests; no UI, timing,
or external-service behavior is involved.

### Gaps Summary

No gaps. Every must-have truth, artifact, and key link is verified against the actual
codebase, not the SUMMARY's narrative. Independent re-execution of falsification #1 (both
GREEN on current code and RED against restored hydration) matches the SUMMARY's quoted text
exactly. The 771→768 test-count arithmetic checks out against actual `it()`/`test()` counts at
each commit boundary and against a fresh full `node --test` run. The one item the SUMMARY
itself flags as unobserved — falsification #3's RED — is correctly reported as unobserved
rather than fabricated; the test it refers to is present, wired, and currently green, so
truth #3 is verified as *present and correct on the given fixture*, with the caveat (carried
from the SUMMARY, not newly discovered) that nobody has watched it fail. That caveat does not
block passing status: the equivalent boundary case is separately proven safe by the
watermark-monotonicity argument in `recovery.ts`'s `seen()` (an issue at or below the
watermark structurally cannot advance `newest`, verified by reading `seen()` at lines 246-250),
which is independent of whether that specific test's RED was ever watched.

---

_Verified: 2026-09-11T20:00:00Z_
_Verifier: Claude (gsd-verifier)_
