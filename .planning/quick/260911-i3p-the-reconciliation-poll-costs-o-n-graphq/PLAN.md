---
task: "P0 — the reconciliation poll costs O(N) GraphQL requests per tick and exceeds Linear's 2500/hour rate limit by construction"
id: 260911-i3p
type: quick
severity: P0
created: 2026-09-11
branch: main
files_modified:
  - src/domain/ports.ts
  - src/outbound/linear-client.ts
  - src/outbound/linear-client.test.ts
  - src/outbound/quiet-linear.ts
  - src/domain/fakes.ts
  - src/orchestration/recovery.ts
  - src/orchestration/recovery.test.ts
  - src/ingress/poll.ts
  - src/ingress/poll.test.ts
  - .planning/TRAPS.md
  - docs/TRAPS.md
  - README.md
gate: npm run verify   # 771/771 + both smokes green before; report the exact number after (poll.test.ts's 7 tests are deleted, ~4 are added)
must_haves:
  truths:
    - "A reconcile() tick's outbound-request cost for issue hydration does not scale with the number of open assigned issues — proven by a test that counts requests, not by a test that only checks which issues came back (the class of test that already passed against the broken code)."
    - "The watermark reaches Linear as a server-side `updatedAt: { gt: ... }` predicate on every poll — proven by inspecting the actual filter/argument sent, not by inferring it from the downstream result, because the surviving client-side `continue` can make an unsent predicate look sent."
    - "The watermark advances to the same value, and enqueues the same issues, whether the query is server-filtered or not — proven at a boundary case (an issue exactly at the watermark), not merely asserted from the code shape."
    - "Deleting the watermark argument at the one production call site is shown, by name, which test suite it turns red and which it leaves green — and that the green ones staying green is itself the evidence for why the argument-inspecting test in truth #2 had to exist."
    - "Exactly one implementation of 'poll for missed work' exists in the repository; `src/ingress/poll.ts`'s dead, never-called twin (TRAPS T122's deferred decision) is gone, not left beside the live one a second time."
    - "`npm run verify` is green at the end, with the count reported exactly, not assumed; neither live daemon process is restarted, and no standalone `npm run build` is run outside `verify`'s own internal one."
  artifacts:
    - "src/domain/ports.ts — `listAssignedOpenIssues(botUserId, since?)` returning `Pick<LinearIssue, 'id' | 'updatedAt'>[]`."
    - "src/outbound/linear-client.ts — the SDK filter carries `updatedAt: { gt: new Date(since) }` when `since` is given; no relation hydration (`toLinearIssue`) in this method at all."
    - "src/outbound/quiet-linear.ts — the passthrough forwards `since` unchanged; this method stays UNGATED (a silent instance still has to find work)."
    - "src/domain/fakes.ts — `FakeLinearClient.listAssignedOpenIssues` narrowed and `since`-aware, so the fake cannot silently be more permissive than the real client."
    - "src/orchestration/recovery.ts — `reconcile()`'s one call site passes the watermark; the client-side `continue` line is unchanged and documented as defense-in-depth, not the primary filter."
    - "src/outbound/linear-client.test.ts — a request-count regression test and a filter-sent test."
    - "src/orchestration/recovery.test.ts — a since-received wiring test and a watermark-equivalence test."
    - "src/ingress/poll.ts and its test deleted."
    - ".planning/TRAPS.md T129 (appended after T128, lines 109-120 untouched); docs/TRAPS.md count and prose; README.md count."
  key_links:
    - "recovery.ts's reconcile() -> LinearClient.listAssignedOpenIssues(botUserId, watermark) -> linear-client.ts's SDK filter -- the one hop where the O(N) cost was created and is now closed."
    - "recovery.test.ts's local `linear` fake -> a recorded `since` argument -- the only artifact in this task that can tell 'the predicate was sent' apart from 'the output happens to look filtered'."
    - "quiet-linear.ts's passthrough -> must carry `since` through unchanged, because this read method is deliberately the one thing silence does not gate."
---

<objective>
Two independent, additive fixes to `reconcile()`'s one Linear read, `listAssignedOpenIssues`, which
today pages issues cheaply (1 request per page) and then hydrates every issue's `assignee`,
`project`, `team`, `state` relations regardless of whether anything reads them — measured at 3.9
requests per issue, ~48 requests for a quiet 12-issue poll, ~2870/hour against Linear's 2500/hour
cap. One instance is already over budget with a watermark frozen for four hours; the operator's
other, relied-upon instance is three tickets from the same cliff.

