---
task: "The structured PR body is never called, the issue key is missing from the PR title, and the bot marker renders as visible text in Linear"
id: 260909-lvl
type: quick
severity: P1
created: 2026-09-09
branch: main
files_modified:
  - src/domain/types.ts
  - src/domain/contract.test.ts
  - src/domain/ports.ts
  - src/domain/fakes.ts
  - src/ingress/guards.ts
  - src/ingress/guards.test.ts
  - src/orchestration/questions.ts
  - src/orchestration/questions.test.ts
  - src/orchestration/run-engine.ts
  - src/orchestration/run-engine.test.ts
  - src/orchestration/fanout.test.ts
  - src/orchestration/recovery.test.ts
  - src/outbound/notify/linear-channel.ts
  - src/execution/deliver.ts
  - src/execution/deliver.test.ts
  - src/cli/adapters.ts
  - .planning/TRAPS.md
  - docs/TRAPS.md
  - README.md
gate: npm run verify   # 661/661 + boot smoke green before; report the exact number after
must_haves:
  truths:
    - "Every PR the worker opens carries `[COD-N](url)` under `## Ticket`, sourced from the run row — not `(no ticket recorded)`."
    - "`prBody` is REQUIRED on `DeliverInput` and on the `Deliverer` port, so a caller that does not build a structured body does not compile. The `body: string` fallback is deleted, not deprecated."
    - "`## Run log` prints the path the run log is actually written to. The same derivation feeds the failure-diagnosis comment, which today prints a directory nothing ever creates."
    - "`## Tests` still renders `none configured for this repository` / `**not run**`, because no code in this repository runs a test command. Nothing fabricates a result."
    - "Every PR title begins with the issue identifier, joined AFTER the agent's half is sanitized, and never doubled when the agent already led with the key."
    - "No comment the bot posts to Linear shows the marker to a human reader — verified against Linear's own parser, not reasoned about."
    - "`isBotAuthoredBody` recognises BOTH the new marker and the legacy `<!-- law-bot` form, so a year of existing Linear comments stays filtered."
  artifacts:
    - "src/execution/deliver.ts — `prBody` required; `renderPrBody(o.prBody)` with no `??` fallback; the identifier prefix applied to the title where the sanitizer already lives."
    - "src/orchestration/run-engine.ts — both `deliverer.deliver(...)` call sites build a `PrBodyInput` from the run row and the `AgentResult`."
    - "src/domain/types.ts — `BOT_COMMENT_MARKER` (a complete CommonMark link reference definition), `isBotAuthoredBody` with a legacy arm, `daemonDirOf`; `LOG_DIR` and `ConfigPaths.logDir` deleted."
    - "src/orchestration/run-engine.test.ts — the T109 integration assertion on `FakeDeliverer.calls[0].pr.prBody`."
    - ".planning/TRAPS.md rows T119/T120; docs/TRAPS.md prose; README count 118 → 120."
  key_links:
    - "`run-engine.dispatch()` → `Deliverer.deliver` → `createDeliverer` → `deliverPullRequest` → `renderPrBody` — four hops, and the renderer sat at the far end of it unreached for a whole milestone."
    - "`deliver.ts` title composition → `prBody.ticketIdentifier` — one source for the identifier in the title and the identifier in the body, so the two cannot disagree."
    - "`domain/types.ts:daemonDirOf` → `run-log.ts:runLogPath` — one derivation of the daemon dir, consumed by `adapters.ts` and `run-engine.ts` alike."
---

<objective>
Three defects, one theme: **a value that is rendered correctly by a function nobody calls is
indistinguishable from a value that ships.** Wire the structured PR body to its live call
site, put the issue identifier in the PR title, and stop the loop-guard marker from being
readable by a human on the Linear ticket.

A fourth defect surfaced while establishing the first (the run log path), and is fixed here
because populating `runLogPath` honestly is impossible without it.
</objective>

<measured_facts>
Read from source at HEAD, from the live Linear API, and from the operator's real PRs.
Nothing recalled.

**M1 — the delivery chain, and where the structured body dies.**
`run-engine.ts:625-628` (`complete`) and `:648-660` (`partial`) call
`deliverer.deliver(worktreeOf(run), repoOf(run), { title, body })`. The port
(`ports.ts:299-315`) declares `pr: { title: string; body: string; draft?: boolean }` —
there is no channel for a structured body at all. `adapters.ts:564-585`
(`createDeliverer`) forwards `body: pr.body` to `deliverPullRequest`. `deliver.ts:105` then
reads `renderPrBody({ ...(o.prBody ?? { summary: o.body }), ciPaths: gates.ciPaths })`.
`o.prBody` is `undefined` on every production path, so the fallback wins every time and
every structured field renders its "missing" branch.

**M2 — `grep -rn "ticketUrl\|ticketIdentifier" src` returns two files**: `pr-body.ts` (the
declaration and the renderer) and `deliver.test.ts:74,244-245` (a test that passes both).
Zero production callers. Confirmed.

**M3 — there is no `src/execution/pr-body.test.ts`.** The task brief names
`pr-body.test.js` as the module suite that must stay GREEN under the T109 deletion; it does
not exist. The `renderPrBody` unit tests live inside `src/execution/deliver.test.ts`. The
T109 pair is therefore **`deliver.test.js` GREEN / `run-engine.test.js` RED**, and Task 2
states it that way.

