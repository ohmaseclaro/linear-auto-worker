/**
 * Settle the one open question of Phase 4: is `ALLOWED_TOOLS` wide enough for a REAL GSD
 * run? (04-CONTEXT D-01 as amended, TRAPS T27.)
 *
 * `--allowedTools "Write" "Edit" "Bash"` is verified sufficient for a file write plus a
 * four-command git chain under `--permission-mode dontAsk`, with zero denials. It is NOT
 * verified against a GSD phase run, which also reaches for Task, Skill, Glob, Grep and
 * TodoWrite. Under-granting reproduces the silent-nothing failure exactly: the agent is
 * refused every tool it needs, creates nothing, and the process exits 0 with
 * is_error:false. That is the single highest-value verification left in this phase.
 *
 * WHY THIS IS A SCRIPT AND NOT A TEST. It spawns a real `claude`, costs real money (the
 * cached GSD system prompt alone measured $0.25 for a one-word reply) and takes minutes.
 * It must never be fired by `node --test` at the integration gate. Two things keep it out:
 * it imports nothing from `node:test`, and it lives outside `src/`, which tsconfig's
 * `rootDir`/`include` cover — so it is never compiled into `dist/` in the first place.
 *
 *   npx tsx scripts/probe-gsd-allowlist.ts
 *
 * Pass: exit 0, zero permission denials, the required GSD skills present, the echoed
 * permission mode matching, and at least one new commit in the throwaway repository.
 * Fail: it prints every denied tool name with its decision_reason_type and tool_input.
 * THAT LIST IS THE ANSWER — add those names to `ALLOWED_TOOLS` in
 * `src/execution/agent-args.ts` and run it again.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execa } from 'execa';

import {
  AGENT_RESULT_JSON_SCHEMA,
  ALLOWED_TOOLS,
  PERMISSION_MODE,
  buildClaudeArgs,
} from '../src/execution/agent-args.js';
import { buildChildEnv } from '../src/execution/agent-env.js';
import { REQUIRED_GSD_SKILLS } from '../src/execution/event-router.js';
import { makeLineParser } from '../src/execution/stream-parser.js';

/**
 * Deliberately GSD-shaped, and deliberately tiny. It has to make the agent reach for the
 * tools this probe exists to discover — orientation (Glob/Grep/Read), a plan (TodoWrite),
 * a skill (Skill/Task) — and then actually write and commit, so a denial anywhere in that
 * chain shows up as a missing commit rather than as a plausible-sounding summary.
 */
const PROBE_PROMPT = [
  'Use the GSD workflow for a quick task in this repository.',
  '',
  'Task: read the existing files to see what this project is, then add a NOTES.md',
  'recording one sentence about it, and commit the change.',
  '',
  'Orient yourself first (list the files, search them), keep a task list as you go, and',
  'use the appropriate GSD skill rather than working ad hoc. Do not run git push and do',
  'not open a pull request.',
  '',
  'End your turn with the JSON result your schema requires.',
].join('\n');

interface Denial {
  tool_name?: string;
  decision_reason_type?: string;
  tool_input?: unknown;
}

