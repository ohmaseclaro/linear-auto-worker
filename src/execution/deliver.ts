/**
 * The worker opens the PR — never the agent. DELV-01, DELV-02, DELV-03, D-12, D-13.
 *
 * Delivery must not depend on the agent remembering a final step, and it must not happen
 * before the gates. Plan 06 owns the templated body and retry idempotency; the tracer
 * writes a minimal body and calls this same function.
 */
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { DeliveryError } from '../domain/errors.js';
import type { RunCommand } from './execute-run.js';
import { assertPushAllowed, touchesCiPaths } from './gates.js';

export interface DeliverInput {
  runCommand: RunCommand;
  worktreePath: string;
  branch: string;
  /** The ref the branch was cut from; the left side of the diff range. */
  base: string;
  /** `owner/repo`. */
  ownerRepo: string;
  defaultBranch: string;
  remote?: string;
  title: string;
  body: string;
  draft: boolean;
}

export interface DeliveryResult {
  prUrl: string;
  ciTouched: boolean;
}

export async function deliver(o: DeliverInput): Promise<DeliveryResult> {
  // 1. The gate, first. Everything below this line assumes it passed.
  assertPushAllowed({ branch: o.branch, defaultBranch: o.defaultBranch });

  const changed = await o.runCommand('git', [
    '-C',
    o.worktreePath,
    'diff',
    '--name-only',
    `${o.base}..HEAD`,
  ]);
  const ciTouched = touchesCiPaths(
    changed.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
  );

  // 2. Push explicitly, one named ref, and never the forcing variant of this command
  //    (D-13). The explicit push also stops `gh` hanging: `gh` prompts for where to push
  //    when the branch is not fully pushed, and it has no TTY here to prompt into.
  const remote = o.remote ?? 'origin';
  await o.runCommand('git', [
    '-C',
    o.worktreePath,
    'push',
    '-u',
    remote,
    `refs/heads/${o.branch}`,
  ]);

  // 3. `--body-file` needs a real path, so the body has to land on disk first.
  const bodyPath = path.join(tmpdir(), `law-pr-body-${randomUUID()}.md`);
  await writeFile(bodyPath, o.body, 'utf8');

  const args = [
    'pr',
    'create',
    '-R',
    o.ownerRepo,
    '--base',
    o.defaultBranch,
    '--head',
    o.branch,
    '--title',
    o.title,
    '--body-file',
    bodyPath,
    ...(o.draft ? ['--draft'] : []),
  ];
  const created = await o.runCommand('gh', args);

  // 4. T13 / D-12: `gh pr create` on 2.98.0 has no flag for machine-readable output —
  //    asking for one errors out with `unknown flag`. It prints the PR URL on stdout.
  const prUrl = created.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .pop();

  if (!prUrl) {
    throw new DeliveryError(
      `the push succeeded but gh printed no PR URL for ${o.branch}. The branch is on the ` +
        `remote; a PR may need to be opened by hand.`
    );
  }

  return { prUrl, ciTouched };
}