**M4 — the fields that have a truthful source at the call site.** `RepoRun` carries
`issueKey` (`types.ts:72`) and `issueUrl` (`types.ts:74`). `AgentResult` for `complete` and
`partial` carries `summary`, `prTitle`, `prBody` (`agent-result.ts:25-33`) — and nothing
else. Specifically:

| `PrBodyInput` field | Source at the call site | Decision |
|---|---|---|
| `ticketIdentifier` | `run.issueKey` | **wire** |
| `ticketUrl` | `run.issueUrl` | **wire** |
| `summary` | `result.prBody` (what `body` carried today) | **wire**, unchanged content |
| `verdict` | the `dispatch` switch arm | **wire** |
| `runLogPath` | see M5 | **wire**, once M5 is fixed |
| `testCommand` | none — see M6 | leave unpopulated |
| `testResult` | none — see M6 | leave unpopulated |
| `didNotDo` | none — `AgentResult` has no such field | leave unpopulated |

**M5 — `runLogPath` has no truthful value today, because the daemon has two disagreeing
derivations of where run logs live.** `run-engine.ts:426-427` builds
`` `${LOG_DIR}/${runId}.log` `` = `~/.linear-auto-worker/logs/<id>.log`. The file is actually
written by `adapters.ts:466` via `openRunLog(daemonDirOf(config), runId)` →
`run-log.ts:37-39` → `path.join(root, 'runs', runId + '.jsonl')` =
`~/.linear-auto-worker/runs/<id>.jsonl`. Verified on the operator's machine:

```
$ ls ~/.linear-auto-worker/
.env  config.json  runs/  say.sock  store.db  worktrees/
$ ls ~/.linear-auto-worker/logs
ls: /Users/augustoclaro/.linear-auto-worker/logs: No such file or directory
$ ls ~/.linear-auto-worker/runs | head -1
19c0b7c7-e96b-4860-902f-bd2a24ed1605.jsonl
```

Wrong directory, wrong extension. `LOG_DIR` is `DEFAULT_PATHS.logDir` (`types.ts:370`), which
`configPaths()` declares at `:348` and which **nothing ever creates or writes**. So the
failure-diagnosis comment `run-engine.ts:433` has been telling the operator to read a file at
a path that cannot exist. Populating `runLogPath` from `logPathFor` would print that same
fabrication in every PR. `grep -rn logDir src` returns only `types.ts:327,348,367,370` and
three test fixtures — no other consumer.

**M6 — nothing in this repository runs a test command.** `grep -rn "testCommand"` outside
`pr-body.ts` returns exactly one hit, `deliver.test.ts:247`. `runPrePushGates`
(`deliver.ts:70-75`) reads the diff and the changed file list; it runs nothing.
`MappingToggles` has no test-command field. The honest render is the one already written:
`none configured for this repository` / `**not run**`.

**M7 — the real PR titles.** `gh pr list -R dzfweb/miracle-shop --state all`:

| # | title | branch |
|---|---|---|
| 3 | `docs(readme): índice de seções no topo, com as âncoras que o GitHub gera` | `claude/cod-9-adicionar-indice-toc-no-readme` |
| 2 | `feat(common): add slugify helper` | `claude/cod-8-add-a-slugify-helper-to-libscommon` |
| 1 | `feat(common): add formatDuration and its inverse parseDuration` | `claude/cod-7-add-a-duration-formatting-utility-to-libscommon` |

**None of the three leads with the identifier.** All three are conventional-commit subjects.
The branch already carries `cod-N`, so Linear's linking has one hook today; the title gives
it a second and gives a human reader the first. The anti-double-prefix rule is a guard
against a shape not yet observed, so it must not be tuned to a sample of zero — it is
specified by boundary (M11) rather than by these three strings.

**M8 — Linear does not parse HTML comments AT ALL. Measured, not reasoned.** Six candidate
bodies were posted through `commentCreate` to a throwaway issue (COD-10, created and
`issueDelete`d for this probe; COD-7/8/9 untouched) and read back with `body` and
`bodyData`. `bodyData` is Linear's own ProseMirror parse — what the editor renders.

| Form sent | `bodyData` for the marker block | Renders as |
|---|---|---|
| `<!-- law-bot` (current) | `{"type":"paragraph","content":[{"type":"text","text":"<!-- law-bot"}]}` | **visible text** |
| `<!-- law-bot -->` (properly closed) | `{"type":"paragraph","content":[{"type":"text","text":"<!-- law-bot -->"}]}` | **visible text** |
| `<!-- law-bot --> body` (inline) | one paragraph, marker inside the text node | **visible text** |
| `<!-- law-bot:q:abcdef01 -->` | `{"type":"paragraph","content":[{"type":"text","text":"<!-- law-bot:q:abcdef01 -->"}]}` | **visible text** |
| `[](#law-bot)` | `{"type":"paragraph"}` — an EMPTY paragraph | invisible marker, **visible blank line** |
| pure zero-width `U+200B U+200C …` | `{"type":"paragraph","content":[{"type":"text","text":"<five zero-width chars>"}]}` | invisible, **visible blank line** |
| **`[//]: # (law-bot)`** | **the paragraph is ABSENT from `bodyData` entirely** | **nothing** |

**Closing the HTML comment does not help.** Linear's markdown parser has no HTML-comment
rule; it turns the whole thing into a text node either way. That kills the first candidate
in the brief outright.

`[//]: # (law-bot)` is a CommonMark **link reference definition**: a label, a colon, and a
destination. CommonMark specifies that link reference definitions produce no output, and
Linear's parser implements that — the block does not appear in `bodyData` at all. The raw
`body` round-trips byte-identical through the API (`ROUNDTRIP: IDENTICAL` for every candidate
tested), so `isBotAuthoredBody` reading a webhook payload or a re-fetched comment still sees
it.

