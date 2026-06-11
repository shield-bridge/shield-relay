import { createHash } from 'node:crypto';
import type { TezosToolkit } from '@tezos-x/octez.js';
import type { ContractParams } from './types.js';
import { resolveSetAddress } from './setAddress.js';
import { sendSaplingOpCapped } from './broadcast.js';

/**
 * Phase 1 — broadcast the user's payment (a PUBLIC unshield of the relay fee out
 * of the XTZ Set contract to the worker's tz1) from the PAYMENT worker's tz1.
 * `onBroadcast` fires with the op hash *after* `.send()` resolves but *before*
 * confirmation, so the caller can durably record the broadcast intent (P2
 * counter-pin) before awaiting confirmation. Returns the op hash + the level it
 * was included at (for the post-confirmation applied-check).
 *
 * SECURITY: the caller MUST gate this on {@link verifyPaymentUnshield} first.
 * Broadcasting an unverified op is the original free-injection hole — this
 * function only sends; the gate (verify-before-broadcast) lives in the processor.
 */
export async function broadcastPayment(
  client: TezosToolkit,
  factoryAddress: string,
  payment: ContractParams,
  confirmations: number,
  onBroadcast?: (opHash: string) => void,
): Promise<{ hash: string; level: number }> {
  const xtzSetAddress = await resolveSetAddress(client, factoryAddress);
  const setContract = await client.contract.at(xtzSetAddress);
  const op = await sendSaplingOpCapped(client, setContract.methodsObject.default!(payment.txns), 'payment');
  onBroadcast?.(op.hash);
  await op.confirmation(confirmations);
  return { hash: op.hash, level: op.includedInBlock };
}

/**
 * Post-confirmation check: re-read the broadcast payment op from its inclusion block
 * and require it actually APPLIED and paid >= `expectedMutez` to the worker's tz1.
 *
 * This closes the proof-malleability race: two re-randomized unshields spending the
 * SAME note can both pass the pre-broadcast simulation (note still unspent) and both
 * get broadcast on different workers; one lands, the OTHER is included as `failed`
 * (nullifier double-spend). The pre-broadcast gate can't see that — only the on-chain
 * result can — so without this the failed op would still flip the job to confirmed and
 * let its Phase 2 inject for free. Reuses {@link sumAppliedTransfersTo}: a `failed`
 * top-level op contributes nothing, so it fails the check.
 */
export async function verifyPaymentLanded(
  client: TezosToolkit,
  opHash: string,
  level: number,
  workerTz1: string,
  expectedMutez: bigint,
): Promise<{ ok: boolean; receivedMutez: bigint }> {
  const block = (await client.rpc.getBlock({ block: String(level) })) as {
    operations?: { hash?: string; contents?: SimContent[] }[][];
  };
  // Manager operations live in validation pass index 3.
  const entry = block.operations?.[3]?.find((o) => o.hash === opHash);
  if (!entry?.contents) return { ok: false, receivedMutez: 0n };
  const receivedMutez = sumAppliedTransfersTo(entry.contents, workerTz1);
  return { ok: receivedMutez >= expectedMutez, receivedMutez };
}

/**
 * Resume-path applied-check: like {@link verifyPaymentLanded} but recovers the inclusion
 * level by SCANNING back from head for `opHash` (we don't persist the level). Used when a
 * crash in the send→confirmation window leaves a job `landed` (counter advanced) but never
 * applied-checked — a malleable same-note loser would have landed as `failed`. Scans up to
 * `maxDepth` recent blocks (the op is recent after a prompt restart), stopping at the first
 * match. `checked:false` ⟹ the op is older than the window (long downtime) — the caller
 * accepts with a log (the residual then needs an active attack AND a long outage: negligible).
 */
