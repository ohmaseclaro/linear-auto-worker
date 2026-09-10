/**
 * T125 — the ref a run was actually branched from.
 *
 * `prepareWorktree` has resolved `refs/remotes/<remote>/<base>` since T112 and then threw
 * the ref away, returning only `{ branch, path }`. So `deliver.ts` built its diff range
 * from the bare config name and `gatherEvidence` counted commits against the same bare
 * name — and on a clone sitting behind its own origin (T112 measured one 18 commits
 * behind) that range contains upstream commits the run never made. `verdict.ts` gates
 * `commitCount === 0`, so a run that committed nothing was judged to have committed.
 *
 * This is the column that carries the one resolved ref to both readers. Nullable rather
 * than `NOT NULL DEFAULT ''`: an empty string would be a base ref, and the readers must be
 * able to tell "this row predates the column" from "this row was branched from ''". Rows
 * that predate it fall back to `repoMappingFor(...).baseBranch`, which is the answer they
 * were already living with.
 */

import type { Migration } from '../migrate.js';

export const migration003: Migration = {
  version: 3,
  name: 'run-base-ref',
  sql: `
ALTER TABLE runs ADD COLUMN base_ref TEXT;
`,
};
