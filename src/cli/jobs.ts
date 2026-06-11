import { join } from 'node:path';
import { loadConfig } from '../config/load.js';
import { SqliteStore } from '../store/sqlite.js';
import { STALE_MS } from '../runtime/instanceLock.js';
import type { InstanceLockRow, JobRow, WorkRow, WorkState, WorkKind } from '../store/index.js';

/** Upper bound on rows a single bulk `--all` mutation touches; saturation is surfaced, not silent. */
const BULK_CAP = 1000;

/**
 * `relay jobs` — dead-letter ops. Inspect and recover work items the relay parked
 * as terminal-'failed' (a paid-but-undelivered phase-2 inject is the case that matters).
 *
 * THE load-bearing rule: this CLI is a SEPARATE process from `relay start`. The whole
 * crash-safety model (counter-pin reconcile) is sound ONLY because a single process owns
 * all writes to a worker's tz1. So `list`/`show` are pure reads (always safe), but the
 * mutators (`retry`/`discard`) REFUSE while a relay is live — they re-arm durable rows for
 * the relay's OWN boot rehydrate to resume; they never broadcast themselves.
 */

// ── shared helpers ───────────────────────────────────────────────────────────
function openStore(): SqliteStore {
  const cfg = loadConfig();
  const store = new SqliteStore(join(cfg.DATA_DIR, 'relay.db'));
  store.init();
  return store;
}

/** Pure liveness predicate (exported for tests): does this lock mean a relay is live NOW?
 *  Uses the SAME STALE_MS the relay uses to reclaim, so the CLI's verdict matches `relay start`. */
export function relayLiveness(
  lock: InstanceLockRow | undefined,
  nowMs: number,
): { holder: string; ageMs: number } | undefined {
  if (!lock) return undefined;
  const ageMs = nowMs - lock.heartbeatAt;
  return ageMs < STALE_MS ? { holder: lock.holder, ageMs } : undefined;
}

/** Returns the lock holder iff a relay is LIVE. Pure read — never acquires/heartbeats the lock. */
function liveHolder(store: SqliteStore): { holder: string; ageMs: number } | undefined {
  return relayLiveness(store.getInstanceLock(), Date.now());
}

/** Mutators are offline-only. If a relay holds the lock, refuse with exit 2 and explain. */
function assertOffline(store: SqliteStore): void {
  const live = liveHolder(store);
  if (live) {
    console.error(
      `\n✗ A relay instance is LIVE (holder ${live.holder}, heartbeat ${Math.round(live.ageMs / 1000)}s ago).\n` +
        '  Refusing to mutate the database from a second process — it would break the single-writer\n' +
        '  invariant the crash-safety model depends on, and a live relay only re-scans work at boot.\n' +
        '  Stop the relay, run this command, then `relay start` (boot rehydrate resumes re-armed rows).\n',
    );
    store.close();
    process.exit(2);
  }
}

const KIND_SHORT: Record<WorkKind, string> = {
  inject_payment: 'payment',
  inject_user_tx: 'user_tx',
  gas_refill: 'gas',
};

function parseKind(s: string | undefined): WorkKind | undefined {
  if (!s) return undefined;
  if (s === 'payment' || s === 'inject_payment') return 'inject_payment';
  if (s === 'user_tx' || s === 'inject_user_tx') return 'inject_user_tx';
  if (s === 'gas' || s === 'gas_refill') return 'gas_refill';
  throw new Error(`unknown --kind '${s}' (use payment | user_tx)`);
}

const VALID_STATES: WorkState[] = ['queued', 'running', 'done', 'failed'];
function parseState(s: string | undefined): WorkState | undefined {
  if (!s) return undefined;
  if (!VALID_STATES.includes(s as WorkState)) {
    throw new Error(`unknown --state '${s}' (use ${VALID_STATES.join(' | ')})`);
  }
  return s as WorkState;
}

