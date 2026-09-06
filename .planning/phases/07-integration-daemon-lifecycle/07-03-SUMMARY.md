---
phase: 07-integration-daemon-lifecycle
plan: 03
subsystem: composition-root
tags: [daemon, boot, ingress, integration, smoke, wiring]
status: complete
requires:
  - "07-02: DomainEvent split into IngressEvent | EngineEvent, tsc at exit 0"
provides:
  - "src/cli/daemon.ts — bootDaemon(opts), the composition root plans 04/05/06 extend"
  - "scripts/boot-smoke.ts + `npm run smoke` — the phase's central verification instrument (D-04)"
  - "The ingress→engine mapping (T45 / hard deliverable #1) is written and exercised end to end"
  - "src/infra/store/domain-store.ts — the RunRow ↔ Run seam"
  - "test/integration/07-ingress-seam.test.ts — 7 gate cases, written, not yet run"
affects:
  - "07-04 (replaces three execution fakes; owns the outbound LinearClient facade seam bootDaemon now throws on)"
  - "07-05 (starts the scheduler, wires the registrar, fills in shutdown, owns signals)"
  - "07-06 (owns the first `node --test` run; tsconfig now emits dist/src/** and dist/test/**)"
tech-stack:
  added: []
  patterns:
    - "The injection seam is two ports wide — tunnel and Linear client — because those are the only ports that cross a boundary this machine cannot cross offline. Everything else is real in every caller, including the smoke."
    - "A verification instrument is only trustworthy once it has been falsified: both new gates were proved to FAIL against a deliberate break before being trusted."
    - "Fixtures for a real-graph boot live under src/ (T41), so the gate's compiled output can reach them."
key-files:
  created:
    - src/cli/daemon.ts
    - src/cli/daemon-fixture.ts
    - src/infra/store/domain-store.ts
    - scripts/boot-smoke.ts
    - test/integration/07-ingress-seam.test.ts
  modified:
    - src/cli/index.ts
    - src/infra/store/sqlite-store.ts
    - src/infra/store/sqlite-store.test.ts
    - src/ingress/registrar.ts
    - package.json
    - tsconfig.json
decisions:
  - "bootDaemon takes exactly two overridable ports (tunnel, linear) — a container with a slot per dependency would let the smoke boot a graph of doubles and prove nothing about the graph that runs"
  - "The scheduler is constructed and immediately paused: that is how D-01's 'execution stays faked' is enforced structurally rather than by comment — a paused semaphore means no run can leave `queued` and nothing can spawn"
  - "The webhook signing secret is read from kv under the registrar's own exported key, generated-and-persisted if absent, so plan 05's reconcile() reuses it rather than minting a second one the receiver would reject every delivery against"
  - "sqlite-store.findActiveRunByIssue now returns ALL active runs, not the newest — a LIMIT 1 cancelled one child of a fanned-out ticket and left the rest running (DELV-07)"
  - "tsconfig rootDir '.' + include ['src','test'] — the only way test/integration/*.test.ts reaches dist, and dist is the only place node --test can run it (T34)"
metrics:
  duration: ~50min
  tasks: 2
  files: 11
  completed: 2026-09-06
---

# Phase 7 Plan 03: The Composition Root and the Boot Smoke Summary

`bootDaemon()` wires the real module graph in D-01 order, and `npm run smoke` proves a
real HMAC-signed webhook becomes a persisted `queued` run in real SQLite — with the
expensive half of the system still faked.

## The `bootDaemon` options shape

Plans 04, 05 and 06 all extend this. It is deliberately narrow.

```ts
export interface BootOptions {
  /** Config root. Defaults to `~/.linear-auto-worker`; the smoke passes a mkdtemp dir. */
  configDir?: string;
  /** Crosses the network. Overridable. */
  tunnel?: TunnelManager;
  /** Crosses the network. Overridable. */
  linear?: LinearClient;
}

export interface DaemonHandle {
  port: number;            // the bound loopback port
  publicUrl: string;       // what the tunnel returned
  config: Config;
  store: Store;            // the domain-shaped store; the smoke and the seam tests read it
  engine: RunEngine;
  log: Logger;
  shutdown(): Promise<void>;
}
```

