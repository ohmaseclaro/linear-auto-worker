/**
 * Re-measure the entire streaming-input contract (M2–M11) against the REAL `claude`.
 *
 * This is the only instrument in the repository that can see T113/M2 — `-p "<prompt>"`
 * silently discarded under `--input-format stream-json`, session hangs forever. Nothing in
 * `npm run verify` can: the gate never spawns a real binary, by design. The suite contains
 * our own regressions; this contains the VENDOR's. The CLI ships a new major roughly
 * weekly, and the day one of them changes stdin semantics, every run produces nothing for
 * 45 minutes with a healthy-looking log.
 *
 * (The daemon is not defenceless in between: `AGENT_ACK_TIMEOUT_MS` in `supervisor.ts`
 * reaps a session that produces neither a `system/init` nor a replayed echo within 60
 * seconds. That turns the failure loud. This is what turns it EXPLAINED.)
 *
 * WHY THIS IS A SCRIPT AND NOT A TEST. It spawns a real `claude` and COSTS REAL MONEY —
 * ~$0.30 per run, measured, because the cached GSD system prompt is charged on the first
 * turn. It must never be fired by `node --test`. Two things keep it out: it imports nothing
 * from `node:test`, and it lives outside `src/`, which is what tsconfig's `include` covers.
 *
 *   npx tsx scripts/probe-stream-input.ts
 *
 * It spawns ONE session through the SHIPPED `buildClaudeArgs` — a probe with its own copy
 * of the flag list verifies nothing about the thing that ships — writes three messages on
 * stdin, and prints a per-result table so the per-message vs cumulative asymmetry (M6) is
 * VISIBLE rather than asserted.
 *
 * PASS looks like: three results, `session_id` identical on all of them, `total_cost_usd`
 * monotonically increasing by small deltas, `usage.input_tokens` NOT accumulating, a user
 * echo before each reply, and a clean exit within a second of `stdin.end()`.
 *
 * FAIL looks like: silence. If nothing arrives after the hook burst, M2 has returned and
 * `agent-args.ts` is wrong about the wire.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execa } from 'execa';

import {
  AGENT_RESULT_JSON_SCHEMA,
  buildClaudeArgs,
  userMessageLine,
} from '../src/execution/agent-args.js';
import { buildChildEnv } from '../src/execution/agent-env.js';
import { makeLineParser } from '../src/execution/stream-parser.js';

/** Three cheap messages. The point is the protocol, not the work. */
const MESSAGES = [
  'Reply with exactly the word APPLE and nothing else.',
  'Now reply with exactly the word BANANA and nothing else.',
  'Now reply with exactly the word CHERRY and nothing else.',
];

/** If nothing at all has arrived by here, M2 is back. Longer than the 90s the probe waited. */
const SILENCE_LIMIT_MS = 120_000;

interface ResultRow {
  n: number;
  sessionId: string;
  subtype: string;
  numTurns: number | undefined;
  costUsd: number | undefined;
  inputTokens: number | undefined;
  cacheRead: number | undefined;
  structured: unknown;
}

