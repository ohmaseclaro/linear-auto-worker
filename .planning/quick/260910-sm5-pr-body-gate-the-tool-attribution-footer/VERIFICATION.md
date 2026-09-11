---
phase: 260910-sm5-pr-body-gate-the-tool-attribution-footer
verified: 2026-09-11T00:25:00Z
status: passed
score: 5/5 must-haves verified
behavior_unverified: 0
overrides_applied: 0
---

# Quick Task 260910-sm5: Gate the tool-attribution footer — Verification Report

**Task Goal:** PR body — gate the tool-attribution footer and the `## Run log` path behind an
instance-level toggle so a silent instance leaks neither, while every config written before the
toggle existed renders a byte-identical body.

**Verified:** 2026-09-11T00:25:00Z
**Status:** passed
**Commits checked:** 82c85fb, 500d011, 315b0dd (all present in `git log`, on `main`)

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | A false `prAttribution` produces a body with neither `## Run log` nor the footer; true/absent renders byte-identically | ✓ VERIFIED | `src/execution/pr-body.ts:67,116,122` — `showAttribution = o.prAttribution ?? true` gates both blocks. `deliver.test.ts` "regression: an ABSENT prAttribution renders byte-identically to an explicit true" passes (ran full suite: 771/771). |
| 2 | A config with no `prAttribution` key resolves to `true` and renders the unchanged body, proven with an ABSENT fixture | ✓ VERIFIED | `src/infra/config.test.ts:265-282` destructures `prAttribution` OUT of `validDefaults` (key absent, not `true`) and asserts `resolved.prAttribution === true`. Render-layer absent case covered by the deliver.test.ts regression test above. |
| 3 | A per-mapping override disagreeing with defaults fails boot, naming mapping and field | ✓ VERIFIED | `src/outbound/quiet-linear.ts:134` — `fields` array includes `'prAttribution'`. `quiet-linear.test.ts:178-195` asserts the throw and matches `/prAttribution/` in the message. |
| 4 | The toggle reaches `renderPrBody` through the real production chain, proven by T109 deletion | ✓ VERIFIED | Independently reproduced (see Behavioral Spot-Checks below): deleting `prAttribution: o.prAttribution` from `deliver.ts:151` and running `deliver.test.ts` produces 31/32 pass, 1 fail — test 13 (`prAttribution: false reaches the real gh body through deliver()`) goes RED with `true !== false`; the "pr-body.ts, pure" region and the "not overridden" test stay green. Restored to 32/32 green after re-adding the line. |
| 5 | `renderPrBody`'s doc comment no longer claims all five sections are unconditional | ✓ VERIFIED | `src/execution/pr-body.ts:51-56` now reads "DELV-03's five sections render unconditionally, except two: `## Run log` and the trailing attribution line are gated by the instance-level `prAttribution` toggle." `.planning/REQUIREMENTS.md`'s DELV-03 line does not itself assert unconditionality, so no contradiction exists there either. |

