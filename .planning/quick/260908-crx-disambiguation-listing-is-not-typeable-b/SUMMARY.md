---
task: "The disambiguation listing prints a field that is not a target, so ambiguity is a dead end"
id: 260908-crx
type: quick
severity: P1
completed: 2026-09-08
branch: main
status: complete
commits:
  - "e51a388 fix(resolve-run): every line the ambiguity listing prints is a target"
  - "4691669 fix(say): suggest a watch target the resolver produced, not a second copy of the rule"
  - "527d325 docs: T118 — a disambiguation prompt that prints a non-unique field is a dead end"
gate: "npm run verify — 661/661 + boot smoke PASSED (657/657 before; +4, not +3, see Deviations)"
key-files:
  modified:
    - src/cli/resolve-run.ts
    - src/cli/resolve-run.test.ts
    - src/cli/say.ts
    - src/cli/say.test.ts
    - .planning/TRAPS.md
    - docs/TRAPS.md
    - README.md
---

# Quick task 260908-crx: the ambiguity listing is now typeable

Every line the "which run did you mean?" listing prints is a target that resolves back to
exactly one run — and uniqueness is decided by `matches()` itself, not by a parallel scan.

## What changed

`runTarget(run, all)` in `src/cli/resolve-run.ts` is the single owner of "the shortest thing
an operator can type to reach exactly this run". It grows a candidate token until

```ts
all.filter((candidate) => matches(candidate, token)).length === 1
```

— the issue key first (what the operator recognises), then id prefixes from `MIN_PREFIX`
upward. `listing()` emits that token as the first field on every line, dropping the issue key
from the description when it IS the token; `resolveRunTarget` returns `{ run, target }`, and
`say.ts:80` reads `resolved.target` instead of building `issueKey ?? id.slice(0, 8)` a second
time.

`MIN_PREFIX` is still declared once (`grep -c 'MIN_PREFIX =' src/cli/resolve-run.ts` → `1`).

## The structural-uniqueness change (CHANGE 1) — it worked, unmodified

The reviewer's instruction was to define uniqueness with the matcher rather than with a
hand-written single-field scan. It went in exactly as specified and is four lines:

```ts
const reachesOnlyThisRun = (token: string): boolean =>
  all.filter((candidate) => matches(candidate, token)).length === 1;

if (run.issueKey !== null && reachesOnlyThisRun(run.issueKey)) return run.issueKey;
for (let length = MIN_PREFIX; length <= run.id.length; length++) { … }
```

Both gaps the checker named are closed by construction: an issue key that is also another
run's id prefix now fails `reachesOnlyThisRun` (the prefix clause counts it), and a run whose
id is a strict prefix of another's exhausts the loop and hits the recorded ceiling
(`ponytail:` comment at `resolve-run.ts:64-68`) rather than emitting a colliding token.
`must_haves.truths[3]` is unchanged — it is now literally true instead of half true.

One property worth recording, because it is a deliberate strictness the plan did not
anticipate: `reachesOnlyThisRun` ignores the resolver's active-before-terminal precedence. If
a TERMINAL run shares an active run's key, `matches()` accepts both, so `runTarget` skips the
key and emits an id prefix — even though typing the key would in fact resolve (the active pool
is searched first). The token is always correct, just occasionally less friendly than it could
be. Making it precedence-aware would mean re-deriving the resolver's ordering inside
`runTarget`, i.e. a second copy of the rule — the exact defect this task exists to remove. Left
strict on purpose.

## RED text actually observed

**1. Ambiguous target, at HEAD** (`node --test dist/src/cli/resolve-run.test.js`, test 11):

```
not ok 11 - ambiguous target: every line the listing prints resolves to exactly one run
  error: |-
    the listing printed `COD-9`; feeding it back gave: `COD-9` matches 2 runs — name one:
      COD-9 dzfweb/miracle-shop running
      COD-9 ohmaseclaro/api running
```

The output of resolution is byte-identical to an input to it. That identity is the defect.

