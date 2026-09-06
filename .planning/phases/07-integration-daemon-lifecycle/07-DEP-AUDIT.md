# 07 — Dependency Legitimacy Audit

**Run:** 2026-09-06, plan 07-01 task 1, on the merged eight-branch tree.
**Method:** every `dependencies` / `devDependencies` key in `package.json` matched by
**name** against `.planning/research/STACK.md`. VERIFIED = the name appears in STACK.md.
ASSUMED = it does not, i.e. no one researched it and a parallel executor may have invented
it under rush mode.

**Result: 12 rows, 12 VERIFIED, 0 ASSUMED.** Nothing has been fetched from a registry by
this plan.

## Runtime dependencies

| Package | In package.json | STACK.md pin | Status | Note |
|---|---|---|---|---|
| `@inquirer/prompts` | `8.7.1` | `8.7.1` | VERIFIED | exact, matches |
| `@linear/sdk` | `93.0.1` | `93.0.1` | VERIFIED | **exact pin, no range operator** (T8: new major ~weekly) |
| `@ngrok/ngrok` | `1.7.0` | `1.7.0` | VERIFIED | exact, matches |
| `better-sqlite3` | `13.0.3` | `13.0.3` | VERIFIED | exact, matches |
| `execa` | `10.0.1` | `10.0.1` | VERIFIED | exact, matches |
| `pino` | `10.3.1` | `10.3.1` | VERIFIED | exact, matches |
| `zod` | `4.5.4` | `4.5.4` | VERIFIED | exact, matches |

## Dev dependencies

| Package | In package.json | STACK.md pin | Status | Note |
|---|---|---|---|---|
| `@types/better-sqlite3` | `^9` | unversioned in STACK install line | VERIFIED | STACK names it without a pin |
| `@types/node` | `^22` | `^24` | VERIFIED (version drift, deliberate) | see below |
| `pino-pretty` | `^13` | unversioned in STACK install line | VERIFIED | **currently unimported** — see below |
| `tsx` | `4.23.13` | `4.23.13` | VERIFIED | exact, matches |
| `typescript` | `~5.9` | `~5.9` | VERIFIED | T12: `latest` is the Go-native TS7 rewrite; the range correctly excludes it |

## Import-side cross-check

Every non-relative import across `src/` and `scripts/`, deduped to package roots:

```
@inquirer/prompts  @linear/sdk  @ngrok/ngrok  better-sqlite3  execa  pino  zod
node:assert node:crypto node:fs node:http node:net node:os node:path
node:sqlite node:stream node:test node:url node:util
```

Every third-party import resolves to a declared, VERIFIED dependency. **No import names a
package that is not in `package.json`, and no dependency is a package no import needs**
— with the two exceptions below.

### Exception 1 — `node:sqlite` is imported alongside `better-sqlite3`

`src/infra/store/migrate.test.ts:15` imports `DatabaseSync` from `node:sqlite`. Its own
header says why: *"nothing is installed on this branch"*. That is a rush-mode artifact,
not a second driver decision. STACK.md § What NOT to Use keeps `node:sqlite` out (still
`ExperimentalWarning` on Node 22/24). **Not a dependency problem — a LOCAL code item for
plan 07-03**, recorded in `07-COMPILE-INVENTORY.md`.

### Exception 2 — `pino-pretty` is declared but never referenced

No `.ts` file imports it or names it as a pino transport target. STACK.md explicitly
recommends it as a dev-only pretty-printer, so it is legitimate and researched, but today
it is dead weight. **Leave it**: plan 07-04/07-05 owns daemon logging and is the natural
place to wire it or drop it.

## `@types/node` version drift — deliberate, not an oversight

STACK.md's install line reads `@types/node@^24`, consistent with its recommendation that
the project run Node 24 Active LTS. `package.json` declares `^22`, and `engines` declares
`node: ">=22"`.

**Kept at `^22` on purpose.** This machine runs **Node v22.23.1**. Typing against `^24`
while executing on 22 lets `tsc` accept standard-library APIs the runtime does not have —
a green typecheck that fails at boot, which is exactly the class of silent break Phase 7
exists to eliminate. The types should track the runtime, not the aspiration.

**Upgrade path:** when the operator upgrades to Node 24 (STACK.md's setup-wizard preflight
already asks for it), bump `@types/node` to `^24` and `engines.node` to `>=24` in the same
commit. Until then these three numbers agree, which is the property that matters.

## Prior verification

`.planning/TRAPS.md` § *Verified clean* records a real `npm install` of exactly this
pinned set on 2026-09-06: 87 packages, 11 s, every pin resolving as written,
`typescript@~5.9` → 5.9.3 (correctly **not** the TS7 rewrite), `better-sqlite3@13.0.3`
shipping a prebuilt `darwin-arm64.node`, `@ngrok/ngrok-darwin-arm64` present via
`optionalDependencies`. That install is present on `main`, and this worktree's
`package.json` and `package-lock.json` are **byte-identical to main's** (`diff -q`, both
clean). So the merged set is not merely audited on paper — it is the set that already
resolved.
