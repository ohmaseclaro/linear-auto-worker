---
schema_version: 1
open_count: 4
waived_count: 0
fixed_count: 1
total_count: 5
last_updated: 2026-09-06T18:43:21.533Z
---

# Broken Windows Ledger

> Cross-phase defect register. `/gsd-ship` blocks while `open_count > 0`.
> Waive with `gsd-tools windows waive <id> "<reason>"` (reason required).
> Mark fixed with `gsd-tools windows fixed <id>`.

| id | phase | kind | file | line | description | status | reason | recorded_at | resolved_at |
|----|-------|------|------|------|-------------|--------|--------|-------------|-------------|
| 1 | 02 | deviation | src/infra/logger.ts |  | redact() has no cycle guard; a circular object logged via createLogger() overflows the call stack (see 02-foundation/deferred-items.md) | open |  | 2026-09-06T16:56:01.511Z |  |
| 2 | 07 | stub | src/domain/types.ts |  | Config.operatorUserId is optional and nothing writes it; run-engine skips the INTK-03 subscribe with a warn until the wizard gains a prompt (07-CONTEXT P8) | open |  | 2026-09-06T18:01:18.325Z |  |
| 3 | 07 | deviation | src/outbound/linear-client.ts |  | outbound LinearClient/LinearIssue do not match src/domain/ports.ts; updateComment/addSubscriber/listComments unimplemented and setIssueState/createWebhook/teamId diverge - 07-04 seam | fixed |  | 2026-09-06T18:01:18.392Z | 2026-09-06T18:43:21.392Z |
| 4 | 07 | deviation | src/cli/daemon.ts |  | The notifier is constructed with the log and Slack channels only; LinearCommentChannel is excluded because the run engine already owns every Linear comment (ack edited in place D-10, threaded questions, multi-repo rollup) and adding it would double-post every milestone - 07-04 | open |  | 2026-09-06T18:43:21.462Z |  |
| 5 | 07 | stub | src/cli/daemon.ts |  | toNotifyEvent reports costUsd 0 and tokensUsed 0 on every terminal notification: runs has no cost or token column, so Slack and the log say $0.0000 for every run - 07-04 | open |  | 2026-09-06T18:43:21.533Z |  |

````json
[
  {
    "id": 1,
    "kind": "deviation",
    "phase": "02",
    "file": "src/infra/logger.ts",
    "line": null,
    "description": "redact() has no cycle guard; a circular object logged via createLogger() overflows the call stack (see 02-foundation/deferred-items.md)",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-09-06T16:56:01.511Z",
    "resolved_at": null
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
  }
]
````
