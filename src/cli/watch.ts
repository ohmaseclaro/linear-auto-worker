/**
 * `law watch [target]` — follow a spawned run's activity live, or read it back afterwards.
 *
 * A SEPARATE process from the daemon, exactly like `law status` and for the same reasons:
 * there is no query endpoint to add, and the run log is an appending file that a second
 * process can tail without coordinating with the writer. It therefore also works on a run
 * whose daemon has since died, which is when an operator most wants it.
 *
 * The tail reuses `makeLineParser` verbatim. Carrying a partial line across reads IS the
 * whole difficulty of following an appending file, and that module already solves it.
 */
import { existsSync, promises as fsp } from 'node:fs';
import path from 'node:path';

import { defaultRoot } from '../infra/config.js';
import { openStore } from '../infra/store/db.js';
import { createSqliteStore, type RunRow } from '../infra/store/sqlite-store.js';
import { TERMINAL } from '../domain/types.js';
import { runLogPath } from '../execution/run-log.js';
import { makeLineParser } from '../execution/stream-parser.js';
import { sanitizeUntrustedText } from '../execution/prompt.js';
import { resolveRunTarget, sessionOwner, sharedWith } from './resolve-run.js';

/** One terminal line. Same shape of cap `status.ts` puts on its label. */
const MAX_LINE = 160;

/** How often the tail re-stats the file. See `<open_risks>`: `stat` is free, `fs.watch`
 *  has platform-dependent semantics, and a log that grows faster than this is past its cap. */
const DEFAULT_POLL_MS = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Collapse whitespace, strip control characters, truncate.
 *
 * `sanitizeUntrustedText` is the SAME helper `prompt.ts` runs Linear-authored text through
 * on the way IN. It is applied here on the way OUT, and the direction is the whole reason
 * it is not a contradiction of T-VOH-06 (which deliberately does NOT sanitize what the
 * operator types into `law say`). What lands in this file is raw agent output, and the
 * agent has been reading attacker-controlled ticket text all run (T99). ANSI escapes in
 * that text would let it rewrite the operator's scrollback and forge this command's own
 * status lines — a run could print its own `── result success` and look delivered.
 * Collapsing whitespace does not remove ESC; this does.
 */
function line(text: string): string {
  const collapsed = sanitizeUntrustedText(text).replace(/\s+/g, ' ').trim();
  return collapsed.length > MAX_LINE ? `${collapsed.slice(0, MAX_LINE - 1)}…` : collapsed;
}

/** A tool call's input, as much of it as fits on the end of one line. */
function digest(input: unknown): string {
  if (input === undefined || input === null) return '';
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input) ?? '';
  } catch {
    return '';
  }
}

function renderContent(block: unknown, isUser: boolean): string | null {
  if (!isRecord(block)) return null;
  const type = block['type'];
  if (type === 'text') {
    const text = str(block['text']) ?? '';
    if (text.trim().length === 0) return null;
    // M11: a replayed `user` text block is the operator's OWN words coming back — that is
    // what puts both halves of the conversation in the log rather than only the agent's
    // unexplained change of direction.
    return isUser ? line(`» ${text}`) : line(text);
  }
  if (type === 'tool_use') {
    return line(`⚙ ${str(block['name']) ?? 'tool'} ${digest(block['input'])}`);
  }
  if (type === 'tool_result') {
    const content = block['content'];
    const text = typeof content === 'string' ? content : digest(content);
    return line(`↳ ${text.split('\n')[0] ?? ''}`);
  }
  return null;
}

/** `null` means "not worth a line". Pure, so the tests are pure. */
export function renderEvent(event: unknown): string | null {
  if (!isRecord(event)) return null;
  const type = event['type'];
  const subtype = event['subtype'];

  if (type === 'system' && subtype === 'init') {
    const session = str(event['session_id']) ?? '????????';
    const skills = Array.isArray(event['skills']) ? event['skills'].length : 0;
    return line(`session ${session.slice(0, 8)} · ${skills} skills · ${str(event['permissionMode']) ?? '?'}`);
  }

  if (type === 'assistant' || type === 'user') {
    const message = event['message'];
    const content = isRecord(message) ? message['content'] : undefined;
    if (!Array.isArray(content)) return null;
    const lines = content
      .map((block) => renderContent(block, type === 'user'))
      .filter((l): l is string => l !== null);
    return lines.length > 0 ? lines.join('\n') : null;
  }

  if (type === 'system' && (subtype === 'task_summary' || subtype === 'post_turn_summary')) {
    const detail = str(event['detail']) ?? str(event['status_detail']);
    return detail === undefined ? null : line(`· ${detail}`);
  }

  if (type === 'system' && subtype === 'permission_denied') {
    return line(`✗ denied ${str(event['tool_name']) ?? '?'}`);
  }

  if (type === 'result') {
    const turns = event['num_turns'];
    const cost = event['total_cost_usd'];
    return line(
      `── result ${str(subtype) ?? '?'} turns=${typeof turns === 'number' ? turns : '?'} ` +
        `$${typeof cost === 'number' ? cost.toFixed(4) : '?'}`,
    );
  }

  if (type === 'law.truncated') {
    return line(`── activity log hit its size cap at ${String(event['bytes'])} bytes; nothing after this was recorded`);
  }
  if (type === 'law.badline') {
    return line(`✗ unparseable stream line: ${str(event['line']) ?? ''}`);
  }

  // Everything else — hook_started, hook_response, rate_limit_event, whatever the CLI adds
  // next — is noise on a terminal. Unknown is `null` by design, not by omission.
  return null;
}

