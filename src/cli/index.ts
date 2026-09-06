#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { runDoctor, runSetupWizard } from './wizard/index.js';

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
    case 'start':
      console.log('not yet implemented — run `law setup` first');
      return 0;
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
