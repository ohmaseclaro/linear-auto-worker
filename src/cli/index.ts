#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { runSetupWizard } from './wizard/index.js';

async function main(): Promise<number> {
  const { positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
  });

  const command = positionals[0];

  switch (command) {
    case 'setup':
      return runSetupWizard();
    case 'start':
      console.log('not yet implemented — run `law setup` first');
      return 0;
    case 'status':
      console.log('not yet implemented — run `law setup` first');
      return 0;
    default:
      console.log('usage: law <setup|start|status>');
      return 1;
  }
}

main().then((code) => {
  process.exitCode = code;
});
