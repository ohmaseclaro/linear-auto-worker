# Traps

One hundred and twenty-seven footguns found while building this daemon, kept as a running ledger
so no two parallel work streams had to rediscover the same one.

**Every entry here was measured, not recalled.** Versions come from the npm registry, API
surfaces from reading the installed package's `.d.ts`, CLI behaviour from running the CLI,
and HTTP behaviour from standing up a real server and POSTing to it. Where a vendor's own
documentation contradicted the shipped artifact, the artifact won and the entry says so.

The point of publishing it: most of these are not specific to this project. If you are
wiring Linear webhooks, driving `claude -p` from a daemon, or writing Node tests that
spawn processes, several of them will cost you an afternoon each.

Measured against: `@linear/sdk@93.0.1`, `@ngrok/ngrok@1.7.0`, `better-sqlite3@13.0.3`,
`execa@10.0.1`, Claude Code CLI `2.1.259`, `gh` `2.98.0`, Node `22.23.1`, macOS.

The complete internal ledger — all 127 rows with per-phase attribution and the evidence for
each — is in [`.planning/TRAPS.md`](../.planning/TRAPS.md). This page is the subset that
generalises.

---

## Driving `claude -p` from a program

**`claude -p` starts in Manual permission mode, denies every edit, and still exits 0.**
The single most expensive trap in the project. A misconfigured run is indistinguishable
from a successful one at the process boundary: exit 0, `is_error: false`, empty worktree.
Always pass an explicit `--permission-mode`.

**`--permission-mode dontAsk` alone still denies `Write`.** Measured on CLI 2.1.259:
`decision_reason_type: "mode"`, nothing created, exit 0. The mode and an explicit
`--allowedTools` allowlist ship together or the process silently produces nothing.

**Because of the two above, never trust the exit code — judge by evidence.** This daemon
runs `git log <base>..HEAD` and `git status --porcelain` in the worktree and classifies on
what it finds. An agent reporting `complete` with no commits is recorded as *failed*; a run
killed at its deadline *with* commits is recorded as *partial* and still ships a draft PR.

**`--bare` skips `~/.claude`.** If your agent depends on globally installed skills, `--bare`
removes them and fails silently. Forbidden here, no exceptions.

**`--output-format stream-json` without `--verbose` is a hard startup error**, not a warning:
`When using --print, --output-format=stream-json requires --verbose`.

**Do not parse the session id out of the stream.** Many `hook_started` events precede
`system/init`. Pre-assign it: `--session-id $(uuidgen)`, and persist it before spawning.

**Read `result.structured_output`, not `result.result`.** With `--json-schema`, the former is
the parsed object; the latter is a string. A resumed session's `stop_reason` also differs
from a fresh one's.

**A resumed session must still carry `-p <answer>`.** `--resume` alone resumes the session
with no new input. It is `--resume <id> -p <answer>`, not one instead of the other.

**Inherited `CLAUDE*` environment variables break the spawned agent.** A probe run from
*inside* a Claude session inherited 22 such variables and had `Write` denied. Build the
child environment explicitly.

**`--help` is not the flag list.** `--max-turns` is a real, validated flag on CLI 2.1.259
and does not appear in `claude --help` — a project that greps the help output to decide what
is supported concludes the turn cap cannot be set. Probe with an invalid value instead:
`--max-turns notanumber` answers `option '--max-turns <turns>' argument 'notanumber' is
invalid. must be a number`, while a genuinely unknown flag answers `unknown option '--x'`.
The difference between those two messages is the test.

**`--max-budget-usd` rejects zero and negatives.** If you track spend across several
sessions of one logical run and pass the *remaining* budget, an exhausted run cannot simply
be handed what is left. Decide before the spawn — and when you stop, judge the run by the
evidence in its worktree, so work already committed ships as a draft instead of being thrown
away for running out of money.

**Under `--input-format stream-json`, a value passed to `-p` is silently discarded and the
session then hangs forever.** Measured on CLI 2.1.263 with stdin held open and nothing
written: eight `system/hook_started` and eight `system/hook_response` events arrived inside
0.7 seconds, and then nothing at all for ninety seconds — no `system/init`, no assistant
turn, no result — until the process was SIGKILLed. If your daemon has a wall-clock deadline,
every run burns the whole of it producing nothing while the log looks perfectly healthy.
Keep `-p` (the input format only works alongside `--print`), pass it **last and with no
value**, and write the prompt as one NDJSON `user` message on the child's stdin. Last
matters: an option following a bare `-p` can be eaten as its optional value. Add
`--replay-user-messages` and you get a positive receipt that the message was consumed —
which is the difference between diagnosing this in a sentence and not diagnosing it at all.
A deadline on that receipt is worth more than the receipt: a session that produces neither a
`system/init` nor any replayed message within a minute has not started, and reaping it then
turns a vendor-side regression from forty-five silent minutes into one loud one.

