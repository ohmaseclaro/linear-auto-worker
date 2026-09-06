# 07 — Contract Reconciliation Ledger

**Written:** 2026-09-06, plan 07-02.
**Input:** every `Contract additions requested` section across phases 1–8 (`grep -rl` returns
26 SUMMARY files), plus the MISSING-MEMBER clusters M1–M7 in `07-COMPILE-INVENTORY.md`.
**Rule applied:** ADD when the need is real and nothing covers it · MAP when an existing
member already covers it under another name · REJECT when it un-decides something
`01-CONTEXT.md` locked one-way.

Deduplication mattered: **six of the requests below are the same two operations under
different names** (`kvPut`/`kvSet`, `tryInsertDelivery`/`recordDelivery`,
`listRunsByParent`/`childRuns`). Merging them centrally is the whole reason this happens in
one place rather than six.

---

## Dispositions

| # | Requested by | Request | Disposition | Reasoning |
|---|---|---|---|---|
| R1 | 06-03 | `PendingQuestion.answeredBy: string \| null` | **ADD** | Written by `questions.ts` in three places and read by two test files. It is the only durable record of *who* changed a run's course mid-flight, so it landed as a field **and** as a `questions.answered_by` column — a domain field with no column is a value that silently vanishes on write. |
| R2 | 06-02 | `LinearClient.updateComment(commentId, body)` | **ADD** | D-10/INTK-06: the queue-position comment is edited, never re-posted. Real call site at `run-engine.ts:252`. |
| R3 | 06-02 | `LinearClient.addSubscriber(issueId, userId)` | **ADD** | INTK-03. Real call site at `run-engine.ts:231`. |
| R4 | 06-04 | `LinearClient.listComments(issueId, since?)` + `LinearComment` | **ADD** | D-05's comment half; the reconciliation poll cannot recover a missed answer without it. Real call site at `recovery.ts:260`. |
| R5 | 06-04 | `LinearIssue.updatedAt: string` (ISO 8601) | **ADD** | Verified available before adding: `Issue.updatedAt` is a `Date` on `@linear/sdk` 93.0.1 (compile-probed against the installed `.d.mts`). Projected in `src/outbound/linear-client.ts` in the same edit, so the port is not ahead of the implementation. Without it the poll re-enqueues every assigned issue every five minutes. |
| R6 | 06-02 | `Config.operatorUserId: string` | **ADD, optional** | The need is real (INTK-03), the *source* is not: the daemon authenticates as the BOT, so the wizard's `viewer()` returns the bot, not the operator (`src/cli/wizard/index.ts:154`). Landed as `operatorUserId?`, and `acknowledge()` **skips the subscribe with a warn** rather than sending `undefined`. Closing it needs a wizard prompt — 07-CONTEXT **P8**, still open. |
| R7 | 06-03 | `DomainEvent` kind `run.resumed` | **ADD, with the mapping** | See "The M7 decision" below. Added *and handled* in `run-engine.ts`; declaring the kind without wiring it is precisely T45's hole. |
| R8 | 06-01, 06-04 | `Store.listRunsByParent(parentRunId)` | **MAP → `childRuns`** | `ports.ts:62` and `sqlite-store.ts:218` both already carry `childRuns(parentId)` with identical semantics (every child, terminal ones included). Call site fixed at `run-engine.ts:341`. A second name for one query is the drift this ledger exists to remove. |
| R9 | 03-02, 03-05, 06-04 | `Store.kvPut(k, v)` | **MAP → `kvSet`** | `sqlite-store.ts` implements `kvSet`; `ports.ts:88` already carried the note. Ten call sites renamed (T46, hard deliverable #6). |
| R10 | 03-05 | `Store.tryInsertDelivery(deliveryId)` | **MAP → `recordDelivery(id, receivedAt)`** | T46/P2. The real store never had `tryInsertDelivery`; the fake carried it as an alias, which is why a **runtime `TypeError` on the first webhook** compiled clean for six phases. Port renamed, `receiver.ts:201` fixed to two arguments, and **the alias deleted from `fakes.ts`** — while it existed it would re-mask this the moment anyone reintroduced the old name. |
| R11 | 04-01, 04-03, 04-05 | Pick one `AgentResult` shape (T58) | **MAP → the domain's** | There was never a second schema to delete: `src/execution/agent-args.ts:66` re-exports `AgentResultSchema` and defines nothing. `status` stays `complete \| needs_input \| failed` (04-03 already settled it; `verdict.ts` derives `delivered` from commit evidence, never from the agent's word). The stale CONTESTED comments in `agent-args.ts` and `verdict.ts` are gone. |
| R12 | 04-03 | Rename `assumptionIfUnanswered` → `assumption` (T64) | **ADD (rename)** | `verdict.ts:95` reads `structured.assumption` while the schema said `assumptionIfUnanswered`, and `additionalProperties: false` forbids anything not listed — so the agent **physically could not return its assumption** and every `needs_input` failed validation. Renamed in the schema, the type, the parser and all 17 call sites. The name-bridging in `validateNeedsInput` is deleted; only its summary default survives, for a documented and different reason. |
| R13 | 06-03 | `MappingToggles.questionFlow` | **MAP → `questionsEnabled`** | 06-03 said "rename at the gate if Phase 1 chose differently"; it did (`types.ts:185`). One call site, `questions.ts:228`. |
| R14 | 06-01, 06-02 | `Config.defaults.concurrency` | **MAP → `Config.concurrency`** | `types.ts:229` is explicit: *"Never per-mapping."* The cap bounds local RAM across every run on the machine. One call site, `scheduler.ts:51`. |
| R15 | 06-02 | `Config.logDir: string` | **MAP → domain `LOG_DIR`** | `logDir` lives on `ConfigPaths` (`types.ts:264`), not on `Config` — right name, wrong object. Rather than duplicate the field or thread a whole `ConfigPaths` for one comment string, `types.ts` exports `LOG_DIR` from the same `DEFAULT_PATHS` object as `CONFIG_ROOT`/`DB_PATH`. Same single derivation (T40), one line. |
| R16 | 06-02 | `PendingQuestion.status` including `'expired'` | **MAP → `'timed_out'`** | The four literals are in the SQL `CHECK` constraint. Four call sites renamed. |
| R17 | 06-05 | `Store.findActiveRunByIssue` must exclude the parent | **already satisfied** | The parent's `state` is `null`, so `listByState`/`findActiveRunByIssue` cannot match it. `run-engine.ts` also filters `kind !== 'ticket'` defensively, and `recovery.ts` and `scheduler.ts` now do too. |
| R18 | 06-05 | `Run.state` must be nullable | **already satisfied** | Landed as the union split `RepoRun \| TicketRun`, which is stronger than a nullable column: a parent has no `state` *field* to misread. `fanout.ts`'s local `ParentRun` is deleted in favour of `TicketRun` (see below). |
| R19 | 02-01, 02-02 | Timestamp columns should be INTEGER | **already satisfied** | `001-init.ts` declares every timestamp `INTEGER` with the T47 rationale written above it. |
| R20 | 08-05 | `src/domain/fakes.ts` missing | **already satisfied** | It exists, with all 14 behavioural ports faked (07-CONTEXT P4). |
| R21 | 08-02 | `CONFIG_ROOT`/`CONFIG_PATH`/`ENV_PATH`/`DB_PATH` | **already satisfied** | Landed in `types.ts:300-303`. `DB_PATH` is `store.db`, not 08-02's guessed `runs.db`. |
| R22 | 04-01 | `Logger` must be one type across layers | **already satisfied** | `src/infra/logger.ts`'s interface is structurally identical to `ports.ts`'s `Logger`; both compile at every boundary with no cast. Left as two structurally-compatible declarations rather than forcing `src/infra/` to import the domain — no error, no drift risk that tsc cannot see. |
| R23 | 04-01, 04-04 | `AgentEnvironmentError extends LawError` | **REJECT (as unnecessary)** | Nothing catches it by class. `event-router.ts` throws `new LawError('AGENT_ENV', …)` and every consumer branches on the code. A tenth error class with one thrower and zero catchers is surface for its own sake. Re-request it the moment something catches it. |
| R24 | 06-04 | Expose `RunEngine.fail` / `announceTerminal` | **REJECT, deferred to 07-05** | The need is real — a run failed by the boot sweep currently posts nothing on the ticket — but it is a *lifecycle* decision about the boot sweep, and 07-05 owns boot. Widening the engine's public surface here, ahead of the caller that needs it, is the wrong order. **Recorded so 07-05 does not rediscover it.** |
| R25 | 08-05 | `ProjectMapping.displayName?`, `MappingKey.teamId?`, `RepoMapping.remoteName` | **REJECT** | Cosmetic or unconsumed. `displayName` is for one wizard review prompt that already labels by id; `remoteName` has no reader at all. Adding config fields nothing reads is how a config file grows a shape its loader has to keep validating. |
| R26 | 06-02 | Move `ack:` / `cancel:` / `terminal:` from kv to `runs` columns | **REJECT (keep kv)** | 06-02 proposed kv and offered columns as an alternative. kv costs no migration and the three keys are restart-safe and idempotent. Not a contract change. |

