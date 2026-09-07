---
task: nz9 — `law setup` cannot complete, and writes a config its own loader rejects
type: quick
gate: npm run verify
files_modified:
  - src/ingress/tunnel.ts
  - src/ingress/tunnel.test.ts
  - src/ingress/registrar.ts
  - src/ingress/registrar.test.ts
  - src/infra/config.ts
  - src/infra/config.test.ts
  - src/cli/daemon.ts
  - src/cli/wizard/register.ts
  - src/cli/wizard/register.test.ts
  - src/cli/wizard/index.ts
  - src/cli/wizard/index.test.ts
  - src/cli/wizard/mapping.ts
  - src/cli/wizard/mapping.test.ts
  - src/cli/wizard/config-writer.ts
  - src/cli/wizard/config-writer.test.ts
  - src/domain/types.ts
  - README.md
---

# Four defects from one live `law setup`

All four were found on a single first run against a real Linear workspace. The run ended at
step 7 with `REGISTRATION_NOT_WIRED_FIX` and left behind a `config.json` that `loadConfig`
throws on, at mode 0644, holding a live Slack webhook URL, with `teamId: ""`.

Order below is P0-first, with one exception stated in D0.

## Decisions

**D0 — the P2 `teamId` fix is pulled forward to task 2.** The operator's failing run has
**project-keyed** mappings and `teamId: ""`. Webhook registration (task 3) calls
`webhookTeamId(config)`, which today throws for exactly that shape. So the P2 is a
prerequisite for the P0, not an afterthought: it lands second.

**D1 — `law setup` REGISTERS. It does not merely validate.** Registration is the only proof
that the Linear key is a workspace admin: `webhookCreate` is the admin-gated call, and
`webhooks()` is not documented to require the same grant, so a listing that succeeds proves
nothing about the mutation that matters. Opening the tunnel is the only proof the ngrok
authtoken works. Both are the operator-visible value of step 7 — fail at setup, not at the
first `law start` three days later.

Consequences, all accepted, and all stated in the output the operator reads:

- The tunnel closes when `law setup` exits, so the registered URL is dead until `law start`
  opens a fresh one and re-points the same registration by label. `daemon.ts` step 6 already
  treats "found ours, auto-disabled" as the normal case (03-CONTEXT D-02).
- Re-running `law setup` while a daemon is running **re-points that daemon's webhook at the
  setup tunnel**, and the daemon then silently receives nothing until restarted. The wizard
  prints "if a daemon is already running, restart it". It is not silently repaired, and it
  is not worked around with a URL-restore dance (three extra Linear calls to paper over a
  case the printed line covers).
- The wizard does **not** call `registrar.disable()` after proving registration. Tidier on
  paper; it would disable a live daemon's webhook on a re-run, which is the project's worst
  failure shape (boots clean, reports healthy, receives nothing).

**D2 — extract a shared factory; do not write a second composition.** This is the fifth
instance of the T72/T73/T92/T96/T99 pattern (built, tested, never called), and every one of
them was born from a duplicate. `ngrokTunnel`, the generate-or-reuse of `KEY_SECRET`, and
`webhookTeamId` move out of `daemon.ts` into the modules that own their subject, and
`daemon.ts` uses the moved versions **in the same commit** — so no exported-but-uncalled
function exists at any point. The boot smoke (`scripts/boot-smoke.ts:134-153`) already
asserts the daemon's tunnel-then-reconcile end to end, so the move is covered from the
first commit.

**D3 — the wizard self-wires; `src/cli/index.ts:63` is left alone.** The defect is not that
the caller forgot an argument, it is that the callee had an unreachable "not wired" branch
and two optional dependencies with no defaults. `registerAtSetup(ctx, make = realSetupAdapters)`
is called unconditionally, `REGISTRATION_NOT_WIRED_FIX` is deleted, and
`WizardDeps.tunnel` / `WizardDeps.registrar` are deleted with it. `runSetupWizard()` with no
arguments becomes the correct call, so nothing in `index.ts` changes.

**D4 — `ConfigSchema` is the wizard's own gate, not just the loader's.** `writeConfig`
validates what it is about to write and refuses. That single check catches this class of
defect (zero repos today, the next field tomorrow) at the one funnel every config write goes
through. The zero-repo refusal in `mapping.ts` is the usability half; this is the guarantee.

**D5 — `ConfigSchema.teamId` stays `z.string()`, NOT `.min(1)`.** Tightening it would brick
every config already on disk with `teamId: ""` — including the one this fix exists to
repair. `webhookTeamId` heals the empty value from `ownerTeamId` instead.

