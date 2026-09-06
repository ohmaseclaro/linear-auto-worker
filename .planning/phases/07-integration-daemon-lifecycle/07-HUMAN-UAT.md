# linear-auto-worker — live verification checklist

**This is the whole of what a machine could not check.** Everything else in this milestone is
covered by `npm run verify` (513 tests, a whole-tree typecheck, and a boot smoke that composes
the real module graph — all green). What remains needs a real Linear workspace, a live ngrok
tunnel, and a real `gh`, so it needs you.

**You do not need to open any other document.** This file supersedes and absorbs
`03-HUMAN-UAT.md` and `08-HUMAN-UAT.md`; both are folded in below, in the order you should
actually do them.

Work top to bottom. Sections 0–2 are setup and must pass before anything after them means
anything. Sections 3 and 4 are the two ROADMAP criteria this milestone could not prove.

Every step has an **expected result** and, when it can fail, **what it means** — so a failure
produces a report rather than a shrug.

---

## Section 0 — Preconditions

Confirm all of these before you start. Every one has bitten this project already.

- [ ] **Node ≥ 22.** `node -v`. `better-sqlite3@13` and `execa@10` both require it.
      *(24 is the Active LTS and is what the wizard recommends; 22 works.)*
- [ ] **The setup wizard has been run** — `law setup` — and `~/.linear-auto-worker/config.json`
      exists. If it has not, do Section 1 first and come back.
- [ ] **Both secrets are present and the file is locked down:**
      ```sh
      grep -c '^LINEAR_API_KEY=\|^NGROK_AUTHTOKEN=' ~/.linear-auto-worker/.env   # expect 2
      stat -f '%Lp' ~/.linear-auto-worker/.env                                   # expect 600
      ```
      **If the mode is not 600** the daemon refuses to boot — `loadSecrets` rejects anything
      looser, deliberately.
- [ ] **`gh` is authenticated and carries the `workflow` scope:**
      ```sh
      gh auth status
      ```
      Expect exit 0 and a `Token scopes:` line containing `workflow`. **Without it**, any push
      that touches `.github/workflows/**` is rejected by GitHub with a message that does not
      mention scopes.
- [ ] **`claude` is on PATH and the global GSD install is intact:**
      ```sh
      claude --version
      ls ~/.claude/skills ~/.claude/gsd-core
      ```
      **If `~/.claude` is missing or unreadable by the user running the daemon**, every spawned
      session comes up with no GSD skills. The daemon detects this and fails the run loudly
      (`LawError` / `AGENT_ENV`) rather than shipping generic work — but you want to know now.
- [ ] **At least one mapped repository has a remote:**
      ```sh
      git -C <mapped-repo> remote -v      # expect exactly one
      gh repo view --json nameWithOwner,defaultBranchRef -R <owner/repo>
      ```
      **Exactly one remote.** With two, the wizard cannot guess which to push to and refuses.
- [ ] **The mapped repository's default branch is BRANCH-PROTECTED.**
      ```sh
      gh api repos/<owner>/<repo>/branches/<default-branch>/protection
      ```
      Expect a JSON body, not a 404 or 403.

      > **Do not skip this one.** Branch protection is the only control in the whole system
      > that survives a spawned agent circumventing the local push guards — it is server-side
      > and out of the agent's reach. A 404 *and* a 403 both mean "not protected as far as we
      > can tell"; add a rule in GitHub repo settings before the first live run.
- [ ] **Use a scratch Linear team for the first pass**, not a real one. Everything below
      creates real comments and moves real issues.

---

## Section 1 — The setup wizard *(absorbed from `08-HUMAN-UAT.md`)*

Skip if `law setup` has already run cleanly and you are only re-verifying the daemon.

