import { join } from 'node:path';
import { loadConfig } from '../config/load.js';
import { createLogger } from '../observability/logger.js';
import { SqliteStore } from '../store/sqlite.js';
import { loadPoolSecrets, buildPool } from '../sapling/pool.js';
import { WorkerQueue } from '../runtime/workerQueue.js';
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
 * SQLite store, build the worker pool (pure tz1 broadcasters — no proving), serve
 * the HTTP routes (status via GET /status polling), boot re-hydration + counter-pin
 * reconcile, the low-gas watchdog, and a bounded SIGTERM drain (DRAIN_TIMEOUT_MS).
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

  // SQLite store (better-sqlite3, local FS). A networked/HA backend may come later.
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
  const processor = new Processor({ config: cfg, store, queue, workers, logger, metrics });

  // Resume any paid-but-unfinished work from before a restart (counter-pin safe).
  rehydrate(store, queue, processor, logger);

  let ready = false;
  const app = await buildServer({
    processor,
    metrics,
    info: buildRelayInfo(cfg),
    metricsToken: cfg.METRICS_TOKEN,
    rateLimitRpm: cfg.RATE_LIMIT_RPM,
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
      await app.close(); // stop new HTTP
      // Let in-flight per-worker tasks finish, but cap the wait at DRAIN_TIMEOUT_MS so a
      // stuck task can't block past Docker's stop_grace_period. Hard-kill is safe: the
      // counter-pinned work_queue lets the next boot's rehydrate finish any in-flight op.
      await Promise.race([
        queue.drain(),
        new Promise((resolve) => setTimeout(resolve, cfg.DRAIN_TIMEOUT_MS)),
      ]);
      lock.release();
      store.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}
