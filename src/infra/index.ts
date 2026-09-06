import * as path from 'node:path';
import { defaultRoot, loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { openStore } from './store/db.js';

/**
 * The single composition point for Foundation. Phase 7's daemon boot imports
 * this, not the individual pieces — one path from a config file on disk to
 * an open, migrated SQLite handle and a logger that cannot leak what it was
 * given.
 *
 * Order matters: a config read/parse failure must throw before the database
 * or logger are ever touched.
 */
export function loadFoundation(root: string = defaultRoot()) {
  const config = loadConfig(root);
  const logger = createLogger();
  const db = openStore(path.join(root, 'store.db'));
  return { config, logger, db };
}
