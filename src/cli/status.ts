import { join } from 'node:path';
import { TezosToolkit } from '@tezos-x/octez.js';
import { InMemorySigner } from '@tezos-x/octez.js-signer';
import { loadConfig } from '../config/load.js';
import { SqliteStore } from '../store/sqlite.js';
import { loadPoolSecrets } from '../sapling/pool.js';
import { relayLiveness } from './jobs.js';
import type { JobStatus } from '../store/index.js';

/**
 * `relay status` — a read-only health glance at the (possibly running) relay.
 *
 * doctor answers "is it configured right to START"; status answers "is the running
 * relay HEALTHY": is it live (instance lock), are workers funded (on-chain gas),
 * is work flowing or stuck (durable queue depth + job counts), what's failing.
 * Read-only — it never mutates, so it has no live-instance gate (unlike jobs).
 */

const KIND_SHORT: Record<string, string> = {
  inject_payment: 'payment',
  inject_user_tx: 'user_tx',
};
const shortJob = (jobId: string): string => jobId.replace(/^job-/, '').slice(0, 8);
function humanAge(epochSeconds: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - epochSeconds);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}

export interface StatusOpts {
  watch?: string;
  json?: boolean;
  /** Commander maps `--no-chain` to `chain:false`; undefined/true means query the chain. */
  chain?: boolean;
}

export async function relayStatus(opts: StatusOpts): Promise<void> {
  const cfg = loadConfig();
  const store = new SqliteStore(join(cfg.DATA_DIR, 'relay.db'));
  store.init();

  // Derive worker tz1s ONCE — they don't change. Best-effort: needs the pool secret,
  // so status still works (store-only) if the pool isn't mounted. Gas is re-queried
  // per render (balances change); the signer derivation is not.
  let workers: { index: number; tz1: string }[] = [];
  let client: TezosToolkit | undefined;
  let gasNote = '';
  if (opts.chain === false) {
    gasNote = 'gas skipped (--no-chain)';
  } else {
    try {
      const secrets = loadPoolSecrets(cfg);
      client = new TezosToolkit(cfg.rpcUrl);
      const n = Math.min(cfg.WORKER_COUNT, secrets.addresses.length);
      for (let i = 0; i < n; i++) {
        const signer = await InMemorySigner.fromSecretKey(secrets.addresses[i]!.tezosSecretKey);
        workers.push({ index: i, tz1: await signer.publicKeyHash() });
      }
    } catch {
      workers = [];
      gasNote = 'gas unavailable (no pool secret / RPC) — run where POOL_FILE is set';
    }
  }

  const render = async (): Promise<void> => {
    const lock = relayLiveness(store.getInstanceLock(), Date.now());
    const jobCounts = new Map(store.countJobsByStatus().map((r) => [r.status, r.count]));
    const activeByPool = new Map(
      store.countActiveWorkByPool().map((r) => [r.poolIndex, { queued: r.queued, running: r.running }]),
    );
    const failures = store.listWork({ states: ['failed'], includeDiscarded: false, limit: 5 });

    // Per-render gas (RPC). Concurrent + best-effort so one slow/failed worker never stalls the view.
    const gas = new Map<number, number | null>();
    if (client && workers.length) {
      await Promise.all(
        workers.map(async (w) => {
          try {
            gas.set(w.index, (await client!.tz.getBalance(w.tz1)).toNumber() / 1_000_000);
          } catch {
            gas.set(w.index, null);
          }
        }),
      );
    }

    const totalRunning = [...activeByPool.values()].reduce((n, a) => n + a.running, 0);
    const totalQueued = [...activeByPool.values()].reduce((n, a) => n + a.queued, 0);

    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            network: cfg.TEZOS_NETWORK,
            running: Boolean(lock),
            holder: lock?.holder ?? null,
            port: cfg.PORT,
            jobsByStatus: Object.fromEntries(jobCounts),
            workers: Array.from({ length: cfg.WORKER_COUNT }, (_, i) => ({
              index: i,
              tz1: workers.find((w) => w.index === i)?.tz1 ?? null,
              gasXtz: gas.get(i) ?? null,
              queued: activeByPool.get(i)?.queued ?? 0,
              running: activeByPool.get(i)?.running ?? 0,
            })),
            inFlight: totalRunning,
            pending: totalQueued,
            recentFailures: failures.map((f) => ({
              taskId: f.taskId,
              jobId: f.jobId,
              kind: f.kind,
              error: store.getJob(f.jobId)?.errorMessage ?? null,
            })),
          },
          null,
          2,
        ),
      );
      return;
    }

    const dot = lock ? '●' : '○';
    const live = lock ? `running   (lock ${lock.holder}, ${Math.round(lock.ageMs / 1000)}s ago)` : 'not running (no live instance lock)';
    console.log(`\nshield-relay status — ${cfg.TEZOS_NETWORK}\n`);
    console.log(`  relay      ${dot} ${live}`);
    console.log(`  endpoint   :${cfg.PORT}  ${cfg.METRICS_TOKEN ? '/metrics (token-gated)' : '/metrics (disabled)'}`);

    console.log(`\n  workers    ${'idx'.padEnd(4)} ${'gas(XTZ)'.padEnd(11)} active(q/r)`);
    for (let i = 0; i < cfg.WORKER_COUNT; i++) {
      const g = gas.get(i);
      const a = activeByPool.get(i) ?? { queued: 0, running: 0 };
      const gasStr = g == null ? '—' : g.toFixed(3);
      const low = g != null && g < cfg.LOW_BALANCE_XTZ ? '  ⚠ low' : '';
      console.log(`             ${String(i).padEnd(4)} ${gasStr.padEnd(11)} ${a.queued} / ${a.running}${low}`);
    }
    if (gasNote) console.log(`             (${gasNote})`);

    const order: JobStatus[] = [
      'completed', 'injecting_user_tx', 'payment_confirmed', 'verifying_payment',
      'queued', 'info_generated', 'payment_failed', 'user_tx_failed',
    ];
    const parts = order.filter((s) => jobCounts.get(s)).map((s) => `${s} ${jobCounts.get(s)}`);
    console.log(`\n  jobs       ${parts.length ? parts.join(' · ') : '(none yet)'}`);
    console.log(`  work       ${totalRunning} in-flight · ${totalQueued} pending`);

    if (failures.length) {
      console.log(`\n  recent failures (${failures.length})`);
      for (const f of failures) {
        const job = store.getJob(f.jobId);
        const err = (job?.errorMessage ?? '').replace(/\s+/g, ' ').slice(0, 44);
        const age = job ? humanAge(job.createdAt) : '—';
        console.log(`    ✗ ${shortJob(f.jobId)}  ${(KIND_SHORT[f.kind] ?? f.kind).padEnd(8)} ${age.padEnd(4)} ${err}`);
      }
      console.log(`\n    recover with \`relay jobs retry <id>\` / \`discard\` (relay must be stopped)`);
    }
    console.log('');
  };

  const watchSecs = opts.watch ? Number(opts.watch) : 0;
  if (watchSecs > 0 && !opts.json) {
    const tick = async (): Promise<void> => {
      process.stdout.write('\x1b[2J\x1b[H'); // clear screen + cursor home
      await render();
      process.stdout.write(`  (refreshing every ${watchSecs}s — Ctrl-C to exit)\n`);
    };
    await tick();
    const timer = setInterval(() => void tick(), watchSecs * 1000);
    await new Promise<void>((resolve) => {
      const stop = (): void => {
        clearInterval(timer);
        resolve();
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
    });
    store.close();
    return;
  }

  await render();
  store.close();
}