**D6 — refuse the mapping, never loop the prompt.** A `while (repos.length === 0) re-prompt`
loop spins forever against a test stub that keeps returning `[]`. Refusal is deterministic
from both sides: the operator gets a named reason, the test gets a return value.

**D7 — `config.json` becomes 0600 and the "no secret" claim is deleted.** It holds
`slackWebhookUrl`, which is a bearer credential — anyone who can read the file can post to
that channel. Three places assert the opposite today and all three are wrong:
`src/cli/wizard/config-writer.ts:356-358`, `src/domain/types.ts:262-266`, `README.md:68`.

---

## Task 1 — one composition for the tunnel, the registrar, and the team id

**Files:** `src/ingress/tunnel.ts`, `src/ingress/registrar.ts`, `src/infra/config.ts`,
`src/cli/daemon.ts`, `src/ingress/tunnel.test.ts`, `src/ingress/registrar.test.ts`

Behaviour-preserving. Three moves, each into the module that owns the subject, each with
`daemon.ts` switched onto the moved version in the same commit.

1. `daemon.ts:211-234` `ngrokTunnel(authtoken, log)` → `src/ingress/tunnel.ts` as
   `export function createTunnelManager(authtoken: string, log: Logger, ngrok: NgrokApi = ngrokSdk): TunnelManager`.
   Carry the T10 authtoken-env comment and the one-retry rationale with it. The SDK seam is
   the one `openTunnel(port, ngrok)` already has — pass it through, do not add a second.
   `daemon.ts:733` becomes `opts.tunnel ?? createTunnelManager(secrets.ngrokAuthtoken, log)`.
2. `daemon.ts:668-673` (the `kvGet(KEY_SECRET)` / `randomBytes(32)` / `kvSet` block) →
   `src/ingress/registrar.ts` as
   `export function ensureWebhookSecret(store: Store): { secret: string; generated: boolean }`.
   `daemon.ts` keeps `logger.registerSecret(secret)` and its "generated a webhook signing
   secret" log at the call site, now conditioned on `generated`.
3. `daemon.ts:298-312` `webhookTeamId(config)` → `src/infra/config.ts`, exported, beside
   `resolveMapping`. It is config-derived and the wizard needs it in task 3 without pulling
   in the daemon's module graph. Message unchanged.
4. New in `src/ingress/registrar.ts`:
   `export function createWebhookRegistrar(client: LinearClient, store: Store, log: Logger, o: { teamId: string; secret: string }): WebhookRegistrar`
   — `reconcile(publicUrl)` delegates to the existing `reconcile()` and returns
   `{ webhookId: r.id, secret: r.secret }`; `disable()` delegates to the existing `disable()`.
   One implementation, two shapes. `daemon.ts:752` switches to
   `registrar.reconcile(publicUrl)` (it uses only `registration.id`) and its shutdown path
   switches to `registrar.disable()`, so there is exactly one call path into `reconcile`.
   **No new `BootOptions` slot** — the boot smoke already injects `linear`, so the registrar
   built over it is already a fake.

**Assertions**

- `src/ingress/registrar.test.ts`: `ensureWebhookSecret(store)` returns
  `{generated: true}` with a 64-char hex secret on a virgin store, and
  `{secret: <same>, generated: false}` on the second call.
- `src/ingress/registrar.test.ts`: `createWebhookRegistrar(fake, store, log, {teamId: 'T', secret: 's'}).reconcile('https://x.ngrok.app')`
  → the fake client's `createWebhook` received `teamId: 'T'` and `secret: 's'`; the return is
  `{webhookId, secret}`. `.disable()` → the fake saw `updateWebhook(id, {enabled: false})`.
- `src/ingress/tunnel.test.ts`: `createTunnelManager('tok', log, fakeNgrok)` — `open(4000)`
  returns the fake listener's URL; a first-call throw followed by a success returns the URL
  after exactly two `connect` calls; `close()` closes the listener and `url()` goes null.
- Unchanged and load-bearing: `npm run smoke` still passes its five webhook checks
  (`scripts/boot-smoke.ts:142-153`).

**Falsify before trusting (T71)**

- Drop the `kvGet` from `ensureWebhookSecret` (always generate) → the second-call test goes
  red. Revert.
- Make `createWebhookRegistrar` pass a hardcoded `teamId` → the `createWebhook` argument
  assertion goes red. Revert.
- Change the retry ceiling in `createTunnelManager` from 2 to 1 → the retry test goes red.
  Revert.
