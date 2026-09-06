---
phase: 08-setup-wizard-safety-pass
plan: 02
subsystem: infra
tags: [cli, wizard, secrets, linear-sdk, ngrok, dotenv, inquirer, node-test]

# Dependency graph
requires:
  - phase: 08-01
    provides: "runSetupWizard() orchestrator that composes this plan's functions"
provides:
  - "acquireLinearKey(existingEnv, deps) — skip-if-present, live viewer() validation, webhooks() workspace-admin probe, returns a reusable authenticated LinearClient"
  - "acquireNgrokToken(existingEnv, deps) — skip-if-present, lifts the token VALUE out of ngrok.yml, else prompts"
  - "writeSecretsEnv(envPath, secrets) — merge-safe .env write, chmod 0600 unconditionally"
  - "readSecretsEnv(envPath) — parses an existing .env into the existingEnv both acquire functions take"
  - "maskSecret(secret) — the only sanctioned way to reference a secret in operator-facing output"
  - "SecretResult<T> discriminated union: { ok: true, value } | { ok: false, fix }"
affects: [08-03, 08-05, 03-tunnel-webhook, 05-linear-client]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "SecretResult<T> — never throw at the operator; every failure carries a pre-written `fix` string and never the raw SDK/GraphQL error"
    - "LinearProbe seam: the two LinearClient members the wizard touches, adapted behind an interface so tests drive all branches with zero network"
    - "source discriminator ('existing' | 'process-env' | 'yaml' | 'prompted') tells the caller which values still need persisting to .env"

key-files:
  created:
    - src/cli/wizard/secrets.ts
    - src/cli/wizard/secrets.test.ts
  modified: []

key-decisions:
  - "`viewer` is a GETTER on @linear/sdk v93's LinearClient (`await client.viewer`), not a method — wrapped in a small `LinearProbe` adapter so the calling code reads uniformly and the fake in the test exercises the real adapter"
  - "Linear key source distinguishes 'existing' (.env) from 'process-env'. A key visible only in the wizard's own process.env would otherwise be classed 'existing', never written to .env, and invisible to the daemon process — a silent boot failure"
  - "Added readSecretsEnv() — 08-05 must build the `existingEnv` argument both acquire functions take, and nothing else in the phase produces it"
  - "NGROK_AUTHTOKEN is read only from .env, never from process.env — unlike the Linear key there is no benefit, and a process-only value must land in .env anyway since the SDK reads only the daemon's own environment (T10)"
  - "ngrok.yml is located at the XDG path AND macOS Application Support (where ngrok v3 actually writes on darwin, the operator's platform); D-05 names only the former"
  - "authtoken extracted by regex, not a YAML parser — the key is on its own line whether top-level or nested under `agent:`, and one scalar does not justify a dependency"

patterns-established:
  - "Secret-never-echoed: no console/log call exists in secrets.ts at all; every catch block discards its error object rather than formatting it"
  - "chmod-after-write: writeFile's `mode` option applies only on create, so fs.chmod(0o600) runs unconditionally after every write"

requirements-completed: [SETUP-02, SETUP-03, SETUP-04]

coverage:
  - id: D1
    description: "acquireLinearKey skips prompting for a present key but still re-validates it live (D-04), and returns a reusable authenticated LinearClient"
    requirement: "SETUP-02"
    verification:
      - kind: unit
        ref: "src/cli/wizard/secrets.test.ts — 'an existing .env key is not re-prompted but IS re-validated (D-04)' (written complete, not run per RUSH MODE)"
        status: unknown
    human_judgment: true
    rationale: "No node_modules on this branch under rush-mode fan-out; the live viewer() call is also credential-gated. Determinate only at the milestone integration gate."
  - id: D2
    description: "A valid-but-non-admin Linear key fails the webhooks() probe with a message naming the exact fix, never a raw GraphQL error"
    requirement: "SETUP-03"
    verification:
      - kind: unit
        ref: "src/cli/wizard/secrets.test.ts — 'a valid non-admin key returns the promote-to-admin fix (SETUP-03, D-06)' + 'no failure message ever echoes the key back'"
        status: unknown
    human_judgment: true
    rationale: "Requires a real Member-scoped Linear key against the live API to observe end to end; belongs on the HUMAN-UAT checklist."
  - id: D3
    description: "An ngrok token in ~/.config/ngrok/ngrok.yml is copied by VALUE into .env, never referenced by path (T10)"
    requirement: "SETUP-04"
    verification:
      - kind: unit
        ref: "src/cli/wizard/secrets.test.ts — 'copies the VALUE out of ngrok.yml, never a reference to the file (T10)' (real temp fixture file)"
        status: unknown
    human_judgment: false
  - id: D4
    description: ".env is written at mode 0600 on create AND on merge, preserving unrelated lines and leaving omitted keys untouched"
    requirement: "SETUP-04"
    verification:
      - kind: unit
        ref: "src/cli/wizard/secrets.test.ts — three writeSecretsEnv cases against real temp files, asserting `mode & 0o777 === 0o600`"
        status: unknown
    human_judgment: false

