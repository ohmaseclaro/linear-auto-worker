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
