import { randomInt, randomUUID } from 'node:crypto';
import type { Config } from '../config/schema.js';
import type { Store } from '../store/index.js';
import type { Worker } from '../sapling/pool.js';
import type { Logger } from '../observability/logger.js';
import type { ContractParams } from '../core/types.js';
import { WorkerQueue } from './workerQueue.js';
import { WsHub } from '../server/wsHub.js';
import { HttpError } from '../server/errors.js';
import { frame } from '../server/statusFrames.js';
import { generateJobSecret, generateMemo, hashJobSecret, checkJobSecret } from '../server/auth.js';
import { broadcastPayment, verifyPaymentMemo } from '../core/payment.js';
import { injectUserTransaction } from '../core/inject.js';
import { readCounter, broadcastAlreadyLanded } from './reconcile.js';

const HEX = /^[0-9a-fA-F]+$/;
const MAX_TXN_HEX = 100_000;

export interface ProcessorDeps {
  config: Config;
  store: Store;
  queue: WorkerQueue;
  workers: Worker[];
  wsHub: WsHub;
  logger: Logger;
}

/**
 * The orchestration layer: maps the three wire endpoints onto durable state +
 * per-worker queue + core chain ops + WS fan-out. Every status transition is
 * persisted (Store) before it is published (WsHub).
 *
 * Crash-safety: the submit endpoints write a durable work_queue row BEFORE the
 * 2xx, and `runTask` is restart-safe — a counter pinned before `.send()` lets a
 * re-hydrated mid-flight task skip a re-broadcast that already landed.
 */
export class Processor {
  constructor(private readonly d: ProcessorDeps) {}

  // ── /get-worker-info ──────────────────────────────────────────────────────
  getWorkerInfo() {
    const n = this.d.workers.length;
    const paymentPoolIndex = randomInt(n);
    const broadcastPoolIndex = n > 1 ? (paymentPoolIndex + 1 + randomInt(n - 1)) % n : paymentPoolIndex;

    const jobId = `job-${randomUUID()}`;
    const memo = generateMemo();
    const jobSecret = generateJobSecret();
    const expiresAt = Math.floor(Date.now() / 1000) + this.d.config.JOB_TTL_SECONDS;

    this.d.store.createJob({
      jobId,
      paymentPoolIndex,
      broadcastPoolIndex,
      memo,
      jobSecretHash: hashJobSecret(jobSecret),
      expiresAt,
    });

    return {
      jobId,
      workerIndex: paymentPoolIndex,
      address: this.d.workers[paymentPoolIndex]!.saplingAddress,
      memo,
      paymentAmount: String(Number(this.d.config.PAYMENT_AMOUNT_MUTEZ) / 1_000_000),
      jobSecret,
    };
  }

  // ── /submit-payment ───────────────────────────────────────────────────────
  submitPayment(jobId: string, jobSecret: string | undefined, payment: ContractParams) {
    const job = this.requireJob(jobId);
    this.assertSecret(jobSecret, job.jobSecretHash);
    if (job.status !== 'info_generated') {
      throw new HttpError(409, `Invalid job status: ${job.status}. Already submitted?`);
    }
    this.validateTxns(payment?.txns);

    const taskId = randomUUID();
    const seq = this.d.store.enqueueWork(
      { taskId, jobId, poolIndex: job.paymentPoolIndex, kind: 'inject_payment', payloadJson: JSON.stringify(payment) },
      'info_generated',
      'queued',
    );
    if (seq === null) throw new HttpError(409, 'Job status changed (concurrent submit).');

    this.dispatch(job.paymentPoolIndex, taskId);
    this.d.wsHub.publish(frame(jobId, 'queued'));
    return { jobId, status: 'queued', message: 'Payment queued for verification.' };
  }

