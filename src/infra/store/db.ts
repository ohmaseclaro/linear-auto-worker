import Database from 'better-sqlite3';

import { migrate } from './migrate.js';

/**
 * The connection, and nothing else.
 *
 * This module used to carry a SECOND migration runner — its own `runMigrations`, its own
 * `Migration` interface, and its own `MIGRATIONS = [migration001]` list — beside the one in
 * `migrate.ts`. `migrate.ts` is the better of the two (it asserts strictly ascending
 * versions, wraps each migration in an explicit BEGIN/COMMIT, and reports what it applied)
 * and it had seven tests; it was also, until now, never called by anything in production.
 *
 * That is the parallel-build seam this project keeps producing, in its most dangerous
 * shape: adding a migration to `migrations/index.ts` — the list the runner with the tests
 * reads — would have done **nothing**, because `openStore` consulted the other list. The
 * schema change would appear to land, `tsc` would pass, the tests would pass, and the
 * column would not exist. Gap D6's migration 002 was written into that trap and found it.
 *
 * One runner, one list. Do not add a second.
 */

/**
 * D-04/OPS-02: WAL mode and an explicit busy timeout are set before any table
 * is touched — including before migrations run.
 */
export function openStore(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}
