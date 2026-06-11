import { readFileSync } from 'node:fs';
import { TezosToolkit } from '@tezos-x/octez.js';
import { InMemorySigner } from '@tezos-x/octez.js-signer';
import type { Config } from '../config/schema.js';

export interface WorkerSecret {
  /** tz1 secret key — the worker signs, pays gas, and receives fees with this. */
  tezosSecretKey: string;
  /** Vestigial under the unshield-payment model (workers never touch a sapling account).
   *  Accepted for back-compat with existing pool files; ignored at runtime. */
  saplingMnemonic?: string;
  saplingAddress?: string;
}
export interface PoolSecrets {
  addresses: WorkerSecret[];
}

export interface Worker {
  /** Physical pool index — the WorkerQueue mutex key. */
  index: number;
  /** tz1 — the public key hash that signs + pays gas for, and receives fees on, this worker. */
  tezosAddress: string;
  client: TezosToolkit;
}

/** Load the worker pool secret from POOL_JSON or POOL_FILE (exactly one). */
export function loadPoolSecrets(cfg: Config): PoolSecrets {
  const raw = cfg.POOL_JSON ?? (cfg.POOL_FILE ? readFileSync(cfg.POOL_FILE, 'utf8') : undefined);
  if (!raw) throw new Error('No pool secret: set POOL_FILE or POOL_JSON (see `relay init`).');
  let parsed: PoolSecrets;
  try {
    parsed = JSON.parse(raw) as PoolSecrets;
  } catch {
    throw new Error('Pool secret is not valid JSON.');
  }
  if (!Array.isArray(parsed.addresses) || parsed.addresses.length === 0) {
    throw new Error('Pool secret invalid: `addresses` must be a non-empty array.');
  }
  return parsed;
}

/**
 * Build N worker contexts. Under the unshield-payment model a worker is just a tz1
 * BROADCASTER: it signs + pays gas for Phase-1/Phase-2 ops and receives fees on its
 * tz1. It never proves or touches a sapling account — so there is no per-worker
 * ShieldBridgeSDK, no worker_threads, and no Sapling proving params; just an octez.js
 * client bound to the worker's signer. (Verification is a node simulation, broadcast is
 * a plain contract call — both pure octez.js.)
 */
export async function buildPool(cfg: Config, secrets: PoolSecrets): Promise<Worker[]> {
  const n = Math.min(cfg.WORKER_COUNT, secrets.addresses.length);
  const workers: Worker[] = [];
  for (let i = 0; i < n; i++) {
    const s = secrets.addresses[i]!;
    const client = new TezosToolkit(cfg.rpcUrl);
    const signer = await InMemorySigner.fromSecretKey(s.tezosSecretKey);
    client.setSignerProvider(signer);
    const tezosAddress = await signer.publicKeyHash();
    workers.push({ index: i, tezosAddress, client });
  }
  if (workers.length === 0) throw new Error('Pool is empty after build.');
  return workers;
}
