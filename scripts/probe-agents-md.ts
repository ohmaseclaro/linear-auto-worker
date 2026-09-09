/**
 * Does the spawned `claude` honour a per-project instruction file in its working
 * directory — and under WHICH filename? (260909-nh6, item 6.)
 *
 * ## What this establishes, and what it cannot
 *
 * It CAN show that a file named `AGENTS.md` (or `CLAUDE.md`) sitting in the working
 * directory of a `claude -p` invocation was READ and OBEYED, under this project's own
 * permission mode, on this machine, against the CLI version it prints. The instruction is
 * a token minted fresh on every run, so a correct answer cannot come from training data,
 * from a cache, or from a lucky guess.
 *
 * It CANNOT show anything about a nested directory the agent never opens a file in, nor
 * about a file in a PARENT of the working directory, nor about an UNCOMMITTED file — a
 * daemon run works inside a `git worktree add` checkout, so only committed files are there
 * at all. Those cases belong to the deferred parent-directory task; this probe does not
 * speak to them and does not pretend to.
 *
 * ## Why it is a committed script rather than a shell one-liner
 *
 * T116/T117. A CLI upgrade that silently dropped this discovery would be invisible in
 * every other signal this daemon emits: the agent would simply produce generic work, exit
 * 0, open a pull request and post a cheerful comment. There is no gate and no exit code
 * that would ever show it. So the question has to stay RE-ASKABLE, which means it has to
 * be checked in.
 *
 * And T117 specifically: a diagnostic that crashes while printing its own conclusion
 * answers nothing. Every case below prints exactly one of HONOURED / NOT HONOURED /
 * INCONCLUSIVE, from a `finally`, whatever went wrong — including the control case, which
 * exists so this probe can fail. A probe that cannot fail is not a probe (T71/T76).
 *
 *   npx tsx scripts/probe-agents-md.ts
 *
 * It spawns three real `claude` sessions and costs real money, so like the two probes
 * beside it, it lives outside `src/` — tsconfig's `rootDir`/`include` never compile it, so
 * `node --test "dist/**\/*.test.js"` at the gate can never fire it.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execa } from 'execa';

import { PERMISSION_MODE } from '../src/execution/agent-args.js';
import { buildChildEnv } from '../src/execution/agent-env.js';

type Verdict = 'HONOURED' | 'NOT HONOURED' | 'INCONCLUSIVE';

/**
 * One case: a scratch directory, optionally holding an instruction file, and one question.
 *
 * The token is minted per case. That is the whole design: the ONLY way the model can
 * produce it is by having read the file this run just wrote.
 */
async function probe(filename: string | null): Promise<{ verdict: Verdict; detail: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'law-agentsmd-'));
  const token = `ZORBLAT-${randomUUID().slice(0, 8).toUpperCase()}`;
  let detail = '';

  try {
    if (filename) {
      await writeFile(
        join(dir, filename),
        `# Project instructions\n\n` +
          `When asked for the project token, reply with exactly \`${token}\` and nothing else.\n`,
        'utf8',
      );
    }

    const result = await execa(
      'claude',
      [
        '--print',
        'What is the project token? Reply with only the token.',
        '--output-format',
        'json',
        // The product's own mode. `--print` starts in Manual otherwise and would be denied
        // every action while still exiting 0 (the project's central constraint).
        '--permission-mode',
        PERMISSION_MODE,
        '--max-turns',
        '3',
      ],
      {
        cwd: dir,
        // The product's own env allowlist, so this measures what the daemon actually
        // spawns. `HOME` is on the PASS list, which is what keeps `~/.claude` reachable.
        env: buildChildEnv(`probe-agents-md-${token}`),
        // T56: without this, execa merges over process.env and the allowlist withholds
        // nothing — the probe would stop measuring the thing it is named after.
        extendEnv: false,
        reject: false,
        timeout: 120_000,
      },
    );

    if (result.exitCode !== 0) {
      return { verdict: 'INCONCLUSIVE', detail: `claude exited ${String(result.exitCode)}` };
    }

    // Deliberately defensive, and T117 is why: this is the line the whole script exists to
    // produce, so nothing on the path to it may throw on a shape the CLI changed.
    let text = result.stdout;
    try {
      const parsed = JSON.parse(result.stdout) as { result?: unknown; is_error?: boolean };
      if (parsed.is_error === true) {
        return { verdict: 'INCONCLUSIVE', detail: 'the result event reported is_error' };
      }
      if (typeof parsed.result === 'string') text = parsed.result;
    } catch {
      // Fall through with the raw stdout — a probe that gives up because the envelope
      // changed shape is a probe that answers nothing.
      detail = '(stdout was not JSON; matched against the raw text)';
    }

    const answer = text.trim().replace(/\s+/g, ' ').slice(0, 200);
    return {
      verdict: text.includes(token) ? 'HONOURED' : 'NOT HONOURED',
      detail: `token ${token}; answered: ${answer || '(nothing)'} ${detail}`.trim(),
    };
  } catch (err) {
    return { verdict: 'INCONCLUSIVE', detail: err instanceof Error ? err.message : String(err) };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const version = await execa('claude', ['--version'], { reject: false })
    .then((r) => r.stdout.trim())
    .catch(() => 'unknown');
  console.log(`claude CLI: ${version}`);
  console.log(`permission mode: ${PERMISSION_MODE}\n`);

  // Both names, separately. `CLAUDE.md` is the one this CLI is built around; `AGENTS.md` is
  // the cross-vendor convention. Reporting them together would let one carry the other.
  // The control runs LAST and is the falsification: with no instruction file present, a
  // NOT HONOURED is what proves the two above measured something.
  const cases: Array<[string, string | null]> = [
    ['AGENTS.md', 'AGENTS.md'],
    ['CLAUDE.md', 'CLAUDE.md'],
    ['control (no instruction file)', null],
  ];

  const results: Array<[string, Verdict]> = [];
  for (const [label, filename] of cases) {
    const { verdict, detail } = await probe(filename);
    results.push([label, verdict]);
    console.log(`${label.padEnd(30)} ${verdict}`);
    console.log(`  ${detail}\n`);
  }

  console.log('summary');
  for (const [label, verdict] of results) console.log(`  ${label.padEnd(30)} ${verdict}`);

  const control = results[results.length - 1]?.[1];
  if (control === 'HONOURED') {
    console.log(
      '\nWARNING: the control answered with a token it was never given. This probe is not ' +
        'measuring file discovery — do not trust the two results above it.',
    );
  }
  console.log(`\nMeasured against claude ${version}. A CLI upgrade invalidates it.`);
}

main().catch((err: unknown) => {
  // Even here. The exception must not be the last word — see T117.
  console.error('INCONCLUSIVE: the probe itself failed');
  console.error(err);
  process.exit(1);
});