**A `result` event is per USER MESSAGE, not per run — so it is not the terminal event.**
Three messages written to one session produced three results (`num_turns` 3/3/3 under
`--max-turns 4`, so the turn budget is per message too), each with its own
`structured_output`, all carrying the same `session_id`. A second `system/init` is emitted
per message as well. The run ends when the **process exits**, and the only thing a result
should decide is when you close stdin. Treat it as terminal and you deliver a pull request
after turn one while the agent is still working. The subtler failure is the one that arrives
if this measurement ever stops holding: a CLI that emitted a result per *internal* turn
would not make a last-wins daemon ship early — it would make it close stdin mid-work, EOF
the child, and truncate a healthy run into a partial one. No scripted-stream test can see
that; only re-measuring against the real binary can.

**Two numbers on those results behave oppositely, and both are easy to get backwards.**
`total_cost_usd` is **cumulative for the session** — measured 0.391886 → 0.434957 →
0.478395 across three results — so take the last one and never sum it. `usage` is **per
message** — `input_tokens` stayed at 4 each time while `cache_read_input_tokens` climbed
36972 → 74262 → 74807 — so sum it, or a session the operator talked to under-reports what it
moved. One value per session, one value per message, sitting side by side in the same event.

**`--remote-control` accepts the flag, exits 0, and does nothing under `--print`.** Its help
text says it starts an *interactive* session, which is precisely what `-p` is not. Passed
alongside `-p --output-format stream-json --verbose` it produced no `remote` substring
anywhere in the stream, no key matching `/remote/i` among `system/init`'s twenty-four, no
state under `~/.claude` and no session registered at account level. It is not the control
channel; streaming input is.

**But do not conclude from that there is no control surface — `system/init` hands you one
on every run.** The same measurement found `messaging_socket_path` pointing at
`/tmp/cc-socks/<pid>.sock`, with the directory `drwx------` and the sockets `srw-------`:
the CLI already runs a per-session Unix socket at exactly the trust level a local tool would
want. This project does not use it and did not probe its protocol — it writes to the child's
stdin instead, which is measured and sufficient. Recorded because the next person who wants
a control channel will reach for `--remote-control`, find a no-op, and stop one line short
of the thing that might actually work.

**An MCP long-poll "ask the human" tool does not block the agent.** Claude Code backgrounds
a main-conversation MCP call after roughly two minutes and the agent proceeds without the
answer. The only reliable question mechanism is exit-and-`--resume`: the agent ends its turn
to ask, the process exits, and the answer arrives as the resumed turn's input.

**A field in your agent's output schema that nothing reads is not dead code — it is a
suggestion.** A `changedRepos: string[]` sat in the JSON schema under a comment saying when
it would be present; the parser read three other fields and the result type had no such
member. It survived a whole milestone harmlessly, and then the multi-repo feature arrived and
it was exactly the lever to reach for. Taking it would have made delivery trust the agent's
own account of what it changed — in a codebase whose first trap is that `claude -p` exits 0
having been denied every edit. Judge from the filesystem: `git diff --name-only <base>..HEAD`
was already being run before the push, so the honest answer cost one early return. Delete the
field in the same commit as the feature it would have been misused for; with
`additionalProperties: false` the deletion is total, because an unlisted field is one the
model physically cannot return.

## Linear's API and SDK

**`@linear/sdk` ships a new major roughly weekly** — 86.0.0 to 93.0.1 in fifteen weeks,
auto-generated from the GraphQL schema. `^93` and `~93` both guarantee an eventual silent
breaking bump. Pin exact.

**The `LinearWebhooks` class is gone in v93.** Its replacement, `LinearWebhookClient` +
`createHandler()` from `@linear/sdk/webhooks`, is itself a `node:http` request listener that
reads the raw body internally — which also solves the raw-body problem for you.

**Parsing the body before verifying the signature destroys it.** Re-stringifying a parsed
JSON body changes key order and unicode escaping, and the HMAC no longer matches. This is
why there is no HTTP framework in this project: adding one reintroduces a problem the SDK
handler otherwise removes.

**An invalid webhook signature returns 400, not 401.** A test asserting 401 never fires.

**`webhookTimestamp` is milliseconds**, and the ±60s staleness check is already inside the
SDK. Do not re-implement it in seconds.

