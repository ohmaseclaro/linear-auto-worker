/**
 * The PR body template. DELV-03, DELV-08.
 *
 * Pure rendering — this file runs nothing and reaches nothing. The worker owns the template
 * (DELV-01): a body the agent writes is a body that is missing on the runs that went worst.
 */
import type { PrBodySource } from '../domain/ports.js';
import { sanitizeUntrustedText } from './prompt.js';

/**
 * The renderer's input. Every field is optional here because the renderer's whole job is
 * to say something honest about a field that is missing — but a CALLER is held to
 * `PrBodySource`, whose ticket fields are required. That asymmetry is deliberate: it is
 * what stops `{}` from compiling at the call site and rendering "(no ticket recorded)".
 */
export interface PrBodyInput extends Partial<PrBodySource> {
  /** From `runPrePushGates`. Non-empty means the body OPENS with the flag. */
  ciPaths?: readonly string[];
  /**
   * `MappingToggles.prAttribution`, instance-level. Defaults to `true` when omitted, so
   * every existing direct caller of `renderPrBody` — including every test in this file
   * that predates this field — renders byte-identically. `false` drops `## Run log` and
   * the trailing attribution line: the two places a PR names the tool and the operator's
   * local filesystem paths.
   */
  prAttribution?: boolean;
}

/**
 * Wrap agent-authored text in a fence it cannot break out of.
 *
 * The summary is text produced by a process that was steered in part by ticket text an
 * outsider wrote. Unfenced, it can forge a heading — or, worse, fabricate a "tests passed"
 * claim in the template's own voice, to a reviewer who has no way to tell the two apart.
 *
 * The fence is one backtick longer than the longest run in the content, which is what makes
 * "just close the fence" not work.
 */
function fence(text: string): string {
  const clean = sanitizeUntrustedText(text);
  const longest = Math.max(0, ...[...clean.matchAll(/`+/g)].map((m) => m[0].length));
  const ticks = '`'.repeat(Math.max(3, longest + 1));
  return `${ticks}text\n${clean}\n${ticks}`;
}

function present(s: string | undefined): string | undefined {
  const t = s?.trim();
  return t && t.length > 0 ? t : undefined;
}

/**
 * DELV-03's five sections render unconditionally, except two: `## Run log` and the
 * trailing attribution line are gated by the instance-level `prAttribution` toggle
 * (default `true`). A deliberately silent instance must not print the tool's name or the
 * operator's local filesystem paths into a PR it opens, so with the toggle off both are
 * omitted rather than blanked.
 *
 * Two of the remaining, unconditional sections are what make the PR reviewable rather than
 * decorative:
 *  - *What I did not do* — an empty section and "nothing" are different statements, and a
 *    reviewer who cannot tell them apart reviews the diff assuming the wrong one.
 *  - *Tests* — under this milestone's constraints the honest answer is often "not run".
 *    Saying so plainly leaves a reviewer better off than a blank they read as "passed".
 */
export function renderPrBody(o: PrBodyInput): string {
  const out: string[] = [];
  const showAttribution = o.prAttribution ?? true;

  // DELV-08. Prominent means FIRST, not present: a warning below the fold is a warning
  // nobody reads. A ticket that quietly edits CI is the highest-consequence diff this
  // tool can produce.
  const ciPaths = o.ciPaths ?? [];
  if (ciPaths.length > 0) {
    out.push('> [!WARNING]');
    out.push('> **This change edits CI, workflow or agent-settings files.**');
    out.push('> Read these paths before anything else in the diff:');
    for (const p of ciPaths) out.push(`> - \`${p}\``);
    out.push('');
  }

  out.push('## Ticket');
  const identifier = present(o.ticketIdentifier);
  const url = present(o.ticketUrl);
  if (url) out.push(identifier ? `[${identifier}](${url})` : url);
  else out.push(identifier ?? '(no ticket recorded)');
  out.push('');

  out.push('## Summary');
  const summary = present(o.summary);
  out.push(summary ? fence(summary) : '_The agent returned no summary._');
  out.push('');

  out.push('## Tests');
  out.push(`- Command: \`${present(o.testCommand) ?? 'none configured for this repository'}\``);
  out.push(`- Result: ${present(o.testResult) ?? '**not run**'}`);
  out.push('');

  out.push('## What I did not do');
  const didNotDo = present(o.didNotDo);
  if (didNotDo) {
    out.push(fence(didNotDo));
  } else if (o.verdict === 'partial') {
    out.push(
      '**This run was cut short and did not finish.** The agent stopped before reporting, ' +
        'so the work left undone is not enumerated here — treat every part of this change ' +
        'as unfinished until the diff says otherwise.'
    );
  } else {
    out.push(
      'The agent recorded nothing here. Assume nothing outside this diff was touched, and ' +
        'read the diff rather than trusting this line.'
    );
  }
  out.push('');

  if (showAttribution) {
    out.push('## Run log');
    out.push(present(o.runLogPath) ? `\`${present(o.runLogPath)}\`` : '(no run log path recorded)');
    out.push('');
  }

  if (showAttribution) {
    out.push('---');
    out.push('_Opened by linear-auto-worker. The worker pushed and opened this PR, not the agent._');
  }

  return out.join('\n');
}
