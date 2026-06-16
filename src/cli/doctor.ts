import { totalmem, freemem } from 'node:os';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { TezosToolkit } from '@tezos-x/octez.js';
import { InMemorySigner } from '@tezos-x/octez.js-signer';
import { loadConfig } from '../config/load.js';
import { loadPoolSecrets } from '../sapling/pool.js';
import { resolveSetAddress } from '../core/setAddress.js';
import { SqliteStore } from '../store/sqlite.js';

type Status = 'ok' | 'warn' | 'fail';
interface Check {
  name: string;
  status: Status;
  detail: string;
}

const GB = 1024 ** 3;

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '0.0.0.0');
  });
}

/** `relay doctor` — fast preflight; tells the operator exactly what's misconfigured. */
export async function doctor(): Promise<void> {
  const checks: Check[] = [];
  const add = (name: string, status: Status, detail: string): void => {
    checks.push({ name, status, detail });
  };

  const cfg = loadConfig();
  add('config', 'ok', `network=${cfg.TEZOS_NETWORK} workers=${cfg.WORKER_COUNT} requireJobSecret=${cfg.REQUIRE_JOB_SECRET}`);

  const client = new TezosToolkit(cfg.rpcUrl);

  try {
    const header = await client.rpc.getBlockHeader();
    add('rpc', 'ok', `${cfg.rpcUrl} @ level ${header.level}`);
  } catch (e) {
    add('rpc', 'fail', `${cfg.rpcUrl}: ${e instanceof Error ? e.message : 'unreachable'}`);
  }

  try {
    const xtzSet = await resolveSetAddress(client, cfg.factoryContract);
    add('factory', 'ok', `${cfg.factoryContract} → XTZ Set ${xtzSet}`);
  } catch (e) {
    add('factory', 'fail', `${cfg.factoryContract}: ${e instanceof Error ? e.message : 'unresolved'}`);
  }

  try {
    const secrets = loadPoolSecrets(cfg);
    add('pool', 'ok', `${secrets.addresses.length} worker secret(s) loaded`);
    const n = Math.min(cfg.WORKER_COUNT, secrets.addresses.length);
    for (let i = 0; i < n; i++) {
      const s = secrets.addresses[i]!;
      try {
        const signer = await InMemorySigner.fromSecretKey(s.tezosSecretKey);
        const tz1 = await signer.publicKeyHash();
        const balXtz = (await client.tz.getBalance(tz1)).toNumber() / 1_000_000;
        const status: Status = balXtz >= cfg.LOW_BALANCE_XTZ ? 'ok' : 'warn';
        add(
          `worker ${i} gas`,
          status,
          `${tz1}  ${balXtz.toFixed(3)} XTZ${status === 'warn' ? `  (< ${cfg.LOW_BALANCE_XTZ} — fund it)` : ''}`,
        );
      } catch (e) {
        add(`worker ${i}`, 'fail', `bad key: ${e instanceof Error ? e.message : 'invalid'}`);
      }
    }
  } catch (e) {
    add('pool', 'fail', e instanceof Error ? e.message : 'pool secret missing/invalid');
  }

  // The relay is a pure tz1 broadcaster (no ZK proving), so it needs only a few
  // hundred MB regardless of WORKER_COUNT — just a sanity headroom check.
  const needGb = 0.5;
  const freeGb = freemem() / GB;
  add(
    'ram',
    freeGb >= needGb ? 'ok' : 'warn',
    `${freeGb.toFixed(1)} GB free / ${(totalmem() / GB).toFixed(1)} GB total; the relay needs only a few hundred MB regardless of worker count`,
  );

  try {
    const store = new SqliteStore(join(cfg.DATA_DIR, 'relay.db'));
    store.init();
    store.close();
    add('store', 'ok', `${join(cfg.DATA_DIR, 'relay.db')} writable`);
  } catch (e) {
    add('store', 'fail', e instanceof Error ? e.message : 'not writable');
  }

  add('port', (await portFree(cfg.PORT)) ? 'ok' : 'fail', `:${cfg.PORT}`);

  const icon: Record<Status, string> = { ok: '✓', warn: '!', fail: '✗' };
  console.log('\nshield-relay doctor\n');
  for (const c of checks) console.log(`  ${icon[c.status]} ${c.name.padEnd(15)} ${c.detail}`);
  const fails = checks.filter((c) => c.status === 'fail').length;
  const warns = checks.filter((c) => c.status === 'warn').length;
  console.log(
    `\n${fails ? `✗ ${fails} failure(s)` : '✓ all critical checks passed'}${warns ? `, ${warns} warning(s)` : ''}.\n`,
  );
  if (fails) process.exitCode = 1;
}