**Rate limiting is HTTP 400 with `errors[].extensions.code === "RATELIMITED"`** — not 429.
Any `if (status === 429)` branch is dead code that never executes.

**The personal API key header has no `Bearer` prefix.** `Authorization: <KEY>`, verbatim.

**`client.webhookCreate` does not exist.** Those are GraphQL mutation names; the SDK methods
are `createWebhook` / `updateWebhook` / `deleteWebhook`. `tsc` catches it as TS2339.

**`fetchNext()` mutates and returns `this`**, appending into the existing `page.nodes`. Code
written as `const next = await page.fetchNext()` and then iterating both variables processes
the first page twice.

**Every `webhooks()` call pulls signing secrets into memory** — `WebhookFragment` selects
`secret`. Register it with your log redactor before the first call, not after.

**Creating a webhook requires workspace admin.** Worth confirming before designing around a
dedicated non-admin bot account.

**Linear's docs and the shipped schema disagree on whether the secret is returned at
creation.** The docs say no; `WebhookFragment` selects it and the schema comment says
"Automatically generated if not provided during creation." Sidestep it: generate your own
with `crypto.randomBytes(32).toString('hex')` and pass it in.

**A stock workspace has two states typed `started`** — "In Progress" and "In Review". Match
on name with a documented fallback, or you will move tickets to the wrong one.

**Issue `branchName` is server-supplied text that reaches your filesystem.** It becomes a
git worktree directory name here, so it is validated as a path component before use.

**Linear "Agents" are not assignees, and cannot create webhooks.** If your integration
picks up work by watching `assigneeId`, Linear's native bot accounts — Agents, a.k.a. app
users — will not trigger it. They are genuinely attractive: real workspace identities that
can be mentioned and commented as, and explicitly *not* billable seats. But assigning an
issue to an agent **delegates** it: the human stays the primary assignee and the agent lands
in a separate field, so an `assigneeId` watcher never fires. Agents also "cannot access
admin functionality", and webhook creation requires admin — so an agent cannot own its own
webhook either. Supporting them means routing on the delegate field and shipping an OAuth
app; it is a feature, not a configuration choice.

**There is no non-personal Linear API key.** Keys are always personal to a user; they can be
*restricted* (Read / Write / Admin / Create issues / Create comments, and to specific teams)
but never elevated beyond what that user can already do. A "bot account" is therefore a
second human-shaped member, and it must be a workspace **admin** if your integration
registers its own webhook. On Linear's **Free** plan every member is an admin automatically
and there is no billing, which makes Free the cheapest correct home for a bot.

**Suspending that bot account silently revokes its API key.** Billing counts *unsuspended*
users, so suspending an idle bot is the obvious way to stop paying for its seat — and it
invalidates the token immediately. The integration then fails 401 on every call, with
nothing in its own logs naming the cause and nothing about it having changed. Converting the
bot to a Guest does the same thing. If 401s ever appear from nowhere, check the bot's member
status before you check anything else.

## ngrok

**`@ngrok/ngrok` does not read `NGROK_AUTHTOKEN` automatically**, nor `~/.config/ngrok/`.
Pass `authtoken_from_env: true` explicitly.

**ngrok v3 on macOS writes its config to `~/Library/Application Support/ngrok/ngrok.yml`**,
not the XDG path.

**The malformed-token error echoes the token back in its message.** Anything that logs the
error object leaks the credential.

**Every ngrok error carries `code: "GenericFailure"`.** Branching on the code is useless;
match on the message.

**A second tunnel fails with a message that names the wrong cause.** `The endpoint
'https://<name>.ngrok-free.dev' is already online. ERR_NGROK_334` reads as a free-plan
tunnel-*count* limit and is not one: it is a static-domain conflict, because the account has
a reserved domain and the first process is already bound to it. The code passes no `domain`
at all — the static domain comes from the account. Read the endpoint *in* the message: it
names a domain, not a quota. A second instance that opens no tunnel never meets it.

## `gh`

**`gh pr create` has no `--json` flag.** It prints the URL on stdout — read it from there.
Note the narrow scope: `gh pr list --json` and `gh pr view --json` both exist and work.

**The ref you branch from and the ref you diff against must be the SAME STRING, or a stale
local base fabricates commits.** `git fetch` advances `refs/remotes/origin/main` and never
moves `refs/heads/main`, so a clone checked out on another branch drifts arbitrarily far
behind its own origin — one here sat 18 commits behind. Branch from the remote-tracking ref
and then compute `main..HEAD` and you get those 18 upstream commits for a run that committed
nothing. Anything gating on "did this produce commits" then says yes. The fix that does not
hold is resolving the ref again in the second reader: make the function that CHOSE the ref
RETURN it, carry that one string, and the two cannot disagree. Same rule for a value read
from config in three places — one lookup, or you will eventually ship three answers.

