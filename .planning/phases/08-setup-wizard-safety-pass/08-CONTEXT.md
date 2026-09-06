# Phase 8: Setup Wizard & Safety Pass - Context

**Gathered:** 2026-09-06
**Status:** Ready for planning

<domain>
## Phase Boundary

One command takes a fresh machine to a working, webhook-registered daemon. Preflight,
secrets, interactive mapping, repo checks, and a registration step that means setup ends
with a system that is already working rather than merely configured.

The config **shape** it writes was fixed in Phase 1; this phase writes the wizard, not the
schema.
</domain>

<decisions>
## Implementation Decisions

- **D-01:** Node preflight **warns** below 24 and **hard-fails only below 22**.
  `better-sqlite3@13` and `execa@10` both require `>=22`, so 22 genuinely works — 24 is
  the Active LTS recommendation, not a dependency floor. The operator's own machine runs
  v22.23.1, so hard-failing at 24 would make refusing to run the wizard's first act.
- **D-02:** Repo discovery **scans one operator-named directory to depth 2** for `.git`
  and presents the results as a checklist. No filesystem-wide scan; no hand-typed paths
  (SETUP-07 rules out hand-editing JSON, and typos become mappings that fail at first run
  rather than at setup).
- **D-03:** A mapped repo with no `CLAUDE.md` or `AGENTS.md` gets a **prominent warning
  plus an offer to generate a starter file**. Research names this the highest-leverage
  success factor; a warning whose fix is a separate project never gets acted on.
- **D-04:** Re-running the wizard **edits in place and skips anything already valid**.
  SETUP-04 already requires skipping present secrets; extending that to the whole flow
  makes the wizard the way a repo mapping gets added later, rather than a one-time ritual.
- **D-05:** Only `LINEAR_API_KEY` and `NGROK_AUTHTOKEN` are ever prompted. The ngrok token
  is lifted out of `~/.config/ngrok/ngrok.yml` when present — note the SDK itself does
  **not** read that file, only the environment, so the wizard must copy it into `.env`.
- **D-06:** The Linear key is validated with a live call and its **workspace-admin
  permission probed** via a `webhooks()` read. `webhookCreate` requires admin and a plain
  Member key fails; the failure must name the exact fix rather than surfacing a raw error.
- **D-07:** Every mapped repo is checked for a remote and a resolvable default branch,
  which is **recorded into the mapping**. Four other layers consume it.
- **D-08:** Preflight covers Node, git and git identity, `gh auth status`, `claude` on
  PATH, and the global GSD install. Each check reports an **actionable fix**, never a
  stack trace.
- **D-09:** Also warn if branch protection is absent on the mapped repo's default branch.
  Research calls it the highest-leverage safety control precisely because it is
  server-side and out of the spawned agent's reach.

### Claude's Discretion
Prompt library ergonomics (`@inquirer/prompts` is the pick), wizard step ordering beyond
"registration last", and output styling.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Binding contract (read first)
- `.planning/phases/01-domain-contract-state-machine-schema/01-CONTEXT.md` — **binding**.
  Its ADDENDUM fixes the exact state literals, table names, config shape and module paths.
  All eight phases were fanned out simultaneously under rush mode, so this text — not the
  code, which may not exist on your branch yet — is the contract. Import from
  `src/domain/`; do not define your own copy of anything it names. If you need a port
  method that does not exist, record it in your SUMMARY under `Contract additions
  requested` rather than editing `src/domain/`.
- `.planning/TRAPS.md` — running ledger of verified footguns. Read every row.

### Project
- `.planning/PROJECT.md` — Key Decisions table and Constraints
- `.planning/REQUIREMENTS.md` — this phase's mapped requirement IDs
- `.planning/ROADMAP.md` — this phase's goal and success criteria

### Research
- `.planning/research/SUMMARY.md` — § Corrections to PROJECT.md, § Non-Negotiable
  Invariants, § Build Order Constraints
- `.planning/research/PITFALLS.md` — the failure modes this phase must avoid
- `.planning/research/STACK.md` — pinned versions and library idioms
- `.planning/research/ARCHITECTURE.md` — five-layer decomposition

</canonical_refs>

<code_context>
## Existing Code Insights

Greenfield. All eight phases are being built simultaneously in isolated worktrees under
rush mode, so no sibling phase's code is on your branch and none of it can be imported.
Build against the binding contract text in `01-CONTEXT.md` and against the in-memory
fakes it specifies. Do not attempt to read or import another phase's files.

</code_context>

<specifics>
## Specific Ideas

SETUP-09's end-to-end verification depends on Phase 7. Under rush mode Phase 8 is built
in parallel anyway; SETUP-09's actual verification is **live-gated** and belongs on the
HUMAN-UAT checklist, not in the build.

</specifics>

<deferred>
## Deferred Ideas

None.

</deferred>

---

*Phase: 8-Setup Wizard & Safety Pass*
*Context gathered: 2026-09-06*
