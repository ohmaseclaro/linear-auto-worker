# Runtime evidence gathered by the orchestrator before 07-03

These were **executed**, not inferred. Under rush mode nothing else in the milestone has run,
so this is the only behavioural evidence that exists. Phase 7 should treat it as fact.

## PASS — Phase 1 SC4: the migration is idempotent

```
before      : user_version=0 tables=[]
after run 1 : user_version=1 applied={"from":0,"to":1,"applied":[1]} tables=[deliveries,kv,questions,run_events,runs]
after run 2 : user_version=1 applied={"from":1,"to":1,"applied":[]}  tables=[deliveries,kv,questions,run_events,runs]
```

Empty database produces the full five-table schema; a second run applies nothing and changes
nothing. `PRAGMA user_version` gating works. **Phase 1 SC4 is satisfied.**

## PASS — Phase 1 SC1, SC2, SC3: the state machine

Executed against `RUN_STATE_TABLE` and `canTransition`:

| state | holdsSlot | hasLiveChild | terminal |
|---|---|---|---|
| queued | false | false | false |
| preparing | true | false | false |
| running | true | true | false |
| **awaiting_answer** | **false** | **false** | false |
| delivering | true | false | false |
| delivered / partial / failed / cancelled | false | false | true |

- **SC1** — exactly nine states, matching the ADDENDUM's literals. PASS
- **SC2** — spot-checked four legal transitions accepted and four illegal ones rejected
  (`delivered→running`, `failed→delivering`, `cancelled→queued`, `queued→delivered`). PASS
- **SC3** — `awaiting_answer` holds **neither** a concurrency slot nor a live child. PASS.
  This is the invariant the entire scheduler rests on: violating it turns "three open questions"
  into "the daemon is dead", with the operator's natural diagnosis being wrong.

Two cells are more carefully modelled than the criteria required: `delivering` and `preparing`
each hold a slot but have **no live child** — correct, because the worker is doing git/`gh` work
while the agent process is already gone. That distinction is what lets the cap bound real RAM.

## PASS — D-14 / T63: prompt-injection containment holds under attack

Executed `buildAgentPrompt` against two crafted ticket bodies:

| attack | result |
|---|---|
| body contains a literal `</untrusted-ticket-data>` | defanged — the closing tag does not survive inside the wrapped body |
| the same tag **split by zero-width characters** | defanged, and the zero-width characters are stripped |

The second case is the one that matters, and it passes because of ordering: `sanitizeUntrustedText`
strips control and zero-width characters **before** the delimiter is rewritten. Reversed, a tag
split by an invisible character reassembles *after* the rewrite and escapes cleanly. Both layers
D-14 requires are present and they compose.

## PASS (layers 1-3) — HOOK-07: loop prevention fires correctly

Executed `selfEventGuards` against synthetic payloads:

| case | dropped | guard bucket |
|---|---|---|
| human comment | no | — |
| bot actor id | yes | `actor:self` |
| null actor | yes | `actor:null-untrusted` |
| bot marker in body | yes | `marker:bot-authored` |
| after `noteSelfWrite('Issue','i-42')` | yes | `suppression:self-write` |

No false positive on the human comment, and `selfEventDropCounts` increments per guard —
satisfying Phase 3 SC4 (an unwired filter is visible rather than silent). A side result: importing
`BOT_COMMENT_MARKER_PREFIX` from `guards.js` **fails**, confirming T32 — guards imports it from
the domain barrel and does not re-export a second copy.

**Caveat — layer 4 is NOT verified and is currently broken.** Delivery-ID uniqueness lives in
`receiver.ts:201` and calls `store.tryInsertDelivery`, which T53 proves does not exist on the real
store. So the guard that catches a *replayed* delivery is the one that throws on first use. Layers
1-3 would still hold, which is exactly why four independent layers were specified — but this must
be fixed, not relied upon.

## FAIL — T53: the store queries columns that do not exist

Authoritative schema, read back from a real in-memory database after running the migration:

| table | columns |
|---|---|
| `runs` | id, parent_run_id, kind, issue_id, issue_key, issue_title, issue_url, repo_dir, repo_slug, branch, worktree_path, session_id, pid, state, cancel_requested, resumable, attempt, question_round, pr_url, failure_reason, created_at, updated_at |
| `questions` | id, run_id, text, assumption, linear_comment_id, asked_at, deadline_at, status, answer |
| `deliveries` | **delivery_id**, received_at |
| `kv` | **k**, **v**, updated_at |
| `run_events` | id, run_id, from_state, to_state, at, detail |

`src/infra/store/sqlite-store.ts` queries:

| line | statement | problem |
|---|---|---|
| 262 | `INSERT OR IGNORE INTO deliveries (id, received_at)` | no column `id` — it is `delivery_id` |
| 272 | `SELECT value FROM kv WHERE key = ?` | no `value`, no `key` — they are `v`, `k` |
| 279 | `INSERT INTO kv (key, value) ... ON CONFLICT(key) DO UPDATE SET value = excluded.value` | same, and `updated_at` is NOT NULL |

**`tsc` reports zero errors for all three**, because TypeScript does not know SQL column names.
The tests cannot catch it either — they run against `InMemoryStore`, not SQLite. Two green
signals over a daemon that dies at startup: the kv read is where the tunnel URL and webhook
secret live, so this fails on the **first boot**, and the delivery dedupe fails on the **first
webhook**.

## What this proves about the gate

The milestone's canonical gate is `tsc && node --test "dist/**/*.test.js"`. It is necessary and
not sufficient. **The integration gate must execute a real store round-trip against
better-sqlite3** — open a database, run the migration, and exercise `recordDelivery`, `kvSet`,
`kvGet` and one `runs` insert/read. Anything less lets this class of defect ship green.
