## What this changes

<!-- One paragraph. What is different afterwards, and why it needed to be. -->

## How it was verified

<!--
Not "tests pass" — what did you actually observe?

If you added or changed a test, gate or assertion, say that you broke it once on purpose
and watched it fail. An instrument that has never failed is not known to work; two checks
in this repo were vacuous until someone did that. See CONTRIBUTING.md.

If you are asserting how an external tool behaves (the Linear SDK, `claude`, `gh`, ngrok,
SQLite), say how you checked — the installed `.d.ts`, a live request, an actual CLI run.
-->

## Checklist

- [ ] `npm run verify` is green
- [ ] No test deleted or assertion weakened to make it green
- [ ] New footguns, if any, added to [`docs/TRAPS.md`](../docs/TRAPS.md)
- [ ] Comments explain *why*, where the why is not obvious
