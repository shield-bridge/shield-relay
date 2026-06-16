# shield-relay/1 — Wire Protocol Specification

> A self-hostable Tezos privacy relay: a Shield Bridge user pays a small fee to have the relay broadcast their Sapling unshield/transfer, so the user's wallet never touches the chain.

**Protocol identifier:** `shield-relay/1`

**Status:** *Frozen wire.* This document specifies the on-the-wire contract — endpoints, envelopes, status codes, field names, and shapes — that any conforming client or server must honor. There are two known server implementations: this self-hostable container relay (the reference implementation described here) and an AWS serverless relay. Both speak `shield-relay/1`. **The code in this repository is the source of truth**; where this document and the code disagree, the code wins.

---

## 1. Overview & trust model

A `shield-relay/1` relay broadcasts a user's Tezos Sapling operation on the user's behalf so that the user's own wallet/IP never appears on chain. The relay is paid a fee in a way that is itself private and is verified *before* anything is broadcast.

### 1.1 Two-phase flow

A job proceeds in two phases, each broadcast by a **distinct worker** drawn from the relay's worker pool:

1. **Phase 1 — Payment (the "firewall").** The client crafts a *public unshield* of the relay fee out of the Shield Bridge "Set" contract, paying the chosen **payment worker's** public `tz1` address. The client submits this op to the relay via `POST /submit-payment`. The relay **simulates the op and verifies that it actually pays the worker the required mutez before it broadcasts anything** — broadcasting an unverified op would be a free-injection hole. After broadcast and confirmation the relay re-reads the inclusion block to confirm the op actually *applied* (closing a proof-malleability double-spend race).
2. **Phase 2 — User transaction.** Once the payment confirms, the client submits the user's *real* Sapling operation via `POST /submit-user-transaction`. A **different worker** (the broadcast worker) injects it. The op hash is reported back through status polling.

Status is delivered by **polling** `GET /status/:jobId`. (The earlier WebSocket transport was removed in the WS→poll migration; there is no upgrade/WebSocket surface.)

### 1.2 What the relay can and cannot see

- The relay reads the **public, transparent** outputs of the payment unshield via RPC `simulate_operation` (the `internal_operation_results` transfers). It never decrypts Sapling notes.
- The user's Phase-2 transaction is **opaque** to the relay: `ContractParams.txns` are hex-encoded Sapling transactions passed verbatim into the contract call; the relay never decodes them. It only chooses which Set contract to target from the out-of-band `contract` / `token_id` fields.

### 1.3 Bounded trust

The relay's power over funds is bounded by construction:

- The payment recipient is **never** taken from a request field. An unshield's recipient lives in client-chosen, untrusted Sapling `bound_data`. The relay trusts only the *simulated, applied* transfers whose `destination` equals the worker's own `tz1`. A client cannot make the relay credit a payment the contract would not actually pay to that exact `tz1`.
- The relay can only **refuse to broadcast** or **broadcast the exact op the user submitted**. It cannot redirect funds or substitute a different operation.
- **Worst case:** the relay refuses after the payment confirms, and the user loses **exactly one fee**.

### 1.4 Unlinkability via two distinct workers

When the pool has more than one worker (`n > 1`), the payment worker and the broadcast worker are deliberately distinct (`broadcastPoolIndex` is chosen distinct from `paymentPoolIndex`). The fee payment and the user transaction therefore originate from two different `tz1` addresses, so an on-chain observer cannot trivially link "who paid" to "whose op was broadcast." With `n == 1` the two indices coincide.

---

## 2. Transport & conventions

### 2.1 HTTP/JSON over a single port

