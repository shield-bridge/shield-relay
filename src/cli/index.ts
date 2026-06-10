#!/usr/bin/env node
// Installs a global `require` for the SDK's eval('require'). This static import only
// reaches THIS (main) isolate — enough for a bare `node dist/cli/index.js` / global
// `relay` bin launch. The spawned Sapling worker_threads are SEPARATE isolates that
// only a `--import` preload reaches, so `relay start`'s worker still needs the
// NODE_OPTIONS/--import wiring (image ENV, the entrypoint exec, and `npm start`).
import '../runtime/saplingRequireShim.js';
import { Command } from 'commander';
import { start } from './start.js';
import { init } from './init.js';
import { doctor } from './doctor.js';
import { relayStatus } from './status.js';
import { jobsList, jobsShow, jobsRetry, jobsDiscard } from './jobs.js';

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

program
  .command('init')
  .description('Mint a fresh worker pool and print the tz1 addresses to fund')
  .requiredOption('-w, --workers <n>', 'number of workers to mint', (v) => parseInt(v, 10))
  .option('-o, --out <path>', 'pool secret output path', './secrets/pool.json')
  .option('-f, --force', 'overwrite an existing pool secret (DANGER)', false)
  .action(async (opts: { workers: number; out: string; force: boolean }) => {
    try {
      await init({ workers: opts.workers, out: opts.out, force: opts.force });
    } catch (e) {
      console.error('init failed:', e instanceof Error ? e.message : e);
      process.exit(1);
    }
  });

program
  .command('doctor')
  .description('Preflight checks (RPC, contract, worker balances, RAM, DB, port)')
  .action(async () => {
    try {
      await doctor();
    } catch (e) {
      console.error('doctor failed:', e instanceof Error ? e.message : e);
      process.exit(1);
    }
  });

program
  .command('status')
  .description('Health glance at the running relay (liveness, worker gas, queue depth, recent failures)')
  .option('--watch <seconds>', 'refresh every N seconds until Ctrl-C')
  .option('--no-chain', 'skip on-chain gas lookups (store-only, faster)')
  .option('--json', 'machine-readable output')
  .action(async (opts) => {
    try {
      await relayStatus(opts);
    } catch (e) {
      console.error('status failed:', e instanceof Error ? e.message : e);
      process.exit(1);
    }
  });

// `relay jobs` — dead-letter ops. list/show are read-only; retry/discard are offline-only.
const jobs = program.command('jobs').description('Inspect and recover dead-letter work items');
const guard = (fn: () => void): void => {
  try {
    fn();
  } catch (e) {
    console.error('✗', e instanceof Error ? e.message : e);
    process.exit(1);
  }
};

jobs
  .command('list')
  .description('List failed (and optionally stuck) work items — read-only')
  .option('--failed-only', 'only terminal-failed rows (default)')
  .option('--stuck', 'also show queued/running rows')
  .option('--all', 'show every state including done + discarded')
  .option('--state <s>', 'filter to one state (queued|running|done|failed)')
  .option('--kind <k>', 'filter by kind (payment|user_tx)')
  .option('--limit <n>', 'max rows (default 50)')
  .option('--json', 'machine-readable output (payload-free)')
  .action((opts) => guard(() => jobsList(opts)));

jobs
  .command('show <id>')
  .description('Show full detail for a jobId or taskId — read-only')
  .option('--json', 'machine-readable output (payload-free)')
  .action((id, opts) => guard(() => jobsShow(id, opts)));

jobs
  .command('retry [id]')
  .description('Re-arm a failed work item so the next `relay start` resumes it (offline-only)')
  .option('--all', 'retry all failed rows (scope with --kind)')
  .option('--kind <k>', 'restrict to a kind (payment|user_tx)')
  .option('--force', 'retry even a permanently-futile payment failure')
  .option('--dry-run', 'show what would change without writing')
  .option('--json', 'machine-readable output')
  .action((id, opts) => guard(() => jobsRetry(id, opts)));

jobs
  .command('discard [id]')
  .description('Abandon a work item (mark terminal; never deletes; offline-only)')
  .option('--all', 'discard all matching rows (requires --state or --kind)')
  .option('--state <s>', 'scope --all to a state')
  .option('--kind <k>', 'scope to a kind (payment|user_tx)')
  .option('--yes', 'confirm the discard (required to mutate)')
  .option('--dry-run', 'preview only')
  .option('--json', 'machine-readable output')
  .action((id, opts) => guard(() => jobsDiscard(id, opts)));

await program.parseAsync(process.argv);
