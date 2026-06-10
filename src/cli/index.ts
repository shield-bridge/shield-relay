#!/usr/bin/env node
import { Command } from 'commander';
import { start } from './start.js';

const program = new Command();
program
  .name('relay')
  .description('Shield Bridge privacy relay — broadcast Sapling transactions for a fee, anonymously.')
  .version('0.0.0');

program
  .command('start')
  .description('Run the relay server')
  .action(async () => {
    try {
      await start();
    } catch (e) {
      console.error('Failed to start:', e instanceof Error ? e.message : e);
      process.exit(1);
    }
  });

// `relay init` (keygen) and `relay doctor` (preflight) land in the next increment.

await program.parseAsync(process.argv);
