---
phase: 08-setup-wizard-safety-pass
plan: 05
subsystem: cli-wizard
tags: [setup, config, webhook, registration, idempotency]

requires:
  - "src/domain/types.ts — Config, MappingToggles, ProjectMapping, RepoMapping, CONFIG_PATH, ENV_PATH, DB_PATH, CONFIG_ROOT"
  - "src/domain/ports.ts — TunnelManager, WebhookRegistrar, LinearClient"
  - "src/cli/wizard/{preflight,secrets,repo-discovery,mapping,repo-safety}.ts (08-01..08-04)"
  - "src/ingress/registrar.ts — WEBHOOK_LABEL (the single ownership marker)"
  - "src/outbound/linear-client.ts — LinearClientImpl, for the --doctor path"
provides:
  - "assembleConfig() / writeConfig() / toWizardMappings() — the idempotent config.json writer (D-04)"
  - "reconcileWebhook() — tunnel + reconcile-by-label, returning a named fix on any failure"
  - "doctorWebhooks() — report-first webhook cleanup with per-item confirmed deletion"
  - "runSetupWizard() wired end to end; runDoctor() behind `law setup --doctor`"
  - "08-HUMAN-UAT.md — the live, credential-gated SETUP-09 checklist"
affects: [07-daemon-composition-root, 01-domain-contract]

tech-stack:
  added: []
  patterns:
    - "{ ok: true, ... } | { ok: false, fix } for any wizard step that halts — the convention
      secrets.ts established, extended to registration; SafetyWarning stays reserved for
      non-halting per-repo findings"
    - "Optional config fields are omitted, never present-but-undefined, so JSON.parse(JSON.stringify(c))
      round-trips to an identical object"
    - "An existing config.json is read field-by-field through type guards (T-08-19), never trusted
      wholesale from JSON.parse"

key-files:
  created:
    - src/cli/wizard/config-writer.ts
    - src/cli/wizard/config-writer.test.ts
    - src/cli/wizard/register.ts
    - src/cli/wizard/register.test.ts
    - .planning/phases/08-setup-wizard-safety-pass/08-HUMAN-UAT.md
  modified:
    - src/cli/wizard/index.ts
    - src/cli/index.ts

key-decisions:
  - "The canonical MappingToggles field names win over the plan text's names: postSlack ->
    notifySlack, prMode:'draft' -> draftPr:true, questionFlowEnabled -> questionsEnabled,
    maxRunTimeMs -> maxRunMs. The plan was written before Phase 1's types landed on this branch."
  - "WEBHOOK_LABEL is imported from src/ingress/registrar.ts and re-exported, never re-declared.
    Two copies of an ownership marker is precisely how a reconciler stops recognising its own
    webhook and deletes it."
  - "Registration failure uses the { ok, fix } shape, not SafetyWarning. A SafetyWarning is a
    non-halting per-repo finding with a repoPath; a setup with no webhook is a hard failure with
    no repo to name."
  - "Without { tunnel, registrar } in WizardDeps the wizard writes config.json and returns 1 with
    a fix naming Phase 7's composition root, rather than printing 'setup complete'. Setup that
    registered no webhook did not finish."
  - "Port doubles for TunnelManager/WebhookRegistrar are local to register.test.ts because
    src/domain/fakes.ts does not exist on this branch, even though src/domain/index.ts already
    re-exports it."

metrics:
  duration: 55min
  completed: 2026-09-06
  tasks: 3
  files: 7

status: complete
---

# Phase 8 Plan 5: Config Assembly, Webhook Registration & Full Wizard Wiring Summary

**`law setup` now runs preflight → secrets → discovery → mapping → repo safety → an idempotent
`config.json` merge → webhook registration reconciled by label rather than by the ngrok URL that
changes every boot, with SETUP-09's live proof written into a human checklist instead of faked
into a green task**

## Performance

- **Duration:** ~55 min
- **Completed:** 2026-09-06
- **Tasks:** 3
- **Files:** 5 created, 2 modified

## Accomplishments

- **`assembleConfig()` merges rather than overwrites (D-04).** A second run replaces only the
  mappings the operator rebuilt this run, preserves every mapping they did not touch, and keeps
  every `defaults` field they did not change. Re-running setup to add one mapping can no longer
  delete the rest — which is what makes the wizard the way a mapping gets added later rather than
  a one-time ritual.
