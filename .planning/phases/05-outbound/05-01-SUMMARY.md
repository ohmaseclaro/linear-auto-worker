---
phase: 05-outbound
plan: 1
subsystem: outbound
tags: [linear, rate-limiting, webhooks, facade]
requires: ["@linear/sdk@93.0.1"]
provides:
  - "src/outbound/linear-client.ts — LinearClient interface + LinearClientImpl (the single Linear call site)"
  - "src/outbound/rate-limit.ts — computeBackoffMs, isRateLimitedError, extractRateLimitInfo, RateLimitedError"
affects: ["03-ingress (webhook registrar)", "05-02 (Notifier)", "06-orchestration (RunEngine)", "07-integration (wiring)"]
tech-stack:
  added: []
  patterns:
    - "One private call() wrapper every public method routes through"
    - "Explicit after/endCursor pagination — never connection.fetchNext()"
    - "Allow-listed log fields at the SDK boundary, never a raw error/response/webhook"
    - "Optional constructor sdk seam for injecting a stubbed @linear/sdk in tests"
key-files:
  created:
    - src/outbound/rate-limit.ts
    - src/outbound/rate-limit.test.ts
    - src/outbound/linear-client.ts
    - src/outbound/linear-client.test.ts
  modified: []
decisions:
  - "Workflow states are cached per team as the raw state list and selected by `type` at call time; ties broken by lowest `position`"
  - "createWebhook returns only `{ id }` — the facade never reads a signing secret back"
  - "LinearClientImpl takes an optional LogFn rather than importing a logger, since Phase 2 owns the real one"
metrics:
  duration: ~35m
  completed: 2026-09-06
status: complete
requirements: [INTK-04, OPS-03]
---

# Phase 5 Plan 1: Linear Client Facade Summary

A single rate-limit-aware `LinearClientImpl` over `@linear/sdk@93.0.1` — every Linear call
in the daemon routes through one `call()` wrapper that detects `RATELIMITED` by GraphQL
extension code, honours `X-RateLimit-Requests-Reset` (epoch ms), and logs only allow-listed
scalars.

## What Was Built

| File | Lines | Contents |
|---|---|---|
| `src/outbound/rate-limit.ts` | 117 | `RateLimitedError`, `computeBackoffMs`, `isRateLimitedError`, `extractRateLimitInfo` |
| `src/outbound/rate-limit.test.ts` | 130 | 16 behaviour tests for the above |
| `src/outbound/linear-client.ts` | 347 | `LinearClient`, `LinearIssue`, `LinearWebhookSummary`, `LinearClientImpl` |
| `src/outbound/linear-client.test.ts` | 501 | 21 tests against an injected stub SDK |

**Nine public methods, nine `this.call(` sites** — verified by grep; every `this.sdk.*`
reference in the file sits inside a `call()` closure, including the relation fetches inside
`toLinearIssue` and the `team.states()` query behind `resolveTeamStates`.

## Traps Addressed

| Trap | How |
|---|---|
| **T7** — rate limiting is HTTP 400 + `extensions.code === "RATELIMITED"`, never 429 | `isRateLimitedError` reads only `extensions.code`, across three candidate carriers (`err.errors`, `err.raw.errors`, `err.response.errors`) since the exact shape `@linear/sdk@93` throws is unverifiable here. No live branch in either file inspects a status. A test asserts `{ status: 400, statusCode: 400 }` and `{ status: 429, statusCode: 429 }` both return `false`. |
| **T8** — `@linear/sdk` majors weekly | No `package.json` on this branch; the pin belongs to Phase 1. Nothing here widens it. |
| **T9** — no `Bearer` prefix | Constructed as `new SdkLinearClient({ apiKey })`. No hand-rolled fetch, no hand-set Authorization header anywhere. |
| **T21** — `client.webhookCreate` does not exist | Uses `createWebhook` / `updateWebhook` / `deleteWebhook`. The string `webhookCreate` appears only in the comment warning against it. |
| **T22** — `fetchNext()` mutates and returns `this` | `pageAll()` re-queries with the previous page's `endCursor` and never calls `fetchNext()`. A test asserts the two-page fixture yields exactly 2 nodes, not 4. |
| **T23** — `webhooks()` pulls signing secrets into memory | `listWebhooks` projects to `LinearWebhookSummary` (id/label/url/enabled/resourceTypes) at the only place a raw `Webhook` exists. A test feeds a secret through the stub and asserts it does not appear in the returned JSON. |