## SQLite and `better-sqlite3`

**`better-sqlite3@13` ships no type declarations** — TS7016 under `strict`. Add
`@types/better-sqlite3`. Registry metadata has neither a `types` nor a `typings` field, so
this is easy to miss.

**It refuses to bind a JavaScript boolean.** `{cancelRequested: true}` is a driver-level
`TypeError`. Convert to `0`/`1` at the store boundary.

**Declaring a timestamp column `TEXT` and writing epoch-millisecond numbers works — until it
doesn't.** SQLite's dynamic typing accepts it, and ordering stays correct only while every
value has the same digit count. Declare them `INTEGER`.

**A backtick inside a SQL comment closes the TypeScript template literal holding your
schema.** ``-- in `detail`, and ...`` produced a syntax error that aborted parsing of the
whole file and *suppressed 53 unrelated type errors downstream*. The error count fell from
46 to 3 and looked like progress. If an error count drops sharply, grep for TS1005/TS1128
before believing it.

**`PRAGMA journal_mode = wal` silently does nothing on `:memory:`.** A test asserting WAL
against an in-memory database can never fail and never verified anything.

## Node's test runner

**`node --test dist` runs zero tests on Node 22.** It treats the directory as a module to
execute and dies with `MODULE_NOT_FOUND` — while still printing a summary that looks like a
result. Verified with a two-test probe (one passing, one deliberately failing): the output
was "1 test, 0 pass, 1 fail" having run neither. Use a glob: `node --test "dist/**/*.test.js"`.

The general lesson, which cost more than the trap: **a fix to a verification mechanism must
itself be probed with a deliberately failing test.** The first fix for this was wrong and
looked right.

**`mock.method` on an ESM namespace object cannot work, and never could.** An ESM binding is
non-configurable *by specification* — `mock.method(execaModule, 'execa', …)` throws
`Cannot redefine property`. That was 22 of 56 failures on one gate run. `mock.module` is the
other way out and is `undefined` on Node 22 without `--experimental-test-module-mocks`. The
answer used here is dependency injection with the real implementation as the default
parameter, so no production call site changes.

**`node --test` cannot resolve a `.js` relative specifier inside a `.ts` file**, so with
`"module": "nodenext"` the tests must run against compiled output, not sources.

**`tsc` emits `.ts` and nothing else.** A `.jsonl` fixture beside its test never reaches
`dist/`, and both suites replaying it fail with a missing file. Copy non-TS assets in the
build script.

**Writing to stdout from a test child can desynchronise the runner's parser.** Under
`NODE_TEST_CONTEXT=child-v8`, a test file reports results as V8-serialized frames on fd 1.
This file failed roughly one run in five with
`Unable to deserialize cloned data due to invalid or unsupported version` and *no failing
assertion*. The child's bytes are deterministic, so the desync is upstream in the parent's
chunk handling — but silencing the code under test's own `console.log` removed the trigger:
1/20 corrupted with it, 0/80 without.

**Module-level state leaks between test cases in the same file.** A 90-second suppression
window held in a module-scoped map made three cases pass or fail depending on order.

## TypeScript and process control

**`typescript@latest` is now 7.0.2**, the Go-native `tsgo` rewrite, with known
type-checking behaviour gaps against large generated `.d.ts` files (`@linear/sdk` ships
~74k lines of them). Pin `~5.9` until your dependencies publish a compatibility statement.

**`erasableSyntaxOnly: true` bans constructor parameter properties** — and it binds every
file, including the ones written by someone who did not read the tsconfig.

**execa merges a supplied `env` over `process.env` unless you pass `extendEnv: false`.**
If you are building a child environment explicitly to *exclude* something, this silently
puts it back.

**execa 10 has no `.on()`.** Samples written against `node:child_process` do not port.

**`SIGINT` to a process group kills only the leader.** Measured: `detached: true` plus
`process.kill(-pid, 'SIGTERM')` reaped the child *and* its grandchildren; every other
combination left grandchildren alive. And a liveness check on the positive pid cannot see
the group the escalation exists to kill.

**An `async` function cannot return a memoised promise by identity** — `async` wraps every
return in a fresh promise, so `if (this.p) return this.p` in an `async` shutdown() hands
each caller a different object.

## Publishing the repository