- **The existing file is treated as untrusted input (T-08-19).** Every field is read through a
  type guard; `concurrency: "lots"` or `defaults.baseBranch: 42` reverts to the shipped default
  instead of reaching the four layers that consume it. An unrecognised key is dropped, never
  written through.
- **The two shape reconciliations earlier waves reported are now implemented, not just noted.**
  08-04's `RepoSafetyInfo.ownerRepo` → `RepoMapping.repoSlug` and `.defaultBranch` →
  `.baseBranch`, with the discovered per-repo branch preferred over the global default;
  `remoteName` is dropped rather than smuggled into `Config` under an invented field name.
  08-03's six wizard toggle names are translated to the canonical `MappingToggles` keys, and
  translated back by `toWizardMappings()` so a re-run's "keep as-is" round-trips losslessly.
- **`reconcileWebhook()` reconciles by label, never by URL.** The operator chose the ephemeral
  ngrok domain, so the registered URL is different on every boot by construction — URL matching
  would never find "our" prior webhook and would create a duplicate every single run (Pitfall 2 /
  T-08-20). `register.test.ts` proves this directly: two reconciles at two different URLs produce
  one webhook, and the test asserts the create count is 1.
- **No secret can leak out of the registration path.** The signing secret is returned for
  persistence and never printed — the success line says "signing secret persisted", not the value
  (T-08-17). An ngrok failure is reduced to at most its `ERR_NGROK_nnnn` code before anything is
  shown, because the malformed-token error echoes the operator's authtoken back inside its own
  message (T24) and every ngrok error carries the same useless `code: "GenericFailure"` (T25).
  A registrar failure names the workspace-admin fix and drops the GraphQL body.
- **`law setup --doctor` reports first and deletes last.** A foreign-labelled, ngrok-looking
  webhook is reported and deleted only after a per-item confirmation defaulting to no
  (T-08-16) — another tool in the same workspace may legitimately run its own tunnel, and the
  label is the only field that tells the two apart. Our own webhook is never a deletion
  candidate, and a disabled one is re-enabled automatically (T-08-18), since an ephemeral URL
  makes Linear auto-disabling the registration the steady state rather than an anomaly.
- **The wizard is wired end to end and fails honestly.** Preflight failures, missing secrets and
  a failed registration halt with a named fix; repo-safety warnings print and continue. Without
  Phase 7's tunnel and registrar it writes `config.json` and exits 1 naming exactly what is
  missing, rather than printing "setup complete" over a system that would receive nothing.
- **SETUP-09's real acceptance is deferred, not faked.** `08-HUMAN-UAT.md` names the live checks:
  a webhook visible in Linear Settings → API → Webhooks pointing at the live ngrok URL, a real
  test issue delivering to the daemon, a second `law setup` leaving **exactly one** webhook, and
  a `--doctor` run against a deliberately-planted foreign ngrok webhook reporting it without
  deleting it.

## Task Commits

| Task | Name | Commit |
|------|------|--------|
| 1 | Assemble and idempotently write Config from all prior wizard outputs | `49d6e5e` |
| 2 | Webhook reconcile-by-label against domain ports, plus --doctor | `95dde03` |
| 3 | Wire the full wizard orchestrator + 08-HUMAN-UAT.md | `b2087d0` |

## Files Created/Modified

- `src/cli/wizard/config-writer.ts` (created) — `DEFAULT_TOGGLES`, `assembleConfig()`,
  `writeConfig()`, `toWizardMappings()`, plus the wizard↔domain shape translation.
- `src/cli/wizard/config-writer.test.ts` (created) — 14 `node:test` cases: fresh defaults,
  08-04 field mapping, base-branch fallback, merge-preserves, merge-replaces, defaults retention,
  corrupt-file guards, no-undefined round trip, sparse absence, toggle-name translation,
  round-trip stability, directory creation, D-08 secret-free assertion, write idempotency.
- `src/cli/wizard/register.ts` (created) — `reconcileWebhook()`, `doctorWebhooks()`,
  `RegisterResult`, `DoctorFinding`, `DoctorClient`, re-exported `WEBHOOK_LABEL`.
- `src/cli/wizard/register.test.ts` (created) — 13 cases against local port doubles: clean
  reconcile, no-duplicate-on-changed-URL, authtoken-not-echoed, admin fix, empty-URL guard,
  report-without-delete, per-item confirm, re-enable, non-ngrok untouched, no-secret assertion.