**Block position is required.** Candidate C proves an inline marker stays in the paragraph.
The winning form was sent as `marker + "\n\n" + body`; that separator is part of the fix, not
cosmetic (M12).

**M9 — the question-marker machinery is dead, and `correlate()` refuses to use it by
design.** `correlate()` (`questions.ts:60-108`) documents: *"Correlates on the stored
`linearCommentId` and never on the comment body: SQLite is the source of truth and Linear
comments are an editable projection… (T-06-13)"*. Tier 1 matches `comment.parentId` against
`q.linearCommentId`; tier 2 is the exactly-one-open-question fallback. Neither reads a short
code. `grep` confirms `questionMarker()` and `questionShortCode()` (`types.ts:399,408`) are
called **only from `contract.test.ts`** — a second instance of the T99/M2 shape in the same
file being edited. The brief's premise that "question-comment matching depends on it" is not
borne out by the code; the dependency is `linearCommentId`.

**M10 — the marker leaks a second time, visibly and on purpose.** `questions.ts:302-306`
builds `` shortCode = `${QUESTION_MARKER_PREFIX}${question.id.slice(0, 8)}` `` and renders it
**inside a code span in the human-facing body**: `` `<!-- law-bot:q:abcdef01` ``. So a question
comment shows the marker twice — once as the leading line and once as a code span mid-body.

**M11 — the three marker writers.** `run-engine.ts:277-279` `botBody()` =
`` `${PREFIX}\n\n${text}` `` (blank line, correct block position). `questions.ts:149-151`
`botBody()` = `` `${PREFIX}${body}` `` (**no separator** — inline, so the new marker would be
parsed as paragraph text; this is why M12 is a required edit, not a tidy-up).
`outbound/notify/linear-channel.ts` **writes no comments at all**: its header claims across
lines 6-11 that "this channel writes it onto every comment", but the file contains no
`createComment` call and does not import the marker. Its `composeBody()` is consumed by
`SlackChannel`. A doc comment asserting a security guard the file does not implement is
itself a trap; it gets corrected here.

**M12 — the guard layer this protects.** `guards.ts:108-123`: layer 1 drops
`actor.id === botUserId` (`actor:self`); layer 2 drops any `Comment` whose body satisfies
`isBotAuthoredBody` (`marker:bot-authored`). A null actor is already dropped outright at
`:101-105` (`actor:null-untrusted`), so of the three justifications in the `types.ts:379-384`
doc comment, only "a stale cached bot id / a re-created bot user" is still live. The marker
stays; it just stops being readable.
</measured_facts>

<design>
## Defect 3 — one complete marker, two accepted forms

`src/domain/types.ts`:

```
BOT_COMMENT_MARKER      = '[//]: # (law-bot)'          // the complete, ready-to-write line
LEGACY_BOT_MARKER       = '<!-' + '- law-bot'          // detection only, never written
BOT_MARKER_PREFIX       = '[//]: # (law-bot'           // detection; also covers the :q: form
questionMarker(id)      = '[//]: # (law-bot:q:' + id.slice(0,8) + ')'
isBotAuthoredBody(body) = body.includes(BOT_MARKER_PREFIX) || body.includes(LEGACY_BOT_MARKER)
```

**Rename `BOT_COMMENT_MARKER_PREFIX` → `BOT_COMMENT_MARKER` deliberately.** The old name
invited `` `${PREFIX}…` `` at three call sites, and an unclosed prefix is exactly the defect.
Renaming turns every existing writer into a compile error, which is the gate: the compiler,
not a reviewer, finds anyone who hand-builds the marker. Writers get a complete line;
detection owns the substring logic and nothing else.

**`LEGACY_BOT_MARKER` is written spliced (`'<!-' + '- law-bot'`) so the literal cannot be
copy-pasted out of this file into a writer.** Its doc comment says: detection only, never
emitted, and it does not get deleted while comments written before 2026-09-09 exist on any
ticket this workspace can still reach.

**Migration, stated plainly.** Old comments carry `<!-- law-bot`; the legacy arm keeps them
recognised, so layer 4 of the ingress filter and `correlate()`'s bot-authored guard both keep
working over history unchanged. **A run resuming against a question comment written before
this change is unaffected**: tier 1 correlation reads `linearCommentId` from SQLite (M9), not
the body, and the human's reply carries the new marker in neither form because the human did
not write one. The one thing that does not migrate is cosmetic — comments already posted keep
showing the old marker forever, and nothing rewrites them.

**Not chosen, with the measurement that ruled each out** (M8): a properly closed HTML comment
(Linear has no HTML-comment rule — renders as visible text, same as today); zero-width
characters (invisible but leave a blank paragraph, unreadable in a log, and `prompt.ts`'s
`sanitizeUntrustedText` strips zero-width characters so the marker is one refactor away from
silently vanishing); dropping the body marker for the author id alone (surrenders the
stale-bot-id case in M12, and `guards.ts` would lose a layer for a cosmetic win the
link-reference form gets for free).

### The two writer edits

`run-engine.ts:277-279` — `` `${BOT_COMMENT_MARKER}\n\n${text}` ``. Shape unchanged.

