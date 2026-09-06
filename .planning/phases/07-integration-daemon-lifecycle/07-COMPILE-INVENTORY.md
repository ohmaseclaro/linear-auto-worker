# 07 — First Full-Tree Compile Inventory

**Taken:** 2026-09-06, plan 07-01 task 3, on the merged eight-branch tree
(`gsd/07-01` @ `12aec7a`, identical source to `main`).
**Command:** `npx tsc --noEmit`, TypeScript **5.9.3** (correctly *not* the TS7 `tsgo`
rewrite — T12 pin holding).
**Exit:** 2. **68 errors.** Nothing was fixed in this plan.

This is the first moment any of these six layers was checked against compiled code rather
than against the binding contract text in `01-CONTEXT.md`. Per 07-CONTEXT **D-05** these
68 are the deferred, budgeted cost of the parallel fan-out, not a regression.

## Integrity of the count

- **Matches the captured baseline exactly.** `diff` of the error lines against
  `07-BASELINE-ERRORS.txt` is empty: 68 = 68, same files, same codes, same order.
- **No syntax-error mask (T54).** `grep -cE 'TS1005|TS1128|TS1002|TS1109|TS1434'` → **0**.
  T54 is the reason this check is mandatory: one stray backtick previously aborted parsing
  and suppressed 53 downstream errors, making the count *fall* and look like progress. It
  is not happening here.
- **Every layer was actually compiled.** `tsc --listFiles` reaches all seven source
  directories — domain 10, infra 12, ingress 13, orchestration 11, execution 23, cli 16,
  outbound 11 files. A layer missing from `include` would make a low error count a lie;
  none is missing.
- **Attribution is exact:** all 68 lines classify into a named cluster; zero unclassified.

## Shape of the damage

| By layer | n | | By code | n |
|---|---|---|---|---|
| `orchestration` | **62** | | TS2339 property missing | **37** |
| `ingress` | 4 | | TS2345 arg type | 11 |
| `infra` | 1 | | TS2322 assign type | 6 |
| `domain` | 1 | | TS2538 null index | 5 |
| `execution` | **0** | | TS2353 unknown property | 4 |
| `outbound` | **0** | | other (2559/2554/2367/2352/2305) | 5 |
| `cli` | **0** | | | |

**91% of the damage is in one layer.** `execution`, `outbound` and `cli` — 50 of the 96
files — compile clean. That is not luck: `orchestration` is the layer that consumes every
port, so it is the only layer positioned to discover that the ports disagree with it.
36 of its 62 errors are in `run-engine.ts` (16), `recovery.test.ts` (13) and `recovery.ts`
(6) alone.

**32 of 68 (47%) are in `*.test.ts` files.** These are not lower priority — a test that
does not compile is a test that has never run, and 07-06 owns the first gate run.

## Triage

**25 MISSING-MEMBER** — a call site expects a port method or type member that
`src/domain/` does not declare. **Plan 07-02's input.** Each needs a decision *in the
domain*, then the call sites follow.

**24 SHAPE-DRIFT** — the member exists but its type disagrees. **Plan 07-03's input.**
Mostly the call sites, not the domain: in the largest cluster the domain is deliberately
right and the consumers assumed it away.

**19 LOCAL** — a plain mistake confined to one layer, fixable without touching the domain.
**Plan 07-03's input**, and the cheapest 19 errors on the list.

---

## MISSING-MEMBER — 25 errors, plan 07-02

### M1 · `FakeAgentRunner.calls` — 8 errors, all in `qa-roundtrip.test.ts`

The fake does not record its invocations; the Q&A round-trip test asserts on them.
`src/domain/fakes.ts` is domain-owned, so this is a contract addition, not a test fix.
**Decide:** add a `calls` array to `FakeAgentRunner` (every other fake should be checked
for the same gap while you are in the file).

`src/orchestration/qa-roundtrip.test.ts(134,22)`, `(135,22)`, `(152,22)`, `(153,22)`, `(154,22)`, `(154,48)`, `(155,22)`, `(188,22)`

### M2 · `PendingQuestion.answeredBy` — 7 errors

Four files write and read an `answeredBy` field the domain type does not have. It carries
who answered, which is the tier-1 correlation signal. **Decide:** add
`answeredBy: string | null` to `PendingQuestion`, or delete the field from all seven sites
— do not leave it half-present.

