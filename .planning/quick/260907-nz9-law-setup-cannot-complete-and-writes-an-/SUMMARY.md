---
task: nz9 — `law setup` cannot complete, and writes a config its own loader rejects
status: complete
gate: npm run verify — 584/584 green (560 at start, +24)
commits:
  - bb9e6e7 refactor(ingress): one composition for the tunnel, the registrar and the team id
  - 739f965 fix(config): derive teamId for a project-keyed mapping
  - d729313 fix(wizard): law setup registers the webhook instead of refusing to
  - a77aed6 fix(wizard): a mapping with no repos is refused, never saved
  - 238e7f6 fix(wizard): writeConfig validates against the loader, and writes 0600
  - 561abca test(wizard): one test that walks the whole wizard end to end
---

# All four defects fixed, every new check falsified

`npm run verify`: **560/560 -> 584/584**, 20 suites, smoke green. The gate was green at
every commit boundary.

---

## Falsification — measured, per case

Each was performed for real: edit the production source, rebuild through `tsc`, run the
suite, observe the named case go RED, restore, observe green. Counts are for the suite the
case lives in, not the whole gate.

| # | Break applied | Predicted red | Measured |
|---|---|---|---|
| F1 | `ensureWebhookSecret`: drop the `kvGet`, always mint | second-call test | registrar 11 -> **10 pass / 1 fail**: `ensureWebhookSecret mints ... once and reuses it` |
| F2 | `createWebhookRegistrar`: hardcode `teamId: 'hardcoded-team'` | `createWebhook` arg assertion | registrar **10 / 1**: `passes the caller teamId and secret straight through` |
| F3 | `createTunnelManager`: retry ceiling `2` -> `1` | retry test | tunnel 10 -> **8 / 2**: the retry case *and* the give-up case (bonus — the ceiling is asserted from both directions) |
| F4 | `bootDaemon`: delete `registrar.reconcile(publicUrl)` | smoke one-webhook check | `SMOKE FAILED — exactly one webhook is registered (got 0)` |
| F5 | `deriveTeamId`: delete the project-keyed branch | `'' !== 'team-abc'` | config-writer 22 -> **21 / 1**, `expected: 'team-abc' / actual: ''` — exactly as predicted |
| F6 | `webhookTeamId`: back to `.map((m) => m.linearTeamId)` | the throw returns | config 15 -> **14 / 1**, error `no Linear team is configured ...` |
| F7 | `registerAtSetup`: `close()` out of `finally` into the success branch | tunnel-failure case | register 14 -> **13 / 1**: `a tunnel failure still closes the adapters` |
| F8 | `registerAtSetup`: swallow the `make` throw, return `REGISTRAR_FIX` | message-text case | register **13 / 1**: `a throw from make surfaces that error message` |
| F9 | `promptOneMapping`: return the mapping instead of `null` | assertions 1 and 2 | mapping 17 -> **15 / 2**, both as named |
| F10 | `'edit-repos'`: return `{...mapping, repos: []}` | assertion 3 | mapping **16 / 1**: `keeps the existing repos` |
| F11 | `writeConfig`: `safeParse` result ignored | reject case (file appears) | config-writer 25 -> **24 / 1**: `REFUSES a config with a zero-repo mapping` |
| F12 | `writeConfig`: delete the `chmod`, keep `mode` | the 0644-repair case | config-writer **24 / 1**: `REPAIRS an existing 0644 file to 0600` |
| F13 | `writeConfig`: delete `mode`, keep the `chmod` | **both stay green** | config-writer **25 / 0** — confirmed. The `chmod` is the load-bearing half; `mode` is kept as documentation of intent, not as the guarantee. |
| F14 | `index.ts`: restore `if (!deps.tunnel || !deps.registrar) return fail(...)` | e2e (1) and (2) | e2e **0 / 1**, halted at `x Webhook registration` |
| F15 | revert the project-keyed `teamId` derivation | e2e (2) | e2e **0 / 1**, `expected: 'team-abc' / actual: ''` |
| F16 | script the repo checkbox to `[]` | e2e (3) red inside `loadConfig` | three layers, below |
| F17 | revert the 0600 write | e2e (4) with 644 | e2e **0 / 1**, `expected: 384 / actual: 420` (0o600 vs 0o644) |
| F18 | delete the caveat lines | e2e (5) | e2e **0 / 1**, `the caveat that this URL dies with the command` |