duration: 20min
completed: 2026-09-06
status: complete
---

# Phase 8 Plan 2: Secret Acquisition and Persistence Summary

**Both of the project's secrets acquired with the least possible operator involvement — a present Linear key is re-validated rather than re-typed and its workspace-admin permission probed with a message naming the exact fix, an ngrok token already in `ngrok.yml` is copied into `.env` by value, and the resulting `.env` is 0600 after every write.**

## Performance

- **Duration:** ~20 min
- **Completed:** 2026-09-06
- **Tasks:** 2 (4 commits — RED/GREEN split preserved)
- **Files modified:** 2 (both created)

## Accomplishments

- `acquireLinearKey()`: a key already in `.env` (or `process.env`) is never re-prompted, but is still put through `viewer()` and a `webhooks({first:1})` admin probe on every wizard run — D-04's requirement that a key revoked or demoted since last setup fails here rather than at first webhook registration. The two failure modes produce two distinct, pre-written `fix` strings; the raw SDK/GraphQL error is discarded in both cases. On success the authenticated `LinearClient` is returned so 08-03 can list teams and projects without re-prompting or re-validating.
- `acquireNgrokToken()`: skip → yaml → prompt, in that order. The yaml branch extracts the token **value** and returns it for persistence into `.env` — T10 is the whole reason the function exists, since `@ngrok/ngrok` reads neither that file nor anything but the process environment, and a path-reference here would fail at tunnel-open with an auth error that names nothing.
- `writeSecretsEnv()` / `readSecretsEnv()`: line-by-line merge that preserves unrelated lines a later phase may add, followed by an unconditional `chmod(0o600)` — `writeFile`'s `mode` option applies only when the file is created, so a `.env` that already existed at 0644 would otherwise stay world-readable after a merge (T-08-05).
- 18 `node:test` cases covering every branch of all four functions, using real temp files for the yaml and `.env` paths and a hand-rolled `LinearClient` fake that mirrors the SDK's getter/method shape.

## Task Commits

Each task committed with `git commit -n` per RUSH MODE, RED before GREEN:

1. **Task 1 (RED): failing tests for the Linear key branches** — `45082dc` (test)
2. **Task 1 (GREEN): `acquireLinearKey`** — `a93e3db` (feat)
3. **Task 2 (RED): failing tests for ngrok acquisition and `.env` persistence** — `df19a18` (test)
4. **Task 2 (GREEN): `acquireNgrokToken` + `writeSecretsEnv`/`readSecretsEnv`** — `145f280` (feat)

Both gates are present in `git log` in the correct order. Neither RED state was *observed* — RUSH MODE forbids running `node --test` on this branch — so the split is a record of authoring order, not of a verified failure.

## Files Created/Modified

- `src/cli/wizard/secrets.ts` (243 lines) — `SecretResult<T>`, `maskSecret()`, `LinearProbe` + adapter, `acquireLinearKey()`, `NGROK_YAML_PATHS`, `acquireNgrokToken()`, `readSecretsEnv()`, `writeSecretsEnv()`
- `src/cli/wizard/secrets.test.ts` (295 lines) — 18 `node:test` cases; written complete, not run (RUSH MODE)