**2. No target, fixture A (siblings), at HEAD** (test 12) — same text, via the
`active.length > 1` listing:

```
not ok 12 - no target: every line the listing prints resolves to exactly one run (siblings)
  error: |-
    the listing printed `COD-9`; feeding it back gave: `COD-9` matches 2 runs — name one:
      COD-9 dzfweb/miracle-shop running
      COD-9 ohmaseclaro/api running
```

**3. No target, fixture B (mirror image), at HEAD: `ok 13` — GREEN, as the reviewer
predicted.** Two ACTIVE runs sharing `o/api` with distinct keys `LAW-1`/`LAW-2` already round
trip, because distinct keys are already unique targets. It was NOT "repaired"; it is the
non-regression that proves the id-prefix branch closes the same-repo ambiguity without adding
`repoSlug` as a fourth accepted form. The plan's `<constraints>` and `<success_criteria>` 1
both claimed all three must be RED; both are corrected in PLAN.md as part of this task.

**4. `say.ts:80` before the wiring** (`node --test dist/src/cli/say.test.js`, test 6) — the
second copy of the rule, caught by the same property one line over:

```
not ok 6 - the ambiguity → retype → resolved loop closes through `runSay` itself
  error: |-
    `law say` suggested `law watch COD-9`; that target gave:
    `COD-9` matches 2 runs — name one:
```

## Falsifications

**Prefix below the floor** — `runTarget`'s prefix branch forced to `slice(0, MIN_PREFIX - 1)`:

```
not ok 11 - ambiguous target: every line the listing prints resolves to exactly one run
  error: 'the listing printed `a1b`; feeding it back gave: no run matching `a1b` — try `law status`'
not ok 12 - no target: every line the listing prints resolves to exactly one run (siblings)
  error: 'the listing printed `a1b`; feeding it back gave: no run matching `a1b` — try `law status`'
```

The one `MIN_PREFIX` holds both sides together: shorten the emitter below the floor and the
matcher stops accepting what the listing prints. Restored, 13/13.

**Listing reverted to emitting the issue key first** — the `say` test's RED:

```
not ok 6 - the ambiguity → retype → resolved loop closes through `runSay` itself
  error: |-
    the listing printed `COD-9`; typing it back gave:
    `COD-9` matches 2 runs — name one:
      COD-9 dzfweb/miracle-shop running
      COD-9 ohmaseclaro/api running
```

Restored, 6/6.

## T109 wiring procedure — the discriminating outcome, not neither-red

`print(resolved.error)` deleted from `say.ts:46`, rebuilt, both suites run separately:

| Suite | Result |
|---|---|
| `dist/src/cli/resolve-run.test.js` | `# tests 13 / # pass 13 / # fail 0` — fully GREEN |
| `dist/src/cli/say.test.js` | `# tests 6 / # pass 5 / # fail 1` — RED on the new test |

The RED text, and it is the right RED — no listing was printed at all:

```
not ok 6 - the ambiguity → retype → resolved loop closes through `runSay` itself
  error: |-
    expected two candidates, got:


    0 !== 2
```

Exactly one suite moved, which is the proof the behaviour is on the live path and not merely
in the module. Line restored; both suites back to 13/13 and 6/6. `watch.test.js` 12/12 with
`watch.ts` untouched (it destructures only `.run`).

## Gate

```
npm run verify
# tests 661
# pass 661
# fail 0
SMOKE PASSED — a signed webhook became a persisted queued run, the stop was clean, and the
next boot ran what the stop left behind.
```

657/657 + smoke before. **661, not the planned 660** — see Deviations.

## Non-regressions, unedited

All seven pre-existing `resolve-run.test.ts` cases and all five pre-existing `say.test.ts`
cases pass without a character changed:

- `resolve-run.test.ts:89-90` — `/LAW-1 o\/api running/` and `/LAW-2 o\/web preparing/` still
  match byte-identically. Distinct keys are unique targets, so `runTarget` returns the key and
  the line renders exactly as before, single space and all. (The plan cited `:88-89`; 88 is a
  comment, the assertions are at `:89-90`.)
