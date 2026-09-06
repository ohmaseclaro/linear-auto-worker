# Phase 8 — Human UAT checklist (live, credential-gated)

> **SUPERSEDED — do not run this file directly.**
> Every item below is folded into the milestone's single consolidated checklist,
> `.planning/phases/07-integration-daemon-lifecycle/07-HUMAN-UAT.md`, in the order an
> operator should actually do them. Kept for its reasoning; run the consolidated one.

**Why this file exists.** SETUP-09's real acceptance criterion is "an operator on a fresh
machine runs one command and ends with a registered, delivering webhook." That cannot be
proven by an automated test on this branch, and faking it into a passing task would produce
a green check that means nothing. Everything below needs at least one of: a live
workspace-admin Linear key, a live ngrok account, or Phase 7's daemon — none of which exist
under rush mode.

**Do not run any of this until the milestone integration gate has merged Phase 1 (domain),
Phase 3 (tunnel + registrar) and Phase 7 (daemon + composition root).**

## Blocking wire-up (do this first)

- [ ] **`runSetupWizard()` is called with `{ tunnel, registrar, port }`.** Phase 8 codes
      against the `TunnelManager` / `WebhookRegistrar` ports only. Until Phase 7's
      composition root passes the real implementations in (`src/ingress/tunnel.ts`'s
      `openTunnel` and `src/ingress/registrar.ts`'s `reconcile`), `law setup` writes
      `config.json` and then **exits 1** with the fix string
      "Webhook registration needs a live tunnel and registrar…". That exit is deliberate:
      setup that did not register a webhook did not finish. Verify the wizard exits 0 once
      the deps are supplied.
- [ ] Confirm `src/domain/fakes.ts` exists (the domain barrel already re-exports it) and,
      if it ships `FakeTunnel` / a `WebhookRegistrar` fake, replace the local port doubles
      at the top of `src/cli/wizard/register.test.ts` with them.
- [ ] Run the phase's four test files at the gate:
      `tsc && node --test "dist/**/*.test.js"` (TRAPS T55 — quote the glob).

## Live setup run (needs a real Linear key + a real ngrok account)

- [ ] On a machine with `gh` and `claude` authenticated, run `law setup`.
- [ ] Preflight prints an actionable fix for every non-pass check and no stack trace.
- [ ] The Linear key prompt appears only if `~/.linear-auto-worker/.env` has none, and the
      key is rejected with the **workspace-admin** fix string if the account is a plain
      Member (D-06). Test this deliberately with a Member key.
- [ ] The ngrok token is lifted silently out of
      `~/Library/Application Support/ngrok/ngrok.yml` on macOS (T39) — confirm the operator
      is **not** prompted for a token they already have.
- [ ] `~/.linear-auto-worker/.env` is mode **0600** (`stat -f '%Lp'` → `600`) and
      `config.json` contains **no** secret-bearing field (D-08).
- [ ] Confirm the terminal transcript contains neither the Linear key, the ngrok token, nor
      the webhook signing secret — grep the scrollback.

## Registration (the SETUP-09 claim)

- [ ] After `law setup` completes, a webhook appears in **Linear → Settings → API →
      Webhooks**, labelled `linear-auto-worker`, pointing at the live `*.ngrok.app` URL the
      wizard printed, and **enabled**.
- [ ] Assign a real test issue to the bot user and confirm the daemon (Phase 7) receives the
      delivery — the issue moves to In Progress and a bot comment appears.
- [ ] **Run `law setup` a second time.** Afterwards, confirm **exactly one** webhook exists
      in the workspace. This is the single most important check in this file: the ngrok
      domain is different on the second run, so a reconciler that matched on URL would have
      created a duplicate. It must have matched on the label and updated in place.
- [ ] Confirm the re-run did **not** re-prompt for either secret, and did **not** drop any
      mapping the operator did not touch (D-04). Diff `config.json` before and after.
- [ ] Stop the daemon, wait for Linear to auto-disable the now-dead webhook (or disable it
      by hand in the UI), then run setup again — confirm the webhook is **re-enabled**
      rather than duplicated (T-08-18).

## `law setup --doctor` (the destructive path)

- [ ] Add an unrelated webhook to the workspace by hand with an ngrok-looking URL and a
      **different** label (e.g. `some-other-tool`, `https://x.ngrok-free.app/hook`).
- [ ] Run `law setup --doctor`. Confirm the foreign webhook is **reported**, that a
      confirmation is asked **per item**, and that answering "no" (the default) leaves it
      **untouched** in Linear. Nothing may be deleted without an explicit yes.
- [ ] Confirm the doctor never touches a non-ngrok webhook at all, and never lists or
      deletes the daemon's own `linear-auto-worker` webhook.
- [ ] Confirm no signing secret appears anywhere in the doctor's output (T23).

## Known non-blocking gaps recorded at build time

- A project-keyed mapping does not record its Linear team id, so `Config.teamId` is filled
  only when at least one mapping is team-keyed. Harmless while the registrar registers with
  `allPublicTeams: true`; revisit if webhook scoping ever narrows to one team.
- `Config.mappings` stores no human-readable mapping name, so a re-run's review prompt
  labels each existing mapping by its id rather than its project/team name.