**The seam rule, stated so 04/05/06 do not widen it:** a port is overridable *only* if it
crosses a process or network boundary this machine cannot cross offline. ngrok needs an
account and the internet; Linear needs a workspace and a key. Config loading, the SQLite
store, the migration, the receiver, the router, the scheduler, the run engine, the question
correlator and the recovery sweep are constructed **real, always, in every caller including
the smoke**. The moment a third slot appears, the smoke stops proving anything about the
graph that actually runs.

## Boot order, and the two places it is load-bearing

1. config + secrets + logger + open, migrated database (`loadFoundation`)
2. the store
3. **the recovery sweep — before ingress binds.** A delivery landing while the database
   still shows a phantom `running` row from a crashed process is dropped as
   already-running, and the ticket sits In Progress forever.
4. `server.listen(0, '127.0.0.1')` — the socket accepts connections...
5. ...**and only then** `tunnel.open(port)` (D-02 / HOOK-01)
6. router → engine, through the mapping. Execution stays fake (D-01).

## T45 is closed: the mapping exists and is exercised

07-02 split `DomainEvent` so `engine.handle(await router.route(d))` is a compile error.
`createIngressMapper({store, linear})` in `daemon.ts` is the written half, exported so it is
testable without booting anything:

| ingress | engine |
|---|---|
| `issue.assigned` | `run.requested` |
| `issue.unassigned` | `run.cancelled` (reason: bot unassigned in Linear) |
| `comment.created` + open question by `parentId` | `question.answered` (body read from the canonical fetch) |
| `comment.created`, no match / no parent | `ignored` |
| anything else | never produced — the router returns nothing |

## The two instruments were falsified before they were trusted

T55's lesson, applied: *a fix to the verification mechanism must itself be verified by a
probe containing a deliberately failing case.* Both were, by temporarily breaking the
codebase and re-running:

| deliberate break | result |
|---|---|
| tunnel handed a port nothing is listening on (a tunnel-before-bind reorder) | `SMOKE FAILED — HOOK-01 violated: nothing is listening on 127.0.0.1:56417 when the tunnel was asked to open` |
| the ingress→engine mapping unwired (T45 reproduced exactly) | `SMOKE FAILED — timed out after 2000ms waiting for a queued run` |

Both breaks were reverted; `tsc --noEmit` is back at exit 0 and the smoke back at exit 0.
Without these two runs the smoke would only have been proved not to crash.

## What the smoke asserts

```
ok  the tunnel opened exactly once
ok  the tunnel's TCP probe reached the bound port (HOOK-01: bind before tunnel)
ok  a validly signed delivery is accepted (got 200)
ok  the acknowledgement came back in 5ms, inside the 1000ms budget
ok  exactly one run was created (got 1)
ok  the run is for the issue the delivery named
ok  the run is queued (got queued)
ok  one run_events row was appended (got 1)
ok  the genesis run_events row records the insert at queued
ok  the router decided from a canonical issue fetch, not from the delivery body
```

`~/.linear-auto-worker/` does not exist on this machine after the run — it was never
created, let alone read or written (T-07-11). The workspace is `mkdtemp`, and the store
inside it is a real `better-sqlite3` file against the real migration, because the unit suite
runs on `InMemoryStore` and that is exactly the blind spot that let T53's three
dead statements ship green.

## Deviations from Plan

**1. [Rule 3] `sqlite-store.ts` does not satisfy the `Store` port — added `src/infra/store/domain-store.ts`.**
The store speaks `RunRow` (every timestamp `number | string`, `state` a bare `string`,
booleans as INTEGER); `ports.ts` speaks `Run` (a discriminated union). They are not
assignable and the composition root needs the domain side. A blanket cast at the boot seam
would have hidden two real defects, so the conversion is one small module instead:
- `findActiveRunByIssue` returns **many** runs, not one (see deviation 2);
- **better-sqlite3 refuses to bind a JavaScript boolean.** `updateRun(id, {cancelRequested: true})`
  is a driver-level `TypeError`, not a silently wrong write. `toRow` maps booleans to 0/1.

**2. [Rule 1] `findActiveRunByIssue` had `LIMIT 1` and returned a single row.**
The port returns an array and the engine's `run.cancelled` iterates it. Against the real
store, unassigning a ticket fanned out over three repos cancelled the newest child and left
the other two running — DELV-07's failure shape, invisible to `tsc` because the two `Store`
interfaces never met until this plan. Changed to `.all()` and its unit test updated.

