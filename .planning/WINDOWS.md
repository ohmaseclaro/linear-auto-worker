---
schema_version: 1
open_count: 3
waived_count: 0
fixed_count: 0
total_count: 3
last_updated: 2026-09-06T18:01:18.392Z
---

# Broken Windows Ledger

> Cross-phase defect register. `/gsd-ship` blocks while `open_count > 0`.
> Waive with `gsd-tools windows waive <id> "<reason>"` (reason required).
> Mark fixed with `gsd-tools windows fixed <id>`.

| id | phase | kind | file | line | description | status | reason | recorded_at | resolved_at |
|----|-------|------|------|------|-------------|--------|--------|-------------|-------------|
| 1 | 02 | deviation | src/infra/logger.ts |  | redact() has no cycle guard; a circular object logged via createLogger() overflows the call stack (see 02-foundation/deferred-items.md) | open |  | 2026-09-06T16:56:01.511Z |  |
| 2 | 07 | stub | src/domain/types.ts |  | Config.operatorUserId is optional and nothing writes it; run-engine skips the INTK-03 subscribe with a warn until the wizard gains a prompt (07-CONTEXT P8) | open |  | 2026-09-06T18:01:18.325Z |  |
| 3 | 07 | deviation | src/outbound/linear-client.ts |  | outbound LinearClient/LinearIssue do not match src/domain/ports.ts; updateComment/addSubscriber/listComments unimplemented and setIssueState/createWebhook/teamId diverge - 07-04 seam | open |  | 2026-09-06T18:01:18.392Z |  |

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
    "status": "open",
    "reason": "",
    "recorded_at": "2026-09-06T18:01:18.392Z",
    "resolved_at": null
  }
]
````
