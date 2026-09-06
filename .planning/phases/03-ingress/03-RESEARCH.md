# Phase 3: Ingress - Research

**Researched:** 2026-09-06
**Domain:** Linear webhook ingress — ngrok tunnel, webhook reconciliation, HMAC verification, dedupe, four-layer loop prevention, event routing
**Confidence:** HIGH — every load-bearing claim below was verified by installing `@linear/sdk@93.0.1` and `@ngrok/ngrok@1.7.0` in a scratch directory and either reading the published `.d.ts`/runtime source or running a live `node:http` server against it. Nothing here is recalled.

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Tunnel and registration**

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

**Missed-work recovery (the reason ephemeral is safe)**

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

**Loop prevention (four independent guards)**

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

**Verification**

- **D-10:** Invalid signature returns **400**, not 401 (verified). Four signature tests
  are required: valid, tampered, stale timestamp, and **non-ASCII body** — the
  ASCII-only test passes while real tickets containing emoji fail.
- **D-11:** No HTTP framework. `LinearWebhookClient.createHandler()` from
  `@linear/sdk/webhooks` is itself a `node:http` request listener that consumes the raw
  body and HMACs it before any JSON parsing. Express/Fastify/Hono each reintroduce the
  raw-body problem that otherwise does not exist here.

### Claude's Discretion

*(CONTEXT.md declares no explicit discretion section for this phase. The two items under
"Needs verification during planning" are resolved in § Resolved Unknowns below.)*

### Deferred Ideas (OUT OF SCOPE)

- **Pinning ngrok's free static domain.** Would delete the reconcile-every-boot path, the
  re-enable path, and the URL-changed handling — strictly less code. Rejected by explicit
  operator preference; revisit only if the operator raises it.

### Phase Boundary

Ingress ends at "a normalised DomainEvent was produced". Anything the router hands off to
is out of scope.
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| TUN-01 | Exactly one ngrok tunnel per process at boot via in-process SDK, public URL exposed | `ngrok.connect({addr, authtoken_from_env:true})` → `Listener`; `listener.url(): string \| null`. Singleton assertable via `ngrok.listeners()`. § Resolved Unknown 1 |
| TUN-02 | Tunnel lifetime bound to the worker process — no orphan after shutdown, crash, restart | Native session dies with the process; `listener.close()` / `ngrok.disconnect(url)` / `ngrok.kill()` for graceful paths. § Pattern 1 |
| TUN-03 | Refuse to start with a clear message when authtoken is missing, invalid, or rejected | Verified error surface: `ERR_NGROK_4018` (unauthenticated) / `ERR_NGROK_105` (malformed). **All ngrok errors share `err.code === "GenericFailure"`** — must match on the message. § Pitfall 6 |
| HOOK-02 | Reconcile at every boot by updating the existing registration's URL, never creating a duplicate | `client.updateWebhook(id, {url, enabled:true})` — one call does URL + re-enable. § Pattern 2 |
| HOOK-03 | Secret generated locally and persisted before registration, supplied to Linear, never read back | `WebhookCreateInput.secret` and `.id` both confirmed present. § Resolved Unknown 3 |
| HOOK-04 | HMAC verified against the raw body before any JSON parsing; invalid rejected without side effects | `client.parseData()` verifies **then** parses. **`createHandler()` does the reverse.** § Finding A |
| HOOK-05 | Deliveries outside the staleness window rejected, preventing replay storms | `webhookTimestamp` is **milliseconds**; SDK enforces ±60 s but **silently skips the check when the field is absent**. § Resolved Unknown 2, § Pitfall 2 |
| HOOK-06 | Duplicate deliveries dropped idempotently via a uniqueness constraint on delivery ID | **The `Linear-Delivery` header is unreachable from `handler.on()`.** § Finding A |
| HOOK-07 | Bot-authored events dropped through four independent layers; null actor treated as untrusted | `payload.actor` is a **4-member union**, all with `id` + `type`. § Pattern 4 |
| HOOK-08 | 200 acknowledged inside the delivery timeout; all real work asynchronous | **`createHandler()` awaits every registered handler before sending 200** — measured 1205 ms for a 1200 ms handler. § Finding A |
| HOOK-09 | Webhooks registered against no-longer-live tunnel URLs are pruned | Paginate + client-side filter; no server-side webhook filter exists. § Pattern 2, § Pitfall 1 |
| INTK-01 | An issue assigned to the bot creates a run record | Edge-detect on `updatedFrom`, then re-fetch. § Pattern 5 |
| INTK-05 | No decision from the webhook payload — re-fetch the issue before acting | § Pattern 5 |
</phase_requirements>

---

## Summary

Three unknowns were flagged for this phase. All three are now closed by direct evidence, and two of them resolved in a way that changes what the plan must contain.

`webhookTimestamp` is **milliseconds** — proven twice over, by the shipped schema's own doc comment ("Unix timestamp in milliseconds when the webhook was sent") and by a live server that accepts a millisecond value and 400s a second-precision one. The staleness check is **already implemented inside the SDK** at ±60 seconds, so HOOK-05 must not be hand-rolled. But the SDK's check is guarded by `if (timestamp)`, which means an absent `webhookTimestamp` field silently skips replay protection entirely — precisely the always-pass failure mode SUMMARY.md warned about. The phase must assert the field's presence itself.

`@ngrok/ngrok` **does** expose `Config.domain`, so the deferred static-domain option remains technically available; the ephemeral path is simply omitting it and reading `listener.url()`, which returns `string | null`. That nullability is the trap — an unchecked `url()` registers the literal string `"null"` as a webhook URL and the daemon looks healthy while receiving nothing.

The webhook-secret contradiction is resolved and D-03 is vindicated: `WebhookCreateInput.secret` and `WebhookCreateInput.id` both exist, so client-supplied idempotent registration works. The SDK's `fragment Webhook` *does* select `secret`, but the field's type is `string | null | undefined` — nullable — so neither reading of the docs can be relied on. Generating locally is correct under both. One consequence nobody has flagged: because the fragment selects `secret`, **every `webhooks()` call pulls signing secrets into memory**, so a `Webhook` object must never reach a log line unredacted.

Beyond the three assigned unknowns, the investigation surfaced a structural problem the plan has to resolve before it can be written. **`LinearWebhookClient.createHandler()` cannot satisfy four of this phase's requirements.** It discards request headers before invoking your callback, so the `Linear-Delivery` header needed for HOOK-06 is unreachable; it awaits every registered handler before sending 200, so HOOK-08's ACK-first rule is unachievable; it collapses stale-timestamp and bad-signature into an identical `400 "Invalid webhook"`, so D-09's "name which guard fired" is impossible; and it `JSON.parse`es unverified bytes *before* HMAC-ing, which is the opposite of what D-11's own rationale states. The fix is small and keeps every constraint D-11 actually protects — a plain `node:http` listener calling `client.parseData()`, which verifies first and then parses. This needs the operator's confirmation because D-11 names `createHandler()` explicitly.

**Primary recommendation:** Build the receiver as a plain `node:http` request listener that reads the raw body itself and calls `LinearWebhookClient.parseData()` for verification — no framework, no hand-rolled crypto, full access to headers, response timing, and failure discrimination. Reconcile webhooks with a single `updateWebhook(id, {url, enabled: true})`, and accumulate pagination with `while (page.pageInfo.hasNextPage) await page.fetchNext()` — never by pushing `page.nodes` each iteration.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Tunnel open/close, URL discovery | Process/native (ngrok session) | — | Lifetime must be bound to the OS process; that binding *is* TUN-02 |
| HTTP listen + raw body read | `node:http` server | — | Owns the socket, the headers, and when the 200 is written — all three are requirements here |
| HMAC verification | `@linear/sdk` (`parseData`) | — | Timing-safe compare, never hand-rolled (V6) |
| Staleness / replay window | Ingress (application) | SDK (partial) | SDK covers ±60 s but skips silently when the field is absent; application must assert presence |
| Delivery-ID dedupe | SQLite `deliveries` table (`UNIQUE`) | — | Must survive restart; an in-memory Set does not |
| Loop guards L1/L2 (actor, marker) | Ingress (application) | — | Pure functions of the verified payload |
| Loop guard L3 (suppression window) | In-process memory | — | Single process by design; a hint only, never correctness |
| Loop guard L4 (delivery uniqueness) | SQLite | — | Same row as dedupe |
| Webhook registration reconcile | Linear API (`createWebhook`/`updateWebhook`) | SQLite (`kv`, secret) | Secret persisted locally before the remote call (D-03) |
| Re-fetch-then-decide | Linear API | — | INTK-05: payload is a signal, never a source of truth |
| Run creation | Out of scope | — | Ingress ends at a normalised DomainEvent |

---

## Resolved Unknowns

### Unknown 1 — Does `@ngrok/ngrok@1.7.0` expose domain control equivalent to the CLI's `--url`?

**Answer: Yes — `Config.domain`. And for the ephemeral path the URL comes from `listener.url()`, which is nullable.** `[VERIFIED: node_modules/@ngrok/ngrok/index.d.ts v1.7.0]`

