#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { runDoctor, runSetupWizard } from './wizard/index.js';
import { bootDaemon, installSignalHandlers } from './daemon.js';

async function main(): Promise<number> {
  const { positionals, values } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      // `law setup --doctor` inspects the workspace's webhooks instead of running the
      // full flow. It is the only flag that can delete anything, and it deletes only
      // after a per-item confirmation.
      doctor: { type: 'boolean', default: false },
    },
  });

  const command = positionals[0];

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
      console.log('not yet implemented — run `law setup` first');
      return 0;
    default:
      console.log('usage: law <setup [--doctor]|start|status>');
      return 1;
  }
}

main().then((code) => {
  process.exitCode = code;
});