function stateIcon(w: WorkRow): string {
  if (w.discardedAt != null) return '⊘';
  return { failed: '✗', queued: '•', running: '▸', done: '✓' }[w.state] ?? '?';
}

function humanAge(epochSeconds: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - epochSeconds);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}

const shortJob = (jobId: string): string => jobId.replace(/^job-/, '').slice(0, 8);

function txnsCount(payloadJson: string): number | null {
  try {
    const p: unknown = JSON.parse(payloadJson);
    const arr = Array.isArray(p) ? p : [p];
    return arr.reduce<number>((n, x) => {
      const txns = (x as { txns?: unknown }).txns;
      return n + (Array.isArray(txns) ? txns.length : 0);
    }, 0);
  } catch {
    return null;
  }
}

/** A payload-free row view for --json (never leaks raw sapling hex). */
function jsonRow(w: WorkRow, job: JobRow | undefined): Record<string, unknown> {
  return {
    taskId: w.taskId,
    jobId: w.jobId,
    kind: w.kind,
    poolIndex: w.poolIndex,
    chainSeq: w.chainSeq,
    state: w.state,
    broadcastState: w.broadcastState,
    opHash: w.opHash,
    pinnedCounter: w.pinnedCounter,
    attempts: w.attempts,
    discardedAt: w.discardedAt,
    payloadBytes: w.payloadJson.length,
    txnsCount: txnsCount(w.payloadJson),
    jobStatus: job?.status ?? null,
    errorMessage: job?.errorMessage ?? null,
    createdAt: job?.createdAt ?? null,
    expiresAt: job?.expiresAt ?? null,
  };
}

// ── list ─────────────────────────────────────────────────────────────────────
export interface ListOpts {
  failedOnly?: boolean;
  stuck?: boolean;
  all?: boolean;
  state?: string;
  kind?: string;
  limit?: string;
  json?: boolean;
}

export function jobsList(opts: ListOpts): void {
  const store = openStore();
  try {
    const kind = parseKind(opts.kind);
    const stateFlag = parseState(opts.state);
    let states: WorkState[] | undefined;
    if (stateFlag) states = [stateFlag];
    else if (opts.all) states = undefined; // everything, including done
    else if (opts.stuck) states = ['failed', 'queued', 'running'];
    else states = ['failed']; // dead-letter default
    const includeDiscarded = Boolean(opts.all);
    const parsed = opts.limit ? parseInt(opts.limit, 10) : 50;
    const limit = Number.isFinite(parsed) && parsed > 0 ? parsed : 50;

    // Fetch one extra to detect (and surface) truncation instead of silently capping.
    const fetched = store.listWork({ states, kind, includeDiscarded, limit: limit + 1 });
    const truncated = fetched.length > limit;
    const rows = truncated ? fetched.slice(0, limit) : fetched;
    const jobs = new Map<string, JobRow | undefined>();
    const jobOf = (id: string): JobRow | undefined => {
      if (!jobs.has(id)) jobs.set(id, store.getJob(id));
      return jobs.get(id);
    };

    if (opts.json) {
      console.log(JSON.stringify({ truncated, rows: rows.map((w) => jsonRow(w, jobOf(w.jobId))) }, null, 2));
      return;
    }

    const live = liveHolder(store);
    const cap = truncated ? `, capped at ${limit} — raise --limit for more` : '';
    console.log(`\nshield-relay dead-letter — ${rows.length} row(s)${cap}${live ? `  (relay LIVE: ${live.holder})` : ''}\n`);
    if (rows.length === 0) {
      console.log('  (nothing to show — no matching work items)\n');
      return;
    }
    console.log(
      `  ${'JOB'.padEnd(9)} ${'KIND'.padEnd(8)} ${'W'.padEnd(2)} ${'STATE'.padEnd(8)} ${'BROADCAST'.padEnd(12)} ${'ATT'.padEnd(3)} ${'AGE'.padEnd(5)} ERROR`,
    );
    for (const w of rows) {
      const job = jobOf(w.jobId);
      const err = (w.discardedAt != null ? 'discarded by operator' : job?.errorMessage ?? '').replace(/\s+/g, ' ');
      console.log(
        `${stateIcon(w)} ${shortJob(w.jobId).padEnd(9)} ${(KIND_SHORT[w.kind] ?? w.kind).padEnd(8)} ` +
          `${String(w.poolIndex).padEnd(2)} ${w.state.padEnd(8)} ${w.broadcastState.padEnd(12)} ` +
          `${String(w.attempts).padEnd(3)} ${(job ? humanAge(job.createdAt) : '—').padEnd(5)} ${err.slice(0, 48)}`,
      );
    }
    console.log(
      '\n  retry <taskId|jobId> to re-arm a failed row · show <id> for detail · discard to abandon\n',
    );
  } finally {
    store.close();
  }
}