```ts
// index.d.ts line 73, inside `export interface Config`
/**
 * The domain to request for this edge, any valid domain or hostname that you have
 * previously registered with ngrok. If using a custom domain, this requires
 * registering in the [ngrok dashboard] and setting a DNS CNAME value.
 */
domain?: string

// index.d.ts line 394, class Listener
url(): string | null      // "The URL that this listener backs."
id(): string
close(): Promise<void>
```

Implications for D-01 (ephemeral, locked):

1. **Omit `domain` entirely.** ngrok assigns a random `*.ngrok-free.app` URL per session. The deferred static-domain option (§ Deferred Ideas) would be `{ domain: cfg.ngrokDomain }` — one line — should the operator ever revisit it. Nothing in this phase's design forecloses that.
2. **`url()` returns `string | null` and must be checked.** This is the sharp edge. An unchecked `listener.url()` flows a `null` into the webhook URL string, and `` `${null}/linear/webhook` `` produces `"null/linear/webhook"` — a URL Linear will accept as a string and then never successfully deliver to. The daemon boots clean, logs healthy, registers a webhook, and receives nothing. Treat a null URL as a fatal boot error in the same class as TUN-03.
3. **The singleton (TUN-01) is assertable, not just assumed.** `ngrok.listeners(): Promise<Array<Listener>>` returns every listener in the process. After connecting, asserting `listeners().length === 1` turns "exactly one tunnel per process" from a code-review claim into a runtime check.

**Also verified on this machine** `[VERIFIED: live execution]`: the `darwin-arm64` prebuilt native binding loads with no compile step, and `@ngrok/ngrok` did **not** read `~/Library/Application Support/ngrok/ngrok.yml` despite that file existing. This confirms T10 and corrects its path: on macOS the agent's config lives at `~/Library/Application Support/ngrok/ngrok.yml`, not `~/.config/ngrok/ngrok.yml`. Phase 8's wizard should read the macOS path.

---

### Unknown 2 — `webhookTimestamp` units: milliseconds or seconds?

**Answer: MILLISECONDS.** `[VERIFIED: shipped schema doc comment + live server test]`

Two independent proofs.

**Proof 1 — the shipped GraphQL schema says so outright:**

```ts
// node_modules/@linear/sdk/dist/index-267_t0Tf.d.mts — type EntityWebhookPayload
/** Unix timestamp in milliseconds when the webhook was sent. */
webhookTimestamp: Scalars["Float"];
```

**Proof 2 — a live `node:http` server + `createHandler()`, real HMACs:**

```
ms  in body : {"status":200,"text":"OK"}
sec in body : {"status":400,"text":"Invalid webhook"}
```

**The staleness check already exists in the SDK — do not write a second one.** From the runtime source (`dist/webhooks-BisgAo6N.mjs`, `verify()`):

```js
if (timestamp) {
  const timestampMs = typeof timestamp === "string" ? parseInt(timestamp, 10) : timestamp;
  if (isNaN(timestampMs)) throw new Error(`Invalid webhook timestamp: ${timestamp}`);
  if (Math.abs(new Date().getTime() - timestampMs) > 1e3 * 60) throw new Error("Invalid webhook timestamp");
}
```

Measured boundary behaviour — the window is **±60 s and symmetric** (future-skew is rejected too):

| Offset from now | Result |
|---|---|
| −90 000 ms | 400 Invalid webhook |
| −61 000 ms | 400 Invalid webhook |
| −59 000 ms | 200 OK |
| 0 | 200 OK |
| +59 000 ms | 200 OK |
| +61 000 ms | 400 Invalid webhook |

**The silent failure mode HOOK-05 must close.** The check is wrapped in `if (timestamp)`. When `webhookTimestamp` is absent from the body *and* the `linear-timestamp` header is absent, `timestamp` is `undefined` and the replay check is **skipped entirely, returning 200**:

```
no timestamp at all -> {"status":200,"text":"OK"}
```

A `webhookTimestamp` of `0` is also falsy and skips the check. This is exactly the "always-pass is the silent one" risk SUMMARY.md flagged. The phase must assert `typeof payload.webhookTimestamp === "number"` itself and reject when absent — the SDK will not do it.

Precedence note: `parseVerifiedPayload` uses `parsedBody.webhookTimestamp ?? timestampHeader`. The body field wins, and it is inside the signed payload, so it cannot be forged independently of the signature. Prefer the body field; treat the `linear-timestamp` header as a fallback only.

---

### Unknown 3 — The webhook-secret doc contradiction

**Answer: both readings are unreliable, and D-03 is correct under either. `WebhookCreateInput.secret` and `.id` both exist.** `[VERIFIED: .d.ts + GraphQL fragment source + tsc compile]`

```ts
type WebhookCreateInput = {
  allPublicTeams?: InputMaybe<Scalars["Boolean"]>;
  enabled?: InputMaybe<Scalars["Boolean"]>;
  /** The identifier in UUID v4 format. If none is provided, the backend will generate one. */
  id?: InputMaybe<Scalars["String"]>;
  label?: InputMaybe<Scalars["String"]>;
  resourceTypes: Array<Scalars["String"]>;
  /** A secret token used to sign the webhook payload. */
  secret?: InputMaybe<Scalars["String"]>;
  teamId?: InputMaybe<Scalars["String"]>;
  url: Scalars["String"];
};
```

- **`secret` accepts a client-supplied value** → D-03 works as specified.
- **`id` accepts a client-supplied UUID v4** → idempotent registration confirmed. Generate the webhook id once with `crypto.randomUUID()`, persist it in `kv` alongside the secret, and the same id is reusable across every boot.

**Why the contradiction is unresolvable and why that no longer matters.** The SDK's selection set *does* request the secret:

```graphql
fragment Webhook on Webhook {
  __typename  label  secret  url  updatedAt  resourceTypes
  team { id }  archivedAt  createdAt  id  creator { id }  enabled  allPublicTeams
}
```

But the resolved TypeScript type of that field is `string | null | undefined` — the compiler was asked directly and answered `Type 'string | null | undefined'`. A nullable field means the API is permitted to return nothing there, so code that depends on reading it back is code that works until it doesn't. Generating locally and never reading back sidesteps the question permanently.

**Unflagged security consequence:** since the fragment selects `secret`, **every `webhooks()` reconcile call returns signing secrets for every webhook in the workspace**. A `log.info({ webhooks })` in the reconciler writes those secrets to disk. `Webhook` objects must be projected to a safe subset before logging, and `secret` belongs on Phase 2's redaction list (01-CONTEXT D-08).

---

## Findings Not In The Brief

### Finding A — `createHandler()` cannot satisfy HOOK-05, HOOK-06, HOOK-08, D-09, or D-10's diagnosis requirement

This is the most consequential result of the investigation. Four independent problems, all verified by running the thing.

**A1. It awaits your handlers before acknowledging. (blocks HOOK-08)** `[VERIFIED: live measurement]`

```js
// dist/webhooks-BisgAo6N.mjs — createHandler()
const allHandlers = this.collectHandlers(eventHandlers, parsedPayload.type);
await Promise.all(allHandlers.map((h) => h(parsedPayload)));
return adapter.send(200, "OK");        // ← 200 is sent AFTER the work
```

Measured with a handler that sleeps 1200 ms: `status 200, ACK took 1205ms`. There is no ack-early escape hatch. Any `await` inside an `.on()` callback is added directly to Linear's 5-second delivery budget, and the sub-200 ms p99 target in § Specific Ideas is unreachable except by making every callback synchronous-and-instant.

**A2. It discards request headers, so the `Linear-Delivery` UUID is unreachable. (blocks HOOK-06)** `[VERIFIED: live test]`

The node adapter extracts exactly two headers — `linear-signature` and `linear-timestamp` — and the callback receives only the parsed payload:

```
keys visible inside handler.on(): action, type, data, webhookTimestamp
linear-delivery reachable from .on()? -> NO — header is discarded
```

HOOK-06's `UNIQUE` constraint needs that UUID. `payload.webhookId` is a different thing — it identifies the *registration*, not the delivery, and is constant across every event. Working around this with an `AsyncLocalStorage` or a `WeakMap<IncomingMessage, string>` populated by an outer listener is strictly more machinery than not using `createHandler()`.

**A3. It collapses every rejection into one indistinguishable response. (blocks D-09, weakens D-10)** `[VERIFIED: live test]`

| Case | Status | Body |
|---|---|---|
| valid | 200 | `OK` |
| tampered signature | 400 | `Invalid webhook` |
| wrong-length signature | 400 | `Invalid webhook` |
| stale timestamp | 400 | `Invalid webhook` |
| malformed JSON | 400 | `Invalid webhook` |
| missing signature header | 400 | `Missing webhook signature` |
| non-POST | 405 | `Method not allowed` |
| handler threw | 500 | `Internal server error` |

D-10's 400 assertion is confirmed. But the `catch { return adapter.send(400, "Invalid webhook") }` swallows the error object entirely — there is no hook, no callback, no event. D-09 requires naming which guard fired; with `createHandler()` you cannot even distinguish "someone is replaying old deliveries" from "our persisted secret is stale", which are opposite incidents with opposite fixes.

