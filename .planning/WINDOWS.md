---
schema_version: 1
open_count: 6
waived_count: 0
fixed_count: 2
total_count: 8
last_updated: 2026-09-06T20:21:59.338Z
---

# Broken Windows Ledger

> Cross-phase defect register. `/gsd-ship` blocks while `open_count > 0`.
> Waive with `gsd-tools windows waive <id> "<reason>"` (reason required).
> Mark fixed with `gsd-tools windows fixed <id>`.

| id | phase | kind | file | line | description | status | reason | recorded_at | resolved_at |
|----|-------|------|------|------|-------------|--------|--------|-------------|-------------|
| 1 | 02 | deviation | src/infra/logger.ts |  | redact() has no cycle guard; a circular object logged via createLogger() overflows the call stack (see 02-foundation/deferred-items.md) | fixed |  | 2026-09-06T16:56:01.511Z | 2026-09-06T20:21:59.146Z |
| 2 | 07 | stub | src/domain/types.ts |  | Config.operatorUserId is optional and nothing writes it; run-engine skips the INTK-03 subscribe with a warn until the wizard gains a prompt (07-CONTEXT P8) | open |  | 2026-09-06T18:01:18.325Z |  |
| 3 | 07 | deviation | src/outbound/linear-client.ts |  | outbound LinearClient/LinearIssue do not match src/domain/ports.ts; updateComment/addSubscriber/listComments unimplemented and setIssueState/createWebhook/teamId diverge - 07-04 seam | fixed |  | 2026-09-06T18:01:18.392Z | 2026-09-06T18:43:21.392Z |
| 4 | 07 | deviation | src/cli/daemon.ts |  | The notifier is constructed with the log and Slack channels only; LinearCommentChannel is excluded because the run engine already owns every Linear comment (ack edited in place D-10, threaded questions, multi-repo rollup) and adding it would double-post every milestone - 07-04 | open |  | 2026-09-06T18:43:21.462Z |  |
| 5 | 07 | stub | src/cli/daemon.ts |  | toNotifyEvent reports costUsd 0 and tokensUsed 0 on every terminal notification: runs has no cost or token column, so Slack and the log say $0.0000 for every run - 07-04 | open |  | 2026-09-06T18:43:21.533Z |  |
| 6 | 07 | deviation | src/execution/verdict.ts |  | T73: 'partial' is unreachable from a live run - the run engine trusts the agent's self-reported status while execute-run.ts's evidence-based verdict (commits present in the worktree) is built but not on the live path; a timed-out run with real commits ships no draft PR | open |  | 2026-09-06T20:21:59.211Z |  |
| 7 | 07 | unrun-verify | .planning/phases/07-integration-daemon-lifecycle/07-HUMAN-UAT.md |  | ROADMAP Phase 7 criteria 1 (assignment becomes a draft PR) and 5 (a question survives a restart) are UNVERIFIED - both need a real Linear workspace, a live ngrok tunnel and real gh; procedure written in 07-HUMAN-UAT.md | open |  | 2026-09-06T20:21:59.275Z |  |
| 8 | 07 | stub | src/cli/daemon.ts |  | Nothing drives a periodic questions.sweep() or reconciliation poll: a question deadline is only enforced at the next boot and missed work only swept at boot (QA-05). Both functions are ready to be called on an interval | open |  | 2026-09-06T20:21:59.338Z |  |

````json
[
  {
    "id": 1,
    "kind": "deviation",
    "phase": "02",
    "file": "src/infra/logger.ts",
    "line": null,
    "description": "redact() has no cycle guard; a circular object logged via createLogger() overflows the call stack (see 02-foundation/deferred-items.md)",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-09-06T16:56:01.511Z",
    "resolved_at": "2026-09-06T20:21:59.146Z"
  },
  {
    "id": 2,
    "kind": "stub",
    "phase": "07",
    "file": "src/domain/types.ts",
    "line": null,
    "description": "Config.operatorUserId is optional and nothing writes it; run-engine skips the INTK-03 subscribe with a warn until the wizard gains a prompt (07-CONTEXT P8)",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-09-06T18:01:18.325Z",
    "resolved_at": null
  },
  {
    "id": 3,
    "kind": "deviation",
    "phase": "07",
    "file": "src/outbound/linear-client.ts",
    "line": null,
    "description": "outbound LinearClient/LinearIssue do not match src/domain/ports.ts; updateComment/addSubscriber/listComments unimplemented and setIssueState/createWebhook/teamId diverge - 07-04 seam",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-09-06T18:01:18.392Z",
    "resolved_at": "2026-09-06T18:43:21.392Z"
  },
  {
    "id": 4,
    "kind": "deviation",
    "phase": "07",
    "file": "src/cli/daemon.ts",
    "line": null,
    "description": "The notifier is constructed with the log and Slack channels only; LinearCommentChannel is excluded because the run engine already owns every Linear comment (ack edited in place D-10, threaded questions, multi-repo rollup) and adding it would double-post every milestone - 07-04",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-09-06T18:43:21.462Z",
    "resolved_at": null
  },
  {
    "id": 5,
    "kind": "stub",
    "phase": "07",
    "file": "src/cli/daemon.ts",
    "line": null,
    "description": "toNotifyEvent reports costUsd 0 and tokensUsed 0 on every terminal notification: runs has no cost or token column, so Slack and the log say $0.0000 for every run - 07-04",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-09-06T18:43:21.533Z",
    "resolved_at": null
  },
  {
    "id": 6,
    "kind": "deviation",
    "phase": "07",
    "file": "src/execution/verdict.ts",
    "line": null,
    "description": "T73: 'partial' is unreachable from a live run - the run engine trusts the agent's self-reported status while execute-run.ts's evidence-based verdict (commits present in the worktree) is built but not on the live path; a timed-out run with real commits ships no draft PR",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-09-06T20:21:59.211Z",
    "resolved_at": null
  },
  {
    "id": 7,
    "kind": "unrun-verify",
    "phase": "07",
    "file": ".planning/phases/07-integration-daemon-lifecycle/07-HUMAN-UAT.md",
    "line": null,
    "description": "ROADMAP Phase 7 criteria 1 (assignment becomes a draft PR) and 5 (a question survives a restart) are UNVERIFIED - both need a real Linear workspace, a live ngrok tunnel and real gh; procedure written in 07-HUMAN-UAT.md",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-09-06T20:21:59.275Z",
    "resolved_at": null
  },
  {
    "id": 8,
    "kind": "stub",
    "phase": "07",
    "file": "src/cli/daemon.ts",
    "line": null,
    "description": "Nothing drives a periodic questions.sweep() or reconciliation poll: a question deadline is only enforced at the next boot and missed work only swept at boot (QA-05). Both functions are ready to be called on an interval",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-09-06T20:21:59.338Z",
    "resolved_at": null
  }
]
````
