/**
 * The worker opens the PR — never the agent. DELV-01, DELV-02, DELV-03, DELV-04, DELV-08,
 * DELV-09, D-12, D-13.
 *
 * This is the only code in the milestone that writes to a remote the operator owns.
 * Everything irreversible in the product happens here, which is why all three gates sit
 * UPSTREAM of the push rather than beside it.
 *
 * Nothing in the agent's prompt or the agent's behaviour is required for delivery to
 * happen. Delivery that depends on the agent remembering a final step is delivery that
 * silently does not happen on the runs where it matters most.
 */
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { DeliveryError } from '../domain/errors.js';
import type { RunCommand } from './execute-run.js';
import { runPrePushGates } from './gates.js';
import type { PrBodySource } from '../domain/ports.js';
import { renderPrBody } from './pr-body.js';
import { sanitizeUntrustedText } from './prompt.js';

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
  /**
   * REQUIRED. The worker templates the body here, after the gates (DELV-03, DELV-08).
   *
   * There used to be a `body?: string` beside this, justified as "kept so `execute-run.ts`
   * compiles unchanged" — `execute-run.ts` does not call `deliver`. It was optional, every
   * caller supplied only it, and the `??` below turned "nobody wired the structured body"
   * into a valid render. Deleted, not deprecated: an optional parameter is a dead parameter
   * until the gate proves a caller sets it, and required makes `tsc` that gate (T120).
   */
  prBody: PrBodySource;
  draft: boolean;
  /** A `partial` run is always a draft, whatever the mapping toggle says. */
  verdict?: 'delivered' | 'partial';
}

export interface DeliveryResult {
  prUrl: string;
  ciPaths: string[];
  /** Convenience mirror of `ciPaths.length > 0`. */
  ciTouched: boolean;
  draft: boolean;
  /** True when an open PR for this branch already existed and none was created. */
  alreadyExisted: boolean;
}

/**
 * A bare `startsWith` would read `COD-99 …` as already carrying `COD-9` and drop this
 * ticket's key — and they are different tickets. The identifier is joined AFTER sanitizing so
 * the trusted half never passes through the stripper.
 */
function leadWithIdentifier(title: string, identifier: string): string {
  const key = identifier.trim();
  if (key.length === 0) return title;
  const head = title.slice(0, key.length);
  if (head.toLowerCase() === key.toLowerCase()) {
    const next = title.charAt(key.length);
    if (next === '' || !/[\p{L}\p{N}]/u.test(next)) return title;
  }
  return `${key} ${title}`;
}

/**
 * Push the branch and open the pull request — or return `null` when there is nothing to
 * deliver.
 *
 * `null` means the diff range is empty: the agent left no commits in THIS repository. That
 * is the normal case for a multi-repo ticket, where one shared session works in some of
 * its repositories and not others. Pushing anyway would create an empty branch on the
 * operator's remote and open an empty pull request for a repository nobody touched, which
 * they would then close by hand.
 *
 * It is a strict improvement on the single-repo path too: a barren `complete` that slipped
 * past `verdict.ts` used to open exactly that empty pull request.
 */
