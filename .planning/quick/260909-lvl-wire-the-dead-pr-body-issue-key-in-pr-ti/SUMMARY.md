---
status: complete
quick_id: 260909-lvl
completed: 2026-09-09
---

# Wire the dead PR body, the issue key in the title, the leaked bot marker

Three defects found against real delivered runs (COD-7/8/9 → `dzfweb/miracle-shop` PRs #1/#2/#3).
Gate 661/661 → **679/679** plus the boot smoke.

## What shipped

| commit | task |
|---|---|
| `78f4116` | the bot marker becomes a CommonMark link reference definition |
| `48f3eff` | `prBody` required, the engine builds it, the run log path stops being fiction |
| `8837d11` | the issue key leads the PR title |

## Deliberately not built

Moving the issue to **In Review** is Linear's own GitHub integration's job, not ours. The
integration is connected and works — every `ohmaseclaro/law-uat-sandbox` ticket carries a
`github` attachment and COD-2/COD-3 moved to Done by themselves on merge. The three
`dzfweb/miracle-shop` tickets have no attachment because `dzfweb` is a personal GitHub account
where the Linear Code app is not installed, and the operator has `push` but not `admin` there.
Building a review-state resolver would have duplicated and fought Linear's automation. No
workflow-state code was touched.

## Fields now live, and fields deliberately still empty

Live: `ticketIdentifier`, `ticketUrl`, `summary`, `verdict`, `runLogPath`.

Still rendering their explicit "not recorded" branch, because no truthful value exists:
`testCommand` and `testResult` (nothing in this repo runs a test command — `runPrePushGates`
reads the diff and file list and executes nothing) and `didNotDo` (`AgentResult` has no such
field). Leaving them honest beats inventing a value.

## Falsifications

Task 3 (the title), both halves, observed:

- boundary removed → only `a neighbouring ticket key at the front does not suppress this one`
  fails. That test targets exactly the boundary.
- guard removed entirely → the three already-leads cases fail; the boundary case passes.
- restored → 25/25.

The blank-identifier case failed first time against a `length === 0` guard: the fixture is
`'   '`, not `''`. Fixed by trimming.

## An honest gap in this record

The executor's own report was lost to a harness error partway through Task 3. Tasks 1 and 2
were already committed and their messages record what was measured, and the full gate is green
— but the RED texts it observed for those two tasks are not reproduced here, because this
session did not see them. Tasks 3 and 4 were finished in the main session and their
falsifications above were observed directly.

## Recorded

T119 (an optional parameter is a dead parameter until the gate proves a caller sets it),
T120 (a marker invisible in one renderer is not invisible in another, and the gate renders
nothing), T121 (a path constant nothing writes to is the same defect as a parameter nothing
sets). Counts moved 118 → 121.
