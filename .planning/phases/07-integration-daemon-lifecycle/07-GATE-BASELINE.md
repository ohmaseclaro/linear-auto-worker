# First-ever test run — baseline for 07-06

Captured by the orchestrator before 07-06 started, so the gate begins with a map rather than a
pile. **These 505 tests had never been executed** — 35 plans wrote them under rush mode and
nothing ran them.

```
tests 505 · pass 446 · fail 59 · duration 2.4s
```

**88% first-time pass rate** on code written by ~20 agents in parallel with no test execution.

## Accurate failure counts (an earlier estimate in this file overcounted — this is measured)

| failures | suite |
|---|---|
| 9 | `cli/wizard/preflight.test.js` |
| 7 | `orchestration/scheduler.test.js` |
| 7 | `cli/wizard/repo-safety.test.js` |
| 6 | `cli/wizard/mapping.test.js` |
| 5 | `orchestration/run-engine.test.js` |
| 4 | `infra/store/sqlite-store.test.js` |
| 3 | `outbound/linear-client.test.js`, `orchestration/questions.test.js`, `execution/execute-run.test.js` |
| 2 | `execution/event-router.test.js` |
| 1 | `orchestration/fanout.test.js`, `infra/logger.test.js`, `execution/supervisor.test.js`, `execution/stream-parser.test.js` |

## ROOT CAUSE FOUND — 22 of 59 are one line, with the fix already in this repo

All three wizard suites fail for **exactly one reason**, verified: 9 of 9, 7 of 7 and 6 of 6
failures are

```
error: 'Cannot redefine property: execa'
```

The tests monkey-patch the `execa` **ESM named export**, which is non-configurable by
specification — an ESM binding cannot be redefined. This is not 22 bugs; it is one testing
approach that ESM forbids.

**The fix pattern already exists in this codebase.** Plan 03-01 hit the same wall with the ngrok
SDK and solved it with default-parameter injection:

```ts
export function openTunnel(port: number, ngrok: NgrokApi = ngrokSdk)
export function installTunnelShutdownHooks(ngrok: NgrokApi = ngrokSdk): void
```

Apply the same shape to the wizard's child-process calls — accept an injected `execa` with the
real one as the default — and the production call sites stay unchanged. Prefer this to
`mock.module`, which is experimental and flag-gated.

The remaining ~37 failures are contract renames from 07-02 and 07-04 (`scheduler`, `run-engine`,
`linear-client`, `sqlite-store` written against pre-fix names) plus T48. Triage those by cause,
not by count — several suites likely share a rename.

## Pre-declared, not a regression

`a circular object logged through the redaction walker does not throw and does not hang` — this is
**TRAPS T48**, filed by 02-02 as out-of-scope and explicitly expected to fail on the first gate
run. Fix `redact()` or delete the test deliberately; do not read it as new breakage.

## Clean

No stray artifacts: `~/.linear-auto-worker` was not created by the run, and the working tree is
unchanged apart from `dist/`.

## What the pass column already proves

446 passing tests include the twelve subsystems separately verified by execution in
`07-RUNTIME-EVIDENCE.md` — migration idempotency, the nine-state table, the scheduler's
anti-starvation property, all four loop guards, prompt-injection containment, rate-limit
detection, notifier fan-out, answer correlation across every tier, and secret redaction including
post-boot registration.
