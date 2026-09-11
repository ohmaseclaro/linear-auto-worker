---
task: "PR body: gate the tool-attribution footer and the Run log path behind an instance-level toggle so a silent instance leaks neither"
id: 260910-sm5
type: quick
severity: P1
created: 2026-09-10
branch: main
files_modified:
  - src/domain/types.ts
  - src/domain/contract.test.ts
  - src/infra/config.ts
  - src/infra/config.test.ts
  - src/cli/wizard/config-writer.ts
  - src/cli/wizard/config-writer.test.ts
  - src/domain/fakes.ts
  - src/outbound/quiet-linear.ts
  - src/outbound/quiet-linear.test.ts
  - src/orchestration/qa-roundtrip.test.ts
  - src/execution/pr-body.ts
  - src/execution/deliver.ts
  - src/execution/deliver.test.ts
  - src/cli/adapters.ts
  - .planning/TRAPS.md
  - docs/TRAPS.md
  - README.md
gate: npm run verify   # 765/765 + boot smoke green before; report the exact number after
must_haves:
  truths:
    - "A false `prAttribution` (instance-level, default true) produces a PR body with neither `## Run log` nor the `_Opened by linear-auto-worker_` footer line; a true or ABSENT value renders exactly like today, byte-for-byte."
    - "A config with no `prAttribution` key at all — the shape of the live `~/.linear-auto-worker/config.json` — still parses, still resolves the toggle to `true`, and still renders the unchanged five-section body. This is proven with a fixture where the key is ABSENT, not merely `true`."
    - "A per-mapping override of `prAttribution` that disagrees with `defaults` fails `law start` at boot, naming the mapping and the field — exactly like `postLinearComments`/`updateLinearIssue` do today."
    - "The toggle reaches `renderPrBody` through the real production chain (`createDeliverer` -> `deliver()` -> `renderPrBody`), proven by deleting the wiring argument and observing the direct-renderer tests stay green while the `deliver()`-level tests go red (T109)."
    - "`renderPrBody`'s doc comment no longer claims all five DELV-03 sections are unconditional — that claim is false the moment this toggle exists, and the comment says so instead of lying next to the code that contradicts it."
  artifacts:
    - "src/domain/types.ts — `MappingToggles.prAttribution: boolean`, required, sitting beside `postLinearComments`/`updateLinearIssue`."
    - "src/infra/config.ts — `TogglesSchema.prAttribution` with `.default(true)`, same compatibility contract as `updateLinearIssue`."
    - "src/execution/pr-body.ts — `renderPrBody` gates `## Run log` and the footer in two INDEPENDENT `if` blocks behind `PrBodyInput.prAttribution ?? true`."
    - "src/execution/deliver.ts — `DeliverInput.prAttribution: boolean` (required, T120 pattern) forwarded at the one `renderPrBody(...)` call site."
    - "src/cli/adapters.ts — `createDeliverer` resolves `toggles.prAttribution` (already-computed `togglesFor(...)`) and passes it through, next to `draftPr`."
    - "src/outbound/quiet-linear.ts — `assertInstanceLevelToggles`'s `fields` array includes `'prAttribution'`; its error message is no longer Linear-client-specific."
    - ".planning/TRAPS.md T128; docs/TRAPS.md prose; README count 127 -> 128."
  key_links:
    - "`config.json` -> `ConfigSchema`/`TogglesSchema` -> `Config.defaults` -> `createDeliverer`'s `togglesFor` -> `DeliverInput.prAttribution` -> `renderPrBody` — five hops, the exact shape T120 found silently broken at its far end (`prBody` reaching nobody for a whole milestone)."
    - "`assertInstanceLevelToggles` (`quiet-linear.ts`) -> boot (`law start`) — the ONLY place a per-mapping override of the new toggle is rejected; nothing at the render or delivery call sites re-checks it."
---

<objective>
A silent second instance (260909-nh6) already suppresses every Linear write via `quietLinear`.
It does not suppress the one artifact that still names the tool and the operator's machine:
the pull request body. `renderPrBody` unconditionally appends `## Run log` (the operator's
home directory and the config-root name, e.g. `/Users/augustoclaro/.law-lahzo/runs/<id>.jsonl`)
and a footer reading `_Opened by linear-auto-worker._` — into every PR the worker opens,
including ones opened by the silent instance into a `lahzolabs/*` repository where the
operator's use of this tool must not be visible.

Add a THIRD instance-level toggle, `prAttribution`, alongside `postLinearComments` and
`updateLinearIssue`. Default `true` so every config written before today — including the live
`~/.linear-auto-worker/config.json`, which has no such key — renders byte-identically. Wire it
through the same five-hop chain `updateLinearIssue` proved out, and prove the wiring with the
same T109 deletion procedure this repo now runs on every toggle addition.

Purpose: the operator's live silent instance opens PRs today (M1). Every one of them currently
leaks. This closes that leak without the operator touching `~/.law-lahzo/config.json` first —
that edit is explicitly the operator's, not this task's (see brief).

