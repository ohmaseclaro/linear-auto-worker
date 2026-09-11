---
task: The reconciliation poll costs O(N) GraphQL requests per tick and exceeds Linear's 2500/hour rate limit by construction
id: 260911-i3p
type: quick
severity: P0
status: complete
created: 2026-09-11
completed: 2026-09-11
gate: npm run verify — 768/768, both smokes PASSED
commits:
  - bcae21e feat — server-filter and narrow listAssignedOpenIssues
  - 26d4950 test — prove watermark wiring, not just output
  - 61863d8 refactor — delete the dead twin, T129
---

# Summary

## Provenance of this file — read first

The executor was killed mid-Task-3 when the host application quit. Tasks 1 and 2 were
already committed (`bcae21e`, `26d4950`); Task 3's edits were complete in the working tree
but uncommitted, and no SUMMARY.md had been written.

This file was written afterwards by the orchestrator, not by the executor. That matters for
one thing and it is stated plainly rather than papered over:

**The executor's own falsification RED texts were never captured.** Its transcript went with
the process. Rather than record an unobserved claim, the orchestrator re-ran falsifications
1, 2 and 4 directly and quotes what it saw. Falsification 3 was not re-run; its test is in
the suite and green, but no one has watched it fail, so it is listed as unobserved.

## The defect

`listAssignedOpenIssues` paged assigned issues and mapped every one through `toLinearIssue`,
which resolves `assignee`, `project`, `team` and `state` — four lazy references, four real
GraphQL round trips. Its one production caller, `reconcile()`, reads `id` and `updatedAt`
and nothing else. The client-side `if (issue.updatedAt <= watermark) continue` ran *after*
the hydration was paid for, so the daemon bought four relations for every issue it then
discarded.

Measured against the live API by instrumenting `globalThis.fetch`: a page of 8 issues cost
1 request; resolving the four relations on those 8 cost 31 more — **3.9 requests per issue**.

At 12 open assigned issues that is ~48 requests per 60-second poll, ~2870/hour against
Linear's 2500/hour cap. The poll-only instance logged 336 consecutive
`reconciliation poll failed; watermark not advanced` with `Rate limit exceeded`, watermark
frozen at `2026-09-10T22:30:51.796Z` for four hours. It could not self-heal, because every
subsequent hour was also over budget. Poll is that instance's only ingress, so it was
completely blind for the whole window.

## What changed

Two independent reductions, both landed in `bcae21e`:

1. `listAssignedOpenIssues` returns `Pick<LinearIssue, 'id' | 'updatedAt'>` and maps
   straight off the page — no `toLinearIssue`, no relation access. The narrowed return type
   is the point: a comment can be ignored, a type cannot.
2. The watermark is pushed into the query as `updatedAt: { gt: new Date(since) }`, so a
   quiet window returns nothing instead of returning everything to be filtered locally.

Safe because `seen(stamp)` only advances `newest` when `stamp > newest`, and `newest` starts
at `watermark` — an issue at or below the watermark could never have advanced it. The
second half of `reconcile()` (the `listComments` pass) calls `seen(c.createdAt)` on its own
and is untouched.

`61863d8` deletes `src/ingress/poll.ts`. `pollForMissedWork` was exported, had no caller,
and had already gotten this exact query right — `updatedAt: { gt }`, no hydration. Deleted
rather than revived: reviving it would mean rebuilding the self-event and loop guards
`reconcile()` already carries (T107), which is the "two implementations of one rule" shape
this ledger has recorded eight times. That also closes T122's deferred decision.

## Measured after, against the live API

| | requests | issues returned |
|---|---|---|
| quiet poll (watermark 5 min ago) | **1** | 0 |
| boot poll (watermark EPOCH) | **1** | 7 |

60 requests/hour against a 2500/hour cap. The cost is now O(1) in the issue count, not
merely smaller — the boot case, which the plan expected to be the expensive one, costs the
same single request as a quiet one because nothing is hydrated at any size.

Before the fix the same 7-issue poll cost 28 requests.

## Falsifications

### #1 — restore the per-issue hydration. OBSERVED RED.

```
not ok 3 - does not scale request cost with the number of issues on the page (mandatory falsification #1)
    1 issue cost 5 requests, 20 issues cost 81 requests -- per-issue relation hydration would scale the second number with N
  name: 'AssertionError'
  expected: 5
  actual: 81
# pass 24
# fail 1
```

This is the test that would have caught the outage, and the reason none of the previous 771
did: it asserts the request **count**, not the result shape. A test asserting only that the
right issues come back passes identically against both implementations.

### #2 — delete the server-side `updatedAt` predicate. OBSERVED RED.

```
not ok 4 - sends the watermark as a server-side updatedAt predicate (mandatory falsification #2)
  name: 'AssertionError'
# pass 45
# fail 1
```

Red in `linear-client.test.ts` only; `recovery.test.ts` stayed green, which is correct — the
client-side `continue` still produces the right output downstream and would have masked a
missing predicate. That is precisely why the assertion inspects the filter that is sent.

### #3 — watermark equivalence at the boundary. NOT OBSERVED.

The test exists and is green. Its RED was never watched, by the executor or afterwards.
Recorded as unobserved rather than claimed.

### #4 — T109 wiring: delete the watermark argument at `recovery.ts:258`. OBSERVED, AND IT DISCRIMINATES.

```
--- linear-client.test.ts (expected GREEN) ---
# pass 25
# fail 0
--- recovery.test.ts (expected RED) ---
not ok 14 - reconcile() sends the current watermark as `since`, not merely a filtered result
# pass 20
# fail 1
```

Worth noting against this repo's recent record: the last two T109 pairs did not discriminate
— one because the named unit suite turned out to carry engine-driving integration tests, one
because a `?? true` default made "unwired" and "wired to true" render identically. This pair
separates cleanly.

## Gate

`npm run verify` — 768/768, 0 failures, `SMOKE PASSED` and `POLL-ONLY PHASE PASSED`.

771 → 768 is the arithmetic of deleting `poll.test.ts` (its tests go) against the new tests
added here, not a regression.
