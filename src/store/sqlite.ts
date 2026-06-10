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
} from './index.js';

/**
 * The canonical schema. The in-memory WorkerQueue is a cache over `work_queue`;
 * this table IS the durable "SQS message". `consumed_memos` is the permanent,
 * never-swept replay guard (UNIQUE(memo) == DynamoDB attribute_not_exists).
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
  expiresAt         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_expiresAt ON jobs(expiresAt);

-- PERMANENT replay/credit-once guard. NO TTL, NO sweep.
CREATE TABLE IF NOT EXISTS consumed_memos (
  memo       TEXT PRIMARY KEY,
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
  attempts       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS work_queue_rehydrate ON work_queue(state, poolIndex, chainSeq);
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
    this.db.exec(DDL);
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
           jobSecretHash, paymentTxHash, userTxHash, errorMessage, createdAt, expiresAt)
         VALUES (@jobId, 'info_generated', @paymentPoolIndex, @broadcastPoolIndex, @memo,
           @jobSecretHash, NULL, NULL, NULL, @createdAt, @expiresAt)`,
      )
      .run({ ...j, createdAt: now });
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

  // ── consumed memos ───────────────────────────────────────────────────────────
  tryConsumeMemo(memo: string, jobId: string): boolean {
    try {
      this.db
        .prepare('INSERT INTO consumed_memos (memo, jobId, consumedAt) VALUES (?, ?, ?)')
        .run(memo, jobId, Math.floor(Date.now() / 1000));
      return true;
    } catch (err) {
      if (err instanceof Error && (err as { code?: string }).code?.startsWith('SQLITE_CONSTRAINT')) {
        // Already present. If it's OURS (crash-resume re-running the consume step),
        // treat as success; another job's memo is a replay → reject.
        const row = this.db
          .prepare('SELECT jobId FROM consumed_memos WHERE memo = ?')
          .get(memo) as { jobId: string } | undefined;
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
}

// Referenced for documentation of the constraint code path.
void UNIQUE_VIOLATION;