export async function verifyPaymentLandedByScan(
  client: TezosToolkit,
  opHash: string,
  workerTz1: string,
  expectedMutez: bigint,
  maxDepth: number,
): Promise<{ checked: boolean; ok: boolean; receivedMutez: bigint }> {
  const header = (await client.rpc.getBlockHeader()) as { level: number };
  for (let level = header.level; level > header.level - maxDepth && level > 0; level--) {
    const block = (await client.rpc.getBlock({ block: String(level) })) as {
      operations?: { hash?: string; contents?: SimContent[] }[][];
    };
    const entry = block.operations?.[3]?.find((o) => o.hash === opHash);
    if (entry?.contents) {
      const receivedMutez = sumAppliedTransfersTo(entry.contents, workerTz1);
      return { checked: true, ok: receivedMutez >= expectedMutez, receivedMutez };
    }
  }
  return { checked: false, ok: false, receivedMutez: 0n };
}

/** The bits of a simulate_operation result we read. Public transparent outputs
 *  only — no sapling decryption is ever needed to verify a payment. */
export interface SimInternalResult {
  kind: string;
  destination?: string;
  amount?: string;
  result?: { status?: string };
}
export interface SimContent {
  metadata?: {
    operation_result?: { status?: string };
    internal_operation_results?: SimInternalResult[];
  };
}

/**
 * Sum the mutez that an operation's APPLIED internal transfers send to `recipient`.
 * A top-level op that did not itself apply contributes nothing (its internals never
 * happened), and an internal transfer is only counted if it too applied. Exported for
 * the money-gate unit tests — this is the whole payment decision in one pure function.
 */
export function sumAppliedTransfersTo(contents: SimContent[], recipient: string): bigint {
  let total = 0n;
  for (const c of contents) {
    const meta = c.metadata;
    if (!meta) continue;
    // The Set-contract call itself must apply; a failed sapling op emits no transfer.
    if (meta.operation_result?.status && meta.operation_result.status !== 'applied') continue;
    for (const ino of meta.internal_operation_results ?? []) {
      const applied = ino.result?.status === undefined || ino.result.status === 'applied';
      if (ino.kind === 'transaction' && ino.destination === recipient && ino.amount && applied) {
        total += BigInt(ino.amount);
      }
    }
  }
  return total;
}

/**
 * Verify — WITHOUT broadcasting — that the submitted Phase-1 op is a genuine
 * payment: when simulated against the node, the XTZ Set contract makes an internal
 * transfer of `>= expectedMutez` to the worker's OWN tz1 (`workerTz1`).
 *
 * This is the firewall. A hijacker who submits an unshield to THEIR address (or any
 * op that doesn't pay the worker) simulates as 0-to-worker and is rejected here,
 * before a single mutez of gas is spent — closing the free-injection / gas-drain
 * hole that an after-the-fact check left open.
 *
 * Robust by construction: an unshield's recipient lives in the (client-chosen,
 * untrusted) sapling bound_data, so we read what the CONTRACT will actually pay out
 * — the simulation's internal_operation_results — rather than any field in the
 * request. `simulate_operation` needs no signature and the prepared op is budgeted
 * with the protocol's hard gas max, so the dry run has room to execute.
 */
export async function verifyPaymentUnshield(
  client: TezosToolkit,
  factoryAddress: string,
  payment: ContractParams,
  workerTz1: string,
  expectedMutez: bigint,
): Promise<{ ok: boolean; receivedMutez: bigint }> {
  const xtzSetAddress = await resolveSetAddress(client, factoryAddress);
  const setContract = await client.contract.at(xtzSetAddress);
  const method = setContract.methodsObject.default!(payment.txns);

  const prepared = await client.prepare.contractCall(method);
  const chainId = await client.rpc.getChainId();
  const sim = (await client.rpc.simulateOperation({
    operation: { branch: prepared.opOb.branch, contents: prepared.opOb.contents },
    chain_id: chainId,
  })) as { contents: SimContent[] };

  const receivedMutez = sumAppliedTransfersTo(sim.contents, workerTz1);
  return { ok: receivedMutez >= expectedMutez, receivedMutez };
}

/**
 * sha256 hex of the payment's sapling txns — the atomic replay key (see the store's
 * consumed_payments guard). Consuming this before broadcast makes the EXACT payment
 * bytes single-use, so the same payment can't be parlayed into two jobs.
 */
export function paymentDigest(payment: ContractParams): string {
  const h = createHash('sha256');
  for (const t of payment.txns) h.update(t);
  return h.digest('hex');
}
