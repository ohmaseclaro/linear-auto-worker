---
phase: 03-ingress
plan: 02
subsystem: ingress
tags: [linear, webhook, reconcile, ngrok, secrets]
requires:
  - src/domain/ports.js (Store, Logger)
  - "@linear/sdk@93.0.1"
provides:
  - "reconcile(client, store, log, tunnelUrl) -> { id, secret, url }"
  - "WEBHOOK_LABEL"
affects:
  - plan 03-01 (supplies the non-null tunnel URL)
  - plan 03-05 (verifies deliveries against the secret returned here)
  - phase 2 logger redaction list
tech-stack:
  added: []
  patterns: [persist-before-remote-call, exhaust-then-read pagination, label-scoped prune]
key-files:
  created:
    - src/ingress/registrar.ts
    - src/ingress/registrar.test.ts
  modified: []
decisions:
  - "Test file lives at src/ingress/registrar.test.ts, not test/ingress/ — see Deviations."
  - "Prune is gated on label AND ngrok URL AND id mismatch, not on the URL shape alone."
metrics:
  duration: ~20m
  completed: 2026-09-06
status: complete
---

# Phase 3 Plan 02: Webhook Registrar Summary

Converges the Linear workspace on one webhook per boot: the signing secret is generated
locally and durable in SQLite before the first outbound byte, ownership is matched on a
client-supplied id that survives an ephemeral URL, and the prune only ever deletes this
daemon's own abandoned ngrok registrations.

## What Was Built

`src/ingress/registrar.ts` exports `reconcile(client, store, log, tunnelUrl)` and
`WEBHOOK_LABEL = "linear-auto-worker"`. Order of operations, all of it load-bearing:

1. `desiredUrl = ${tunnelUrl}/linear/webhook`.
2. `kvGet` id/secret, falling back to `crypto.randomUUID()` / `randomBytes(32).toString("hex")`,
   then `kvPut` both — **before** any call on the client (HOOK-03, D-03).
3. `await client.webhooks({ first: 250 })`, then
   `while (page.pageInfo.hasNextPage) await page.fetchNext();` and read `page.nodes` **once**.
4. `all.find(w => w.id === id)` → absent: `createWebhook({ id, secret, url, enabled: true,
   label, allPublicTeams: true, resourceTypes: ["Issue","Comment"] })`, throwing on
   `!success`. Present: `updateWebhook(id, { url, enabled: true })` — one call, both halves
   of D-02, `enabled` unconditional.
5. Prune: `id !== ours && label === WEBHOOK_LABEL && /\.ngrok(-free)?\.(app|dev|io)(\/|$)/`
   → `deleteWebhook`.

Logging is projected scalars only (`webhookId`, `url`, `wasEnabled`). No `Webhook` object
and no fetched array ever reaches the logger.

## Traps Handled

- **T21** — `createWebhook` / `updateWebhook` / `deleteWebhook`. The GraphQL mutation
  spellings (`webhookCreate` etc.) appear nowhere in non-comment source; the gate greps
  for their absence.
- **T22** — `fetchNext()` mutates and returns `this`. Nodes are read once after the loop,
  never accumulated per iteration. The test's `webhooks()` fake reproduces the same
  mutate-and-return-this semantic, so the six-not-nine assertion is not vacuous.
- **T23** — every `webhooks()` result carries live signing secrets. Nothing derived from a
  `Webhook` is logged wholesale; a test asserts no logged value serialises to any fake
  secret.
- **T35** — no enums, namespaces, or constructor parameter properties.

## Deviations from Plan

**1. [Rule 3 - Blocking] Test file relocated from `test/ingress/` to `src/ingress/`**

- **Found during:** Task 2
- **Issue:** `tsconfig.json` sets `rootDir: "src"` and `include: ["src"]`, and T34 moved the
  verify script to `tsc && node --test dist`. A test written under `test/` is never
  compiled and never executed — it would have been dead code at the milestone integration
  gate, which is the only place this test's value is realised.
- **Fix:** Wrote it to `src/ingress/registrar.test.ts`, matching the convention already
  landed by Phases 1, 2, 6 and 8 (`src/**/**.test.ts`). Did not touch `tsconfig.json`
  (Phase 1 owns it, three siblings are live on this phase).
- **Impact:** Task 2's verify gate greps the `test/` path and will report missing; the
  same gate passes verbatim against the `src/` path.
- **Commit:** 8b4e4db

## Contract additions requested

Needed on the `Store` port in `src/domain/ports.ts` (imported, not authored here):

```ts
kvGet(key: string): string | undefined;
kvPut(key: string, value: string): void;
```

Keys used by this module: `webhook_id`, `webhook_secret`.

Needed on the Phase 2 logger (`src/infra/logger.ts` already exposes
`registerSecret(value: string)` on `LoggerWithSecretRegistration`):

- **The webhook signing secret returned by `reconcile()` must be registered for
  redaction at boot** — `log.registerSecret(reg.secret)` — alongside `linearApiKey` and
  `ngrokAuthtoken`. Pitfall 4 names `secret` and `authtoken` as required redaction-list
  entries.

## Known Stubs

None.

## Threat Flags

None. The register in the plan (`T-03-05` … `T-03-09`) covers the surface this plan adds;
`T-03-09` (workspace-admin requirement on `createWebhook`) remains `accept` — it fails
loudly at runtime and Phase 8's wizard probes it.

## Verification

Not run — rush mode forbids `npm install`, `tsc` and `node --test` on phase branches. Both
static gates were executed:

- Task 1 gate: **PASS** (verbatim).
- Task 2 gate: **PASS** with `test/ingress/registrar.test.ts` → `src/ingress/registrar.test.ts`.

## Self-Check: PASSED

- `src/ingress/registrar.ts` — FOUND
- `src/ingress/registrar.test.ts` — FOUND
- commit eca815c — FOUND
- commit 8b4e4db — FOUND
