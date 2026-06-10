import { z } from 'zod';

/**
 * THE single source of truth for every environment variable the relay reads.
 * Parsed once at boot (config/load.ts); nothing else may touch process.env.
 *
 * P1 (MVP) surface. The full knob set (sweep, grief breaker, alerting, etc.)
 * from DESIGN.md §7 is layered in during P2/P3.
 */

const bool = z
  .enum(['true', 'false', '1', '0', 'yes', 'no', 'on', 'off'])
  .transform((v) => ['true', '1', 'yes', 'on'].includes(v));

const NETWORKS = ['mainnet', 'shadownet'] as const;

/** V2 Factory contract per network (mirrors shield-bridge SHIELD_BRIDGE_CONTRACT). */
const DEFAULT_FACTORY: Record<(typeof NETWORKS)[number], string> = {
  mainnet: 'KT1WqGXxe5Anam6Hm6zQqGmaXdtZrzZRynnw',
  shadownet: 'KT1Q81ZGgciw6tLfbwuPuYiJ8WyxkwzJeESQ',
};

const DEFAULT_RPC: Record<(typeof NETWORKS)[number], string> = {
  mainnet: 'https://rpc.tzkt.io/mainnet',
  shadownet: 'https://rpc.shadownet.teztnets.com',
};

export const ConfigSchema = z
  .object({
    TEZOS_NETWORK: z.enum(NETWORKS).default('mainnet'),
    TEZOS_RPC_URL: z.string().url().optional(),
    SHIELD_BRIDGE_CONTRACT: z.string().optional(),

    PAYMENT_AMOUNT_MUTEZ: z.coerce.bigint().default(1_000_000n),

    WORKER_COUNT: z.coerce.number().int().positive().default(1),
    MAX_CONCURRENT_PROOFS: z.coerce.number().int().positive().default(2),
    REQUIRE_JOB_SECRET: bool.default('true'),

    // Secrets — exactly one source must resolve (validated in pool loading).
    POOL_FILE: z.string().optional(),
    POOL_JSON: z.string().optional(),

    DATA_DIR: z.string().default('./data'),
    DATABASE_URL: z.string().optional(),
    ALLOW_NETWORK_FS: bool.default('false'),

    SAPLING_PARAMS_URL: z.string().optional(), // file:///opt/sapling-params/ in the image

    CONFIRMATIONS_PHASE1: z.coerce.number().int().positive().default(2),
    CONFIRMATIONS_PHASE2: z.coerce.number().int().positive().default(1),

    GAS_REFILL_THRESHOLD_XTZ: z.coerce.number().nonnegative().default(5),
    GAS_REFILL_INTERVAL_MS: z.coerce.number().int().positive().default(6 * 60 * 60 * 1000),

    JOB_TTL_SECONDS: z.coerce.number().int().positive().default(3600),

    PORT: z.coerce.number().int().positive().default(8080),
    RATE_LIMIT_RPM: z.coerce.number().int().positive().default(120),

    DRAIN_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
    RETAIN_CLIENT_IPS: bool.default('false'),

    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  })
  .transform((c) => ({
    ...c,
    // Resolve network-derived defaults once.
    rpcUrl: c.TEZOS_RPC_URL ?? DEFAULT_RPC[c.TEZOS_NETWORK],
    factoryContract: c.SHIELD_BRIDGE_CONTRACT ?? DEFAULT_FACTORY[c.TEZOS_NETWORK],
  }));

export type Config = z.infer<typeof ConfigSchema>;