**A realistic fake credential in a test fixture blocks your first push.** The secret-scanner
tests here check a Slack bot token of the correct shape —
`xoxb-<digits>-<digits>-<24 chars>` — and GitHub push protection rejected the initial push of
this repository because of it. The token was `1111111111-2222222222-aaaa…`; the scanner
cannot tell synthetic from real, and neither can a contributor's local scanner after they
clone. Note what did *not* trip: `ghp_AAAA…` and `sk-ant-api03-AAAA…` failed the vendors'
checksum/entropy checks, and `AKIAIOSFODNN7EXAMPLE` is AWS's own published example and is
allowlisted. Only the purely structural detector matched.

Clicking the "allow this secret" link works and is the wrong move — it puts a
push-protection bypass on the public record of a project whose whole subject is not failing
silently. Assemble the value at runtime instead, so no literal in the source matches while
the string the test actually exercises is byte-identical:

```ts
line: `slackToken: "${'xox' + 'b'}-1111111111-2222222222-${'a'.repeat(24)}",`,
```

Then break it once and confirm the case goes red, or you have changed a passing test into a
differently passing test. It does: 21 pass / 1 fail with the prefix broken, 22 / 0 restored.

**A test that boots your app may be reading credentials you forgot it needs.** Two of the
three integration suites here called `bootDaemon` without injecting a fake command runner, so
boot's preflight shelled out to the developer's real, authenticated `gh`. Locally: 511/511.
On the first CI run: 14 failures on all four matrix legs, with an error
(`law start: gh is not usable`) that reads like a product bug rather than a harness one.
Reproduce it before you have CI by putting a shim that exits 1 first on `PATH` — measured
0/14 with the shim, 14/14 without, and 511/511 with the shim after the fix. Keep CI
*unauthenticated* on purpose: adding a token would make those tests pass again without
fixing anything.

**Scan your own history before you create the repository, and scan it the way GitHub
does.** A grep for high-entropy patterns over the working tree is not enough — a public repo
exposes every commit, and the offending blob here was 262 commits back. Rewriting one blob
out of history with `git filter-repo --replace-text` costs minutes before the first push and
is unpleasant afterwards.

## Schema and logging

**Two migration runners, and the dead one had all the tests.** This project carried a
well-written runner — strictly-ascending version assertions, an explicit BEGIN/COMMIT per
migration, a report of what it applied, seven tests — that nothing in production called.
`openStore` used a duplicate hidden in the connection module with its own hardcoded
one-element list. Adding a second migration to the tested list applied *nothing*: the
compiler passed, every test passed, and the column simply did not exist until a `SELECT`
failed at runtime. If your project has a migration list, check which one the code that
opens the database actually reads, and assert it: one test that opens a real database and
compares `PRAGMA user_version` against the newest migration in the list closes this
permanently.

**Test the upgrade, not just the fresh install.** A migration that drops and recreates a
table passes every "empty database migrates to the latest version" test and destroys a
live operator's history. Write the case that seeds a v1 database, migrates it, and asserts
the old row is still there with a sane default in the new column.

**A substring-matching log redactor eats innocent fields.** A key pattern of
`/(token|secret|key|authorization)/i` also matches `tokensUsed` — a token *count* — so
every terminal log line here printed `"tokensUsed":"[REDACTED]"`. It went unnoticed for a
whole milestone because the field was hardcoded to `0`, and surfaced the instant it carried
a real number. Resist narrowing the pattern: over-redaction is the safe error for a log
sink, and under-redaction leaks a credential. Add an explicit exception list instead, so
anything new still fails closed — and write the test that goes red if someone later
"fixes" it by loosening the pattern.

**A per-session value written to a per-run row under-reports the runs that matter most.**
The first cut of the cost tracking here assigned the session's `total_cost_usd` to the run's
row. One run is one row, but it can be several `claude` sessions — every answered question
resumes it through the same code — so the row ended up holding the *last* session's cost.
A run that asked three questions reported a quarter of what it spent, and the error scales
with session count, so the most expensive runs were the most wrongly reported. Nothing
fails; the number is simply false. Ask of every write: *can this path run twice for one
row?* Accumulate if it can.

**Config keys that nothing reads are worse than missing features.** Three were found here
by grepping for consumers rather than definitions: `maxQuestionRounds` was validated by the
schema, prompted for by the setup wizard, written to disk — and its counter was set to `0`
at creation and never read, incremented or compared anywhere. The operator was told they
had a limit. `maxTurns` and `maxBudgetUsd` are the same shape. For every knob you expose,
grep for its *consumer*, not its declaration.


