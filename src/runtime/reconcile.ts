import type { TezosToolkit } from '@tezos-x/octez.js';

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
