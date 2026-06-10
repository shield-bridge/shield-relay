import type { Config } from '../config/schema.js';
import type { WorkerQueue } from '../runtime/workerQueue.js';
import type { Worker } from '../sapling/pool.js';
import type { Logger } from '../observability/logger.js';
import type { Alerter } from '../observability/alerting.js';
import { refillWorkerGas } from '../core/gasRefill.js';

/**
 * Periodic self-funding. Each worker's gas-refill is enqueued THROUGH that
 * worker's per-worker queue, so it can never overlap a paid job on the same tz1's
 * notes/counter (the sequential-per-worker invariant covers gas-refill too).
 * Returns a stop() function.
 */
export function startGasRefillLoop(deps: {
  config: Config;
  queue: WorkerQueue;
  workers: Worker[];
  logger: Logger;
  alerter: Alerter;
}): () => void {
  const checkAll = (): void => {
    for (const worker of deps.workers) {
      deps.queue
        .enqueue(worker.index, async () => {
          try {
            const r = await refillWorkerGas(worker, deps.config.GAS_REFILL_THRESHOLD_XTZ);
            if (r.refilled) {
              deps.logger.info({ worker: worker.index, amountXtz: r.amountXtz }, 'gas refilled');
            } else if (
              r.balanceXtz < deps.config.GAS_REFILL_THRESHOLD_XTZ &&
              r.reason?.includes('sapling')
            ) {
              // Below threshold AND nothing to self-fund from → the worker will run dry.
              deps.alerter.raise({
                kind: 'worker_low_gas',
                message: `Worker ${worker.index} gas ${r.balanceXtz.toFixed(3)} XTZ with no sapling balance to self-fund — fund tz1 ${worker.tezosAddress}.`,
                data: { worker: worker.index, tz1: worker.tezosAddress, balanceXtz: r.balanceXtz },
              });
            }
          } catch (e) {
            deps.logger.warn({ worker: worker.index, err: String(e) }, 'gas refill failed');
            deps.alerter.raise({
              kind: 'gas_refill_failed',
              message: `Gas refill for worker ${worker.index} failed: ${e instanceof Error ? e.message : String(e)}`,
              data: { worker: worker.index },
            });
          }
        })
        .catch(() => undefined);
    }
  };

  const timer = setInterval(checkAll, deps.config.GAS_REFILL_INTERVAL_MS);
  timer.unref(); // don't keep the process alive solely for the refill timer
  return () => clearInterval(timer);
}
