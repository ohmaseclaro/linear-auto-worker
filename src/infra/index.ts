import { defaultRoot, loadConfig, loadSecrets } from './config.js';
import { createLogger } from './logger.js';
import { openStore } from './store/db.js';

/**
 * The single composition point for Foundation. Phase 7's daemon boot imports
 * this, not the individual pieces — one path from a config file on disk to
 * an open, migrated SQLite handle and a logger that cannot leak what it was
 * given.
 *
 * Order matters: a config read/parse failure must throw before secrets, the
 * database, or the logger are ever touched, and secrets must be loaded
 * before the logger is constructed so every secret known at boot is
 * redactable from the first log line.
 */
export function loadFoundation(root: string = defaultRoot()) {
  const config = loadConfig(root);
  // The ordering comment above is what makes this possible at all: the config is already
  // read, so the MODE is in hand before the secrets check runs. A poll-only instance opens
  // no tunnel, so it needs no ngrok token — and demanding one would make the second
  // instance's supported configuration a boot failure.
  const secrets = loadSecrets(root, config.ingress !== 'poll');
  // Only what exists. `registerSecret`/`createLogger` redact by VALUE, and an `undefined`
  // in the list is a redaction rule matching nothing at best.
  const logger = createLogger(
    [secrets.linearApiKey, secrets.ngrokAuthtoken].filter((s): s is string => Boolean(s)),
  );
  // `config.dbPath`, not a second derivation of `root/store.db`. `law setup` persists the
  // webhook signing secret through the SAME field, and two derivations of "the database"
  // is a daemon that boots clean and rejects every delivery against a secret it cannot see.
  const db = openStore(config.dbPath);
  return { config, secrets, logger, db };
}