The way to find them is to grep for the **caller** of every exported entry point, not for
its definition. Seven dead exports hid in this codebase that way — a second Linear comment
poster, a second verdict classifier, a second migration runner, a complete second
composition root for a run, the prompt builder itself, a repo-list helper, and a set of
signal hooks — each compiling, each tested, none reachable. `tsc` cannot see this, a test
suite cannot see this, and code review does not either, because every file looks correct on
its own.

Two caveats learned by doing it:

- **A dead export is not automatically a missing wire.** One of the seven registered signal
  handlers that called `process.exit(0)`; wiring it would have raced the daemon's ordered
  shutdown and abandoned its in-flight bookkeeping. Check whether calling it would be
  *correct* before assuming it should be called. Its own test had to detach the handlers in
  a `finally` to avoid killing the test runner — which was the clue nobody read.
- **Check the test names, not just the code.** One helper's test was titled "so a child
  knows it is one of several". It asserted the helper returned the right list. The child
  never knew, because nothing consumed the list. A green test whose title states a promise
  the system does not keep is worth more attention than an uncovered line.

Where two representations of the same fact genuinely must both exist, the cheap fix is not
to unify them but to **assert their equivalence** — one test comparing a lookup table
against the arrays beside it turns an invisible drift into a red build.

## Shipping a CLI

**A directory whose `.git` is a FILE is not a repository you can offer someone.** It is a
linked worktree or a submodule — a checkout of a repository that lives elsewhere.
`fs.readdir(dir, {withFileTypes: true})` already tells you which, and a scanner that only
asks "is there an entry named `.git`" over-counts badly: on one working root, 33 directories
bore a `.git` entry, 12 as a directory and 21 as a file, and `git rev-parse --git-common-dir`
resolved all 33 to those same 12. Two picks that resolve to one repository then collide on
whatever key you index them by. Build the fixture with real `git worktree add` — a
hand-written `.git` file passes against a rule that only matches the shape you typed.


**`tsc` does not make your `bin` entry executable, and a clean build destroys the bit npm
set.** A `bin` mapping plus a `#!/usr/bin/env node` shebang is not enough: TypeScript emits
0644. `npm link` chmods the target at link time, so installing works exactly once — the next
build wipes `dist/` and recreates the entry non-executable, and the command dies with
`permission denied` (exit 126). Set the bit in the build itself, and assert it on the built
artifact.

The reason it survived a whole packaging pass here: `--help` had been "tested" by running
`node dist/src/cli/index.js --help`, which needs no executable bit at all. **Test a CLI by
invoking it the way the operator will** — through the name on their PATH — or you are
testing a different program than the one you shipped.

That argument applies to error messages too. **An error that names your options is only
useful if the options are typeable — and the test for it is a round trip, not a string
match.** This tool's "which run did you mean?" listing printed `issueKey repoSlug state`
while the matcher accepted only an id, an issue key, or a 4+ character id prefix. The
moment one ticket mapped to two repos, both candidates shared the issue key, so every line
led with the same token and retyping it reproduced the identical error — a dead end in
precisely the case disambiguation exists for. The doc comment above the function said the
output was "typeable straight back in".

The fixture half is the sharper lesson. The two-repo case was already in the test file —
two active runs, one key, two repos — and it asserted that both repo slugs appeared in the
error. The construction was there; the property was not. **A test that checks what an error
SAYS cannot see that the error is unusable as INPUT.** Split the message, take each line's
first token, feed it back into the same resolver, and require one run per token: that
assertion needs nobody to have thought about sibling runs, and it catches the next variant
too. It also caught a second copy of the naming rule one line away, in the `law watch`
command the success message suggests.

The other reason it survived: every fixture in the suite gave a mapping one repo, so the
multi-repo shape the product advertises had never been constructed at all. A monoculture of
fixtures is a monoculture of bugs you can find.

## What only a live run finds

Everything below was found by pointing this at a real Linear workspace for the first time,
after 594 passing tests and a green boot smoke. Each had been latent through eight phases.

**A poll that re-derives work from state re-runs everything the bot already finished.** The
reconciliation poll enqueued any assigned open issue with no *active* run. A delivered run
is terminal, so it did not block — and the watermark could not help, because **the bot's own
writes bump the issue's `updatedAt`**: moving it to In Progress and posting "Done" both push
it past the watermark. Sixty seconds after the first ticket delivered its pull request, a
second agent was working the same ticket. Left alone it opens a PR a minute, forever, at
real cost.

The fix that generalises: key the guard on the **producer's evidence class**, not on run
state. A webhook is an *act with an actor* — block it only if a run is live, or you break a
legitimate reassignment. A poll is *state the bot's own writes keep refreshing* — block it
if any run exists at all. If a code path derives work from state rather than from an event,
ask what your own writes do to that state.

