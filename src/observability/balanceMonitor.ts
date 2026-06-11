import type { Config } from '../config/schema.js';
import type { Worker } from '../sapling/pool.js';
import type { Logger } from '../observability/logger.js';
import type { Alerter } from '../observability/alerting.js';

/**
 * Low-gas watchdog. Under the unshield-payment model workers are self-funding — each
 * 1-XTZ fee lands directly on a payment worker's tz1, far above per-op gas — so there is
 * nothing to refill. But a worker can still run low during INITIAL seeding (before it has
 * earned fees) or if the fee is misconfigured below gas, so we periodically read each
 * worker's tz1 and raise a durable alert when it's below LOW_BALANCE_XTZ. The operator
 * then tops up the tz1 (the relay never moves funds itself).
 *
 * Read-only (a balance query), so unlike a real op it does NOT go through the WorkerQueue.
 * Runs on a slow cadence (BALANCE_CHECK_INTERVAL_MS) so a persistently-low worker yields
 * at most one alert per interval, not a stream. Returns a stop() function.
 */
export function startBalanceMonitor(deps: {
  config: Config;
  workers: Worker[];
  logger: Logger;
  alerter: Alerter;
}): () => void {
  const checkAll = (): void => {
    for (const worker of deps.workers) {
      worker.client.tz
        .getBalance(worker.tezosAddress)
        .then((bal) => {
          const balanceXtz = bal.toNumber() / 1_000_000;
          if (balanceXtz < deps.config.LOW_BALANCE_XTZ) {
            deps.alerter.raise({
              kind: 'worker_low_gas',
              message: `Worker ${worker.index} gas ${balanceXtz.toFixed(3)} XTZ is below ${deps.config.LOW_BALANCE_XTZ} XTZ — fund tz1 ${worker.tezosAddress}.`,
              data: { worker: worker.index, tz1: worker.tezosAddress, balanceXtz },
            });
          }
        })
        .catch((e) => deps.logger.warn({ worker: worker.index, err: String(e) }, 'balance check failed'));
    }
  };

  const timer = setInterval(checkAll, deps.config.BALANCE_CHECK_INTERVAL_MS);
  timer.unref(); // don't keep the process alive solely for the watchdog timer
  return () => clearInterval(timer);
}
