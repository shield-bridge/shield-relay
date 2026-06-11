import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type {
  Store,
  JobRow,
  JobStatus,
  NewJob,
  NewWork,
  WorkRow,
  WorkState,
  WorkKind,
  AlertRow,
  InstanceLockRow,
  WorkFilter,
  MutationResult,
} from './index.js';

/**
 * The canonical schema. The in-memory WorkerQueue is a cache over `work_queue`;
 * this table IS the durable "SQS message". `consumed_payments` is the permanent,
 * never-swept replay guard (UNIQUE(digest) == DynamoDB attribute_not_exists).
 */
const DDL = `
CREATE TABLE IF NOT EXISTS jobs (
  jobId             TEXT PRIMARY KEY,
  status            TEXT NOT NULL,
  paymentPoolIndex  INTEGER NOT NULL,
  broadcastPoolIndex INTEGER NOT NULL,
  memo              TEXT NOT NULL,
  jobSecretHash     TEXT NOT NULL,
  paymentTxHash     TEXT,
  userTxHash        TEXT,
  errorMessage      TEXT,
  createdAt         INTEGER NOT NULL,
  expiresAt         INTEGER NOT NULL,
  quotedFeeMutez    INTEGER,
  quotedTxCount     INTEGER,
  legacyQuote       INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS jobs_expiresAt ON jobs(expiresAt);

-- PERMANENT replay/credit-once guard. NO TTL, NO sweep. Keyed on a sha256 digest
-- of the payment's sapling txns: a verified payment's exact bytes are single-use.
CREATE TABLE IF NOT EXISTS consumed_payments (
  digest     TEXT PRIMARY KEY,
  jobId      TEXT NOT NULL,
  consumedAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS work_queue (
  taskId         TEXT PRIMARY KEY,
  jobId          TEXT NOT NULL,
  poolIndex      INTEGER NOT NULL,
  chainSeq       INTEGER NOT NULL,
  kind           TEXT NOT NULL,
  payloadJson    TEXT NOT NULL,
  state          TEXT NOT NULL,
  broadcastState TEXT NOT NULL DEFAULT 'none',
  opHash         TEXT,
  pinnedCounter  INTEGER,
  attempts       INTEGER NOT NULL DEFAULT 0,
  discardedAt    INTEGER
);
CREATE INDEX IF NOT EXISTS work_queue_rehydrate ON work_queue(state, poolIndex, chainSeq);

-- Durable, retrying critical alerts (e.g. worker low gas balance).
CREATE TABLE IF NOT EXISTS alert_outbox (
  id            TEXT PRIMARY KEY,
  payloadJson   TEXT NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0,
  nextAttemptAt INTEGER NOT NULL
);

-- Single-instance guard: refuse a 2nd process on the same pool/DB.
CREATE TABLE IF NOT EXISTS instance_lock (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  holder      TEXT NOT NULL,
  heartbeatAt INTEGER NOT NULL
);
`;

const UNIQUE_VIOLATION = 'SQLITE_CONSTRAINT_PRIMARYKEY';

export class SqliteStore implements Store {
  private db!: Database.Database;

  constructor(private readonly dbPath: string) {}

  init(): void {
    if (this.dbPath !== ':memory:') mkdirSync(dirname(this.dbPath), { recursive: true });
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    // Contended commits (a 2nd CLI, or the bounded window before the live-lock gate trips)
    // retry for up to 3s instead of throwing SQLITE_BUSY immediately.
    this.db.pragma('busy_timeout = 3000');
    this.db.exec(DDL);
    this.migrate();
  }

  /** Additive, idempotent migrations for DBs created before a column existed.
   *  Fresh installs get the column from the CREATE TABLE above; this is a no-op for them. */
  private migrate(): void {
    this.ensureColumn('work_queue', 'discardedAt', 'INTEGER');
    this.ensureColumn('jobs', 'quotedFeeMutez', 'INTEGER');
    this.ensureColumn('jobs', 'quotedTxCount', 'INTEGER');
    this.ensureColumn('jobs', 'legacyQuote', 'INTEGER NOT NULL DEFAULT 1');
  }

