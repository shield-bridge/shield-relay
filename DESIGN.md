# Shield Relay — Build-Ready Blueprint (`shield-relay/1`)

*Lead-architect synthesis of 5 design lenses + 3 red-teams, **verified against `shield-bridge-sdk` source**, the Lambda code, and this scaffold. 2026-06-09. Supersedes the earlier draft.*

> **⚠ SUPERSEDED IN PART — read this first (2026-06).** The payment model below (a
> *shielded* 1-XTZ transfer carrying a *memo*, verified after broadcast) was replaced by
> **option B**: Phase-1 payment is now a **public unshield of the fee to the worker's
> tz1, verified BEFORE broadcast** by a node simulation (`verifyPaymentUnshield` →
> `simulateOperation`, reading the contract's `internal_operation_results`). No memo; the
> replay guard is a sha256 of the payment bytes; a post-confirmation applied-check closes
> the same-note malleability race. Knock-on changes that invalidate sections below:
> - **No Sapling proving in the relay.** It only simulates + signs (pure octez.js), so the
>   per-worker `ShieldBridgeSDK`, `parallelThreads:true`, `worker_threads`, the ~49 MB
>   proving params, and the **~1.2–1.5 GB/worker RAM model + `MAX_CONCURRENT_PROOFS`** are
>   GONE. A worker is now just `{ index, tezosAddress, client }`; the image is a slim
>   broadcaster (mem sized ~256–512 MB).
> - **Gas-refill removed.** Fees land directly as public tz1 XTZ, so workers self-fund;
>   the `gas_refill` WorkKind + `refillScheduler` are replaced by a read-only low-gas
>   *watchdog* alert. (`WORKER_FLOAT_CAP`/`SWEEP_ADDRESS` → a future tz1→treasury sweep.)
> - **Two-worker unlinkability:** Phase 1 (payment) and Phase 2 (broadcast) run on
>   *distinct* workers so the public fee receipt can't be paired with the user's op.
> - **WS/transport hardening:** heartbeat reaper, `MAX_CONNECTIONS`, enforced
>   `RATE_LIMIT_RPM` (+ `TRUST_PROXY`).
>
> `shield-relay/1` is now a wire PROTOCOL with two implementations (this container + the
> AWS serverless relay). **The code is the source of truth**; the rationale below is kept
> as the historical design record (the SDK/RAM/refill/per-worker-mutex reasoning still
> explains *why* the scaffold was shaped as it was).

> **Status correction (read first):** one design-agent finding claimed the in-tree backend "has no jobSecret and broadcasts Phase-2 from the same worker," contradicting "Phase 0 enforced." That is an artifact of the agents reading the **v3 checkout**, whose `infrastructure/serverless` never received the Phase 0 *backend* merge (Phase 0 landed on `main`). **Phase 0 is live + enforced on mainnet** — verified `401`(no secret)/`403`(wrong)/`409`(right) against `api.shieldbridge.xyz`. The migration gate below still holds: freeze the reference wire from the **live prod relay**, not from a checkout.

---

## 1. Verdict

**Yes — a single-container, multi-host, self-migratable relay is achievable, but ONLY after correcting one fatal architecture error the lenses all shared.** The headline shape: **one Node 22 process = one logical relay owning N workers, where each worker is an isolated `worker_threads` SDK context (`parallelThreads:true`), serialized by a per-*physical-tz1* promise-chain mutex, backed by a durable `better-sqlite3` work-queue written *before* every HTTP 2xx, with boot re-hydration and counter-pinned reconcile-on-restart, in-process `ws` fan-out, and an in-queue gas-refill.** The lenses' unanimous "per-worker mutex in `parallelThreads:false` is stronger than SQS FIFO" claim is **false and fatal**: verified at `shield-bridge-sdk/dist/index.js:270-277`, direct mode aliases *every* worker SDK instance to one process-global singleton (`saplingCore.js`: *"singleton state … safe because each execution context loads its own copy"*), and `loadSaplingSecret` overwrites it per-op — so two workers proving concurrently corrupt each other's spending key. The fix is non-negotiable: **`parallelThreads:true`** for real per-thread isolation, which forces an **honest RAM model** (a worker thread active in the reaper window holds ~1.2–1.5 GB resident) and makes `MAX_CONCURRENT_PROOFS` a CPU/RAM-pressure cap, *not* a memory-magic decoupler. With that plus the red-teams' accepted fixes — **counter-pin-before-send reconcile**, **mutex keyed on physical tz1**, **single-transaction `jobs`↔`work_queue` coupling**, **`not_found` kept in the wire status set**, and **a live-prod conformance transcript as the migration gate** — the design matches or beats the AWS baseline and is build-ready.

---

## 2. Tech Stack + Top-Level Decisions

| Concern | Decision | Rationale |
|---|---|---|
| Language/runtime | **TypeScript on Node 22 (ESM, strict)** | SDK + `@tezos-x/octez.js` are JS; Node 22 has stable `worker_threads`, native `fetch`/`file://`, global crypto. |
| Concurrency mode | **`parallelThreads:true` (worker-thread per worker)** | *Red-team fix:* `parallelThreads:false` shares a process-global singleton (verified `index.js:270-277`) → cross-worker key corruption. Threads = real isolation. |
| Server | **Fastify** (HTTP) + **`ws`** (WS on same port via `upgrade`) | Fast, schema-validated, low-dep; in-process fan-out the protocol needs; one port = one ingress rule everywhere. |
| State store | **`better-sqlite3` (WAL, `synchronous=NORMAL`) default; Postgres via `DATABASE_URL`** | Synchronous single-file transactions give the atomic "durable-then-return" path with zero external deps; Postgres for networked-FS / future HA. |
| Durable queue | **SQLite `work_queue` table** (no broker) | The durable row *is* the SQS message; re-hydrated on boot. Redis/NATS would break the single-image goal. |
| In-mem serialization | **Per-physical-tz1 promise-chain mutex** (`Map<poolIndex, Promise>`) | *Red-team fix:* key on physical tz1, not role-index, so one tz1 serving two roles + gas-refill can't race. |
| WS | **`ws`** with `Map<jobId, Set<WebSocket>>`, persist-then-broadcast | In-process fan-out; no Connections table. |
| Container | **Single multi-arch image (`buildx` amd64+arm64), `node:22-bookworm-slim`, params baked** | Glibc base for `better-sqlite3` prebuilds; baked ~52 MB z.cash params → offline/Akash-ready (`file://` verified `saplingCore.js:73-74`). |
| CLI | **`commander`** — `init / start / doctor / keys / jobs` | One binary replaces `setup-secrets.sh` + `InitializePool`; `doctor` = the <30-min DX guarantee. |
| Config | **One `zod` schema, parsed once at boot, fail-fast** | Kills env drift; the only module reading `process.env`. |
| Logging | **`pino` JSON + hard redaction allowlist** | Blocks mnemonic/secret/jobSecret/tx-hex/`paymentTxHash`; no client IP by default. |
| Metrics | **`prom-client` `/metrics` + shipped Grafana dashboard + alert rules** | Cloud-agnostic replacement for the 8 CloudWatch alarms. |
| Secrets | **3-tier: `POOL_FILE` (0600) / `POOL_JSON` / optional `age`\|KMS decrypt-at-rest** | 12-factor across PaaS env-stores and k8s/compose mounts. |
| Alerting | **Pluggable notifier: `ALERT_WEBHOOK_URL` + persistent outbox w/ retry** | *Red-team fix:* critical alerts through a retrying outbox, not fire-and-forget. |

---

## 3. Concrete Repo File Tree

`[lifted]` = re-implemented from verified Lambda source (NOT imported); `[new]` = net-new for the container.

```
shield-relay/
├── package.json                      # bin:relay; deps: shield-bridge-sdk, @tezos-x/octez.js(+ -signer),
│                                     #   fastify, ws, better-sqlite3, pg(optional), zod, pino, prom-client, commander
├── tsconfig.json                     # Node22 ESM strict; emits dist/cli/index.js (shebang)
├── .env.example                      # 1:1 mirror of config/schema.ts
├── .dockerignore                     # excludes node_modules, secrets/, *.db, .git
├── src/
│   ├── cli/                          # index, init, start, doctor, keys, jobs[new]
│   ├── config/                       # schema.ts (zod source of truth) + load.ts (only reader of process.env)
│   ├── runtime/
│   │   ├── workerQueue.ts            # [new] per-PHYSICAL-tz1 promise-chain mutex; enqueue(poolIndex, task)
│   │   ├── semaphore.ts              # [new] global MAX_CONCURRENT_PROOFS cap (CPU/RAM pressure, NOT a RAM oracle)
│   │   ├── rehydrate.ts              # [new] boot: SELECT non-terminal ORDER BY (poolIndex, chainSeq); reconcile; re-enqueue
│   │   ├── reconcile.ts              # [new] counter-pin + recent-ops scan per send-path (the keystone — §4/§6)
│   │   ├── lifecycle.ts              # [new] boot order + SIGTERM drain (stop send()-starts first; bounded)
│   │   └── instanceLock.ts           # [new] exclusive SQLite/PG-advisory lock + heartbeat — refuse 2nd process on same pool
│   ├── sapling/
│   │   ├── pool.ts                   # per-worker ShieldBridgeSDK({...,parallelThreads:true}); await ready
│   │   └── params.ts                 # SHA-256 verify baked params at boot before first proof
│   ├── core/                         # framework-free pure domain
│   │   ├── jobs.ts                   # status state machine over canonical enum (+ not_found on wire)
│   │   ├── setAddress.ts             # [lifted] resolveSetAddress: Factory storage tez/token_fa_1_2/token_fa_2 + cache
│   │   ├── payment.ts                # [lifted] Phase-1: broadcast, conf(2), verify memo — INTEGER mutez compare
│   │   ├── inject.ts                 # [lifted] Phase-2: setContract.methodsObject.default(txns); opHash captured pre-conf
│   │   └── gasRefill.ts              # [lifted] self-funding; default unshield-entire-to-own-tz1 (parity); cap+sweep opt-in
│   ├── store/                        # index(Store iface), schema.sql, sqlite.ts (networked-FS guard), postgres.ts
│   ├── server/                       # server, routes, wsHub, statusFrames, auth, info(/.well-known), health(/healthz,/readyz)
│   ├── economics/                    # refillScheduler[new] (through workerQueue), breaker[new] (grief circuit breaker)
│   └── observability/                # logger(redaction), metrics, alerting(outbox)
├── docker/                           # Dockerfile (multi-stage/arch, baked+verified params, non-root, ro-rootfs), entrypoint.sh
├── deploy/                           # compose.yml(PRIMARY)+Caddy, fly.toml, railway.json, render.yaml, k8s/, akash/deploy.yaml
├── observability/                    # dashboard.json (Grafana), alert-rules.yaml (mirrors 8 AWS alarms)
├── litestream.yml                    # SQLite → S3-compatible (R2/B2/MinIO) PITR of the never-swept memo set
├── test/                             # invariant/{sequential-per-worker, cross-worker-isolation}, chaos/crash-boundary,
│                                     #   compat/client-statemachine, integration/shadownet (RELAY_IT-gated)
├── docs/                             # SHIELD_RELAY_PROTOCOL.md (frozen wire), RUNBOOK.md, SECURITY.md
└── .github/workflows/                # ci.yml (tsc/eslint/vitest/build + arm64 better-sqlite3 load), release.yml (buildx+SBOM+cosign→GHCR)
```

---

## 4. The Resilience Core (most important section)

### Durable schema (source of truth; the in-memory chain is a cache over it)

```sql
jobs(
  jobId TEXT PRIMARY KEY,
  status TEXT,                 -- queued|verifying_payment|payment_confirmed|injecting_user_tx|completed|payment_failed|user_tx_failed
  paymentPoolIndex INT,        -- PHYSICAL tz1 that signs Phase-1
  broadcastPoolIndex INT,      -- DISTINCT physical tz1 that signs Phase-2
  memo TEXT, jobSecretHash TEXT, expiresAt INT   -- ~1h TTL; past TTL → WS emits not_found
);
consumed_memos(memo TEXT PRIMARY KEY, jobId TEXT, consumedAt INT);   -- PERMANENT, NO TTL, atomic == DynamoDB attribute_not_exists
work_queue(
  taskId TEXT PRIMARY KEY, jobId TEXT,
  poolIndex INT,               -- PHYSICAL tz1 this task touches (mutex key) — NOT a role index
  chainSeq INT,                -- monotonic per-poolIndex seq at enqueue-to-chain (NOT wall-clock)
  kind TEXT,                   -- inject_payment | inject_user_tx | gas_refill
  payloadJson TEXT, state TEXT,        -- queued|running|done|failed
  broadcastState TEXT,         -- none|broadcasting|broadcast|confirmed
  opHash TEXT, pinnedCounter INT, attempts INT  -- pinnedCounter read+persisted BEFORE send() — the reconcile anchor
);
alert_outbox(id TEXT PRIMARY KEY, payloadJson TEXT, attempts INT, nextAttemptAt INT);
```

### Job lifecycle + where each durable write happens

**Phase 1 — submit-payment → 202:** verify jobSecret (timingSafeEqual; wrong rejected regardless of `REQUIRE_JOB_SECRET`) → **ONE SQLite txn**: conditional `UPDATE jobs SET status='queued'` **AND** `INSERT work_queue(kind='inject_payment', poolIndex=paymentPoolIndex, chainSeq=next(...))` → COMMIT → **only then** `enqueue()` in memory → return 202. *Durable-then-return: crash between COMMIT and enqueue → rehydration; crash before COMMIT → no 2xx, client retries safely.*

**Phase 1 execution (inside the tz1 chain):** read tz1 counter → **persist `pinnedCounter` + `broadcastState='broadcasting'` BEFORE `.send()`** → `.send()`, capture `op.opHash` synchronously (Taquito populates pre-confirmation, verified `index.js:824`) → **persist `broadcast,opHash` BEFORE `confirmation(2)`** → `confirmation(2)` → verify memo via `getShieldedTransactions()` comparing **INTEGER mutez** (`BigInt(receiptValueMutez) >= expectedMutez`) → `INSERT consumed_memos(memo)` (fails-on-dup = credit-once) → **one txn**: `jobs.status='payment_confirmed'` + `work_queue.state='done'` → persist-then-fanout WS.

**Phase 2 — submit-user-transaction → 200** (only after `payment_confirmed`): jobSecret check → **ONE txn**: gate on `status='payment_confirmed'` (else 409), `UPDATE status='injecting_user_tx'` + `INSERT work_queue(kind='inject_user_tx', poolIndex=broadcastPoolIndex,…)` → COMMIT → enqueue → 200. In chain: persist `pinnedCounter+broadcasting` BEFORE `.send()` → capture opHash → persist `broadcast` → `confirmation(1)` → one txn `completed`+`done`.

### Surviving crash/restart WITHOUT violating the invariant or double-broadcasting

**Boot re-hydration:** `SELECT * FROM work_queue WHERE state IN ('queued','running') ORDER BY poolIndex, chainSeq` → `reconcile()` each → re-`enqueue(poolIndex,…)`. Ordering by `(poolIndex, chainSeq)` rebuilds each physical tz1's chain in original order → **sequential-per-worker holds across restart**. A `running`/`broadcasting`/`broadcast` row is reconciled, never blindly re-run.

**The reconcile decision (`reconcile.ts`) — counter-pin, NOT opHash-only, NOT memo-presence** (the central red-team fix):
- Read the **current on-chain counter** of the task's `poolIndex` tz1.
- **`currentCounter > pinnedCounter`** → an op already landed. Scan that tz1's recent ops (TzKT, bounded window) for one matching this job's target → if found, **broadcast succeeded; skip re-send**, resume post-send (P1: re-poll memo; P2: mark completed). Counter advance is ground truth even with no recorded opHash.
- **`currentCounter == pinnedCounter` AND no matching op** → never broadcast → **re-send ONCE using the pinned counter** (don't let Taquito auto-fetch a fresh one).
- **Hard cap of 1 auto re-broadcast**, then **park to dead-letter** (`relay jobs retry/discard`).

**Why no double-broadcast:** a P2 re-send with a *fresh* counter would be a different-hash op (chain dedup wouldn't catch it) → counter-pinned reconcile is the only safe path. **Backstops:** `consumed_memos UNIQUE(memo)` (P1) + the `payment_confirmed` status gate (P2) make an accidental re-send *harmless*.

**No `jobs`↔`work_queue` divergence:** every status transition + its work_queue change are **one `BEGIN/COMMIT`**. A boot consistency check **fails `/readyz`** if any job's `jobs.status`/`work_queue.state` disagree.

**Gas-refill safety:** `setInterval` → `enqueue(poolIndex, gas_refill)` on the **same physical-tz1 chain** → cannot overlap a job's notes/counter; durable row → reconciles like any task.

**WS:** persist-then-fanout always; `jobs.status` is the replay source; **`not_found` emitted for unknown/expired jobIds** (the client's `relay.ts` soft-locks the form forever without it).

**Drain:** SIGTERM → `/readyz`→503, stop new submits + refill; **stop *starting* new `.send()` immediately**; only await confirmations of already-sent ops; bounded 120s (templates set grace ≥ this, CI-checked). *Drain is an optimization; counter-pinned intent-log makes hard-kill safe regardless* — PaaS 30s grace caps mean mid-broadcast SIGKILL is the common case.

---

## 5. Deploy Matrix

**Image:** ONE multi-arch image (`buildx amd64,arm64`, `node:22-bookworm-slim`), **~52 MB z.cash params BAKED** at `/opt/sapling-params` (`SAPLING_PARAMS_URL=file://…`, SHA-256 verified build+boot), GHCR manifest list, `better-sqlite3` pinned to a prebuild-having version (sole native dep; `@airgap/sapling-wasm` is arch-neutral WASM), non-root + ro-rootfs + dropped caps, cosign-signed + SBOM. ~250–350 MB.

**RAM (HONEST, `parallelThreads:true`):** each worker thread active in the reaper window holds ~1.2–1.5 GB. Peak tracks workers-fired-recently, NOT live proof count. `MAX_CONCURRENT_PROOFS` caps proving pressure, does NOT decouple RAM from N. **Homelab default `WORKER_COUNT=1`** (the "$5–40 / 2–4 GB box" is true only here); 2 ≈ 4 GB; 5 ≈ 6–10 GB. `doctor` refuses N workers if RAM < N×1.5 GB.

| Target | SQLite vol | WS | Single-instance | Grace≥drain | RAM | Secrets |
|---|---|---|---|---|---|---|
| **Fly.io** | Fly volume | transparent | `min/max machines=1` | `kill_timeout=120s` | `[[vm]] memory` | `fly secrets` |
| **Railway** | Volume @ `/data` | transparent | `numReplicas=1` | document | plan | env |
| **Render** | Disk @ `/data` | raise idle timeout | `numInstances:1` | document | plan | env `sync:false` |
| **VPS/compose** | bind `./data` | Caddy/Traefik sidecar | `restart:always` | `stop_grace_period:120s` | `mem_limit` | `env_file`/secret |
| **Homelab/Pi** | local vol | Caddy sidecar | one container | compose grace | `WORKER_COUNT=1` | `POOL_FILE` 0600 |
| **k8s** | RWO PVC (warn networked-FS) | Ingress WS annos | **StatefulSet `replicas:1`** | `terminationGracePeriodSeconds:120` | requests/limits | Secret |
| **Akash** | persistent (warn networked-FS) | expose `http` | `count:1` | document | `4–8Gi` | sealed env |

**Networked-FS guard:** SQLite WAL is unreliable on NFS/networked CSI → `sqlite.ts` probes on boot and **refuses to start** unless `ALLOW_NETWORK_FS=true`; **Postgres is the *supported* path** for k8s-network-PVC / Akash.

---

## 6. Hard Invariants + How Honored

| Invariant | How |
|---|---|
| **Sequential-per-worker** | Per-physical-tz1 promise-chain mutex (one process owns all workers → no leases); `worker_threads` isolation makes concurrent *different*-tz1 proofs safe; same-tz1 ops (P1, P2-as-broadcast, gas-refill) chain on the same `poolIndex`; rehydration re-enqueues in `(poolIndex, chainSeq)` order. **Cross-worker isolation test against the REAL SDK is the load-bearing proof.** |
| **Payment-before-reveal** | Phase-2 `work_queue` row only inserts when `status='payment_confirmed'`; memo verified (integer mutez) + `consumed_memos` written before status flips; stuck-`payment_confirmed` surfaced via metric/alert. |
| **Permanent atomic replay guard** | `consumed_memos(memo PK)` atomic INSERT-fails-on-dup, NO TTL/sweep; Litestream/`.backup` off-box; boot integrity check fails `/readyz` if unexpectedly empty. Per-operator scope OK — the on-chain nullifier is the true defense; a replayed memo elsewhere only re-burns the attacker's fee. |
| **Restart-safety** | Durable `work_queue` written **before** every 2xx; boot re-hydration re-enqueues every non-terminal task. In-memory queue is a cache, never source of truth. |
| **No-double-broadcast** | **Counter-pin-before-send** + reconcile-by-current-counter-and-recent-ops for all three send paths; opHash (pre-confirmation) as fast-path anchor, counter advance as ground truth; re-send only if counter unchanged AND no matching op; max 1 then park. Backstops make accidental re-send harmless. |

---

## 7. Security / Key-Custody + Config Surface

**Checklist:** 3-tier secret load (one source resolves; assert `tz1 == InMemorySigner(secretKey).publicKeyHash()` before any gas spend) · secrets never logged/imaged (redaction allowlist + CI grep gate; wrapped SDK errors) · jobSecret `randomBytes(16+)`, **sha256-at-rest**, `timingSafeEqual`, wrong always rejected, never echo `paymentTxHash` · **default `REQUIRE_JOB_SECRET=true`** (all live clients send it) · hot-wallet float **default parity (unshield-entire-to-own-tz1)**, cap+sweep opt-in OFF by default with a burn-derived floor · gas-grief documented **structurally unpreventable** (dry-run proves nothing post-Sapling) → per-IP rate limit + circuit breaker (pause NEW broadcasts only) + optional anti-spam deposit + a grief-economics worksheet · cross-host single-owner instance lock + heartbeat · supply chain: digest-pinned base, `npm ci`, cosign + SBOM, ro-rootfs · log-min `RETAIN_CLIENT_IPS=false`.

**Env surface (zod-validated):** `TEZOS_NETWORK · TEZOS_RPC_URL(comma-failover) · TZKT_API · SHIELD_BRIDGE_CONTRACT(net-default) · PAYMENT_AMOUNT_MUTEZ=1000000 · WORKER_COUNT=1 · MAX_CONCURRENT_PROOFS=2 · REQUIRE_JOB_SECRET=true · POOL_FILE|POOL_JSON|POOL_FILE_ENC+AGE_IDENTITY_FILE|POOL_KMS_KEY_ID · DATA_DIR|DB_PATH · DATABASE_URL? · ALLOW_NETWORK_FS=false · SAPLING_PARAMS_URL=file:///opt/sapling-params/ · CONFIRMATIONS_PHASE1=2 · CONFIRMATIONS_PHASE2=1 · GAS_REFILL_THRESHOLD_XTZ=5 · GAS_REFILL_INTERVAL_MS · WORKER_FLOAT_CAP_XTZ? · WORKER_GAS_TARGET_XTZ? · SWEEP_ADDRESS? · JOB_TTL_SECONDS=3600 · PORT=8080 · RATE_LIMIT_RPM · RATE_LIMIT_BURST · MAX_CONNECTIONS · MAX_INFLIGHT · GRIEF_FAIL_RATE_THRESHOLD · GRIEF_WINDOW · ANTISPAM_DEPOSIT_MUTEZ=0 · DRAIN_TIMEOUT_MS=120000 · RETAIN_CLIENT_IPS=false · ALERT_WEBHOOK_URL? · LOG_LEVEL=info · RELAY_PUBLIC_URL? · ABUSE_CONTACT?`

---

## 8. Definition of Done for Self-Migration

Point `shieldbridge.xyz` at this instead of Lambda when ALL are green:
- [ ] **Live-prod conformance transcript passes** — a byte-level transcript captured from the **running prod relay** replays identically against the container (freeze the real wire, incl. jobSecret + distinct broadcast worker that are live on mainnet).
- [ ] **Cross-worker isolation test passes against the REAL SDK** (two threads prove+sign concurrently, no key bleed) — until green, the reliability story is unproven.
- [ ] **Chaos suite on shadownet:** `kill -9` in the send()→commit gap for P1, P2, AND gas-refill (and mid-confirmation) → no double-broadcast, no counter desync/stall, no stranded paid job, memo-consume-once intact.
- [ ] **Client state-machine compat:** real `relay.ts` resume of expired job → `not_found` → form unlocks; 409-on-resume handled.
- [ ] Integer-mutez compare verified; measured RAM table from a real arm64 box; `doctor` enforces RAM headroom.
- [ ] E2E shadownet: live web client completes a relayed **transfer AND batch** unchanged, incl. WS reconnect/replay during a real 10–60s proof.
- [ ] Single-instance lock proven cross-host; `consumed_memos` off-box backup + boot integrity check; alert outbox survives a webhook outage; grace ≥ drain CI-checked in every template.

**Posture:** build → run **beside** Lambda against shadownet + a mainnet shadow → migrate only after transcript + chaos gates are green.

---

## 9. Phased Build Plan

- **P1 — MVP (shadownet).** Scaffold order: `config/{schema,load}` → `sapling/pool` (**`parallelThreads:true` day 1**) → `store/{schema.sql,sqlite}` → `runtime/workerQueue` (per-physical-tz1) → `core/{setAddress,payment(int-mutez),inject,gasRefill}` → `server/{server,routes,wsHub,auth,health}` → `cli/{init,start,doctor}`. **Deliverable:** `relay init`→fund→`doctor`→`compose up`→live web client completes one relayed transfer. **First test:** `cross-worker-isolation.test.ts` against the real SDK (validates the concurrency model before anything else).
- **P2 — Resilient + observable.** `runtime/{rehydrate,reconcile,lifecycle,instanceLock}` + counter-pin writes + one-txn coupling → `observability/{logger,metrics,alerting(outbox)}`, `economics/{refillScheduler,breaker}`, `cli/jobs`, Litestream. **Deliverable:** chaos + client-statemachine tests pass; `/metrics` + dashboard live; survives `kill -9`.
- **P3 — Multi-host.** `docker/{Dockerfile(multi-arch,baked params),entrypoint}` + CI (buildx + arm64 better-sqlite3 load + cosign/SBOM) → `deploy/{compose,fly,railway,render,k8s,akash}` (grace≥drain CI-checked, networked-FS guard, single-instance pins). **Deliverable:** one `docker run` on Mac/Pi/VPS; measured RAM table; Akash SDL digest-pinned.
- **P4 — Registry-ready.** `server/info.ts` (`/.well-known/shield-relay.json`) + `docs/SHIELD_RELAY_PROTOCOL.md` frozen → `store/postgres.ts` advisory-lock leasing (deferred HA) + challenge-signing. **Deliverable:** discoverable, challenge-verifiable relay; Path-A (independent disjoint-pool relays) documented as scale-out.

---

## 10. Key Open Decisions for the Owner

1. ~~Phase-0 baseline contradiction~~ — **resolved:** the flag was the v3 checkout lacking the Phase 0 backend merge; Phase 0 is live + enforced on mainnet (verified). Action that *remains*: capture the live-prod transcript as the migration reference (don't freeze from a checkout).
2. **Concurrency model (BLOCKING before scaffolding):** accept **`parallelThreads:true` (N isolated threads)** as default? Alternatives: global-single-proof-mutex (low RAM, no parallelism — the "stronger than SQS" framing evaporates) or N independent single-worker *processes* (Path A — matches Lambda's proven per-process isolation). Blueprint picks threads.
3. **Homelab default `WORKER_COUNT`:** 1 (2–4 GB box true, smallest anon set) vs 2 — sets the README promise.
4. **Float-cap/sweep:** ship parity default (unshield-entire-to-own-tz1) with opt-in sweep — confirm, and whether a cold `SWEEP_ADDRESS` is required or same-tz1 accumulation is allowed (loud warning).
5. **Postgres adapter in P1 or deferred?** Shipping now lets k8s/networked-FS operators start on the supported networked-storage path, but risks implying multi-instance HA (not supported until advisory-lock leasing).
6. **Confirmation depths:** keep `2`/`1` (P1/P2) for parity, or make per-network configurable.
7. **Params redistribution:** are the z.cash `.params` redistributable inside the image under license, or fetch-at-build-with-checksum (reintroduces firewalled-build pain for forkers)?
8. **arm64 CI:** native arm64 runner vs qemu buildx; arm64 real-proof smoke test before publishing the manifest list, or amd64-verified + arm64-best-effort first?

---

**First files to scaffold:** `src/sapling/pool.ts` (`parallelThreads:true`), `src/runtime/workerQueue.ts` (per-physical-tz1), `src/store/{schema.sql,sqlite.ts}`, `src/runtime/reconcile.ts` (counter-pin), and `test/invariant/cross-worker-isolation.test.ts` (the real-SDK proof that validates the concurrency model **before** any further build).