**A4. It `JSON.parse`s unverified bytes before HMAC-ing — the reverse of D-11's stated rationale.** `[VERIFIED: runtime source]`

```js
parseVerifiedPayload(rawBody, signature, timestampHeader) {
  const parsedBody = this.parseBodyAsWebhookPayload(rawBody);          // ← parse first
  const timestamp = parsedBody.webhookTimestamp ?? timestampHeader;
  if (!this.verify(rawBody, signature, timestamp)) throw ...           // ← verify second
  return parsedBody;
}
```

It parses first in order to read `webhookTimestamp` out of the body. The HMAC is still computed over the raw `Buffer` — so T14 is *not* violated and signatures are correct — but the claim in D-11 and in SUMMARY.md that the handler "HMACs it before any JSON parsing" is factually inverted. `JSON.parse` on attacker-controlled bytes is low-severity in Node, but it is not what the decision says is happening.

**The recommended alternative — same constraints, none of the problems.** `parseData()` verifies *first*, then parses:

```js
parseData(rawBody, signature, timestamp) {
  if (!this.verify(rawBody, signature, timestamp)) throw new Error("Invalid webhook signature");
  return this.parseBodyAsWebhookPayload(rawBody);
}
```

A plain `node:http` listener calling `parseData()` keeps everything D-11 exists to protect — no HTTP framework, no hand-rolled HMAC, the raw body stream consumed once and never re-serialised — while restoring header access, ACK timing, and error discrimination. Verified end-to-end (§ Code Example 1):

```
valid    -> {"status":200,"ms":3}     deferred work captured delivery id "D-1"
stale    -> {"status":400,"ms":2}     guard=timestamp: stale by 90001ms
tampered -> {"status":400,"ms":1}     guard=signature: Invalid webhook signature
no ts    -> {"status":400,"ms":2}     guard=timestamp: field absent from signed payload
```

> **Planner action required.** D-11 is a locked decision that names `createHandler()` explicitly. This finding does not relitigate its no-framework rule — that rule is upheld — but it does contradict the specific API named. Raise this with the operator as a `checkpoint:human-verify` before implementing, rather than silently substituting.

---

### Finding B — `fetchNext()` mutates and appends; the natural pagination loop double-counts every page

`[VERIFIED: runtime source, dist/index.mjs]`

```js
_appendNodes(nodes) { this.nodes = nodes ? [...this.nodes ?? [], ...nodes] : this.nodes; }

async fetchNext() {
  if (this.pageInfo?.hasNextPage) {
    const response = await this._fetch({ after: this.pageInfo?.endCursor });
    this._appendNodes(response?.nodes);          // appends into THIS connection
    this._appendPageInfo(response?.pageInfo);
  }
  return Promise.resolve(this);                   // returns the SAME object
}
```

`fetchNext()` accumulates into `this.nodes` and returns `this`. The intuitive loop is therefore wrong:

```ts
// ✗ WRONG — page 1 counted N times, page 2 counted N−1 times, ...
let page = await client.webhooks({ first: 50 });
for (;;) { out.push(...page.nodes); if (!page.pageInfo.hasNextPage) break; page = await page.fetchNext(); }

// ✓ RIGHT — accumulation is the connection's job
const page = await client.webhooks({ first: 250 });
while (page.pageInfo.hasNextPage) await page.fetchNext();
const all = page.nodes;
```

**Why this is dangerous rather than merely wrong here.** The reconciler's job (HOOK-02/HOOK-09) is to keep one webhook and delete the rest. Feed it duplicates and `const [keep, ...dupes] = mine` classifies the daemon's own live registration as a duplicate and **deletes it**. The daemon then either recreates it on the next boot — churning secrets — or reports success while owning nothing. Note that the reconcile snippet in `research/PITFALLS.md` § Pitfall 2 does not paginate at all (its own comment says `// paginate!`), so this loop will be written fresh by whoever implements it.

---

### Finding C — the client's webhook methods are not named what the research says

`[VERIFIED: tsc error + prototype walk]`

`client.webhookCreate` **does not exist** — `tsc` rejects it: `error TS2339: Property 'webhookCreate' does not exist on type 'LinearClient'`. Those are GraphQL mutation names, not SDK method names. `PROJECT.md`, `03-CONTEXT.md` D-03, and `PITFALLS.md` § Pitfall 2 all use the GraphQL spelling.

| Research / CONTEXT says | Actual SDK method |
|---|---|
| `linear.webhookCreate(input)` | `client.createWebhook(input)` |
| `linear.webhookUpdate(id, input)` | `client.updateWebhook(id, input)` |
| `linear.webhookDelete(id)` | `client.deleteWebhook(id)` |
| — | `client.rotateSecretWebhook(id)` (exists; not needed under D-03) |
| `linear.webhooks()` | `client.webhooks(vars?)` ✓ correct |

Also: `createWebhook` returns a payload whose `.webhook` is a **Promise** (`const w = await res.webhook`), and `.success` is the boolean to check.

---

### Finding D — ngrok errors cannot be branched on by `code`

`[VERIFIED: three live failure runs]`

| Scenario | `err.name` | `err.code` | Message contains |
|---|---|---|---|
| no authtoken | `Error` | `GenericFailure` | `ERR_NGROK_4018` — "This ngrok session is not authenticated" |
| `authtoken_from_env: true`, env var unset | `Error` | `GenericFailure` | `ERR_NGROK_4018` — *identical to the above* |
| malformed authtoken | `Error` | `GenericFailure` | `ERR_NGROK_105` — "does not look like a proper ngrok authtoken" |

Three consequences for TUN-03:

1. **`switch (err.code)` is dead code.** Every ngrok failure is `GenericFailure`. Discrimination must parse `/ERR_NGROK_(\d+)/` out of the message.
2. **An unset `NGROK_AUTHTOKEN` is indistinguishable from a bad account.** `authtoken_from_env: true` does not report "the env var is missing"; it reports "not authenticated". TUN-03 promises "a clear message when the authtoken is missing" — so the worker must check `process.env.NGROK_AUTHTOKEN` itself *before* calling `connect()` and emit its own message. This sharpens T10.
3. **The malformed-token error echoes the token back in its message.** Verified: `Your authtoken: not-a-real-authtoken-0000`. Logging a raw ngrok error therefore writes the operator's real authtoken into the log — directly violating Phase 2 success criterion 3 ("no line anywhere contains an API key or authtoken"). Sanitise ngrok error messages before logging.

