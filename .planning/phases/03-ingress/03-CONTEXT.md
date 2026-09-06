# Phase 3: Ingress - Context

**Gathered:** 2026-09-06
**Status:** Ready for planning

<domain>
## Phase Boundary

A Linear delivery reaches the system safely, exactly once, and never as an echo of the
bot's own writes. Tunnel, webhook reconciliation, signature verification, dedupe,
four-layer loop prevention, event routing.

Out of scope: anything the router hands off to. Ingress ends at "a normalised DomainEvent
was produced".
</domain>

<decisions>
## Implementation Decisions

### Tunnel and registration

- **D-01:** Keep the **ephemeral random ngrok domain**, reaffirmed by the operator against
  the research recommendation. The webhook URL is therefore reconciled on every boot.
- **D-02:** The reconciliation must include an explicit **re-enable path**, not just a URL
  update. Linear auto-disables a webhook after repeated delivery failures, and an
  ephemeral URL guarantees failures on every restart — so the disabled case is the normal
  case here, not an edge case. Paginate `webhooks()`; reconcile, never create blindly.
- **D-03:** Webhook signing secret is generated locally
  (`crypto.randomBytes(32).toString('hex')`), persisted to SQLite **before**
  `webhookCreate`, and passed as `WebhookCreateInput.secret`. Never read back from the
  API — Linear's docs and its shipped schema contradict each other on whether creation
  returns it, and this approach is correct under either reading.

### Missed-work recovery (the reason ephemeral is safe)

- **D-04:** Reconciliation poll runs **at boot and every 5 minutes**, querying bot-assigned
  issues with `updatedAt >` a last-seen watermark held in the `kv` table. This is what
  makes a lost delivery a latency problem rather than a correctness problem, because the
  router never decides from `payload.data` — it re-fetches and decides from fresh state,
  so the poll reconstructs exactly the decision the lost webhook would have produced.
- **D-05:** An issue-level diff does **not** recover a threaded answer to an open question,
  because that is a comment rather than an issue field. Boot recovery must additionally
  list comments since the watermark on issues holding an open question. Without this a run
  sits in `awaiting_answer` until its deadline despite the operator having already
  answered. *(This obligation is shared with Phase 6 — see 06-CONTEXT D-06.)*

### Loop prevention (four independent guards)

- **D-06:** All four layers ship, and they are independent: actor identity, an invisible
  comment marker, a short self-write suppression window, and delivery-ID uniqueness.
- **D-07:** The marker-prefix constant lives in **one shared module** imported by both
  ingress and outbound. It cannot be duplicated across two phases built in parallel.
- **D-08:** A **null actor is treated as untrusted and dropped** — a null actor is not
  evidence an event came from a human. Safe because the reconciliation poll (D-04) picks
  up any real work dropped this way, making the failure mode a short delay rather than an
  API-budget-consuming loop.
- **D-09:** The dropped-self-event counter is accompanied by a log line **naming which
  guard fired**. Success criterion 4 wants an unwired filter to be visible; naming the
  guard additionally reveals whether the other three are dead code you only believe is
  protecting you.

### Verification

- **D-10:** Invalid signature returns **400**, not 401 (verified). Four signature tests
  are required: valid, tampered, stale timestamp, and **non-ASCII body** — the
  ASCII-only test passes while real tickets containing emoji fail.
- **D-11 (AMENDED 2026-09-06, post-research):** No HTTP framework — a plain `node:http`
  listener calling **`client.parseData()`**, which verifies the HMAC *before* parsing.
  The original wording named `LinearWebhookClient.createHandler()`; measurement showed it
  `JSON.parse`s unverified bytes before HMAC-ing (the inverse of this decision's own
  rationale), awaits handlers before sending 200 (1205 ms measured for a 1200 ms handler,
  blowing the sub-5s ACK budget), discards the `Linear-Delivery` header so dedupe is
  unreachable, and collapses stale/tampered/malformed into one identical 400 — defeating
  HOOK-05, HOOK-06, HOOK-08, D-09 and D-10. `parseData()` on plain `node:http` upholds
  both properties this lock exists to protect, verified at 200-in-3ms with work deferred.
- **D-12 (NEW):** Ownership of the D-04 reconciliation poll, which three documents assign
  to three different owners: **Phase 3 owns the query, Phase 6 owns the timer.** This
  matters because D-08's null-actor drop is only safe *because* the poll exists — an
  unowned poll makes a locked decision unsound.
- **D-13 (NEW):** `src/shared/markers.ts` (the D-07 marker constant) is **owned by
  Phase 3**. Phase 5 imports it and must not create its own copy.
- **D-11 (original wording, superseded):** No HTTP framework. `LinearWebhookClient.createHandler()` from
  `@linear/sdk/webhooks` is itself a `node:http` request listener that consumes the raw
  body and HMACs it before any JSON parsing. Express/Fastify/Hono each reintroduce the
  raw-body problem that otherwise does not exist here.

### Needs verification during planning
- Whether `@ngrok/ngrok`'s in-process SDK exposes domain control equivalent to the CLI's
  `--url` (flagged in research; relevant even for ephemeral, to confirm behavior).
- `webhookTimestamp` units — milliseconds vs seconds — is unconfirmed.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Binding contract (read first)
- `.planning/phases/01-domain-contract-state-machine-schema/01-CONTEXT.md` — **binding**.
  Its ADDENDUM fixes the exact state literals, table names, config shape and module paths.
  All eight phases were fanned out simultaneously under rush mode, so this text — not the
  code, which may not exist on your branch yet — is the contract. Import from
  `src/domain/`; do not define your own copy of anything it names. If you need a port
  method that does not exist, record it in your SUMMARY under `Contract additions
  requested` rather than editing `src/domain/`.
- `.planning/TRAPS.md` — running ledger of verified footguns. Read every row.

### Project
- `.planning/PROJECT.md` — Key Decisions table and Constraints
- `.planning/REQUIREMENTS.md` — this phase's mapped requirement IDs
- `.planning/ROADMAP.md` — this phase's goal and success criteria

### Research
- `.planning/research/SUMMARY.md` — § Corrections to PROJECT.md, § Non-Negotiable
  Invariants, § Build Order Constraints
- `.planning/research/PITFALLS.md` — the failure modes this phase must avoid
- `.planning/research/STACK.md` — pinned versions and library idioms
- `.planning/research/ARCHITECTURE.md` — five-layer decomposition

</canonical_refs>

<code_context>
## Existing Code Insights

Greenfield. All eight phases are being built simultaneously in isolated worktrees under
rush mode, so no sibling phase's code is on your branch and none of it can be imported.
Build against the binding contract text in `01-CONTEXT.md` and against the in-memory
fakes it specifies. Do not attempt to read or import another phase's files.

</code_context>

<specifics>
## Specific Ideas

Sub-5-second ACK is a hard requirement; research targets sub-200 ms. ACK first, then
process — never process inside the request handler.

</specifics>

<deferred>
## Deferred Ideas

- **Pinning ngrok's free static domain.** Would delete the reconcile-every-boot path, the
  re-enable path, and the URL-changed handling — strictly less code. Rejected by explicit
  operator preference; revisit only if the operator raises it.

</deferred>

---

*Phase: 3-Ingress*
*Context gathered: 2026-09-06*
