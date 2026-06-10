import type { Config } from '../config/schema.js';

/**
 * The relay's public capability descriptor (GET /info). Pure read, no side effects —
 * lets a client preview the fee BEFORE minting a job, and hard-check it's talking to a
 * relay on the right network/contract. The first brick of the P4 discovery descriptor.
 */
export interface RelayInfo {
  protocol: string;
  network: string;
  factoryContract: string;
  fee: { model: 'flat' | 'scheduled'; flatMutez: string };
  feeSchedule: { baseMutez: number; perTxMutez: number; quantumMutez: number };
}

export function buildRelayInfo(cfg: Config): RelayInfo {
  return {
    protocol: 'shield-relay/1',
    network: cfg.TEZOS_NETWORK,
    factoryContract: cfg.factoryContract,
    fee: {
      model: cfg.fee.perTxMutez > 0n ? 'scheduled' : 'flat',
      flatMutez: String(cfg.PAYMENT_AMOUNT_MUTEZ), // legacy / no-txCount quote
    },
    feeSchedule: {
      baseMutez: Number(cfg.fee.baseMutez),
      perTxMutez: Number(cfg.fee.perTxMutez),
      quantumMutez: Number(cfg.fee.quantumMutez),
    },
  };
}