---

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@linear/sdk` | `93.0.1` exact | Linear GraphQL client + webhook verification | Only first-party client; ships the HMAC implementation. Exact pin per T8 — new major ~weekly `[VERIFIED: npm registry]` |
| `@linear/sdk/webhooks` | (subpath) | `LinearWebhookClient`, header constants | Subpath export confirmed in `package.json` exports map `[VERIFIED: package.json]` |
| `@ngrok/ngrok` | `1.7.0` | In-process tunnel | Lifetime bound to the process — this *is* TUN-02. `darwin-arm64` prebuild present, no compile `[VERIFIED: live load]` |
| `node:http` | built-in | Webhook server | No framework (D-11). Owns headers, body stream, and ACK timing — all three are requirements |
| `node:crypto` | built-in | `randomBytes(32)` secret, `randomUUID()` webhook id | D-03; both consumed by `WebhookCreateInput` |
| `better-sqlite3` | `13.0.3` | `deliveries` UNIQUE dedupe, `kv` watermark + secret | Synchronous — a dedupe insert inside the ACK path must not yield |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `pino` | `10.3.1` | Structured log naming the guard that fired | D-09; child logger per delivery id |
| `zod` | `4.5.4` | Shape-check the verified payload before routing | After HMAC, before decisions. Zod 4 idioms: `z.url()`, `z.prettifyError()` |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `client.parseData()` in own listener | `client.createHandler()` | Less code, but forfeits HOOK-06, HOOK-08, D-09 and D-10 diagnosis — see Finding A |
| `node:http` | Hono 4.13.7 | Rejected by D-11. Would be a one-line migration later (`handler(c.req.raw)` Fetch signature is supported) if a status API ever appears |
| Ephemeral URL + reconcile | `Config.domain` static pin | Rejected by operator (D-01). Available whenever revisited — § Deferred Ideas |
| Local secret generation | `client.rotateSecretWebhook(id)` | Requires reading the secret back; nullable field makes that unreliable (Unknown 3) |

**Installation:**

```bash
npm install @linear/sdk@93.0.1 @ngrok/ngrok@1.7.0 better-sqlite3@13.0.3 zod@4.5.4 pino@10.3.1
```

> ⚠ Under RUSH mode there is no `package.json` on this branch and no install may be run. Write source files only; the integration gate installs.

---

## Package Legitimacy Audit

`[VERIFIED: gsd-tools query package-legitimacy check --ecosystem npm]`

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| `@linear/sdk` | npm | published 2026-09-04 (2 d) | 2 158 859/wk | github.com/linear/linear | **SUS** (`too-new`) | **Approved — see below** |
| `@ngrok/ngrok` | npm | published 2025-12-16 | 487 252/wk | github.com/ngrok/ngrok-javascript | OK | Approved |

**Packages removed due to [SLOP] verdict:** none.

**Packages flagged as suspicious [SUS]:** `@linear/sdk`. The `too-new` signal fires because version `93.0.1` was published two days ago — which is **the documented, expected behaviour recorded as T8** ("ships a new major roughly weekly; 86 → 93 in 15 weeks"), not a slopsquatting indicator. Countervailing evidence: 2.16M weekly downloads, the official `linear/linear` monorepo as its source, not deprecated, **no postinstall script**, and already installed and executed during this session. `.planning/TRAPS.md` § "Verified clean" further records the whole pinned set installing cleanly on 2026-09-06. No `checkpoint:human-verify` is warranted; the exact pin already required by PROJECT.md is the correct mitigation.

`postinstall` scripts checked for both packages: **none** `[VERIFIED: npm view <pkg> scripts.postinstall]`.

---

## Architecture Patterns

### System Architecture Diagram

```
                    ┌─────────────────────────── BOOT SEQUENCE ───────────────────────────┐
                    │                                                                     │
  process.env ─────►│ 0. assert NGROK_AUTHTOKEN present    (Finding D — own message)      │
                    │            │                                                        │
                    │            ▼                                                        │
                    │ 1. http.createServer(...).listen(0)   ◄── bound BEFORE tunnel       │
                    │            │                              (HOOK-01, Phase 7)        │
                    │            ▼                                                        │
                    │ 2. ngrok.connect({addr: port, authtoken_from_env: true})             │
                    │            │  no `domain` key ⇒ ephemeral (D-01)                    │
                    │            ▼                                                        │
                    │ 3. url = listener.url()  ──► null? ⇒ FATAL BOOT ERROR (Unknown 1)   │
                    │            │      assert ngrok.listeners().length === 1  (TUN-01)   │
                    │            ▼                                                        │
                    │ 4. secret/id from kv, else crypto.randomBytes/randomUUID            │
                    │       PERSIST TO SQLITE ───────────────────► before any remote call │
                    │            │                                            (D-03)      │
                    │            ▼                                                        │
                    │ 5. RECONCILE ── paginate webhooks() ── accumulate via fetchNext()   │
                    │       │           (Finding B: never push nodes per iteration)       │
                    │       ├─ ours (id matches kv)  ─► updateWebhook(id,{url,enabled:1}) │
                    │       │                            one call = URL + re-enable (D-02)│
                    │       ├─ absent                ─► createWebhook({id,secret,url,...})│
                    │       └─ stale ngrok-looking   ─► log + prune            (HOOK-09)  │
                    └─────────────────────────────────────────────────────────────────────┘
                                                 │
     Linear ══ POST ══════════════════════════════▼════════════════════════════════════════
     delivery      headers: linear-signature, linear-timestamp, Linear-Delivery
                                                 │
                    ┌──────────────── REQUEST PATH — target p99 < 200 ms ────────────────┐
                    │  method !== POST ────────────────────────────────► 405 · return    │
                    │            │                                                       │
                    │            ▼  read raw body ONCE (never re-serialise · T14)        │
                    │  G0 parseData(raw, sig)  ─ verify THEN parse ─ throw ─► 400        │
                    │            │                              guard="signature"        │
                    │            ▼                                                       │
                    │  G1 webhookTimestamp is number? ── absent ────────► 400            │
                    │     |now − ts| > 60 000 ms?     ── stale  ────────► 400            │
                    │            │                    guard="timestamp"     (HOOK-05)    │
                    │            ▼                                                       │
                    │  G2 INSERT delivery_id  ── UNIQUE violation ──────► 200 · drop     │
                    │            │                    guard="delivery-id"   (L4/HOOK-06) │
                    │            ▼                                                       │
                    │  G3 actor null OR actor.id === BOT ───────────────► 200 · drop     │
                    │            │                    guard="actor"         (L1/D-08)    │
                    │            ▼                                                       │
                    │  G4 Comment && body startsWith MARKER ────────────► 200 · drop     │
                    │            │                    guard="marker"        (L2/D-07)    │
                    │            ▼                                                       │
                    │  G5 isSelfWrite(type:id) within 90 s ─────────────► 200 · drop     │
                    │            │                    guard="suppression"   (L3)         │
                    │            ▼                                                       │
                    │  ══► res.end(200)  ◄══ ACK HERE. Nothing below is awaited (HOOK-08)│
                    │            │                                                       │
                    └────────────┼───────────────────────────────────────────────────────┘
                                 │ setImmediate / queue
                                 ▼
                    ┌──────── ASYNC ROUTER — never blocks the ACK ─────────┐
                    │  payload is a SIGNAL only, never a source (INTK-05)  │
                    │            │                                        │
                    │  edge-detect: "assigneeId" in updatedFrom           │
                    │            │                                        │
                    │            ▼                                        │
                    │  RE-FETCH issue from Linear API ─────► decide       │
                    │            │                                        │
                    │            ▼                                        │
                    │      DomainEvent  ══► PHASE BOUNDARY ENDS HERE      │
                    └─────────────────────────────────────────────────────┘

   every drop above ──► selfEventsDropped.inc() + log.warn({guard, deliveryId})   (D-09)

   ┌─── RECONCILIATION POLL — boot + every 5 min (D-04) ────────────────────────┐
   │  kv watermark ─► issues(assignee=bot, updatedAt > watermark) ─► DomainEvent│
   │                  + comments since watermark on open-question issues (D-05) │
   │  This is what makes a lost delivery latency, not data loss.                │
   └────────────────────────────────────────────────────────────────────────────┘
```

### Recommended Project Structure

```
src/ingress/
├── tunnel.ts          # ngrok connect/close, url() null-check, singleton assert   TUN-01..03
├── registrar.ts       # paginate + reconcile + re-enable + prune                  HOOK-02,03,09
├── receiver.ts        # node:http listener, parseData, guard chain, ACK-first     HOOK-04,05,08
├── guards.ts          # G2–G5 as pure predicates returning a named guard          HOOK-06,07
├── router.ts          # edge-detect → re-fetch → DomainEvent                      INTK-01,05
└── poll.ts            # boot + 5-min reconciliation poll                          D-04, D-05
src/shared/
└── markers.ts         # MARKER constant — imported by ingress AND outbound        D-07
```

`src/shared/markers.ts` is deliberately **not** under `src/ingress/`. D-07 requires one definition shared with Phase 5, and Phase 5 must not import from `src/ingress/`. Per the ADDENDUM, `src/domain/` is Phase 1's alone — so a sibling `src/shared/` is the correct home, and its path must be recorded in the SUMMARY so Phase 5 imports the same file.

### Pattern 1: Tunnel with bound lifetime and a checked URL (TUN-01/02/03)

**What:** Open exactly one tunnel, prove the URL exists, guarantee no orphan.
**When to use:** Once, at boot, before registration.

```ts
// Source: @ngrok/ngrok@1.7.0 index.d.ts (verified) + live failure-path runs
import ngrok, { type Listener } from "@ngrok/ngrok";

export async function openTunnel(port: number): Promise<{ listener: Listener; url: string }> {
  // Finding D.2 — connect() cannot tell "env var unset" from "bad account". Check first.
  if (!process.env.NGROK_AUTHTOKEN) {
    throw new Error("NGROK_AUTHTOKEN is not set. Run the setup wizard or export it in ~/.linear-auto-worker/.env");
  }

  let listener: Listener;
  try {
    listener = await ngrok.connect({ addr: port, authtoken_from_env: true });
    //                               ^ no `domain` key ⇒ ephemeral random URL (D-01)
  } catch (e) {
    // Finding D.1 — every ngrok error is code "GenericFailure"; discriminate on the message.
    // Finding D.3 — the malformed-token message ECHOES THE TOKEN. Never log it raw.
    const code = /ERR_NGROK_(\d+)/.exec(String((e as Error).message))?.[0] ?? "unknown";
    throw new Error(`ngrok tunnel failed to open (${code}). Check the authtoken in ~/.linear-auto-worker/.env`);
  }

  // Unknown 1.2 — url() is `string | null`. Unchecked, this registers "null/linear/webhook".
  const url = listener.url();
  if (!url) {
    await listener.close();
    throw new Error("ngrok returned a null tunnel URL; refusing to register an unreachable webhook");
  }

  // TUN-01 as a runtime assertion, not a claim.
  const all = await ngrok.listeners();
  if (all.length !== 1) throw new Error(`expected exactly 1 ngrok listener, found ${all.length}`);

  return { listener, url };
}

// TUN-02 — the native session dies with the process; these cover the graceful paths.
export const closeTunnel = (l: Listener) => l.close();
process.once("SIGINT",  () => void ngrok.kill().finally(() => process.exit(0)));
process.once("SIGTERM", () => void ngrok.kill().finally(() => process.exit(0)));
```

### Pattern 2: Reconcile — paginate, re-enable, prune (HOOK-02/03/09, D-02)

**What:** Converge the workspace on exactly one webhook owned by this daemon.
**When to use:** Every boot, after the tunnel URL is known.

```ts
// Source: @linear/sdk@93.0.1 .d.ts + runtime source, all calls compile under tsc 5.9.3
import { LinearClient, type Webhook } from "@linear/sdk";
import crypto from "node:crypto";

