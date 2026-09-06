# Phase 3 — Deferred live verification

> **SUPERSEDED — do not run this file directly.**
> Every item below is folded into the milestone's single consolidated checklist,
> `.planning/phases/07-integration-daemon-lifecycle/07-HUMAN-UAT.md`, in the order an
> operator should actually do them. Kept for its reasoning; run the consolidated one.

**Status:** deferred, non-blocking. One item.

This phase ships three assumptions it cannot settle from a test. All three are readable
off **a single real webhook delivery**, so this is one checklist item, not three.

It requires a Linear API key, a scratch team, workspace admin to register a webhook, and
an ngrok authtoken — none of which exist on this branch, and all of which are Phase 8's
wizard to provide. Under this milestone's live-UAT policy the item goes on the checklist
and the phase proceeds. It gates no executor.

---

## Why one delivery and not three

| Assumption | Question | Where the answer is |
|---|---|---|
| **A1** | Is the delivery-correlation header actually named `linear-delivery`? | the request header keys |
| **A2** | Is `webhookTimestamp` populated on every entity delivery? | `typeof payload.webhookTimestamp` |
| **A6** | Does a personal-API-key bot present as the `user` actor variant? | `payload.actor.type` |

All three are fields of the same request. Three separate checks would cost three
deliveries for no extra information.

`logFirstDeliveryShape` in `src/ingress/receiver.ts` emits exactly these three facts,
once per process, on the first delivery that clears the signature guard.

**It logs header KEYS only, never values.** The signature header is a live credential
(T-03-24, Pitfall 4). Do not widen this probe to log header values when reading the
result — paste the key list, not the headers.

---

## Procedure

1. Complete the Phase 8 setup wizard against a **Linear scratch team**, not a real one.
2. Start the worker. It opens its tunnel and registers the webhook.
3. In Linear, assign one issue on that scratch team to the bot user.
4. Read the first log line tagged `first delivery shape (settles A1/A2/A6)`. It carries
   `headerKeys`, `webhookTimestampType` and `actorType`.

One delivery. Record the three values below.

---

## Outcomes and what each one changes

### A1 — `headerKeys` does not contain `linear-delivery`

The assumption is wrong, and **nothing is broken**: the sha256-of-body surrogate id in
`src/ingress/receiver.ts` (G2) is already carrying the traffic, and it dedupes correctly
because Linear's retries resend an identical body. This is why the receiver falls back
rather than rejecting — a wrong header name with a rejecting receiver would drop 100% of
real traffic (T-03-26).

**Fix:** set `DELIVERY_HEADER` in `src/ingress/receiver.ts` to the observed name. The
surrogate path then becomes dead code and can stay as the fallback it is.

**Warning sign if unnoticed:** the one-time `delivery header absent — falling back to
sha256-of-body surrogate id` warning in the log at every boot.

### A2 — `webhookTimestampType` is not `"number"`

The assumption is wrong, and the `timestamp:absent` guard is rejecting **real traffic**
with a 400. This is the one failing outcome that is user-visible: no issue would ever be
picked up.

**Fix:** it is one constant away — downgrade G1's presence assertion from a rejection to a
warning in `src/ingress/receiver.ts`, keeping the `timestamp:stale` comparison for the
deliveries that do carry the field. Do **not** simply delete the guard: T20's silent skip
is what it exists to close.

**Warning sign if unnoticed:** every delivery 400s with guard `timestamp:absent`; the
issue never leaves its original state.

### A6 — `actorType` is not `user`

The assumption is wrong, **loop-prevention layer 1 is dead code**, and layer 2 (the
invisible comment marker) is silently carrying the whole load on comment events. Layers 3
and 4 still work.

**Fix:** widen the discriminant in `src/ingress/guards.ts` — the actor is a four-member
union (`externalUser | integration | oauthClient | user`), all four carrying `id` and
`type`, so the fix is adding the observed variant to the `actorType === 'user'` test.

**Warning sign if unnoticed:** the per-guard counter from plan 03-03 shows
`actor:self` at zero forever while the daemon is demonstrably seeing its own writes.

---

## Record the result

- [ ] **A1** — delivery header name confirmed. Observed `headerKeys`: `______________________`
- [ ] **A2** — `webhookTimestamp` populated. Observed `webhookTimestampType`: `____________`
- [ ] **A6** — bot actor discriminant confirmed. Observed `actorType`: `____________`

---

## What this delivery cannot settle

- **A3** — Linear's undocumented auto-disable threshold (how many consecutive failures
  disable a webhook). Affects only how often the re-enable path in plan 03-02 runs, and is
  not observable from a successful delivery. Left open deliberately.
- **A5** — that webhook *creation* requires workspace admin. Phase 8's wizard probes this
  when it registers, and reports it there; by the time a delivery arrives the question is
  already answered.
