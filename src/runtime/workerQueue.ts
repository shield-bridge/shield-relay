/**
 * WorkerQueue — the load-bearing SEQUENTIAL-PER-WORKER invariant.
 *
 * One single-concurrency promise-chain mutex per PHYSICAL tz1 (pool index). Every
 * operation that touches a worker's tz1 account counter or its Sapling notes —
 * Phase-1 payment injection and Phase-2 broadcast (when that tz1 is the broadcast
 * worker) — MUST be enqueued here on that worker's poolIndex.
 *
 * Because a single process owns all workers, this is a strictly stronger
 * guarantee than the AWS SQS-FIFO MessageGroupId=worker-N: there is no
 * cross-process race window, so two ops can never concurrently select the same
 * notes or reuse the same counter (the double-spend the chain rejects).
 *
 * Keyed on the PHYSICAL tz1 (pool index), NOT a payment/broadcast role — so a
 * single tz1 serving as one job's payment worker and another's broadcast worker
 * is still strictly serialized.
 *
 * NOTE: cross-WORKER concurrency (different pool indices) is only safe because
 * each worker's SDK runs with parallelThreads:true (isolated worker_threads
 * context). With parallelThreads:false the SDK shares a process-global singleton
 * sapling core and concurrent workers would corrupt each other's keys — see
 * DESIGN.md §1.
 */
export class WorkerQueue {
  private readonly chains = new Map<number, Promise<unknown>>();
  private readonly depth = new Map<number, number>();

  /**
   * Append `task` to `poolIndex`'s serial chain. The returned promise settles
   * with the task's own result/error; the chain tail never rejects, so a failed
   * task cannot poison subsequent tasks for that worker.
   */
  enqueue<T>(poolIndex: number, task: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(poolIndex) ?? Promise.resolve();
    this.depth.set(poolIndex, (this.depth.get(poolIndex) ?? 0) + 1);

    const run = async (): Promise<T> => {
      try {
        return await task();
      } finally {
        this.depth.set(poolIndex, (this.depth.get(poolIndex) ?? 1) - 1);
      }
    };

    // Run after prev settles, regardless of whether prev resolved or rejected.
    const result = prev.then(run, run);
    // Store a non-rejecting tail so the next enqueue chains cleanly.
    this.chains.set(
      poolIndex,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
  }

  /** Number of tasks queued + running for a worker (for /metrics + drain). */
  queueDepth(poolIndex: number): number {
    return this.depth.get(poolIndex) ?? 0;
  }

  /** Total in-flight across all workers. */
  totalDepth(): number {
    let sum = 0;
    for (const d of this.depth.values()) sum += d;
    return sum;
  }

  /** Resolve once every currently-queued task on every worker has settled. */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.chains.values()]);
  }
}