const NGROK_URL = /\.ngrok(-free)?\.(app|dev|io)(\/|$)/;

export async function reconcile(client: LinearClient, store: Store, tunnelUrl: string) {
  const desiredUrl = `${tunnelUrl}/linear/webhook`;

  // D-03 — id and secret are OURS, generated once and persisted BEFORE any remote call.
  const id     = store.kvGet("webhook_id")     ?? crypto.randomUUID();
  const secret = store.kvGet("webhook_secret") ?? crypto.randomBytes(32).toString("hex");
  store.kvPut("webhook_id", id);
  store.kvPut("webhook_secret", secret);

  // Finding B — accumulate INSIDE the connection. Pushing page.nodes per iteration
  // duplicates every earlier page, and the dupe-pruning below would then delete our own.
  const page = await client.webhooks({ first: 250 });
  while (page.pageInfo.hasNextPage) await page.fetchNext();
  const all: Webhook[] = page.nodes;
  // ⚠ every element here carries a live `secret`. Never log `all` — project first.

  const ours = all.find(w => w.id === id);

  if (!ours) {
    // Finding C — method is createWebhook, NOT webhookCreate.
    const res = await client.createWebhook({
      id, secret, url: desiredUrl, enabled: true,
      allPublicTeams: true,
      resourceTypes: ["Issue", "Comment"],   // narrow surface = fewer loop surfaces
    });
    if (!res.success) throw new Error("webhook registration failed");
  } else {
    // D-02 — URL update AND re-enable in ONE call. With an ephemeral domain the webhook
    // is auto-disabled by failed deliveries after nearly every restart, so `enabled: true`
    // is unconditional here: it is the normal path, not a repair.
    await client.updateWebhook(id, { url: desiredUrl, enabled: true });
  }

  // HOOK-09 — prune our own abandoned ngrok registrations. Never touch foreign ones:
  // another tool in this workspace may legitimately use ngrok.
  for (const w of all) {
    if (w.id !== id && NGROK_URL.test(w.url)) {
      log.warn({ webhookId: w.id, url: w.url }, "stale ngrok webhook found");
      await client.deleteWebhook(w.id);
    }
  }
  return { id, secret, url: desiredUrl };
}
```

### Pattern 3: ACK-first receiver with a named guard chain (HOOK-04/05/08, D-09, D-10)

See § Code Example 1 — verified end to end.

### Pattern 4: The actor guard is a four-member union (HOOK-07 L1, D-08)

**What:** `payload.actor` is not a user. It is `ExternalUserActorWebhookPayload | IntegrationActorWebhookPayload | OauthClientActorWebhookPayload | UserActorWebhookPayload`. `[VERIFIED: .d.ts]`

All four carry `id: string` and `type: string`; only `UserActorWebhookPayload` carries `email`. A bot authenticated with a personal API key appears as the `user` variant, so the guard should assert the discriminant rather than compare ids across namespaces:

```ts
// D-08 — null actor is UNTRUSTED and dropped. Note the shape of the test:
// `payload.actor?.id !== BOT` would be TRUE for a null actor and let it through.
export function actorGuard(payload: LinearWebhookPayload, botUserId: string) {
  const actor = payload.actor;
  if (!actor) return { drop: true, guard: "actor:null-untrusted" };
  if (actor.type === "user" && actor.id === botUserId) return { drop: true, guard: "actor:self" };
  return { drop: false };
}
```

Dropping null actors is only safe because D-04's poll re-discovers any real work lost this way — the failure mode is a ≤5-minute delay, not a lost ticket. That coupling is load-bearing: **if the poll is descoped, D-08 becomes a correctness bug.**

### Pattern 5: Edge-detect on `updatedFrom`, then re-fetch (INTK-01, INTK-05)

**What:** Distinguish "the bot was just assigned" from "the issue changed and the bot happens to be the assignee".

```ts
// `updatedFrom` = previous values of all updated properties. Key MEMBERSHIP is the edge.
const justAssigned =
  payload.action === "update" &&
  payload.updatedFrom != null &&
  "assigneeId" in (payload.updatedFrom as Record<string, unknown>);

if (!justAssigned) return;            // success criterion 5: later unrelated edits ⇒ no pickup

// INTK-05 — `updatedFrom` decided WHETHER to look. It does not decide WHAT to do.
const issue = await client.issue(payload.data.id);   // fresh fetch is the only source of truth
```

Keying on "assignee is bot" without the `updatedFrom` membership test re-triggers on every subsequent edit forever — including the bot's own writes, which is loop surface 3 from PITFALLS § Pitfall 1.

### Anti-Patterns to Avoid

- **`if (payload.actor?.id !== BOT_ID) process(...)`** — a null actor makes this true and passes the event. Invert the test (Pattern 4).
- **`out.push(...page.nodes)` inside a `fetchNext()` loop** — double-counts every page; makes the reconciler delete its own webhook (Finding B).
- **`switch (err.code)` on ngrok errors** — all are `GenericFailure`; dead code (Finding D).
- **`await` anything inside a `handler.on()` callback** — adds directly to the 5 s delivery budget (Finding A1).
- **`log.info({ webhook })` / `log.error(ngrokErr)`** — the first leaks the signing secret, the second leaks the authtoken (Unknown 3, Finding D3).
- **`if (!client.verify(...))`** — `verify()` throws on failure and never returns `false`. The `false` branch is unreachable. Use `try/catch`.
- **Re-serialising the body to verify** — `JSON.stringify(JSON.parse(raw))` happens to round-trip in V8 for these payloads, so this bug **passes a naive test** and fails later on key ordering or a different serialiser. Never construct the HMAC input; use the received `Buffer` (T14).
- **Asserting 401 for a bad signature** — it is 400 (T6, D-10, re-verified).

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| HMAC verification | `createHmac` + `===` compare | `client.parseData()` / `client.verify()` | Uses `timingSafeEqual`; a `===` compare is timing-unsafe and a length mismatch throws before the compare |
| Timestamp staleness | Your own ±N-minute window | SDK's built-in ±60 s — **plus** an explicit presence assertion | The window exists already; only the absent-field case is yours (Unknown 2) |
| Raw body capture | A body-parser with a `verify` callback | Read the `IncomingMessage` stream yourself, once | Any parse-then-restringify path breaks unicode/key-order signatures (T14) |
| Tunnel process management | ngrok CLI + PID file + lockfile | `@ngrok/ngrok` in-process | Lifetime bound to the process makes orphans structurally impossible (TUN-02) |
| Webhook secret | Reading it back from the API | `crypto.randomBytes(32).toString("hex")` supplied as input | The field is nullable; docs and schema disagree (Unknown 3) |
| Idempotent registration | "find by URL" heuristics | Client-supplied `WebhookCreateInput.id` | Exact identity survives a URL that changes every boot |
| Cursor pagination | Manual `after`/`endCursor` bookkeeping | `while (page.pageInfo.hasNextPage) await page.fetchNext()` | The connection accumulates for you (Finding B) |
| Delivery dedupe | In-memory `Set` | SQLite `deliveries` table with `UNIQUE` | Must survive restart; Linear retries at +1 min / +1 hr / +6 hr |
| Missed-delivery recovery | Trusting Linear's retries | The D-04 reconciliation poll | A 10-minute laptop sleep pushes the retry out an hour |

**Key insight:** the SDK already owns the two things that are genuinely hard here — a timing-safe HMAC over the exact received bytes, and cursor accumulation. What it does *not* own, and what this phase must own, is everything about **when** the 200 is written and **which** guard rejected. Reaching for `createHandler()` gets the easy half and forfeits the hard half.

---

## Common Pitfalls

### Pitfall 1: The reconciler deletes its own webhook

**What goes wrong:** Reconcile runs, sees the daemon's live registration listed several times, treats the extras as duplicates, deletes them — and the first one deleted is the real one.
**Why it happens:** `fetchNext()` appends into the same connection and returns `this` (Finding B). Every intuitive pagination loop double-counts.
**How to avoid:** `while (page.pageInfo.hasNextPage) await page.fetchNext();` then read `page.nodes` once. Match ownership on the persisted `id`, never on URL equality — with an ephemeral domain the URL is different on every boot by definition.
**Warning signs:** webhook count oscillating between boots; signature failures on *some* deliveries (a stale registration's secret); `deleteWebhook` called with the id just written.

### Pitfall 2: The replay check that never runs

**What goes wrong:** HOOK-05 ships, tests pass, and stale deliveries are accepted forever.
**Why it happens:** the SDK's check is `if (timestamp) { ... }`. Absent `webhookTimestamp` and absent `linear-timestamp` header ⇒ skipped ⇒ 200 `[VERIFIED: live test]`. A `webhookTimestamp` of `0` is also falsy.
**How to avoid:** assert `typeof payload.webhookTimestamp === "number"` explicitly and reject when absent, with its own guard name. Test the absent case, not only the stale one.
**Warning signs:** a stale-timestamp test that only ever exercises a *present* timestamp; deliveries arriving on a 1-hour cadence (that is Linear's retry schedule).

### Pitfall 3: ACK measured with a fast handler

**What goes wrong:** ACK latency looks fine in tests and blows past 5 s in production, so Linear retries, so every event is processed 3×, so the retry traffic auto-disables the webhook.
**Why it happens:** `createHandler()` awaits handlers before responding (Finding A1) — measured 1205 ms for a 1200 ms handler. A test whose handler returns immediately cannot see this.
**How to avoid:** ACK before the work, structurally: `res.end()` then `setImmediate(...)`. Test with a handler that deliberately sleeps ≫ the budget and assert the ACK returned in ms.
**Warning signs:** handler latency approaching 5 s; identical `Linear-Delivery` values arriving 3×; the webhook found `enabled: false` at boot more often than a restart explains.

### Pitfall 4: Signing secrets and authtokens in the log

**What goes wrong:** `~/.linear-auto-worker/logs` accumulates live credentials, breaking Phase 2 success criterion 3.
**Why it happens:** two independent leaks. (a) The SDK's `fragment Webhook` selects `secret`, so every `webhooks()` result carries signing secrets — one `log.info({ webhooks })` in the reconciler writes them all. (b) ngrok's malformed-token error **echoes the token in its message** `[VERIFIED]`, so `log.error(err)` writes the authtoken.
**How to avoid:** project `Webhook` to `{id, url, enabled}` before logging; sanitise ngrok errors to just the `ERR_NGROK_nnnn` code. Add `secret` and `authtoken` to Phase 2's redaction list.
**Warning signs:** `grep -rE 'ngrok_[0-9A-Za-z]{20,}|[0-9a-f]{64}' logs/` returning anything.

### Pitfall 5: The unicode test that passes for the wrong reason

**What goes wrong:** D-10's non-ASCII test is written as parse → re-stringify → compare, it passes, and the real encoding bug ships.
**Why it happens:** measured this session — `JSON.stringify(JSON.parse(raw))` produced **byte-identical** output for a payload containing emoji, CJK, accents, smart quotes and a zero-width space. V8 preserves insertion order for non-numeric keys, so the classic round-trip does not reliably break.
**How to avoid:** make the non-ASCII test assert the *signature* over the received `Buffer`, and add a negative case that signs the same payload under the wrong encoding — `Buffer.toString("latin1")` — which does correctly 400 `[VERIFIED]`. Test the multi-byte body end to end, not the round-trip.
**Warning signs:** any test that reconstructs the body before hashing.

### Pitfall 6: TUN-03's "clear message" that is neither clear nor triggered

**What goes wrong:** the operator forgets `NGROK_AUTHTOKEN` and gets "This ngrok session is not authenticated", which reads like an account problem.
**Why it happens:** `authtoken_from_env: true` with the variable unset fails identically to having no credential at all — same `ERR_NGROK_4018`, same `GenericFailure` code (Finding D).
**How to avoid:** check `process.env.NGROK_AUTHTOKEN` before `connect()` and emit your own message naming the file to fix.
**Warning signs:** a `switch (err.code)` in the tunnel module — it can only ever match `GenericFailure`.

---

## Code Examples

### Example 1: ACK-first receiver with named guards — verified end to end

```ts
// Source: verified against @linear/sdk@93.0.1 with a live node:http server.
// Measured: valid 200 in 3 ms with work deferred; stale/tampered/absent-ts each 400
// with a DISTINCT guard name; Linear-Delivery captured.
import http from "node:http";
import { LinearWebhookClient, LINEAR_WEBHOOK_SIGNATURE_HEADER } from "@linear/sdk/webhooks";

