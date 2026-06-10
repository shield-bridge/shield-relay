/**
 * Store — the durable source of truth (jobs, the permanent consumed-memo replay
 * guard, and the durable work_queue). The in-memory WorkerQueue is a cache over
 * `work_queue`; every HTTP 2xx is preceded by a durable write here.
 *
 * Default impl: SQLite (better-sqlite3, synchronous transactions). A Postgres
 * adapter (DATABASE_URL) implements the same interface for networked-FS / HA.
 */

/** Canonical job status. The WIRE subset (sent to clients) excludes `info_generated`. */
export type JobStatus =
  | 'info_generated'
  | 'queued'
  | 'verifying_payment'
  | 'payment_confirmed'
  | 'injecting_user_tx'
  | 'completed'
  | 'payment_failed'
  | 'user_tx_failed';

export type WorkKind = 'inject_payment' | 'inject_user_tx' | 'gas_refill';
export type WorkState = 'queued' | 'running' | 'done' | 'failed';
export type BroadcastState = 'none' | 'broadcasting' | 'broadcast' | 'confirmed';

export interface JobRow {
  jobId: string;
  status: JobStatus;
  paymentPoolIndex: number;
  broadcastPoolIndex: number;
  memo: string;
  jobSecretHash: string;
  /** Recorded server-side for ops/debugging — NEVER emitted on the wire. */
  paymentTxHash: string | null;
  userTxHash: string | null;
  errorMessage: string | null;
  createdAt: number;
  expiresAt: number;
}

export interface WorkRow {
  taskId: string;
  jobId: string;
  poolIndex: number;
  chainSeq: number;
  kind: WorkKind;
  payloadJson: string;
  state: WorkState;
  broadcastState: BroadcastState;
  opHash: string | null;
  pinnedCounter: number | null;
  attempts: number;
  /** Operator-discard marker (epoch ms). Non-null ⟹ parked by `relay jobs discard`;
   *  the row stays terminal-'failed' so it is never rehydrated or executed. */
  discardedAt: number | null;
}

export interface NewJob {
  jobId: string;
  paymentPoolIndex: number;
  broadcastPoolIndex: number;
  memo: string;
  jobSecretHash: string;
  expiresAt: number;
}

export interface NewWork {
  taskId: string;
  jobId: string;
  poolIndex: number;
  kind: WorkKind;
  payloadJson: string;
}

export interface AlertRow {
  id: string;
  payloadJson: string;
  attempts: number;
  nextAttemptAt: number;
}

/** Read-only view of the single-instance lock (CLI liveness probe). */
export interface InstanceLockRow {
  holder: string;
  heartbeatAt: number;
}

/** Filter for the ops/dead-letter work listing. Empty filter = all non-discarded rows. */
export interface WorkFilter {
  states?: WorkState[];
  kind?: WorkKind;
  jobId?: string;
  includeDiscarded?: boolean;
  limit?: number;
}

/** Outcome of a retry/discard mutation. `changed:false` ⟹ a no-op (wrong state / already done). */
export interface MutationResult {
  changed: boolean;
  kind?: WorkKind;
  jobId?: string;
}

export interface Store {
  /** Run migrations / open the DB. Throws if the data dir is on an unsafe networked FS. */
  init(): void;
  close(): void;

  // ── jobs ──────────────────────────────────────────────────────────────────
  createJob(j: NewJob): void;
  getJob(jobId: string): JobRow | undefined;
  setJobStatus(
    jobId: string,
    status: JobStatus,
    extra?: Partial<Pick<JobRow, 'paymentTxHash' | 'userTxHash' | 'errorMessage'>>,
  ): void;

  // ── consumed memos (permanent, atomic, never swept) ─────────────────────────
  /** Atomic INSERT — returns true if newly consumed, false if the memo already existed. */
  tryConsumeMemo(memo: string, jobId: string): boolean;

  // ── work queue (durable inbound queue; the "SQS message") ────────────────────
  /**
   * Atomically advance a job's status AND insert a work item in ONE transaction,
   * but only if the job is currently in `expectedStatus`. Returns the assigned
   * chainSeq, or null if the conditional status guard failed (e.g. already moved).
   */
  enqueueWork(
    work: NewWork,
    expectedStatus: JobStatus,
    nextStatus: JobStatus,
  ): number | null;

  getWork(taskId: string): WorkRow | undefined;
  /** Non-terminal work, ordered (poolIndex, chainSeq) — boot re-hydration order. */
  listNonTerminalWork(): WorkRow[];
  setWorkState(taskId: string, state: WorkState): void;
  setBroadcasting(taskId: string, pinnedCounter: number): void;
  setBroadcast(taskId: string, opHash: string): void;
  /** Mark the work item done AND set the job's status in one transaction. */
  completeWork(taskId: string, jobId: string, jobStatus: JobStatus, userTxHash?: string): void;

  // ── instance lock (refuse a 2nd process on the same pool/DB) ─────────────────
  /** Claim the single-instance lock; false if a fresh holder already has it. */
  tryAcquireInstanceLock(holder: string, staleMs: number): boolean;
  heartbeatInstanceLock(holder: string): void;
  releaseInstanceLock(holder: string): void;
  /** Read the lock WITHOUT acquiring/heartbeating it — the CLI's "is a relay live?" probe. */
  getInstanceLock(): InstanceLockRow | undefined;

  // ── dead-letter ops (the `relay jobs` CLI; mutators are offline-only) ─────────
  /** Filtered work listing (dead-letter view). Ordered (poolIndex, chainSeq). Read-only. */
  listWork(filter: WorkFilter): WorkRow[];
  /**
   * Re-arm a terminal-'failed' work row to 'queued' so the NEXT boot rehydrate resumes it.
   * Resets job.status to the post-enqueue value for its kind (matches the normal-flow pairing
   * AND blocks a duplicate re-submit) and clears errorMessage — all in ONE transaction.
   * LEAVES broadcastState/pinnedCounter/opHash/attempts intact so the boot counter-pin reconcile
   * can skip a re-broadcast that already landed. NEVER broadcasts. No-op unless state is 'failed'.
   */
  retryWork(taskId: string): MutationResult;
  /**
   * Park a work row as operator-discarded: force terminal 'failed' + stamp discardedAt, and set
   * the job to its kind-terminal *_failed with an errorMessage. Additive — NEVER DELETEs a row and
   * NEVER touches consumed_memos (the credit-once replay guard stays intact). No-op if already discarded.
   */
  discardWork(taskId: string): MutationResult;

  // ── alert outbox (durable, retrying critical alerts) ────────────────────────
  enqueueAlert(id: string, payloadJson: string): void;
  listDueAlerts(now: number, limit: number): AlertRow[];
  bumpAlertAttempt(id: string, nextAttemptAt: number): void;
  deleteAlert(id: string): void;
}