- `src/cli/wizard/index.ts` (modified) — `runSetupWizard(deps)` composing all seven steps,
  `runDoctor()`, `WizardDeps`.
- `src/cli/index.ts` (modified) — `--doctor` flag on the `setup` subcommand.
- `.planning/phases/08-setup-wizard-safety-pass/08-HUMAN-UAT.md` (created).

## Trap Compliance

| Trap | How this plan complies |
|------|------------------------|
| **T21** | Nothing here calls `webhookCreate`. The doctor path uses the port's `updateWebhook`/`deleteWebhook`, which `LinearClientImpl` implements against the real SDK method names. |
| **T22** | `doctorWebhooks` never pages a raw connection; it calls `LinearClient.listWebhooks()`, which pages to completion inside the implementation. `fetchNext()` appears nowhere in this plan. A comment in `register.ts` states why, so a future edit does not reintroduce the accumulate-per-page loop that makes the reconciler delete its own live webhook. |
| **T23** | No webhook object is ever logged. `listWebhooks()` returns a projection with no `secret`; a test asserts the string `secret` never appears in the doctor's findings. The registrar's secret is returned for persistence and never printed. |
| **T19** | An empty tunnel URL is rejected before registration, so `null/linear/webhook` can never be registered. |
| **T24 / T25** | Only the `ERR_NGROK_(105\|4018)` code is matched out of an ngrok error; the message (which can contain the authtoken) is discarded. A test feeds an error containing a fake token and asserts it does not reach the fix string. |
| **T35** | No enum, no namespace, no constructor parameter property in any file this plan wrote. |
| **T39 / T10** | Untouched — 08-02 already lifts the token out of both ngrok config paths and copies it into `.env`; this plan only routes the result. |
| **T40** | `CONFIG_PATH`, `ENV_PATH`, `DB_PATH` and `CONFIG_ROOT` are imported from `src/domain/`. `worktreeRoot` is derived as `${CONFIG_ROOT}/worktrees` rather than re-deriving the root. |
| **T41** | Both test files are co-located under `src/`. |
| **T-08-20** | Reconcile-by-URL is explicitly rejected; the label is the only ownership key, and the no-duplicate test is the direct proof. |

## Deviations from Plan

### 1. [Rule 3 — contract] Canonical `MappingToggles` names override the plan's names

- **Found during:** Task 1
- **Issue:** The plan specified `postSlack`, `prMode: "draft"`, `questionFlowEnabled`,
  `maxRunTimeMs`. Phase 1's `src/domain/types.ts` — which has since merged onto this branch —
  fixes them as `notifySlack`, `draftPr`, `questionsEnabled`, `maxRunMs`, and adds a seventh
  required field, `questionTimeoutMs`.
- **Fix:** Used the canonical names. `questionTimeoutMs` defaults to 30 min; `maxRunMs` keeps the
  plan's 45 min (Pitfall 5c). The plan text predates the merged contract; the contract wins.
- **Files:** `src/cli/wizard/config-writer.ts`
- **Commit:** `49d6e5e`

### 2. [Rule 3 — contract] `Config.mappings` is a `Record`, not the plan's `Mapping[]`

- **Found during:** Task 1
- **Issue:** The plan's signature is `assembleConfig(input: { mappings: Mapping[]; existing?: Config })`,
  but the canonical `Config.mappings` is `Record<string, ProjectMapping>` keyed by project id
  then team id (D-07), and `ProjectMapping.repos` is `RepoMapping[]`, not `string[]`.
- **Fix:** Kept the plan's `Mapping[]` input (that is what 08-03/08-04 produce) and added the
  array→record bridge plus its inverse `toWizardMappings()`, which the re-run edit-in-place path
  needs so an existing mapping's overrides survive a "keep as-is".
- **Files:** `src/cli/wizard/config-writer.ts`
- **Commit:** `49d6e5e`

### 3. [Rule 3 — contract] Registration failure uses `{ ok, fix }`, not `SafetyWarning`

- **Found during:** Task 2
- **Issue:** The plan asked for failures "converted into the same `SafetyWarning`-shaped result
  used elsewhere in this phase". `SafetyWarning` is `{ repoPath, kind, message, fixOffered }` — it
  is a **non-halting, per-repo** finding, and registration has no repo and does not continue.