- Delete the `registrar.reconcile(publicUrl)` call from `bootDaemon` → the smoke's "exactly
  one webhook is registered" goes red. Revert.

---

## Task 2 — `teamId` for a project-keyed mapping (P2, pulled forward per D0)

**Files:** `src/infra/config.ts`, `src/cli/wizard/config-writer.ts`,
`src/infra/config.test.ts`, `src/cli/wizard/config-writer.test.ts`

1. `webhookTeamId` (moved in task 1): the mapping scan becomes
   `.map((m) => m.linearTeamId ?? m.ownerTeamId ?? null)`. This repairs configs **already on
   disk** without a setup re-run. The named throw stays for a config with no team anywhere.
2. `assembleConfig` derives the team id itself rather than trusting the caller's hint. When
   `input.teamId` is blank: first a team-keyed mapping's `key.id`, then a project-keyed
   mapping's `key.teamId` (that is `ownerTeamId`, already recorded on every mapping), then
   `existing.teamId`, then `''`. `index.ts` keeps passing its best-effort `teamId` and needs
   no change.
3. `ConfigSchema.teamId` is **not** tightened (D5).

**Assertions**

- `config-writer.test.ts`: `assembleConfig` over one project-keyed mapping with
  `key.teamId = 'team-abc'` and no team-keyed mapping → `config.teamId === 'team-abc'`.
- `config-writer.test.ts`: a team-keyed mapping still wins over a project-keyed one.
- `config.test.ts`: `webhookTeamId({teamId: '', mappings: {p1: {linearProjectId: 'p1', linearTeamId: null, ownerTeamId: 'team-abc', ...}}})` → `'team-abc'`.
- `config.test.ts`: `webhookTeamId` with no team id anywhere still throws the named
  "no Linear team is configured" error.

**Falsify**

- Delete the project-keyed branch from `assembleConfig` → the first assertion goes red with
  `'' !== 'team-abc'`. Revert.
- Restore `.map((m) => m.linearTeamId)` in `webhookTeamId` → the third assertion goes red
  with the throw. Revert.

---

## Task 3 — `law setup` actually registers the webhook (P0, defect 1)

**Files:** `src/cli/wizard/register.ts`, `src/cli/wizard/index.ts`,
`src/cli/wizard/register.test.ts`

`register.ts` gains the composition the wizard was missing:

```ts
export interface SetupAdapters {
  tunnel: TunnelManager;
  registrar: WebhookRegistrar;
  /** The loopback port the tunnel forwards to. */
  port: number;
  /** Closes the tunnel, the throwaway socket and the database, in that order. */
  close(): Promise<void>;
}
export type MakeSetupAdapters = (ctx: SetupContext) => Promise<SetupAdapters>;
export interface SetupContext { config: Config; linear: LinearClient; ngrokAuthtoken: string }

export async function registerAtSetup(
  ctx: SetupContext,
  make: MakeSetupAdapters = realSetupAdapters,
): Promise<RegisterResult>
```

`realSetupAdapters` — the composition, and the whole of what was missing:

- `openStore(ctx.config.dbPath)` → `asDomainStore(createSqliteStore(db))`. The wizard has no
  store today; the registrar's contract requires the caller to persist the signing secret
  **before** the remote call (T-07-22), so it needs one.
- `ensureWebhookSecret(store)` (task 1) — the same key `law start` reads, so the daemon
  reuses this registration instead of minting a second secret the receiver would reject.
- `createLogger([linearApiKey, ngrokAuthtoken]).child({ component: 'setup' })` — file sink,
  never stdout.
- `net.createServer().listen(0, '127.0.0.1')` for a real forward target. Bind **before**
  the tunnel opens, same ordering as HOOK-01, so the wizard does not teach the opposite of
  the daemon. (`addr: 0` would forward ngrok at port 0; guessing a fixed port is worse than
  binding one.)
- `createTunnelManager(ngrokAuthtoken, log)` and
  `createWebhookRegistrar(linear, store, log, { teamId: webhookTeamId(config), secret })`.

`registerAtSetup` body: build adapters inside a `try` (a `webhookTeamId` throw becomes
`{ok: false, fix: err.message}` — the actionable "no Linear team is configured" line, not
the misleading admin fix), then `await reconcileWebhook(a.tunnel, a.registrar, a.port)` and
`await a.close()` in a `finally`. `reconcileWebhook` and its ngrok/registrar fix strings are
unchanged.

`index.ts` step 7:

- delete `REGISTRATION_NOT_WIRED_FIX`, `WizardDeps.tunnel`, `WizardDeps.registrar`,
  `WizardDeps.port` and the `TunnelManager`/`WebhookRegistrar` imports;