`src/orchestration/questions.ts(254,9)`, `(282,11)`, `(291,40)`, `src/orchestration/questions.test.ts(35,5)`, `(231,23)`, `src/orchestration/recovery.test.ts(130,72)`, `(454,25)`

### M3 · `LinearClient` is missing three methods — 3 errors

`updateComment`, `listComments`, `addSubscriber`. **This is hard deliverable #3's
neighbourhood** — `run-engine.ts` and `recovery.ts` need a richer Linear port than
`ports.ts` declares. **Decide:** add all three to the `LinearClient` port and to
`FakeLinearClient`.

`src/orchestration/recovery.ts(260,36)` · `listComments` — `src/orchestration/run-engine.ts(231,14)` · `updateComment` — `(252,16)` · `addSubscriber`

### M4 · `Store.listRunsByParent` — 1 error

`src/orchestration/run-engine.ts(341,28)`. The fan-out parent needs its children; no port
method returns them. **Decide:** add to `Store`, `InMemoryStore` and `sqlite-store.ts`.

### M5 · `Config.operatorUserId` — 1 error

`src/orchestration/run-engine.ts(231,48)`. Who to @-mention on a question. Not in the
`Config` shape, and **not prompted for by the wizard either** — coordinate with P8 before
adding, since a config field no wizard step writes is a field that is always undefined.

### M6 · `LinearIssue.updatedAt` — 2 errors

`src/orchestration/recovery.ts(241,18)`, `(242,17)`. Recovery wants issue mtime to decide
staleness. `RunBase` has `updatedAt`; `LinearIssue` (`ports.ts:244`) does not. **Decide:**
add it to `LinearIssue` **only if the Linear API actually returns it** on the selection the
client makes — otherwise recovery needs a different staleness signal.

### M7 · `DomainEvent` has no `run.resumed` kind — 3 errors

`src/orchestration/questions.ts(173,11)`, `src/orchestration/questions.test.ts(443,16)`, `(443,58)`

P3 confirmed all seven contracted kinds landed. `questions.ts` emits an **eighth**,
`run.resumed`, and the union does not carry it — which is why `(443,58)` reads
`'input' does not exist on type 'never'`: the narrow eliminated every arm.

**Read this cluster together with hard deliverable #1 (T45).** The union already
typechecks clean while the ingress→engine mapping is unwired; adding an eighth kind
without wiring the mapping widens the same silent hole. Settle the mapping table from
`01-02-SUMMARY.md` and this kind in one decision.

---

## SHAPE-DRIFT — 24 errors, plan 07-03

### S1 · `Run.state` is `RunState | null` — 11 errors — **the single largest cluster**

`Run = RepoRun | TicketRun`, and `TicketRun.state` is **`null` by design**: 07-CONTEXT
D-04 says a ticket-kind run's status is *derived* from its children by
`deriveParentState`, never read from a column, and there is deliberately no column to read.
That invariant is what stops a parent and child disagreeing — the exact bug that would let
one repo's failure discard another repo's already-shipped PR (DELV-07).

`run-engine.ts`, `recovery.ts` and `scheduler.ts` all read `run.state` as if it were
always `RunState`. Five of the eleven are TS2538 `null cannot be used as an index type` —
a `null` reaching a state-table lookup.

> **The domain is right here. Do not widen `RunState` and do not give `TicketRun` a
> state column to make these go away** — that deletes D-04's guarantee and buys a silent
> data bug in exchange for eleven green lines. Fix is at the call sites: narrow on
> `run.kind === 'repo'`, or route parents through `deriveParentState`.

`src/orchestration/run-engine.ts(98,24)`, `(98,73)`, `(106,5)`, `(303,34)`, `(377,33)`, `(397,34)`, `(416,9)`, `src/orchestration/recovery.ts(148,32)`, `(149,21)`, `src/orchestration/recovery.test.ts(101,31)`, `src/orchestration/scheduler.ts(104,45)`

### S2 · `QuestionsDeps.linear` is never passed — 3 errors

`QuestionsDeps` (`questions.ts:118`) requires `linear: LinearClient`; all three callers
pass `{store, engine, config, log}`.