const client = new LinearWebhookClient(secret);          // secret from kv (D-03)
const STALENESS_MS = 60_000;

const readRaw = (req: http.IncomingMessage) => new Promise<Buffer>((resolve, reject) => {
  const chunks: Buffer[] = [];
  req.on("data", c => chunks.push(c as Buffer));
  req.on("end", () => resolve(Buffer.concat(chunks)));   // read ONCE, never re-serialise (T14)
  req.on("error", reject);
});

export const server = http.createServer(async (req, res) => {
  if (req.method !== "POST") { res.statusCode = 405; return res.end("Method not allowed"); }

  const deliveryId = req.headers["linear-delivery"] as string | undefined;   // Finding A2
  const signature  = req.headers[LINEAR_WEBHOOK_SIGNATURE_HEADER] as string | undefined;

  let raw: Buffer;
  try { raw = await readRaw(req); } catch { res.statusCode = 400; return res.end(); }

  const reject = (guard: string, detail?: string) => {
    log.warn({ deliveryId, guard, detail }, "delivery rejected");   // D-09: name the guard
    metrics.selfEventsDropped.inc({ guard });
    res.statusCode = 400;                                            // D-10 / T6: 400, not 401
    res.end("Invalid webhook");
  };

  // G0 — HMAC over the raw bytes. parseData verifies FIRST, then parses (Finding A4).
  let payload;
  try { payload = client.parseData(raw, signature ?? ""); }
  catch (e) { return reject("signature", (e as Error).message); }

  // G1 — HOOK-05. The SDK skips this silently when the field is absent (Unknown 2).
  const ts = payload.webhookTimestamp;
  if (typeof ts !== "number") return reject("timestamp:absent");
  if (Math.abs(Date.now() - ts) > STALENESS_MS) return reject("timestamp:stale", `${Date.now() - ts}ms`);

  // G2 — HOOK-06 / loop layer 4. Synchronous SQLite insert; UNIQUE violation ⇒ replay.
  if (!deliveryId) return reject("delivery-id:absent");
  if (!store.tryInsertDelivery(deliveryId)) {
    log.info({ deliveryId, guard: "delivery-id:replay" }, "duplicate delivery dropped");
    res.statusCode = 200; return res.end("OK");        // 200 — do not burn Linear's retry budget
  }

  // G3–G5 — loop layers 1/2/3. Pure predicates over the verified payload.
  const drop = selfEventGuards(payload);               // {drop, guard} — see Pattern 4
  if (drop.drop) {
    log.info({ deliveryId, guard: drop.guard }, "self-event dropped");
    metrics.selfEventsDropped.inc({ guard: drop.guard });
    res.statusCode = 200; return res.end("OK");
  }

  // ═══ HOOK-08 — ACK HERE. Nothing below this line is awaited. ═══
  res.statusCode = 200;
  res.end("OK");

  setImmediate(() => router.enqueue(payload, deliveryId));   // INTK-05 re-fetches downstream
});
```

### Example 2: What `handler.on()` actually receives — why HOOK-06 forces Example 1

```ts
// Source: live test this session.
const handler = client.createHandler();
handler.on("*", p => { /* p === the parsed payload, and NOTHING else */ });
// keys visible inside handler.on(): action, type, data, webhookTimestamp
// 'linear-delivery' reachable? -> NO. The node adapter reads only
//   `linear-signature` and `linear-timestamp` and discards the rest of `req.headers`.
```

### Example 3: The shared marker constant (D-07)

```ts
// src/shared/markers.ts — ONE definition, imported by BOTH src/ingress/ and Phase 5's outbound.
// Rush mode: Phase 5 is being written in parallel. Record this path in 03-SUMMARY.md
// under "Contract additions requested" so Phase 5 imports this file rather than redefining it.
export const BOT_COMMENT_MARKER = "<!-- law:bot v1 -->";
export const withMarker = (body: string) => `${BOT_COMMENT_MARKER}\n${body}`;
export const hasMarker  = (body: string) => body.startsWith(BOT_COMMENT_MARKER);
```

An HTML comment is chosen because Linear renders markdown and hides it from the reader while leaving it in `payload.data.body`, which is the field the ingress guard reads. `payload.data.body`, `payload.data.parentId` and `payload.data.issueId` are all confirmed present on the `Comment` payload `[VERIFIED: tsc compile]` — `parentId` is what Phase 6 needs for D-05 threaded-answer correlation.

---

## Contract Additions Requested

Per RUSH.md rule 3, these belong in `03-SUMMARY.md`. Recording them here so the planner emits them.

```ts
// src/domain/ports.ts — Store methods this phase calls
tryInsertDelivery(deliveryId: string): boolean;   // false ⇒ UNIQUE violation ⇒ replay (HOOK-06)
kvGet(key: string): string | undefined;           // webhook_id, webhook_secret, poll watermark
kvPut(key: string, value: string): void;

// src/domain/types.ts — the phase boundary output
type DomainEvent =
  | { kind: "issue.assigned";   issueId: string; deliveryId?: string }
  | { kind: "issue.unassigned"; issueId: string; deliveryId?: string }
  | { kind: "comment.created";  issueId: string; commentId: string; parentId?: string; deliveryId?: string };