  // ── /submit-user-transaction ──────────────────────────────────────────────
  submitUserTransaction(
    jobId: string,
    jobSecret: string | undefined,
    userTransaction: ContractParams | ContractParams[],
  ) {
    const job = this.requireJob(jobId);
    this.assertSecret(jobSecret, job.jobSecretHash);
    if (job.status === 'completed' || job.status === 'injecting_user_tx') {
      throw new HttpError(409, 'Job already consumed.');
    }
    if (job.status !== 'payment_confirmed') {
      throw new HttpError(409, `Payment not confirmed yet (status: ${job.status}).`);
    }
    const arr = Array.isArray(userTransaction) ? userTransaction : [userTransaction];
    for (const t of arr) this.validateTxns(t?.txns);

    const taskId = randomUUID();
    const seq = this.d.store.enqueueWork(
      { taskId, jobId, poolIndex: job.broadcastPoolIndex, kind: 'inject_user_tx', payloadJson: JSON.stringify(userTransaction) },
      'payment_confirmed',
      'injecting_user_tx',
    );
    if (seq === null) throw new HttpError(409, 'Job already consumed (concurrent submit).');

    this.dispatch(job.broadcastPoolIndex, taskId);
    this.d.wsHub.publish(frame(jobId, 'injecting_user_tx'));
    return { jobId, status: 'injecting_user_tx', message: 'User transaction queued for injection.' };
  }

  // ── task execution (shared by submit + boot re-hydration) ──────────────────
  /** Enqueue a task body onto its worker's serial chain. */
  private dispatch(poolIndex: number, taskId: string): void {
    this.d.queue
      .enqueue(poolIndex, () => this.runTask(taskId))
      .catch((e: unknown) => this.d.logger.error({ taskId, err: String(e) }, 'task crashed'));
  }

  /** Run a durable work item to completion. Restart-safe + idempotent. Public so
   *  boot re-hydration can re-enqueue it on the right worker. */
  async runTask(taskId: string): Promise<void> {
    const work = this.d.store.getWork(taskId);
    if (!work || work.state === 'done' || work.state === 'failed') return;
    if (work.kind === 'inject_payment') return this.runPayment(taskId);
    if (work.kind === 'inject_user_tx') return this.runInject(taskId);
  }

  private async runPayment(taskId: string): Promise<void> {
    const work = this.d.store.getWork(taskId);
    if (!work) return;
    const job = this.d.store.getJob(work.jobId);
    if (!job) return;
    const worker = this.d.workers[work.poolIndex]!;

    try {
      this.d.store.setWorkState(taskId, 'running');
      this.d.store.setJobStatus(job.jobId, 'verifying_payment');
      this.d.wsHub.publish(frame(job.jobId, 'verifying_payment'));

      // Broadcast — unless a crash-interrupted broadcast already landed.
      const landed =
        work.broadcastState !== 'none' &&
        work.pinnedCounter != null &&
        (await broadcastAlreadyLanded(worker.client, worker.tezosAddress, work.pinnedCounter));
      if (!landed) {
        const counter = await readCounter(worker.client, worker.tezosAddress);
        this.d.store.setBroadcasting(taskId, counter); // pin BEFORE send
        const payment = JSON.parse(work.payloadJson) as ContractParams;
        await broadcastPayment(
          worker.client,
          this.d.config.factoryContract,
          payment,
          this.d.config.CONFIRMATIONS_PHASE1,
          (opHash) => {
            this.d.store.setBroadcast(taskId, opHash);
            this.d.store.setJobStatus(job.jobId, 'verifying_payment', { paymentTxHash: opHash });
          },
        );
      }

      if (!(await verifyPaymentMemo(worker.sdk, job.memo, this.d.config.PAYMENT_AMOUNT_MUTEZ))) {
        return this.failPayment(taskId, job.jobId, 'Payment verification failed (memo/amount).');
      }
      // tryConsumeMemo is same-job idempotent → safe to re-run on resume.
      if (!this.d.store.tryConsumeMemo(job.memo, job.jobId)) {
        return this.failPayment(taskId, job.jobId, 'Memo already consumed.');
      }

      this.d.store.completeWork(taskId, job.jobId, 'payment_confirmed');
      this.d.wsHub.publish(frame(job.jobId, 'payment_confirmed'));
      this.d.logger.info({ jobId: job.jobId }, 'payment confirmed');
    } catch (e) {
      this.failPayment(taskId, job.jobId, e instanceof Error ? e.message : 'Payment injection failed.');
    }
  }

