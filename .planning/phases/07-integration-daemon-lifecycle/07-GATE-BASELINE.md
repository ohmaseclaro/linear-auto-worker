# First-ever test run — baseline for 07-06

Captured by the orchestrator before 07-06 started, so the gate begins with a map rather than a
pile. **These 505 tests had never been executed** — 35 plans wrote them under rush mode and
nothing ran them.

```
tests 505 · pass 446 · fail 59 · duration 2.4s
```

**88% first-time pass rate** on code written by ~20 agents in parallel with no test execution.

## Failures are concentrated, not scattered

| suite | approx failures | likely cause |
|---|---|---|
| `cli/wizard/mapping.test.js` | ~18 | shells out via `execa`; ESM module mocking under `node:test` |
| `cli/wizard/repo-safety.test.js` | ~16 | same — `git remote`, `gh api` |
| `cli/wizard/preflight.test.js` | ~16 | same — `git config`, `gh auth status`, `claude --version` |
| `outbound/linear-client.test.js` | ~13 | SDK doubles vs the port that 07-04 just changed |
| `orchestration/scheduler.test.js`, `run-engine.test.js` | ~22 | contract renames from 07-02 |
| `infra/store/sqlite-store.test.js` | ~5 | written against the pre-T53 column names |
| others | remainder | |

Roughly **50 of 59 are the three wizard suites**, which share one shape: they mock a child-process
call. That is likely **one fix pattern, not fifty bugs**. Triage by cause before by count.

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