// ── show ─────────────────────────────────────────────────────────────────────
export function jobsShow(id: string, opts: { json?: boolean }): void {
  const store = openStore();
  try {
    let job: JobRow | undefined;
    let works: WorkRow[];
    if (id.startsWith('job-')) {
      job = store.getJob(id);
      works = store.listWork({ jobId: id, includeDiscarded: true, limit: 10 });
    } else {
      const w = store.getWork(id);
      works = w ? [w] : [];
      job = w ? store.getJob(w.jobId) : undefined;
    }
    if (!job && works.length === 0) {
      console.error(`✗ not found: ${id}`);
      store.close();
      process.exit(1);
    }

    if (opts.json) {
      console.log(JSON.stringify({ job, work: works.map((w) => jsonRow(w, job)) }, null, 2));
      return;
    }

    console.log('');
    if (job) {
      const expired = Math.floor(Date.now() / 1000) > job.expiresAt;
      console.log(`job        ${job.jobId}`);
      console.log(`  status   ${job.status}${expired ? '  (EXPIRED)' : ''}`);
      console.log(`  pools    payment=${job.paymentPoolIndex} broadcast=${job.broadcastPoolIndex}`);
      console.log(`  paymentTx ${job.paymentTxHash ?? '—'}`);
      console.log(`  userTx    ${job.userTxHash ?? '—'}`);
      console.log(`  error    ${job.errorMessage ?? '—'}`);
      console.log(`  created  ${new Date(job.createdAt * 1000).toISOString()}  age ${humanAge(job.createdAt)}`);
    }
    for (const w of works) {
      console.log(`\nwork       ${w.taskId}  (${stateIcon(w)} ${w.state}${w.discardedAt != null ? ', discarded' : ''})`);
      console.log(`  kind     ${w.kind}  worker=${w.poolIndex}  chainSeq=${w.chainSeq}`);
      console.log(`  broadcast ${w.broadcastState}  pinnedCounter=${w.pinnedCounter ?? '—'}  attempts=${w.attempts}`);
      console.log(`  opHash   ${w.opHash ?? '—'}`);
      console.log(`  payload  ${w.payloadJson.length} bytes, ${txnsCount(w.payloadJson) ?? '?'} txn(s)`);
    }
    console.log('');
  } finally {
    store.close();
  }
}

// ── target resolution (shared by retry/discard) ──────────────────────────────
function resolveTargets(
  store: SqliteStore,
  id: string | undefined,
  opts: { all?: boolean; kind?: string; state?: string },
  defaultStates: WorkState[],
): WorkRow[] {
  const kind = parseKind(opts.kind);
  const stateFlag = parseState(opts.state);
  if (opts.all) {
    const states = stateFlag ? [stateFlag] : defaultStates;
    // +1 so the caller can detect saturation and warn instead of silently truncating.
    return store.listWork({ states, kind, limit: BULK_CAP + 1 });
  }
  if (!id) throw new Error('specify a taskId / jobId, or --all (with a filter)');
  if (id.startsWith('job-')) {
    const rows = store.listWork({ jobId: id, states: defaultStates, kind, limit: 10 });
    if (rows.length > 1) {
      const desc = rows.map((r) => `${r.taskId} (${KIND_SHORT[r.kind] ?? r.kind})`).join(', ');
      throw new Error(`jobId ${id} has ${rows.length} matching rows: ${desc}\n  disambiguate with --kind <payment|user_tx>, or --all to take both`);
    }
    return rows;
  }
  const w = store.getWork(id);
  return w ? [w] : [];
}