Output: `prAttribution: boolean` on `MappingToggles`/`TogglesSchema`/every `DEFAULT_TOGGLES`
literal; `renderPrBody` gating both leak surfaces independently; the toggle wired end to end
from config to the real `gh pr create --body-file` call; a boot-time refusal for a disagreeing
per-mapping override; TRAPS T128.
</objective>

<measured_facts>
Read from source at HEAD. Nothing recalled — every file/line below was opened and confirmed,
not assumed from the brief.

**M1 — the exact leak, from the real renderer.** `src/execution/pr-body.ts:102-107`:
`renderPrBody` unconditionally does `out.push('## Run log')` followed by the path (or
`'(no run log path recorded)'` if absent), then unconditionally `out.push('---')` and
`out.push('_Opened by linear-auto-worker. The worker pushed and opened this PR, not the
agent._')`. Both are the LAST two blocks in the function, appended with no gate of any kind.
There is exactly ONE production call site: `src/execution/deliver.ts:145`,
`renderPrBody({ ...o.prBody, ciPaths: gates.ciPaths })`.

**M2 — the doc comment this task falsifies.** `pr-body.ts:43-50`, directly above
`renderPrBody`: *"All five DELV-03 sections, none of them optional and none of them ever
empty."* `## Run log` is one of the five. The moment it is conditionally omitted, that
sentence is false, in the file that most needs it to stay true — the exact "comment that
became false is a defect" case the brief names. Fixed in Task 2, in the same commit.

**M3 — the two existing instance-level toggles, as the template.** `MappingToggles`
(`types.ts:207-236`) has `postLinearComments: boolean` and `updateLinearIssue: boolean`.
`TogglesSchema` (`config.ts:23-39`) parses `postLinearComments: z.boolean()` (no default —
it predates the compatibility requirement) and `updateLinearIssue: z.boolean().default(true)`
with the comment: *"every config written before this field existed must still load, and must
load as today's behaviour."* `prAttribution` follows `updateLinearIssue`'s shape exactly, not
`postLinearComments`'s — it is a NEW field on an old schema, so it needs the default.

**M4 — `assertInstanceLevelToggles`, the enforcement point.** `quiet-linear.ts:127-142`:
`const fields = ['postLinearComments', 'updateLinearIssue'] as const;` then, per mapping, per
field, throws if `mapping.overrides?.[field]` is defined and disagrees with
`config.defaults[field]`. The thrown message says *"these two toggles are instance-level:
they are enforced at the Linear client"* — true for these two, and it will be FALSE for
`prAttribution`, which is enforced at `createDeliverer`/`renderPrBody`, nowhere near the
Linear client. The message needs rewriting, not just the `fields` array.

**M5 — where the toggle must be READ, and why it is a different seam from M3/M4's two.**
`postLinearComments`/`updateLinearIssue` are read straight off `config.defaults` inside
`quietLinear` (wired at `daemon.ts:550`), because that wrapper is handed only an issue id and
a repo-slug lookup would cost a round trip per comment (`quiet-linear.ts:14-32`). The PR body
is different: `createDeliverer` (`adapters.ts:657-680`) is handed a `RepoMapping` — it already
resolves `const toggles = togglesFor(deps.config, deps.index, repo.repoSlug);` and reads
`toggles.draftPr` from it. `prAttribution` is genuinely per-mapping-RESOLVABLE at this seam
(unlike the other two), and the product decision is that it must not vary within one instance
regardless — a workspace where the tool is silent must not have one repo's PRs speak while a
sibling's stay quiet. So it is read from the already-computed `toggles` object (cheap, no
extra round trip) and STILL policed by `assertInstanceLevelToggles` at boot, for a different
reason than the other two.

**M6 — the full production chain, traced hop by hop.** `run-engine.ts:785` calls
`deliverer.deliver(worktreeOf(run), repoOf(run), { title, prBody, ...(partial ? {draft:true}
: {}) })` — this object shape (`Deliverer` port, `ports.ts:373-384`) has NO toggle field and
none is added here; `prAttribution` is resolved entirely inside `createDeliverer`, same as
`draftPr` is (the port's `draft?` is a caller-forced OVERRIDE, which `prAttribution` has no
equivalent of). `createDeliverer.deliver` (`adapters.ts:661-680`) resolves `toggles` and
currently builds the `deliverPullRequest(...)` call (imported as `deliverPullRequest`, aliased
from `deliver` in `execution/deliver.ts:32`) with `draft: pr.draft ?? toggles.draftPr`.
`deliver()` (`deliver.ts:89-149`) takes `DeliverInput`, and its ONE `renderPrBody(...)` call is
at line 145.

