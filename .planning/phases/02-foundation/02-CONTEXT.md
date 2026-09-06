# Phase 2: Foundation - Context

**Gathered:** 2026-09-06
**Status:** Ready for planning
**Note:** Not separately discussed — decisions below are derived from Phase 1's locked
contract and from PROJECT.md. Nothing here was invented by the planner.

<domain>
## Phase Boundary

Validated config loading, the real SQLite store, and structured logging — SETUP-10 and
OPS-02. Behaves correctly enough that no other layer has to defend against it.

Out of scope: the wizard that writes the config (Phase 8), and any business rule. The
store is a dumb typed repository.
</domain>

<decisions>
## Implementation Decisions

- **D-01:** Config lives at `~/.linear-auto-worker/config.json`; secrets in a sibling
  `.env` at mode 0600; the SQLite database and logs in the same directory. Locked in
  Phase 1 (D-06, D-08).
- **D-02:** Validation is zod 4. Use v4 idioms — top-level `z.url()`/`z.email()`, and
  `z.prettifyError()` rather than v3's `.format()`/`.flatten()`. The error message must
  name the offending field and the shape expected, because the wizard renders it.
- **D-03:** Config shape is a global `defaults` block plus sparse per-mapping overrides
  for the six CONF-02 toggles. Mappings are keyed by Linear project **with a team-level
  fallback** (Phase 1 D-07, D-09).
- **D-04:** SQLite in WAL mode with a busy timeout. Migration is `PRAGMA user_version`
  plus numbered TypeScript modules exporting SQL template literals — never `.sql` files,
  because `tsc` does not copy non-TS assets and the dist build would ENOENT (Phase 1
  D-10, D-11).
- **D-05:** Logging is pino with a **global redacting serializer at the sink**, not
  per-call-site redaction. Per-call-site redaction is forgotten exactly once, and once is
  enough to put a Linear key in a logfile. Redact at minimum: `LINEAR_API_KEY`,
  `NGROK_AUTHTOKEN`, the webhook signing secret, and any `authorization` header.
- **D-06:** Every log line carries the run ID via a child logger (`log.child({ runId,
  issueId })`). This is checkable: no line anywhere may contain a key or authtoken.

### Claude's Discretion
Store method surface, index choices beyond the required ones (`delivery_id`,
`runs.state`, `questions.deadline_at`), and pino transport configuration.

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

Store is a dumb typed repository with no business rules — the RunEngine is the only
writer of `runs.state`. Foundation must not encode any state-machine knowledge.

</specifics>

<deferred>
## Deferred Ideas

None — phase scope is narrow and fully specified by STACK.md.

</deferred>

---

*Phase: 2-Foundation*
*Context gathered: 2026-09-06*