```

`src/shared/markers.ts` is a **new module outside `src/domain/`** created by this phase and imported by Phase 5. Flag it explicitly for Phase 7 reconciliation.

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | everything | ✓ | v22.23.1 | Meets `>=22`; STACK.md prefers 24 (T15) — not blocking |
| `@linear/sdk` | HOOK-02/03/04 | ✓ | 93.0.1 (installed + executed in scratch) | none needed |
| `@ngrok/ngrok` native binding | TUN-01 | ✓ | 1.7.0, `darwin-arm64` prebuild loads | none needed |
| `NGROK_AUTHTOKEN` | TUN-01 | ✗ **not in env** | — | `~/Library/Application Support/ngrok/ngrok.yml` **exists**; wizard (Phase 8) must lift the token out of it — the SDK will not read it |
| `LINEAR_API_KEY` | HOOK-02 reconcile | ✗ not in env | — | Phase 8 wizard prompt |
| git / gh / claude | other phases | ✓ | 2.50.1 / 2.98.0 / 2.1.259 | — |

**Missing dependencies with no fallback:** none for *writing* this phase. Both secrets are runtime inputs owned by Phase 8; the phase is fully implementable and unit-testable without them.

**Missing with fallback:** `NGROK_AUTHTOKEN` — verified this session that its absence produces `ERR_NGROK_4018`, indistinguishable from a bad account, which is precisely why Pattern 1 checks the variable before calling `connect()`.

---

## Validation Architecture

`nyquist_validation: true` in `.planning/config.json`.

> **RUSH constraint (RUSH.md rule 4):** tests are **written as files and not run**. No task's verification step may be `node --test` or `tsc`. The commands below are what the Phase 7 integration gate will run.

### Test Framework

| Property | Value |
|----------|-------|
| Framework | `node:test` (built-in) — locked by 01-CONTEXT D-12 |
| Config file | none required |
| Quick run command | `node --test test/ingress/` *(gate only — do not run in this phase)* |
| Full suite command | `tsc --noEmit && node --test` *(01-CONTEXT D-13 — Phase 1 creates this script)* |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| TUN-01 | one listener; `url()` null ⇒ fatal | unit (fake tunnel port) | `node --test test/ingress/tunnel.test.ts` | ❌ Wave 0 |
| TUN-02 | close/SIGINT paths invoke teardown | unit | same file | ❌ Wave 0 |
| TUN-03 | missing env var ⇒ own message, not ngrok's | unit | same file | ❌ Wave 0 |
| HOOK-02 | existing id ⇒ `updateWebhook`, never `createWebhook` | unit (fake Linear) | `node --test test/ingress/registrar.test.ts` | ❌ Wave 0 |
| HOOK-02 | **paginated result is not double-counted** (Finding B) | unit — 2 pages × 3 nodes ⇒ expect 6, not 9 | same file | ❌ Wave 0 |
| HOOK-02 | disabled webhook ⇒ `enabled: true` sent (D-02) | unit | same file | ❌ Wave 0 |
| HOOK-03 | secret persisted **before** the remote call | unit — assert store write ordering | same file | ❌ Wave 0 |
| HOOK-04 | valid signature ⇒ 200 | unit (real HMAC over a Buffer) | `node --test test/ingress/receiver.test.ts` | ❌ Wave 0 |
| HOOK-04 | tampered ⇒ **400**, guard `signature` (D-10, T6) | unit | same file | ❌ Wave 0 |
| HOOK-04 | **non-ASCII body ⇒ 200**, and latin1-signed ⇒ 400 (Pitfall 5) | unit | same file | ❌ Wave 0 |
| HOOK-05 | stale ts ⇒ 400, guard `timestamp:stale` | unit | same file | ❌ Wave 0 |
| HOOK-05 | **absent `webhookTimestamp` ⇒ 400**, guard `timestamp:absent` (Unknown 2) | unit | same file | ❌ Wave 0 |
| HOOK-06 | replayed delivery id ⇒ 200, no side effect | unit | same file | ❌ Wave 0 |
| HOOK-08 | **slow downstream ⇒ ACK still < 200 ms** (Pitfall 3) | unit — deferred work sleeps 1200 ms | same file | ❌ Wave 0 |
| HOOK-07 | each of 4 guards drops independently; counter names the guard | unit, table-driven | `node --test test/ingress/guards.test.ts` | ❌ Wave 0 |
| HOOK-07 | **`actor: null` ⇒ dropped** (D-08) | unit | same file | ❌ Wave 0 |
| HOOK-09 | stale ngrok URL pruned; foreign URL untouched | unit | `node --test test/ingress/registrar.test.ts` | ❌ Wave 0 |
| INTK-01 | `assigneeId` in `updatedFrom` ⇒ exactly one pickup | unit | `node --test test/ingress/router.test.ts` | ❌ Wave 0 |
| INTK-01 | later unrelated edit ⇒ **no** pickup (criterion 5) | unit | same file | ❌ Wave 0 |
| INTK-05 | router calls re-fetch; decides from fetched, not payload | unit — fake returns state differing from payload | same file | ❌ Wave 0 |

### Sampling Rate

- **Per task commit:** none — `git commit -n`, no gate (RUSH.md rules 4–5).
- **Per wave merge:** none.
- **Phase gate:** deferred to the milestone integration gate (Phase 7).

### Wave 0 Gaps

- [ ] `test/ingress/tunnel.test.ts` — TUN-01, TUN-02, TUN-03
- [ ] `test/ingress/registrar.test.ts` — HOOK-02, HOOK-03, HOOK-09
- [ ] `test/ingress/receiver.test.ts` — HOOK-04, HOOK-05, HOOK-06, HOOK-08
- [ ] `test/ingress/guards.test.ts` — HOOK-07 (4 layers + null actor)
- [ ] `test/ingress/router.test.ts` — INTK-01, INTK-05
- [ ] `test/ingress/fixtures.ts` — signed-payload builder: takes an object, returns `{raw: Buffer, signature, deliveryId}`. Every receiver test needs it, and it must sign the **exact Buffer** the server will receive (Pitfall 5).

---

## Security Domain

`security_enforcement` is absent from `.planning/config.json` ⇒ enabled.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes | Webhook HMAC is the authentication boundary — `client.parseData()`, timing-safe |
| V3 Session Management | no | No sessions; stateless deliveries |
| V4 Access Control | partial | Actor identity guard (HOOK-07 L1); `createWebhook` requires workspace admin (SUMMARY correction 2) |
| V5 Input Validation | yes | Verify HMAC **before** trusting any field; shape-check with zod after |
| V6 Cryptography | yes | `crypto.randomBytes(32)` for the secret, `randomUUID()` for the id — never hand-roll the HMAC compare |
| V7 Error Handling & Logging | yes | **Secrets must not reach logs** — see Pitfall 4; guard names must reach logs (D-09) |
| V9 Communications | yes | ngrok terminates TLS; the local listener binds loopback only |
| V13 API | yes | 400 on rejection, 200 on dropped-but-valid (never burn Linear's retry budget on our own filtering) |

### Known Threat Patterns

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Forged delivery to a public ngrok URL | Spoofing | HMAC over raw bytes; reject 400 |
| Replay of a captured valid delivery | Spoofing / Tampering | ±60 s window **plus** an absent-field assertion (Unknown 2), plus delivery-ID `UNIQUE` |
| Signature bypass via body re-serialisation | Tampering | Read the stream once; hash the received `Buffer` (T14) |
| Signing secret leaked to logs via `webhooks()` | Information Disclosure | Project `Webhook` before logging; add `secret` to redaction |
| ngrok authtoken echoed in an error message | Information Disclosure | Log only the `ERR_NGROK_nnnn` code (Finding D3) |
| Self-triggered feedback loop draining 2 500 req/hr | DoS (self-inflicted) | Four independent guards + a per-issue circuit breaker |
| Second daemon instance duplicating every event | Tampering / DoS | Client-supplied webhook `id` makes registration singular; instances converge on one row |
| Unicode/control chars in ticket text reaching the agent | Injection | Out of scope here — Phase 4 (AGNT-06). Ingress must not "sanitise" before hashing |
| Timing attack on signature compare | Information Disclosure | `crypto.timingSafeEqual` inside the SDK — do not reimplement |

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `LinearWebhooks` class + manual `verify(body, sig, ts)` | `LinearWebhookClient` from `@linear/sdk/webhooks` | v93 (T5) | Old class removed; code written against it does not compile |
| ngrok CLI subprocess + PID/lockfile | `@ngrok/ngrok` in-process | 2023+ | Orphan tunnels become structurally impossible |
| Framework + raw-body middleware | `node:http`, stream read once | — | Deletes an entire class of signature bug (T14) |
| ngrok free = ephemeral only | free accounts get one permanent dev domain | 2023 | Static pinning is available (`Config.domain`) — **deliberately not used** per D-01 |

**Deprecated/outdated:**
- `LinearWebhooks` — removed in v93.
- `linear.webhookCreate/webhookUpdate/webhookDelete` as *SDK method names* — never existed; they are GraphQL mutation names (Finding C).
- The `ngrok` npm package (distinct from `@ngrok/ngrok`) — unmaintained CLI wrapper.

---

## Project Constraints (from CLAUDE.md)

| Directive | Applies here |
|---|---|
| `@linear/sdk` pinned **exact**, no caret/tilde | Yes — `93.0.1` |
| `typescript@~5.9`, never `latest` (TS7 `tsgo`) | Yes — all snippets verified under 5.9.3 |
| ESM, `"type": "module"` | Yes — `@linear/sdk` is `"type": "module"` |
| **No HTTP framework** — `node:http` only | Yes, upheld. Finding A changes only *which SDK entry point*, never the framework rule |
| Never parse the body before HMAC verification | Yes — `parseData()` verifies first; `createHandler()` does not (Finding A4) |
| `@ngrok/ngrok` in-process; never the CLI | Yes |
| Only `LINEAR_API_KEY` and `NGROK_AUTHTOKEN` are prompted | Yes — the webhook secret is **generated**, never prompted (D-03) |
| Exactly one tunnel per process, enforced structurally | Yes — plus a runtime `listeners().length` assertion |
| No `tsup`/bundling | N/A |
| Reliability posture: best effort, never fragile | Yes — every guard degrades to a logged drop; D-04's poll is the safety net |
| GSD workflow enforcement before file edits | Yes — this is `/gsd-plan-phase --research-phase 3` |

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Linear sends the delivery UUID as the `Linear-Delivery` header (lower-cased `linear-delivery` in Node) | Example 1, HOOK-06 | Verified only from Linear's public docs, not a live delivery — no Linear credentials this session. If the name differs, `deliveryId` is `undefined` and G2 rejects everything. **Mitigation:** log all `req.headers` keys once on the first real delivery. |
| A2 | Linear populates `webhookTimestamp` on every entity delivery | Unknown 2, Pitfall 2 | The field is non-optional in the schema, but the SDK's `if (timestamp)` implies it can be absent. If commonly absent, `timestamp:absent` rejects real traffic. **Mitigation:** the guard is one constant away from being downgraded to a warning. |
| A3 | Linear's webhook auto-disable is reachable via `enabled: false` on the `Webhook` model | D-02, Pattern 2 | Field confirmed to exist; the auto-disable *threshold* is undocumented (PITFALLS notes this). Only affects how often the re-enable path runs, not its correctness. |
| A4 | An HTML comment marker renders invisibly in Linear and survives round-trip in `payload.data.body` | D-07, Example 3 | If Linear strips or rewrites it, loop layer 2 silently becomes dead code — which is exactly what D-09's per-guard counter is designed to expose. |
| A5 | `createWebhook` requires workspace-admin permission | Security V4 | From SUMMARY correction 2 (Linear docs). Untestable without a key. Blocks HOOK-02 at runtime, not at build time; Phase 8's wizard probes it. |
| A6 | The bot authenticated by personal API key appears as `actor.type === "user"` | Pattern 4 | If it appears as `integration` or `oauthClient`, the discriminant check misses and layer 1 goes dead. **Mitigation:** the guard logs the observed `actor.type` on every drop, so one real delivery settles it. |

Items A1, A2 and A6 are all resolvable by a single real delivery against a Linear scratch team. Recommend the plan include one `checkpoint:human-verify` task at the end of the phase that captures one live delivery and confirms all three at once.

---

## Open Questions

1. **Does D-11 survive Finding A?**
   - What we know: the no-HTTP-framework rule is correct and upheld; `createHandler()` specifically cannot satisfy HOOK-05, HOOK-06, HOOK-08, D-09 or D-10's diagnosis need, and its stated rationale (HMAC before JSON parse) is factually inverted.
   - What's unclear: whether the operator locked "no framework" (upheld either way) or "use `createHandler()`" (contradicted).
   - Recommendation: **`checkpoint:human-verify` before the receiver task.** Present the measured 1205 ms ACK and the discarded-header result. Recommend `parseData()` in a plain `node:http` listener.

2. **Where does `src/shared/markers.ts` live so Phase 5 can import it?**
   - What we know: D-07 requires one definition; the ADDENDUM reserves `src/domain/` to Phase 1; Phase 5 must not import `src/ingress/`.
   - What's unclear: Phase 5 is being written in parallel and may create its own.
   - Recommendation: create `src/shared/markers.ts` in this phase and record it in `03-SUMMARY.md` under `Contract additions requested`. Flag the collision risk explicitly for Phase 7.

3. **Who owns the reconciliation poll (D-04/D-05)?**
   - What we know: 03-CONTEXT D-04 assigns it here; REQUIREMENTS maps INTK-07 to **Phase 6**; PITFALLS assigns it to the Scheduler. D-05 says the obligation is "shared with Phase 6 (06-CONTEXT D-06)".
   - What's unclear: three sources, three owners — a real risk of it being built twice or not at all, and D-08's null-actor drop is only safe *because* it exists.
   - Recommendation: Phase 3 owns the **query** (`issues assigned to bot where updatedAt > watermark` → `DomainEvent`) as a pure function in `src/ingress/poll.ts`; Phase 6 owns the **timer** that calls it. Record the exact signature in the SUMMARY.

4. **Per-issue circuit breaker — in scope?**
   - What we know: PITFALLS § Pitfall 1 layer 4 recommends a reaction cap; D-06 names only four guards and does not include it.
   - Recommendation: out of scope. Four guards are locked; adding a fifth unrequested one contradicts D-06. Note it as a backlog item.

---

## Sources

### Primary (HIGH confidence — verified by execution this session)

- `node_modules/@linear/sdk@93.0.1/dist/webhooks-BisgAo6N.mjs` — full `LinearWebhookClient` runtime source: `createHandler`, `parseVerifiedPayload`, `verify`, `parseData`, node/fetch adapters
- `node_modules/@linear/sdk@93.0.1/dist/index-267_t0Tf.d.mts` — `EntityWebhookPayload`, `WebhookCreateInput`, `WebhookUpdateInput`, `LinearWebhookHandler`, `LinearWebhookEventTypeMap`, the four-member actor union, `WebhooksQueryVariables`
- `node_modules/@linear/sdk@93.0.1/dist/index.mjs` — `Connection.fetchNext/_appendNodes`; the literal `fragment Webhook on Webhook` selection set
- **Live `node:http` + `createHandler()` conformance run** — timestamp units (ms vs s), ±60 s boundary at six offsets, 200/400/405/500 matrix, unicode body, latin1-signed negative, 1205 ms ACK measurement, header visibility inside `.on()`
- **Live `node:http` + `parseData()` run** — ACK-first at 3 ms with deferred work, per-guard discrimination, `linear-delivery` captured
- **`tsc 5.9.3 --strict --module NodeNext`** — compiled the full ingress surface (paginate, create, update, delete, `http.createServer(handler)`, typed `.on("Issue")`/`.on("Comment")`); negative-tested `client.webhookCreate` (TS2339) and revealed `Webhook["secret"]` as `string | null | undefined`
- **Three live `@ngrok/ngrok` failure runs** — `ERR_NGROK_4018` / `ERR_NGROK_105`, uniform `GenericFailure`, token echoed in the malformed-token message; `darwin-arm64` binding load
- `node_modules/@ngrok/ngrok@1.7.0/index.d.ts` — `Config.domain`, `Config.authtoken_from_env`, `Listener.url(): string | null`, `listeners()`
- `npm view` + `gsd-tools query package-legitimacy check` — versions, downloads, repos, absent postinstalls

### Secondary (MEDIUM confidence)

- `.planning/research/PITFALLS.md` §§ 1–4 — loop surfaces, registration multiplication, ngrok ceilings. *Corrected here on SDK method names, pagination, and ACK ordering.*
- `.planning/research/SUMMARY.md` — corrections table, non-negotiable invariants, build-order constraints
- `.planning/TRAPS.md` — T5, T6, T10, T14 all re-verified this session; T10's macOS config path corrected

### Tertiary (LOW confidence — not re-verified)

- linear.app/developers/webhooks — `Linear-Delivery` header name, retry schedule (1 min/1 hr/6 hr), 5 000 ms budget, admin requirement for webhook creation, actor nullability. **No Linear credentials available this session** — hence assumptions A1, A2, A5.

---

## Metadata

**Confidence breakdown:**

| Area | Level | Reason |
|------|-------|--------|
| Three assigned unknowns | **HIGH** | All three closed by direct evidence; units proven twice independently |
| SDK API surface | **HIGH** | Every call compiled under `tsc --strict`; negative cases confirmed by compiler errors |
| Receiver behaviour | **HIGH** | Measured against a live server, not read from docs |
| ngrok surface | **HIGH** | Types read + three real failure paths executed |
| Loop-prevention design | **MEDIUM-HIGH** | Guards 1/3/4 verifiable in-process; guard 2 depends on A4 (Linear's markdown handling) |
| Linear delivery semantics | **MEDIUM** | Header name, retry schedule and admin requirement are docs-only — A1, A2, A5 |
| Phase-boundary ownership | **MEDIUM** | Open Question 3 — the poll has three claimed owners across three documents |

**Research date:** 2026-09-06
**Valid until:** **2026-09-13 (7 days).** `@linear/sdk` ships a new major roughly weekly (T8). The exact `93.0.1` pin means the verified surface stays true for this milestone regardless — but any deliberate bump invalidates every `.d.ts` claim above and requires re-running the probes.

---

*Phase: 3-Ingress*
*Researched: 2026-09-06*