**Two functions wrote a value for a next process that never read it.** Shutdown moved
in-flight runs to `queued`; boot recovery moved `preparing` to `queued`. Nothing ever
dispatched a queued row the current process had not created — the scheduler drained an
in-memory array, and the store query that would have found those rows was dead code. So
every Ctrl-C silently abandoned its work while the status command reported the run as
active. The comment above the shutdown write said it existed precisely to stop that.

Two traps hid inside that fix, and one of them no test could have caught: a requeued run's
session id is **spent**, and reusing it is a hard CLI error — but fakes never see the argv,
so the whole suite stays green while production fails every time. The other is timing:
starting the scheduler resolves parked slots as a *microtask*, so a drain on the next
synchronous line re-reads those rows as queued and drives them twice.

**A test that only fails in its own module has not proven the wiring.** After the
prompt-injection control turned out to be unit-tested and never called, this became a
procedure: delete the call site and check that the unit tests stay green while the
integration check goes red. Both red means the test targets the module; neither red means it
targets nothing. Running it here also caught a vacuous first attempt — the assertion passed
against unfixed code because the setup already manufactured the same event history.

**Both of the above were re-verified live after the fix, and that mattered.** Unit tests for
a crash-recovery path are written by the same understanding that missed the bug, so the fixes
were re-run against a real workspace: a ticket interrupted mid-flight with Ctrl-C, then the
daemon restarted. The lines that prove it are `dispatched runs left queued by a previous
process` followed by `queued -> preparing -> running`, and `poll observed an issue that has
already been attempted; ignoring` across five polls reporting `enqueued:0 resumed:0`. Exactly
one agent spawned, and one run row existed for the resumed ticket.

Two things surfaced only because that re-run happened. **Creating the test ticket with the
bot's own API key makes the bot the actor**, so its webhook is dropped as a self-event and
pickup falls back to the reconciliation sweep up to a full tick later — a delay that reads
exactly like broken ingress. And **worktrees are pruned at the next boot, not at delivery**,
so a running daemon accumulates delivered worktrees; that briefly looked like a leak from the
interrupted attempt, and is not one.

**A fetch updates remote-tracking refs only, so code that fetches and then names a bare
branch has not refreshed anything.** The worktree preparation fetched `origin` and then
branched from `baseBranch` — the string `"main"`, straight out of `config.json`. A bare name
is `refs/heads/main`, the local branch, and `git fetch` moves `refs/remotes/origin/main` and
nothing else. Every run forked off whatever the operator last pulled. Two of the three mapped
clones were level with their remote, so nothing showed; the third, `kardun`, sat 18 commits
behind its own `origin/main`, because it is checked out on `production` and its local `main`
only moves on an explicit fetch of that ref. A run there would have opened a pull request
against a base 18 commits stale. What kept this alive for a whole milestone is that the
comment directly above the fetch stated the correct intent, word for word — a run must not
fork off whatever the operator last happened to have pulled. The comment was right and the
line below it did the opposite, and the comment is what stopped anyone reading the line.

**An allowlist that under-grants is invisible in every signal the system emits.** The
spawned agent's `--allowedTools` was `Write Edit Bash`. On a real delivered ticket the agent
was refused `Skill` and `Read` — reason `mode` — and simply routed around both: it read files
with `head` and `cat` through `Bash`, did the work, and shipped a correct pull request. Exit
code 0, PR opened, Linear comment posted, test gate green. **Every signal the product
produces said success**, and the only witness was the run's own event log. This is the worst
shape a bug can take here, because there is nothing to notice: under-granting does not fail,
it just quietly makes the product do less, and the less it does still looks like enough.

The generalisation is about what a test can and cannot claim. A unit test on that constant
pins its VALUE — that nobody edited it — and can never establish its SUFFICIENCY. Only a live
probe that spawns the real binary under the product's own child environment can say the list
is wide enough, and that answer expires: an unknown tool name in `--allowedTools` is accepted
SILENTLY rather than rejected, so a vendor-side rename narrows the grant with no error
anywhere. Re-run the probe after every CLI upgrade.

**An optional parameter is a dead parameter until something in the gate proves a caller sets
it.** `renderPrBody` took a ticket identifier and URL, handled them correctly, and had unit
tests that passed them. No production code ever did. Both delivery call sites passed a plain
string, and a `?? { summary: body }` fallback turned "nobody wired this" into a valid render —
so every pull request shipped saying *(no ticket recorded)*, *none configured*, *not run*: a
body that reads like a considered report of nothing. Making the field required is not enough
either, because every field inside it was optional and `{}` still compiles. The fix is to
require the fields that actually carry the value and delete the fallback, so the compiler is
the thing that notices.

