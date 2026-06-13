import { randomInt, randomUUID } from 'node:crypto';
import type { Config } from '../config/schema.js';
import type { Store } from '../store/index.js';
import type { Worker } from '../sapling/pool.js';
import type { Logger } from '../observability/logger.js';
import type { Metrics } from '../observability/metrics.js';
import type { ContractParams } from '../core/types.js';
import { WorkerQueue } from './workerQueue.js';
import { HttpError } from '../server/errors.js';
import { frame, type StatusFrame } from '../server/statusFrames.js';
import { toWireStatus } from '../core/jobs.js';
import { generateJobSecret, generateMemo, hashJobSecret, checkJobSecret } from '../server/auth.js';
import { broadcastPayment, verifyPaymentUnshield, verifyPaymentLanded, verifyPaymentLandedByScan, paymentDigest } from '../core/payment.js';
import { injectUserTransaction } from '../core/inject.js';
import { quoteFee, checkSubmittedTxCount } from '../core/feeSchedule.js';
import { readCounter, broadcastAlreadyLanded, classifyTaskError } from './reconcile.js';

const HEX = /^[0-9a-fA-F]+$/;
const MAX_TXN_HEX = 100_000;
const MAX_TX_COUNT = 256; // sanity bound on a fee quote request
// Hard backstop on sapling txns the relay will inject in ONE Phase-2 op, independent
// of the fee config. The client's BATCH_MAX_ITEMS is 10; this leaves headroom for
// note-management splits while bounding worst-case storage-burn loss from abuse.
const MAX_INJECT_TXS = 32;
// How many recent blocks the resume path scans for a broadcast payment op's hash to
// recover its applied-status (we don't persist the inclusion level). Generous for a
// prompt restart; the scan stops at the first match so the typical cost is 1-2 blocks.
const RESUME_SCAN_DEPTH = 60;
// Post-broadcast auto-reconcile budget. An UNKNOWN error AFTER a broadcast (e.g. an RPC
// blip during the applied-check) must never terminal-fail the job — the op may have
// landed. We re-enqueue to reconcile from chain state (the `landed` branch), bounded so
// a sustained outage doesn't spin forever; after the cap the task is PARKED (left
// non-terminal + the job in-progress) so a restart's rehydrate or `relay jobs retry`
// finishes it — it is never flipped to *_failed. See classifyTaskError.
const MAX_POST_BROADCAST_RECONCILE_TRIES = 8;
const RECONCILE_RETRY_DELAY_MS = 4000;

export interface ProcessorDeps {
  config: Config;
  store: Store;
  queue: WorkerQueue;
  workers: Worker[];
  logger: Logger;
  metrics: Metrics;
}

/**
 * The orchestration layer: maps the three wire endpoints onto durable state +
 * per-worker queue + core chain ops. Every status transition is persisted to the
 * Store; the client reads them by polling GET /status (the single status transport).
 *
 * Crash-safety: the submit endpoints write a durable work_queue row BEFORE the
 * 2xx, and `runTask` is restart-safe — a counter pinned before `.send()` lets a
 * re-hydrated mid-flight task skip a re-broadcast that already landed.
 */
export class Processor {
  constructor(private readonly d: ProcessorDeps) {}

  // In-memory count of post-broadcast auto-reconcile re-enqueues per task (bounds the
  // retry loop without a schema change; resets on restart, where rehydrate gives a fresh
  // budget). Cleared once the task settles.
  private readonly reconcileTries = new Map<string, number>();