  private ensureColumn(table: string, column: string, decl: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
    }
  }

  close(): void {
    this.db?.close();
  }

  // ── jobs ────────────────────────────────────────────────────────────────────
  createJob(j: NewJob): void {
    const now = Math.floor(Date.now() / 1000);
    this.db
      .prepare(
        `INSERT INTO jobs (jobId, status, paymentPoolIndex, broadcastPoolIndex, memo,
           jobSecretHash, paymentTxHash, userTxHash, errorMessage, createdAt, expiresAt,
           quotedFeeMutez, quotedTxCount, legacyQuote)
         VALUES (@jobId, 'info_generated', @paymentPoolIndex, @broadcastPoolIndex, @memo,
           @jobSecretHash, NULL, NULL, NULL, @createdAt, @expiresAt,
           @quotedFeeMutez, @quotedTxCount, @legacyQuote)`,
      )
      .run({ ...j, createdAt: now, legacyQuote: j.legacyQuote ? 1 : 0 });
  }

  getJob(jobId: string): JobRow | undefined {
    return this.db.prepare('SELECT * FROM jobs WHERE jobId = ?').get(jobId) as JobRow | undefined;
  }

  setJobStatus(
    jobId: string,
    status: JobStatus,
    extra?: Partial<Pick<JobRow, 'paymentTxHash' | 'userTxHash' | 'errorMessage'>>,
  ): void {
    this.db
      .prepare(
        `UPDATE jobs SET status = @status,
           paymentTxHash = COALESCE(@paymentTxHash, paymentTxHash),
           userTxHash    = COALESCE(@userTxHash, userTxHash),
           errorMessage  = COALESCE(@errorMessage, errorMessage)
         WHERE jobId = @jobId`,
      )
      .run({
        jobId,
        status,
        paymentTxHash: extra?.paymentTxHash ?? null,
        userTxHash: extra?.userTxHash ?? null,
        errorMessage: extra?.errorMessage ?? null,
      });
  }

  // ── consumed payments ─────────────────────────────────────────────────────────
  tryConsumePaymentDigest(digest: string, jobId: string): boolean {
    try {
      this.db
        .prepare('INSERT INTO consumed_payments (digest, jobId, consumedAt) VALUES (?, ?, ?)')
        .run(digest, jobId, Math.floor(Date.now() / 1000));
      return true;
    } catch (err) {
      if (err instanceof Error && (err as { code?: string }).code?.startsWith('SQLITE_CONSTRAINT')) {
        // Already present. If it's OURS (crash-resume re-running the consume step),
        // treat as success; another job's digest is a replay → reject.
        const row = this.db
          .prepare('SELECT jobId FROM consumed_payments WHERE digest = ?')
          .get(digest) as { jobId: string } | undefined;
        return row?.jobId === jobId;
      }
      throw err;
    }
  }

  // ── work queue ────────────────────────────────────────────────────────────────
  enqueueWork(work: NewWork, expectedStatus: JobStatus, nextStatus: JobStatus): number | null {
    const txn = this.db.transaction((): number | null => {
      const job = this.db.prepare('SELECT status FROM jobs WHERE jobId = ?').get(work.jobId) as
        | { status: JobStatus }
        | undefined;
      if (!job || job.status !== expectedStatus) return null; // conditional guard failed

      const row = this.db
        .prepare(
          'SELECT COALESCE(MAX(chainSeq), 0) + 1 AS next FROM work_queue WHERE poolIndex = ?',
        )
        .get(work.poolIndex) as { next: number };
      const chainSeq = row.next;

      this.db
        .prepare(
          `INSERT INTO work_queue (taskId, jobId, poolIndex, chainSeq, kind, payloadJson, state, broadcastState, attempts)
           VALUES (@taskId, @jobId, @poolIndex, @chainSeq, @kind, @payloadJson, 'queued', 'none', 0)`,
        )
        .run({ ...work, chainSeq });

      this.db.prepare('UPDATE jobs SET status = ? WHERE jobId = ?').run(nextStatus, work.jobId);
      return chainSeq;
    });
    return txn();
  }

  getWork(taskId: string): WorkRow | undefined {
    return this.db.prepare('SELECT * FROM work_queue WHERE taskId = ?').get(taskId) as
      | WorkRow
      | undefined;
  }

  listNonTerminalWork(): WorkRow[] {
    return this.db
      .prepare(
        `SELECT * FROM work_queue WHERE state IN ('queued', 'running') ORDER BY poolIndex, chainSeq`,
      )
      .all() as WorkRow[];
  }

  setWorkState(taskId: string, state: WorkState): void {
    this.db.prepare('UPDATE work_queue SET state = ? WHERE taskId = ?').run(state, taskId);
  }

  setBroadcasting(taskId: string, pinnedCounter: number): void {
    this.db
      .prepare(
        `UPDATE work_queue SET broadcastState = 'broadcasting', pinnedCounter = ?, attempts = attempts + 1 WHERE taskId = ?`,
      )
      .run(pinnedCounter, taskId);
  }

  setBroadcast(taskId: string, opHash: string): void {
    this.db
      .prepare(`UPDATE work_queue SET broadcastState = 'broadcast', opHash = ? WHERE taskId = ?`)
      .run(opHash, taskId);
  }

  completeWork(taskId: string, jobId: string, jobStatus: JobStatus, userTxHash?: string): void {
    const txn = this.db.transaction(() => {
      this.db
        .prepare(`UPDATE work_queue SET state = 'done', broadcastState = 'confirmed' WHERE taskId = ?`)
        .run(taskId);
      this.db
        .prepare('UPDATE jobs SET status = ?, userTxHash = COALESCE(?, userTxHash) WHERE jobId = ?')
        .run(jobStatus, userTxHash ?? null, jobId);
    });
    txn();
  }

  // ── instance lock ───────────────────────────────────────────────────────────
  tryAcquireInstanceLock(holder: string, staleMs: number): boolean {
    const now = Date.now();
    const txn = this.db.transaction((): boolean => {
      const row = this.db.prepare('SELECT holder, heartbeatAt FROM instance_lock WHERE id = 1').get() as
        | { holder: string; heartbeatAt: number }
        | undefined;
      if (row && row.holder !== holder && now - row.heartbeatAt < staleMs) {
        return false; // a different, still-alive holder owns it
      }
      this.db
        .prepare(
          `INSERT INTO instance_lock (id, holder, heartbeatAt) VALUES (1, @holder, @now)
           ON CONFLICT(id) DO UPDATE SET holder = @holder, heartbeatAt = @now`,
        )
        .run({ holder, now });
      return true;
    });
    return txn();
  }

  heartbeatInstanceLock(holder: string): void {
    this.db
      .prepare('UPDATE instance_lock SET heartbeatAt = ? WHERE id = 1 AND holder = ?')
      .run(Date.now(), holder);
  }

  releaseInstanceLock(holder: string): void {
    this.db.prepare('DELETE FROM instance_lock WHERE id = 1 AND holder = ?').run(holder);
  }

  getInstanceLock(): InstanceLockRow | undefined {
    return this.db
      .prepare('SELECT holder, heartbeatAt FROM instance_lock WHERE id = 1')
      .get() as InstanceLockRow | undefined;
  }

  countJobsByStatus(): { status: JobStatus; count: number }[] {
    return this.db
      .prepare('SELECT status, COUNT(*) AS count FROM jobs GROUP BY status')
      .all() as { status: JobStatus; count: number }[];
  }

  countActiveWorkByPool(): { poolIndex: number; queued: number; running: number }[] {
    return this.db
      .prepare(
        `SELECT poolIndex,
                SUM(CASE WHEN state = 'queued'  THEN 1 ELSE 0 END) AS queued,
                SUM(CASE WHEN state = 'running' THEN 1 ELSE 0 END) AS running
           FROM work_queue
          WHERE state IN ('queued', 'running')
          GROUP BY poolIndex
          ORDER BY poolIndex`,
      )
      .all() as { poolIndex: number; queued: number; running: number }[];
  }

  // ── alert outbox ──────────────────────────────────────────────────────────────
  enqueueAlert(id: string, payloadJson: string): void {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO alert_outbox (id, payloadJson, attempts, nextAttemptAt) VALUES (?, ?, 0, ?)',
      )
      .run(id, payloadJson, Date.now());
  }

  listDueAlerts(now: number, limit: number): AlertRow[] {
    return this.db
      .prepare('SELECT * FROM alert_outbox WHERE nextAttemptAt <= ? ORDER BY nextAttemptAt LIMIT ?')
      .all(now, limit) as AlertRow[];
  }

  bumpAlertAttempt(id: string, nextAttemptAt: number): void {
    this.db
      .prepare('UPDATE alert_outbox SET attempts = attempts + 1, nextAttemptAt = ? WHERE id = ?')
      .run(nextAttemptAt, id);
  }

  deleteAlert(id: string): void {
    this.db.prepare('DELETE FROM alert_outbox WHERE id = ?').run(id);
  }

  // ── dead-letter ops (the `relay jobs` CLI) ──────────────────────────────────
  listWork(filter: WorkFilter): WorkRow[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.states?.length) {
      clauses.push(`state IN (${filter.states.map(() => '?').join(',')})`);
      params.push(...filter.states);
    }
    if (filter.kind) {
      clauses.push('kind = ?');
      params.push(filter.kind);
    }
    if (filter.jobId) {
      clauses.push('jobId = ?');
      params.push(filter.jobId);
    }
    if (!filter.includeDiscarded) clauses.push('discardedAt IS NULL');
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = filter.limit && filter.limit > 0 ? filter.limit : 50;
    return this.db
      .prepare(`SELECT * FROM work_queue ${where} ORDER BY poolIndex, chainSeq LIMIT ?`)
      .all(...params, limit) as WorkRow[];
  }

  retryWork(taskId: string): MutationResult {
    const txn = this.db.transaction((): MutationResult => {
      const work = this.db
        .prepare('SELECT jobId, kind, state FROM work_queue WHERE taskId = ?')
        .get(taskId) as { jobId: string; kind: WorkKind; state: WorkState } | undefined;
      if (!work) return { changed: false };
      if (work.state !== 'failed') return { changed: false, kind: work.kind, jobId: work.jobId };

      // Re-arm the durable row. broadcastState/pinnedCounter/opHash/attempts are LEFT INTACT
      // so the boot reconcile (broadcastAlreadyLanded) skips a re-broadcast that already landed.
      this.db.prepare(`UPDATE work_queue SET state = 'queued' WHERE taskId = ?`).run(taskId);
      // Post-enqueue status for the kind: matches the normal (job.status, work.state) pairing
      // AND blocks a duplicate user re-submit (submitPayment wants info_generated; submitUserTx
      // rejects injecting_user_tx). Clear the stale error.
      const nextStatus: JobStatus = work.kind === 'inject_user_tx' ? 'injecting_user_tx' : 'queued';
      this.db
        .prepare('UPDATE jobs SET status = ?, errorMessage = NULL WHERE jobId = ?')
        .run(nextStatus, work.jobId);
      return { changed: true, kind: work.kind, jobId: work.jobId };
    });
    return txn();
  }

  discardWork(taskId: string): MutationResult {
    const now = Date.now();
    const txn = this.db.transaction((): MutationResult => {
      const work = this.db
        .prepare('SELECT jobId, kind, state, discardedAt FROM work_queue WHERE taskId = ?')
        .get(taskId) as
        | { jobId: string; kind: WorkKind; state: WorkState; discardedAt: number | null }
        | undefined;
      if (!work) return { changed: false };
      if (work.discardedAt != null) return { changed: false, kind: work.kind, jobId: work.jobId };
      // NEVER discard a delivered job. A 'done' row is a truthful completed record
      // (broadcastState=confirmed, userTxHash set); forcing it to *_failed would corrupt the
      // audit trail. Discard's only legitimate targets are 'failed' dead-letters and
      // crash-orphaned 'queued'/'running' rows — mirrors retryWork's state guard.
      if (work.state === 'done') return { changed: false, kind: work.kind, jobId: work.jobId };

      // Force terminal + stamp. ADDITIVE: never DELETE, never touch consumed_memos.
      this.db
        .prepare(`UPDATE work_queue SET state = 'failed', discardedAt = ? WHERE taskId = ?`)
        .run(now, taskId);
      const jobStatus: JobStatus = work.kind === 'inject_user_tx' ? 'user_tx_failed' : 'payment_failed';
      this.db
        .prepare('UPDATE jobs SET status = ?, errorMessage = ? WHERE jobId = ?')
        .run(jobStatus, 'discarded by operator', work.jobId);
      return { changed: true, kind: work.kind, jobId: work.jobId };
    });
    return txn();
  }
}

// Referenced for documentation of the constraint code path.
void UNIQUE_VIOLATION;
