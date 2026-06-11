import { join } from 'node:path';
import { loadConfig } from '../config/load.js';
import { createLogger } from '../observability/logger.js';
import { SqliteStore } from '../store/sqlite.js';
import { loadPoolSecrets, buildPool } from '../sapling/pool.js';
import { WorkerQueue } from '../runtime/workerQueue.js';
import { WsHub } from '../server/wsHub.js';
import { Processor } from '../runtime/processor.js';
import { buildServer } from '../server/server.js';
import { buildRelayInfo } from '../server/info.js';
import { rehydrate } from '../runtime/rehydrate.js';
import { ensureWorkersRevealed } from '../core/reveal.js';
import { startBalanceMonitor } from '../observability/balanceMonitor.js';
import { acquireInstanceLock } from '../runtime/instanceLock.js';
import { Metrics } from '../observability/metrics.js';
import { Alerter } from '../observability/alerting.js';

/**
 * `relay start` — wire the whole relay together and listen.
 *
 * P1: SQLite store, build the worker pool (parallelThreads:true), serve the three
 * routes + WS. P2 adds boot re-hydration + counter-pin reconcile + the low-gas
 * watchdog + full drain; this start path is the seam they slot into.
 */
export async function start(): Promise<void> {
  const cfg = loadConfig();
  const logger = createLogger(cfg);
  logger.info(
    { network: cfg.TEZOS_NETWORK, workers: cfg.WORKER_COUNT, requireJobSecret: cfg.REQUIRE_JOB_SECRET },
    'shield-relay starting',
  );

  // The schedule prices per-tx, but legacy (no-txCount) clients still pay flat — if
  // their batch isn't capped, the griefing vector the schedule exists to close stays
  // open for the common case. Warn so the operator wires LEGACY_FLAT_MAX_TXS.
  if (cfg.fee.perTxMutez > 0n && cfg.legacyFlatMaxTxs === 0) {
    logger.warn(
      'Fee schedule active but LEGACY_FLAT_MAX_TXS=0: legacy clients can still submit large batches at the flat fee. Set LEGACY_FLAT_MAX_TXS (e.g. 5) to close it.',
    );
  }

  // P1: SQLite only. Postgres (DATABASE_URL) adapter is P4.
  const store = new SqliteStore(join(cfg.DATA_DIR, 'relay.db'));
  store.init();

  // Refuse to start if another instance holds this data dir (would corrupt state).
  const lock = acquireInstanceLock(store, logger);
  const metrics = new Metrics();
  const alerter = new Alerter(store, cfg, logger);

  const secrets = loadPoolSecrets(cfg);

  // Workers are pure tz1 broadcasters now (no Sapling SDK, no proving params).
  const workers = await buildPool(cfg, secrets);
  logger.info(
    { workers: workers.map((w) => ({ index: w.index, tz1: w.tezosAddress })) },
    'worker pool ready',
  );

  // Turnkey: reveal any unrevealed worker keys BEFORE serving, so the first relayed op
  // never fails on a bundled-reveal gas batch. No-op once workers are revealed.
  await ensureWorkersRevealed(workers, logger);

  const queue = new WorkerQueue();
  const wsHub = new WsHub(store, cfg.REQUIRE_JOB_SECRET);
  const processor = new Processor({ config: cfg, store, queue, workers, wsHub, logger, metrics });

  // Resume any paid-but-unfinished work from before a restart (counter-pin safe).
  rehydrate(store, queue, processor, logger);

  let ready = false;
  const app = await buildServer({
    processor,
    wsHub,
    metrics,
    info: buildRelayInfo(cfg),
    metricsToken: cfg.METRICS_TOKEN,
    rateLimitRpm: cfg.RATE_LIMIT_RPM,
    maxConnections: cfg.MAX_CONNECTIONS,
    wsHeartbeatMs: cfg.WS_HEARTBEAT_MS,
    trustProxy: cfg.TRUST_PROXY,
    isReady: () => ready,
  });
  await app.listen({ port: cfg.PORT, host: '0.0.0.0' });
  ready = true;
  logger.info({ port: cfg.PORT }, 'shield-relay listening');

  const stopMonitor = startBalanceMonitor({ config: cfg, workers, logger, alerter });
  const stopAlerts = alerter.startDrainLoop();
  const metricsTimer = setInterval(() => {
    for (const w of workers) {
      metrics.queueDepth.set({ worker: String(w.index) }, queue.queueDepth(w.index));
      w.client.tz
        .getBalance(w.tezosAddress)
        .then((b) => metrics.gasBalance.set({ worker: String(w.index) }, b.toNumber() / 1_000_000))
        .catch(() => undefined);
    }
  }, 30_000);
  metricsTimer.unref();

  const shutdown = async (sig: string): Promise<void> => {
    logger.info({ sig }, 'draining and shutting down');
    ready = false; // /readyz → 503; stop accepting new work
    stopMonitor();
    stopAlerts();
    clearInterval(metricsTimer);
    try {
      await app.close(); // stop new HTTP + WS
      await queue.drain(); // let in-flight per-worker tasks finish
      lock.release();
      store.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}