async function main(): Promise<number> {
  const cwd = await mkdtemp(join(tmpdir(), 'law-probe-stream-'));
  const sessionId = randomUUID();

  // From the PRODUCT. That is the whole value of the probe.
  const args = buildClaudeArgs({
    sessionId,
    schema: AGENT_RESULT_JSON_SCHEMA,
    maxTurns: 4,
  });
  const env = buildChildEnv(`probe-${sessionId}`);

  console.log(`argv: claude ${args.join(' ')}\n`);
  console.log('M3 check: -p is', args[args.length - 1] === '-p' ? 'LAST and bare — ok' : 'NOT LAST — WRONG');
  console.log(`session id requested: ${sessionId}\n`);

  const results: ResultRow[] = [];
  const inits: string[] = [];
  const echoes: string[] = [];
  const started = Date.now();
  let sawAnything = false;
  let sent = 0;

  const child = execa('claude', args, {
    cwd,
    env,
    // T56: without this execa merges `env` over process.env.
    extendEnv: false,
    buffer: false,
    reject: false,
  });

  const stamp = (): string => `${((Date.now() - started) / 1000).toFixed(1)}s`;

  function send(text: string): void {
    sent += 1;
    console.log(`[${stamp()}] -> message ${sent}: ${text}`);
    child.stdin?.write(userMessageLine(text));
  }

  const parser = makeLineParser(
    (event) => {
      const e = event as Record<string, unknown>;
      sawAnything = true;
      const type = e['type'];
      const subtype = e['subtype'];

      if (type === 'system' && subtype === 'init') {
        inits.push(String(e['session_id']));
        console.log(
          `[${stamp()}] system/init  session=${String(e['session_id'])} ` +
            `skills=${(e['skills'] as string[] | undefined)?.length ?? 0} ` +
            `mode=${String(e['permissionMode'])}`,
        );
        return;
      }

      if (type === 'user') {
        // M11. This is the receipt the daemon relies on.
        const content = (e['message'] as { content?: Array<{ text?: string }> } | undefined)?.content;
        const text = content?.[0]?.text ?? '';
        echoes.push(text);
        console.log(`[${stamp()}] user echo   "${text.slice(0, 60)}"`);
        return;
      }

      if (type === 'result') {
        const usage = (e['usage'] ?? {}) as Record<string, number>;
        results.push({
          n: results.length + 1,
          sessionId: String(e['session_id']),
          subtype: String(subtype),
          numTurns: e['num_turns'] as number | undefined,
          costUsd: e['total_cost_usd'] as number | undefined,
          inputTokens: usage['input_tokens'],
          cacheRead: usage['cache_read_input_tokens'],
          structured: e['structured_output'],
        });
        console.log(
          `[${stamp()}] result #${results.length}  turns=${String(e['num_turns'])} ` +
            `cost=$${String(e['total_cost_usd'])}`,
        );

        // M7: injection works BETWEEN turns. The session stays alive on an open stdin.
        if (sent < MESSAGES.length) {
          send(MESSAGES[sent] as string);
        } else {
          // M8: EOF is what ends the session. Nothing else terminated it in 90 seconds.
          console.log(`[${stamp()}] <- stdin.end()`);
          child.stdin?.end();
        }
      }
    },
    (line) => console.log(`[${stamp()}] BAD LINE: ${line.slice(0, 120)}`),
  );

  // The M2 detector. If the CLI ever starts discarding stdin the way it discards a `-p`
  // VALUE, this is what says so instead of hanging until somebody notices.
  const watchdog = setTimeout(() => {
    console.error(
      `\nNOTHING ARRIVED IN ${SILENCE_LIMIT_MS / 1000}s. That is M2/T113: the prompt was ` +
        `discarded and the session is hung. agent-args.ts is wrong about the wire.`,
    );
    child.kill('SIGKILL');
  }, SILENCE_LIMIT_MS);

  // Synchronously, before reading anything (the rule `supervisor.ts` follows).
  send(MESSAGES[0] as string);

  if (child.stdout) {
    child.stdout.setEncoding('utf8');
    for await (const chunk of child.stdout) parser.push(chunk as string);
  }
  parser.flush();
  clearTimeout(watchdog);
  const { exitCode } = await child;

  console.log('\n--- results (M6: cost is CUMULATIVE, usage is PER MESSAGE) ---');
  console.log('  #  subtype        turns  total_cost_usd  input_tokens  cache_read');
  for (const r of results) {
    console.log(
      `  ${r.n}  ${String(r.subtype).padEnd(14)} ${String(r.numTurns).padEnd(6)} ` +
        `${String(r.costUsd).padEnd(15)} ${String(r.inputTokens).padEnd(13)} ${String(r.cacheRead)}`,
    );
  }

  console.log('\n--- report ---');
  console.log(`exit code:            ${exitCode}  (0 within ~1s of stdin.end() is M8)`);
  console.log(`results:              ${results.length} (expected ${MESSAGES.length} — M4)`);
  console.log(`system/init events:   ${inits.length} (M9: one PER MESSAGE, not one per session)`);
  console.log(`user echoes:          ${echoes.length} (M11 — the delivery receipt)`);
  console.log(
    `session id echoed:    ${
      [...new Set([...inits, ...results.map((r) => r.sessionId)])].join(', ')
    } (M10)`,
  );
  const costs = results.map((r) => r.costUsd ?? 0);
  const monotonic = costs.every((c, i) => i === 0 || c >= (costs[i - 1] as number));
  console.log(`cost monotonic:       ${monotonic} — take the LAST, never the sum`);
  console.log(
    `tokens if summed:     ${results.reduce((t, r) => t + (r.inputTokens ?? 0), 0)} input_tokens ` +
      `— this IS the right sum for usage`,
  );
  console.log(`last structured_output: ${JSON.stringify(results[results.length - 1]?.structured)}`);

  await rm(cwd, { recursive: true, force: true });

  if (!sawAnything) {
    console.error('\nFAIL: the session emitted nothing at all. M2/T113 has returned.');
    return 1;
  }
  if (results.length !== MESSAGES.length) {
    console.error(
      `\nFAIL: ${MESSAGES.length} messages produced ${results.length} results. M4 no longer ` +
        `holds, and the terminal design in supervisor.ts rests on it.`,
    );
    return 1;
  }
  console.log('\nPASS — the streaming-input contract still holds.');
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  },
);
