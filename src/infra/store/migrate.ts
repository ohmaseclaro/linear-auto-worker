/**
 * The migration runner (D-10).
 *
 * Schema evolution rides on SQLite's built-in `PRAGMA user_version` — a signed 32-bit
 * integer already stored in the database header. There is deliberately no version table
 * of our own: SQLite hands us the integer for free, and a table would need its own
 * bootstrap migration to exist before it could record that migrations had run.
 *
 * Read the stored version, apply every migration above it in ascending order inside a
 * transaction, bump the version. That is what makes "run it twice, the second is a no-op"
 * true, and it is why upgrading the daemon against an existing database does not discard
 * run history or a question still waiting on the operator's reply.
 *
 * Down-migrations are deliberately absent. This is a single-operator local daemon: the
 * recovery path for a bad migration is to fix it forward, and `user_version` does not
 * preclude adding a `down` field later. Do not add one back as an oversight.
 */

import { MigrationError } from '../../domain/errors.js';
// `migrations/index.ts` imports the `Migration` type back from here, but type-only — so
// this looks like a cycle and is not one at runtime.
import { MIGRATIONS } from './migrations/index.js';

/** One numbered migration. `sql` is a template literal in a checked-in TypeScript module (D-11). */
export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

/**
 * Only what the runner actually touches, typed structurally rather than imported from a
 * driver package. Both the production driver and the platform's built-in synchronous
 * database satisfy it, so this module compiles and runs with no database package present —
 * which is the difference between a migration test that exists and one that can ever run.
 */
export interface MigratableDb {
  exec(sql: string): unknown;
  prepare(sql: string): { get(...params: unknown[]): unknown };
}

export interface MigrateResult {
  /** The version found in the database before anything was applied. */
  readonly from: number;
  /** The version left in the database afterwards. */
  readonly to: number;
  /** Versions applied by this call. Empty is the observable form of the no-op. */
  readonly applied: readonly number[];
}

/** The schema version currently recorded in the database header. 0 for a fresh database. */
export function readUserVersion(db: MigratableDb): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
  const value = row?.user_version ?? 0;
  assertVersion(value, 'stored user_version');
  return value;
}

/**
 * `PRAGMA user_version` cannot be parameterised, so the new version is the one value in
 * this project concatenated into SQL text. It originates from a literal in a checked-in
 * migration module rather than from any input, and it is guarded here regardless.
 */
function assertVersion(value: unknown, what: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new MigrationError(`${what} must be a non-negative safe integer, got ${String(value)}`);
  }
}

/**
 * Two migrations sharing a number is a merge artefact this project — eight phases built in
 * parallel — is unusually likely to produce, and it would silently skip one of them.
 */
function assertStrictlyAscending(migrations: readonly Migration[]): void {
  let previous = -1;
  for (const migration of migrations) {
    assertVersion(migration.version, `migration "${migration.name}" version`);
    if (migration.version <= previous) {
      throw new MigrationError(
        `migrations must be strictly ascending; version ${migration.version} follows ${previous}`,
      );
    }
    previous = migration.version;
  }
}

export function migrate(db: MigratableDb, migrations: readonly Migration[] = MIGRATIONS): MigrateResult {
  assertStrictlyAscending(migrations);

  const from = readUserVersion(db);
  const applied: number[] = [];
  let to = from;

  for (const migration of migrations) {
    if (migration.version <= from) continue;

    // Explicit begin/commit: the SQL and the version bump land together or neither does,
    // so a failed migration can never leave the version bumped over a half-applied schema.
    db.exec('BEGIN');
    try {
      db.exec(migration.sql);
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec('COMMIT');
    } catch (cause) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // The transaction was already aborted; the original failure is the useful one.
      }
      throw new MigrationError(
        `migration ${migration.version} (${migration.name}) failed: ${String(cause)}`,
        { cause },
      );
    }
    applied.push(migration.version);
    to = migration.version;
  }

  return { from, to, applied };
}