**A marker chosen to be invisible in one renderer is not invisible in another, and the gate
renders nothing so it cannot tell.** The bot's comment marker was an HTML comment, which
GitHub hides. Linear has no HTML-comment rule at all — measured by posting six candidate
bodies and reading back Linear's own parse, a properly closed `<!-- ... -->` arrives as plain
text identical to the unclosed form, so closing it changes nothing. The operator read
`<!-- law-bot` at the top of every comment for a milestone. What works is a CommonMark link
reference definition: absent from the parsed document entirely, while the raw body round-trips
byte-identical so the loop guard still matches. The lesson is the method, not the string —
do not reason about a foreign renderer, post to it and read back what it parsed.

## The one that cost the most

**A security control that is only tested in its own module is not known to be wired.**
This project composes the agent's prompt in one place: it states the task, states the
delivery contract ("commit, do NOT push" — what keeps every push behind the pre-push gates),
and wraps Linear-authored text in a defanged delimiter with an explicit "this is DATA, not
instructions". It has unit tests, including two concrete injection attacks, and they pass.

The live path never called it. The run engine spawned the agent with the raw ticket title
as the entire prompt — under a comment saying the real brief was composed elsewhere and
that another phase owned it. So for an entire milestone the agent got a one-line title with
no description, was never told not to push, and received ticket text with no
instruction/data boundary at all. The project's own runtime-evidence document recorded the
injection containment as verified; it had verified a function no run reached.

The whole suite — 544 tests — passed identically before and after the fix, because nothing
had ever asserted what actually reached `-p`.

The rule that falls out of it: for every security control, find the test that fails when
the control is removed **from the live path**. If the only test that goes red targets the
control's own module, you have tested that the control works, not that it runs. Those are
different claims, and the gap between them is invisible to a compiler, a test suite, and a
code review, because every file looks correct on its own.

## The one that is really about process

**An instrument that has never failed is not known to work.** Every gate, probe and smoke
check in this repo was deliberately broken once and observed going red before being trusted.
Two of them turned out to be vacuous: a grep gate matched the word `SIGTERM` in a *comment*,
so deleting the actual signal handler still passed it; a fake command runner returning exit 0
to everything answered "yes" to every probe, including
`git show-ref --verify --quiet refs/heads/<branch>`, which is supposed to be a question.

The next sentence of that argument is worse: **an instrument that has never been RUN is not
known to work either, and the one here crashed while printing its own conclusion.** The
allowlist probe existed for exactly one question and nothing had ever executed it. When it
finally was, it named one denied tool and then died on `JSON.stringify(undefined)` — which
returns the *value* `undefined`, so `.slice(0, 300)` threw — and the single line the whole
script exists to produce was never reached. The same root cause hid a second defect: two
different sources report the same refusal with different fields, and the probe concatenated
them, so it reported twice as many denials as there were.

Two habits come out of it. Exercise an instrument's FAILURE path on real data, not just its
happy path — the repaired probe was deliberately run once against the un-widened allowlist,
before anything was widened, precisely so the reporting path that had crashed was the path
under test. And where the product already owns a rule, the instrument should CALL it rather
than re-derive it; a probe carrying its own copy of a rule verifies its copy, not the thing
that ships.

**And the shape underneath both of those has now appeared eight times in this repository.**
That count is the lesson, not the individual entries: *a thing that exists, type-checks, is
tested, and is not connected to anything.* A renderer with no production caller. A path
constant nothing writes to. A parameter no caller sets. A migration runner with all the
tests and none of the calls. A timer that was documented and never built.

The seventh and eighth landed together. **A whole module whose doc comment reads exactly
like the live one's**: an ingress poll declared, described in its own header as the
reconciliation poll, and never called — while the real poll lived in another file under
another name. The header was accurate about *intent* and silent about *reach*, so a reader
took it for the live trigger and reasoned about the wrong query. **And a config toggle the
setup wizard writes, echoes back in its own review prompt, and nothing consults**: it
reached six layers as a schema field and had exactly one mention in production code — a doc
comment referring to a module that does not do the thing. Set it to false and the behaviour
it names carries on, with every signal reporting success.

Both have the same tell and the same cheap check: `grep` for the name, discard the schema,
the fixtures and the tests, and see what is left. If nothing is left, it is unimplemented —
the declaration is the claim, not the evidence. When two modules claim one job, find the
*caller* before reading either header. And when a toggle must actually take effect, gate it
at the one place every path goes through rather than at each call site: six guards is six
chances to forget, and the seventh site arrives with no guard at all.