  // ── /get-worker-info ──────────────────────────────────────────────────────
  getWorkerInfo(txCountRaw?: unknown) {
    const txCount = this.parseTxCount(txCountRaw);
    const n = this.d.workers.length;
    const paymentPoolIndex = randomInt(n);
    const broadcastPoolIndex = n > 1 ? (paymentPoolIndex + 1 + randomInt(n - 1)) % n : paymentPoolIndex;

    const jobId = `job-${randomUUID()}`;
    // Vestigial per-job token. The unshield-payment protocol uses NO memo (an unshield
    // can't carry one); this only satisfies the legacy `jobs.memo NOT NULL` column on
    // pre-release DBs and is never returned on the wire or used in verification.
    const memo = generateMemo();
    const jobSecret = generateJobSecret();
    const expiresAt = Math.floor(Date.now() / 1000) + this.d.config.JOB_TTL_SECONDS;

    // txCount present → scheduled quote; absent → legacy flat (PAYMENT_AMOUNT). The
    // quote is BINDING and durable: Phase 1 verifies against it (restart-safe).
    const quotedFeeMutez =
      txCount == null ? this.d.config.PAYMENT_AMOUNT_MUTEZ : quoteFee(txCount, this.d.config.fee);

    this.d.store.createJob({
      jobId,
      paymentPoolIndex,
      broadcastPoolIndex,
      memo,
      jobSecretHash: hashJobSecret(jobSecret),
      expiresAt,
      quotedFeeMutez: Number(quotedFeeMutez),
      quotedTxCount: txCount ?? null,
      legacyQuote: txCount == null,
    });

    return {
      jobId,
      workerIndex: paymentPoolIndex,
      // The worker's PUBLIC tz1: the client builds an unshield of the fee to it, and
      // the relay verifies that payout (no memo, no shielded transfer). `paymentMode`
      // lets a client distinguish this from a legacy shielded-transfer relay whose
      // `address` is a zet1 sapling address.
      address: this.d.workers[paymentPoolIndex]!.tezosAddress,
      paymentMode: 'unshield' as const,
      paymentAmount: String(Number(quotedFeeMutez) / 1_000_000), // the QUOTED amount
      quotedTxCount: txCount ?? null,
      // Lets a schedule-aware client preview fees before building a batch.
      feeSchedule: {
        baseMutez: Number(this.d.config.fee.baseMutez),
        perTxMutez: Number(this.d.config.fee.perTxMutez),
        quantumMutez: Number(this.d.config.fee.quantumMutez),
      },
      jobSecret,
    };
  }

  // ── GET /status/:jobId ─────────────────────────────────────────────────────
  /**
   * Read-only status, jobSecret-gated — THE status transport the client polls. An
   * unauthorized or unknown jobId gets `not_found` (revealing nothing more), and a
   * pre-payment `info_generated` job is also `not_found` on the wire (that internal
   * state is never exposed).
   */
  getStatus(jobId: string, jobSecret: string | undefined): StatusFrame {
    const job = this.d.store.getJob(jobId);
    const check = checkJobSecret(jobSecret, job?.jobSecretHash, this.d.config.REQUIRE_JOB_SECRET);
    if (check !== 'ok') return frame(jobId, 'not_found', { error: 'unauthorized' });
    if (!job) return frame(jobId, 'not_found');
    const wire = toWireStatus(job.status);
    if (!wire) return frame(jobId, 'not_found');
    return frame(jobId, wire, {
      opHash: job.userTxHash ?? undefined,
      error: job.errorMessage ?? undefined,
    });
  }

