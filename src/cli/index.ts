#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { runDoctor, runSetupWizard } from './wizard/index.js';
import { bootDaemon } from './daemon.js';

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
      // Signal handling, drain and the reverse-order shutdown land in plan 05; the
      // listening socket is what keeps the process alive until then.
      const daemon = await bootDaemon();
      console.log(`listening on 127.0.0.1:${daemon.port} -> ${daemon.publicUrl}`);
      return 0;
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