- [ ] `law setup` on a machine where `gh` and `claude` are authenticated.
- [ ] **Every non-passing preflight check prints an actionable fix and no stack trace.**
- [ ] The Linear key is prompted for **only** if `~/.linear-auto-worker/.env` has none.
- [ ] Deliberately try a plain-**Member** Linear key once. Expect a rejection naming
      **workspace admin**. *(Webhook creation requires it; a Member key produces a permission
      error that does not say so.)*
- [ ] On macOS, the ngrok token is lifted silently from
      `~/Library/Application Support/ngrok/ngrok.yml`. **You must not be prompted for a token
      you already have.**
- [ ] `config.json` contains **no** secret-bearing field:
      ```sh
      grep -iE 'key|token|secret' ~/.linear-auto-worker/config.json     # expect no matches
      ```
- [ ] Grep your terminal scrollback for the Linear key, the ngrok token and the webhook signing
      secret. **None may appear.**
- [ ] A webhook appears in **Linear → Settings → API → Webhooks**, labelled
      `linear-auto-worker`, pointing at the `*.ngrok.app` URL the wizard printed, **enabled**.

### 1a. The re-run — the single most important check in this section

- [ ] **Run `law setup` a second time.** Then count webhooks in Linear.

      **Expected: exactly one.** The ngrok domain is different on every run, so a reconciler
      that matched on **URL** would have created a duplicate. It matches on the **label** and
      updates in place.

      **If there are two:** label matching is broken. Delete the extra by hand; do not run the
      daemon until it is fixed, or Linear will deliver every event twice.
- [ ] The re-run did **not** re-prompt for either secret and did **not** disturb a mapping you
      did not touch. `diff` `config.json` before and after.
- [ ] Stop the daemon, let Linear auto-disable the dead webhook (or disable it by hand), run
      setup again. **Expected: re-enabled, not duplicated.**

### 1b. `law setup --doctor` — the destructive path

- [ ] Add an unrelated webhook by hand with an ngrok-looking URL and a **different** label
      (e.g. `some-other-tool`, `https://x.ngrok-free.app/hook`).
- [ ] `law setup --doctor`. The foreign webhook is **reported**, confirmation is asked **per
      item**, and answering "no" (the default) leaves it **untouched**. Nothing may be deleted
      without an explicit yes.
- [ ] The doctor never touches a non-ngrok webhook, and never lists or deletes the daemon's own
      `linear-auto-worker` webhook.
- [ ] No signing secret appears anywhere in the doctor's output.

---

## Section 2 — First boot, and the three assumptions one delivery settles *(absorbed from `03-HUMAN-UAT.md`)*

Start the daemon and leave it running for the rest of this file.

- [ ] Start it and **watch for the reconciled webhook URL**:
      ```sh
      law start 2>&1 | tee ~/law-uat.log
      ```
      Expect, in order: `preflight ok` (×3) → `receiver listening on loopback` →
      `tunnel open` → `webhook registered` (or `webhook reconciled`) → `daemon ready`.

      **The bind must come before the tunnel.** If `tunnel open` appears first, there is a
      window in which Linear can deliver to a live public URL backed by nothing; those 502s
      burn Linear's retry budget and march the webhook toward auto-disable.
- [ ] Copy the `publicUrl` from the `daemon ready` line and confirm it matches the URL on the
      webhook in Linear's settings UI.

### 2a. Three assumptions, one delivery

These three are fields of the *same* request, so one delivery settles all three. Assign any
issue on the scratch team to the bot, then find this line:

```sh
grep 'first delivery shape' ~/law-uat.log
```

It logs **header keys only, never values** — the signature header is a live credential. When
you record the result below, paste the key list, not the headers.

- [ ] **A1 — the delivery header is named `linear-delivery`.**
      Observed `headerKeys`: `______________________`

      **If it is absent:** nothing is broken. The sha256-of-body surrogate id in
      `src/ingress/receiver.ts` is already carrying the traffic and dedupes correctly, because
      Linear's retries resend an identical body. **Fix:** set `DELIVERY_HEADER` to the observed
      name. **Warning sign if unnoticed:** a `delivery header absent — falling back to
      sha256-of-body surrogate id` warning at every boot.

