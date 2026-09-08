/**
 * `law say <target> <text…>` — a message into a live agent's stdin.
 *
 * A separate process from the daemon, like `law status` and `law watch`. It resolves the
 * target against the store, refuses the two states where a message cannot land, and
 * otherwise hands the text to the 0600 socket. It never hangs and never exits 0 on a
 * message that was not accepted.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

import { defaultRoot } from '../infra/config.js';
import { openStore } from '../infra/store/db.js';
import { createSqliteStore, type RunRow } from '../infra/store/sqlite-store.js';
import { TERMINAL } from '../domain/types.js';
import { sendInjection } from '../execution/inject.js';
import { resolveRunTarget } from './resolve-run.js';

export interface SayDeps {
  root?: string;
  target?: string;
  text: string;
  print?: (line: string) => void;
}

function label(run: RunRow): string {
  return [run.issueKey ?? run.id.slice(0, 8), run.repoSlug].filter(Boolean).join(' ');
}

/** Returns the process exit code. */
export async function runSay(deps: SayDeps): Promise<number> {
  const root = deps.root ?? defaultRoot();
  const print = deps.print ?? ((l: string) => console.log(l));

  const dbFile = path.join(root, 'store.db');
  if (!existsSync(dbFile)) {
    print(`no store at ${dbFile} — run \`law setup\` first`);
    return 1;
  }

  const db = openStore(dbFile);
  try {
    const store = createSqliteStore(db);
    const resolved = resolveRunTarget(store, deps.target);
    if ('error' in resolved) {
      print(resolved.error);
      return 1;
    }
    const run = resolved.run;

    if (TERMINAL.includes(run.state as never)) {
      print(`run ${label(run)} already finished (${run.state ?? '?'}) — nothing to say to`);
      return 1;
    }

    // The Q&A boundary from the design, made visible at the only place an operator hits it.
    // An agent question IS a `result` event, and stdin closes on a result — so by the time a
    // question exists this channel is already shut. The two paths are disjoint in time by
    // construction, not by convention, and this line is what says so.
    if (run.state === 'awaiting_answer') {
      print(
        `run ${label(run)} is parked awaiting an answer — reply to the bot's comment on ` +
          `${run.issueKey ?? 'the ticket'} in Linear instead`,
      );
      return 1;
    }

    const outcome = await sendInjection({ root, runId: run.id, text: deps.text });
    if (!outcome.ok) {
      print(outcome.error);
      return 1;
    }

    // FLAG-C: "queued", not "sent". `injector.send` returning ok means the bytes were
    // accepted by the pipe, NOT that the agent consumed them — the child reads on its own
    // schedule and can die between the write and the read. The only proof of consumption is
    // the CLI replaying the message back (`--replay-user-messages`, M11), which shows up in
    // `law watch` as a `»` line. Claiming "sent" would be claiming something this process
    // cannot know.
    // The watch argument comes from the RESOLVER (`resolved.target`), not from a second
    // copy of the naming rule: under sibling runs of one ticket, `run.issueKey` is
    // ambiguous and suggesting it would hand the operator back the dead end he just hit.
    print(`queued to ${label(run)} — \`law watch ${resolved.target}\` to see it land`);
    return 0;
  } finally {
    db.close();
  }
}