`questions.ts:149-151` — must GAIN the `\n\n`. Today it is `` `${PREFIX}${body}` ``, which
under the new marker puts it in paragraph position where CommonMark does not treat it as a
definition (M8, candidate C). Give `post()` an optional marker so the question comment can
lead with `questionMarker(question.id)` — which wires a second dead renderer (M9) instead of
hand-building the string at `:302`.

`questions.ts:302-306` — the visible code span (M10) drops the marker and keeps the bare
8-character code: `` `abcdef01` ``. It is a human reference label; `correlate()` never reads
it. Do **not** delete `questionShortCode()` in this task — report it as still-unused and let
the operator decide.

`linear-channel.ts:6-11` — correct the header to describe what the file does (M11).

## Defects 1 and 2 — make the structured body the only way to call

`ports.ts` `Deliverer.deliver`, third parameter:

```
pr: { title: string; prBody: Omit<PrBodyInput, 'ciPaths'>; draft?: boolean }
```

`deliver.ts` `DeliverInput`: **delete `body?: string`** and make
`prBody: Omit<PrBodyInput, 'ciPaths'>` required. Line 105 becomes
`renderPrBody({ ...o.prBody, ciPaths: gates.ciPaths })` — no `??`.

That is the whole lesson made structural: *an optional parameter is a dead parameter until
the gate proves a caller sets it.* Required, the gate is `tsc`. Deleting the forwarding in
`adapters.ts` stops compiling; there is no fallback left to silently win. The `body` field's
stated reason for existing — "kept so `execute-run.ts` compiles unchanged" — is stale:
`execute-run.ts` does not call `deliver` (grep: two comment mentions, no call).

`run-engine.ts` gains one helper used by both `dispatch` arms:

```
prBodyFor(run, result, verdict) -> {
  ticketIdentifier: run.issueKey,
  ticketUrl:        run.issueUrl,
  summary:          result.prBody,   // same string the `body` field carried
  runLogPath:       logPathFor(run.id),
  verdict,
}
```

`testCommand`, `testResult` and `didNotDo` are **omitted, not set to `''`** — `present()`
(`pr-body.ts:44-47`) treats both the same, but omission is the honest statement and the
SUMMARY records why (M6).

The `partial` arm keeps its warning banner exactly as written, prepended to `result.prBody`
inside `summary`. Rendering is unchanged there — that banner is already fenced today, because
`body` already fed `summary`. `verdict: 'partial'` additionally lights the
`## What I did not do` cut-short branch, which is new and correct. Do **not** set
`DeliverInput.verdict` — that field drives `draft` (`deliver.ts:89`) and the draft decision
already comes from `pr.draft ?? toggles.draftPr` (`adapters.ts:580-583`). Two inputs to one
decision is the shape being removed elsewhere in this plan.

### The run log path (M5)

`src/domain/types.ts`: delete `LOG_DIR`, delete `ConfigPaths.logDir` and the `logDir:` line in
`configPaths()`, and add the one derivation both consumers need:

```
/** The daemon dir. `adapters.ts` and `run-engine.ts` both need it; `LOG_DIR` was the second
 *  guess, and it pointed at a directory nothing creates (see TRAPS T120). */
export function daemonDirOf(config: { worktreeRoot: string }): string
```

`adapters.ts:87-89` deletes its private copy and imports this one. `run-engine.ts`'s
`logPathFor` becomes `runLogPath(daemonDirOf(config), runId)` — `config` is already in scope
(`:147`). The failure-diagnosis comment at `:433` is fixed by the same edit, which is the
point: one shared derivation, both callers correct, rather than a second right answer next to
the first wrong one. Three test fixtures (`fanout.test.ts:349`, `recovery.test.ts:97`,
`run-engine.test.ts:58`) drop their now-nonexistent `logDir` key.

## Defect 2 — where the prefix goes

**In `deliver.ts`, not in `run-engine.ts`.** `deliver.ts:112` is where
`sanitizeUntrustedText(o.title)` lives, and the identifier is trusted (it came off the run
row) while the agent's half is not. Composing there means the trusted token is joined
**after** sanitization and never passes through it, and the identifier is read from
`o.prBody.ticketIdentifier` — the same single source the `## Ticket` section uses, so title
and body cannot disagree.

```
const clean = sanitizeUntrustedText(o.title);
const id    = o.prBody.ticketIdentifier?.trim();
const title = id && !alreadyLeadsWith(clean, id) ? `${id} ${clean}` : clean;
```

`alreadyLeadsWith(title, id)` — case-insensitive `startsWith`, and the character immediately
after the identifier must not be alphanumeric. Plain string work, no constructed regex and no
escaping. The boundary check is what stops `COD-9` being skipped on a title that opens with
`COD-99` (a different ticket, which must still be prefixed). Behaviour on the three real
titles (M7): all three get prefixed.

## Deliberately NOT doing

- **Nothing about "In Review".** No review-state resolver, no second `setIssueState`,
  `resolveWorkflowStateId` untouched. Linear's GitHub integration owns it; the three
  `dzfweb/miracle-shop` tickets lack attachments because the integration is authorized for
  the `ohmaseclaro` org. Operator settings, not code.
- **Not deleting `questionShortCode()`** (M9) despite it having no production caller. It is
  reported, not removed — the brief believes it is load-bearing and that disagreement is the
  operator's to settle.
- **Not fabricating a `testResult`** (M6), and not inventing a test-runner toggle to
  manufacture one.
- **Not rewriting existing Linear comments** to the new marker.
</design>

<constraints>
- Stay on `main`. Four commits, one per task.
- `npm run verify` is 661/661 plus a boot smoke and must stay green. Report the exact number
  the runner prints — do not assume it.