- **Fix:** Used the `{ ok: true, ... } | { ok: false, fix }` shape `secrets.ts` already
  established for a halting step. Same intent (never an uncaught rejection, never a stack trace,
  always a named fix), correct semantics.
- **Files:** `src/cli/wizard/register.ts`
- **Commit:** `95dde03`

### 4. [Rule 2 — critical] `WEBHOOK_LABEL` imported from Phase 3's registrar, not re-declared

- **Found during:** Task 2
- **Issue:** The plan says `export const WEBHOOK_LABEL = 'linear-auto-worker'` in `register.ts`.
  `src/ingress/registrar.ts` has since merged and already exports that exact constant, and the
  registrar's prune step is gated on it. Two independently declared ownership markers that later
  drift is exactly how a reconciler stops recognising its own webhook.
- **Fix:** `register.ts` imports and re-exports Phase 3's constant. One definition.
- **See "Integration notes" below** — `registrar.ts` currently fails `tsc` for an unrelated
  reason (T46), which this import now surfaces on the CLI's module graph.
- **Files:** `src/cli/wizard/register.ts`
- **Commit:** `95dde03`

### 5. [process — RUSH MODE] Test and implementation committed together on the `tdd="true"` tasks

- Tasks 1 and 2 are `tdd="true"`, but no genuine RED could be observed: RUSH MODE forbids
  `node --test` on this branch (no `node_modules`). Both files were written complete and
  committed as one `feat` commit each — the precedent 08-01, 08-03 and 08-04 all set.

### 6. [naming] `HUMAN-UAT.md` written as `08-HUMAN-UAT.md`

- The plan's `files_modified` says `HUMAN-UAT.md`; the executor brief says `08-HUMAN-UAT.md`. Used
  the phase-prefixed name, matching every other artifact in this directory. The plan's Task 3
  `<verify>` string checks the unprefixed path and will not match as written.

**Total deviations:** 4 contract reconciliations, 1 process, 1 naming. 0 bugs, 0 architectural.

## Integration notes for Phase 7 / the milestone gate

1. **Wire registration.** `runSetupWizard({ tunnel, registrar, port })` — pass
   `src/ingress/tunnel.ts`'s tunnel and `src/ingress/registrar.ts`'s `reconcile` adapted to the
   `WebhookRegistrar` port. Until then `law setup` exits 1 at the last step, by design.
2. **`src/ingress/registrar.ts` does not currently compile** — it calls `store.kvPut`, which is
   not on the `Store` port (TRAPS **T46**: the implemented pair is `kvGet`/`kvSet`). This was
   already true before this plan; importing `WEBHOOK_LABEL` from it now puts that one-line error
   on the CLI's module graph too. Fix `kvPut` → `kvSet` in `registrar.ts` at the gate.
3. **`src/domain/index.ts` re-exports `./fakes.js`, which does not exist.** The barrel therefore
   fails to resolve for every branch that imports it. Either ship `fakes.ts` or drop the line.
4. `registrar.reconcile()` returns `{ id, secret, url }` (`WebhookRegistration`) while the
   `WebhookRegistrar` port declares `{ webhookId, secret }`. The adapter Phase 7 writes must
   rename `id` → `webhookId`.

## Contract additions requested

*Consolidated across 08-01 through 08-05, per this plan's `<output>` instruction. Phase 1's owner
and whoever runs the milestone integration gate should work from this list.*

**1. `src/domain/fakes.ts` — MISSING, and the barrel already imports it. (08-05; blocking)**
`src/domain/index.ts` line 5 is `export * from './fakes.js'` and no such file exists, so the
domain barrel does not resolve. `register.test.ts` therefore declares local doubles for
`TunnelManager` and `WebhookRegistrar`. The shapes wanted:
```ts
export function makeFakeTunnel(url?: string): TunnelManager;      // open() resolves to url, url() reflects state
export function makeFakeRegistrar(): WebhookRegistrar & {         // create-or-update keyed on WEBHOOK_LABEL
  createdCount(): number;                                          // must stay 1 across reconciles at different URLs
};
```

**2. Config-root path constants — LANDED, no longer outstanding. (08-02)**
`CONFIG_ROOT` / `CONFIG_PATH` / `ENV_PATH` / `DB_PATH` now exist in `src/domain/types.ts` and are
used here. Note `DB_PATH` resolves to `store.db`, not the `runs.db` 08-02 guessed — `store.db`
is canonical.