**This is hard deliverable #3, and it is the good news of this compile.** T43 flagged the
unwired `QuestionsDeps.linear` as a *silent* failure — `openQuestion` never posts the
question comment, tier-1 answer correlation dies, and the tier-2 fallback masks it on
every single-question ticket. It turns out to be a hard type error, so it cannot be
shipped unwired. Fixing S2 discharges deliverable #3.

`src/orchestration/fanout.test.ts(469,31)`, `src/orchestration/qa-roundtrip.test.ts(103,31)`, `src/orchestration/run-engine.test.ts(194,31)`

### S3 · `prUrl` / `failureReason` live on `RepoRun`, not on `Run` — 8 errors

Same union split as S1: both fields are declared on `RepoRun` (`types.ts:91`, `:92`) and
`TicketRun` has neither, so neither is reachable through `Run`. Same resolution — narrow on
`kind`, do not flatten the union.

`src/orchestration/run-engine.ts(275,26)`, `(307,37)`, `(323,13)`, `src/orchestration/fanout.ts(178,5)`, `src/orchestration/fanout.test.ts(606,29)`, `src/orchestration/recovery.test.ts(293,24)`, `(294,24)`, `(296,27)`

### S4 · `tryInsertDelivery` called with 1 argument, declared with 2 — 1 error

`src/ingress/receiver.ts(201,16)`. **This is P2 / T46, and it is the highest-severity
single error in the inventory** — the only one whose *runtime* consequence is worse than
its compile message.

`ports.ts:83` declares `tryInsertDelivery(deliveryId, receivedAt)`; `sqlite-store.ts:260`
implements **`recordDelivery`**. The real store has no `tryInsertDelivery` at all, so
against the production store this is a **runtime `TypeError`, not a type error** — the
webhook dedupe path dies on the first delivery. It has stayed invisible because
`fakes.ts:155` carries `tryInsertDelivery` as an **alias** to `recordDelivery`, so every
test passes.

`tsc` caught only the arity. **Fix:** settle on `recordDelivery` (T46), rename in
`ports.ts` and `receiver.ts`, fix the arity, and **delete the alias from `fakes.ts:155`** —
while it exists it will re-mask this the moment someone reintroduces the old name.

### S5 · `logDir` read off `Config` — 1 error

`src/orchestration/run-engine.ts(270,22)`. `logDir` exists on **`ConfigPaths`**
(`types.ts:264`), not on `Config`. Right name, wrong object. **Fix:** thread `ConfigPaths`
to the call site; do not duplicate the field onto `Config`.

---

## LOCAL — 19 errors, plan 07-03

### L1 · `kvPut` → `kvSet` — 10 errors — hard deliverable #6, mechanical

The store implements `kvSet`; three files call `kvPut`. `ports.ts:88` already carries the
comment *"`kvSet`, not `kvPut` — this is the pair `src/infra/store/sqlite-store.ts`
implements."* Pure rename, no decision.

`src/ingress/registrar.ts(51,9)`, `(52,9)`, `src/orchestration/recovery.ts(292,11)`, `src/orchestration/recovery.test.ts(389,11)`, `(400,11)`, `(433,11)`, `(461,11)`, `(483,11)`, `(505,11)`, `(521,11)`

### L2 · Phase 2's renamed toggles — 1 error (but 4 fields)

`src/infra/config.ts(69,10)` TS2352. The zod-parsed object is cast to `Config` and the two
types "do not sufficiently overlap". Reading the reported shape against
`MappingToggles` (`types.ts:180`) gives the diff:

| `config.ts` parses | `MappingToggles` declares |
|---|---|
| `slackNotify` | `notifySlack` |
| `questionFlowEnabled` | `questionsEnabled` |
| `maxRunTimeMs` | `maxRunMs` |
| `postLinearComments` | `postLinearComments` ✓ |

**One error line, three renames** — and note the `as Config` cast, which is what
compressed a four-field mismatch into a single diagnostic. This is hard deliverable #5's
R-item set. **Fix the zod schema to the domain names and drop the cast**; while the cast
survives, the next drift is silent.

### L3 · question status `'expired'` → `'timed_out'` — 2 errors

