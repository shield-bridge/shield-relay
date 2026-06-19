import type { Config } from '../config/schema.js';
import type { Worker } from '../sapling/pool.js';
import type { Logger } from '../observability/logger.js';
import type { Alerter } from '../observability/alerting.js';

/** What the watchdog should do for a worker on a given check. */
export type LowGasAction = 'alert' | 'recovered' | 'none';

/**
 * Edge-triggered + throttled decision for the low-gas watchdog. Pure so it can be unit
 * tested without timers or RPC.
 *
 * - `lastAlertAt` is the epoch-ms of the most recent alert for this worker, or null if it
 *   is not currently in the low state (never alerted, or recovered since).
 * - returns `alert` on the first crossing below the threshold and again only once
 *   `realertMs` has elapsed since the last alert (so a persistently-low worker doesn't
 *   re-alert every check); `recovered` when a previously-low worker is back above; else
 *   `none`.
 */
export function lowGasAction(
  isLow: boolean,
  lastAlertAt: number | null,
  now: number,
  realertMs: number,
): LowGasAction {
  if (isLow) {
    if (lastAlertAt === null) return 'alert'; // first crossing below the threshold
    return now - lastAlertAt >= realertMs ? 'alert' : 'none'; // throttled reminder
  }
  return lastAlertAt === null ? 'none' : 'recovered'; // crossed back above
}

/**
 * Low-gas watchdog. Under the unshield-payment model workers are self-funding — each
 * fee lands directly on a payment worker's tz1, far above per-op gas — so there is
 * nothing to refill. But a worker can still run low during INITIAL seeding (before it has
 * earned fees) or if the fee is misconfigured below gas, so we periodically read each
 * worker's tz1 and alert when it's below LOW_BALANCE_XTZ. The operator then tops up the
 * tz1 (the relay never moves funds itself).
 *
 * Edge-triggered + throttled: a worker that crosses below the threshold raises ONE alert,
 * then stays quiet while it remains low — re-alerting at most once per LOW_BALANCE_REALERT_MS
 * — and logs once (info) when it recovers. So a persistently-low balance no longer spams a
 * `raise()` (log + durable webhook) on every check. State is in-memory, so a restart
 * re-surfaces a still-low worker once (intentional).
 *
 * Read-only (a balance query), so unlike a real op it does NOT go through the WorkerQueue.
 * Returns a stop() function.
 */
export function startBalanceMonitor(deps: {
  config: Config;
  workers: Worker[];
  logger: Logger;
  alerter: Alerter;
}): () => void {
  // workerIndex → epoch-ms of the last low-gas alert; absent ⟹ not currently low.
  const lastAlertAt = new Map<number, number>();

  const checkAll = (): void => {
    for (const worker of deps.workers) {
      worker.client.tz
        .getBalance(worker.tezosAddress)
        .then((bal) => {
          const balanceXtz = bal.toNumber() / 1_000_000;
          const isLow = balanceXtz < deps.config.LOW_BALANCE_XTZ;
          const prev = lastAlertAt.get(worker.index) ?? null;
          const action = lowGasAction(isLow, prev, Date.now(), deps.config.LOW_BALANCE_REALERT_MS);

          if (action === 'alert') {
            lastAlertAt.set(worker.index, Date.now());
            deps.alerter.raise({
              kind: 'worker_low_gas',
              message: `Worker ${worker.index} gas ${balanceXtz.toFixed(3)} XTZ is below ${deps.config.LOW_BALANCE_XTZ} XTZ — fund tz1 ${worker.tezosAddress}.`,
              data: { worker: worker.index, tz1: worker.tezosAddress, balanceXtz },
            });
          } else if (action === 'recovered') {
            lastAlertAt.delete(worker.index);
            deps.logger.info(
              { worker: worker.index, tz1: worker.tezosAddress, balanceXtz },
              'worker gas recovered above threshold',
            );
          }
        })
        .catch((e) => deps.logger.warn({ worker: worker.index, err: String(e) }, 'balance check failed'));
    }
  };

  const timer = setInterval(checkAll, deps.config.BALANCE_CHECK_INTERVAL_MS);
  timer.unref(); // don't keep the process alive solely for the watchdog timer
  return () => clearInterval(timer);
}