Threat `T-05-02` (log leak) has its own test: on a rate-limited failure whose error carries
`request.headers.Authorization`, exactly one log line is emitted with keys
`['complexity', 'op', 'waitMs']` and the API key appears nowhere in it.

`In Progress` resolution (D-06 / INTK-04) is tested against an adversarial fixture where the
state literally *named* "In Progress" is typed `unstarted` and the wanted one is named
"Doing" — any name match picks wrong.

## Deviations from Plan

Three, all small, none architectural.

**1. `call()` takes an `op` label — `call<T>(op: string, fn: () => Promise<T>)`.** The plan
specified `call<T>(fn)`. 05-CONTEXT's specifics say the structured log *is* the UI; without
`op`, a `linear.ratelimited` line cannot say which call hit the limit. Private method, so no
contract impact.

**2. Per-team state cache holds the raw state list, not a pre-built type→state map.** The
plan said "memoize the resolved per-type map." Selection is now
`states.filter(s => s.type === stateType).sort(by position)[0]` at call time. Same
memoization property (a second call for a known team queries nothing), less code, and the
type match is visible rather than buried in map construction — which is what the plan's own
`grep -Eq "type\s*===\s*stateType"` check was reaching for. The first draft used a map and
failed that check; the refactor is the fix.

**3. Ties broken by lowest `position` (Rule 2 — missing correctness).** Not in the plan.
A stock Linear workspace has **both** "In Progress" and "In Review" typed `started`. First-
match-wins would non-deterministically park a freshly-picked-up ticket in review. The lowest
`position` state of a type is the one earliest in the workflow.

No auth gates. No architectural decisions required.

## Known Stubs

**`extractRateLimitInfo` on the success path is a deliberate best-effort no-op.**
`call()` probes each resolved SDK value for rate-limit headers and logs them if present. On
`@linear/sdk@93.0.1` this most likely finds nothing — the SDK returns model objects, not HTTP
responses. Kept soft on purpose (the plan instructed this): guessing at the SDK's per-response
header surface without being able to inspect it would produce confident dead code. The error
path *does* work, because a thrown SDK error is far more likely to carry the response. See
"Contract additions requested" item 5 for what would settle it.

## Contract additions requested

### 1. Final `LinearClient` interface (reconcile against `src/domain/ports.ts`)

```ts
export type WorkflowStateType = 'started' | 'completed' | 'canceled';

export interface LinearIssue {
  id: string; identifier: string; title: string; description: string | null;
  url: string; branchName: string; assigneeId: string | null;
  projectId: string | null; teamId: string; stateId: string; stateType: string;
}

export interface LinearWebhookSummary {
  id: string; label: string | null; url: string;
  enabled: boolean; resourceTypes: string[];
}

export interface CreateWebhookInput {
  label: string; url: string; teamId: string; secret: string; resourceTypes: string[];
}
export interface UpdateWebhookInput {
  url?: string; enabled?: boolean; resourceTypes?: string[];
}

export interface LinearClient {
  viewer(): Promise<{ id: string; name: string }>;
  getIssue(issueId: string): Promise<LinearIssue>;
  listAssignedOpenIssues(botUserId: string): Promise<LinearIssue[]>;
  setIssueState(issueId: string, teamId: string, stateType: WorkflowStateType): Promise<void>;
  createComment(issueId: string, body: string, parentId?: string): Promise<{ id: string }>;
  listWebhooks(): Promise<LinearWebhookSummary[]>;
  createWebhook(input: CreateWebhookInput): Promise<{ id: string }>;
  updateWebhook(id: string, input: UpdateWebhookInput): Promise<void>;
  deleteWebhook(id: string): Promise<void>;
}
```