**M7 — every place a complete `MappingToggles` literal is built, checked one at a time, not
guessed.** `grep -rn ": MappingToggles\b" src` returns exactly three genuinely type-checked
literals: `config-writer.ts:52` (`DEFAULT_TOGGLES`), `domain/fakes.ts:218` (`DEFAULT_TOGGLES`),
`domain/contract.test.ts:67` (`DEFAULTS`). Two more literals are assigned directly to a
`: Config`-typed binding with NO bypass cast and would also fail to compile once the field is
required: `orchestration/qa-roundtrip.test.ts:52` (`const CONFIG: Config = {...}`, ends at
`:76` with a plain `};`) and `infra/config.test.ts:18-26` (`validDefaults`, spread into
`config()`'s return at `:44-45` with no cast). Every OTHER `Config`-shaped object literal found
by `grep -rln "postLinearComments:.*true\|postLinearComments:.*false" src` —
`adapters.inject.test.ts:150`, `adapters.verdict.test.ts:52,246`, `daemon-fixture.ts` (need to
confirm at execution time whether its literal is cast), `usage.test.ts:57,274`,
`fanout.test.ts:387`, `run-engine.test.ts:87,1006`, `quiet-linear.test.ts`'s `configWith` — was
individually opened and confirmed to end in `} as unknown as Config;`. `tsc` does not check
field completeness through that cast, and none of those suites reads `toggles.prAttribution`,
so none of them needs editing. **Do not touch files outside the five just named on the theory
that "there might be more" — this list was produced by opening every match, not by pattern
count.**

**M8 — `mergeToggles`'s own doc comment states the exact rule this task must satisfy.**
`config-writer.ts:90-100`: *"A field this function does not NAME is a field a `law setup`
re-run DELETES... Add the field here in the same commit that adds it to `MappingToggles`, or
the round-trip test below goes red — which is the point of it."* The round-trip test is
`config-writer.test.ts:390-410`, already extended once for `updateLinearIssue` under the
260909-nh6 banner comment at `:384-388`.

**M9 — the wizard has no per-mapping override name for either existing instance-level toggle,
and that is precedent, not an oversight.** `mapping.ts`'s `TOGGLE_NAMES`
(`linearComments, slackNotifications, baseBranch, draftPr, questionTimeoutMs, maxRunTimeMs`)
and `config-writer.ts`'s `toDomainOverrides`/`fromDomainOverrides` switch (`:124-155`) have NO
case for `updateLinearIssue` at all — it is settable only as a global default, never per
mapping, from the wizard's own UI. `prAttribution` gets the same treatment for the same
reason (M4/M5): a per-mapping value would be inert by product decision, and
`assertInstanceLevelToggles` is what would catch a hand-edited `config.json` that tried anyway.

**M10 — `pr-body.test.ts` does not exist**, confirmed by `ls src/execution/*.test.ts`.
`renderPrBody`'s own unit tests, and every `deliver()`-level integration test, both live in
`src/execution/deliver.test.ts` — the "pr-body.ts, pure" section (direct `renderPrBody(...)`
calls, starting at the `// ================================================================
pr-body.ts, pure` banner) versus the `deliver()`-calling tests earlier in the same file (using
the `input()`/`harness()` helpers and reading `h.bodyAtCreate()`). The T109 pair for this task
is therefore two REGIONS of one file, not two files — same conclusion 260909-lvl's M3 reached
for the same reason, recorded there so this task does not re-derive it.

**M11 — a pre-existing, unrelated defect found and NOT fixed here.** `.planning/TRAPS.md` has
an UNRESOLVED git merge conflict (`<<<<<<< HEAD` / `=======` / `>>>>>>> gsd/07-06`) at lines
109/113/120, inside the T79-T89 region, committed since `b43d2e4d` (2026-09-06) and still
present at HEAD (`git status` is clean — this is committed content, not a local artifact).
It predates this task by a full milestone and is unrelated to the PR-body toggle. **Do not
attempt to resolve it as part of this task** — it deserves its own quick task. T128 (Task 3)
is appended at the END of the file, after T127, nowhere near that region, so this task's own
edit cannot make the existing conflict worse or better.

**M12 — the live-daemon-vs-`npm run verify` tension, and why it resolves the same way it did
on 260909-nh6.** This brief says "do not run `npm run build`, do not touch `dist/`" while also
setting the gate to `npm run verify`, which runs `npm run clean && tsc` internally and DOES
rewrite `dist/`. 260909-nh6's own M14 measured this exact situation (a live daemon running
off `dist/` while `npm run verify` needed to run) and concluded: *"`npm run clean && tsc`
rewrites `dist/`, which the running process does not re-read: node resolved its modules at
boot. Do not restart it as part of this task."* The prohibition is on RESTARTING the two live
daemons (PIDs 52153, 67498) and on reading/writing either instance's real `config.json` — not
on running the mandated gate. `npm run verify` is required by this brief's own constraints
("Must be green at the end") and is safe under that precedent. Task 3 states this again at
the point it runs the gate, so the executor does not have to re-derive it under time pressure.
</measured_facts>

<design>
## Naming and shape

`prAttribution: boolean` — the brief's own suggested name, kept because there is no reason to
invent a second one. Lives on `MappingToggles` next to `postLinearComments`/`updateLinearIssue`
(both in `types.ts` and the parallel `TogglesSchema` in `config.ts`), defaults to `true`
everywhere a default is expressed, and is READ (not merely declared) at exactly three points:
`assertInstanceLevelToggles`'s `fields` array (boot-time refusal), `createDeliverer` (resolves
it from `toggles`), and `renderPrBody` (acts on it). Grep for `prAttribution` after this task
and expect to find it in all three, plus every fixture/default object that names its siblings.