- add `register?: typeof registerAtSetup` to `WizardDeps` and call
  `(deps.register ?? registerAtSetup)({ config, linear: linear.value.linearClient, ngrokAuthtoken: ngrok.value.token })`
  unconditionally;
- **the success message must not claim more than it did** (this is half the defect). Print
  the URL, then: this proves the ngrok authtoken and workspace-admin grant; the tunnel
  closes with this command and `law start` opens a fresh one and re-points the same
  registration; if a daemon is already running, restart it.

Also in this task, because task 4's test makes `index.ts` test-reachable and production code
on a test-reachable path must not write to stdout: route every `console.log` in `index.ts`
through an injected `report` sink (`deps.report ?? ((m: string) => console.log(m))`), threaded
into `printResult`, `fail` and `printWarning`. Mechanical; do it first, in one pass, exactly
as `mapping.ts:176-178` does it.

**Assertions** (`register.test.ts`, driving `registerAtSetup` with a fake `make`)

- ok path: returns `{ok: true, publicUrl, webhookId, secret}`, the fake registrar's
  `reconcile` saw the URL the fake tunnel returned, and `close()` was called exactly once.
- tunnel failure: a `make` whose tunnel throws `ERR_NGROK_105` → `{ok: false}` with the
  authtoken fix, **and `close()` was still called** (finally, not happy path).
- `make` itself throwing (the `webhookTeamId` case) → `{ok: false}` carrying that error's
  message, never a stack trace.
- The signing secret never appears in any string returned to the caller.

**Falsify**

- Move `a.close()` out of the `finally` into the success branch → the tunnel-failure
  assertion goes red. Revert.
- Have `registerAtSetup` swallow the `make` throw and return the generic registrar fix → the
  third assertion goes red on the message text. Revert.
- Restore `if (!deps.tunnel || !deps.registrar) return fail(...)` in `index.ts` → task 4's
  end-to-end test goes red (see below). Revert.

---

## Task 4 — one test that walks the whole wizard (the anti-T72 gate)

**Files:** `src/cli/wizard/index.ts`, new `src/cli/wizard/index.test.ts`

Nothing has ever executed `runSetupWizard` end to end — which is why four defects shipped in
one function. Every step it calls **already** has an injectable seam with a real default
(`runPreflight(run)`, `acquireLinearKey(env, {prompt, makeClient, probe})`,
`buildMappings(client, discovered, existing, p, report)`,
`annotateRepoSafety(mappings, {run, prompts, report})`, `chooseOperator(client, {prompts})`).
`runSetupWizard` simply threads none of them. Add to `WizardDeps`, each defaulted at the call
site, each passed to a parameter that already exists:

`preflight?` (one seam covering all six checks, including the two that take no `run`),
`prompts?`, `runCommand?`, `makeLinearClient?`, `report?`, `register?` — alongside the
existing `configPath`, `envPath`, `promptRoot`.

**Never `mock.method` on an ESM namespace (T88)** — default-parameter/`??` injection only,
the convention `deps.ts` already documents.

The test: a `mkdtemp` config root, a scripted `WizardPrompts`, a fake `LinearClient`, a fake
`RunCommand`, `promptRoot` pointing at a temp dir holding two throwaway git repos, a
`register` fake that returns ok, and `report` capturing lines into an array. One walk, five
assertions — one per defect, at the level the operator hit them:

1. returns `0`, and no captured line contains `at Object.` or `Error:` (D-08, no stack trace);
2. the `register` fake was called **exactly once**, and the `config` it received has
   `teamId === 'team-abc'` for a project-keyed mapping — defects 1 and 4 on the live path;
3. `loadConfig(root)` on the file the wizard just wrote **succeeds** — defect 2, asserted by
   executing the real loader rather than by re-describing the schema;
4. `statSync(configPath).mode & 0o777 === 0o600` — defect 3;
5. the captured output contains the URL and the "restart the daemon / fresh tunnel" caveat —
   D1's honesty requirement.

**Falsify — all five, one at a time, reverting each**

- Restore the `if (!deps.tunnel || !deps.registrar) return fail(...)` early return → (1) and
  (2) go red.
- Revert task 2's project-keyed `teamId` derivation → (2) goes red on `'' !== 'team-abc'`.
- Script the repo checkbox to return `[]` → (3) goes red inside `loadConfig`. **This is the
  exact live failure**, reproduced from a test.
- Revert task 6's `chmod` → (4) goes red with `644`.
- Delete the caveat lines from the success message → (5) goes red.

