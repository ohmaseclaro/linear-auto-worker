---
schema_version: 1
open_count: 1
waived_count: 0
fixed_count: 0
total_count: 1
last_updated: 2026-09-06T16:56:01.511Z
---

# Broken Windows Ledger

> Cross-phase defect register. `/gsd-ship` blocks while `open_count > 0`.
> Waive with `gsd-tools windows waive <id> "<reason>"` (reason required).
> Mark fixed with `gsd-tools windows fixed <id>`.

| id | phase | kind | file | line | description | status | reason | recorded_at | resolved_at |
|----|-------|------|------|------|-------------|--------|--------|-------------|-------------|
| 1 | 02 | deviation | src/infra/logger.ts |  | redact() has no cycle guard; a circular object logged via createLogger() overflows the call stack (see 02-foundation/deferred-items.md) | open |  | 2026-09-06T16:56:01.511Z |  |

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
  }
]
````