## Decisions Made

- **`client.viewer` is a getter, not a method.** In `@linear/sdk` v93 the documented usage is `await client.viewer` — `client.viewer()` is a `TypeError`. Rather than scatter that asymmetry through the flow, the two members are adapted behind a `LinearProbe` interface (`viewer()`, `webhooks()`), which doubles as the test seam. The fake in `secrets.test.ts` defines `viewer` as a getter too, so the adapter itself is under test.
- **`source` distinguishes `'existing'` from `'process-env'`.** The plan's behavior text used a single `'existing'` marker, and `writeSecretsEnv` is specified never to rewrite an `'existing'` value. A Linear key present only in the wizard's own `process.env` would then be classed existing, never written to `.env`, and completely invisible to the daemon process at boot — a silent, hard-to-attribute failure. The extra source value lets 08-05 persist it correctly.
- **No `process.env` fallback for `NGROK_AUTHTOKEN`.** It buys nothing: the token must reach `.env` regardless, because `@ngrok/ngrok` reads only the daemon's own environment (T10) and the daemon is a different process from the wizard.
- **Both ngrok config locations are checked.** D-05 names `~/.config/ngrok/ngrok.yml`; ngrok v3 on macOS actually writes `~/Library/Application Support/ngrok/ngrok.yml`, and the operator is on darwin. Both are in `NGROK_YAML_PATHS`, XDG first.
- **Empty prompt answers are rejected here.** T25: an empty or whitespace `NGROK_AUTHTOKEN` reaches `@ngrok/ngrok` as `code: "GenericFailure"`, byte-identical to having no credential at all. The pre-check the trap calls for lives at the only place that can still name a fix.

## Trap Compliance

| Trap | How this plan complies |
|------|------------------------|
| **T8/T9** | No hand-rolled auth header — `new LinearClient({ apiKey })` sets the no-`Bearer` personal-key header itself. No version range is written by this plan. |
| **T10** | `acquireNgrokToken` returns the token **value** from `ngrok.yml`, and `writeSecretsEnv` puts it in `.env`. Nothing anywhere returns or stores the yaml path as a credential. Wiring `authtoken_from_env` is Phase 3's, not this plan's. |
| **T23** | The `webhooks({first:1})` result is discarded immediately and never bound, logged, or returned. Its `WebhookFragment` carries every webhook's signing secret. |
| **T24** | No ngrok call is made in this plan, and there is **no logging call of any kind** in `secrets.ts` — `grep -n "console\.\|log\." src/cli/wizard/secrets.ts` returns nothing. Every `catch` discards its error rather than formatting it, so no error message can carry a token to disk. |
| **T25** | The empty-token pre-check above. Also the reason `acquireNgrokToken` fails with a named fix rather than deferring to the tunnel's indiscriminable error. |
| **T-08-04/05/06/07** | `password({ mask: true })` for both prompts; unconditional `chmod 0600`; yaml read errors swallowed as "not found" without echoing the file; fixed `fix` strings instead of relayed GraphQL text. |

## Deviations from Plan

### Auto-added

**1. [Rule 2 — Missing critical functionality] `readSecretsEnv(envPath)`**
- **Found during:** Task 2
- **Issue:** Both acquire functions take `existingEnv: Record<string,string>`, and 08-05's plan composes them without producing that argument — nothing in the phase parses the existing `.env`. Without it, 08-05 would either invent its own parser (divergent from `writeSecretsEnv`'s format) or pass `{}` and re-prompt on every run, defeating D-04/SETUP-04 outright.
- **Fix:** Exported `readSecretsEnv(envPath): Promise<Record<string,string>>` sharing the same `ENV_LINE` regex as the writer, returning `{}` for a missing file.
- **Files modified:** `src/cli/wizard/secrets.ts`, `src/cli/wizard/secrets.test.ts`
- **Committed in:** `145f280`

