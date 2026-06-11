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
 * counter-pin) before awaiting confirmation. Returns the op hash.
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
): Promise<string> {
  const xtzSetAddress = await resolveSetAddress(client, factoryAddress);
  const setContract = await client.contract.at(xtzSetAddress);
  const op = await sendSaplingOpCapped(client, setContract.methodsObject.default!(payment.txns), 'payment');
  onBroadcast?.(op.hash);
  await op.confirmation(confirmations);
  return op.hash;
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
