import type { Worker } from '../sapling/pool.js';
import type { Logger } from '../observability/logger.js';

// A standalone reveal is ~1000 gas / a few hundred mutez. These explicit limits keep it
// a SINGLE op with NO estimation — sidestepping octez's per-op-max dry-run, which
// inflates a reveal+op batch to 2×the per-operation cap and overflows the block gas
// limit on tight-limit protocols (Tallinn: block == op == 1,040,000 gas).
const REVEAL_FEE_MUTEZ = 1_000;
const REVEAL_GAS_LIMIT = 2_000;

/**
 * Turnkey worker setup: ensure every worker tz1's public key is revealed on-chain.
 *
 * The FIRST operation from an unrevealed account bundles a reveal; the relay's first
 * real op would therefore be a 2-op (reveal + sapling) batch, which fails with a cryptic
 * `gas_limit_too_high` because the estimator's dry-run declares 2×the per-op gas cap. A
 * standalone reveal (one op, explicit gas) fixes it once and for all.
 *
 * Idempotent + best-effort: already-revealed workers are skipped (a cheap manager_key
 * read), unfunded ones are warned about, and a transient failure is logged and retried
 * on the next boot. Awaited BEFORE the relay serves traffic, so no job is ever routed to
 * a worker that can't broadcast.
 */
export async function ensureWorkersRevealed(workers: Worker[], logger: Logger): Promise<void> {
  await Promise.all(
    workers.map(async (w) => {
      try {
        const managerKey = await w.client.rpc.getManagerKey(w.tezosAddress).catch(() => null);
        if (managerKey) return; // already revealed — nothing to do

        const balanceMutez = (await w.client.tz.getBalance(w.tezosAddress)).toNumber();
        if (balanceMutez <= REVEAL_FEE_MUTEZ) {
          logger.warn(
            { worker: w.index, tz1: w.tezosAddress },
            'worker is unrevealed AND unfunded — send it gas, then restart (the relay reveals it on boot)',
          );
          return;
        }

        logger.info({ worker: w.index, tz1: w.tezosAddress }, 'revealing worker public key (first-time setup)…');
        const op = await w.client.contract.reveal({
          fee: REVEAL_FEE_MUTEZ,
          gasLimit: REVEAL_GAS_LIMIT,
          storageLimit: 0,
        });
        await op.confirmation(1);
        logger.info({ worker: w.index, tz1: w.tezosAddress, opHash: op.hash }, 'worker revealed');
      } catch (e) {
        logger.warn(
          { worker: w.index, tz1: w.tezosAddress, err: e instanceof Error ? e.message : String(e) },
          'worker reveal failed — its operations will fail until it is revealed (retried next boot)',
        );
      }
    }),
  );
}