  private failPayment(taskId: string, jobId: string, msg: string): void {
    this.d.store.setWorkState(taskId, 'failed');
    this.d.store.setJobStatus(jobId, 'payment_failed', { errorMessage: msg });
    this.d.wsHub.publish(frame(jobId, 'payment_failed', { error: msg }));
    this.d.logger.warn({ jobId, msg }, 'payment failed');
  }

  private async runInject(taskId: string): Promise<void> {
    const work = this.d.store.getWork(taskId);
    if (!work) return;
    const job = this.d.store.getJob(work.jobId);
    if (!job) return;
    const worker = this.d.workers[work.poolIndex]!;

    try {
      this.d.store.setWorkState(taskId, 'running');
      this.d.wsHub.publish(frame(job.jobId, 'injecting_user_tx'));

      const landed =
        work.broadcastState !== 'none' &&
        work.pinnedCounter != null &&
        (await broadcastAlreadyLanded(worker.client, worker.tezosAddress, work.pinnedCounter));

      let opHash: string;
      if (landed) {
        opHash = work.opHash ?? 'recovered-on-restart';
      } else {
        const counter = await readCounter(worker.client, worker.tezosAddress);
        this.d.store.setBroadcasting(taskId, counter); // pin BEFORE send
        const userTransaction = JSON.parse(work.payloadJson) as ContractParams | ContractParams[];
        opHash = await injectUserTransaction(
          worker.client,
          this.d.config.factoryContract,
          userTransaction,
          this.d.config.CONFIRMATIONS_PHASE2,
          (h) => this.d.store.setBroadcast(taskId, h),
        );
      }

      this.d.store.completeWork(taskId, job.jobId, 'completed', opHash);
      this.d.wsHub.publish(frame(job.jobId, 'completed', { opHash }));
      this.d.logger.info({ jobId: job.jobId, opHash }, 'user transaction completed');
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'User transaction injection failed.';
      this.d.store.setWorkState(taskId, 'failed');
      this.d.store.setJobStatus(job.jobId, 'user_tx_failed', { errorMessage: msg });
      this.d.wsHub.publish(frame(job.jobId, 'user_tx_failed', { error: msg }));
      this.d.logger.warn({ jobId: job.jobId, msg }, 'user transaction failed');
    }
  }

  // ── helpers ───────────────────────────────────────────────────────────────
  private requireJob(jobId: string) {
    if (!jobId || typeof jobId !== 'string') throw new HttpError(400, 'Missing jobId.');
    const job = this.d.store.getJob(jobId);
    if (!job) throw new HttpError(404, `Job not found: ${jobId}`);
    return job;
  }

  private assertSecret(provided: string | undefined, expectedHash: string): void {
    const check = checkJobSecret(provided, expectedHash, this.d.config.REQUIRE_JOB_SECRET);
    if (check === 'missing') throw new HttpError(401, 'Missing job secret.');
    if (check === 'mismatch') throw new HttpError(403, 'Invalid job secret.');
  }

  private validateTxns(txns: unknown): void {
    if (!Array.isArray(txns) || txns.length === 0) {
      throw new HttpError(400, 'Transaction must include a non-empty txns array.');
    }
    for (const t of txns) {
      if (typeof t !== 'string' || t.length === 0 || t.length > MAX_TXN_HEX || !HEX.test(t)) {
        throw new HttpError(400, 'Invalid sapling transaction: must be a hex string.');
      }
    }
  }
}