1. Push the watermark into the query server-side (`updatedAt: { gt: new Date(since) }`) so a busy
   window doesn't return issues nobody needs to re-see.
2. Narrow the port's return type to what its one caller reads (`id`, `updatedAt`) so the relation
   hydration this caller never consumes cannot come back — a type, not a comment.

Alongside: `src/ingress/poll.ts`'s `pollForMissedWork` is a correct, efficient, dead implementation
of nearly this same query (T122, deliberately not deleted at the time). This task makes the
decision T122 deferred: delete it, because reviving it as the live path would mean rebuilding the
self-event loop-guard sophistication `reconcile()` already carries (T107), which would be a ninth
instance of this repository's own "two implementations of one rule" family (T72/T92/T96/T99/
T101/T119/T125).

Purpose: a poll that cannot run inside its own rate budget is not a safety net, it is a second
outage waiting for the first one's neighbor. Fixing the query, not the schedule, is what makes a
quiet poll cost 1 request instead of 48.

Output: a server-filtered, narrow-return `listAssignedOpenIssues` wired through every layer
(port, real client, silence decorator, fake, the one caller); a request-count regression test that
would have caught this and did not exist before; `poll.ts` deleted; TRAPS T129.
</objective>

<measured_facts>
Read from source at HEAD, not recalled.

**M1 — the exact waste, line by line.** `src/outbound/linear-client.ts:240-253`:
`listAssignedOpenIssues` pages with `pageAll<Issue>`, then does
`return Promise.all(issues.map(toLinearIssue));`. `toLinearIssue` (`:134-150`) does
`await Promise.all([issue.assignee, issue.project, issue.team, issue.state])` — four lazy SDK
references, each a real GraphQL request when the SDK resolves it. The one caller,
`src/orchestration/recovery.ts:261-277`, reads exactly `issue.updatedAt` (lines 263, 264) and
`issue.id` (lines 274-276). Every hydrated field is fetched and discarded.