The relay is a single-port [Fastify](https://fastify.dev) app serving JSON over HTTP/1.1. There is **no WebSocket or HTTP-upgrade handling**. All status delivery is via polling `GET /status/:jobId`.

- **Body limit:** 5 MiB (`5 * 1024 * 1024` = 5 242 880 bytes). Larger bodies are rejected by Fastify before the handler runs. (Relevant because `userTransaction` may be an array.)
- **Listen port:** `PORT` (default `8080`).
- **Proxy trust:** `trustProxy` (from `TRUST_PROXY`, default `false`) controls whether `X-Forwarded-For` is trusted for `req.ip`. Set true **only** behind a trusted reverse proxy — otherwise clients can spoof `XFF` to evade or share rate-limit buckets.

### 2.2 CORS & preflight

A global `onRequest` hook (`server.ts:42-53`) sets these CORS headers on every response that **reaches it** — including route-not-found `404`s and `HttpError` `4xx`/`5xx`, since those are produced during/after routing:

```
access-control-allow-origin: *
access-control-allow-methods: GET, POST, OPTIONS
access-control-allow-headers: content-type
```

CORS is intentionally permissive (`*`) and there is **no credentialed/cookie surface** — no `access-control-allow-credentials` header is set. Any `OPTIONS` request (on any path, even nonexistent ones — the hook runs before routing) short-circuits to **`204 No Content`** with an empty body after the CORS headers are applied.

> **Exception — the `429` rate-limit response.** `@fastify/rate-limit` is registered (`server.ts:34`) **before** the CORS `onRequest` hook is added (`server.ts:42`). The plugin installs its own `onRequest` hook, which — by registration order — runs first; on a throttled request it emits the `429` and short-circuits the hook chain, so the CORS hook never executes. A throttled browser XHR therefore likely sees a CORS failure rather than a readable `429`. CORS coverage is "every response except the rate-limit `429`."

### 2.3 Rate limiting

`@fastify/rate-limit` is registered with `{ max: RATE_LIMIT_RPM, timeWindow: '1 minute', allowList: ['127.0.0.1', '::1'] }`.

- Per-IP cap of `RATE_LIMIT_RPM` (default `120`) HTTP requests per minute; over-limit requests get HTTP `429`.
- Loopback (`127.0.0.1` and `::1`) is allow-listed and **never throttled** (for local health probes). Note: any client appearing as loopback bypasses the cap entirely.

### 2.4 Response envelopes (the asymmetry)

Response envelopes are **deliberately non-uniform.** The wrapping convention exists so that a client doing `json.data ?? json` works correctly across all endpoints: wrapped endpoints expose the payload at `.data`; bare/raw endpoints have no `.data`, so the `?? json` fallback yields the whole body.

| Endpoint | Method | Success status | Envelope |
|---|---|---|---|
| `/get-worker-info` | POST | `200` | `{ "success": true, "data": <WorkerInfo> }` |
| `/status/:jobId` | GET | `200` (always) | `{ "success": true, "data": <StatusFrame> }` |
| `/submit-payment` | POST | **`202`** | **bare** `{ jobId, status, message }` (NOT wrapped) |
| `/submit-user-transaction` | POST | `200` | `{ "success": true, "data": { jobId, status, message } }` |
| `/info` | GET | `200` | **raw** `RelayInfo` object (NOT wrapped) |
| `/.well-known/shield-relay.json` | GET | `200` | **raw** `RelayInfo` object (NOT wrapped) |
| `/healthz` | GET | `200` | raw `{ "status": "ok" }` |
| `/readyz` | GET | `200` / `503` | raw `{ "status": "ready" }` / `{ "status": "not_ready" }` |
| `/metrics` | GET | `200` | Prometheus **text** (not JSON) |

**Key facts a client must internalize:**

- `POST /submit-payment` is the **only** business endpoint that does not wrap in `{ success, data }` **and** the only one returning a non-`200` success code (`202 Accepted`). Its body is the bare `{ jobId, status, message }`.
- `/info` and `/.well-known/shield-relay.json` return the `RelayInfo` object directly. A client using `json.data ?? json` must **not** expect a `.data` property here.
- The `{ success, data }` wrapped progress object from `submit-user-transaction` carries a `message` field that a polled `StatusFrame` never has.

### 2.5 Error envelope

Errors raised as `HttpError` are sent with the `HttpError`'s `statusCode` and this body:

```json
{ "error": "<message>", "code": "<code>" }
```

`code` is **optional on the wire** (`HttpError.code?: string`) — it may be absent. Mechanically, the mapper at `routes.ts:62` *always* writes the `code` key into the JS object literal (`{ error: e.message, code: e.code }`); when `HttpError.code` is `undefined`, JSON serialization simply drops the key, so it never appears on the wire. The `500` fallback (`routes.ts:64`) is different — it genuinely omits the key entirely (`{ error: 'Internal server error' }`). Any non-`HttpError` exception becomes:

```json
{ "error": "Internal server error" }
```

at HTTP `500`, with **no** `code` field. Clients must treat `code` as optional on error bodies.

> **Caveat:** `GET /status/:jobId` has no `try/catch` and does not route through the error mapper. It is designed to *return* a `not_found` frame (HTTP `200`) rather than throw; a thrown `HttpError` there would fall through to Fastify's generic `500` instead of the `{ error, code }` shape. Clients must inspect `data.status`, not the HTTP code, on this endpoint.

> **Unknown routes use Fastify's built-in 404, not the relay envelope.** There is no custom `setNotFoundHandler`/`setErrorHandler` anywhere in `server.ts` or `routes.ts`, so a request to any unregistered path returns Fastify's *default* 404 body — shape `{ "statusCode": 404, "error": "Not Found", "message": "<...>" }` — which is **distinct** from the relay's `{ error, code? }` error envelope (and from a relay business `404`). A client doing `json.data ?? json` / `json.error` parsing on an unknown path gets a differently-shaped body (`json.error` would read `"Not Found"`, and the human-readable detail lives in `json.message`).

### 2.6 Status code conventions

| Code | Meaning in this protocol |
|---|---|
| `200` | Success (wrapped or raw per §2.4); also every `GET /status` response, even `not_found`. |
| `202` | `POST /submit-payment` accepted and queued. |
| `204` | `OPTIONS` preflight. |
| `400` | Malformed request (missing `jobId`, bad `txCount`, bad/oversized `txns`, batch over the hard cap). |
| `401` | Missing job secret (when required); or `/metrics` with a configured token but missing/wrong bearer. |
| `402` | Fee too low for the submitted Phase-2 tx count. |
| `403` | Job secret present but wrong. |
| `404` | Job not found (POST paths); `/info` absent → legacy relay; `/metrics` disabled (no token). **Unknown routes** return Fastify's default 404 `{ statusCode, error: "Not Found", message }` — *not* the relay's `{ error, code? }` envelope (no custom not-found handler; see §2.5). |
| `409` | Job in the wrong state / already consumed / concurrent submit. |
| `429` | Per-IP rate limit exceeded. |
| `500` | Unexpected server error (`{ error: 'Internal server error' }`, no `code`). |
| `503` | `/readyz` while the pool is not yet built or during drain. |

---

## 3. Authentication — the per-job secret

Each job is gated by a per-job capability token, the **`jobSecret`**.

### 3.1 Minting and storage

- At `POST /get-worker-info` the relay mints a fresh secret: `randomBytes(24).toString('base64url')` — a **192-bit URL-safe base64url** token.
- The plaintext `jobSecret` is returned to the client **exactly once**, as the `jobSecret` field of the `/get-worker-info` response. It is never returned again. A client that loses it cannot recover it and cannot drive the job.
- The relay persists **only** `sha256(secret)` hex (`hashJobSecret`). The plaintext is never stored.

### 3.2 Presenting the secret

The transport differs by endpoint (deliberately, so the secret never appears in a URL/access log):

| Endpoint | Where the secret goes |
|---|---|
| `POST /submit-payment` | JSON body field `jobSecret` |
| `POST /submit-user-transaction` | JSON body field `jobSecret` |
| `GET /status/:jobId` | HTTP request header `x-job-secret` |

For `GET /status`, a non-string header value (e.g. a duplicated header) is treated as `undefined`. The secret must **never** be placed in the `/status` URL or query.

### 3.3 Verification

The relay hashes the presented secret and compares it to the stored hash using a constant-time `timingSafeEqual`. The check short-circuits to "fail" on missing inputs or a buffer-length mismatch before the constant-time compare. `checkJobSecret(provided, expectedHash, required)` returns one of three results:

| Result | Condition |
|---|---|
| `ok` | No stored hash (legacy job — check effectively disabled); **or** hash present + secret missing + `required` is false; **or** hash present + secret verifies. |
| `missing` | Hash present, no secret provided, and `required` is true. |
| `mismatch` | Hash present, secret provided, verification fails. **Always rejected regardless of `REQUIRE_JOB_SECRET`.** |

`REQUIRE_JOB_SECRET` (default `true`) governs only the *missing* case. A **wrong** secret is always `mismatch`.

> All jobs minted by `get-worker-info` always store a hash, so the "no stored hash ⇒ ok" path only affects legacy/pre-release rows.

### 3.4 Status codes & the not_found mask

The two POST endpoints map auth results to HTTP errors:

- `missing` → `401 { "error": "Missing job secret." }`
- `mismatch` → `403 { "error": "Invalid job secret." }`

`GET /status/:jobId` does **not** surface 401/403. Any non-`ok` secret check collapses to a `not_found` frame (HTTP `200`) carrying `error: "unauthorized"`. This leaks nothing: an unknown job, an unauthorized read, and a pre-payment job all look like `not_found` (only the `error` string distinguishes an unauthorized read). In contrast, the **POST** paths reveal job existence by throwing `404 Job not found: <jobId>` for an unknown `jobId`. On these paths `requireJob()` (`processor.ts:464-469`, throwing the `404` at line `467`) runs **before** `assertSecret()` (`processor.ts:471-475`, throwing the `401`/`403` at lines `473-474`): the existence check comes first, so a `404` fires for an unknown `jobId` *regardless of whether any (or a correct) `jobSecret` was supplied*, and the secret assertion only runs once the job is known to exist (`submitPayment` at `processor.ts:147-148`, `submitUserTransaction` at `176-177`). This matches the §4.2/§4.3 check-order notes (existence `404` → secret `401`/`403`).

> A `memo` is generated and stored per job but is **vestigial**: it never travels on the wire and plays no part in auth or payment verification (it exists only to satisfy a legacy `NOT NULL` DB column). Do not confuse it with the `jobSecret`.

---

## 4. Endpoint reference

### 4.1 `POST /get-worker-info`

Mint a job: pick a payment worker, quote the fee, return the worker's `tz1` and a fresh `jobSecret`. No side effects on chain.

- **Auth:** none (this is where the secret is *minted*).
- **Request body:**

```json
{ "txCount": 3 }
```

| Field | Type | Notes |
|---|---|---|
| `txCount` | `number?` | Optional. Integer in `[1, 256]`. The *expanded* number of Sapling txns the Phase-2 payload will carry (`sum(txns.length)`), used to quote a scheduled fee. Omit it for the legacy flat quote. |

- **Success — `200`:**

```json
{
  "success": true,
  "data": {
    "jobId": "job-<uuid>",
    "workerIndex": 0,
    "address": "tz1...",
    "paymentMode": "unshield",
    "paymentAmount": "1.25",
    "quotedTxCount": 3,
    "feeSchedule": { "baseMutez": 300000, "perTxMutez": 270000, "quantumMutez": 250000 },
    "jobSecret": "<base64url 24-byte token>"
  }
}
```

> `paymentAmount` is `String(Number(quotedFeeMutez) / 1_000_000)` where `quotedFeeMutez = quoteFee(txCount, fee)` (`processor.ts:105,81-82`). With the example's `txCount: 3` and `feeSchedule { baseMutez: 300000, perTxMutez: 270000, quantumMutez: 250000 }`: `quantizeUp(300000 + 270000·3, 250000) = quantizeUp(1110000, 250000) = 1250000` mutez ⇒ `"1.25"` (consistent with the §8.6 worked-example row for `txCount = 3`).

- **Errors:**

| Status | code | When |
|---|---|---|
| `400` | — | `txCount` present but not an integer in `[1, 256]` → `Invalid txCount: must be an integer in [1, 256].` |
| `500` | (none) | Unexpected error. |

### 4.2 `POST /submit-payment` (Phase 1)

Queue the fee unshield for verify-before-broadcast.

- **Auth:** `jobSecret` in body (if required).
- **Request body:**

```json
{
  "jobId": "job-<uuid>",
  "jobSecret": "<secret>",
  "paymentTransaction": { "txns": ["<hex sapling tx>"] }
}
```

| Field | Type | Notes |
|---|---|---|
| `jobId` | `string` | Required. |
| `jobSecret` | `string?` | Required if `REQUIRE_JOB_SECRET`. |
| `paymentTransaction` | `ContractParams` | `txns` must contain **exactly one** hex Sapling tx (a single unshield to the worker's `tz1`). |

- **Success — `202` (BARE, not wrapped):**

```json
{ "jobId": "job-<uuid>", "status": "queued", "message": "Payment queued for verification." }
```

- **Errors:**

| Status | code | When |
|---|---|---|
| `400` | — | Missing `jobId`; or `txns` not a non-empty array; or `> 1` txn (`Too many sapling txns in one operation (N > 1).`); or a non-hex/empty/over-length txn (`Invalid sapling transaction: must be a hex string.`). |
| `401` | — | `Missing job secret.` |
| `403` | — | `Invalid job secret.` |
| `404` | — | `Job not found: <jobId>` |
| `409` | — | Wrong status (`Invalid job status: <status>. Already submitted?`); or concurrent submit (`Job status changed (concurrent submit).`). |

> Check order: `jobId` presence (400) → existence (404) → secret (401/403) → status must be `info_generated` (409) → `txns` validation (400). The earliest failure in this chain is the one surfaced.

### 4.3 `POST /submit-user-transaction` (Phase 2)

Queue the user's real op for broadcast by the distinct broadcast worker. Only valid after the payment confirms.

- **Auth:** `jobSecret` in body (if required).
- **Request body** (`userTransaction` may be a single `ContractParams` or an array):

```json
{
  "jobId": "job-<uuid>",
  "jobSecret": "<secret>",
  "userTransaction": [
    { "txns": ["<hex>"] },
    { "txns": ["<hex>"], "contract": "KT1...", "token_id": 3 }
  ]
}
```

| Field | Type | Notes |
|---|---|---|
| `jobId` | `string` | Required. |
| `jobSecret` | `string?` | Required if `REQUIRE_JOB_SECRET`. |
| `userTransaction` | `ContractParams \| ContractParams[]` | Total Sapling txns across all elements must be `≤ 32` (`MAX_INJECT_TXS`), and must not exceed the quoted/legacy fee cap. |

- **Success — `200` (wrapped):**

```json
{
  "success": true,
  "data": { "jobId": "job-<uuid>", "status": "injecting_user_tx", "message": "User transaction queued for injection." }
}
```

- **Errors:**

| Status | code | When |
|---|---|---|
| `400` | — | Missing `jobId`; per-element `txns` invalid/empty/non-hex; element exceeds 32 txns (`Too many sapling txns in one operation (N > 32).`); or total exceeds the hard cap (`Batch too large: N sapling txns exceeds the 32 hard limit.`). |
| `401` | — | `Missing job secret.` |
| `402` | — | Fee too low for the submitted count (see §8.4). |
| `403` | — | `Invalid job secret.` |
| `404` | — | `Job not found: <jobId>` |
| `409` | — | Already consumed (status `completed`/`injecting_user_tx`) → `Job already consumed.`; payment not yet confirmed → `Payment not confirmed yet (status: <status>).`; concurrent submit → `Job already consumed (concurrent submit).` |

> Check order: `jobId` (400) → existence (404) → secret (401/403) → status (`completed`/`injecting_user_tx` → 409; not `payment_confirmed` → 409) → per-element & total txn validation (400) → fee coverage (402) → enqueue.

### 4.4 `GET /status/:jobId`

Read-only status poll — **the** status transport. Always HTTP `200`.

- **Auth:** `jobSecret` in the `x-job-secret` header (if required).
- **Request:** `GET /status/job-<uuid>` with header `x-job-secret: <secret>`.
- **Success — `200`:** `{ "success": true, "data": <StatusFrame> }`. The frame's `status` is a wire status or `not_found`. See §5.1 for the full mapping. Representative bodies:

```json
{ "success": true, "data": { "jobId": "job-<uuid>", "status": "verifying_payment" } }
```

```json
{ "success": true, "data": { "jobId": "job-<uuid>", "status": "completed", "operationHash": "o...", "userTxHash": "o..." } }
```

```json
{ "success": true, "data": { "jobId": "job-<uuid>", "status": "payment_failed", "error": "Payment verification failed: unshield pays <n> mutez to the worker, need >= <m>." } }
```

```json
{ "success": true, "data": { "jobId": "job-<uuid>", "status": "not_found", "error": "unauthorized" } }
```

- **Errors:** none under normal operation — unknown/unauthorized/pre-payment jobs are all `200` with `status: "not_found"`. (A thrown error would degrade to Fastify's generic `500`, since this route does not use the error mapper.)

### 4.5 `GET /info` and `GET /.well-known/shield-relay.json`

The public capability + fee descriptor. Both return the **same** `RelayInfo` object **directly** (no `{ success, data }` wrapper); they are byte-identical. The `.well-known` path is the canonical discovery location. Pure read, no side effects.

- **Auth:** none.
- **Success — `200`:**

```json
{
  "protocol": "shield-relay/1",
  "network": "mainnet",
  "factoryContract": "KT1...",
  "paymentMode": "unshield",
  "transport": "poll",
  "fee": { "model": "scheduled", "flatMutez": "1000000" },
  "feeSchedule": { "baseMutez": 300000, "perTxMutez": 270000, "quantumMutez": 250000 }
}
```

- **Notable:** a `404` on `/info` is **meaningful** — it signals a legacy/flat relay, in which case the client should default to a **1 XTZ** fee (it does not mean the host is down). See §9 for the `RelayInfo` type (note `fee.flatMutez` is a **string**, the three `feeSchedule.*` fields are **numbers**).

### 4.6 `GET /healthz`

Liveness. Always `200`, raw body:

```json
{ "status": "ok" }
```

### 4.7 `GET /readyz`

Readiness. `200` when ready, `503` until the pool is built and during drain.

```json
{ "status": "ready" }
```

```json
{ "status": "not_ready" }
```

### 4.8 `GET /metrics`

Prometheus metrics, **default-deny** to keep per-worker gas/queue metadata private.

- **No token configured** (`METRICS_TOKEN` unset): `404` with empty body — the endpoint does not even reveal it exists.
- **Token configured, missing/wrong bearer:** `401` with empty body. The header must match exactly `Authorization: Bearer <token>`.
- **Valid bearer:** `200`, `content-type: <metrics.contentType>`, body = Prometheus text.

### 4.9 `OPTIONS <any path>`

CORS preflight. Always `204 No Content`, empty body, with the CORS headers from §2.2. Handled by the global `onRequest` hook before routing, so it applies to every path.

---

## 5. Job lifecycle & status

### 5.1 Internal statuses vs. wire statuses

The store tracks **8** internal `JobStatus` values; only **7** are ever exposed on the wire. `not_found` is a frame-only sentinel, not a stored status.

| Internal `JobStatus` | Wire status | Notes |
|---|---|---|
| `info_generated` | *(hidden)* → `not_found` | The state between `get-worker-info` and `submit-payment`. Never exposed. |
| `queued` | `queued` | Payment enqueued for verification. |
| `verifying_payment` | `verifying_payment` | Payment broadcasting / awaiting confirmation / applied-check. |
| `payment_confirmed` | `payment_confirmed` | Fee confirmed; ready for Phase 2. |
| `injecting_user_tx` | `injecting_user_tx` | User op enqueued / broadcasting. |
| `completed` | `completed` | User op confirmed. Carries the op hash. |
| `payment_failed` | `payment_failed` | Phase-1 failure (pre-broadcast or chain-confirmed-negative). |
| `user_tx_failed` | `user_tx_failed` | Phase-2 failure. |

`toWireStatus()` returns the status unchanged if it is a wire status, else `null`. `getStatus()` turns a `null` wire status into a `not_found` frame. Therefore **`info_generated` is reported as `not_found`** — a client polling immediately after `get-worker-info` (before the payment is queued) correctly sees `not_found`; this is expected, not an error.

### 5.2 The `not_found` overload

`not_found` is returned for three indistinguishable-except-by-`error` conditions:

| Condition | Frame |
|---|---|
| Unknown / nonexistent `jobId` | `{ jobId, status: "not_found" }` (no `error`) |
| Bad/missing job secret | `{ jobId, status: "not_found", error: "unauthorized" }` |
| Valid+authorized job still in `info_generated` | `{ jobId, status: "not_found" }` (no `error`) |

### 5.3 State diagram

```
                 POST /get-worker-info
                          │
                          ▼
                  [info_generated]   ── GET /status ──▶ not_found (hidden)
                          │
                 POST /submit-payment
                          │  (gate: status == info_generated, exactly 1 txn)
                          ▼
                      [queued]
                          │  worker picks up inject_payment
                          ▼
                 [verifying_payment] ──(verify !ok / replay / not applied)──▶ [payment_failed]
                          │
                  (confirmed & applied)
                          ▼
                 [payment_confirmed]
                          │
            POST /submit-user-transaction
                          │  (gate: status == payment_confirmed; tx count ≤ cap & ≤ 32)
                          ▼
                 [injecting_user_tx] ──(pre-broadcast error)──▶ [user_tx_failed]
                          │
                  (confirmed)
                          ▼
                    [completed]   ── GET /status ──▶ status: completed + opHash
```

State transitions are guarded by a compare-and-advance (`enqueueWork` advances the status only from the expected prior status, atomically with inserting the work row); a concurrent change makes the enqueue return `null`, surfaced as a `409`.

> A *post-broadcast* unknown error never produces `*_failed`: the job is left in-progress (`verifying_payment` / `injecting_user_tx`) and reconciled or parked, to avoid reporting a phantom failure for an op that may have landed. Thus `*_failed` strictly means a pre-broadcast or chain-confirmed-negative failure.

### 5.4 TTL / expiry

`expiresAt = floor(now/1000) + JOB_TTL_SECONDS` (default `3600`s) is written at job creation. However, **expiry is not enforced or swept in the HTTP read path**: `getJob`/`getStatus` apply no expiry predicate, and nothing prunes expired rows. An "expired" job still returns its real wire status over HTTP. The `(EXPIRED)` marker exists only in the offline `relay jobs show` CLI. (The `consumed_payments` replay guard is separate and has *no* TTL — it is permanent.)

### 5.5 StatusFrame shape

```ts
interface StatusFrame {
  jobId: string;
  status: WireStatus | 'not_found';
  operationHash?: string; // present only on completed; same value as userTxHash
  userTxHash?: string;    // present only on completed; same value as operationHash
  error?: string;         // failure message, or the literal 'unauthorized'
}
```

On `completed`, `operationHash` and `userTxHash` are the **same string** (the Phase-2 user-tx op hash) — they are not two different hashes. A client may read either. The Phase-1 fee-unshield op hash (`paymentTxHash`) is stored server-side but is **never** emitted on the wire. Frames before `completed` carry no `operationHash`/`userTxHash`.

---

## 6. Phase 1 — Payment (the verify-before-broadcast firewall)

### 6.1 The payment

A legitimate Phase-1 payment is a **public unshield** of the relay fee out of the Shield Bridge "Set" contract, paying the **payment worker's own `tz1`**. There is **no memo** and no shielded transfer. The op is a Set-contract `default` entrypoint call (`setContract.methodsObject.default(payment.txns)`) sent from the payment worker's `tz1`. The `paymentTransaction.txns` array must contain **exactly one** Sapling txn (enforced by `validateTxns(..., 1)`).

### 6.2 Verify before broadcast (`verifyPaymentUnshield`)

Before any broadcast, the relay dry-runs the op via RPC `simulate_operation` (no signature needed; budgeted with the protocol's hard gas max). It then:

1. Sums, via `sumAppliedTransfersTo(sim.contents, workerTz1)`, **only** the `internal_operation_results` transfers that are **applied** and whose `destination` equals the worker's `tz1`.
2. Accepts iff `receivedMutez >= expectedMutez` (exact `BigInt` mutez comparison; overpayment and exact payment both pass).

A content entry is counted only if its top-level `operation_result.status` is not set-and-`!= 'applied'` (an unset top-level status is allowed), the internal result is `kind === 'transaction'` with `destination === workerTz1` and a present `amount`, and the internal `result.status` is unset or `'applied'`. A failed top-level op (e.g. bad proof) contributes nothing.

This is **robust by construction**: an unshield's recipient lives in client-chosen, untrusted Sapling `bound_data`, so the relay reads what the *contract will actually pay out*, never a request field. A hijacker who unshields to their own address simulates as `0`-to-worker and is rejected before any gas is spent.

`expectedMutez` is the job's binding quote: `BigInt(job.quotedFeeMutez ?? Number(PAYMENT_AMOUNT_MUTEZ))` (`processor.ts:255`). `PAYMENT_AMOUNT_MUTEZ` is a `bigint` in config (`schema.ts:34`, default `1_000_000n`); on the fallback path it is round-tripped through `Number()` first (immaterial at the default value).

### 6.3 Replay guard (`paymentDigest`)

`paymentDigest(payment)` is the SHA-256 hex of the concatenated `payment.txns`. It is the atomic, **order-sensitive** replay key. It is **consumed before broadcast** via the store's `consumed_payments` table, making the exact payment bytes single-use — one payment cannot be parlayed into two jobs. Consumption is same-job idempotent (a matching `jobId` on the existing digest row returns success, which is what makes crash-resume safe); a *different* `jobId` on the same digest is rejected as a replay.

### 6.4 Broadcast & confirmations

`broadcastPayment(client, factory, payment, confirmations, onBroadcast?)` returns `{ hash, level }`. It fires `onBroadcast(opHash)` **after** `.send()` resolves but **before** awaiting `op.confirmation(confirmations)` — so the relay durably records the broadcast intent (and flips the job to `verifying_payment`, storing `paymentTxHash`) while the op is still unconfirmed. Confirmations default to `CONFIRMATIONS_PHASE1 = 2`.

### 6.5 Post-confirmation applied-check (`verifyPaymentLanded`)

After confirmation the relay re-reads the inclusion block (manager ops live at validation **pass index 3**), finds the op by hash, and re-sums the applied transfers to the worker, requiring `receivedMutez >= expectedMutez`. This closes a **proof-malleability race**: two re-randomized unshields spending the *same* note can both pass pre-broadcast simulation (where the note is still unspent) and be broadcast on different workers; one lands, the other is included as `failed` (nullifier double-spend). A `failed` op contributes `0`, so it fails the applied-check. Pre-broadcast simulation and the post-confirmation applied-check are **both required and not redundant.**

On crash-resume (a job was broadcast but never applied-checked), `verifyPaymentLandedByScan` recovers the inclusion level by scanning back from head up to a max depth. If the op is not found in the window (deep downtime), it returns `{ checked: false, ... }`, which the processor accepts with a warning (a residual would require both an active malleability attack *and* a long outage).

### 6.6 Processor ordering (fresh broadcast)

1. `verifyPaymentUnshield` — on `!ok`, fail with `Payment verification failed: unshield pays <receivedMutez> mutez to the worker, need >= <expectedMutez>.`
2. consume `paymentDigest` — on collision with another job, fail with `Payment already consumed (replay).`
3. pin the counter (`setBroadcasting`) **before** send.
4. `broadcastPayment`.
5. `verifyPaymentLanded` — on `!ok`, fail with `Payment op <hash> did not apply / underpaid on-chain (<receivedMutez> mutez to the worker, need >= <expectedMutez>).`

---

## 7. Phase 2 — User transaction

### 7.1 What is broadcast

Phase 2 broadcasts the user's real Sapling op from the **broadcast worker's `tz1`** (distinct from the payment worker). The payload is a `ContractParams` (single) or `ContractParams[]` (batch). Each element's `txns` are **opaque** hex Sapling txns the relay never decodes; they are passed verbatim to `setContract.methodsObject.default(params.txns)`.

### 7.2 Asset routing

The target Set contract is resolved per element by reading the V2 Factory storage (results cached process-wide, valid because Set addresses are immutable). Routing depends on **field presence**, not values:

| `contract` | `token_id` | Asset / resolution |
|---|---|---|
| absent | — | native XTZ — `storage.tez` |
| present | present | FA2 — `storage.token_fa_2.get({ contract, token_id })` |
| present | absent | FA1.2 — `storage.token_fa_1_2.get(contract)` |

`token_id: 0` **is** significant (`token_id !== undefined`); omitting it for an FA2 asset misroutes to the FA1.2 bigmap. If the Factory has no Set for the asset, the relay throws `Sapling Set not found for <key>. Has it been created in the Factory?`

### 7.3 Single vs. batch

- **Single** (one element, or a one-element array — handled identically): broadcast via `sendSaplingOpCapped(..., 'user_tx')`, which estimates gas and clamps the declared `gasLimit` to the protocol per-op cap `1_040_000`. If the op genuinely *consumes* more than the cap, it throws an actionable error: `This sapling operation needs <n> gas, over the 1040000 per-operation cap — the transaction is too large to inject (likely too many input notes; the shielded balance may need consolidating).`
- **Batch** (`> 1` element): combined into a single Tezos op group via `client.contract.batch().withContractCall(...)` — **all-or-nothing**. The batch path relies on octez.js auto-estimation and does **not** apply the explicit per-op gas clamp.

### 7.4 opHash capture & confirmations

The op hash is captured synchronously via `onBroadcast(op.hash)` immediately after `.send()` and **before** awaiting `op.confirmation(CONFIRMATIONS_PHASE2)` (default `1`). A captured hash therefore does **not** imply confirmation. On confirmation, `completeWork(..., 'completed', opHash)` stores the hash as `userTxHash`, later surfaced as both `operationHash` and `userTxHash` in the `completed` frame.

### 7.5 Two independent Phase-2 caps (distinct status codes)

Phase 2 enforces **two separate** limits with **different** status codes, and the absolute backstop is checked **first**:

1. **Absolute backstop — `400`.** `MAX_INJECT_TXS = 32`, independent of the fee schedule:
   - Each `ContractParams` element is validated with `validateTxns(txns, 32)`.
   - The **total** across all batch elements (`actualTxCount = Σ txns.length`) must be `≤ 32`; otherwise `throw new HttpError(400, "Batch too large: <N> sapling txns exceeds the 32 hard limit.")` (`processor.ts:190-191`).
2. **Fee coverage — `402`.** Only after the backstop passes, `checkSubmittedTxCount(...)` is evaluated and, on `!ok`, `throw new HttpError(402, check.reason)` (`processor.ts:202`; see §8.4). This is the economic cap, *not* the absolute one.

So the `32`-cap (`400 Batch too large`) and the fee-cap (`402`) are distinct rejections — exceeding 32 is never reported as `402`, and the backstop is evaluated before the fee check (`processor.ts:185-202`).

(Workers must be revealed before broadcasting; the relay reveals each worker's public key once at boot so a worker's first real op does not bundle a reveal and overflow the gas cap.)

---

## 8. Fee schedule

### 8.1 Units

All amounts are **integer mutez** (`bigint`), never float tez. **1 XTZ = 1 000 000 mutez.**

### 8.2 The formula (`quoteFee`)

```
n            = max(1, trunc(txCount))      // truncate toward zero, THEN clamp to ≥ 1
fee(txCount) = quantizeUp(baseMutez + perTxMutez × n, quantumMutez)

quantizeUp(v, q) = v                       if q ≤ 1
                 = v                       if v % q == 0
                 = v + (q − (v % q))       otherwise   // round UP to next multiple of q
```

- `n = BigInt(Math.max(1, Math.trunc(txCount)))` (`feeSchedule.ts:27`): `txCount` is first truncated toward zero, **then** clamped to `≥ 1` (a `0`/negative count is priced as `1`).
- `quantizeUp` is a no-op when `quantum ≤ 1n` (`feeSchedule.ts:20` — `if (quantum <= 1n) return value`), not only when `quantum == 1`.
- The computation is pure/deterministic integer math so the client preview and the relay's binding quote agree exactly.

### 8.3 Flat / legacy path

If the `/get-worker-info` request omits `txCount`, the relay quotes the flat `PAYMENT_AMOUNT_MUTEZ` and marks the job `legacyQuote = true` (`quotedTxCount` becomes `null`). Enabling the schedule does **not** change what a legacy client pays.

The processor branches **before** calling `quoteFee`: `quotedFeeMutez = txCount == null ? PAYMENT_AMOUNT_MUTEZ : quoteFee(txCount, fee)` (`processor.ts:82`). So the legacy/no-`txCount` quote is taken **directly** from `PAYMENT_AMOUNT_MUTEZ` — `quoteFee` is not invoked at all on that path.

The schedule ships **dark**: with the default params (`base = PAYMENT_AMOUNT_MUTEZ`, `perTx = 0`, `quantum = 1`) `quoteFee` would produce the flat fee for *every* `txCount`, so a scheduled quote and the flat quote coincide — byte-for-byte the legacy flat relay. (That equivalence holds only because of those defaults; it is not because the legacy branch routes through `quoteFee`.)

### 8.4 Phase-2 enforcement (`checkSubmittedTxCount`) & 402 semantics

Before injection, `submit-user-transaction` re-counts the actual Sapling txns (`Σ txns.length`) and computes a cap:

- **Scheduled job:** `cap = quotedTxCount ?? +∞`.
- **Legacy job:** `cap = LEGACY_FLAT_MAX_TXS` if `> 0`, else `+∞` (the dark default `0` means no cap; only the absolute `MAX_INJECT_TXS = 32` backstop applies).

`checkSubmittedTxCount` (`feeSchedule.ts:38-58`) is a **pure function** that carries **no status code**: it returns `{ ok: true }` or `{ ok: false; reason: string }`. The HTTP **`402` Payment Required** is assigned by the **caller** in the processor — `if (!check.ok) throw new HttpError(402, check.reason)` (`processor.ts:202`). Rejection fires **only** when `actualTxCount > cap`, and the `reason` is one of:

- Scheduled: `This batch has <N> sapling transactions but the paid fee covers <quotedTxCount>.`
- Legacy: `This batch has <N> sapling transactions but the flat fee covers <cap>. Please update your client to the fee-schedule protocol.`

Submitting **fewer** txns than quoted is always allowed (`{ ok: true }`) and is **never refunded** (a refund would create an amount-correlation channel).

Because Phase 1 is already paid and there is **no top-up channel**, a too-low quote **forfeits the prepaid fee**. Client-side `txCount` exactness is therefore a hard correctness requirement: `txCount` must count *expanded* Sapling txns (`Σ txns.length`, including note-management splits), **not** UI/asset item count. The same gate protects the relay from a "quote-1-submit-10" griefing dodge. `402` is only ever thrown in Phase 2; never in Phase 1 (the fee was paid then).

### 8.5 Empirical / recommended values

See [`FEE_SCHEDULE.md`](../FEE_SCHEDULE.md) for the full mainnet sweep. Recommended opt-in values, sized for a ≥20% profit floor on the worst-observed all-max-fragmentation batch:

| Param | Recommended |
|---|---|
| `FEE_BASE_MUTEZ` | `300000` (0.30 XTZ) |
| `FEE_PER_TX_MUTEZ` | `270000` (0.27 XTZ) |
| `FEE_QUANTUM_MUTEZ` | `250000` (0.25 XTZ) |
| `LEGACY_FLAT_MAX_TXS` | `5` |

These are the authoritative recommended values (`FEE_SCHEDULE.md:7, 75-77, 200-203, 313-314`, and the inline comment at `src/config/schema.ts:38`). They are **opt-in**, not defaults: the actual shipped (dark) defaults are `PAYMENT_AMOUNT_MUTEZ = 1_000_000n`, `FEE_BASE_MUTEZ` optional → resolves to `PAYMENT_AMOUNT`, `FEE_PER_TX_MUTEZ = 0n`, `FEE_QUANTUM_MUTEZ = 1n`, `LEGACY_FLAT_MAX_TXS = 0` (no cap).

### 8.6 Worked example

With `base = 300_000`, `perTx = 270_000`, `quantum = 250_000`:

| `txCount` | raw `base + perTx·n` | quantized (charged) |
|---|---|---|
| 1 | 570 000 (0.57) | **750 000** (0.75 XTZ) |
| 2 | 840 000 (0.84) | **1 000 000** (1.00 XTZ) |
| 3 | 1 110 000 (1.11) | **1 250 000** (1.25 XTZ) |
| 5 | 1 650 000 (1.65) | **1 750 000** (1.75 XTZ) |
| 10 | 3 000 000 (3.00) | **3 000 000** (3.00 XTZ) |

Every charged value is a multiple of the `0.25 XTZ` quantum, so fees land on a coarse grid instead of exposing exact per-byte cost. Note that with the recommended `perTxMutez (270k) > quantumMutez (250k)`, each added txn advances by at least one quantum, so consecutive `txCount`s do **not** collapse onto a shared value — the value-collapse privacy property (`FEE_SCHEDULE.md §4`) holds only for a schedule with `perTx < quantum`.

---

## 9. Data types

```ts
/** The unit a client submits; the relay broadcasts it verbatim. txns are opaque hex. */
interface ContractParams {
  txns: string[];     // hex-encoded sapling transactions; non-empty; each /^[0-9a-fA-F]+$/, len ≤ 100000
  contract?: string;  // token contract KT1...; omitted/undefined => native XTZ
  token_id?: number;  // FA2 token id (snake_case); present => FA2, absent-with-contract => FA1.2
}

/** POST /get-worker-info response payload (wrapped in { success, data }). */
interface WorkerInfo {
  jobId: string;                 // "job-<uuid>"
  workerIndex: number;           // = paymentPoolIndex
  address: string;               // the payment worker's public tz1
  paymentMode: 'unshield';       // literal
  paymentAmount: string;         // quoted fee in XTZ as a string (mutez / 1_000_000)
  quotedTxCount: number | null;  // echoes requested txCount, or null in legacy mode
  feeSchedule: { baseMutez: number; perTxMutez: number; quantumMutez: number };
  jobSecret: string;             // base64url 24-byte token — emitted exactly once
}

/** GET /status/:jobId payload (wrapped in { success, data }). */
interface StatusFrame {
  jobId: string;
  status: WireStatus | 'not_found';
  operationHash?: string;        // only on completed; == userTxHash
  userTxHash?: string;           // only on completed; == operationHash
  error?: string;                // failure message, or literal 'unauthorized'
}

type WireStatus =
  | 'queued' | 'verifying_payment' | 'payment_confirmed'
  | 'injecting_user_tx' | 'completed' | 'payment_failed' | 'user_tx_failed';

/** GET /info and GET /.well-known/shield-relay.json — returned RAW (no wrapper). */
interface RelayInfo {
  protocol: string;              // always 'shield-relay/1'
  network: string;               // cfg.TEZOS_NETWORK ('mainnet' | 'shadownet')
  factoryContract: string;
  paymentMode: 'unshield';       // literal
  fee: {
    model: 'flat' | 'scheduled'; // 'scheduled' iff feeSchedule.perTxMutez > 0, else 'flat' (derived)
    flatMutez: string;           // STRING — String(PAYMENT_AMOUNT_MUTEZ); legacy/no-txCount quote
  };
  feeSchedule: { baseMutez: number; perTxMutez: number; quantumMutez: number }; // NUMBERs
  transport: 'poll';             // literal — the single status transport since WS→poll
}

/** Bare progress objects from the two POST submit endpoints (note the `message` field, absent from StatusFrame). */
interface SubmitResult { jobId: string; status: WireStatus; message: string; }

/** Error body. */
interface ErrorBody { error: string; code?: string; } // code absent on 500 'Internal server error'
```

> **Type asymmetry inside `RelayInfo`:** `fee.flatMutez` is a **string**; the three `feeSchedule.*` fields are **numbers** (converted from bigints via `Number()`, so values above 2^53−1 would lose precision — which is why `flatMutez` is stringified instead). A client can recompute `fee.model` itself: `scheduled` iff `feeSchedule.perTxMutez > 0`.

---

## 10. End-to-end sequence

```mermaid
sequenceDiagram
    participant C as Client
    participant R as Relay (HTTP)
    participant Wp as Payment worker (tz1 A)
    participant Wb as Broadcast worker (tz1 B)
    participant Tz as Tezos chain

    C->>R: GET /info  (or /.well-known/shield-relay.json)
    R-->>C: 200 RelayInfo { protocol, network, fee, feeSchedule, transport:"poll" }  (raw)

    C->>R: POST /get-worker-info { txCount: 3 }
    R-->>C: 200 { success, data: WorkerInfo { jobId, address(=A), paymentAmount, jobSecret } }
    Note over R: job status = info_generated (hidden as not_found on the wire)

    C->>C: craft unshield of fee -> worker tz1 A (exactly 1 sapling txn)
    C->>R: POST /submit-payment { jobId, jobSecret, paymentTransaction }
    Note over R: verifyPaymentUnshield (simulate) -> consume paymentDigest -> pin counter
    R-->>C: 202 { jobId, status:"queued", message }  (BARE)
    R->>Tz: broadcastPayment (from tz1 A)
    Note over R: status -> verifying_payment ; await CONFIRMATIONS_PHASE1 (=2)
    Tz-->>R: included
    Note over R: verifyPaymentLanded (applied-check, pass index 3) -> payment_confirmed

    loop poll until payment_confirmed
        C->>R: GET /status/:jobId  (x-job-secret)
        R-->>C: 200 { success, data: { status: "verifying_payment" | "payment_confirmed" } }
    end

    C->>R: POST /submit-user-transaction { jobId, jobSecret, userTransaction }
    Note over R: gate payment_confirmed ; tx count <= quote & <= 32 (else 402/400)
    R-->>C: 200 { success, data: { status:"injecting_user_tx", message } }
    R->>Tz: injectUserTransaction (from DISTINCT tz1 B)
    Note over R: capture opHash (pre-confirm) ; await CONFIRMATIONS_PHASE2 (=1)
    Tz-->>R: confirmed -> completed (userTxHash = opHash)

    loop poll until completed
        C->>R: GET /status/:jobId  (x-job-secret)
        R-->>C: 200 { success, data: { status:"completed", operationHash, userTxHash } }
    end
```

---

## 11. Error code reference

| HTTP | `code` | Message / meaning | Where |
|---|---|---|---|
| `400` | — | `Missing jobId.` | submit-payment, submit-user-transaction |
| `400` | — | `Invalid txCount: must be an integer in [1, 256].` | get-worker-info |
| `400` | — | `Transaction must include a non-empty txns array.` | submit-payment, submit-user-transaction |
| `400` | — | `Too many sapling txns in one operation (<n> > <max>).` (`max`=1 payment, `max`=32 user) | submit-payment, submit-user-transaction |
| `400` | — | `Invalid sapling transaction: must be a hex string.` | submit-payment, submit-user-transaction |
| `400` | — | `Batch too large: <n> sapling txns exceeds the 32 hard limit.` | submit-user-transaction |
| `401` | — | `Missing job secret.` | submit-payment, submit-user-transaction |
| `401` | — | (empty body) bad/missing `Authorization: Bearer <token>` | /metrics |
| `402` | — | `This batch has <n> sapling transactions but the paid fee covers <quotedTxCount>.` | submit-user-transaction (scheduled) |
| `402` | — | `This batch has <n> sapling transactions but the flat fee covers <cap>. Please update your client to the fee-schedule protocol.` | submit-user-transaction (legacy) |
| `403` | — | `Invalid job secret.` | submit-payment, submit-user-transaction |
| `404` | — | `Job not found: <jobId>` | submit-payment, submit-user-transaction |
| `404` | — | (legacy/flat relay signal) | /info, /.well-known/shield-relay.json |
| `404` | — | (empty body) metrics disabled (`METRICS_TOKEN` unset) | /metrics |
| `409` | — | `Invalid job status: <status>. Already submitted?` | submit-payment |
| `409` | — | `Job status changed (concurrent submit).` | submit-payment |
| `409` | — | `Job already consumed.` | submit-user-transaction |
| `409` | — | `Payment not confirmed yet (status: <status>).` | submit-user-transaction |
| `409` | — | `Job already consumed (concurrent submit).` | submit-user-transaction |
| `429` | — | per-IP rate limit exceeded | all routes (loopback exempt); emitted by `@fastify/rate-limit`'s own hook, which runs **before** the CORS hook, so this response likely carries **no** CORS headers (see §2.2) |
| `500` | *(none)* | `Internal server error` (no `code` field) | any unhandled exception |
| `503` | — | `{ status: "not_ready" }` (pool not built / draining) | /readyz |

*All error bodies are `{ error, code? }` except the `500` fallback (`{ error }` only) and the empty-body `/metrics` 401/404.*

`GET /status/:jobId` does not use this error envelope; failures and unknown jobs are reported as `200` `not_found` frames (see §5).

---

## 12. Configuration knobs affecting the wire

Protocol-relevant environment variables (the full surface is declared in `src/config/schema.ts`; derived fields are marked). `factoryContract`, `rpcUrl`, `fee.*`, and `legacyFlatMaxTxs` are **derived** transforms, not raw env vars.

| Env var | Type / default | Wire effect |
|---|---|---|
| `TEZOS_NETWORK` | enum `mainnet`\|`shadownet`, default `mainnet` | Reported as `RelayInfo.network`; also selects default factory & RPC. |
| `SHIELD_BRIDGE_CONTRACT` | string, optional | Overrides derived `factoryContract` (else per-network default); reported as `RelayInfo.factoryContract`. |
| `TEZOS_RPC_URL` | url, optional | Overrides derived `rpcUrl` (else per-network default). |
| `PAYMENT_AMOUNT_MUTEZ` | bigint, default `1_000_000n` (1 XTZ) | Legacy flat quote; reported as `RelayInfo.fee.flatMutez` (stringified). |
| `FEE_BASE_MUTEZ` | bigint, optional → `fee.baseMutez` (default = `PAYMENT_AMOUNT_MUTEZ`) | `feeSchedule.baseMutez`; fee formula base. |
| `FEE_PER_TX_MUTEZ` | bigint, default `0n` → `fee.perTxMutez` | `feeSchedule.perTxMutez`; `> 0` ⇒ `fee.model = 'scheduled'`. |
| `FEE_QUANTUM_MUTEZ` | bigint, default `1n` (positive) → `fee.quantumMutez` | `feeSchedule.quantumMutez`; quantization step. |
| `LEGACY_FLAT_MAX_TXS` | int, default `0` (= no cap) → `legacyFlatMaxTxs` | Phase-2 cap for legacy (no-`txCount`) jobs. |
| `REQUIRE_JOB_SECRET` | bool, default `true` | Whether a missing `jobSecret` is rejected (`401`/`not_found`). |
| `CONFIRMATIONS_PHASE1` | int, default `2` | Confirmations before trusting the Phase-1 payment. |
| `CONFIRMATIONS_PHASE2` | int, default `1` | Confirmations before marking the job `completed`. |
| `JOB_TTL_SECONDS` | int, default `3600` | Advisory job retention (not swept; see §5.4). |
| `PORT` | int, default `8080` | Listen port. |
| `RATE_LIMIT_RPM` | int, default `120` | Per-IP request cap before `429` (loopback exempt). |
| `TRUST_PROXY` | bool, default `false` | Trust `X-Forwarded-For` for rate-limit keying (only behind a proxy). |
| `METRICS_TOKEN` | string (min 1), optional | Enables `/metrics`; scrapers must send `Authorization: Bearer <token>`. Unset ⇒ `/metrics` 404. |

Hard-coded protocol constants: `MAX_INJECT_TXS = 32`, `MAX_TX_COUNT = 256` (quote `txCount` upper bound), `MAX_TXN_HEX = 100_000` (per-txn hex length cap), `HARD_GAS_LIMIT_PER_OP = 1_040_000`.

> **Load-time refinement:** the effective fee base (`FEE_BASE_MUTEZ ?? PAYMENT_AMOUNT_MUTEZ`) must be `> 0`, else the relay refuses to start (`Effective fee base must be > 0 ... — a non-positive base disables payment verification.`) — a `0` base would make the Phase-1 `received >= quoted` check vacuously true (free injection).
>
> **Not part of this protocol:** there is no `RELAY_PUBLIC_URL`, `MAX_CONNECTIONS`, or `MAX_INFLIGHT` knob anywhere in the source.

---

## 13. Versioning & conformance

### 13.1 What `shield-relay/1` guarantees

- The endpoint set, methods, and paths of §4.
- The envelope rules of §2.4 (including the asymmetry) and the error envelope of §2.5.
- The wire status set of §5.1 (7 statuses + the `not_found` sentinel), and the hiding of `info_generated`.
- The two-phase, two-distinct-worker flow with verify-before-broadcast.
- `paymentMode: 'unshield'`, `transport: 'poll'`, and `protocol: 'shield-relay/1'` in `RelayInfo`.

### 13.2 Negotiation via `/info`

A conforming client SHOULD probe `GET /.well-known/shield-relay.json` (or `/info`) first and negotiate from the descriptor:

- **Transport:** read `transport` (currently always `'poll'` — poll `GET /status/:jobId`).
- **Fee model:** read `fee.model` (or recompute: `scheduled` iff `feeSchedule.perTxMutez > 0`). For a scheduled relay, compute the quote client-side with the §8.2 formula and send `txCount` to `get-worker-info`. For a flat relay, omit `txCount`.

### 13.3 Backward compatibility

- **Legacy / flat relays:** a `404` on `/info` signals a legacy/flat relay; the client should default to a **1 XTZ** fee and the legacy (no-`txCount`) path. A dark-default scheduled relay (`perTxMutez == 0`) reports `fee.model = 'flat'` and prices every job at the flat fee.
- **`json.data ?? json` parsing:** the deliberate envelope design lets a single client parser handle both wrapped (`{ success, data }`) and raw/bare responses. The `?? json` fallback is **required** to correctly read `POST /submit-payment` (bare `202`), `/info`, `/.well-known/shield-relay.json`, `/healthz`, and `/readyz`.
- **Legacy job rows** without a stored `jobSecretHash` are treated as `ok` by the auth check; all jobs minted by this protocol version always store a hash.
- **`txCount` exactness** is a hard client requirement on scheduled relays: under-quoting forfeits the prepaid fee (no top-up, no refund). Count *expanded* Sapling txns (`Σ txns.length`), not UI items.
