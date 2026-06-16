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
  mainnet: 'https://tezos-mainnet.octez.io',
  shadownet: 'https://tezos-shadownet.octez.io',
};

export const ConfigSchema = z
  .object({
    TEZOS_NETWORK: z.enum(NETWORKS).default('mainnet'),
    TEZOS_RPC_URL: z.string().url().optional(),
    SHIELD_BRIDGE_CONTRACT: z.string().optional(),

    PAYMENT_AMOUNT_MUTEZ: z.coerce.bigint().nonnegative().default(1_000_000n),

    // Quantized fee schedule (FEE_SCHEDULE.md). Defaults reproduce the flat fee
    // EXACTLY (ships dark): base=PAYMENT_AMOUNT (resolved below), perTx=0, quantum=1,
    // legacy cap off. Operators opt in with the recommended 300k/270k/250k + cap=5.
    FEE_BASE_MUTEZ: z.coerce.bigint().nonnegative().optional(),
    FEE_PER_TX_MUTEZ: z.coerce.bigint().nonnegative().default(0n),
    FEE_QUANTUM_MUTEZ: z.coerce.bigint().positive().default(1n),
    LEGACY_FLAT_MAX_TXS: z.coerce.number().int().nonnegative().default(0), // 0 = no cap

    // Default 2 so Phase-1 payment and Phase-2 broadcast run on DISTINCT tz1
    // addresses (the two-worker unlinkability property). With 1 worker both phases
    // collapse onto one tz1, making the public fee receipt pairable with the user op.
    WORKER_COUNT: z.coerce.number().int().positive().default(2),
    REQUIRE_JOB_SECRET: bool.default('true'),

    // Secrets — exactly one source must resolve (validated in pool loading).
    POOL_FILE: z.string().optional(),
    POOL_JSON: z.string().optional(),

    DATA_DIR: z.string().default('./data'),

    CONFIRMATIONS_PHASE1: z.coerce.number().int().positive().default(2),
    CONFIRMATIONS_PHASE2: z.coerce.number().int().positive().default(1),

    // Low-gas watchdog: warn/alert when a worker's tz1 falls below this (no auto-refill —
    // under unshield payments workers self-fund, so a low balance means seed/misconfig).
    LOW_BALANCE_XTZ: z.coerce.number().nonnegative().default(5),
    BALANCE_CHECK_INTERVAL_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(6 * 60 * 60 * 1000),

    JOB_TTL_SECONDS: z.coerce.number().int().positive().default(3600),

    PORT: z.coerce.number().int().positive().default(8080),
    // Per-IP HTTP request cap (enforced via @fastify/rate-limit).
    RATE_LIMIT_RPM: z.coerce.number().int().positive().default(120),
    // Set true ONLY behind a trusted reverse proxy (e.g. the compose Caddy) so the
    // rate limiter keys on X-Forwarded-For. Leave false when 8080 is exposed directly
    // (else a client could spoof XFF to dodge the per-IP limit).
    TRUST_PROXY: bool.default('false'),

    DRAIN_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
    RETAIN_CLIENT_IPS: bool.default('false'),

    ALERT_WEBHOOK_URL: z.string().url().optional(),
    // /metrics is OFF by default (privacy relay: per-worker gas + queue depth are
    // deanonymization-relevant metadata). Set a token to enable it; scrapers then
    // pass `Authorization: Bearer <token>`.
    METRICS_TOKEN: z.string().min(1).optional(),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
      .default('info'),
  })
  .transform((c) => ({
    ...c,
    // Resolve network-derived defaults once.
    rpcUrl: c.TEZOS_RPC_URL ?? DEFAULT_RPC[c.TEZOS_NETWORK],
    factoryContract:
      c.SHIELD_BRIDGE_CONTRACT ?? DEFAULT_FACTORY[c.TEZOS_NETWORK],
    // Fee schedule params, grouped. base defaults to the flat amount → dark by default.
    fee: {
      baseMutez: c.FEE_BASE_MUTEZ ?? c.PAYMENT_AMOUNT_MUTEZ,
      perTxMutez: c.FEE_PER_TX_MUTEZ,
      quantumMutez: c.FEE_QUANTUM_MUTEZ,
    },
    legacyFlatMaxTxs: c.LEGACY_FLAT_MAX_TXS,
  }))
  // A non-positive effective base would make every quote ≤ 0, turning Phase-1
  // verification (received >= quoted) vacuously true → free injection. Reject at load.
  .refine((c) => c.fee.baseMutez > 0n, {
    message:
      'Effective fee base must be > 0 (set FEE_BASE_MUTEZ or PAYMENT_AMOUNT_MUTEZ > 0) — a non-positive base disables payment verification.',
  });

export type Config = z.infer<typeof ConfigSchema>;