**M2 — the early-out runs after the price is paid.** `recovery.ts:264`:
`if (issue.updatedAt <= watermark) continue;` — this is a CLIENT-side filter, applied after
`listAssignedOpenIssues` has already hydrated every issue on the page. The `ponytail:` comment
directly above the call (`:257-260`) states this was a deliberate choice ("filtered client-side...
push the predicate into the query if that set ever grows past a page or two") — that ceiling has
been reached.

**M3 — the watermark math is already safe, proven by reading it, not by assuming it.**
`reconcile()` (`recovery.ts:242-330`): `let newest = watermark;` (`:247`), and
`const seen = (stamp) => { if (stamp > newest && stamp <= ceiling) newest = stamp; };` (`:248-250`).
Since `newest` starts at `watermark` and only moves to a `stamp` strictly greater than its current
value, an issue with `updatedAt <= watermark` can structurally never advance `newest` — regardless
of whether the query filtered it out or the client did. This is what makes server-side filtering
safe to add without touching `seen()` at all.

**M4 — the dead twin, confirmed by caller, not by header.** `src/ingress/poll.ts:74`
`pollForMissedWork` has no caller anywhere in `src/` or `scripts/` except its own declaration and
its own test file (`grep -rn 'pollForMissedWork' src/ scripts/ | grep -v .test.ts` returns exactly
one line, `recovery.ts:49`'s doc comment). TRAPS T122 (`.planning/TRAPS.md:162`) already found this
and deliberately did NOT delete it: "deleting a module is a bigger decision than a knob-adding task
should make on its own." `poll.ts`'s own query (`:91-93`) already does the right thing —
`filter: { assignee: { id: { eq: botUserId } }, updatedAt: { gt: new Date(since) } }`, reading only
`issue.id`/`issue.updatedAt` — but its event model (`DomainEvent[]`, `issue.assigned`/
`comment.created`) and its `PollDeps` shape (a bespoke `PollClient`/`Connection<T>` abstraction) do
not compose with the current `RecoveryDeps`/`engine.handle()` architecture `reconcile()` runs today,
and it carries none of T107's self-event guard. Reviving it means rebuilding, not reusing.

**M5 — every call site of the method being narrowed, confirmed by opening each one.**
`grep -rn "listAssignedOpenIssues" src` : the port (`ports.ts:474`), the real implementation
(`linear-client.ts:240`), the silence passthrough (`quiet-linear.ts:86`), the fake
(`fakes.ts:767`), the one production caller (`recovery.ts:261`), and three test call sites —
`recovery.test.ts:168` (a LOCAL fake, cast `as unknown as RecoveryDeps`, not type-checked against
the port), `qa-roundtrip.test.ts:250,271` (via the real `FakeLinearClient`, reading only `.length`
and `.updatedAt`), `quiet-linear.test.ts:139` (reading only `.length`). None of the test call sites
read any field this narrowing removes, confirmed by opening each one rather than assuming from the
grep count.

**M6 — `scripts/` is outside the compile surface by design, and neither smoke script calls this
method directly.** `tsconfig.json`'s own comment: `"scripts/" is deliberately OUT` of `include`.
`grep -n "listAssignedOpenIssues" scripts/*.ts` returns nothing; both `boot-smoke.ts` and
`live-ingress-uat.ts` exercise the method only indirectly, through a real daemon boot calling
`reconcile()` against a `RecordingLinear`/`FakeLinearClient` stub (`daemon-fixture.ts:188`, which
overrides only `getIssue`, not `listAssignedOpenIssues` — it inherits the fake being changed here).
`live-ingress-uat.ts` needs live Linear credentials this task does not touch or run; it is
unaffected by this change and is reported, not executed.

**M7 — the pre-existing merge conflict, left alone.** `.planning/TRAPS.md` lines 109-120 carry a
committed, unresolved merge conflict predating this task. Do not open or edit that range; append
T129 after the last existing row (T128, line 168).

**M8 — two more ledger rows this task's method leans on, read as instructed.** T109's deletion
procedure is itself T99 applied as a habit ("for any security control, find the test that fails
when the control is removed from the LIVE path" generalises past security controls to any
must-be-wired behavior, which is why Task 2 runs the same deletion against `recovery.ts:261`).
T120's lesson — do not reason about a foreign system, post to it and read back what it actually
did — is why the original 3.9-requests-per-issue number came from instrumenting `globalThis.fetch`
around the real SDK rather than from reading `toLinearIssue` and guessing; the regression test in
Task 1 cannot re-run that live probe on every `npm run verify`, so it substitutes a counting
getter on the SAME test-seam this file already uses (`sdk: asSdk({...})`, T88's default-parameter
injection) as a deterministic stand-in for the real SDK's lazy-relation request, not a new
testing philosophy.

**M9 — the live daemon, and why `npm run verify` is still safe to run in full.** PID 57847 runs
live off this repo's `dist/`. `npm run verify` runs `npm run clean && tsc`, which rewrites `dist/` —
harmless, because the running process resolved its modules at boot and does not re-read `dist/`
(the same reasoning 260909-nh6's M14 and 260910-sm5's M12 already recorded for this exact
tension). The prohibition is on a standalone `npm run build`/restart/kill, not on the mandated
gate.
</measured_facts>

<design>
## The narrowed signature and the server-side filter

`ports.ts`, `LinearClient.listAssignedOpenIssues`:

```
listAssignedOpenIssues(botUserId: string, since?: string): Promise<Pick<LinearIssue, 'id' | 'updatedAt'>[]>;
```

`linear-client.ts`'s implementation drops the `toLinearIssue` hydration entirely and adds the
predicate conditionally, so the one pre-existing test calling with a single argument keeps its
exact expected filter object:

```
async listAssignedOpenIssues(botUserId, since) {
  return this.call('listAssignedOpenIssues', async () => {
    const issues = await pageAll<Issue>((after) =>
      this.sdk.issues({
        first: PAGE_SIZE,
        after,
        filter: {
          assignee: { id: { eq: botUserId } },
          state: { type: { nin: ['completed', 'canceled'] } },
          ...(since !== undefined ? { updatedAt: { gt: new Date(since) } } : {}),
        },
      }),
    );
    return issues.map((issue) => ({ id: issue.id, updatedAt: issue.updatedAt.toISOString() }));
  });
}
```

One short comment above the port method, not a paragraph: narrowed on purpose, measured cost of
widening it back is 3.9 requests/issue, see quick 260911-i3p. This repo's global comment
convention (terse, only for a constraint the next person would otherwise break) applies to this
new code even though the surrounding file's older comments are longer.

## The request-count test, the most important one in this task

Add a `countingIssue` helper beside the existing `fakeIssue` in `linear-client.test.ts`: build a
plain issue object, then `Object.defineProperty` its `assignee`/`project`/`team`/`state` as
GETTERS that increment a shared counter and return a resolved relation — modeling exactly what the
real SDK does (each lazy relation access is a request). A second counter increment happens inside
the fake `sdk.issues` call itself (the one page fetch). Then:

```
const costFor = async (n) => {
  counter.requests = 0;
  await client(counter).listAssignedOpenIssues('user-bot');
  return counter.requests;
};
assert.equal(await costFor(20), await costFor(1), `... 1 issue cost X, 20 issues cost Y`);
```

Falsify by temporarily restoring `return Promise.all(issues.map(toLinearIssue));` in
`linear-client.ts` and re-running only this test: it must fail with the real counts in the message
(1-issue cost ~5, 20-issue cost ~81, i.e. `page(1) + 4*N`). A test that only checked which issues
came back would pass against that broken code — which is why none of the 771 existing tests caught
this, and why the assertion must be on the count.

## Recovery's call site and the now-corrected comment

`recovery.ts:257-261`'s `ponytail:` comment is replaced (not extended) — it currently states the
exact ceiling this task closes ("push the predicate into the query if that set ever grows"), so
leaving it would be a comment asserting a decision this task reverses. New comment: two sentences,
stating the predicate is now server-side and that the `continue` below is defense-in-depth, per
M3's proof. The `continue` line itself is UNCHANGED.

## The dead twin: deleted, not revived

`poll.ts` gets the query right but is wired to a different, older architecture (`DomainEvent[]`,
a bespoke `PollClient`) that predates T107's self-event guard. Reviving it as the live path is not
"the lazy option" — it is a rewrite disguised as a reuse. Delete `poll.ts` and `poll.test.ts`
outright. This is T122's deferred decision, made now with the evidence T122 didn't have: the live
`reconcile()` has since absorbed everything `pollForMissedWork` did and more (T107's guard), so
there is no capability gap to justify keeping two.

## TRAPS T129 (append after T128, `.planning/TRAPS.md`)

```
| T129 | **A query that hydrates every relation costs the caller nothing it reads.** `listAssignedOpenIssues` paged issues then ran `toLinearIssue` on all of them -- `Promise.all([issue.assignee, issue.project, issue.team, issue.state])` -- for a caller (`recovery.ts`'s `reconcile()`) that reads only `id` and `updatedAt`. Measured live: a page of 8 issues cost 1 request; resolving those four relations on the 8 cost 31 more -- 3.9 requests per issue for fields nobody consumed. At 12 open assigned issues that is ~48 requests/poll, ~2870/hour against Linear's 2500/hour cap; one instance ran 336 consecutive rate-limit failures with its watermark frozen for four hours, unable to self-heal, because every subsequent hour was also over budget. | The client-side `if (issue.updatedAt <= watermark) continue` ran AFTER the hydration was paid for, so the daemon paid full price for every issue it then discarded. And `src/ingress/poll.ts`'s `pollForMissedWork` -- T122's deferred dead twin, deliberately not deleted at the time because "deleting a module is a bigger decision than a knob-adding task should make on its own" -- had already gotten the query right (`updatedAt: { gt: new Date(since) }`, no `toLinearIssue` anywhere) and was never called. | Narrow the port's return type to `Pick<LinearIssue, 'id' \| 'updatedAt'>` so the type system refuses the hydration back, and push the watermark into the query as `updatedAt: { gt: new Date(since) }` -- a narrowed return type beats a comment. `pollForMissedWork` deleted outright rather than left a second time: reviving it would mean rebuilding the self-event/loop-guard sophistication `reconcile()` already carries (T107), a ninth instance of T72/T92/T96/T99/T101/T119/T125's "two implementations of one rule." The regression test asserts the REQUEST COUNT, not the result shape -- a test asserting only that the right issues come back would have passed against the broken code, which is exactly why none of the 771 existing tests caught this. | quick 260911-i3p |
```

## docs/TRAPS.md

Bump line 3's count ("One hundred and twenty-eight" -> "One hundred and twenty-nine"). Add one
short paragraph under `## Linear's API and SDK`, after the "Every `webhooks()` call pulls signing
secrets into memory" paragraph (same shape: an innocent-looking call costs more than it looks):
state the 3.9-requests-per-issue measurement, the four-hour frozen watermark, and that the fix is
a narrowed return type plus a server-side predicate, closing T122's deferred dead-twin decision.
Bump `README.md:201`'s count from 128 to 129.
</design>

<tasks>

<task type="tracer">
  <name>Task 1: One path, server-filtered and narrow, wired end to end (both fixes from the objective)</name>
  <files>
    src/domain/ports.ts, src/outbound/linear-client.ts, src/outbound/linear-client.test.ts,
    src/outbound/quiet-linear.ts, src/domain/fakes.ts, src/orchestration/recovery.ts
  </files>
  <read_first>
    - `src/orchestration/recovery.ts:242-330` (`reconcile()`) and its `EPOCH`/`seen()` at
      `:56-57,247-250` -- confirm M3's proof yourself before editing anything.
    - `src/outbound/linear-client.ts:134-150` (`toLinearIssue`) and `:240-253`
      (`listAssignedOpenIssues`), and `PAGE_SIZE` at `:41`.
    - `src/domain/ports.ts:389-412` (`LinearIssue`) and `:468-500` (`LinearClient`, especially
      `listAssignedOpenIssues` at `:474` and the sibling optional-`since` precedent at
      `listComments`, `:500`).
    - `src/outbound/quiet-linear.ts:80-91` -- the read-methods block, and its own comment
      explaining why reads are never gated (:81-83). `listAssignedOpenIssues` stays in this
      block; it does not move to the gated section below.
    - `src/domain/fakes.ts:712-768` -- `FakeLinearClient`'s constructor (`:736`) and its
      `listAssignedOpenIssues` (`:767`).
    - `src/outbound/linear-client.test.ts:18-35` (`fakeIssue`, `onePage`) and `:223-269`
      (the `listAssignedOpenIssues` describe block) -- the exact two pre-existing tests and
      the injection pattern to extend, not replace.
  </read_first>
  <action>
    Change the port signature (`ports.ts:474`) to
    `listAssignedOpenIssues(botUserId: string, since?: string): Promise<Pick<LinearIssue, 'id' | 'updatedAt'>[]>`.
    Add one short comment above it (per the Design section: terse, states the measured cost of
    widening it back, cites this quick task) -- not a paragraph matching this file's older,
    longer comments.

    Rewrite `linear-client.ts`'s `listAssignedOpenIssues` per the Design section's code: add
    `since` as a second parameter, conditionally spread `updatedAt: { gt: new Date(since) }` into
    the filter only when `since !== undefined`, and replace `Promise.all(issues.map(toLinearIssue))`
    with a direct `.map` to `{ id, updatedAt: issue.updatedAt.toISOString() }` -- no
    `toLinearIssue` call anywhere in this method, no `Promise.all` on relations.

    Update `quiet-linear.ts:86`'s passthrough to
    `listAssignedOpenIssues: (botUserId: string, since?: string) => inner.listAssignedOpenIssues(botUserId, since)`.
    Do not move this line out of the ungated reads block.

    Update `fakes.ts:767`'s `FakeLinearClient.listAssignedOpenIssues` to accept `since?: string`,
    keep the existing `assigneeId === botUserId` filter, add `&& (since === undefined ||
    i.updatedAt > since)`, and narrow the returned object to `{ id: i.id, updatedAt: i.updatedAt }`
    per issue (the internal `Map<IssueId, LinearIssue>` that backs `getIssue` is untouched --
    `getIssue` still needs the full shape).

    Update `recovery.ts:261`'s call to `await linear.listAssignedOpenIssues(config.botUserId, watermark);`
    and replace the `ponytail:` comment at `:257-260` with the corrected two-sentence version from
    the Design section. Leave the `if (issue.updatedAt <= watermark) continue;` line and everything
    below it in the loop completely unchanged.

    In `linear-client.test.ts`'s `listAssignedOpenIssues` describe block: change the first
    existing test's `assert.equal(issues[0]?.identifier, 'ENG-42')` to
    `assert.deepEqual(issues[0], { id: 'issue-1', updatedAt: '2026-09-06T12:00:00.000Z' })` (the
    narrowed shape now has no `identifier`); the second existing test needs no change (it already
    reads only `.id`).

    Add the request-count regression test (mandatory falsification #1, the most important test in
    this task) per the Design section's `countingIssue` sketch: assert the total request count for
    20 issues equals the count for 1 issue, with both actual numbers in the failure message.
    Falsify it: temporarily restore the old `Promise.all(issues.map(toLinearIssue))` return, rerun
    this one test alone, and confirm it fails RED with the real counts shown (expect roughly 5 vs
    81) -- capture the exact failure text verbatim for SUMMARY.md. Restore the fix and confirm
    green before moving on.

    Add the predicate-sent test (mandatory falsification #2): call
    `listAssignedOpenIssues('user-bot', '2026-09-10T22:30:00.000Z')` against a fake `sdk.issues`
    that captures `args.filter`, and `assert.deepEqual` it against the full expected filter object
    including `updatedAt: { gt: new Date('2026-09-10T22:30:00.000Z') }`. Falsify: temporarily
    delete the `updatedAt` predicate from the filter object (not the `since` parameter itself),
    rerun this test alone, and confirm it fails RED showing the missing key in the diff -- capture
    the text verbatim. Restore and confirm green.
  </action>
  <verify>
    <automated>npm run verify</automated>
    Plus the two falsification RED texts captured above, quoted verbatim in SUMMARY.md.
  </verify>
  <done>
    `listAssignedOpenIssues` is server-filtered and returns only `{id, updatedAt}` at every layer
    (port, real client, silence passthrough, fake) with the one production caller passing the
    watermark. Both new tests are green, both falsifications were run and their RED text captured,
    and the two pre-existing tests in `linear-client.test.ts` reflect the narrowed shape. `npm run
    verify` green. Committed.
  </done>
</task>

<task type="auto">
  <name>Task 2: Prove the wiring, not just the output -- watermark equivalence and the T109 pair</name>
  <files>src/orchestration/recovery.test.ts</files>
  <read_first>
    - `src/orchestration/recovery.test.ts:66-81` (`Harness` interface), `:83-209` (`harness()`,
      especially the local `linear` object at `:167-183` and `failLinear` at `:79` (interface)
      and `:91` (instance)).
    - `:455-468` ("an issue below the watermark is not re-enqueued on the next pass") and
      `:585-597` ("the watermark never advances past our own clock") -- the two existing tests
      whose semantics your new tests must not disturb; both rely on the client-side `continue`
      and must keep passing unchanged.
    - `.planning/TRAPS.md` T109 (line 149) -- the exact procedure this task's falsification #4
      runs: delete a call-site argument, and name which suite goes red and which stays green.
    - `src/orchestration/qa-roundtrip.test.ts:228,291,359` -- the three T107 tests (each
      starting at one of these lines) that call `reconcile()` through the REAL engine and
      `FakeLinearClient`; these must stay green under falsification #4, and this task does not
      modify this file.
  </read_first>
  <action>
    Extend `harness()`'s local `linear` fake (`:167-183`) to accept a second parameter,
    `since?: string`. Add two new fields to `Harness` and populate them from the closure:
    `sinceReceived: Array<string | undefined>` (push every `since` value the fake receives, every
    call, unconditionally) and `filterServerSide: { on: boolean }` (mirrors `failLinear`'s shape,
    default `false`). When `filterServerSide.on` is `true` and `since !== undefined`, the fake
    returns `issues.filter((i) => i.updatedAt > since)` instead of the raw `issues` array. When
    `filterServerSide.on` is `false` (the default every pre-existing test runs under), behavior is
    completely unchanged -- confirm the two tests named in read_first still pass with no other
    edits.

    Add a new test: "reconcile() sends the current watermark as `since`, not merely a filtered
    result (mandatory falsification #2)" -- seed `h.store.kvSet(POLL_WATERMARK_KEY, OLD)` (reuse the file's existing
    `OLD`/`FRESH` constants), call `reconcile(h.deps, NOW)`, and assert
    `h.sinceReceived.at(-1) === OLD`. This is the argument-inspecting proof mandatory falsification
    #2 requires -- it cannot be satisfied by checking `report.enqueued` or `report.watermark`,
    because the client-side `continue` would make an unsent predicate look sent.

    Add a new test: "server-side filtering advances the watermark to the same value client-side
    filtering did, at the boundary (mandatory falsification #3)" -- set
    `h.filterServerSide.on = true`, seed one issue exactly AT the watermark (`updatedAt: OLD`) and
    one issue after it (`updatedAt: FRESH`), and assert the result matches what the sibling
    non-filtering test at `:455` already proves for the same shape: `enqueued` contains only the
    after-watermark issue, and `report.watermark === FRESH`. Falsify it: temporarily make the
    fake's simulated filter drop the after-watermark issue too (e.g. change the filter predicate to
    exclude it, simulating an off-by-one bug in a real server-side filter), rerun this one test, and
    confirm it fails RED at the mismatched `enqueued`/`watermark` values -- capture the text
    verbatim, then restore.

    **Mandatory falsification #4 (T109).** Temporarily delete the second argument at
    `recovery.ts:261` (back to `linear.listAssignedOpenIssues(config.botUserId)`). Run
    `recovery.test.ts` and `qa-roundtrip.test.ts` (via `npm run verify`, reading the per-test
    node:test output, not just the aggregate pass/fail) and record explicitly, by test name:
    - Expected RED: the new "sends the current watermark as `since`" test from this task -- it
      inspects the argument directly and has nothing to fall back on.
    - Expected GREEN, unaffected: every pre-existing `recovery.test.ts` behavior test (including
      the two named in read_first), the new watermark-equivalence test from this task (its
      `filterServerSide` fake falls back to returning everything unfiltered when `since` is
      `undefined`, and the client-side `continue` still filters correctly), and all three
      `qa-roundtrip.test.ts` T107 tests.
    State this pairing explicitly in SUMMARY.md with the actual RED assertion text, and if the
    split does not come out clean (both red, or neither), say so plainly rather than reporting a
    pass -- per T109's own recorded lesson, "a first pass that goes neither-red is the normal
    outcome, not a sign the procedure was done wrong." Restore the deleted argument and confirm
    the full suite is green again before proceeding.
  </action>
  <verify>
    <automated>npm run verify</automated>
    Plus falsification #3's RED text and falsification #4's by-test-name GREEN/RED report, both
    quoted verbatim in SUMMARY.md.
  </verify>
  <done>
    `recovery.test.ts` proves the watermark is actually SENT (not merely inferred), proves
    server-side and client-side filtering agree at the boundary, and the T109 deletion at the
    real call site is shown to turn exactly the argument-inspecting test red while every
    output-only test — in this file and in `qa-roundtrip.test.ts` — stays green. `npm run verify`
    green. Committed.
  </done>
</task>

<task type="auto">
  <name>Task 3: Delete the dead twin, close TRAPS T122, append T129, final gate</name>
  <files>
    src/ingress/poll.ts, src/ingress/poll.test.ts, src/orchestration/recovery.ts,
    .planning/TRAPS.md, docs/TRAPS.md, README.md
  </files>
  <read_first>
    - `src/ingress/poll.ts` in full (124 lines) and `src/ingress/poll.test.ts` in full (163
      lines) -- confirm, yourself, via `grep -rn "pollForMissedWork\|from '\./poll" src/
      scripts/ | grep -v poll.test.ts`, that nothing outside this pair references it, before
      deleting.
    - `src/orchestration/recovery.ts:47-54` (`POLL_WATERMARK_KEY`'s doc comment) -- the one
      remaining stale reference to `pollForMissedWork()` once `poll.ts` is gone.
    - `.planning/TRAPS.md` lines 165-168 (T125-T128, the tail of the ledger) and lines 109-120
      (the pre-existing merge conflict -- do NOT open or edit this range).
    - `docs/TRAPS.md:1-5` and its `## Linear's API and SDK` section (the "Every `webhooks()`
      call pulls signing secrets into memory" paragraph, to anchor the new one after it).
    - `README.md` around line 201, for the count string.
  </read_first>
  <action>
    Delete `src/ingress/poll.ts` and `src/ingress/poll.test.ts`. This is T122's deferred decision,
    made now: `pollForMissedWork` is correct but architecturally stale (M4), and reviving it would
    duplicate what `reconcile()` already does correctly and more safely.

    Rewrite `recovery.ts:47-54`'s doc comment on `POLL_WATERMARK_KEY` — it currently claims the key
    is "Shared with Phase 3's `pollForMissedWork()`"; that file no longer exists. State instead
    that the key is read and written only here now, and name this quick task and T122 for anyone
    tracing why the old cross-reference is gone.

    Append TRAPS T129 to `.planning/TRAPS.md`, using the exact row text from the Design section's
    "TRAPS T129" subsection, directly after T128 (the current last row, line 168). Do not open,
    edit, or attempt to resolve the merge-conflict markers at lines 109-120 (M7) — leave them
    exactly as found.

    Add the matching short paragraph to `docs/TRAPS.md` under `## Linear's API and SDK`, per the
    Design section, after the "Every `webhooks()` call pulls signing secrets into memory"
    paragraph. Bump the count at `docs/TRAPS.md:3` from "One hundred and twenty-eight" to "One
    hundred and twenty-nine". Bump `README.md`'s count from 128 to 129 at its equivalent line.

    Run the final gate, `npm run verify`, in full. Per M9, `npm run verify`'s internal
    `npm run clean && tsc` rewriting `dist/` is expected and harmless — the live daemon (PID 57847)
    is NOT restarted, killed, or reconfigured, and its real `config.json` is neither read nor
    written by this task. Report the exact test count printed (baseline 771, minus `poll.test.ts`'s
    7, plus this task's ~4 new tests — report the real number, not the arithmetic). Confirm
    `npm run smoke` (bundled inside `verify`) is green; note that `live-ingress-uat.ts` needs live
    credentials this task does not have and is not run, and is unaffected per M6.
  </action>
  <verify>
    <automated>npm run verify</automated>
  </verify>
  <done>
    Exactly one implementation of "poll for missed work" exists in the repository.
    `POLL_WATERMARK_KEY`'s doc comment no longer names a deleted function. TRAPS T129 is appended
    after T128 with the pre-existing merge conflict untouched; docs/TRAPS.md and README.md both
    read 129. `npm run verify` green with the exact count reported; the live daemon untouched.
    Committed.
  </done>
</task>

</tasks>

<success_criteria>
- A reconcile() tick's request cost for issue hydration is proven, by an automated count-based
  test, not to scale with the number of open assigned issues — and that test is shown to fail
  against the pre-fix code with the real counts in the failure message.
- The watermark is proven to reach Linear as a server-side predicate by inspecting the actual
  argument/filter sent, independently of whether the downstream result merely looks filtered.
- Server-side and client-side filtering are proven equivalent at the boundary case (an issue
  exactly at the watermark), with a falsification that drops a row and goes red.
- The T109 deletion at the real call site (`recovery.ts:261`) is run, and its outcome — which
  test went red, which stayed green, and why the green ones staying green matters — is reported
  by name, honestly, even if the split is not the clean pair expected.
- `src/ingress/poll.ts` and its test no longer exist; the one remaining reference to it
  (`recovery.ts`'s doc comment) is corrected.
- TRAPS T129 is appended after T128 without touching the pre-existing merge conflict at lines
  109-120; docs/TRAPS.md and README.md both read 129.
- `npm run verify` is green with the exact test count reported; the live daemon (PID 57847) is
  never restarted, killed, or reconfigured, and no standalone `npm run build` is run.
</success_criteria>

<output>
Write `.planning/quick/260911-i3p-the-reconciliation-poll-costs-o-n-graphq/SUMMARY.md`.

It must state, at minimum: the two fixes and where each landed across all five layers (port, real
client, silence passthrough, fake, the one caller); the dead-twin decision (deleted, not revived)
and why; all four mandatory falsifications' actual RED/GREEN text, quoted verbatim, in numbered
order (#1 request-count, #2 predicate-sent, #3 watermark-equivalence boundary, #4 the T109
deletion at `recovery.ts:261`, naming which suite/test went red and which stayed green); the exact
`npm run verify` count before and after; and confirmation the live daemon (PID 57847) was never
restarted or reconfigured and no standalone build was run.
</output>