export interface WatchDeps {
  root?: string;
  target?: string;
  print?: (line: string) => void;
  now?: () => number;
  pollMs?: number;
}

function label(run: RunRow): string {
  return [run.issueKey ?? run.id.slice(0, 8), run.repoSlug].filter(Boolean).join(' ');
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Returns the process exit code. */
export async function runWatch(deps: WatchDeps = {}): Promise<number> {
  const root = deps.root ?? defaultRoot();
  const print = deps.print ?? ((l: string) => console.log(l));
  const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;

  const dbFile = path.join(root, 'store.db');
  if (!existsSync(dbFile)) {
    print(`no store at ${dbFile} — run \`law setup\` first`);
    return 1;
  }

  // `openStore` migrates on open — safe from here for the reason `status.ts` records.
  const db = openStore(dbFile);
  const store = createSqliteStore(db);
  let interrupted = false;
  const onSigint = (): void => {
    interrupted = true;
  };
  process.on('SIGINT', onSigint);

  try {
    const resolved = resolveRunTarget(store, deps.target);
    if ('error' in resolved) {
      print(resolved.error);
      return 1;
    }

    // Resolution is done; NOW redirect. A multi-repo ticket is worked by ONE `claude`
    // session, so any of its rows means that session — and the row the operator named may
    // have no log of its own at all. Strictly after `resolveRunTarget`, which is what keeps
    // T118 intact: nothing here touches `matches` or `runTarget`.
    const run = sessionOwner(store, resolved.run);
    if (run.id !== resolved.run.id) {
      // Reported, never silent. An operator who typed one repository's token and is shown
      // another's session has to be told why, or the output looks like the wrong run.
      const others = sharedWith(store, resolved.run).filter((slug) => slug !== run.repoSlug);
      print(
        `following ${label(run)}'s session, shared with ${others.join(' and ')}` +
          ` — one agent works this whole ticket`,
      );
    }
    const file = runLogPath(root, run.id);
    const parser = makeLineParser(
      (event) => {
        const rendered = renderEvent(event);
        if (rendered !== null) print(rendered);
      },
      // A line the parser could not parse out of the LOG is not the same defect as one the
      // agent emitted; both are worth a line and neither is worth a crash.
      (bad) => print(line(`✗ unreadable log line: ${bad}`)),
    );

    let offset = 0;
    let announcedWaiting = false;

    for (;;) {
      if (interrupted) return 0;

      let size: number | undefined;
      try {
        size = (await fsp.stat(file)).size;
      } catch {
        size = undefined;
      }

      if (size === undefined) {
        const fresh = store.getRun(run.id) ?? run;
        if (TERMINAL.includes(fresh.state as never)) {
          print(
            `no activity log for ${label(run)} — it predates \`law watch\`, or no agent was ever spawned`,
          );
          return 1;
        }
        if (!announcedWaiting) {
          print('waiting for the agent to start…');
          announcedWaiting = true;
        }
        await sleep(pollMs);
        continue;
      }

      if (size > offset) {
        const handle = await fsp.open(file, 'r');
        try {
          const length = size - offset;
          const buffer = Buffer.alloc(length);
          const { bytesRead } = await handle.read(buffer, 0, length, offset);
          offset += bytesRead;
          parser.push(buffer.subarray(0, bytesRead).toString('utf8'));
        } finally {
          await handle.close();
        }
        continue;
      }

      // Caught up. Only NOW may a terminal state end the follow — the other order drops
      // whatever the agent wrote between the last read and the state write.
      const fresh = store.getRun(run.id) ?? run;
      if (TERMINAL.includes(fresh.state as never)) {
        parser.flush();
        const tail =
          fresh.prUrl ??
          (fresh.failureReason ? fresh.failureReason.split('\n')[0] : undefined) ??
          '';
        print(`── ${fresh.state ?? '?'} ${label(fresh)} ${tail}`.trimEnd());
        return 0;
      }

      await sleep(pollMs);
    }
  } finally {
    process.removeListener('SIGINT', onSigint);
    db.close();
  }
}
