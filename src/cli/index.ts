#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { runDoctor, runSetupWizard } from './wizard/index.js';
import { bootDaemon, installSignalHandlers } from './daemon.js';
import { runStatus } from './status.js';
import { runSay } from './say.js';
import { runWatch } from './watch.js';

const USAGE = `law — turn Linear issues assigned to your bot into pull requests

usage: law <command> [options]

commands:
  setup            Guided setup: preflight, secrets, project→repo mapping, webhook
                   registration. Safe to re-run — it edits in place and skips whatever
                   is already valid.
  setup --doctor   Inspect and repair this workspace's webhook registrations instead of
                   running the full flow. The only path that can delete anything, and it
                   deletes only after a per-item confirmation.
  start            Run the daemon: bind the local server, open the tunnel, reconcile the
                   webhook, then process assigned issues until interrupted.
  status           Show queued and in-flight runs, read straight from the store. Works
                   whether or not the daemon is running.
  watch [target]   Follow a run's activity live, or replay a finished one. With no target
                   it follows the single active run; otherwise give an issue key
                   (LAW-123) or the first 4+ characters of a run id.
  say <target> <text…>
                   Speak to a running agent mid-flight. The text is queued to the
                   agent's stdin over a local socket the tunnel cannot reach; watch
                   it land with "law watch". Use -- before text starting with a dash.

options:
  -h, --help       Show this message.

the activity "watch" renders is plain NDJSON at
~/.linear-auto-worker/runs/<runId>.jsonl — readable with jq and kept for 7 days.

config lives in ~/.linear-auto-worker/ (config.json, .env at 0600, the SQLite database
and logs). Only LINEAR_API_KEY and NGROK_AUTHTOKEN are ever prompted for.`;

async function main(): Promise<number> {
  // TRAPS T88: `parseArgs` THROWS on any unknown option, so `law --help` — the first
  // thing anybody types — exited with a raw ERR_PARSE_ARGS_UNKNOWN_OPTION stack trace.
  // 08-CONTEXT D-08 requires an actionable message and never a stack trace; that held
  // for unknown commands and was missed for unknown options.
  let positionals: string[];
  let values: { doctor?: boolean; help?: boolean };
  try {
    ({ positionals, values } = parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      options: {
        // `law setup --doctor` inspects the workspace's webhooks instead of running the
        // full flow. It is the only flag that can delete anything, and it deletes only
        // after a per-item confirmation.
        doctor: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(`\n${USAGE}`);
    return 1;
  }

  const command = positionals[0];

  if (values.help || command === 'help' || command === undefined) {
    console.log(USAGE);
    return command === undefined && !values.help ? 1 : 0;
  }

  switch (command) {
    case 'setup':
      return values.doctor ? runDoctor() : runSetupWizard();
    case 'start': {
      const daemon = await bootDaemon();
      // Installed HERE and not inside `bootDaemon`: signal handlers are process-wide
      // state, and a boot that installs them means every integration test that boots a
      // daemon leaves another handler behind on a process they all share.
      //
      // A second SIGINT during shutdown exits immediately (the child escalation ladder
      // can legitimately run 25 seconds), and the next boot's recovery sweep cleans up
      // whatever the interrupted shutdown did not reach.
      installSignalHandlers(daemon);
      console.log(`listening on 127.0.0.1:${daemon.port} -> ${daemon.publicUrl}`);
      // The listening socket keeps the loop alive; this never resolves. `main` returning
      // would set an exit code and let the process fall out from under a live daemon.
      return new Promise<number>(() => undefined);
    }
    case 'status':
      return runStatus();
    case 'watch':
      return runWatch({ ...(positionals[1] !== undefined ? { target: positionals[1] } : {}) });
    case 'say': {
      // Joined rather than requiring quotes: `law say LAW-1 stop and run the tests` is what
      // an operator types. `parseArgs` THROWS on an unknown option (T88), so text starting
      // with a dash needs `--`; USAGE says so.
      const text = positionals.slice(2).join(' ').trim();
      if (positionals[1] === undefined || text.length === 0) {
        console.error('usage: law say <target> <text…>\n');
        console.error(USAGE);
        return 1;
      }
      return runSay({ target: positionals[1], text });
    }
    default:
      console.error(`unknown command: ${command}\n`);
      console.error(USAGE);
      return 1;
  }
}

main().then((code) => {
  process.exitCode = code;
});