## `renderPrBody`'s two independent gates

Not one shared `if` wrapping both blocks — TWO separate `if (showAttribution) { ... }`
statements, one around the `## Run log` block, one around the `---`/footer block. Functionally
they always agree (same boolean), but structurally independent, so each of mandatory
falsifications #1 and #2 can be reproduced by breaking exactly one of the two without touching
the other — which is the point of running them as separate falsifications rather than one.

```
const showAttribution = o.prAttribution ?? true;
...
if (showAttribution) {
  out.push('## Run log');
  out.push(present(o.runLogPath) ? `\`${present(o.runLogPath)}\`` : '(no run log path recorded)');
  out.push('');
}

if (showAttribution) {
  out.push('---');
  out.push('_Opened by linear-auto-worker. The worker pushed and opened this PR, not the agent._');
}
```

## The stale comment, corrected

Current (`pr-body.ts:43-50`):

> All five DELV-03 sections, none of them optional and none of them ever empty.

Replace with something that states the ACTUAL, now-conditional invariant — e.g.: DELV-03's
five sections render unconditionally except `## Run log` and the trailing attribution line,
which are gated by the instance-level `prAttribution` toggle (default `true`); a deliberately
silent instance must not print the tool's name or the operator's local filesystem paths into a
PR it opens, so with the toggle off both are omitted rather than blanked. Keep the two
remaining bullets about "What I did not do" and "Tests" — those are unaffected by this change.

`.planning/REQUIREMENTS.md`'s DELV-03 line is left UNCHANGED. Checked, and deciding so
deliberately: `grep` over `.planning/REQUIREMENTS.md`'s git history shows zero prior quick
task (`260907-*`, `260908-*`, `260909-*`) ever edited it, even 260909-lvl, which touched
`pr-body.ts` directly. This project's convention treats phase-requirements text as
milestone-scoped history, not living documentation kept in sync with quick-task fixes — the
operative, currently-true text for a future reader is the doc comment on `renderPrBody`
itself, which this task corrects.

## `assertInstanceLevelToggles`: field-agnostic message, field-agnostic reasoning

Current thrown message ends: *"These two toggles are instance-level: they are enforced at the
Linear client, which is handed an issue id and cannot resolve a mapping without a round trip
per comment."* True for `postLinearComments`/`updateLinearIssue`. Replace with something that
does not claim a specific enforcement point at all, e.g.: `` `${field}` is instance-level:
resolved once from `defaults` rather than per mapping. Move the value to `defaults`, or drop
the override. `` — keeps the mapping name and field name in the message (existing tests assert
on both), drops the now-partially-false claim.

Module header comment (`quiet-linear.ts:14-32`), last paragraph of the "## It reads
`config.defaults` only" section — add two sentences after the existing text explaining that
`assertInstanceLevelToggles` also guards `prAttribution`, for a DIFFERENT reason than the
round-trip cost that justifies the other two (M5): it is per-mapping RESOLVABLE at its actual
read site, and is pinned to instance-level by product decision instead.

## What is explicitly NOT touched, and why (per the brief's own instruction to decide and say)

- **`toDomainOverrides`/`fromDomainOverrides`/`TOGGLE_NAMES` (`config-writer.ts`/`mapping.ts`)**
  — no new case. `updateLinearIssue` already has none, for the identical reason (M9). Add one
  short comment at `toDomainOverrides` naming both fields and the reason, so the omission
  reads as a decision.
- **`PrBodySource` (`src/domain/ports.ts` — NOT `types.ts`; the brief's file pointer is off by
  one file, corrected here)** — unchanged. The toggle is caller-supplied instance state, not
  ticket data; it belongs beside `ciPaths` on `PrBodyInput`, which already exists exactly to
  hold renderer inputs that are not `PrBodySource` fields (its own doc comment says so). Adding
  it to `PrBodySource` would force every `prBodyFor(...)` call in `run-engine.ts` (which builds
  ticket data, not config) to also thread a config value through — the wrong layer.
- **`Deliverer` port (`ports.ts`)** — unchanged. `prAttribution` has no caller-forced-override
  use case the way `draft` does for a `partial` run (M6); it is resolved entirely inside
  `createDeliverer` from config and never appears in the object `run-engine.ts` constructs.
- **`SilenceToggles` (`quiet-linear.ts`)** — unchanged, stays at two fields. It is the
  Linear-client gate's own narrower type; `prAttribution` never reaches `quietLinear`.

## TRAPS T128

Append after T127 (do not touch the pre-existing conflict at lines 109-120, M11). Row shape,
five columns matching the existing table: **A doc comment asserting an invariant is falsified
the moment a legitimate caller needs to violate it, and nothing forces a second look** |
`pr-body.ts`'s doc comment read "All five DELV-03 sections... none of them ever empty" — true
when written, silently false the instant a second, deliberately silent instance needed a PR
body naming neither the tool nor the operator's home directory | `tsc` and the full test suite
passed with the comment already wrong in spirit; nothing catches a doc comment whose claim a
new feature quietly contradicts | Fixed in the same commit that added the third
instance-level toggle (`prAttribution`, alongside `postLinearComments`/`updateLinearIssue`) —
the comment now states the conditional invariant; treat an edited invariant as the same defect
class as the dead-parameter/dead-export rows above it | quick 260910-sm5.