- [ ] **A2 — `webhookTimestampType` is `"number"`.**
      Observed: `____________`

      **If it is not:** the `timestamp:absent` guard is rejecting **real traffic** with a 400,
      and no issue is ever picked up. This is the one outcome that is immediately
      user-visible. **Fix:** downgrade the presence assertion to a warning, keeping the
      staleness comparison for deliveries that do carry the field. Do **not** delete the guard
      — the SDK's own check is wrapped in `if (timestamp)`, so an absent field silently skips
      replay protection and returns 200.

- [ ] **A6 — `actorType` is `user`.**
      Observed: `____________`

      **If it is not** (`integration` / `oauthClient` / `externalUser`): loop-prevention layer 1
      is dead code and layer 2 (the invisible comment marker) is silently carrying the load on
      comment events. Layers 3 and 4 still work. **Fix:** add the observed variant to the
      discriminant in `src/ingress/guards.ts`. **Warning sign if unnoticed:** the `actor:self`
      drop counter sits at zero forever while the daemon is demonstrably seeing its own writes.

*Not settled by this delivery, deliberately:* Linear's undocumented auto-disable threshold
(affects only how often the re-enable path runs, and is not observable from a **successful**
delivery).

---

## Section 3 — ROADMAP criterion 1: assignment becomes a pull request

> *"Assigning a real Linear issue to the bot produces a draft pull request with no manual step
> in between, and the pull request URL appears in Linear, Slack, and the logs."*

This is the core value. Nothing in the repository can assert it.

- [ ] **Assign a real issue** in a mapped project to the bot user. Give it a task the agent can
      actually finish — a small, well-specified change in the mapped repo.

- [ ] **Within ten seconds:** an acknowledgement comment appears on the ticket, and the issue
      moves to **In Progress**.

      **Expected:** the comment names the repo and, if the daemon is busy, its queue position.
      **If nothing happens:** check `grep 'guard' ~/law-uat.log` first. A drop counter naming
      `actor:self` or `actor:null-untrusted` means a loop guard ate a real delivery — see A6
      above. Silence in the log instead means the delivery never arrived: re-check the webhook
      URL from Section 2.

      **If the comment appears but the state does not change:** the bot account lacks permission
      to move issues on that team, or the team has no workflow state of type `started`.

- [ ] **Milestone comments appear as the run progresses** — pickup, then agent progress, then a
      terminal comment. **Expect four to six comments for a whole run, not a wall of them.**

      **If you see a wall:** the notifier's Linear channel has been wired alongside the engine's
      own comment sites. See **T72** in the known-gaps section — it is deliberately unwired.

- [ ] **A draft pull request exists**, and its URL appears in **all three** places:
      ```sh
      # 1. Linear — the terminal comment on the ticket carries the URL.
      # 2. Slack — only if this mapping has a webhook configured.
      # 3. The log:
      grep 'run.terminal' ~/law-uat.log
      ```

- [ ] **Read the whole run from the log, by run id.** Take the `runId` from any line above:
      ```sh
      grep '"runId":"<RUN-ID>"' ~/law-uat.log | node -e \
        'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>s.trim().split("\n").forEach(l=>{const o=JSON.parse(l);console.log(new Date(o.time).toISOString(), o.msg, o.from?`${o.from}->${o.to}`:"")}))'
      ```
      **Expected:** a single unbroken chain `queued → preparing → running → delivering →
      delivered`, with no gap longer than the agent's own working time.

- [ ] **No secret appears in the logfile.** Run this exactly:
      ```sh
      grep -c -F "$(grep '^LINEAR_API_KEY=' ~/.linear-auto-worker/.env | cut -d= -f2-)" ~/law-uat.log
      grep -c -F "$(grep '^NGROK_AUTHTOKEN=' ~/.linear-auto-worker/.env | cut -d= -f2-)" ~/law-uat.log
      ```
      **Expected: `0` from both.** Redaction is a global serializer at the log sink, so it
      catches the webhook signing secret too — which is minted at runtime and does not exist
      when the logger is constructed.

      **If either returns non-zero:** stop. Do not share the logfile. A secret reached disk,
      which means the redaction list is missing a registration.