---

## Task 5 — a mapping with no repos is refused (P0, defect 2)

**Files:** `src/cli/wizard/mapping.ts`, `src/cli/wizard/index.ts`,
`src/cli/wizard/mapping.test.ts`

`promptRepoSelection` may still return `[]` — blank stays the operator's way out of the
filter loop (D6). What changes is that `[]` no longer produces a mapping:

- `promptOneMapping` → `Promise<Mapping | null>`: on an empty selection,
  `report('a mapping with no repos cannot be saved — the daemon would have nothing to work in; mapping discarded')`
  and return `null`. Both `buildMappings` call sites push only non-null.
- `reviewExistingMapping`, `'edit-repos'`: an empty selection keeps the mapping's existing
  repos untouched and reports `to remove this mapping entirely, choose "remove"` — the
  action that already exists for that intent. Never a silent clear.
- `runSetupWizard`: after `buildMappings`, `mappings.length === 0` →
  `fail('Mapping', 'no mapping has any repos — re-run `law setup` and select at least one repo for a mapping')`.
  Halt before `writeConfig`, not after.
- Correct the now-false docstring at `mapping.ts:248-249`: `[]` is **not** a valid mapping.

**Assertions** (`mapping.test.ts`, through the existing `scripted()` harness)

- A scripted run whose repo checkbox returns `[]` and then declines "add another" →
  `buildMappings` returns `[]`, and the captured `report` names the discard reason.
- A scripted run that selects `[]` for the first mapping and one repo for the second →
  exactly one mapping returned, and it is the second.
- `reviewExistingMapping` via `buildMappings(existing)` with `'edit-repos'` and an empty
  checkbox → the returned mapping's `repos` is **byte-identical to the input's**.

**Falsify**

- Return the mapping instead of `null` on an empty selection → assertions 1 and 2 go red.
- Return `{...mapping, repos: []}` from the `'edit-repos'` branch → assertion 3 goes red.
- Revert both, then re-run task 4's test to confirm (3) there also reddens.

---

## Task 6 — `writeConfig` validates, and writes 0600 (P0 backstop + P1, defects 2 and 3)

**Files:** `src/cli/wizard/config-writer.ts`, `src/domain/types.ts`, `README.md`,
`src/cli/wizard/config-writer.test.ts`

1. `writeConfig` runs `ConfigSchema.safeParse(config)` and, on failure, throws
   `ConfigError(...)` built with `z.prettifyError(result.error)` — nothing is written.
   `index.ts` wraps the call and turns it into
   `fail('Config', 'the assembled config is not valid and was NOT written: <prettified>')`.
   (`src/infra/config.ts` imports only from `src/domain/` — no cycle.)
2. `writeFile(configPath, json, { encoding: 'utf8', mode: 0o600 })`, followed by
   `chmod(configPath, 0o600)`. The `chmod` is not redundant: `mode` applies only at
   creation, and the operator already has a 0644 file on disk that this must repair.
3. Delete the false claim in all three places (D7): the `writeConfig` comment
   (`config-writer.ts:356-358`), the `Config` doc comment (`types.ts:262-266`), and the
   README config-root table (`README.md:68`). Replace with the truth —
   `config.json  the project→repo map and behaviour toggles, mode 0600 (a mapping's Slack
   webhook URL is a posting credential)`. The two prompted secrets still live only in `.env`;
   that part of the claim is intact.

**Assertions** (`config-writer.test.ts`)

- `writeConfig` on a config whose one mapping has `repos: []` **rejects** with a
  `ConfigError` whose message names `repos`, and **no file exists** at the path afterwards.
- A valid config writes, and `statSync(path).mode & 0o777 === 0o600`.
- Pre-create the target at `0o644`, write over it, assert `0o600` — the repair path.
- The existing D-08 assertion (`config-writer.test.ts:196`, no secret-bearing field) stays
  green and is not weakened by the doc-comment edits.

**Falsify**

- Change the schema check to `safeParse` with the result ignored → the reject assertion goes
  red (the file appears). Revert.
- Delete the `chmod` line → the 0644-repair assertion goes red with `644`. Revert.
- Delete the `mode` option but keep the `chmod` → both mode assertions stay green (correct:
  the `chmod` is the load-bearing one), so keep the `mode` option only as documentation of
  intent, not as the guarantee.

---

## Gate

`npm run verify` — 560/560 green today, must be green after every task. Each task is one
commit. After task 6, re-run `law setup` live against the real workspace: it must reach
"webhook registered", and `law start` must then boot against the config setup just wrote.