- **Never `mock.method`** (T88).
- Tests colocated in `src/` as `*.test.ts`.
- **Falsify every new check** (T71/T76) and paste the RED text actually seen. Where RED at
  HEAD is a `tsc` error rather than an assertion failure, say so and paste the compiler
  message — a type error is a legitimate RED, but calling it an assertion failure is not.
- No probing against COD-7/8/9. The marker probe is already done (M8) and its scratch issue
  is deleted; do not re-run it. If a further probe is genuinely needed, create a fresh
  throwaway issue and `issueDelete` it in the same script.
</constraints>

<tasks>

<task type="tracer" tdd="true">
  <name>Task 1: The marker becomes a link reference definition, and history keeps working</name>
  <read_first>
    - `src/domain/types.ts:372-415` — the marker block in full: the doc comments at `:379-384`
      and `:387-390`, `BOT_COMMENT_MARKER_PREFIX` `:385`, `QUESTION_MARKER_PREFIX` `:391`,
      `isBotAuthoredBody` `:394-396`, `questionMarker` `:399-401`, `questionShortCode`
      `:408-412`.
    - `src/ingress/guards.ts:20-24` (the import and its T32 note) and `:108-123` (layers 1
      and 2, and the `marker:` field on the drop record at `:121`).
    - `src/orchestration/questions.ts:28-31` (imports), `:60-108` (`correlate`, especially
      the "never on the comment body" paragraph), `:149-165` (`botBody` and `post`),
      `:295-312` (the `shortCode` construction and the posted body).
    - `src/orchestration/run-engine.ts:13-16` and `:276-279` (`botBody`).
    - `src/outbound/notify/linear-channel.ts:1-21` — the header making the claim M11 falsifies.
    - `src/domain/contract.test.ts:80-92`, `src/ingress/guards.test.ts:32`,
      `src/orchestration/questions.test.ts:127,295` — every existing assertion that names the
      marker.
  </read_first>
  <behavior>
    Write these FIRST and watch them fail.

    - **The marker is a link reference definition.** `BOT_COMMENT_MARKER` matches
      `/^\[\/\/\]: # \(.+\)$/`. RED at HEAD: the constant is the unclosed HTML-comment form.
    - **The marker is a whole line.** The body `botBody` produces starts with the marker
      followed immediately by a blank line — assert on `body.split('\n')`, that line 0 is
      exactly the marker and line 1 is empty. Asserted for BOTH writers: `run-engine`'s
      status comment and `questions`' question comment. RED at HEAD for `questions`, whose
      writer has no separator at all (M11).
    - **Both forms are recognised.** `isBotAuthoredBody` is true for a body carrying the new
      marker, true for one carrying the legacy form, true for one carrying a question marker,
      and false for `'a human reply'`. The NEW-marker case is RED at HEAD; the legacy case is
      GREEN at HEAD and is the migration non-regression — do not "repair" it if it passes.
    - **The ingress filter sees the new marker.** Drive `guards.ts`'s decision with a
      `Comment` payload whose body carries the new marker and a non-bot actor, and require
      `{ drop: true, guard: 'marker:bot-authored' }`. RED at HEAD: not dropped, because the
      body contains no legacy substring.
    - **The question comment shows no marker to a reader.** The posted question body contains
      no occurrence of the legacy form anywhere, and contains the string `[//]: #` exactly
      once — on line 0. That single assertion catches both leaks: the leading line and the
      code span at `:302`. RED at HEAD on both counts.
  </behavior>
  <action>
    In `src/domain/types.ts`, replace the marker block. Rename
    `BOT_COMMENT_MARKER_PREFIX` to `BOT_COMMENT_MARKER` and give it the complete link
    reference definition value. Add `BOT_MARKER_PREFIX` (detection; also matches the question
    form) and `LEGACY_BOT_MARKER`, the latter built by concatenating two string pieces so the
    literal cannot be lifted from here into a writer, with a doc comment stating: detection
    only, never emitted, and not to be removed while comments written before 2026-09-09 are
    still reachable. Point `QUESTION_MARKER_PREFIX` at the new opening form and change
    `questionMarker` to close with a parenthesis. Widen `isBotAuthoredBody` to the two-arm
    check. Rewrite the `:379-384` doc comment: state that Linear has no HTML-comment rule and
    that this form is a CommonMark link reference definition, which produces no output —
    measured against Linear's own parser on 2026-09-09, cross-referencing TRAPS T119. Drop the
    stale "survives a null actor" justification; `guards.ts:101-105` already drops null actors
    outright, so the live reason is a stale or re-created bot id.

    The rename breaks three writers; that is the gate. Fix each:
    `guards.ts:121` — the `marker:` field on the drop record.
    `run-engine.ts:277-279` — `botBody` uses the complete marker; the `\n\n` is already there.
    `questions.ts:149-165` — `botBody` GAINS the `\n\n`, and `post()` takes an optional marker
    so `openQuestion` can lead with `questionMarker(question.id)`. Then `:302` stops
    hand-building the short code and the visible code span carries the bare
    `question.id.slice(0, 8)`. State in a comment why the visible code is only a human label:
    `correlate()` matches on `linearCommentId` and never on the body (T-06-13).

    Correct `linear-channel.ts:6-11` to describe what the file does — it composes bodies for
    `SlackChannel` and writes no comment — rather than claiming a marker guard it does not
    implement.

    Update the three existing marker assertions (`guards.test.ts:32`,
    `questions.test.ts:127,295`, `contract.test.ts:86-90`) to the new name. Their intent does
    not change.
  </action>
  <verify>
    <automated>npm run verify</automated>
    Into the SUMMARY:
    - The RED text for each of the five new assertions, verbatim, at HEAD.
    - Falsification after the fix: delete the `LEGACY_BOT_MARKER` arm of `isBotAuthoredBody`,
      rebuild, run `node --test dist/src/domain/contract.test.js`, paste the RED, restore.
      That is the migration guard proving it guards something.
    - Second falsification: change `questions.ts`'s `botBody` separator back to the empty
      string, rebuild, run `node --test dist/src/orchestration/questions.test.js`, paste the
      RED, restore. Block position is a behaviour, not formatting.
    - `node -e` printing `BOT_COMMENT_MARKER` and `questionMarker('abcdef01-2345')`, so the
      SUMMARY carries the two literals that now go on every ticket.
  </verify>
  <done>
    The marker renders as nothing in Linear, both marker forms are recognised, the question
    comment carries exactly one marker and it is invisible, and `npm run verify` is green.
    Committed.
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: `prBody` becomes required, the run engine builds it, and the run log path stops being fiction</name>
  <read_first>
    - `src/execution/pr-body.ts` in full (116 lines) — `PrBodyInput` `:9-25`, `present()`
      `:44-47`, and each section's missing-branch at `:77`, `:82`, `:86-87`, `:100-104`, `:109`.
    - `src/execution/deliver.ts:23-45` (`DeliverInput`, and the `body` field's stale
      justification at `:34-39`), `:89`, `:104-107`.
    - `src/domain/ports.ts:294-315` — `PullRequest` and `Deliverer`.
    - `src/cli/adapters.ts:87-89` (`daemonDirOf`), `:460-470` (`openRunLog`),
      `:560-587` (`createDeliverer`).
    - `src/orchestration/run-engine.ts:16-18` (imports incl. `LOG_DIR`), `:145-150` (the deps
      destructure), `:415-435` (`classify`, `logPathFor`, `diagnosis`), `:605-665`
      (`dispatch`, both `deliver` call sites).
    - `src/execution/run-log.ts:33-45` — `runLogDir`, `runLogPath`, `openRunLog`.
    - `src/domain/types.ts:320-352` (`ConfigPaths`, `configPaths`) and `:362-370`
      (`DEFAULT_PATHS`, `LOG_DIR`).
    - `src/domain/fakes.ts:638-666` — `FakeDeliverer`, whose `calls` array is the seam the
      integration assertion reads.
    - `src/execution/deliver.test.ts:60-90` and `:235-260` — the existing `renderPrBody`
      coverage (M3: there is no `pr-body.test.ts`).
  </read_first>
  <behavior>
    Write these FIRST.

    - **The engine hands the ticket to the deliverer.** Drive a `complete` dispatch through
      `run-engine.test.ts` with a run row carrying `issueKey: 'COD-9'` and a real
      `issueUrl`, then assert on `FakeDeliverer.calls[0].pr.prBody`: `ticketIdentifier` is
      `'COD-9'`, `ticketUrl` is that URL, `verdict` is `'delivered'`, `runLogPath` ends with
      `/runs/<runId>.jsonl`. RED at HEAD is a **`tsc` error** — `prBody` does not exist on the
      port's `pr` type. Paste the compiler message; do not describe it as an assertion failure.
    - **The `partial` arm too.** Same assertion on the `partial` dispatch, with `verdict`
      `'partial'`, and the existing warning-banner assertion left intact.
    - **The rendered body carries the link.** In `deliver.test.ts`, a `deliver()` call whose
      `prBody` carries both ticket fields writes a `--body-file` containing `[COD-9](` — read
      the file the call wrote, not the return value. RED at HEAD by type error.
    - **The run log path is the one that is written.** Assert `logPathFor`'s output equals
      `runLogPath(daemonDirOf(config), runId)` by calling both — never by rebuilding the
      string in the test, which would assert the test's copy of the rule. RED at HEAD:
      `.../logs/<id>.log` against `.../runs/<id>.jsonl`.
  </behavior>
  <action>
    Fix the path first, because the body depends on it. In `src/domain/types.ts`: delete
    `LOG_DIR`, delete `ConfigPaths.logDir` and the `logDir:` line in `configPaths()`, and add
    `daemonDirOf(config: { worktreeRoot: string })` returning `path.dirname(config.worktreeRoot)`
    with a doc comment naming the two consumers and recording that `LOG_DIR` was the second
    guess (cross-reference TRAPS T120). Delete the now-orphaned `logDir:` keys from
    `fanout.test.ts:349`, `recovery.test.ts:97` and `run-engine.test.ts:58`. In
    `adapters.ts:87-89`, delete the private `daemonDirOf` and import the shared one. In
    `run-engine.ts`, drop the `LOG_DIR` import and make `logPathFor` call
    `runLogPath(daemonDirOf(config), runId)`. Leave `diagnosis()` otherwise untouched — it is
    correct the moment the path is.

    Then close the channel. In `ports.ts`, replace `body: string` with
    `prBody: Omit<PrBodyInput, 'ciPaths'>` on `Deliverer.deliver`'s third parameter, importing
    the type. In `deliver.ts`, delete `DeliverInput.body` and its comment block, make `prBody`
    required, and reduce `:105` to a spread with no `??`. In `adapters.ts`'s `createDeliverer`,
    forward `prBody: pr.prBody`. Update `FakeDeliverer`'s `calls` and `deliver` signatures to
    the new shape.

    In `run-engine.ts`, add `prBodyFor(run, result, verdict)` per `<design>` and call it from
    both `dispatch` arms. **Omit `testCommand`, `testResult` and `didNotDo`** — write a
    comment at the helper stating that no code in this repository runs a test command
    (M6) and that `AgentResult` carries no did-not-do field, so those three sections keep
    rendering their explicit "not recorded" branches on purpose. The `partial` arm keeps its
    banner, prepended to `result.prBody` inside `summary`, and passes `verdict: 'partial'`.
    Do not set `DeliverInput.verdict`; the draft decision keeps its single input.
  </action>
  <verify>
    <automated>npm run verify</automated>
    Into the SUMMARY:
    - The `tsc` RED at HEAD, verbatim, and the assertion RED for the run-log-path test.
    - **The T109 wiring procedure, run exactly as specified.** Delete the line
      `ticketIdentifier: run.issueKey,` from `prBodyFor` in `run-engine.ts` — it is an
      optional field, so this still compiles. Rebuild, then run the two suites SEPARATELY and
      paste both outcomes: `node --test dist/src/execution/deliver.test.js` must stay **GREEN**
      (it targets `renderPrBody`, which is unchanged and correct), and
      `node --test dist/src/orchestration/run-engine.test.js` must go **RED** on the
      `ticketIdentifier` assertion. Restore the line. Both green, or both red, means the
      assertion is targeting the module rather than the wiring — say so and repair it before
      claiming the fix. Per T109 a first pass that goes neither-red is the normal outcome, not
      evidence the procedure was done wrong. Note in the SUMMARY that the brief named
      `pr-body.test.js`, which does not exist (M3), and that `deliver.test.js` is the module
      suite that plays that role.
    - The rendered `## Ticket` line for a real run row, pasted, so the SUMMARY shows the
      before (`(no ticket recorded)`, PR #3) and the after.
    - An explicit statement of which `PrBodyInput` fields went live and which stay
      unpopulated, each with its reason — the M4 table, updated to what actually shipped.
  </verify>
  <done>
    `prBody` is required end to end, both engine call sites build one, `## Ticket` renders a
    link, `## Run log` prints the file that exists, the three test-and-did-not-do sections
    still render their honest missing branches, and `npm run verify` is green. Committed.
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 3: The issue identifier leads the PR title</name>
  <read_first>
    - `src/execution/deliver.ts:104-132` after Task 2 — the body render, the
      `sanitizeUntrustedText` call at `:112` and its comment at `:109-111`, and the
      `createArgs` array.
    - `src/execution/prompt.ts` — `sanitizeUntrustedText`'s exact transformation, so the
      claim "the trusted token never passes through it" is checked rather than assumed.
    - `src/execution/deliver.test.ts` — the existing `gh pr create` argv assertions, to
      extend rather than duplicate.
  </read_first>
  <behavior>
    Write these FIRST. All three read the `--title` value out of the `gh pr create` argv the
    fake runner captured.

    - **Prefixed.** `title: 'docs(readme): índice de seções'` with `ticketIdentifier: 'COD-9'`
      yields `'COD-9 docs(readme): índice de seções'`. This is PR #3's real title (M7).
      RED at HEAD: the identifier is absent.
    - **Not doubled.** `title: 'COD-9 docs: x'` with the same identifier stays
      `'COD-9 docs: x'` — one occurrence of `COD-9`, asserted as a count, not a match.
    - **Not doubled, colon form.** `title: 'COD-9: docs: x'` stays unchanged.
    - **The boundary.** `title: 'COD-99 fix the other thing'` with `ticketIdentifier: 'COD-9'`
      becomes `'COD-9 COD-99 fix the other thing'`. A different ticket's key at the front is
      not this ticket's key, and a bare `startsWith` would silently skip the prefix.
    - **No identifier.** `ticketIdentifier` omitted leaves the sanitized title untouched.
  </behavior>
  <action>
    In `deliver.ts`, compose the title where the sanitizer already is: sanitize `o.title`,
    read the trimmed `o.prBody.ticketIdentifier`, and prefix only when the identifier is
    present and the sanitized title does not already lead with it. `alreadyLeadsWith` is a
    case-insensitive `startsWith` plus a check that the next character is not alphanumeric —
    plain string work, no constructed regex, no escaping. Extend the `:109-111` comment: the
    identifier comes off the run row and is trusted, so it is joined AFTER sanitization and
    never passes through it, and it is read from `prBody.ticketIdentifier` so the title and
    the `## Ticket` section cannot name different tickets.
  </action>
  <verify>
    <automated>npm run verify</automated>
    Into the SUMMARY:
    - RED at HEAD for the prefixed case, verbatim.
    - Falsification: replace `alreadyLeadsWith` with a bare case-insensitive `startsWith`
      (dropping the boundary check), rebuild, run
      `node --test dist/src/execution/deliver.test.js`, paste the RED from the `COD-99` case,
      restore. Then delete the `alreadyLeadsWith` guard entirely, paste the RED from the
      not-doubled case, restore. Two different failures from two different halves of the rule.
    - The three real titles from M7 with the prefix applied, so the operator can read what
      the next three PRs will be called.
  </verify>
  <done>
    Every PR title leads with the identifier, never twice, and a neighbouring ticket's key at
    the front does not suppress it. `npm run verify` is green. Committed.
  </done>
</task>

<task type="auto">
  <name>Task 4: TRAPS T119 and T120, the prose, and the count</name>
  <read_first>
    - `.planning/TRAPS.md` — the five-column header and the T109 row (`:149`), whose shape and
      density these two match. T118 (`:158`) is the current last row.
    - `docs/TRAPS.md` — the `## Linear's API and SDK` section (`:128`) and
      `## The one that is really about process` (`:552`), which is where the wiring/instrument
      material already lives.
    - `README.md:201` — the count.
  </read_first>
  <action>
    Add two rows to `.planning/TRAPS.md`, same five columns, same evidence density as T109.

    **T119 — a marker chosen to be invisible in one renderer is not invisible in another, and
    no gate can see the difference because no gate renders anything.** `<!-- law-bot` was
    picked because HTML comments are invisible on GitHub. Linear has no HTML-comment rule at
    all: `commentCreate` + read-back of `bodyData` shows every form — unclosed, properly
    closed, inline, and the `:q:` variant — arriving as a plain `text` node in a `paragraph`.
    **Closing the comment does not help**; that is the obvious fix and it is wrong, which is
    why this row exists. The operator saw `<!-- law-bot` as the first line of every bot
    comment for the whole milestone while 661 tests passed, because no test renders markdown
    in Linear and no test can. Correct move: a CommonMark **link reference definition**,
    `[//]: # (law-bot)` — absent from `bodyData` entirely, byte-identical on API round-trip,
    so the loop guard is unaffected. Record the full candidate table from M8, including the
    two near-misses that leave a blank paragraph (`[](#law-bot)` and pure zero-width), and
    that the marker must sit in **block** position with a blank line after it — inline, it is
    paragraph text again. General lesson: verify a marker against **every** renderer it
    reaches, by rendering, and prefer a syntax whose invisibility is specified rather than
    incidental.

    **T120 — an optional parameter is a dead parameter until the gate proves a caller sets
    it.** `renderPrBody` had seven optional fields, correct logic, and unit tests in
    `deliver.test.ts` that passed `ticketUrl` and `ticketIdentifier`. Production passed
    neither, for an entire milestone: `deliver.ts:105` read
    `o.prBody ?? { summary: o.body }` and every caller supplied only `body`, so the fallback
    won every time and every PR said `(no ticket recorded)`, `none configured`, `**not run**`,
    `(no run log path recorded)`. The `??` is the mechanism — it converted "nobody wired this"
    into a valid render. Same shape as T99 and T109, third occurrence. Correct move: make the
    structured input **required** so `tsc` is the gate, delete the fallback rather than
    deprecating it, and confirm the wiring with the T109 deletion procedure — record the
    observed pair (`deliver.test.js` GREEN, `run-engine.test.js` RED). Include the sibling
    found the same day: `LOG_DIR` named `~/.linear-auto-worker/logs`, nothing ever created it,
    the run log is written to `~/.linear-auto-worker/runs/<id>.jsonl`, and the failure comment
    had been quoting the fictional path to the operator all milestone. **A declared path that
    nothing writes is the same defect as an optional parameter that nothing sets** — both are
    a plausible-looking value with no producer behind it, and both survive a green build.

    Then `docs/TRAPS.md`: T119 goes under `## Linear's API and SDK` with the candidate table
    (it is the most portable finding here — it costs an afternoon to anyone marking bot
    comments in Linear). T120 goes under `## The one that is really about process`, beside the
    existing instrument material, since it is the third instance of the same shape and the
    paragraph should say so. Update the opening count at `docs/TRAPS.md:3` from
    "One hundred and eighteen" to "One hundred and twenty", and `README.md:201` from
    **118 verified footguns** to **120**.
  </action>
  <verify>
    <automated>npm run verify</automated>
    Plus: `grep -c '^| T' .planning/TRAPS.md` increased by exactly 2; `grep -n 'One hundred'
    docs/TRAPS.md` and `grep -n 'verified footguns' README.md` both read 120.
  </verify>
  <done>
    T119 and T120 are in the ledger with their measurements, the prose carries both lessons in
    the right sections, and both counts read 120. Committed.
  </done>
</task>

</tasks>

<success_criteria>
- A PR opened by the worker shows `[COD-N](url)` under `## Ticket`, a real `## Run log` path,
  and a title beginning with the identifier.
- `## Tests` and `## What I did not do` still render their honest missing branches, and the
  SUMMARY says which fields went live, which did not, and why.
- No bot comment on a Linear ticket shows a marker to a human reader; every comment written
  before today is still filtered.
- The T109 deletion procedure was run for Defect 1 and its outcome pasted, including the
  correction that `pr-body.test.js` does not exist.
- `npm run verify` green; the exact test count reported, not assumed.
- Nothing in the diff touches issue workflow state.
</success_criteria>

<output>
Write `.planning/quick/260909-lvl-wire-the-dead-pr-body-issue-key-in-pr-ti/SUMMARY.md`.

It must state, at minimum: which `PrBodyInput` fields went live and which stay deliberately
unpopulated with the reason for each; what Linear actually rendered for every marker form
tried, with the `bodyData` evidence; what happens to comments already carrying the old marker,
specifically a run resuming against a pre-change question comment; the T109 pair observed for
Defect 1; and every RED text quoted verbatim.

Report as findings, not fixes: `questionShortCode()` and (before this change) `questionMarker()`
have no production caller, and `correlate()` documents that it will never use them; and
`linear-channel.ts` claimed a marker guard it does not implement.
</output>
</content>
</invoke>
