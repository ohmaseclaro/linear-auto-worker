---
phase: 03-ingress
plan: 01
subsystem: infra
tags: [ngrok, tunnel, boot, secrets, node-test]

requires:
  - phase: 01-domain-contract-state-machine-schema
    provides: "TunnelError (src/domain/errors.ts) — the typed error every failure path here throws"
provides:
  - "openTunnel(port, ngrok?) — opens the process's single ephemeral ngrok tunnel and returns a URL proven non-null"
  - "closeTunnel(listener) — graceful single-tunnel close"
  - "installTunnelShutdownHooks(ngrok?) — SIGINT/SIGTERM handlers, registered explicitly by Phase 7, never at module scope"
  - "NgrokApi — the injectable three-method slice of @ngrok/ngrok used for testing without a real tunnel"
affects: [03-02 registrar, 07 daemon lifecycle]

tech-stack:
  added: []
  patterns:
    - "Optional last-parameter dependency injection (default = real SDK) instead of a module mock"
    - "Secret-safe error handling: extract a code from the message, never forward the caught object"

key-files:
  created:
    - src/ingress/tunnel.ts
    - src/ingress/tunnel.test.ts
  modified: []

key-decisions:
  - "Tests co-located at src/ingress/tunnel.test.ts, not test/ingress/ — tsconfig rootDir/include is 'src' and verify is `tsc && node --test dist`, so a test outside src is never compiled and never runs"
  - "openTunnel takes an optional NgrokApi as its second parameter so all three verified ngrok failure paths are testable without opening a real tunnel"
  - "The catch block throws a fresh TunnelError with no `cause` — attaching the caught error would carry the echoed authtoken into any downstream serializer"
  - "TUN-02 crash/restart needs no code: the native ngrok session is bound to the OS process, so an orphan is structurally impossible"

patterns-established:
  - "Failure-path sanitisation: any third-party error that can echo a credential is reduced to a matched code before it crosses a module boundary"
  - "Boot invariants are runtime assertions (listener count, non-null URL), not review claims"

requirements-completed: [TUN-01, TUN-02, TUN-03]

coverage:
  - id: D1
    description: "Booting with NGROK_AUTHTOKEN unset fails with a message naming ~/.linear-auto-worker/.env, before any network call"
    requirement: TUN-03
    verification:
      - kind: unit
        ref: "src/ingress/tunnel.test.ts#an unset NGROK_AUTHTOKEN throws before any network call and names the .env file"
        status: unknown
    human_judgment: false
  - id: D2
    description: "A null listener.url() closes the listener and aborts boot rather than registering an unreachable webhook"
    requirement: TUN-01
    verification:
      - kind: unit
        ref: "src/ingress/tunnel.test.ts#a null url() closes the listener and fails boot (T19)"
        status: unknown
    human_judgment: false
  - id: D3
    description: "Exactly one listener exists in the process after openTunnel returns, asserted at runtime"
    requirement: TUN-01
    verification:
      - kind: unit
        ref: "src/ingress/tunnel.test.ts#two listeners after connect throws and names the observed count (TUN-01)"
        status: unknown
    human_judgment: false
  - id: D4
    description: "No error surfaced by the tunnel module can contain the operator's authtoken"
    requirement: TUN-03
    verification:
      - kind: unit
        ref: "src/ingress/tunnel.test.ts#an ERR_NGROK_105 rejection that echoes the authtoken never leaks it (T24)"
        status: unknown
    human_judgment: false
  - id: D5
    description: "Graceful shutdown closes the tunnel; ungraceful exit orphans nothing"
    requirement: TUN-02
    verification:
      - kind: unit
        ref: "src/ingress/tunnel.test.ts#installTunnelShutdownHooks registers SIGINT and SIGTERM handlers"
        status: unknown
    human_judgment: true
    rationale: "The ungraceful-exit half is a property of the native ngrok session's process binding. Confirming no orphan survives a SIGKILL needs a real tunnel and a real kill -9, which rush mode forbids and no unit test can stand in for."
  - id: D6
    description: "The tunnel URL is ephemeral — no domain key is passed to connect (D-01)"
    verification:
      - kind: unit
        ref: "src/ingress/tunnel.test.ts#the happy path returns the listener and a non-empty ephemeral url"
        status: unknown
    human_judgment: false

duration: 9min
completed: 2026-09-06
status: complete
---

# Phase 3 Plan 01: ngrok Tunnel Summary

**One ephemeral ngrok tunnel per process, whose URL is proven non-null and whose failure path cannot write the operator's authtoken to disk.**

## Performance

- **Duration:** ~9 min
- **Tasks:** 1/1
- **Files created:** 2
- **Commits:** 1 (`e9b8c5e`)

## Accomplishments