### F16, in three layers

The plan predicted "(3) goes red inside `loadConfig`". With the full fix in place that is no
longer reachable — two guards now stand in front of it — so the case was run three times,
peeling one guard off at a time:

1. **All guards on** — the wizard halts at `x Mapping / fix: no mapping has any repos ...`,
   after reporting `a mapping with no repos cannot be saved ...`. Test red at assertion (1).
2. **Mapping guards reverted, `writeConfig` validation on** — the backstop catches it:
   `x Config / fix: the assembled config is not valid and was NOT written: Too small:
   expected array to have >=1 items -> at mappings["proj-1"].repos`. Test red at (1).
3. **Every guard reverted** — `loadConfig` throws, exactly as predicted and **byte-identical
   to the message the operator's real config.json produces**: `ConfigError: Invalid config
   ... Too small: expected array to have >=1 items -> at mappings["proj-1"].repos`. Test red
   at (3).

That is the live failure reproduced from a test, with both new guards proven to be the thing
standing between it and the operator.

---

## Verification against the operator's ACTUAL config

`~/.linear-auto-worker/config.json` was **copied** to `/tmp/law-cfg-probe/` and driven there.
Neither the config nor `.env` was modified or deleted; the directory still holds only
`config.json`, mode 644, unchanged.

Observed shape: one **project-keyed** mapping (`linearProjectId` set, `linearTeamId: null`,
`ownerTeamId: a8fc20d3-...`), `repos: []`, `teamId: ""`, a live `slackWebhookUrl`, mode 644.

1. **`loadConfig` fails today — that is the bug.**

   ```
   ConfigError: Invalid config at /tmp/law-cfg-probe/config.json:
   Too small: expected array to have >=1 items
     -> at mappings["fe8fe1f9-d4e1-4f89-9133-b89373382945"].repos
   ```

2. **`webhookTeamId`, before and after.** Old logic (`.map(m => m.linearTeamId)`) resolved
   nothing and **threw** — `law start` could not register a webhook at all even once the
   repos were fixed. New logic resolves `a8fc20d3-8ae9-404a-8e58-cabc9d72393b` from
   `ownerTeamId`, which was on disk the whole time.
3. **The repair is one field.** Giving that mapping a single repo (nothing else touched,
   `teamId` still `""`) makes `loadConfig` succeed *and* `webhookTeamId` resolve. So the
   operator's existing file heals on the next `law setup` with no manual edit — which is
   precisely what D5 (`teamId` stays `z.string()`) exists to preserve.

---

## The running-daemon warning, as shipped

Printed after `Webhook registered at <url> (signing secret persisted)`:

```
  this proves your ngrok authtoken works and your Linear key is a workspace admin.
  the tunnel closes when this command exits, so that URL is already dead —
  `law start` opens a fresh tunnel and re-points this same registration at it.
  if a daemon is ALREADY RUNNING, restart it now (Ctrl-C, then `law start`): setup just
  re-pointed its webhook at a tunnel that no longer exists, and it only reconciles at
  boot — until you restart it, it will receive nothing.
