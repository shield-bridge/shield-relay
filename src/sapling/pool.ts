import { readFileSync } from 'node:fs';
import { TezosToolkit } from '@tezos-x/octez.js';
import { InMemorySigner } from '@tezos-x/octez.js-signer';
import { ShieldBridgeSDK } from 'shield-bridge-sdk';
import type { Config } from '../config/schema.js';

export interface WorkerSecret {
  saplingAddress: string;
  saplingMnemonic: string;
  tezosSecretKey: string;
}
export interface PoolSecrets {
  addresses: WorkerSecret[];
}

export interface Worker {
  /** Physical pool index — the WorkerQueue mutex key. */
  index: number;
  saplingAddress: string;
  /** tz1 — the public key hash that signs + pays gas for this worker's ops. */
  tezosAddress: string;
  sdk: ShieldBridgeSDK;
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
 * Build N worker contexts. Each worker gets its OWN ShieldBridgeSDK with
 * `parallelThreads: true` — i.e. an isolated worker_threads Sapling proving
 * context. This is non-negotiable: `parallelThreads: false` aliases every SDK to
 * one process-global singleton sapling core, so concurrent workers would corrupt
 * each other's spending keys (DESIGN.md §1).
 *
 * After build, every cross-WORKER proof is safe to run concurrently; same-worker
 * ops are still serialized by the WorkerQueue (counter/notes).
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

    // Assert the secret key matches the advertised tz1 before it can spend gas.
    const sdk = new ShieldBridgeSDK({
      client,
      saplingMnemonic: s.saplingMnemonic,
      tzktApi: cfg.TEZOS_NETWORK,
      shieldBridgeContract: cfg.factoryContract,
      parallelThreads: true,
      ...(cfg.SAPLING_PARAMS_URL ? { saplingParamsUrl: cfg.SAPLING_PARAMS_URL } : {}),
    });
    await sdk.ready;

    workers.push({ index: i, saplingAddress: s.saplingAddress, tezosAddress, sdk, client });
  }
  if (workers.length === 0) throw new Error('Pool is empty after build.');
  return workers;
}