- [ ] **Confirm the pull request is a DRAFT** and targets the mapped base branch, not the
      default branch by accident:
      ```sh
      gh pr view <url> --json isDraft,baseRefName,headRefName
      ```

---

## Section 4 — ROADMAP criterion 5: a question survives a restart

> *"A run that asks a question survives a full daemon restart and resumes on the operator's
> threaded reply."*

- [ ] **Assign an issue whose description is deliberately underspecified** so the agent has a
      genuine reason to ask — e.g. "add caching to the API" with no mention of where, what to
      cache, or for how long.

- [ ] **Wait for the question comment** on the ticket. It arrives as a top-level comment and
      carries the assumption the agent will proceed on if you never answer.

- [ ] **Stop the daemon with an interrupt** — `Ctrl-C` once, in the terminal running it.

      **Expected:** `shutting down` → `webhook disabled for shutdown` → `in-flight runs marked`
      → `shutdown complete`, then exit 0.

- [ ] **Confirm from the database that the run is parked with its deadline intact:**
      ```sh
      sqlite3 ~/.linear-auto-worker/store.db \
        "SELECT r.id, r.state, q.status, datetime(q.deadline_at/1000,'unixepoch')
           FROM runs r JOIN questions q ON q.run_id = r.id
          WHERE r.state = 'awaiting_answer';"
      ```
      **Expected:** one row, state `awaiting_answer`, question status `open`, and a deadline in
      the future.

      **This is the invariant everything rests on:** `awaiting_answer` holds **no** concurrency
      slot and **no** live child. If a parked run held a slot, three open questions would look
      exactly like a dead daemon — and your natural diagnosis ("it's hung") would send you
      somewhere else entirely.

      **If the state is `running` instead:** the clean-stop transition did not happen, and the
      next boot will *fail* that run rather than resume it — because after an unclean exit the
      push status is genuinely unknowable. That is correct behaviour over an incorrect state.

- [ ] **Restart the daemon.** `law start`. Confirm `boot recovery complete` reports the parked
      run as `left` (neither requeued nor failed), and that the reconciled webhook URL is
      printed again.

- [ ] **Reply IN THE THREAD on the question comment** with a real answer.

      **Expected:** the run resumes **on the same session** — the log line carries the same
      `sessionId` as before the restart — and proceeds to a pull request.

      **If it does not resume:** `grep 'correlate' ~/law-uat.log`. `unknown_thread` means you
      replied under a different comment. `bot_authored` means the reply was attributed to the
      bot.

### 4a. The mistake everyone makes

- [ ] **Repeat with a second underspecified issue, but reply in the MAIN comment box** instead
      of in the thread.

      **Expected: it still works.** With exactly one open question on the ticket, the top-level
      fallback matches it.

      **This is the whole point of the fallback.** Without it, an operator answering the way
      that feels natural gets no response at all, and the bot looks broken.

- [ ] **Then the case the fallback must refuse.** Get **two** questions open on one ticket (a
      multi-repo mapping, or two runs), and reply top-level.

      **Expected: no match, and the log says `ambiguous`.** It must refuse to guess.
      **If it picks one:** answering one question would silently answer the other, and the
      wrong repo gets the wrong instruction.

---

## Section 5 — The two checks that exist only here

Neither can be reproduced offline. They are the reason this file exists at all.

- [ ] **A real signed delivery from Linear verifies against the locally generated secret.**

      Every test in the repository signs its own payloads, so all of them would pass even if the
      secret we register and the secret Linear signs with had drifted apart. The only proof is
      a real delivery answering **200**:
      ```sh
      grep -c 'signature' ~/law-uat.log     # expect 0 rejections
      ```
      **If deliveries come back 400 with a signature guard:** the secret in `kv` is not the one
      Linear holds. Re-run `law setup` — reconciliation rewrites both in one transaction.