// ── retry ────────────────────────────────────────────────────────────────────
export interface RetryOpts {
  all?: boolean;
  kind?: string;
  force?: boolean;
  dryRun?: boolean;
  json?: boolean;
}

const FUTILE_PAYMENT = /consumed|verification failed/i;

export function jobsRetry(id: string | undefined, opts: RetryOpts): void {
  const store = openStore();
  try {
    assertOffline(store);
    if (opts.all && !opts.force && !opts.kind) {
      // bulk retry is allowed but make the operator scope or acknowledge it
      console.error('✗ `retry --all` re-arms EVERY failed row. Add --kind <payment|user_tx> to scope it, or --force to take all.');
      store.close();
      process.exit(1);
    }
    const resolved = resolveTargets(store, id, opts, ['failed']);
    const capped = opts.all && resolved.length > BULK_CAP;
    const targets = capped ? resolved.slice(0, BULK_CAP) : resolved;
    if (targets.length === 0) {
      console.log('  no failed work matched — nothing to retry.');
      return;
    }

    const results: { taskId: string; kind: WorkKind; outcome: string }[] = [];
    for (const w of targets) {
      if (w.state !== 'failed') {
        results.push({ taskId: w.taskId, kind: w.kind, outcome: `skipped (state=${w.state}; only failed rows retry — stuck rows auto-resume on restart)` });
        continue;
      }
      // A failed inject_payment is usually futile: the user never paid, or the payment is
      // PERMANENTLY consumed (no TTL). Re-running re-fails identically. Require --force.
      if (w.kind === 'inject_payment' && !opts.force) {
        const job = store.getJob(w.jobId);
        if (job?.errorMessage && FUTILE_PAYMENT.test(job.errorMessage)) {
          results.push({ taskId: w.taskId, kind: w.kind, outcome: `refused (payment failure '${job.errorMessage}' is permanent — --force to retry anyway)` });
          continue;
        }
      }
      if (opts.dryRun) {
        results.push({ taskId: w.taskId, kind: w.kind, outcome: 'would re-arm → queued' });
        continue;
      }
      const r = store.retryWork(w.taskId);
      results.push({ taskId: w.taskId, kind: w.kind, outcome: r.changed ? 're-armed → queued' : 'no-op (not failed)' });
    }

    if (opts.json) {
      console.log(JSON.stringify({ dryRun: Boolean(opts.dryRun), capped, results }, null, 2));
      return;
    }
    console.log('');
    for (const r of results) console.log(`  ${r.taskId.slice(0, 8)}  ${(KIND_SHORT[r.kind] ?? r.kind).padEnd(8)} ${r.outcome}`);
    const armed = results.filter((r) => r.outcome.startsWith('re-armed')).length;
    if (opts.dryRun) {
      console.log(`\n  (dry run — nothing changed)\n`);
    } else if (armed > 0) {
      console.log(`\n✓ ${armed} task(s) re-armed. They resume on the NEXT \`relay start\` — restart the relay to process them.\n`);
    } else {
      console.log('');
    }
    if (capped) {
      console.log(`⚠ hit the ${BULK_CAP}-row cap — more failed rows match. Re-run \`relay jobs retry --all\` for the next batch (re-armed rows are skipped).\n`);
    }
  } finally {
    store.close();
  }
}