`docs/TRAPS.md`: one short paragraph under `## The one that is really about process`,
alongside the existing stale-comment material there. Bump `docs/TRAPS.md:3` "One hundred and
twenty-seven" -> "One hundred and twenty-eight" and `README.md:201` "127 verified footguns" ->
"128 verified footguns".
</design>

<tasks>

<task type="auto">
  <name>Task 1: A third instance-level toggle, defaulting true, refused per-mapping when it disagrees</name>
  <files>
    src/domain/types.ts, src/infra/config.ts, src/cli/wizard/config-writer.ts,
    src/domain/fakes.ts, src/outbound/quiet-linear.ts, src/domain/contract.test.ts,
    src/orchestration/qa-roundtrip.test.ts, src/infra/config.test.ts,
    src/cli/wizard/config-writer.test.ts, src/outbound/quiet-linear.test.ts
  </files>
  <read_first>
    - `src/domain/types.ts:207-236` — `MappingToggles`, including its own header comment's
      stale "six CONF-02 toggles" enumeration (already missing `updateLinearIssue`; fix the
      count/list while adding the ninth field rather than compounding the staleness).
    - `src/infra/config.ts:23-39` — `TogglesSchema`, and the exact comment above
      `updateLinearIssue: z.boolean().default(true)` (M3) — reuse its reasoning verbatim for
      `prAttribution`.
    - `src/cli/wizard/config-writer.ts:52-111` — `DEFAULT_TOGGLES` and `mergeToggles`, and the
      doc comment above `mergeToggles` (M8) naming the exact rule this task satisfies.
    - `src/cli/wizard/config-writer.ts:124-155` — `toDomainOverrides`/`fromDomainOverrides` —
      confirm `updateLinearIssue` has no case (M9) before deciding `prAttribution` gets none
      either.
    - `src/outbound/quiet-linear.ts:1-33,105-142` — the module header comment and
      `assertInstanceLevelToggles`, including the message text that becomes false (M4).
    - `src/cli/wizard/config-writer.test.ts:384-411` — the exact precedent test to extend
      (260909-nh6's "a law setup re-run preserves ingress, pickupStates and
      updateLinearIssue").
    - `src/infra/config.test.ts:16-26,262-279` — `validDefaults` and the "a config written
      before today loads and resolves to today's behaviour" test, the exact precedent for the
      absent-field regression (M7).
    - `src/outbound/quiet-linear.test.ts:143-184` — `configWith` and the existing
      DISAGREE/AGREES tests, for the new test's shape (do not modify `configWith` itself —
      write the new test's `Config` literal standalone, `as unknown as Config`, per M7's rule
      to touch only what needs touching).
  </read_first>
  <action>
    Add `prAttribution: boolean` to `MappingToggles` (`types.ts`), placed directly after
    `updateLinearIssue`, with a doc comment stating: it gates `pr-body.ts`'s `## Run log`
    section and its trailing attribution line; it is INSTANCE-level for a product reason
    rather than `updateLinearIssue`'s round-trip-cost reason (M5); it is enforced at
    `quiet-linear.ts:assertInstanceLevelToggles`, not at the Linear client. Fix the
    interface's own header comment (currently claims "six CONF-02 toggles" and omits
    `updateLinearIssue` already) to name the actual current set rather than leaving a second
    stale enumeration next to the one this task is here to fix.

    Add `prAttribution: z.boolean().default(true)` to `TogglesSchema` (`config.ts`), directly
    after `updateLinearIssue`, with the same "every config written before this field existed
    must still load, and must load as today's behaviour" comment `updateLinearIssue` carries.

    Add `prAttribution: true,` to BOTH `DEFAULT_TOGGLES` literals — `config-writer.ts:52-60`
    and `fakes.ts:218-227` — directly after `updateLinearIssue: true,`. Add a matching
    `prAttribution: pickBoolean(e.prAttribution, DEFAULT_TOGGLES.prAttribution),` arm to
    `mergeToggles` (`config-writer.ts`), directly after the `updateLinearIssue` arm.

    Do NOT add a case for `prAttribution` to `toDomainOverrides` or `fromDomainOverrides`, and
    do NOT add it to `mapping.ts`'s `TOGGLE_NAMES`/`ToggleName`/`TOGGLE_SPECS`. Add one comment
    at `toDomainOverrides` naming both `updateLinearIssue` and `prAttribution` as the two
    toggles with no wizard-local per-mapping override name, and why (M9) — so the omission
    reads as a decision made twice for the same reason, not a gap.

    In `quiet-linear.ts`, add `'prAttribution'` to `assertInstanceLevelToggles`'s `fields`
    array. Rewrite the thrown error message per the Design section's "field-agnostic message"
    — it must stop claiming enforcement happens "at the Linear client", since that becomes
    false for this field, while still naming the mapping and the field (existing tests assert
    on both substrings; do not break them). Add the two-sentence addition to the module header
    comment's closing paragraph per Design, explaining why `prAttribution` is guarded by the
    same function for a different reason than the other two.

    Fix the three test fixtures that would otherwise fail to compile once `prAttribution` is a
    required field with no bypass cast in scope (M7 — these three, and only these three, were
    individually confirmed to need it): add `prAttribution: true,` to
    `domain/contract.test.ts:67-75`'s `DEFAULTS`, to
    `orchestration/qa-roundtrip.test.ts:52-76`'s `CONFIG.defaults`, and to
    `infra/config.test.ts:16-26`'s `validDefaults` (all three directly after
    `updateLinearIssue: true,`/`updateLinearIssue: true`).

    Extend `infra/config.test.ts`'s "a config written before today loads and resolves to
    today's behaviour" test (`:262-279`): destructure `prAttribution` out of `validDefaults`
    ALONGSIDE the existing `updateLinearIssue` strip (both dropped from the same
    `preTodayDefaults` object, same reasoning comment extended to mention both), and add
    `assert.equal(resolved.prAttribution, true, 'the new toggle defaults to today: the body is
    fully attributed');` next to the existing `updateLinearIssue` assertion. This is the
    schema-level proof of the "absent key, not merely true" regression the brief requires —
    the render-level proof of the same regression is Task 2's.

    Extend `config-writer.test.ts`'s "a law setup re-run preserves ingress, pickupStates and
    updateLinearIssue" test (`:390-411`): before the round trip, add
    `existing.defaults.prAttribution = false;` next to the existing `updateLinearIssue`/
    `postLinearComments` sets; after the round trip, add
    `assert.equal(again.defaults.prAttribution, false, 'mergeToggles names the new toggle');`
    next to the existing assertions.

    Add a new test to `quiet-linear.test.ts`, in the boot-refusal section (after the existing
    "an override that AGREES is inert" test), asserting a per-mapping override of
    `prAttribution` that disagrees with defaults throws, naming the mapping and the field —
    same shape as the existing `postLinearComments`/`updateLinearIssue` DISAGREE test at
    `:161-176`, built as its own standalone `Config` literal (`as unknown as Config`) rather
    than by extending the shared `configWith` helper, since `configWith`'s hardcoded
    `defaults` object does not carry `prAttribution` and every OTHER existing test relies on
    that shape staying exactly as it is.

    **Mandatory falsification #4.** After that new test passes, temporarily remove
    `'prAttribution'` from `assertInstanceLevelToggles`'s `fields` array and re-run
    `quiet-linear.test.ts` alone. The new test must now FAIL (the boot no longer refuses the
    disagreeing override) — capture the exact assertion failure text verbatim for SUMMARY.md.
    Restore the field immediately after and re-run to confirm green again before moving on.
  </action>
  <verify>
    <automated>npm run verify</automated>
    Plus the falsification-4 RED text captured above, and confirmation it returns to green
    after the field is restored.
  </verify>
  <done>
    `MappingToggles`, `TogglesSchema`, both `DEFAULT_TOGGLES` literals, `mergeToggles`, and
    `assertInstanceLevelToggles` all agree on `prAttribution`. A disagreeing per-mapping
    override fails boot naming the mapping and field. A config missing the key resolves the
    toggle to `true` (proven with the key ABSENT, not set true). `npm run verify` green.
    Committed.
  </done>