- `openTunnel(port, ngrok = ngrokSdk)` executes the five steps in the locked order: env pre-check → `connect({ addr, authtoken_from_env: true })` → sanitised catch → non-null URL check → single-listener assertion.
- The `NGROK_AUTHTOKEN` pre-check runs before any network call and names `~/.linear-auto-worker/.env` plus the setup wizard. Per T25 this is the *only* place TUN-03's actionable message can come from: an unset variable and a revoked account both surface as `ERR_NGROK_4018`.
- The catch extracts `/ERR_NGROK_(\d+)/` from the message and throws a fresh `TunnelError` with no `cause` and nothing else from the original. Per T24 the malformed-token error echoes the authtoken inside its own message; per T25 branching on `err.code` is dead code because every ngrok error is `GenericFailure`.
- A falsy `listener.url()` closes the listener and throws (T19) — the difference between a daemon that fails at boot and one that boots clean, logs healthy, and silently receives nothing forever.
- `(await ngrok.listeners()).length !== 1` turns TUN-01 from a claim into a runtime assertion.
- `installTunnelShutdownHooks()` is a function, not module-scope side effects, so importing this file (in a test or anywhere else) registers no signal handlers.
- Eight `node:test` cases against a hand-written fake, covering every case in the plan's behavior block.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Test file moved from `test/ingress/tunnel.test.ts` to `src/ingress/tunnel.test.ts`**

- **Found during:** Task 1
- **Issue:** `tsconfig.json` sets `"rootDir": "src"` and `"include": ["src"]`, and `package.json`'s verify script is `tsc && node --test dist` (the T34 resolution). A test file under a top-level `test/` directory is never compiled into `dist/` and therefore never executed. It would have looked like a passing gate while contributing zero coverage — the exact silent-success failure shape T34 describes.
- **Fix:** Co-located the test as `src/ingress/tunnel.test.ts`, matching the convention already on this branch (`src/domain/state-machine.test.ts`, `src/infra/config.test.ts`, `src/cli/wizard/preflight.test.ts`, `src/orchestration/scheduler.test.ts`).
- **Consequence for the gate:** the plan's Task 1 automated gate contains `test -f test/ingress/tunnel.test.ts`. Re-run it with that clause pointed at `src/ingress/tunnel.test.ts`; every other clause passes as written. Verified:
  ```
  GATE PASS
  ```
- **Commit:** `e9b8c5e`

**2. [Rule 3 - Blocking] `openTunnel` gained an optional second parameter**

- **Found during:** Task 1
- **Issue:** The plan's signature is `openTunnel(port: number)` with a hard `import ngrok from '@ngrok/ngrok'`, but the behavior block demands eight test cases including three ngrok failure paths — untestable without either module mocking (`node:test`'s `mock.module` is experimental and needs a runtime flag) or injection.
- **Fix:** `openTunnel(port: number, ngrok: NgrokApi = ngrokSdk)`. Production call sites are unchanged — `openTunnel(port)` still works and still uses the real SDK. The gate's literal `ngrok.listeners()` and `authtoken_from_env: true` strings are preserved because the parameter is named `ngrok`. `installTunnelShutdownHooks` took the same optional parameter for the same reason.
- **Commit:** `e9b8c5e`

## Contract additions requested

Phase 7 (daemon lifecycle) must wire these; nothing here self-registers.

```ts
// src/ingress/tunnel.ts
export interface NgrokApi {
  connect(config: { addr: number; authtoken_from_env: boolean }): Promise<Listener>;
  listeners(): Promise<Listener[]>;
  kill(): Promise<void>;
}

export function openTunnel(
  port: number,
  ngrok?: NgrokApi
): Promise<{ listener: Listener; url: string }>;

export function closeTunnel(listener: Listener): Promise<void>;

/** MUST be called once by Phase 7's daemon boot. Registers nothing at module scope. */
export function installTunnelShutdownHooks(ngrok?: NgrokApi): void;
```

Ordering constraint for Phase 7's boot sequence (03-RESEARCH § Architecture): the local
`node:http` server must be bound to `port` **before** `openTunnel(port)` is called.

## Out-of-scope discoveries (not fixed — not this plan's files)

- `src/infra/logger.ts` uses a **constructor parameter property** — `constructor(private readonly secrets: Set<string>)` in `SecretScrubbingStream`. This violates T35 / `erasableSyntaxOnly: true` and will fail `tsc` at the integration gate. Owned by Phase 2; flagged here rather than edited across a branch boundary. One-line fix: declare the field and assign it in the body.

## Known Stubs

None.

## Threat Flags

None. No new network surface beyond the tunnel already in the plan's threat register.

## Notes

- TUN-02's crash and restart cases carry no code by design. The ngrok session is native and dies with the OS process, so an orphaned tunnel is structurally impossible — no PID file, no lockfile. This is stated in a comment at the top of the module.
- The logger's `registerSecret()` (02-CONTEXT D-05) is a second line of defence, not the primary one. This module's guarantee is that the authtoken never reaches a log call in the first place.

## Self-Check: PASSED

- `src/ingress/tunnel.ts` — FOUND
- `src/ingress/tunnel.test.ts` — FOUND
- commit `e9b8c5e` — FOUND
- Task 1 automated gate (test path clause adjusted per Deviation 1) — GATE PASS
- T35 scan (`enum` / `namespace` / constructor parameter properties) — clean
- Forbidden-branch scan (`domain:`, `err.code` outside whole-line comments) — clean