// ── discard ──────────────────────────────────────────────────────────────────
export interface DiscardOpts {
  all?: boolean;
  kind?: string;
  state?: string;
  yes?: boolean;
  dryRun?: boolean;
  json?: boolean;
}

export function jobsDiscard(id: string | undefined, opts: DiscardOpts): void {
  const store = openStore();
  try {
    assertOffline(store);
    // 'done' is never discardable — a completed/delivered job is a truthful record.
    if (parseState(opts.state) === 'done') {
      console.error("✗ refusing to discard 'done' rows — they are completed, delivered jobs.");
      store.close();
      process.exit(1);
    }
    if (opts.all && !opts.state && !opts.kind) {
      console.error('✗ `discard --all` is too broad. Scope it with --state <failed|queued|running> or --kind <payment|user_tx>.');
      store.close();
      process.exit(1);
    }
    const resolved = resolveTargets(store, id, opts, ['failed']);
    const capped = opts.all && resolved.length > BULK_CAP;
    const bounded = capped ? resolved.slice(0, BULK_CAP) : resolved;
    // A bare taskId can resolve a 'done' row (getWork has no state filter) — surface + exclude it.
    const refusedDone = bounded.filter((w) => w.state === 'done');
    const targets = bounded.filter((w) => w.state !== 'done');
    for (const w of refusedDone) {
      console.log(`  ✗ ${w.taskId.slice(0, 8)}  ${(KIND_SHORT[w.kind] ?? w.kind).padEnd(8)} completed (done) — cannot discard a delivered job`);
    }
    if (targets.length === 0) {
      console.log(refusedDone.length ? '\n  nothing discardable (targets are completed).\n' : '  no matching work — nothing to discard.');
      return;
    }

    const paid = targets.filter((w) => w.kind === 'inject_user_tx' && w.discardedAt == null);
    const willChange = targets.filter((w) => w.discardedAt == null);

    // Preview is mandatory; mutating requires explicit --yes (no interactive prompt → never hangs).
    console.log('');
    for (const w of targets) {
      const note =
        w.discardedAt != null
          ? 'already discarded'
          : w.kind === 'inject_user_tx'
            ? `⚠ user ALREADY PAID — abandons their unbroadcast tx${w.opHash ? ` (opHash ${w.opHash} — verify on-chain first)` : ''}`
            : 'low-risk (payment never delivered)';
      console.log(`  ${w.taskId.slice(0, 8)}  ${(KIND_SHORT[w.kind] ?? w.kind).padEnd(8)} ${w.state.padEnd(8)} ${note}`);
    }

    if (opts.dryRun) {
      console.log(`\n  (dry run — nothing changed)\n`);
      return;
    }
    if (!opts.yes) {
      console.log(
        `\n  ${willChange.length} row(s) would be discarded${paid.length ? `, ${paid.length} of which the user PAID for` : ''}.` +
          '\n  Discard is additive (never deletes a row, never touches the replay guard) but ABANDONS the work.' +
          '\n  Re-run with --yes to confirm.\n',
      );
      return;
    }

    const results: { taskId: string; kind: WorkKind; outcome: string }[] = [];
    for (const w of targets) {
      const r = store.discardWork(w.taskId);
      results.push({ taskId: w.taskId, kind: w.kind, outcome: r.changed ? 'discarded' : 'no-op (already discarded)' });
    }
    if (opts.json) {
      console.log(JSON.stringify({ capped, results }, null, 2));
      return;
    }
    const n = results.filter((r) => r.outcome === 'discarded').length;
    console.log(`\n✓ ${n} task(s) discarded (parked terminal; rows + memos preserved).\n`);
    if (capped) {
      console.log(`⚠ hit the ${BULK_CAP}-row cap — more rows match. Re-run for the next batch (discarded rows are skipped).\n`);
    }
  } finally {
    store.close();
  }
}