### Three rejections that were pre-decided and did not have to be applied

No request asked for any of them, which is worth recording:

- Nothing asked to give the `Store` knowledge of the state machine. The store stayed a dumb
  typed repository and `run-engine.ts`'s `transition()` is still the only writer of
  `runs.state`.
- Nothing asked for a stored status column on a parent run row. R18 asked for the opposite.
- Nothing asked for a tenth run state or a rename of the nine.

---

## The M7 decision: `run.resumed` **and** the ingress→engine mapping, together

T67 and hard deliverable #1 are one decision, and settling only the first would have widened
the hole. What landed:

1. `run.resumed` is in the union, **and handled** — `run-engine.ts` routes it through the
   same resume path as an answer, with a null question id. QA-07's disabled-question-flow
   branch has no question row by construction, so it cannot key off `question.answered`.
2. The union is **split**. `EventRouter.route` returns `IngressEvent | null`;
   `RunEngine.handle` takes `EngineEvent`. They are not assignable to one another, so
   `engine.handle(await router.route(d))` — the daemon that boots green and processes
   nothing — **is now a compile error at the composition root**. The five-case mapping table
   is written on the `DomainEvent` doc comment in `ports.ts`.

`null` rather than an eighth ingress kind for "nothing to do": `ignored` is an *engine*
vocabulary word, and ingress reports what Linear did, not what the daemon should do.

**07-03 still owns writing the mapping.** What changed is that it can no longer be skipped
silently — which is the only half of T45 a contract can own.

---

## What this ledger did NOT do

- **`src/outbound/linear-client.ts` declares its own `LinearClient` and `LinearIssue`, and
  they do not match the port.** Five differences are now listed at that interface. Four are
  design decisions 07-04 owns (the `setIssueState` state mapping, the `createWebhook` secret
  — where the *facade* is right and the *port* is wrong, landmine #3 — the nullable
  `teamId`, and the duplicate `LinearIssue`). Passing `LinearClientImpl` where the port is
  expected does not compile, so 07-04 meets this at the seam that has to decide it. Only
  `updatedAt` (R5) was projected here, because R5 created that need.
- **`registrar.ts` bypasses the port entirely**, talking to the raw `@linear/sdk` client.
  The port's four webhook-CRUD methods therefore have zero consumers. 07-05 owns the boot
  wiring; noted so it is a decision rather than a discovery.
- The T53 `sqlite-store.ts` ↔ `001-init.ts` column drift. `tsc` structurally cannot see it
  and this plan did not go looking; 07-06's gate must execute a real store round-trip.
