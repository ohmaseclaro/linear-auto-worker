# Contributing

Thanks for looking. This is a single-operator daemon, so the bar for a change is not "does
it work on your machine" — it is "does it still work on a machine you will never see,
three months from now, when the tool it drives has shipped twelve new versions."

## Getting set up

```bash
npm install
npm run verify
```

`npm run verify` is the whole gate: clean, `tsc`, copy non-TS assets, run every test, then
boot the daemon against fakes and shut it down. It takes about 45 seconds on a laptop and
needs no credentials, no network, and no Linear workspace. **A pull request is expected to
leave it green**, and CI runs exactly the same command.

That last claim is enforced rather than trusted: CI runs deliberately unauthenticated, and
it is verifiable locally by putting a `gh` shim that exits 1 first on your `PATH` — the gate
stays 511/511. It did not always: two integration suites used to boot the daemon without a
fake command runner and were quietly passing on the author's `gh` login. See T91.

If `verify` fails on a fresh clone before you have changed anything, that is a bug — please
open an issue rather than working around it.

## The three rules that actually matter here

**1. Measure it; don't recall it.** Every claim in [`docs/TRAPS.md`](docs/TRAPS.md) was
verified against the real tool — the installed `.d.ts`, a live HTTP request, an actual CLI
invocation. Training data and vendor prose have both been wrong about this stack, in ways
that cost days. If you assert an API behaves some way, say how you checked.

**2. An instrument that has never failed is not known to work.** If you add a test, a gate,
a smoke check or an assertion, break it once on purpose and watch it go red before you trust
it. Two checks in this repo were vacuous until that was done: a grep gate matched the word
`SIGTERM` in a comment, so deleting the actual signal handler still passed; and a fake
command runner returning exit 0 to everything answered "yes" to every probe, including one
whose whole job was to ask a question. This applies with special force to a fix *to a
verification mechanism* — the first fix for the `node --test` trap was wrong and looked
right.

**3. Nothing on this path may fail silently.** The defining hazard of the design is that
every way a run can be misconfigured exits 0 and reports success: an agent denied every
tool, an agent that never loaded its skills, an agent that produced nothing at all. That is
why success is judged by evidence in the worktree rather than by exit code. A change that
introduces a new way to be silently wrong will be asked to add the detector alongside it.

## Style, such as it is

- **Comments explain *why*, and cost is no object when the why is non-obvious.** Several
  modules here carry long header comments recording what was measured and what was rejected.
  That is deliberate: the alternative is the next person re-deriving it from a stack trace.
- **Dependency injection over module mocking.** `mock.method` on an ESM namespace cannot
  work, so seams take the real implementation as a default parameter. Production call sites
  stay unchanged; tests pass a stub.
- **No new dependency for what a few lines can do.** The pins are exact and deliberate;
  `@linear/sdk` in particular ships a new major roughly weekly and must never carry a range.
- **Tests live inside `src/`** (`tsconfig` is `rootDir: "src"`), and run against compiled
  output in `dist/`.

## Adding to the traps ledger

If you lose an afternoon to something, that is a contribution. Add it to
[`docs/TRAPS.md`](docs/TRAPS.md) with the failure mode, the correct move, and how you
verified it. This is the part of the repository most likely to be useful to a stranger.

## Planning artifacts

`.planning/` holds the full record of how this was built — requirements, per-phase context
and plans, verification reports, and the raw 103-row traps ledger. It is kept deliberately.
You do not need to read it to contribute, and you are not expected to add to it.

## Pull requests

- One coherent change per PR, with a message that says *why*.
- `npm run verify` green.
- No test deleted or assertion weakened to make the gate pass. If a test is wrong, say so
  in the PR and explain what it should have been asserting.

## Reporting a security issue

Do not open a public issue — see [SECURITY.md](SECURITY.md).