**2. [Rule 2 — Missing critical functionality] `'process-env'` source value for the Linear key**
- **Found during:** Task 1
- **Issue:** As described under Decisions — the plan's single `'existing'` marker combined with "never re-write a value whose source was `'existing'`" loses a `process.env`-only key before the daemon ever sees it.
- **Fix:** `LinearKeySource = 'existing' | 'process-env' | 'prompted'`; only `'existing'` means "already in `.env`, do not persist".
- **Files modified:** `src/cli/wizard/secrets.ts`, `src/cli/wizard/secrets.test.ts`
- **Committed in:** `a93e3db`

**3. [Rule 2 — Missing critical functionality] macOS ngrok config path**
- **Found during:** Task 2
- **Issue:** D-05 and the plan name only `~/.config/ngrok/ngrok.yml`. ngrok v3 on darwin writes `~/Library/Application Support/ngrok/ngrok.yml`; on the operator's own machine the documented path will typically not exist, so the "skip the prompt" path would never fire.
- **Fix:** `NGROK_YAML_PATHS` holds both, XDG first, tried in order.
- **Files modified:** `src/cli/wizard/secrets.ts`
- **Committed in:** `145f280`

---

**Total deviations:** 3 auto-added (Rule 2), 0 bugs, 0 architectural.
**Impact on plan:** Additive only. Every signature the plan specified exists with the specified name and semantics.

## Issues Encountered

None blocking. One thing worth flagging to Phase 7's integration gate: `@linear/sdk`'s `viewer` getter shape was established from documentation and the research notes, not from a `.d.ts` on this branch (no `node_modules` exists here). If the integration gate finds `viewer` is callable after all, the fix is one line inside `probeFromClient` — the rest of the module is insulated from it by design.

## Contract additions requested

**1. A canonical config-root path constant in `src/domain/`.**

The ADDENDUM fixes the config root as `~/.linear-auto-worker/` holding `config.json`, `.env` (0600), the SQLite database, and logs — but names no symbol for it. This plan takes `envPath` as a parameter rather than inventing one, which means 08-05 (and the daemon, which must read the same `.env`) will each derive the path independently. Requested:

```ts
// src/domain/types.ts (or a new src/domain/paths.ts)
export const CONFIG_ROOT: string;   // join(homedir(), '.linear-auto-worker')
export const CONFIG_PATH: string;   // join(CONFIG_ROOT, 'config.json')
export const ENV_PATH: string;      // join(CONFIG_ROOT, '.env')
export const DB_PATH: string;       // join(CONFIG_ROOT, 'runs.db')
```

No other `src/domain/` type was needed: secret acquisition is upstream of `Config`, which 08-05 assembles.

## Notes for 08-05 (the composing orchestrator)

- Call `readSecretsEnv(envPath)` once, pass the result to both acquire functions.
- Pass to `writeSecretsEnv` **only** the secrets whose `source !== 'existing'`. Passing an `'existing'` value is harmless (the merge is idempotent), but omitting the `'process-env'` / `'yaml'` / `'prompted'` ones is not — the daemon would boot without them.
- On `{ ok: false }`, print `result.fix` and halt. Never print, log, or interpolate the key or token itself; use `maskSecret()` if a confirmation line needs to reference one.

## User Setup Required

None in this plan — the operator is prompted at wizard runtime, which is the feature.

## Next Phase Readiness

- 08-03 can take `acquireLinearKey`'s returned `linearClient` straight into `listMappingCandidates()` / `buildMappings()` — it is authenticated and already admin-confirmed.
- 08-05 has all four functions it composes, plus `readSecretsEnv` for the argument the plan did not otherwise produce.
- Phase 3 can rely on `NGROK_AUTHTOKEN` being present in `.env` as a real value before `authtoken_from_env: true` is set.
- Blocker: none. All verification here is structural per RUSH MODE; the 18-case suite runs at the milestone integration gate.

## Self-Check: PASSED

Both created files confirmed present on disk (`src/cli/wizard/secrets.ts`, `src/cli/wizard/secrets.test.ts`). All 4 commit hashes (`45082dc`, `a93e3db`, `df19a18`, `145f280`) confirmed in `git log --oneline --all`. Both tasks' structural `<verify>` greps re-run and passing.

---
*Phase: 08-setup-wizard-safety-pass*
*Completed: 2026-09-06*
