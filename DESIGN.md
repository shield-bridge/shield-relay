# Shield Relay — Architecture

`shield-relay/1` is a wire protocol; this repository is a self-hostable implementation of it.
For the exact on-the-wire contract (endpoints, envelopes, status codes, fee schedule) see
[`docs/SHIELD_RELAY_PROTOCOL.md`](./docs/SHIELD_RELAY_PROTOCOL.md). **The code is the source of
truth**; this document is a high-level map of how the pieces fit together.

## What a relay is

One container = one relay = a pool of N Tezos **tz1 worker accounts** that broadcast a user's
Sapling operation on their behalf for a small fee, so the user's own wallet never appears on-chain.

A worker is *just a broadcaster*. It generates **no zero-knowledge proofs** — the client builds the
opaque Sapling proof; the relay only **simulates, signs, and broadcasts** it. So the process is
lightweight (a few hundred MB of RAM regardless of worker count) and needs no Sapling proving
params and no proving context — each worker is a plain `@tezos-x/octez.js` client bound to its signer.

**Bounded trust.** For the user's real operation the relay only ever sees an **opaque proof**: it
can't see the amount, asset, sender, or recipient, and it can't redirect funds. The worst a
malicious relay can do is **refuse** after being paid — the user loses at most one fee. That
property is what makes a permissionless network of relays safe to use.

## The two phases (and why one worker does both)

1. **Payment.** The user **unshields the fee** to one of the relay's worker tz1s. The relay
   **simulates the operation first** and broadcasts it only if it actually pays that worker at
   least the quoted fee — so it never spends gas on an op that doesn't pay it, nor on a hijack
   attempt. A **permanent replay guard** (a sha256 digest of the payment, in `consumed_payments`,
   never swept) credits each payment exactly once.
2. **Broadcast.** Only **after the payment confirms**, the user submits their real (still-opaque)
   operation, which the **same worker** broadcasts.

The two phases are **coupled onto one worker per job** on purpose: the fee that worker just
received covers the gas it spends, so each job is **self-funding** and a single container runs
unattended with no cross-worker balance drift. (Distinct payment/broadcast workers would unlink the
fee receipt from the broadcast on-chain, but make balances drift — and the user is hidden either
way, since the relay broadcasts, not the user.) Multiple workers still process **distinct jobs in
parallel**.

## Durability & crash-safety

The relay is a durable intent log, not a best-effort queue:

- A **SQLite work-queue** (`store/`) is the durable source of truth. Every job/task state change is
  written in **one transaction before the HTTP 2xx** — so a crash after the commit is recoverable,
  and a crash before it never returned a 2xx (the client retries safely).
- On boot, every non-terminal task is **re-hydrated** and **reconciled**, then re-enqueued in its
  original per-worker order.
- **No double-broadcast.** Before each `.send()` the worker **pins the account counter**; on
  restart, reconcile reads the *current* on-chain counter + recent ops to decide whether the op
  already landed, and re-sends **at most once** (parking to a dead-letter after that). The replay
  guard (Phase 1) and the `payment_confirmed` status gate (Phase 2) make an accidental re-send
  harmless regardless.
- Same-tz1 ops are **serialized by a per-worker promise-chain mutex** (`runtime/workerQueue.ts`) so
  two ops from one account can't race its counter; different workers run concurrently.

## Status, storage, config

- **Status is pull-based**: clients poll `GET /status`. There is no WebSocket — one HTTP surface,
  one port, no upgrade handling.
- **Storage is local SQLite** (WAL). A networked filesystem is refused on boot (it corrupts the WAL
  and the single-writer lock).
- **One process owns the pool**, guarded by a single-writer `instance_lock` so a second process
  can't run against the same workers.
- **Config is one `zod` schema** (`config/schema.ts`) — the only reader of `process.env`;
  `.env.example` mirrors it 1:1.
- **Workers self-fund** (the fee lands on the worker tz1), so there is no auto gas-refill — just a
  low-balance **watchdog** that alerts when a worker needs seeding.

## Code layout

```
src/
  cli/        relay init | start | doctor | status | jobs | registry
  config/     schema.ts (zod, the only env reader) + load.ts
  server/     Fastify HTTP: routes, auth (per-job secret), /status frames,
              health (/healthz,/readyz), info (/.well-known/shield-relay.json)
  runtime/    workerQueue (per-tz1 mutex), processor, reconcile (counter-pin),
              rehydrate (boot recovery), instanceLock
  core/       framework-free domain: payment (verify-before-broadcast), inject,
              broadcast, reveal, setAddress, feeSchedule, jobs (status machine)
  sapling/    pool.ts — build N tz1 worker clients from the pool secret
  store/      sqlite.ts (+ index.ts) — durable jobs / work_queue / consumed_payments
  observability/  logger (redaction), metrics, balance watchdog, alerting
```

## Security posture

- **jobSecret** — a per-job shared secret gates submit/subscribe (`timingSafeEqual`, sha256 at
  rest); a wrong secret is always rejected.
- **Secrets never leave the process** — pool keys load from `POOL_FILE`/`POOL_JSON`, are asserted
  against their tz1, and a redaction allowlist keeps mnemonics / secret keys / jobSecrets out of logs.
- **Replay / credit-once** — `consumed_payments` is permanent and never swept; the on-chain
  nullifier is the ultimate defense, so a replayed payment only re-burns the attacker's own fee.
- **Abuse** — per-IP rate limiting; gas-griefing is structurally unpreventable for a privacy relay
  (a simulation proves nothing post-Sapling), so it's bounded by rate limits + an optional
  anti-spam deposit, not by inspecting the (opaque) op.

---

To list this relay so clients can discover it, see
[**Listing your relay on-chain**](./README.md#listing-your-relay-on-chain).