</task>

<task type="auto">
  <name>Task 2: `renderPrBody` gates the footer and the Run log independently</name>
  <files>src/execution/pr-body.ts, src/execution/deliver.test.ts</files>
  <read_first>
    - `src/execution/pr-body.ts` in full (110 lines) — the doc comment at `:43-50` to correct
      (M2), and the exact two blocks at `:102-107` to gate (M1).
    - `src/execution/deliver.test.ts:255-310` — the "pr-body.ts, pure" test section, its exact
      existing assertions, and `headingsOutsideFences` (`:317-330`), which must keep passing
      unchanged (it asserts on the shape of the DEFAULT, attributed render).
  </read_first>
  <action>
    Add `prAttribution?: boolean` to `PrBodyInput`, directly after `ciPaths`, with a doc
    comment stating: it is `MappingToggles.prAttribution`, instance-level, defaults to `true`
    when omitted so every existing direct caller of `renderPrBody` (including every test in
    this file that predates this change) renders byte-identically; `false` drops `## Run log`
    and the trailing attribution line.

    Inside `renderPrBody`, add `const showAttribution = o.prAttribution ?? true;` immediately
    after `const out: string[] = [];`. Wrap the `## Run log` block (`out.push('## Run log')`
    through its trailing `out.push('')`) in `if (showAttribution) { ... }`. Wrap the
    `---`/footer two lines in a SEPARATE `if (showAttribution) { ... }` — two independent
    blocks, not one shared wrapper, per the Design section's reasoning (each of falsifications
    #1/#2 must be independently reproducible).

    Correct the doc comment above `renderPrBody` per the Design section's "stale comment,
    corrected" — it must no longer claim all five sections are unconditional and never empty;
    state instead that `## Run log` and the footer are the two gated by `prAttribution`
    (default `true`), and name why (a silent instance must not announce the tool or the
    operator's paths).

    In `deliver.test.ts`'s "pr-body.ts, pure" section, add three new tests immediately after
    "agent-authored text cannot break out of the template structure":

    **Mandatory falsification #1.** Write a test calling
    `renderPrBody({ verdict: 'delivered', prAttribution: false })` and asserting
    `body.includes('Opened by linear-auto-worker')` is `false`. Run it BEFORE implementing the
    footer's `if` (i.e., against the still-unconditional footer) and confirm it fails RED —
    capture the exact failure text. Then add the footer's `if` and confirm this test goes
    GREEN.

    **Mandatory falsification #2, independently of #1.** Write a second test calling
    `renderPrBody({ verdict: 'delivered', prAttribution: false, runLogPath:
    '/var/law/run-1.log' })` and asserting BOTH `body.includes('## Run log')` is `false` AND
    `body.includes('/var/law/run-1.log')` is `false`. Run it at the point where ONLY the
    footer's `if` exists (Run log still unconditional) and confirm it fails RED — capture the
    exact failure text, and confirm falsification #1's test is UNAFFECTED (still green) at
    this same point, proving the two do not move together. Then add the Run log's own `if`
    and confirm both tests are green.

    **Regression (byte-identical when absent, not merely true).** Write a third test asserting
    `renderPrBody({ verdict: 'delivered', runLogPath: '/x' })` (no `prAttribution` key at all)
    is `===` to `renderPrBody({ verdict: 'delivered', runLogPath: '/x', prAttribution: true })`
    character for character. This is the render-layer half of the "absent, not merely true"
    regression; Task 1 already covers the schema-parse half.

    Confirm every PRE-EXISTING test in this section — including "the body carries all five
    DELV-03 sections" and `headingsOutsideFences`'s five-heading assertion — is unaffected,
    since none of them pass `prAttribution` and the default is `true`.
  </action>
  <verify>
    <automated>npm run verify</automated>
    Plus the two RED texts from falsifications #1 and #2, captured verbatim for SUMMARY.md.
  </verify>
  <done>
    `renderPrBody` suppresses `## Run log` and the footer independently when `prAttribution`
    is `false`, and renders identically to today when it is `true` or absent. The doc comment
    above the function states the true, now-conditional invariant. Both falsification RED
    texts are captured. `npm run verify` green. Committed.
  </done>
</task>

<task type="auto">
  <name>Task 3: Wire the toggle to its one real call site, prove it with T109, close the ledger</name>
  <files>
    src/execution/deliver.ts, src/cli/adapters.ts, src/execution/deliver.test.ts,
    .planning/TRAPS.md, docs/TRAPS.md, README.md
  </files>
  <read_first>
    - `src/execution/deliver.ts:23-45` — `DeliverInput`, and the doc comment on `prBody`
      naming T120's "required, not optional" rule to follow for `prAttribution` too.
    - `src/execution/deliver.ts:145` — the one `renderPrBody(...)` call.
    - `src/cli/adapters.ts:657-682` — `createDeliverer`, specifically the `draft: pr.draft ??
      toggles.draftPr,` line this task adds a sibling to.
    - `src/execution/deliver.test.ts:64-79` — the `input()` helper every `deliver()`-calling
      test in the file goes through.
    - `.planning/TRAPS.md` — the last row (T127, near the end of the file) and its five-column
      shape. Do NOT open or touch the `<<<<<<< HEAD` region at lines 109/113/120 (M11) — it is
      unrelated and pre-existing.
    - `docs/TRAPS.md:3` and the `## The one that is really about process` section's closing
      material, and `README.md:201`, for the count bumps.
  </read_first>
  <action>
    Add `prAttribution: boolean` to `DeliverInput` (required, no `?`), with a doc comment
    citing T120: an optional field here is a field a caller can forget to set, and this one
    decides whether the PR body leaks the tool's name and the operator's local paths — required
    makes `tsc` the gate, the same fix T120 applied to `prBody`.

    Update the one `renderPrBody(...)` call (`:145`) to
    `renderPrBody({ ...o.prBody, ciPaths: gates.ciPaths, prAttribution: o.prAttribution })`.

    In `adapters.ts`'s `createDeliverer.deliver`, add `prAttribution: toggles.prAttribution,`
    to the object passed to `deliverPullRequest`, next to `draft: pr.draft ?? toggles.draftPr,`
    — with a one-line comment noting there is no caller-forced override for this one (unlike
    `draft`'s `partial`-run case): it is resolved from config every time.

    Update `deliver.test.ts`'s `input()` helper: add `prAttribution: true,` to its returned
    default object, next to `draft: true,`. Every existing test in the file keeps passing
    unchanged (they get `true` by default, matching today's behaviour).

    Add two new tests, in a clearly labelled new section (e.g. a comment banner naming
    260910-sm5), that call `deliver()` — not `renderPrBody` directly — and assert on
    `h.bodyAtCreate()`:
    - `deliver(input(h, { prAttribution: false }))` → the body gh was pointed at contains
      neither `## Run log` nor `Opened by linear-auto-worker`.
    - `deliver(input(h))` (default, `prAttribution` not overridden) → the body contains both.

    **Mandatory falsification #3 (T109).** Temporarily delete
    `prAttribution: o.prAttribution,` from the `renderPrBody(...)` call in `deliver.ts`. Run
    the full `deliver.test.ts` suite and record, explicitly, which tests stayed GREEN and
    which went RED:
    - Expected GREEN, unaffected: every test in the "pr-body.ts, pure" section (Task 2) —
      they call `renderPrBody` directly and never go through `deliver()`.
    - Expected RED: the two new tests just added in this task, which call `deliver()` and
      depend on the deleted forwarding.
    State this pairing explicitly in SUMMARY.md by test-region name, and paste the actual RED
    assertion failure text verbatim. If BOTH regions go red, or NEITHER does, say so plainly in
    SUMMARY.md rather than reporting a pass — that is the exact honesty call this repo's own
    T109 procedure exists to force (see `.planning/TRAPS.md` T109's own note: "a first pass
    that goes neither-red is the normal outcome, not a sign the procedure was done wrong").
    Restore the deleted line and confirm the full suite is green again before proceeding.

    Append TRAPS T128 to `.planning/TRAPS.md`, after T127, using the row text from the Design
    section's "TRAPS T128" subsection, in the same five-column shape as the surrounding rows.
    Do not open, edit, or attempt to resolve the pre-existing merge-conflict markers at lines
    109/113/120 — leave them exactly as found (M11). Add the matching short paragraph to
    `docs/TRAPS.md` under `## The one that is really about process`. Bump the count at
    `docs/TRAPS.md:3` from "One hundred and twenty-seven" to "One hundred and twenty-eight",
    and at `README.md:201` from "127 verified footguns" to "128 verified footguns".

    Run the final gate, `npm run verify`, in full. Per M12, this is expected to rewrite
    `dist/` and is safe: the two live daemons (PIDs 52153, 67498) are NOT restarted, NOT
    reconfigured, and neither instance's real `config.json` (`~/.linear-auto-worker/` or
    `~/.law-lahzo/`) is read or written by this task. Report the exact test count printed,
    not the number assumed from the brief.
  </action>
  <verify>
    <automated>npm run verify</automated>
  </verify>
  <done>
    `config.json` -> `createDeliverer` -> `deliver()` -> `renderPrBody` carries `prAttribution`
    end to end, proven by a real `deliver()` call whose rendered body (read from the file
    `gh pr create --body-file` was pointed at) respects the toggle. The T109 pair is observed
    and its RED text quoted verbatim in SUMMARY.md, named honestly even if it does not come
    out as the clean two-region split expected. TRAPS/docs/README all read 128. `npm run
    verify` green with the live daemons untouched and their configs untouched. Committed.
  </done>
</task>

</tasks>

<success_criteria>
- A PR opened with `prAttribution: false` (once the operator sets it on `~/.law-lahzo/
  config.json`, which is explicitly not this task's job) carries no `## Run log` line and no
  `_Opened by linear-auto-worker_` footer — proven here by direct-renderer tests, not just by
  inspection.
- A config with the key entirely ABSENT — the live `~/.linear-auto-worker/config.json`'s
  actual shape — resolves the toggle to `true` and renders byte-identically to today, proven
  at both the schema layer (Task 1) and the render layer (Task 2).
- A per-mapping override of `prAttribution` that disagrees with `defaults` fails `law start`,
  and removing the field from `assertInstanceLevelToggles`'s guard list is shown, by a
  falsification, to silently stop catching that.
- The T109 deletion procedure was run for the `deliver.ts` wiring, its outcome named by
  test-region and pasted verbatim — including an honest report if the split is not the clean
  green/red pair expected.
- `renderPrBody`'s doc comment states the true, conditional invariant rather than the stale
  unconditional one.
- `npm run verify` green; the exact test count reported, not assumed. Neither live daemon
  (PIDs 52153, 67498) restarted; neither live config read or written.
- The pre-existing, unrelated merge conflict in `.planning/TRAPS.md` (M11) is left untouched
  and reported as a finding, not silently worked around or fixed in passing.
</success_criteria>

<output>
Write `.planning/quick/260910-sm5-pr-body-gate-the-tool-attribution-footer/SUMMARY.md`.

It must state, at minimum: the field name chosen and where it landed in all five layers
(types, schema, both `DEFAULT_TOGGLES`, `mergeToggles`, `assertInstanceLevelToggles`,
`createDeliverer`, `renderPrBody`); the four mandatory falsifications' actual RED text, quoted
verbatim, in numbered order (#1 footer, #2 Run log, #3 T109 deletion at `deliver.ts`, #4
`assertInstanceLevelToggles` field removal); for falsification #3 specifically, which test
region stayed green and which went red, named explicitly and honestly even if the split was
not clean; the exact `npm run verify` count before and after; and the pre-existing
`.planning/TRAPS.md` merge conflict (M11) as a reported finding, not a fix.

Report as a finding, not a fix: the `.planning/TRAPS.md` merge-conflict markers at
lines 109/113/120, present since commit `b43d2e4d` (2026-09-06) and still there at HEAD,
untouched by this task and worth its own quick task.
</output>
</content>
</invoke>
