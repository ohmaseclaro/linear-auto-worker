# Traps

One hundred and two footguns found while building this daemon, kept as a running ledger so no two
parallel work streams had to rediscover the same one.

**Every entry here was measured, not recalled.** Versions come from the npm registry, API
surfaces from reading the installed package's `.d.ts`, CLI behaviour from running the CLI,
and HTTP behaviour from standing up a real server and POSTing to it. Where a vendor's own
documentation contradicted the shipped artifact, the artifact won and the entry says so.

The point of publishing it: most of these are not specific to this project. If you are
wiring Linear webhooks, driving `claude -p` from a daemon, or writing Node tests that
spawn processes, several of them will cost you an afternoon each.

Measured against: `@linear/sdk@93.0.1`, `@ngrok/ngrok@1.7.0`, `better-sqlite3@13.0.3`,
`execa@10.0.1`, Claude Code CLI `2.1.259`, `gh` `2.98.0`, Node `22.23.1`, macOS.

The complete internal ledger — all 102 rows with per-phase attribution and the evidence for
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

**An MCP long-poll "ask the human" tool does not block the agent.** Claude Code backgrounds
a main-conversation MCP call after roughly two minutes and the agent proceeds without the
answer. The only reliable question mechanism is exit-and-`--resume`: the agent ends its turn
to ask, the process exits, and the answer arrives as the resumed turn's input.

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

## ngrok

**`@ngrok/ngrok` does not read `NGROK_AUTHTOKEN` automatically**, nor `~/.config/ngrok/`.
Pass `authtoken_from_env: true` explicitly.

**ngrok v3 on macOS writes its config to `~/Library/Application Support/ngrok/ngrok.yml`**,
not the XDG path.

**The malformed-token error echoes the token back in its message.** Anything that logs the
error object leaks the credential.

**Every ngrok error carries `code: "GenericFailure"`.** Branching on the code is useless;
match on the message.

## `gh`

**`gh pr create` has no `--json` flag.** It prints the URL on stdout — read it from there.
Note the narrow scope: `gh pr list --json` and `gh pr view --json` both exist and work.

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
