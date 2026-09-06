import Database from 'better-sqlite3';
import { migration001 } from './migrations/001-init.js';

export interface Migration {
  version: number;
  sql: string;
}

const MIGRATIONS: Migration[] = [migration001];

/**
 * D-10/D-11: PRAGMA user_version plus numbered migration modules. Applying
 * this twice against the same file is a no-op the second time because every
 * candidate migration's version is already <= the stored user_version.
 */
export function runMigrations(db: Database.Database, migrations: Migration[] = MIGRATIONS): void {
  const currentVersion = db.pragma('user_version', { simple: true }) as number;
  const pending = migrations
    .filter((migration) => migration.version > currentVersion)
    .sort((a, b) => a.version - b.version);

  for (const migration of pending) {
    // A partial migration must never leave the pragma bumped without its SQL
    // applied, or vice versa — both happen inside one transaction.
    const applyMigration = db.transaction(() => {
      db.exec(migration.sql);
      db.pragma(`user_version = ${migration.version}`);
    });
    applyMigration();
  }
}

/**
 * D-04/OPS-02: WAL mode and an explicit busy timeout are set before any table
 * is touched — including before migrations run.
 */
export function openStore(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  runMigrations(db);
  return db;
}
