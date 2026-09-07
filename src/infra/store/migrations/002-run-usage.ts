/**
 * Gap D6 — what a run cost.
 *
 * `classifyOutcome` has read `total_cost_usd` and `usage` off the agent's result event
 * since Phase 4, and the terminal notification threw both away: `toNotifyEvent` hardcoded
 * `costUsd: 0, tokensUsed: 0` with a comment saying there was no column to read. This is
 * that column. Slack, the Linear comment and the log all reported `$0.0000` on every run
 * until it existed.
 *
 * The first migration this project has ever applied on top of another, which is its own
 * small verification: `runMigrations` filters on `version > user_version` and had only one
 * candidate to filter, so the ordering and the pragma bump were until now untested against
 * a second row.
 *
 * `ALTER TABLE ... ADD COLUMN` is not `IF NOT EXISTS` in SQLite, so unlike 001 this cannot
 * be re-run against a database that already has the columns. It does not have to be:
 * `PRAGMA user_version` gates it, and the bump and the SQL share one transaction (`db.ts`),
 * so a database is never left with the columns and the old version or the reverse.
 *
 * Both columns are NOT NULL DEFAULT 0, so every row that predates this migration reads as
 * a free run rather than as a null the notifier has to branch on. That is a lie about
 * history in exactly one direction, and it is the harmless one: an old run genuinely has
 * no recorded cost, and reporting `$0.0000` for it is what the daemon did anyway.
 */

import type { Migration } from '../migrate.js';

export const migration002: Migration = {
  version: 2,
  name: 'run-usage',
  sql: `
ALTER TABLE runs ADD COLUMN cost_usd    REAL    NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN tokens_used INTEGER NOT NULL DEFAULT 0;
`,
};