function fail(message: string): never {
  console.error(`\nFAIL: ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  // A throwaway repository in a fresh temp directory. NEVER a mapped repo: this probe
  // grants an agent Write, Edit and Bash and then asks it to commit.
  const repo = await mkdtemp(join(tmpdir(), 'law-gsd-probe-'));
  console.log(`probe repository: ${repo}`);

  const git = (...args: string[]) => execa('git', args, { cwd: repo });
  await git('init', '-q');
  await git('config', 'user.email', 'probe@example.invalid');
  await git('config', 'user.name', 'allowlist probe');
  await writeFile(join(repo, 'README.md'), '# probe fixture\n\nA throwaway repository.\n');
  await git('add', 'README.md');
  await git('commit', '-q', '-m', 'chore: probe fixture');
  const before = (await git('rev-list', '--count', 'HEAD')).stdout.trim();

  // The whole value of this probe is that these two come from the PRODUCT. A probe with
  // its own copy of the flag list or its own environment verifies nothing about the thing
  // that ships.
  const sessionId = randomUUID();
  const args = buildClaudeArgs({
    sessionId,
    prompt: PROBE_PROMPT,
    schema: AGENT_RESULT_JSON_SCHEMA,
  });
  const env = buildChildEnv(`probe-${sessionId}`);

  console.log(`allowlist under test: ${ALLOWED_TOOLS.join(' ')}`);
  console.log(`requested permission mode: ${PERMISSION_MODE}\n`);

  let skills: string[] | undefined;
  let permissionMode: string | undefined;
  let costUsd: number | undefined;
  let numTurns: number | undefined;
  let subtype: string | undefined;
  let isError: boolean | undefined;
  const denials: Denial[] = [];
  const badLines: string[] = [];

  const parser = makeLineParser(
    (event) => {
      const e = event as Record<string, unknown>;
      if (e['type'] === 'system' && e['subtype'] === 'init') {
        // `skills` is a FLAT string[] on CLI 2.1.259, not a nested structure, so the
        // GSD-presence check is one includes() per required entry.
        skills = e['skills'] as string[] | undefined;
        // The mode the CLI actually applied, echoed back. A free T1 detector at init time.
        permissionMode = e['permissionMode'] as string | undefined;
        console.log(`init: ${skills?.length ?? 0} skills, permissionMode=${permissionMode}`);
      }
      if (e['type'] === 'system' && e['subtype'] === 'permission_denied') {
        denials.push(e as Denial);
        console.log(`DENIED ${String(e['tool_name'])} (${String(e['decision_reason_type'])})`);
      }
      if (e['type'] === 'result') {
        subtype = e['subtype'] as string | undefined;
        isError = e['is_error'] as boolean | undefined;
        costUsd = e['total_cost_usd'] as number | undefined;
        numTurns = e['num_turns'] as number | undefined;
        for (const d of (e['permission_denials'] as Denial[] | undefined) ?? []) denials.push(d);
      }
    },
    (line) => badLines.push(line)
  );

  const child = execa('claude', args, {
    cwd: repo,
    env,
    // T56: without this execa merges `env` over process.env and the allowlist — the very
    // thing this probe is meant to exercise — withholds nothing.
    extendEnv: false,
    buffer: false,
    reject: false,
  });
  if (child.stdout) {
    child.stdout.setEncoding('utf8');
    for await (const chunk of child.stdout) parser.push(chunk as string);
  }
  parser.flush();
  const { exitCode } = await child;

  const after = (await git('rev-list', '--count', 'HEAD')).stdout.trim();
  const newCommits = Number(after) - Number(before);

  console.log('\n--- report ---');
  console.log(`exit code:        ${exitCode}   (0 means nothing — see D-06/T1)`);
  console.log(`result:           subtype=${subtype} is_error=${isError}`);
  console.log(`turns / cost:     ${numTurns} turns, $${costUsd}`);
  console.log(`new commits:      ${newCommits}`);
  console.log(`denials:          ${denials.length}`);
  if (badLines.length > 0) console.log(`unparsable lines: ${badLines.length}`);

  if (denials.length > 0) {
    console.error('\nThese are the tools the allowlist is missing. Add them to');
    console.error('ALLOWED_TOOLS in src/execution/agent-args.ts and run this again:\n');
    for (const d of denials) {
      console.error(`  ${d.tool_name}  reason=${d.decision_reason_type}`);
      console.error(`      input: ${JSON.stringify(d.tool_input).slice(0, 300)}`);
    }
    console.error(`\n  suggested: ${[...new Set(denials.map((d) => d.tool_name))].join(' ')}`);
    console.error(`\nprobe repository left in place for inspection: ${repo}`);
    fail(`${denials.length} permission denial(s)`);
  }

  const missing = REQUIRED_GSD_SKILLS.filter((s) => !(skills ?? []).includes(s));
  if (missing.length > 0) {
    console.error(`\nprobe repository left in place for inspection: ${repo}`);
    fail(
      `the spawned session cannot see the GSD install (missing: ${missing.join(', ')}). ` +
        'Every run would produce generic non-GSD work and exit 0. Check that nothing ' +
        'added the forbidden --bare flag.'
    );
  }

  if (permissionMode !== PERMISSION_MODE) {
    console.error(`\nprobe repository left in place for inspection: ${repo}`);
    fail(`init echoed permissionMode=${permissionMode}, expected ${PERMISSION_MODE}`);
  }

  if (newCommits < 1) {
    console.error(`\nprobe repository left in place for inspection: ${repo}`);
    fail('the agent committed nothing — the silent-nothing failure, with no denial to explain it');
  }

  await rm(repo, { recursive: true, force: true });
  console.log('\nPASS: zero denials, GSD skills present, mode echoed, work committed.');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