  private parseTxCount(raw: unknown): number | undefined {
    if (raw === undefined || raw === null) return undefined; // legacy: no quote requested
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > MAX_TX_COUNT) {
      throw new HttpError(400, `Invalid txCount: must be an integer in [1, ${MAX_TX_COUNT}].`);
    }
    return raw;
  }

  // ── /submit-payment ───────────────────────────────────────────────────────
  submitPayment(jobId: string, jobSecret: string | undefined, payment: ContractParams) {
    const job = this.requireJob(jobId);
    this.assertSecret(jobSecret, job.jobSecretHash);
    if (job.status !== 'info_generated') {
      throw new HttpError(409, `Invalid job status: ${job.status}. Already submitted?`);
    }
    // A legitimate Phase-1 payment is EXACTLY one unshield to the worker's tz1
    // (client: generatePaymentParams → one tx). Capping at 1 stops a griefer from
    // stuffing extra sapling txns into the payment for the relay to broadcast at
    // storage-burn cost while only the worker-bound output clears verification.
    this.validateTxns(payment?.txns, 1);

    const taskId = randomUUID();
    const seq = this.d.store.enqueueWork(
      { taskId, jobId, poolIndex: job.paymentPoolIndex, kind: 'inject_payment', payloadJson: JSON.stringify(payment) },
      'info_generated',
      'queued',
    );
    if (seq === null) throw new HttpError(409, 'Job status changed (concurrent submit).');

    this.dispatch(job.paymentPoolIndex, taskId);
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
    for (const t of arr) this.validateTxns(t?.txns, MAX_INJECT_TXS);

    const actualTxCount = arr.reduce((acc, t) => acc + (Array.isArray(t?.txns) ? t.txns.length : 0), 0);
    // Hard absolute backstop, independent of fee config (stops a cost-bomb even on
    // a dark/legacy relay with no economic cap configured).
    if (actualTxCount > MAX_INJECT_TXS) {
      throw new HttpError(400, `Batch too large: ${actualTxCount} sapling txns exceeds the ${MAX_INJECT_TXS} hard limit.`);
    }

    // Enforce the paid fee covers the submitted size — BEFORE injection, so a
    // quote-1-submit-10 dodge is rejected without spending the relay's gas. The
    // fee was already paid (Phase 1), so a too-low quote forfeits it (FEE_SCHEDULE §3.3).
    const check = checkSubmittedTxCount(
      actualTxCount,
      { legacyQuote: Boolean(job.legacyQuote), quotedTxCount: job.quotedTxCount },
      this.d.config.legacyFlatMaxTxs,
    );
    if (!check.ok) throw new HttpError(402, check.reason);

    const taskId = randomUUID();
    const seq = this.d.store.enqueueWork(
      { taskId, jobId, poolIndex: job.broadcastPoolIndex, kind: 'inject_user_tx', payloadJson: JSON.stringify(userTransaction) },
      'payment_confirmed',
      'injecting_user_tx',
    );
    if (seq === null) throw new HttpError(409, 'Job already consumed (concurrent submit).');

    this.dispatch(job.broadcastPoolIndex, taskId);
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

      const payment = JSON.parse(work.payloadJson) as ContractParams;

      // Skip the gate + broadcast if a crash-interrupted broadcast already landed:
      // it only reaches that state AFTER passing this same gate in a prior life.
      const landed =
        work.broadcastState !== 'none' &&
        work.pinnedCounter != null &&
        (await broadcastAlreadyLanded(worker.client, worker.tezosAddress, work.pinnedCounter));

      // Binding fee this payment must clear (legacy or scheduled quote; the fallback
      // covers a pre-fee-schedule job row with a null quote). Needed by both branches.
      const expectedMutez = BigInt(job.quotedFeeMutez ?? Number(this.d.config.PAYMENT_AMOUNT_MUTEZ));

      if (!landed) {
        // ── THE FIREWALL: verify BEFORE broadcast ─────────────────────────────
        // Simulate the submitted op and require it unshields >= the binding fee to
        // THIS worker's own tz1. An op that pays anyone else (or pays nothing) is
        // rejected here, having spent zero gas — a dry run, not a broadcast. This is
        // what stops a hijacker getting the relay to inject an op of their choosing
        // for free.
        const { ok, receivedMutez } = await verifyPaymentUnshield(
          worker.client,
          this.d.config.factoryContract,
          payment,
          worker.tezosAddress,
          expectedMutez,
        );
        if (!ok) {
          return this.failPayment(
            taskId,
            job.jobId,
            `Payment verification failed: unshield pays ${receivedMutez} mutez to the worker, need >= ${expectedMutez}.`,
          );
        }

        // Atomic replay guard — consume the exact payment bytes BEFORE broadcast, so
        // two concurrent jobs race on this insert (not on the chain). Same-job
        // idempotent → safe to re-run on a crash-resume that didn't yet broadcast.
        if (!this.d.store.tryConsumePaymentDigest(paymentDigest(payment), job.jobId)) {
          this.d.metrics.paymentReplayRejected.inc();
          return this.failPayment(taskId, job.jobId, 'Payment already consumed (replay).');
        }

        const stopTimer = this.d.metrics.broadcast.startTimer({ kind: 'payment' });
        const counter = await readCounter(worker.client, worker.tezosAddress);
        this.d.store.setBroadcasting(taskId, counter); // pin BEFORE send
        const { hash, level } = await broadcastPayment(
          worker.client,
          this.d.config.factoryContract,
          payment,
          this.d.config.CONFIRMATIONS_PHASE1,
          (opHash) => {
            this.d.store.setBroadcast(taskId, opHash);
            this.d.store.setJobStatus(job.jobId, 'verifying_payment', { paymentTxHash: opHash });
          },
        );
        stopTimer();

        // Post-confirmation applied-check — closes the proof-malleability race. The
        // pre-broadcast simulation can't see a same-note double-spend that two workers
        // both pass; the LOSER lands on-chain as `failed`. Require the op actually
        // applied AND paid the worker before flipping the job to confirmed.
        const onChain = await verifyPaymentLanded(worker.client, hash, level, worker.tezosAddress, expectedMutez);
        if (!onChain.ok) {
          return this.failPayment(
            taskId,
            job.jobId,
            `Payment op ${hash} did not apply / underpaid on-chain (${onChain.receivedMutez} mutez to the worker, need >= ${expectedMutez}).`,
          );
        }
      } else {
        // RESUME after a crash in the send→confirmation window: the op advanced the
        // counter (landed) but was never applied-checked in its prior life. A malleable
        // same-note loser lands as `failed`, so recover its status by scanning recent
        // blocks for the op hash before confirming (we don't persist the level; the op is
        // recent after a prompt restart). Not found in the window (long downtime) ⟹ accept
        // with a log — the residual then needs an active attack AND a long outage.
        if (work.opHash) {
          const scanned = await verifyPaymentLandedByScan(
            worker.client,
            work.opHash,
            worker.tezosAddress,
            expectedMutez,
            RESUME_SCAN_DEPTH,
          );
          if (scanned.checked && !scanned.ok) {
            return this.failPayment(
              taskId,
              job.jobId,
              `Resumed payment op ${work.opHash} did not apply / underpaid on-chain (${scanned.receivedMutez} mutez to the worker, need >= ${expectedMutez}).`,
            );
          }
          if (!scanned.checked) {
            this.d.logger.warn(
              { jobId: job.jobId, opHash: work.opHash },
              'resumed payment op not found in scan window — accepting (deep-downtime residual)',
            );
          }
        }
      }

      this.reconcileTries.delete(taskId);
      this.d.store.completeWork(taskId, job.jobId, 'payment_confirmed');
      this.d.metrics.jobs.inc({ status: 'payment_confirmed' });
      this.d.logger.info({ jobId: job.jobId }, 'payment confirmed');
    } catch (e) {
      // UNKNOWN error: terminal-fail only if nothing was broadcast; otherwise reconcile
      // (the broadcast may have landed — never report a false payment_failed).
      this.onTaskError('inject_payment', taskId, job.jobId, work.poolIndex, e);
    }
  }

  /** Mark a payment terminally failed for a KNOWN failure (verification / applied-check
   *  said no). Distinct from onTaskError, which handles UNKNOWN thrown errors. */
  private failPayment(taskId: string, jobId: string, msg: string): void {
    this.reconcileTries.delete(taskId);
    this.d.store.setWorkState(taskId, 'failed');
    this.d.store.setJobStatus(jobId, 'payment_failed', { errorMessage: msg });
    this.d.metrics.jobs.inc({ status: 'payment_failed' });
    this.d.logger.warn({ jobId, msg }, 'payment failed');
  }

  /**
   * Handle an UNKNOWN thrown error from a payment/inject task. Pre-broadcast → terminal
   * fail. Post-broadcast → never terminal-fail (the op may have landed): re-enqueue to
   * reconcile from chain state, bounded, then park (leave non-terminal + recoverable).
   * This is the relay mirror of the Shield Bridge serverless injector's fund-safety fix.
   */
  private onTaskError(
    kind: 'inject_payment' | 'inject_user_tx',
    taskId: string,
    jobId: string,
    poolIndex: number,
    err: unknown,
  ): void {
    const msg = err instanceof Error ? err.message : 'task failed';
    const failStatus = kind === 'inject_user_tx' ? 'user_tx_failed' : 'payment_failed';
    const broadcastState = this.d.store.getWork(taskId)?.broadcastState ?? 'none';
    const tries = this.reconcileTries.get(taskId) ?? 0;
    const action = classifyTaskError(broadcastState, tries, MAX_POST_BROADCAST_RECONCILE_TRIES);

    if (action === 'fail') {
      // Nothing was broadcast → genuine terminal failure.
      this.reconcileTries.delete(taskId);
      this.d.store.setWorkState(taskId, 'failed');
      this.d.store.setJobStatus(jobId, failStatus, { errorMessage: msg });
      this.d.metrics.jobs.inc({ status: failStatus });
      this.d.logger.warn({ jobId, taskId, msg }, `${kind} failed (pre-broadcast)`);
      return;
    }

    if (action === 'reconcile') {
      // The op may have landed — re-run the task to reconcile from chain state (its
      // `landed` branch). Leave the work NON-TERMINAL; never write *_failed here.
      this.reconcileTries.set(taskId, tries + 1);
      this.d.logger.warn(
        { jobId, taskId, tries, msg },
        `${kind} post-broadcast error — re-queueing to reconcile (not failing)`,
      );
      const t = setTimeout(() => this.dispatch(poolIndex, taskId), RECONCILE_RETRY_DELAY_MS);
      (t as { unref?: () => void }).unref?.();
      return;
    }

    // 'park': auto-reconcile exhausted (sustained outage). Leave the work non-terminal +
    // the job in-progress so the next restart's rehydrate or an operator `relay jobs
    // retry` finishes it. NEVER *_failed — the op likely landed; a false failure would
    // strand the fee / report a phantom failure to the client.
    this.reconcileTries.delete(taskId);
    this.d.logger.error(
      { jobId, taskId, msg },
      `${kind} post-broadcast reconcile exhausted — left recoverable (NOT marked failed)`,
    );
  }

  private async runInject(taskId: string): Promise<void> {
    const work = this.d.store.getWork(taskId);
    if (!work) return;
    const job = this.d.store.getJob(work.jobId);
    if (!job) return;
    const worker = this.d.workers[work.poolIndex]!;

    try {
      this.d.store.setWorkState(taskId, 'running');

      const landed =
        work.broadcastState !== 'none' &&
        work.pinnedCounter != null &&
        (await broadcastAlreadyLanded(worker.client, worker.tezosAddress, work.pinnedCounter));

      let opHash: string;
      if (landed) {
        opHash = work.opHash ?? 'recovered-on-restart';
      } else {
        const stopTimer = this.d.metrics.broadcast.startTimer({ kind: 'user_tx' });
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
        stopTimer();
      }

      this.reconcileTries.delete(taskId);
      this.d.store.completeWork(taskId, job.jobId, 'completed', opHash);
      this.d.metrics.jobs.inc({ status: 'completed' });
      this.d.logger.info({ jobId: job.jobId, opHash }, 'user transaction completed');
    } catch (e) {
      // UNKNOWN error: terminal-fail only if nothing was broadcast; otherwise reconcile
      // (the user op may have landed — never report a false user_tx_failed).
      this.onTaskError('inject_user_tx', taskId, job.jobId, work.poolIndex, e);
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

  private validateTxns(txns: unknown, maxTxns: number): void {
    if (!Array.isArray(txns) || txns.length === 0) {
      throw new HttpError(400, 'Transaction must include a non-empty txns array.');
    }
    if (txns.length > maxTxns) {
      throw new HttpError(400, `Too many sapling txns in one operation (${txns.length} > ${maxTxns}).`);
    }
    for (const t of txns) {
      if (typeof t !== 'string' || t.length === 0 || t.length > MAX_TXN_HEX || !HEX.test(t)) {
        throw new HttpError(400, 'Invalid sapling transaction: must be a hex string.');
      }
    }
  }
}