- `resolve-run.test.ts:124-134` — `/o\/api/` and `/o\/web/` still match; the slug is still
  PRINTED, it is simply no longer the thing the operator is expected to type.
- `say.test.ts:112` — `` /^queued to LAW-9 o\/r — `law watch LAW-9` to see it land$/ ``
  unchanged and passing: one run, unique key, branch 1 returns `LAW-9`.
- No-target one / zero / many; active pool searched before terminal (`:111-122`); a finished
  run resolves when nothing live shares its key (`:144-149`); "never picks the newest" and the
  `questions.ts:88-91` reference preserved verbatim in the `resolveRunTarget` doc comment.
- `say.ts:51-53`'s finished-run refusal did not move, and `label()` at `:26-28` is untouched —
  it is a display label, not a target.

**`src/cli/index.ts` is untouched, deliberately.** `matches()` is unmodified, so the accepted
target forms did not change: `watch [target]` still documents "an issue key (LAW-123) or the
first 4+ characters of a run id", and both are still exactly what the matcher accepts. What
changed is only what the listing PRINTS — it now prints one of the forms the help text already
promised. `repoSlug` was NOT added as a target; it stays printed so the operator still reads
what he recognises.

## Deviations from plan

**1. [CHANGE 1, reviewer-directed] Uniqueness decided by `matches()` rather than by a
single-field scan.** Applied as instructed; the plan's `<design>` branch descriptions are
corrected in PLAN.md. Consequence recorded above: the test is stricter than the resolver's
precedence, on purpose.

**2. [CHANGE 2, reviewer-directed] Fixture B is a non-regression, not a falsification.**
Observed GREEN at HEAD as predicted. `<constraints>` and `<success_criteria>` 1 corrected in
PLAN.md; the fixture was not touched.

**3. [Rule 1 — plan arithmetic] 661 tests, not 660.** The plan asked for the no-target round
trip to run "against two fixtures" inside one test. Written as two separately named tests
instead (`…(siblings)` and `…two runs sharing a REPO across two tickets`) so that each fixture
reports its own pass/fail — which is what made the fixture-B finding legible as `ok 13` rather
than hidden inside a composite green. Three fixtures, four new tests, +4.

**4. [Rule 3] The single-active-run success path now costs a second query.** The plan asked
for the terminal fetch to be a memoised thunk "so the common case (one active run) still runs
one query". That is not achievable now that the success shape carries `target`: `runTarget`
cannot decide uniqueness without the universe `matches()` searches, so the no-target
single-run path fetches terminal too. The memoisation still earns its keep on the target path
(one fetch instead of two). Two synchronous `better-sqlite3` reads in a one-shot CLI process
is not a cost worth a lazy getter over a database the caller closes in a `finally`.

**5. [Cosmetic] `docs/TRAPS.md:3` rewrapped.** "One hundred and eighteen" is longer than "One
hundred and nine"; the line was rewrapped to stay under 100 characters like its neighbours.

## Known stubs

None.

## Self-Check: PASSED

- `src/cli/resolve-run.ts`, `src/cli/resolve-run.test.ts`, `src/cli/say.ts`,
  `src/cli/say.test.ts`, `.planning/TRAPS.md`, `docs/TRAPS.md`, `README.md` — all present.
- `e51a388`, `4691669`, `527d325` — all present in `git log`.
- `grep -c '^| T118 ' .planning/TRAPS.md` → `1`
- `grep -c '260908-crx' .planning/TRAPS.md` → `1`
- `grep -c '118 verified footguns' README.md` → `1`
- `grep -c '109' docs/TRAPS.md` → `0`
- `grep -c 'resolved.target' src/cli/say.ts` → `2` (comment + call site; `0` at HEAD)
- `grep -c 'MIN_PREFIX =' src/cli/resolve-run.ts` → `1`