```

It names the action (`Ctrl-C, then law start`), the cause (setup re-pointed the webhook),
the mechanism (the daemon reconciles only at boot, never on its tick), and the consequence
of ignoring it. Assertion (5) of the e2e test holds it in place; F18 proved that assertion
fails when the caveat is removed.

---

## Where the plan was wrong against the real code

Expected — it was written from a read. Seven, all resolved toward correctness:

1. **`createLogger` is a stdout sink, not a file sink.** The plan said
   `createLogger([...]).child({component:'setup'})` — "file sink, never stdout". It is not:
   `infra/logger.ts`'s `SecretScrubbingStream._write` ends in `process.stdout.write(line)`.
   Handing it to the wizard would interleave pino JSON through an output contract that is
   "one named line per step". **Shipped:** a five-line `silentLog` in `register.ts`. Every
   failure on that path already returns a named `fix`; a log line adds nothing the operator
   does not get. Marked as a ponytail with the upgrade path.
2. **`SetupContext.linear: LinearClient` is ambiguous and unbuildable as written.** The
   wizard holds an `@linear/sdk` client; `createWebhookRegistrar` needs the *domain* port;
   `LinearClientImpl` is the only bridge and its constructor requires `apiKey`.
   **Shipped:** `SetupContext { config, linearApiKey, ngrokAuthtoken }`.
3. **`webhookTeamId`'s message could not stay unchanged.** It was prefixed `law start:` and
   is now also `law setup`'s error — task 3 surfaces it verbatim as the wizard's fix string.
   **Shipped:** prefix dropped, body kept, circular "or re-run `law setup`" tail removed
   since setup is now one of the two callers.
4. **Task ordering.** The plan's task 4 asserts 0600 and a loadable config, both of which
   land in tasks 5 and 6 — so as written the gate could not be green after task 4.
   **Shipped:** executed 1, 2, 3, 5, 6, 4. Same six commits, same content, gate green at
   every boundary.
5. **A second derivation of the database path (Rule 2, auto-added).** `realSetupAdapters`
   opens `config.dbPath`, while `loadFoundation` derived `path.join(root, 'store.db')` and
   ignored the config field entirely. Two derivations of "the database" means the wizard can
   persist the signing secret where the daemon will not look — boots clean, rejects every
   delivery. **Shipped:** `loadFoundation` now opens `config.dbPath`. One line; the boot
   smoke fixture already set that field to the same value, so it is a no-op there.
6. **`writeConfig`'s new validation also rejects an unresolved `repoSlug`.** `toRepoMapping`
   leaves `repoSlug: ''` when `gh repo view` cannot resolve the repo, and
   `RepoMappingSchema` requires `.min(1)` — so a repo with no readable GitHub remote now
   halts setup with a named fix instead of writing a config the daemon cannot load. Correct
   (that config was always unloadable) but a **behaviour change the plan did not name**: an
   operator who previously got a warning and a broken file now gets a hard stop and a fix.
   Flagged rather than softened.
7. **The tunnel-retry test costs 2 s.** `RETRY_DELAY_MS` is not injectable, so
   `createTunnelManager retries a failed open exactly once` really sleeps. Left as-is: one
   test, two seconds, versus a knob whose only consumer is a test.

---

## What did NOT change, deliberately

- **`ConfigSchema.teamId` stays `z.string()`** (D5). Tightening it would reject the very
  file this fix exists to repair — verified above.
- **`src/cli/index.ts:63` is untouched** (D3). `runSetupWizard()` with no arguments was
  always the correct call; the callee was the defect.
- **The wizard does not call `registrar.disable()`** after proving registration (D1) — that
  would disable a live daemon's webhook on a re-run.
- **No test was deleted and no assertion weakened.** The existing D-08 check in
  `config-writer.test.ts` (no `LINEAR_API_KEY|NGROK_AUTHTOKEN|authtoken|apiKey` in the
  written JSON) is still true and still green: the two *prompted* secrets never were in
  `config.json`. What was false — and is now deleted from all three places that said it —
  is the wider claim that the file carries no credential at all.

## Anti-T72 check

Nothing is exported-but-uncalled at any commit boundary. `createTunnelManager`,
`ensureWebhookSecret`, `webhookTeamId` and `createWebhookRegistrar` were created and switched
onto by `daemon.ts` in the **same commit** (bb9e6e7); `registerAtSetup` is called
unconditionally by `index.ts` in the same commit that defines it (d729313). F4 and F14 prove
both call paths are live rather than merely present.

## Deferred

- `src/cli/index.ts` `law setup` still has no way to pass a `report` sink; `runDoctor` now
  accepts one but nothing uses it. Not worth a flag until something needs it.
- The `repoSlug: ''` hard stop (deviation 6) deserves a friendlier wizard-side message —
  today it surfaces as a raw prettified zod path. One line when it first bites someone.
