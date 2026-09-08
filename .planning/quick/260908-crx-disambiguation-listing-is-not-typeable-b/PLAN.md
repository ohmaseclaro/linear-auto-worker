---
task: "The disambiguation listing prints a field that is not a target, so ambiguity is a dead end"
id: 260908-crx
type: quick
severity: P1
created: 2026-09-08
branch: main
files_modified:
  - src/cli/resolve-run.ts
  - src/cli/resolve-run.test.ts
  - src/cli/say.ts
  - src/cli/say.test.ts
  - .planning/TRAPS.md
  - docs/TRAPS.md
  - README.md
gate: npm run verify   # 657/657 + boot smoke green before; 660/660 + smoke after
must_haves:
  truths:
    - "Every line the disambiguation listing prints is itself a target that `resolveRunTarget` resolves to exactly ONE run, and different lines resolve to different runs."
    - "That property is asserted as a ROUND TRIP over `resolveRunTarget`, for the no-target listing and the ambiguous-target listing alike — never as a format assertion."
    - "The property holds for two ACTIVE runs sharing an issue key across two repos (the multi-repo shape the product advertises) and for two ACTIVE runs sharing a repo across two tickets (the mirror image)."
    - "The token the listing prints and the token the matcher accepts agree BY CONSTRUCTION: one `MIN_PREFIX`, one function, and the printed token satisfies a clause of `matches` by the way it is built."
    - "`law say` suggests a `law watch` argument that resolves to exactly one run, using the same rule rather than a second copy of it."
    - "The four named non-regressions still hold: no-target one/zero/many; active searched before terminal; never picks the newest; the finished-run refusal still lives in `say.ts`."
  artifacts:
    - "src/cli/resolve-run.ts — `runTarget()`, the single owner of \"the shortest thing an operator can type to reach exactly this run\", consumed by `listing()` and returned on the success result."
    - "src/cli/resolve-run.test.ts — the round-trip property, over a two-repo sibling fixture, observed RED at HEAD."
    - "src/cli/say.test.ts — the same property driven through `runSay`, so the behaviour is reachable from the command and not merely from the module (T109)."
    - ".planning/TRAPS.md row T118; docs/TRAPS.md prose; README count."
  key_links:
    - "`listing()` → `runTarget()` → `matches()` — the printed token must satisfy a clause of `matches` because of how it is constructed, not because two constants happen to agree."
    - "`say.ts:80` → `resolved.target` — the suggested `law watch` argument comes from the resolver, not from a second `issueKey ?? id.slice(0, 8)`."
---

<objective>
`resolveRunTarget` refuses to guess between candidates and prints them instead. Good. But
`listing()` (`resolve-run.ts:27-32`) renders each candidate as
`` `${issueKey ?? id.slice(0,8)} ${repoSlug ?? '-'} ${state ?? '?'}` `` while `matches()`
(`:38-42`) accepts only an exact `run.id`, a case-insensitive `run.issueKey`, or a `run.id`
prefix of `MIN_PREFIX` (4) or more characters. **`repoSlug` is not a target.**

A Linear ticket may map to several repos — `repos: z.array(RepoMappingSchema).min(1)` in
`src/infra/config.ts:50`, and `status.ts:43-48` already documents the consequence: one issue
mapped to three repos is three rows sharing an issue key. Those sibling runs make the
listing print the same leading token on every line:

```
`COD-9` matches 2 runs — name one:
  COD-9 dzfweb/miracle-shop running
  COD-9 ohmaseclaro/api running
```

Retyping `COD-9` reproduces the identical error. The only other accepted form is the run id,
which the listing never prints and `law status` never prints either (`status.ts:62-70`: state
· label · age · tail, where the label is `issueKey ?? id.slice(0,8)` and the id only appears
when the key is null). Dead end, in precisely the case disambiguation exists for. The doc
comment at `:27` calls the output "typeable straight back in"; it is not.

Latent today — all four of the operator's mappings hold one repo — and it lights up on the
first multi-repo project.