**3. [Rule 2] `findQuestionByShortCode` was declared on the port, faked, and never implemented.**
The tier-2 answer-correlation fallback would have been a `TypeError` on first use — the same
shape as T46's `tryInsertDelivery`. Four lines of SQL in `sqlite-store.ts`.

**4. [Rule 3] `tsconfig` `rootDir` → `"."`, `include` → `["src", "test"]`.**
The plan mandates `test/integration/07-ingress-seam.test.ts`. 03-01 already found that a
file under a top-level `test/` is never compiled into `dist/` and therefore never runs, and
T34 shows node's type stripping cannot run it in place (it will not resolve a `.js`
specifier inside a `.ts` file). Compiling it is the only option. **Output is now
`dist/src/**` and `dist/test/**`; the gate's `dist/**/*.test.js` glob matches both** — plan
06 needs to know this and nothing else changes.

**5. [Rule 2] `KEY_ID`/`KEY_SECRET` exported from `registrar.ts`.**
The daemon reads the signing secret out of kv at boot. A second spelling of
`'webhook_secret'` is a receiver verifying against a secret nobody registered — a 400 on
every real delivery. One `export` keyword beats a duplicated string literal (T32's rule).

## Known Stubs

| Stub | Where | Why | Owner |
|---|---|---|---|
| `bootDaemon()` **throws** when `opts.linear` is absent | `src/cli/daemon.ts` | `outbound/linear-client.ts` declares its own `LinearClient` that does not satisfy the port (three unimplemented methods, a different `setIssueState` arity). Constructing it here would be doing 07-04's design work; failing loudly beats booting a daemon that cannot talk to Linear and reports healthy. This makes `law start` exit with a named owner rather than a mystery. | **07-04** |
| Worktree manager, agent runner and deliverer are `FakeWorktreeManager` / `FakeAgentRunner` / `FakeDeliverer` | `src/cli/daemon.ts` | 07-CONTEXT **D-01** makes this ordering the point of the plan. | **07-04** |
| The scheduler is paused at boot and never started | `src/cli/daemon.ts` | No run may leave `queued` and nothing may spawn a child process in this plan. | **07-05** |
| No `WebhookRegistrar` call — the tunnel URL is never registered with Linear | `src/cli/daemon.ts` | The secret is generated and persisted under the registrar's own key so `reconcile()` reuses it; the call itself is boot lifecycle. | **07-05** |
| `shutdown()` closes the tunnel, the server and the store — no drain, no child kill, no in-flight requeue | `src/cli/daemon.ts` | D-03/D-06 are explicitly 07-05's. | **07-05** |
| `test/integration/07-ingress-seam.test.ts` has never been executed | that file | Plan 06 owns the first `node --test` run; this plan was instructed not to run it. It typechecks and holds 7 cases. | **07-06** |

## Contract additions requested

None. Every port used here already existed; the only additions were an *implementation*
(`findQuestionByShortCode`) and an arity correction (`findActiveRunByIssue`) on the SQLite
side, both toward the existing port rather than away from it.

## Verification

| check | result |
|---|---|
| `npx tsc --noEmit` | exit 0 |
| `grep -cE 'TS1005\|TS1128\|TS1002\|TS1109\|TS1434'` (T54 syntax mask) | 0 |
| `npm run smoke` | exit 0, 10 assertions |
| smoke falsified against a tunnel/bind reorder | FAILS, with the HOOK-01 diagnosis |
| smoke falsified against an unwired ingress→engine mapping | FAILS, with a timeout on the queued run |
| `~/.linear-auto-worker/` after the smoke | does not exist |
| `grep -c 'test(' test/integration/07-ingress-seam.test.ts` | 7 |
| `@ts-ignore` / `@ts-expect-error` added | 0 / 0 |

## Self-Check: PASSED

- `src/cli/daemon.ts`, `src/cli/daemon-fixture.ts`, `src/infra/store/domain-store.ts`,
  `scripts/boot-smoke.ts`, `test/integration/07-ingress-seam.test.ts` — all present.
- Commits `7a52af9` (composition root + smoke) and `e8fc524` (seam cases + tsconfig) present.
- `git status --short` clean before this summary.