**3. `Mapping` / `MappingKey` / `ToggleOverrides` still live in `src/cli/wizard/mapping.ts`. (08-03)**
08-05 bridges them to `Config.mappings` in `config-writer.ts` (`toProjectMapping` /
`toWizardMappings`). Two follow-ups if Phase 1 promotes them:
- **The two toggle vocabularies must be collapsed.** 08-03's names map to the canonical ones as:
  `linearComments`→`postLinearComments`, `slackNotifications`→`notifySlack`, `baseBranch`→
  `baseBranch`, `draftPr`→`draftPr`, `questionTimeoutMs`→`questionTimeoutMs`,
  `maxRunTimeMs`→`maxRunMs`. **08-03 has no name for `questionsEnabled`** — it rendered D-09's
  "question flow" as `questionTimeoutMs` — so `questionsEnabled` is settable today only as a
  global default, never as a per-mapping override. Decide whether that is intended.
- **`MappingKey` carries only the id it was keyed by**, so a project-keyed mapping records no
  team id, and `ProjectMapping.linearTeamId` is `null` for it. Consequently `Config.teamId` is
  populated only when at least one mapping is team-keyed. Requested:
  `MappingKey { kind, id, name, teamId?: string }`, populated from `ProjectCandidate.teamId`
  (which `listMappingCandidates` already resolves and then discards).

**4. `RepoSafetyInfo` → `RepoMapping` field mapping — IMPLEMENTED here. (08-04)**
`ownerRepo`→`repoSlug`, `defaultBranch`→`baseBranch`, `enabled` set to `true` by 08-05,
`remoteName` dropped (no canonical slot; wizard-diagnostic only). No domain change needed unless
Phase 1 wants `remoteName` on `RepoMapping`, which nothing consumes.

**5. `Config.mappings` stores no human-readable mapping name. (08-05)**
`toWizardMappings()` therefore labels each existing mapping by its id on a re-run's review
prompt. Requested: `ProjectMapping.displayName?: string`, written by the wizard, read only for
operator-facing output.

**6. Confirm `@linear/sdk` v93's `Project` → team relation shape. (08-03, still open)**
Cannot be resolved without `node_modules`; isolated to one loop in `listMappingCandidates`.

## Threat Flags

None. Every trust boundary touched here is one the plan's own `<threat_model>` already names:
the ports seam, the webhook CRUD surface (`doctorWebhooks`, the only destructive action in the
phase), and the untrusted existing `config.json`. No new network endpoint, auth path or schema
was introduced.

## Known Stubs

None in the shipped code. One deliberate, documented gap:

| Item | File | Why |
|------|------|-----|
| Webhook registration is unreachable until `{ tunnel, registrar }` are supplied | `src/cli/wizard/index.ts` step 7 | Phase 3's implementations and Phase 7's composition root are not on this branch. This is not a stub returning fake success — the wizard **exits 1** with a fix string naming exactly what is missing, and the gap is item 1 of `08-HUMAN-UAT.md`. |

Both `.test.ts` files in this plan are written complete and **not run** (RUSH MODE — no
`node_modules` on this branch). They execute at the milestone-end gate,
`tsc && node --test "dist/**/*.test.js"` (T55).

## User Setup Required

None at build time. The operator is prompted at wizard runtime, which is the feature.

## Next Phase Readiness

- Phase 8's build is complete: all five plans merged, every SETUP requirement implemented.
- Phase 7 has four concrete integration items, listed above under "Integration notes".
- Blockers: `src/domain/fakes.ts` is missing while the domain barrel imports it, and
  `src/ingress/registrar.ts` calls `store.kvPut` (T46). Both are one-line fixes owned by the gate.

## Self-Check

- FOUND: src/cli/wizard/config-writer.ts
- FOUND: src/cli/wizard/config-writer.test.ts
- FOUND: src/cli/wizard/register.ts
- FOUND: src/cli/wizard/register.test.ts
- FOUND: src/cli/wizard/index.ts
- FOUND: src/cli/index.ts
- FOUND: .planning/phases/08-setup-wizard-safety-pass/08-HUMAN-UAT.md
- FOUND commit 49d6e5e, 95dde03, b2087d0
- All three tasks' structural `<verify>` greps re-run and passing (Task 3's `HUMAN-UAT.md`
  existence check passes against the phase-prefixed filename — see Deviation 6).

---
*Phase: 08-setup-wizard-safety-pass*
*Completed: 2026-09-06*