**Do not patch the string.** Encode the property that generalises:

> Every line the disambiguation listing prints must itself be a valid target that resolves
> to exactly one run.

That is the test, as a round trip through `resolveRunTarget`. It would have caught this
without anyone reasoning about sibling runs, and it catches the next variant too.
</objective>

<measured_facts>
Read from the source at HEAD. Nothing recalled.

**M1 — the matcher's three accepted forms**, `resolve-run.ts:38-42`: exact `run.id`;
`run.issueKey` compared case-insensitively; `run.id.startsWith(target)` gated on
`target.length >= MIN_PREFIX`. `MIN_PREFIX = 4` at `:19`, declared once.

**M2 — the listing's fields**, `resolve-run.ts:28-31`: `issueKey ?? id.slice(0, 8)`, then
`repoSlug ?? '-'`, then `state ?? '?'`. Two of the three are not targets, and the first
degenerates to a shared value across sibling runs.

**M3 — the two call sites of `listing()`**: `:60` (no target, `active.length > 1`) and `:68`
(a target matched more than one run in a pool). Both are dead ends under sibling runs; both
must satisfy the invariant.

**M4 — a sibling fixture already exists and does not test the property.**
`resolve-run.test.ts:124-134` builds exactly the two-repo shape (`aaaa1111`/`o/api` and
`bbbb2222`/`o/web`, both `LAW-7`, both active) and asserts only that both slugs appear in the
error. It never feeds a printed line back in. The fixture was there; the property was not.

**M5 — `law status` cannot supply the missing id.** `status.ts:50-56` builds its label from
`issueKey ?? id.slice(0,8)`, so a run WITH an issue key never shows an id anywhere in
`law status` output.

**M6 — `say.ts:80` prints a suggested command built from a second copy of the rule**:
`` `law watch ${run.issueKey ?? run.id.slice(0, 8)}` ``. Under sibling runs that suggestion
is itself ambiguous. Same defect, one line over, and T72/T73/T92/T96/T99/T101 are all "two
implementations of one rule" — `resolve-run.ts`'s own header exists because of that.

**M7 — the refusal message the task names is NOT in `resolve-run.ts`.** Confirmed:
`run ${label(run)} already finished (${state}) — nothing to say to` is `say.ts:51-53`, built
from `say.ts:26-28`'s local `label()`. It is a display label for an already-resolved run, not
a target, and it does not move.

**M8 — nothing outside `resolve-run.test.ts` asserts on the listing text.**
`grep -rn 'name one\|matches 2 runs\|active runs' src/ test/` returns only `resolve-run.ts`
itself, `status.test.ts:78` (an unrelated test name) and `fanout.test.ts:530` (an unrelated
message). The two format assertions that DO exist are
`resolve-run.test.ts:88-89` (`/LAW-1 o\/api running/`, `/LAW-2 o\/web preparing/`), and the
format below keeps both passing untouched.
</measured_facts>

<design>
## One function, and the agreement is structural

Add to `resolve-run.ts`:

```
runTarget(run, all) -> string      // the shortest thing an operator can type to reach
                                   // exactly this run, given every run in the store
```