- [ ] **A restart does not accumulate a duplicate registration.**

      Stop and start the daemon **three** times, then count webhooks labelled
      `linear-auto-worker` in Linear → Settings → API → Webhooks.

      **Expected: exactly one, enabled, pointing at the newest ngrok URL.**

      The ngrok domain is different every boot, so a reconciler matching on URL creates a new
      registration each time — and finding our own webhook **auto-disabled** at boot is the
      *normal* case, not a repair path, because an ephemeral URL guarantees failed deliveries
      while the daemon is down.

      **If the count grows:** delete the extras by hand and stop the daemon. Every duplicate
      multiplies inbound deliveries, and the delivery-id dedupe will not help — Linear sends
      each registration its own delivery with its own id.

---

## Known gaps — recorded, not fixed

Do not report these as bugs. They are deliberate, and each has its reasoning written down.

| # | What you will see | Why it is this way |
|---|---|---|
| **T72** | Milestone comments come from the run engine only. The notifier's Linear channel exists in the codebase and is **not** constructed. | The engine already posts every Linear comment, and does it better — edit-in-place queue positions, threaded question ids, multi-repo rollups. Wiring both would **double-post every milestone**, and every bot comment is then an event the four loop guards must filter. Accepted for v1: the notifier is two channels, not three. The **log** channel — the half the engine does not do — is wired and structurally cannot be removed. |
| **T73** | A run that is killed at its deadline with real commits in its worktree is reported **`failed`**, not `partial`, and ships no draft PR. `partial` is unreachable from a live run. | Two verdict designs were built. The run engine trusts the agent's self-reported `status`; `execute-run.ts` judges by **commits present in the worktree**. Only the engine's is on the live path — and research is emphatic that trusting a self-report is this project's most likely silent failure, because `claude -p` exits 0 having been denied every edit. Reconciling needs `partial` on `AgentResult` plus a draft flag on the `Deliverer` port. **Architectural: recorded, not fixed. Highest-value follow-up after this milestone.** |
| **D4** | A question's deadline is only enforced at the **next boot**, and missed work is only swept at boot. | Nothing drives a periodic `questions.sweep()` or reconciliation poll — no plan owned a timer. Both functions are written and ready to be called on an interval. In practice: if you never answer a question, the assumption is posted at the next restart rather than at the deadline. |
| **D5** | `maxQuestionRounds` is not enforced. | A pathological agent could ask more rounds than configured. |
| **D6** | Terminal notifications report `costUsd: 0` and `tokensUsed: 0`. | The values are never threaded from the agent result to the notifier. |
| **D7** | After an **unclean** exit there is no recorded pid to inspect. | Shutdown reaps through the in-process abort map, so the `runs.pid` column is never written. A clean stop does not need it; a crash leaves you without it. |
| — | A project-keyed mapping does not record its Linear team id. | Harmless while the registrar registers with `allPublicTeams: true`. Revisit only if webhook scoping ever narrows to one team. |
| — | A re-run's review prompt labels each existing mapping by id rather than by project/team name. | `Config.mappings` stores no human-readable name. |

---

## Record the outcome

- Date: `____________`  ·  Operator: `____________`
- Criterion 1 (assignment → draft PR): ☐ pass ☐ fail — PR URL: `____________________`
- Criterion 5 (question survives restart): ☐ pass ☐ fail — resumed on same session: ☐ yes ☐ no
- A1 `headerKeys`: `____________`  ·  A2 `webhookTimestampType`: `____________`  ·  A6 `actorType`: `____________`
- Secrets in logfile: ☐ none (expected) ☐ **FOUND — stop and report**
- Webhook count after three restarts: `____`  (expected: 1)