export async function deliver(o: DeliverInput): Promise<DeliveryResult | null> {
  const remote = o.remote ?? 'origin';
  const range = `${o.base}..HEAD`;

  // 1. Collect the text the gates need. These are the only two commands upstream of the
  //    gates, and both are read-only.
  const changed = await o.runCommand('git', ['-C', o.worktreePath, 'diff', '--name-only', range]);
  const files = splitLines(changed.stdout);
  const diff = await o.runCommand('git', ['-C', o.worktreePath, 'diff', range]);

  // 1b. Nothing to deliver. Decided from GIT, before the gates and long before the push —
  //     never from the agent's own claim about which repositories it changed (that field
  //     existed on the wire schema and was deleted rather than wired up; `verdict.ts` is
  //     the rule of this file). Both reads are needed: a commit that only moves a file
  //     mode shows in `--name-only` with an empty textual diff, and a merge commit can do
  //     the reverse.
  if (files.length === 0 && diff.stdout.trim().length === 0) return null;

  // 2. The gates, before a single push argument is constructed. A refusal or a block ends
  //    the run here — no push, no PR — and the reason goes out to the caller so Phase 5 can
  //    report it on the ticket.
  const gates = runPrePushGates({
    branch: o.branch,
    defaultBranch: o.defaultBranch,
    diff: diff.stdout,
    files,
  });
  if (gates.refusal) throw new DeliveryError(gates.refusal);
  if (gates.block) throw new DeliveryError(gates.block);

  // 3. Push explicitly, one FULLY QUALIFIED named ref: an ambiguous ref can resolve to a
  //    tag of the same name and push the wrong object. The forcing variants of this command
  //    do not appear anywhere in this file, in any spelling (D-13) — a rewrite of a remote
  //    branch is exactly the irreversible act the gates above exist to prevent.
  //
  //    The push comes before `gh` and not after: `gh` prompts for where to push when the
  //    branch is not fully pushed, and it has no TTY here to prompt into, so the prompt is
  //    a hang (Pitfall 7).
  await o.runCommand('git', ['-C', o.worktreePath, 'push', '-u', remote, `refs/heads/${o.branch}`]);

  const draft = o.draft || o.verdict === 'partial';

  // 4. Idempotency. Delivery is retried after transient failures, and a second PR for one
  //    branch is noise the operator cleans up by hand.
  const existing = await findOpenPrUrl(o);
  if (existing) {
    return {
      prUrl: existing,
      ciPaths: gates.ciPaths,
      ciTouched: gates.ciPaths.length > 0,
      draft,
      alreadyExisted: true,
    };
  }

  // 5. `--body-file` needs a real path, so the body lands on disk first.
  const body = renderPrBody({ ...o.prBody, ciPaths: gates.ciPaths });
  const bodyPath = path.join(tmpdir(), `law-pr-body-${randomUUID()}.md`);
  await writeFile(bodyPath, body, 'utf8');

  // The title crosses into a subprocess argv AND into a GitHub page heading. It is the same
  // untrusted ticket text the prompt sanitizes, and it deserves the same treatment; the
  // runner takes an argv array, so there is no shell to interpolate into either.
  const title = leadWithIdentifier(sanitizeUntrustedText(o.title), o.prBody.ticketIdentifier);

  const createArgs = [
    'pr',
    'create',
    '-R',
    o.ownerRepo,
    '--base',
    o.defaultBranch,
    '--head',
    o.branch,
    '--title',
    title,
    '--body-file',
    bodyPath,
    // DELV-02: draft is the DEFAULT, with a per-mapping toggle for ready. Shipping
    // incomplete work as ready-for-review wastes a reviewer's time on the run that already
    // went least well.
    ...(draft ? ['--draft'] : []),
  ];
  const created = await o.runCommand('gh', createArgs);

  // 6. T13 / D-12: `gh pr create` on 2.98.0 has NO machine-readable output flag — asking
  //    for one errors out with `unknown flag`, which is the obvious thing to reach for and
  //    the reason this is written down. It prints the PR URL on stdout, and stdout may
  //    carry a leading warning line, so take the last non-empty one.
  const prUrl = splitLines(created.stdout).pop();
  if (!prUrl) {
    throw new DeliveryError(
      `the push succeeded but gh printed no PR URL for ${o.branch}. The branch is on the ` +
        `remote; a PR may need to be opened by hand.`
    );
  }

  return {
    prUrl,
    ciPaths: gates.ciPaths,
    ciTouched: gates.ciPaths.length > 0,
    draft,
    alreadyExisted: false,
  };
}

/**
 * The open PR for this branch, or undefined.
 *
 * T60 — read this before "simplifying" back to a text parse. T13 is real but NARROW:
 * `gh pr create` has no `--json` and errors with `unknown flag`. `gh pr list --json` and
 * `gh pr view --json` both exist (verified, gh 2.98.0). Applying T13 file-wide forced this
 * function into parsing the first integer of the first non-empty line of non-TTY `gh pr
 * list` output — an unverifiable parse of a format gh does not promise, on the one code
 * path that decides whether the daemon opens a SECOND pull request for a branch that
 * already has one. The ban belongs on the subcommand, not the flag; `deliver.test.ts`
 * asserts exactly that.
 *
 * The URL now comes back from gh rather than being reassembled from `owner/repo`, so a
 * GitHub Enterprise host works without a second code path.
 */
interface GhPrListRow {
  number?: unknown;
  url?: unknown;
}

async function findOpenPrUrl(o: DeliverInput): Promise<string | undefined> {
  const listArgs = [
    'pr',
    'list',
    '--head',
    o.branch,
    '-R',
    o.ownerRepo,
    '--state',
    'open',
    '--json',
    'number,url',
  ];
  const listed = await o.runCommand('gh', listArgs, { reject: false });
  if (listed.exitCode !== 0) return undefined;

  // gh prints `[]` for no match. Anything unparseable is treated as "no existing PR",
  // which costs at worst a duplicate PR — the same failure the old parse had, without
  // pretending a malformed payload is a number.
  let rows: unknown;
  try {
    rows = JSON.parse(listed.stdout.trim() || '[]');
  } catch {
    return undefined;
  }
  if (!Array.isArray(rows)) return undefined;

  const first = rows[0] as GhPrListRow | undefined;
  return typeof first?.url === 'string' && first.url.length > 0 ? first.url : undefined;
}

function splitLines(s: string): string[] {
  return s
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