### 2. Three intentional divergences from `research/ARCHITECTURE.md`'s port sketch

The sketch (ARCHITECTURE.md ~line 802) is **not** the binding contract — the ADDENDUM names
`ports.ts` but does not fix its contents. Where `ports.ts` disagrees with the above, **the
above is what the working implementation does**, and these three are the ones that will
actually break a `tsc`:

| Sketch | Implemented | Why |
|---|---|---|
| `setIssueState(id, 'started' \| 'review')` | `setIssueState(issueId, teamId, 'started' \| 'completed' \| 'canceled')` | `review` is not a Linear `WorkflowState.type`. `teamId` is required because state ids are per-team; forcing the facade to re-fetch the issue to learn its team would double every transition's cost, and the caller already holds it. |
| `createWebhook(...) → { id, secret }` | `createWebhook({..., secret}) → { id }` | Plan task 3: the facade never generates or reads back a secret. Caller supplies it (side-stepping TRAPS T-landmine-3, where Linear's docs and its schema disagree about whether `secret` is returned at all). |
| `LinearIssue` has no `teamId` | `LinearIssue.teamId: string` | The pickup path needs the team to resolve In Progress; without it every transition costs an extra issue fetch. |

### 3. `LogFn` — the facade needs a logger and Phase 2 owns it

```ts
export type LogFn = (fields: Record<string, unknown>, msg: string) => void;
```

`LinearClientImpl` takes `log?: LogFn` and defaults to a no-op rather than importing a
logger that does not exist on this branch. **Phase 7 must wire the real pino child logger in**
— otherwise every rate-limit and complexity line is silently dropped, which under 05-CONTEXT
D-04 ("the log is the UI") is a real regression, not a cosmetic one. Two log messages are
emitted: `linear.response.budget` and `linear.ratelimited`.

If `src/domain/ports.ts` defines a `Logger` port, `LogFn` should be replaced by it at
integration; the two shapes are trivially adaptable.

### 4. `sdk?: SdkLinearClient` constructor seam

`LinearClientImpl` accepts a pre-built SDK client so tests can inject a stub. Production
callers pass only `{ apiKey, log }`. If Phase 1's fakes supersede this, the seam can be
dropped — but `linear-client.test.ts` depends on it today.

### 5. What would settle `extractRateLimitInfo`'s success path

Once `node_modules` exists, one of these resolves it:

- Whether `@linear/sdk@93.0.1`'s `LinearGraphQLClient` exposes response headers on a
  successful request (inspect `dist/*.d.mts` for a `rawRequest`/`response` surface), **or**
- Whether `LinearClientOptions` accepts a custom `fetch`/middleware hook that could capture
  `x-complexity` per response out of band.

If neither exists, delete the success-path probe in `call()` and record `X-Complexity` as
unobtainable — do **not** replace it with a guess.

## Self-Check: PASSED

- `src/outbound/rate-limit.ts` — FOUND
- `src/outbound/rate-limit.test.ts` — FOUND
- `src/outbound/linear-client.ts` — FOUND
- `src/outbound/linear-client.test.ts` — FOUND
- `699ccdb` `test(05-01): add failing tests for the Linear rate-limit helpers` — FOUND
- `d81fa12` `feat(05-01): rate-limit helpers and the authenticated LinearClient facade` — FOUND
- `1ecd2e9` `feat(05-01): per-team state resolution, comment threading, boot-sweep read` — FOUND
- `0e033c0` `feat(05-01): webhook CRUD with explicit cursor pagination` — FOUND

All three task `<verify>` blocks pass. Additional sweep confirms no live-code occurrence of
`429`, `webhookCreate`, `fetchNext`, or a hand-set `Bearer`/Authorization header — every hit
is a comment or a negative-assertion test.

**Not executed, per this run's constraints:** `npm install`, `tsc`, `node --test`. No live
Linear call was made. Both test files are written for the end-of-milestone integration gate.

**STATE.md / ROADMAP.md deliberately not touched.** Eight phases are executing in parallel
worktrees; eight branches each rewriting the same progress table guarantees a conflict at
every merge. The orchestrator owns those files for this run.