`src/orchestration/questions.test.ts(109,41)`, `(280,34)`. Domain enum is
`'open' | 'answered' | 'timed_out' | 'cancelled'`. Rename in the tests.

### L4 · toggles read off the wrong object — 2 errors

- `src/orchestration/questions.ts(228,19)` — `MappingToggles.questionFlow` → `questionsEnabled`.
- `src/orchestration/scheduler.ts(51,36)` — `MappingToggles.concurrency` → **`Config.concurrency`**.
  This is hard deliverable #5's named R-item. `types.ts:229` is explicit: *"Global cap on
  simultaneous spawned Claude sessions. Default 3. **Never per-mapping.**"* Read it from
  `Config`; do not add it to `MappingToggles`.

### L5 · wrong import path — 1 error

`src/domain/fakes.test.ts(28,37)` imports `LinearIssue` from `./types.js`; it is exported
from `./ports.ts` (and re-exported by `./index.ts:34`). Change the import.

### L6 · `fanout.ts` reinvented `TicketRun` — 1 error

`src/orchestration/run-engine.ts(121,40)`: `ParentRun` is not assignable to `Run`.
`fanout.ts:62` defines `export type ParentRun = Omit<Run, 'state'> & { readonly state: null }`.
`Omit` over a union collapses to the keys **common to both arms**, so `ParentRun` loses
`prUrl`/`failureReason` (that is the other half of S3's `fanout.ts(178,5)`) and is not a
`Run`. **`TicketRun` already is exactly this type.** Delete `ParentRun`, use `TicketRun`;
this one deletion clears both errors.

### L7 · unchecked null — 1 error

`src/ingress/registrar.ts(99,25)`: `string | null | undefined` into a `string` parameter.
Add the guard. Adjacent to **P9** (`reconcile()` returns `{id, secret, url}` while the
`WebhookRegistrar` port declares `{webhookId, secret}`) — worth fixing in the same pass.

### L8 · wrong argument shape to `resolveToggles` — 1 error

`src/orchestration/questions.ts(195,54)`: passes `{repos?: ...}` where
`Pick<ProjectMapping, 'overrides'>` is wanted. Pass the mapping, not its repos.

---

## Two things this compile did NOT catch — do not read 68→0 as done

1. **`sqlite-store.ts` vs `001-init.ts` column drift (T53, deliverable #9).** Four
   divergences. `tsc` **structurally cannot** see them — TypeScript does not know SQL
   column names. A green typecheck proves nothing here; only a real store round-trip does.
   Plan 07-06's gate must execute one.
2. **The ingress→engine `DomainEvent` mapping (T45, deliverable #1).** P3 confirmed the
   union carries all seven kinds, which is precisely why the mismatch **compiles clean**:
   ingress emits `issue.assigned`/`issue.unassigned`/`comment.created`, the engine switches
   on `run.requested`/`question.answered`/`run.cancelled`/`ignored`. Unwired, the daemon
   boots, verifies green, and **processes nothing.** The five-case mapping table is in
   `01-02-SUMMARY.md`. Highest-risk item in the milestone, and zero of these 68 errors
   point at it.

Also invisible to `tsc` and still owed: deliverable #2 (`noteSelfWrite` at the
`setIssueState` call site, T49), #4 (`LinearClient.log` defaults to a no-op, so every
`linear.ratelimited` line is dropped), #7 (`maxQuestionRounds` unbounded, T44), P5
(`onProgress` unthreaded), P6 (`timedOut` unthreaded, T61), P7 (`findOpenPrUrl` text parse,
T60), P10 (`runSetupWizard` wiring), and the T58/T64 `AgentResult` schema contest — which
does **not** appear here only because nothing imports the losing side yet.

## Hand-off

| Plan | Takes | Errors |
|---|---|---|
| **07-02** | MISSING-MEMBER M1–M7 — decide each in `src/domain/`, then follow the call sites | **25** |
| **07-03** | SHAPE-DRIFT S1–S5 and LOCAL L1–L8 | **43** |

Start 07-03 with **S4** (the only runtime `TypeError` in the set) and **L1/L6** (10 + 2
errors for two mechanical renames and one deletion). Leave **S1/S3** — 19 errors, one
narrowing discipline, one decision — for last, and resist the temptation to flatten the
union.
