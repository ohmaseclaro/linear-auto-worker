# Security

## Reporting a vulnerability

Use GitHub's private reporting: **[Security → Report a vulnerability][advisory]** on this
repository. That opens a private advisory visible only to you and the maintainers.

Please do **not** open a public issue for anything exploitable.

Include what you did, what happened, and what you expected. A proof of concept helps but is
not required. Expect a first response within a week; this is a personal project, not a
funded one, and that is the honest number.

[advisory]: https://github.com/ohmaseclaro/linear-auto-worker/security/advisories/new

## What this tool is, in security terms

Be clear-eyed about what you are running. `linear-auto-worker` takes text written in a
Linear ticket and uses it to drive an AI coding agent that has **write and shell access to
your local git repositories**, then pushes branches and opens pull requests under your own
`gh` credentials.

It runs on one operator's machine, under that operator's account. There is no auth layer, no
user model, and no multi-tenancy — adding any of those would be a different product.

## The trust boundary you accept by using it

**Every repository you map is implicitly fully trusted.** The spawned agent runs without
`--bare` (which would strip the globally installed skills the tool depends on), and the
consequence is that a mapped repository's own `.claude/settings.json` hooks execute
unprompted inside that session. Map only repositories you would already be willing to run
arbitrary code from.

**Ticket text is untrusted input that reaches an agent.** Anyone who can file or edit an
issue in a mapped Linear project can put text in front of your agent. This is treated as a
real attack surface, not a theoretical one:

- The issue body **and** any answer you post to the bot's question are wrapped in a
  delimiter that is defanged against a closing-tag escape, and the containment is asserted
  by tests that run concrete injection attacks against both paths.
- The prompt is a single `argv` entry. There is no shell anywhere on the spawn path, so a
  ticket title cannot break out of it.
- Linear-supplied `branchName` is validated before it becomes a filesystem path.

> **This section described the wrong thing until 2026-09-07.** The containment above was
> written in Phase 4 and tested there — and the code that actually ran never called it. The
> live path sent the raw ticket title as the entire prompt, so ticket text reached the agent
> with no instruction/data boundary at all, and the answer path passed a Linear comment
> through verbatim. Both are fixed, both are now asserted on the live path (an end-to-end
> test that fails if the delimiter is absent, not only a unit test of the builder), and the
> whole class is recorded as T99. If you ran a version of this before that date, its
> injection containment was not active.

It is still input written by someone else that steers a program with write access to your
code. Treat mapped Linear projects with the same care as repository write access.

## Guards that are actually in place

| Guard | What it stops |
|---|---|
| HMAC verification on every webhook, with the raw body never re-parsed first | Forged or replayed deliveries |
| Delivery-id dedupe and a self-event marker | The bot reacting to its own writes, and loops |
| Push refused on the default branch | An agent committing straight to `main` |
| Secret-pattern scan of the diff, push blocked on a hit | Credentials leaving in a PR |
| CI-file changes flagged on the PR | An agent quietly editing its own gates |
| Worktree paths confined to configured repositories | Writes escaping the mapped repos |
| Secret redaction in the logger, including secrets registered after boot | API keys and the webhook signing secret in logs |
| `.env` written at mode 0600 | Local credential exposure |

**Branch protection on the default branch is the one guard a prompt-injected agent cannot
reach**, because it is enforced by GitHub rather than by this process. The setup wizard
warns when a mapped repository does not have it. Turn it on.

## Out of scope

- Anything requiring an attacker to already have shell access as the operator.
- The AI agent producing wrong or low-quality code. That is what the pull request review is
  for — every PR is a draft by default.
- Compromise of the upstream tools this shells out to (`claude`, `gh`, `git`, ngrok).
- ngrok exposing a local port to the internet. That is the tool's stated purpose; the
  endpoint verifies HMAC on every request and serves nothing else.

## Supported versions

The `main` branch. This is a pre-1.0 single-operator tool with no release train and no
backports.
