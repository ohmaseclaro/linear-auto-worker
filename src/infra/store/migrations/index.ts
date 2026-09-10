import type { Migration } from '../migrate.js';
import { migration001 } from './001-init.js';
import { migration002 } from './002-run-usage.js';
import { migration003 } from './003-run-base-ref.js';

/** Ascending by version. `migrate()` asserts that before applying anything. */
export const MIGRATIONS: readonly Migration[] = [migration001, migration002, migration003];