**CORRECTED DURING EXECUTION.** As first drafted, both branches decided uniqueness with a
hand-written scan over ONE field, while `matches()` has three clauses — leaving two reachable
gaps (a branch-1 issue key that is also another run's id prefix, and a run whose id is a strict
prefix of another's). Uniqueness is therefore decided by **`matches()` itself**: a candidate
token is accepted only when `all.filter((r) => matches(r, token)).length === 1`.

Two branches, and each one is literally a clause of `matches()`, with that one uniqueness test
applied to both:

1. **The issue key**, when `run.issueKey` is non-null and `matches()` accepts exactly one run
   for it. Friendly, and accepted by the issue-key clause by construction.
2. **Otherwise an id prefix** `run.id.slice(0, L)`, growing `L` from `MIN_PREFIX` until
   `matches()` accepts exactly one run. Accepted by the prefix clause because `L >= MIN_PREFIX`
   and the value is a prefix of `run.id` — both conditions hold by the way the string is built,
   not because two constants agree.

`MIN_PREFIX` stays declared exactly once and is read by both `runTarget` and `matches`. That
is constraint 1 discharged: there is one floor, one function that emits, and the emitted
value satisfies the matcher's clause by construction. The round-trip test is the guard that
a later edit cannot break the agreement silently.

**Ceiling, recorded not engineered:** no `L` exists when one run's id is a strict PREFIX of
another's. Real ids are `crypto.randomUUID()` — 36 chars, fixed length, never a prefix of
another — so this is reachable only from a hand-written fixture. Fall back to the full
`run.id` and mark it with a `ponytail:` comment naming the condition. Do NOT add an
exact-id-wins short circuit to `resolveRunTarget` for it; that is a real ambiguity nobody
has, and the new fixtures use full-length UUIDs so they do not manufacture one.

## The listing

```
`  ${runTarget(run, all)} ${rest}`   // rest = issueKey, repoSlug ?? '-', state ?? '?',
                                     //        dropping issueKey when it IS the token
```

Single space after the token, deliberately: it keeps `resolve-run.test.ts:88-89` passing
verbatim. Distinct keys render `  LAW-1 o/api running` exactly as today. Siblings render
`  a1b2c3d4 COD-9 dzfweb/miracle-shop running` — the key stays visible because the no-target
header (`2 active runs — name one:`) does not name it.

Update the `:27` doc comment to say what is now true and why it is true.

## The universe

`runTarget` needs every run the matcher could search — `matches` is applied to the active
pool and then the terminal pool, so a token unique among the two listed candidates could
still collide with a third run elsewhere. Compute over active ∪ terminal.

The target path at `:64` already fetches both pools eagerly, so it costs nothing there. The
no-target path fetches only `active` today; make the terminal fetch a memoised thunk so the
common case (one active run) still runs one query.

## `resolved.target`

Widen the success shape to `{ run: RunRow; target: string }`. The resolver has already built
the universe; handing the token back is free and it converts `say.ts:80` (M6) from a second
copy of the naming rule into a consumer of the one rule. `watch.ts:183` destructures only
`.run` and is unaffected. `'run' in result` narrowing is unchanged everywhere.

## Deliberately NOT doing

- **Not accepting `repoSlug` as a target.** It is a second matcher branch that does not close
  the invariant on its own — two active runs in one repo for different tickets is the
  mirror-image ambiguity, and two attempts on the same issue in the same repo collide on
  BOTH fields. The id-prefix branch already makes every line typeable in every shape.
  Constraint 2 is therefore moot by not being triggered, and the round-trip test covers the
  same-repo shape anyway (Task 1, fixture B) to prove it.
- **Not touching `USAGE` in `src/cli/index.ts`.** The accepted target forms do not change:
  `watch [target]` already documents "an issue key (LAW-123) or the first 4+ characters of a
  run id", and both remain exactly what `matches()` accepts. What changes is that the listing
  now PRINTS one of those forms, which is the discovery path the help text already promised.
  `usage: law say <target> <text…>` is likewise unchanged.
- **Not adding run ids to `law status`.** Its lines are already at a 58-char label cap
  (`status.ts:50-56`) and the dead end is closed at the listing, which is where the operator
  meets it.
- **Not touching `say.ts:51-53`** (M7). That message is a display label for a run already
  resolved, and it stays exactly where it is.
</design>

<constraints>
- Stay on `main`. Three commits, one per task.
- `npm run verify` is 657/657 plus a boot smoke and must stay green. Expect 660/660 after the
  three tests below; report the exact number the runner prints.
- **Never `mock.method`** (T88).
- Tests colocated in `src/` as `*.test.ts`.
- **Falsify every new check** (T71/T76) and paste the RED text actually seen.
- The round-trip tests over the SIBLING shape (fixture A) and the ambiguous-target path MUST go
  RED against today's unmodified `resolve-run.ts`. If either passes before the fix, the fixture
  is not reproducing sibling runs — repair the fixture, never weaken the assertion.
- **Fixture B is expected GREEN at HEAD, and must not be "repaired".** Two ACTIVE runs sharing
  `o/api` with DISTINCT keys `LAW-1`/`LAW-2` already round-trip by construction — distinct keys
  are already unique targets. B is a NON-REGRESSION proving the id-prefix branch closes the
  same-repo ambiguity without a `repoSlug` matcher branch; it is not a falsification.
</constraints>

<tasks>

<task type="tracer" tdd="true">
  <name>Task 1: The round-trip property, RED at HEAD, then `runTarget` to make it green</name>
  <read_first>
    - `src/cli/resolve-run.ts` in full (73 lines) — `ACTIVE` `:16`, `MIN_PREFIX` `:19`,
      `ResolveResult` `:21`, `listing` `:27-32`, `matches` `:38-42`, `resolveRunTarget`
      `:53-73` and its `:44-51` doc comment.
    - `src/cli/resolve-run.test.ts` — `row()` `:21-45` and `storeWith()` `:47-52` (the fixture
      helpers to reuse), the format assertions at `:88-89`, and the existing sibling fixture
      at `:124-134` (M4) which this task turns into a real property.
    - `src/infra/store/sqlite-store.ts:104` — `listByState(...states: string[])`.
    - `src/domain/types.ts:37` — `TERMINAL`.
  </read_first>
  <behavior>
    Write these as tests FIRST and watch them fail against unmodified `resolve-run.ts`.

    - **Round trip, ambiguous target.** Two ACTIVE runs, same `issueKey` `'COD-9'`, different
      `repoSlug` (`'dzfweb/miracle-shop'` and `'ohmaseclaro/api'`), full-length UUID ids.
      `resolveRunTarget(store, 'COD-9')` returns an error; split it on newlines, drop the
      header, and for EACH remaining line take the first whitespace-delimited token and
      resolve it again. Every token must return a run, and the two tokens must return two
      DIFFERENT run ids.
    - **Round trip, no target.** The same property over the `active.length > 1` listing, run
      against two fixtures: (A) the sibling shape above; (B) the mirror image — two ACTIVE
      runs sharing `repoSlug` `'o/api'` with different keys `'LAW-1'` and `'LAW-2'`. Both must
      satisfy the property, which is what proves the fix covers the same-repo ambiguity
      without a `repoSlug` matcher branch.
    - The assertion message on a failing token must quote the token AND the error it produced,
      so the RED text names the dead end rather than saying `false !== true`.
  </behavior>
  <action>
    Add the two tests to `src/cli/resolve-run.test.ts` using the existing `row()`/`storeWith()`
    helpers. Factor the round trip into one local helper both tests call — it is the same
    property applied to two listings, and writing it twice is the defect this task is about.
    Give the helper a comment stating the invariant in one sentence.

    RUN THEM AT HEAD FIRST and paste the failure. Expected RED, from the ambiguous-target
    test: the helper's message quoting the token it was handed and the error that token
    produced — the token being `COD-9`, and the error being the same
    `` `COD-9` matches 2 runs — name one: `` the listing had just printed. That identity is
    the defect: the output of resolution is not an input to it.

    Then implement:

    - Add `runTarget(run, all)` beside `matches`, per `<design>`. Its doc comment states the
      construction argument explicitly: branch one returns a value the issue-key clause
      accepts, branch two returns a value the prefix clause accepts because it is a prefix of
      `run.id` of length at least `MIN_PREFIX`. Add the `ponytail:` line naming the
      strict-prefix ceiling and why `crypto.randomUUID()` cannot reach it.
    - Rewrite `listing()` to take the candidates AND the universe, and to emit
      `runTarget(...)` as the first token, then the remaining descriptive fields with the
      issue key dropped when it is already the token. Replace the `:27` doc comment: the
      first token on every line is a target, and the reason it is one.
    - In `resolveRunTarget`, memoise the terminal pool in a thunk, build the universe as
      active ∪ terminal, pass it to both `listing()` call sites, and widen the success shape
      to carry `target: runTarget(run, universe)`. Extend the `:44-51` doc comment with the
      new invariant — **keep the existing `questions.ts:88-91` reference and the "never picks
      the newest" sentence verbatim**; they are load-bearing and are not what changed.
  </action>
  <verify>
    <automated>npm run verify</automated>
    Plus, all pasted into the SUMMARY:
    - The HEAD failure described above, verbatim, for BOTH new tests.
    - Falsification after the fix: change `runTarget`'s prefix branch to slice at
      `MIN_PREFIX - 1`, rebuild, run `node --test dist/src/cli/resolve-run.test.js`, paste the
      RED text, restore. A 3-character prefix is below the floor, so the token stops resolving
      and the round trip breaks — which also demonstrates that the listing and the matcher are
      held together by the one constant.
    - `grep -c 'MIN_PREFIX =' src/cli/resolve-run.ts` returns `1`.
    - The seven pre-existing tests in that file still pass unmodified — in particular
      `:80-92` (`/LAW-1 o\/api running/`), `:111-122` (a live run beats a finished one) and
      `:144-149` (a finished run resolves when nothing live shares its key).
  </verify>
  <done>
    `resolve-run.test.ts` holds a round-trip property over both listings and three fixtures
    (siblings sharing a key, runs sharing a repo, and the ambiguous-target path), all observed
    RED at HEAD with the token-quoting message, all green after. `runTarget` is the one owner
    of the rule, `MIN_PREFIX` is declared once and read by both sides, and every previously
    passing test in the file still passes without edits.
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Reach it from `law say`, and prove the wiring by deleting the call site (T109)</name>
  <read_first>
    - `src/cli/say.ts` — `label()` `:26-28`, the resolve/print block `:44-48`, the terminal
      refusal `:51-54` (M7 — confirm for yourself it lives here, then leave it alone), and the
      queued line `:80`.
    - `src/cli/say.test.ts` — `workspace(state)` `:29-56` (single-run fixture, `RUN_ID`
      `aaaa1111-2222`), the daemon-not-running case `:80-87`, and the queued-line assertion at
      `:112` which pins `` /^queued to LAW-9 o\/r — `law watch LAW-9` to see it land$/ ``.
    - `src/cli/watch.ts:177-183` — the other consumer, to confirm it destructures only `.run`.
  </read_first>
  <behavior>
    - With two ACTIVE sibling runs in the store, `runSay({ target: 'COD-9', … })` exits 1 and
      prints the listing.
    - Feeding the FIRST token of each printed line back in as `target` reaches exactly one run:
      the output no longer contains a listing, and instead reports the socket failure
      (`/daemon is not running/`) — the message that proves resolution succeeded and execution
      moved on.
    - The two tokens reach two different runs.
    - With a single run in the store, `say.ts:80` still emits the issue key, so the existing
      assertion at `:112` passes byte-identically.
  </behavior>
  <action>
    In `src/cli/say.ts`, replace the hand-built `run.issueKey ?? run.id.slice(0, 8)` inside the
    queued line at `:80` with the resolver's `target`. `label()` at `:26-28` stays as it is —
    it is a display label, not a target, and it is what `:52` and `:63` read.

    In `src/cli/say.test.ts`, add a sibling workspace helper beside `workspace()` that inserts
    TWO active runs sharing `issueKey` `'COD-9'` with different `repoSlug` and full-length UUID
    ids. Do not widen `workspace()` itself; every existing case depends on its single-row shape.

    Add ONE test driving the operator's actual loop through `runSay`: ambiguous target, capture
    the printed lines, take each listed line's first token, call `runSay` again with it, and
    assert each second call reached exactly one run and that the two calls reached different
    runs. Its comment says why it exists rather than living only in `resolve-run.test.ts`: a
    property proven inside the module is not proven on the path the operator walks.

    **Then run the T109 wiring procedure and paste both halves.** Delete the `print(resolved.error)`
    line in `say.ts:46`, rebuild, and run the two suites separately:
    `node --test dist/src/cli/resolve-run.test.js` must stay fully GREEN, and
    `node --test dist/src/cli/say.test.js` must go RED on the new test with no listing printed.
    That difference is the proof the behaviour is on the live path. Restore the line and re-run
    both green. If BOTH go red, the new test is targeting the module and must be rewritten to
    go through `runSay`; if NEITHER does, it is targeting nothing — and T109 records that a
    first pass coming back neither-red is the normal outcome, not a sign the procedure was done
    wrong. Report whichever you actually got.
  </action>
  <verify>
    <automated>npm run verify</automated>
    - The T109 result above, both halves, with the suite counts the runner printed.
    - Falsification of the new test itself: revert `listing()` to emit the issue key as the
      first token, rebuild, paste the RED text from `say.test.js`, restore.
    - `grep -c 'resolved.target' src/cli/say.ts` returns at least `1` (it is `0` at HEAD, so
      this gate is not vacuous).
    - `node --test dist/src/cli/watch.test.js` — all 12 cases green, `watch.ts` untouched.
  </verify>
  <done>
    `law say` suggests a `law watch` argument that comes from the resolver, and a test drives
    the ambiguity → listing → retype → resolved loop through `runSay` itself. The T109
    procedure was run and its actual outcome reported. `say.test.ts:112`'s queued-line
    assertion is unchanged and passing, and the terminal-refusal message is still at
    `say.ts:51-53`.
  </done>
</task>

<task type="auto">
  <name>Task 3: File T118 and correct the counts</name>
  <read_first>
    - `.planning/TRAPS.md:124-127` — the "Discovered at open-source release" heading and its
      five-column header, and `:157` (T117) as the current last row.
    - `docs/TRAPS.md:1-20` — the header, which still says "One hundred and nine" and "all 109
      rows"; and `:409` `## Shipping a CLI`, whose existing lesson is "test a CLI by invoking
      it the way the operator will".
    - `README.md:199-206` — the traps-ledger section and its count.
  </read_first>
  <action>
    **`.planning/TRAPS.md`** — append ONE row after T117, five columns, matching T109's density
    (a measured claim per cell, no advice that was not paid for). Phase column: `quick 260908-crx`.

    - **Trap:** a disambiguation prompt that prints a field which is not a target is a dead
      end. `listing()` rendered `issueKey repoSlug state` while `matches()` accepted only an
      id, an issue key, or a 4+ char id prefix; sibling runs of one ticket across two repos
      share the key, so every printed line led with the same token and retyping it reproduced
      the identical error. `law status` never prints a run id for a run that has a key
      (`status.ts:50-56`), so the one accepted form the listing omitted was unobtainable.
    - **Failure mode:** the doc comment claimed the output was typeable straight back in, and
      it was false in exactly the case disambiguation exists for. Latent on this machine
      because all four mappings hold one repo; it lights up on the first multi-repo project —
      a shape the product advertises and `config.ts:50` allows.
    - **Why it hid:** the sibling fixture ALREADY existed (`resolve-run.test.ts:124-134`,
      two repos, one key, both active) and asserted only that both slugs appeared in the
      error. The construction was there; the property was not. A format assertion cannot see
      this defect — only feeding the output back in as input can.
    - **Correct move:** assert the round trip, not the format — every line the listing prints
      resolves to exactly one run, and different lines to different runs. Hold the listing and
      the matcher together by construction: one `MIN_PREFIX`, one `runTarget()`, and a printed
      token that satisfies a clause of `matches` by the way it is built. Name the RED text
      seen at HEAD, and note the second copy of the rule found one line away at `say.ts:80`.

    **`docs/TRAPS.md`** — no new section. Add the lesson as prose under `## Shipping a CLI`
    (`:409`), where the existing lesson is already about testing a CLI the way the operator
    uses it — this is that argument applied to an error message: an error that names your
    options is only useful if the options are typeable, and the test for it is a round trip,
    not a string match. Include the fixture half: it survived because every fixture gave a
    mapping one repo, so the multi-repo case the product advertises was never constructed.

    Also correct that file's own stale counts while it is open: `:3` and `:18` still describe
    the ledger as 109 rows. Both become 118 — `:3` spelled out in words to match its sentence,
    `:18` as the numeral.

    **`README.md:201`** — the count moves from 117 to 118. Leave the sample list alone.
  </action>
  <verify>
    <automated>npm run verify</automated>
    - `grep -c '^| T118 ' .planning/TRAPS.md` returns `1`.
    - `grep -c '260908-crx' .planning/TRAPS.md` returns `1`.
    - `grep -c '118 verified footguns' README.md` returns `1`.
    - `grep -c '109' docs/TRAPS.md` returns `0`.
  </verify>
  <done>
    T118 is in the ledger in five-column form with the phase tag; the lesson appears as prose
    under `## Shipping a CLI` in `docs/TRAPS.md` with both halves (the non-typeable field and
    the one-repo fixture monoculture); that file's header no longer claims 109 rows; the
    README count is 118.
  </done>
</task>

</tasks>

<commits>
- `fix(resolve-run): every line the ambiguity listing prints is a target`
- `fix(say): suggest a watch target the resolver produced, not a second copy of the rule`
- `docs: T118 — a disambiguation prompt that prints a non-unique field is a dead end`
</commits>

<success_criteria>
1. The round-trip property is asserted over BOTH listings and three fixtures. The two that CAN
   fail — the sibling shape (fixture A) and the ambiguous-target path — were **observed RED
   against unmodified `resolve-run.ts`** with the failure text pasted; fixture B is green at HEAD
   by construction (see `<constraints>`). A test that only asserts the new format does not
   satisfy this.
2. The two-repo sibling fixture exists — two ACTIVE runs, one `issueKey`, two `repoSlug`s —
   and the operator reaches exactly one of them using only a token the tool printed.
3. `npm run verify` green: 660/660 (or the exact number the runner prints, stated) plus the
   boot smoke.
4. The T109 wiring procedure was run against `say.ts:46` and its ACTUAL outcome reported —
   including if it came back neither-red, which is a finding, not a failure.
5. `MIN_PREFIX` is still declared once, and the printed token satisfies a clause of `matches`
   by construction. Falsified by shortening the slice below the floor and watching the round
   trip break.
6. The four named non-regressions hold and their existing tests are unedited: no-target
   one/zero/many; active before terminal; never the newest, with the `questions.ts:88-91`
   reference intact; and `already finished (…) — nothing to say to` still in `say.ts`.
7. `src/cli/index.ts` is untouched, and the SUMMARY states why: the accepted target forms did
   not change, only what the listing prints.
</success_criteria>

<open_risks>
- **The invariant is guarded across the whole store, not just the listed candidates.**
  `runTarget` computes over active ∪ terminal because `matches` searches both pools. If a
  later change adds a third pool or a fourth accepted form, the universe must grow with it —
  the round-trip test will go red, which is the point, but the fix is to widen the universe,
  not to narrow the test.
- **`runTarget`'s issue-key branch assumes keys and UUID prefixes cannot collide.** Keys are
  uppercase-prefixed (`COD-9`), ids are lowercase hex and dashes, and the prefix clause is
  case-sensitive. Recorded rather than defended in code; the round-trip test is what would
  catch it if a workspace ever produced a lowercase-hex issue key.
- **This closes the dead end; it does not make `law status` self-sufficient.** An operator
  who wants a run id without provoking an ambiguity still has none. That is a separate change
  with its own line-budget argument, deliberately not made here.
</open_risks>
</content>
</invoke>
