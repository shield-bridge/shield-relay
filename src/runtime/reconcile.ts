import type { TezosToolkit } from '@tezos-x/octez.js';
import type { BroadcastState } from '../store/index.js';

/** What to do with a task that threw, given whether a broadcast was in flight. */
export type TaskErrorAction = 'fail' | 'reconcile' | 'park';

/**
 * Decide how to handle an error thrown by a payment/inject task.
 *
 * The load-bearing rule (mirrors the Shield Bridge serverless injector): NEVER write a
 * terminal `*_failed` for a job whose broadcast may have landed. A pre-broadcast error
 * (`broadcastState === 'none'`) is a genuine failure — nothing was sent. But once a
 * broadcast is in flight, an unknown/transient error (e.g. an RPC blip during the
 * post-broadcast applied-check) does NOT mean the op failed — it may have landed and
 * paid the worker / moved the user's funds. Flipping such a job to `*_failed` would
 * strand the fee and report a false failure to the client. So:
 *   - 'none'                    → 'fail'      (terminal, nothing was broadcast)
 *   - broadcast in flight, tries < max → 'reconcile' (re-run to resolve from chain state)
 *   - broadcast in flight, exhausted   → 'park'      (leave non-terminal + recoverable)
 *
 * Note: a KNOWN on-chain failure (the explicit applied-check / scan saying "did not
 * apply") is handled directly by the caller's failPayment path, not here — this governs
 * only UNKNOWN thrown errors.
 */
export function classifyTaskError(
  broadcastState: BroadcastState,
  tries: number,
  maxTries: number,
): TaskErrorAction {
  if (broadcastState === 'none') return 'fail';
  return tries < maxTries ? 'reconcile' : 'park';
}

/**
 * Read a tz1 account's current counter. We pin this BEFORE `.send()`; after our
 * op confirms, the counter advances by exactly one.
 */
export async function readCounter(client: TezosToolkit, address: string): Promise<number> {
  const contract = await client.rpc.getContract(address);
  return Number(contract.counter ?? 0);
}

/**
 * Decide, on crash-restart, whether a task's broadcast already landed.
 *
 * Because the per-worker queue strictly serializes everything signed by this tz1,
 * NO other op from it can be concurrent — so if the on-chain counter has advanced
 * past the value we pinned before `.send()`, it can only be because OUR op landed.
 * That makes the counter advance a reliable "already broadcast" signal even when
 * the op hash was never durably recorded (crash between send and the hash write).
 *
 * Returns true → skip re-broadcast (resume at the post-send step). The Sapling
 * nullifiers are the ultimate backstop: re-broadcasting the same txns can never
 * double-spend (the chain rejects the duplicate nullifier), so a wrong answer
 * here wastes gas at worst, it cannot lose funds.
 */
export async function broadcastAlreadyLanded(
  client: TezosToolkit,
  address: string,
  pinnedCounter: number,
): Promise<boolean> {
  const current = await readCounter(client, address);
  return current > pinnedCounter;
}
