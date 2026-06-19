import { loadConfig } from '../config/load.js';
import { loadPoolSecrets, buildPool } from '../sapling/pool.js';
import type { Config } from '../config/schema.js';

/**
 * `relay registry …` — list this relay in the on-chain Relay Registry so Shield Bridge clients
 * can DISCOVER it (sapling-contracts/RELAY_REGISTRY.md). The operator never hand-crafts an
 * operation: these subcommands read the relay's own pool + config and sign from worker 0.
 *
 *   register   — bind the pool's worker tz1s + descriptor_url, lock the refundable min_deposit.
 *   update     — change only the descriptor_url (worker keys are immutable).
 *   deregister — leave the live index immediately (stop being discovered); starts the unbond timer.
 *   withdraw   — after the unbond period, refund the deposit and free the entry + worker keys.
 *   show       — print this operator's current registry entry (or "not registered").
 *
 * register/update/deregister/withdraw SPEND from worker 0 (gas, plus the deposit on register), so
 * that key must be funded. The contract's own guards (ALREADY_REGISTERED, deposit floor, unbond
 * timer, …) are surfaced verbatim as the failwith on a rejected op.
 */

// Structural view of the registry contract handle — the subset of octez.js's ContractAbstraction
// we drive — so we don't couple to octez.js's exact exported types.
interface SentOp {
  hash: string;
  confirmation: (confirmations?: number) => Promise<unknown>;
}
interface RegistryEntry {
  operator: string;
  worker_keys: string[];
  descriptor_url: string;
  registered_at?: string;
  unbond_at?: string | null;
}
interface RegistryStorage {
  index: string[];
  relays: { get: (op: string) => Promise<RegistryEntry | undefined> };
}
interface RegistryContract {
  methodsObject: {
    register: (p: { worker_keys: string[]; descriptor_url: string }) => {
      send: (params?: { amount: number; mutez: boolean }) => Promise<SentOp>;
    };
    update: (p: { descriptor_url: string }) => { send: () => Promise<SentOp> };
  };
  methods: {
    deregister: () => { send: () => Promise<SentOp> };
    withdraw: () => { send: () => Promise<SentOp> };
  };
  storage: () => Promise<RegistryStorage>;
}

/** Shared setup: config, the registry contract bound to worker 0's signer, and the pool tz1s. */
async function ctx(): Promise<{ cfg: Config; operator: string; workerKeys: string[]; registry: RegistryContract }> {
  const cfg = loadConfig();
  const pool = await buildPool(cfg, loadPoolSecrets(cfg));
  const operatorWorker = pool[0]!; // worker 0 is the operator identity + signer
  const registry = (await operatorWorker.client.contract.at(cfg.registryContract)) as unknown as RegistryContract;
  return { cfg, operator: operatorWorker.tezosAddress, workerKeys: pool.map((w) => w.tezosAddress), registry };
}

/** descriptor_url for the entry: the explicit --url, else RELAY_PUBLIC_URL. Trailing slash trimmed. */
function resolveDescriptorUrl(cfg: Config, urlOpt?: string): string {
  const url = (urlOpt ?? cfg.RELAY_PUBLIC_URL ?? '').trim().replace(/\/+$/, '');
  if (!url) {
    throw new Error(
      'No descriptor URL: pass --url https://relay.example.com or set RELAY_PUBLIC_URL. ' +
        'It must be the public https origin serving /info + /.well-known/shield-relay.json.',
    );
  }
  if (!/^https:\/\//.test(url)) throw new Error(`Descriptor URL must be https:// (got ${url}).`);
  return url;
}

async function confirm(label: string, op: SentOp): Promise<void> {
  console.log(`${label}: ${op.hash} — waiting for confirmation…`);
  await op.confirmation(1);
  console.log(`${label}: confirmed.`);
}

export async function registryRegister(opts: { url?: string }): Promise<void> {
  const { cfg, operator, workerKeys, registry } = await ctx();
  const descriptorUrl = resolveDescriptorUrl(cfg, opts.url);
  const depositTez = Number(cfg.registryMinDepositMutez) / 1_000_000;
  console.log(`Registering relay on ${cfg.TEZOS_NETWORK}`);
  console.log(`  registry      ${cfg.registryContract}`);
  console.log(`  operator      ${operator} (worker 0)`);
  console.log(`  worker_keys   ${workerKeys.join(', ')}`);
  console.log(`  descriptor    ${descriptorUrl}`);
  console.log(`  deposit       ${depositTez} XTZ (refundable on withdraw after the unbond period)`);
  const op = await registry.methodsObject
    .register({ worker_keys: workerKeys, descriptor_url: descriptorUrl })
    .send({ amount: Number(cfg.registryMinDepositMutez), mutez: true });
  await confirm('register', op);
  console.log('Listed. Clients will discover this relay on their next registry read.');
}

export async function registryUpdate(opts: { url?: string }): Promise<void> {
  const { cfg, registry } = await ctx();
  const descriptorUrl = resolveDescriptorUrl(cfg, opts.url);
  console.log(`Updating descriptor_url → ${descriptorUrl}`);
  await confirm('update', await registry.methodsObject.update({ descriptor_url: descriptorUrl }).send());
}

export async function registryDeregister(): Promise<void> {
  const { registry } = await ctx();
  console.log('Deregistering (leaves the live index immediately; starts the unbond timer)…');
  await confirm('deregister', await registry.methods.deregister().send());
  console.log('Deregistered. Run `relay registry withdraw` after the unbond period to refund the deposit.');
}

export async function registryWithdraw(): Promise<void> {
  const { registry } = await ctx();
  console.log('Withdrawing (refunds the deposit + frees the entry; only valid after the unbond period)…');
  await confirm('withdraw', await registry.methods.withdraw().send());
}

export async function registryShow(): Promise<void> {
  const { cfg, operator, registry } = await ctx();
  const storage = await registry.storage();
  const listed = Array.isArray(storage.index) && storage.index.includes(operator);
  const entry = await storage.relays.get(operator).catch(() => undefined);
  console.log(`Operator ${operator} on ${cfg.TEZOS_NETWORK}:`);
  if (!entry) {
    console.log('  not registered. Run `relay registry register --url <https origin>`.');
    return;
  }
  console.log(`  listed         ${listed ? 'yes' : 'no (deregistered — awaiting withdraw)'}`);
  console.log(`  descriptor     ${entry.descriptor_url}`);
  console.log(`  worker_keys    ${(entry.worker_keys ?? []).join(', ')}`);
  if (entry.registered_at) console.log(`  registered_at  ${entry.registered_at}`);
  if (entry.unbond_at) console.log(`  unbond_at      ${entry.unbond_at} (withdraw allowed after this)`);
}
