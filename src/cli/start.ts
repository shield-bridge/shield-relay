import { join } from 'node:path';
import { loadConfig } from '../config/load.js';
import { createLogger } from '../observability/logger.js';
import { SqliteStore } from '../store/sqlite.js';
import { loadPoolSecrets, buildPool } from '../sapling/pool.js';
import { WorkerQueue } from '../runtime/workerQueue.js';
import { WsHub } from '../server/wsHub.js';
import { Processor } from '../runtime/processor.js';
import { buildServer } from '../server/server.js';

/**
 * `relay start` — wire the whole relay together and listen.
 *
 * P1: SQLite store, build the worker pool (parallelThreads:true), serve the three
 * routes + WS. P2 adds boot re-hydration + counter-pin reconcile + the gas-refill
 * loop + full drain; this start path is the seam they slot into.
 */
export async function start(): Promise<void> {
  const cfg = loadConfig();
  const logger = createLogger(cfg);
  logger.info(
    { network: cfg.TEZOS_NETWORK, workers: cfg.WORKER_COUNT, requireJobSecret: cfg.REQUIRE_JOB_SECRET },
    'shield-relay starting',
  );

  // P1: SQLite only. Postgres (DATABASE_URL) adapter is P4.
  const store = new SqliteStore(join(cfg.DATA_DIR, 'relay.db'));
  store.init();

  const secrets = loadPoolSecrets(cfg);
  logger.info('building worker pool — loading sapling params, may take a moment…');
  const workers = await buildPool(cfg, secrets);
  logger.info(
    { workers: workers.map((w) => ({ index: w.index, tz1: w.tezosAddress })) },
    'worker pool ready',
  );

  const queue = new WorkerQueue();
  const wsHub = new WsHub(store, cfg.REQUIRE_JOB_SECRET);
  const processor = new Processor({ config: cfg, store, queue, workers, wsHub, logger });

  let ready = false;
  const app = await buildServer({ processor, wsHub, isReady: () => ready });
  await app.listen({ port: cfg.PORT, host: '0.0.0.0' });
  ready = true;
  logger.info({ port: cfg.PORT }, 'shield-relay listening');

  const shutdown = async (sig: string): Promise<void> => {
    logger.info({ sig }, 'shutting down');
    ready = false;
    try {
      await app.close();
      await queue.drain();
      store.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}