**Score:** 5/5 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/domain/types.ts` | `MappingToggles.prAttribution: boolean` | ✓ VERIFIED | Line 248, required field, positioned after `updateLinearIssue`. |
| `src/infra/config.ts` | `TogglesSchema.prAttribution` with `.default(true)` | ✓ VERIFIED | Line 31: `prAttribution: z.boolean().default(true)`. |
| `src/execution/pr-body.ts` | Two INDEPENDENT `if` blocks gating Run log and footer | ✓ VERIFIED | Lines 116-120 and 122-125 — two separate `if (showAttribution)` blocks, not one shared wrapper. |
| `src/execution/deliver.ts` | `DeliverInput.prAttribution: boolean` required, forwarded at the `renderPrBody` call | ✓ VERIFIED | Line 53 (required, no `?`), line 151 forwards it. |
| `src/cli/adapters.ts` | `createDeliverer` resolves `toggles.prAttribution` and passes it through | ✓ VERIFIED | Line ~680: `prAttribution: toggles.prAttribution,` next to `draft: pr.draft ?? toggles.draftPr,`. |
| `src/outbound/quiet-linear.ts` | `assertInstanceLevelToggles`'s `fields` includes `'prAttribution'`; message no longer Linear-client-specific | ✓ VERIFIED | Line 134 includes the field. Message rewritten field-agnostic (confirmed via boot-smoke log line printed during `npm run verify`: `` `postLinearComments` is instance-level: resolved once from `defaults` rather than per mapping. ``). |
| `.planning/TRAPS.md` T128; `docs/TRAPS.md`; `README.md` count | 127 -> 128 | ✓ VERIFIED | T128 row appended after T127 (line 168). `docs/TRAPS.md:3` reads "One hundred and twenty-eight"; `docs/TRAPS.md:18` reads "all 128 rows" (executor also fixed this un-named stale count — reasonable Rule-1 auto-fix). `README.md:201` reads "128 verified footguns". |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|----|--------|---------|
| `config.json` | `TogglesSchema` | `z.boolean().default(true)` | ✓ WIRED | Confirmed by `config.test.ts` absent-key test. |
| `Config.defaults` | `createDeliverer`'s `togglesFor` | `resolveToggles` | ✓ WIRED | `adapters.ts` line: `const toggles = togglesFor(deps.config, deps.index, repo.repoSlug);` then reads `toggles.prAttribution`. |
| `createDeliverer` | `DeliverInput.prAttribution` | object literal passed to `deliverPullRequest` | ✓ WIRED | `prAttribution: toggles.prAttribution,` in the call. |
| `DeliverInput` | `renderPrBody` | `deliver.ts:151` | ✓ WIRED | `renderPrBody({ ...o.prBody, ciPaths: gates.ciPaths, prAttribution: o.prAttribution })`. Independently falsified by deleting this exact fragment (see spot-check). |
| `assertInstanceLevelToggles` | boot (`law start`) | `fields` array + throw | ✓ WIRED | `quiet-linear.test.ts` DISAGREE test passes; falsification (field removed) turns it RED per SUMMARY, not independently re-run here but code inspection confirms the loop iterates `fields` and throws per-field — mechanically sound. |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Full test suite | `npm run verify` | `# tests 771 / # pass 771 / # fail 0`, SMOKE PASSED, POLL-ONLY PHASE PASSED | ✓ PASS |
| T109 wiring falsification (independently reproduced, not just read from SUMMARY) | Delete `prAttribution: o.prAttribution` from `deliver.ts:151`, run `npx tsx --test src/execution/deliver.test.ts` | 31/32 pass, 1 fail — test 13 (`prAttribution: false reaches the real gh body through deliver()`) RED with `AssertionError: true !== false`; test 14 (not-overridden case) and all "pr-body.ts, pure" tests stayed green | ✓ PASS — matches SUMMARY's claim exactly, restored to 32/32 green afterward |

### Anti-Patterns Found

None. No `TODO`/`FIXME`/`HACK`/`TBD`/`XXX` markers introduced in any of the 18 files modified by this task. No empty implementations, no hardcoded stub returns.

### Requirements Coverage

No `requirements:` frontmatter field on this PLAN.md (quick task, not a phase plan) — no formal requirement IDs to cross-reference. DELV-03 in `.planning/REQUIREMENTS.md` remains textually unchanged by deliberate, documented decision (verified: the REQUIREMENTS.md line does not itself assert "unconditional," so no contradiction was introduced).

### Verification item 6 — the T109 half-discrimination claim

The SUMMARY states falsification #3 did not produce a clean two-region red/green split: only the
`prAttribution: false` deliver()-level test went red; the `prAttribution` (not overridden,
defaults true) deliver()-level test stayed green even with the wiring deleted.

**Confirmed correct by reading the code and independently reproducing it.** `renderPrBody`
computes `const showAttribution = o.prAttribution ?? true;` (`pr-body.ts:67`). When the
`prAttribution: o.prAttribution` fragment is deleted from the `renderPrBody(...)` call in
`deliver.ts`, the renderer receives no `prAttribution` key at all — its own `?? true` fallback
makes that indistinguishable from a wired call where `DeliverInput.prAttribution` was `true`.
The "not overridden" test's `input()` default is `prAttribution: true`, so wired-and-true and
unwired-defaulting-to-true render identically — the test has no discriminating power over the
wiring. The `false` test IS discriminating, because there is no code path that turns an intended
`false` into a rendered `false` without the forwarding line. This is exactly the executor's
stated reasoning, and it is correct. The wiring is proven live by the one test that CAN
discriminate it; the other test's insensitivity is a property of the `?? true` default contract
that Task 1/2 deliberately preserve for backward compatibility, not a gap in coverage.

### Human Verification Required

None. All must-haves are mechanically verifiable and were independently re-derived from the
codebase, not taken from SUMMARY.md's word.

### Gaps Summary

No gaps. Every must-have truth, artifact, and key link was independently confirmed by reading
the actual source at HEAD and, for the highest-risk claim (T109 wiring), by re-running the
falsification procedure myself rather than trusting the transcript in SUMMARY.md. The
pre-existing `.planning/TRAPS.md` merge-conflict markers (lines 109/113/120, predates this task,
out of scope per the orchestrator's brief) remain untouched, as required — confirmed via grep.

---

_Verified: 2026-09-11T00:25:00Z_
_Verifier: Claude (gsd-verifier)_
