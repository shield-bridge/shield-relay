import type { Store } from '../store/index.js';
import type { WorkerQueue } from './workerQueue.js';
import type { Processor } from './processor.js';
import type { Logger } from '../observability/logger.js';

/**
 * Boot re-hydration: re-enqueue every non-terminal durable work item onto its
 * worker's serial chain, in (poolIndex, chainSeq) order — re-establishing the
 * sequential-per-worker order across the restart boundary and resuming any
 * paid-but-unfinished job that a crash interrupted.
 *
 * `runTask` is restart-safe (counter-pin reconcile + same-job-idempotent memo
 * consume), so a mid-flight broadcast is reconciled, never blindly re-sent.
 * Returns the number of tasks resumed.
 */
export function rehydrate(
  store: Store,
  queue: WorkerQueue,
  processor: Processor,
  logger: Logger,
): number {
  const pending = store.listNonTerminalWork(); // ordered (poolIndex, chainSeq)
  for (const work of pending) {
    queue
      .enqueue(work.poolIndex, () => processor.runTask(work.taskId))
      .catch((e: unknown) =>
        logger.error({ taskId: work.taskId, err: String(e) }, 'rehydrated task crashed'),
      );
  }
  if (pending.length > 0) {
    logger.info({ count: pending.length }, 're-hydrated pending work after restart');
  }
  return pending.length;
}
