# Fee Schedule — Replacing the Flat 1 XTZ Relay Fee

**Status:** design proposal (not implemented). Companion to `DESIGN.md` (`shield-relay/1`).
**Source data:** mainnet operation [`ooRSpM5TDKpr1SEchYaxhJgFQQrzGB1sTZWLZXauMV49kr5AhkZ`](https://tzkt.io/ooRSpM5TDKpr1SEchYaxhJgFQQrzGB1sTZWLZXauMV49kr5AhkZ) — a real 10-asset relay batch (20 contents) that collected the flat 1 XTZ fee.

---

## 1. The problem: the flat fee is underwater at the batch cap

The relay charges a flat fee (`PAYMENT_AMOUNT_MUTEZ`, default 1 XTZ —
`src/config/schema.ts`) regardless of how many sapling transactions the job
injects. Measured against the real batch above:

| Component | Cost (XTZ) |
| --- | --- |
| Baker fee (gas + op bytes) | 0.0548 |
| **Storage burn** (contract storage growth) | **0.8455** |
| **Total cost** | **0.900** |
| Revenue (flat fee) | 1.000 |

Storage burn is **94% of real cost** and was the term the original "margin is
90–99%" estimate missed. Every sapling `default` call appends nullifiers,
commitments, and ciphertexts to contract storage — measured **307–371 bytes per
sapling tx**, i.e. **0.077–0.093 XTZ per tx** at the protocol's 250 µꜩ/byte.
Gas + operation bytes add only ~0.005–0.008 XTZ per tx (~1.5 KB and ~31k gas per
sapling tx; ~82k gas for the XTZ set).

Per-job economics at the flat 1 XTZ fee:

| Job shape | Approx. cost (XTZ) | Margin |
| --- | --- | --- |
| Single transfer/unshield (Phase 1 payment + Phase 2 tx + amortized fee-redemption ~0.085) | ~0.18 | ~82% |
| 10-item batch, 2-output notes | ~0.90–1.12 | **break-even to LOSS** |

The client's `BATCH_MAX_ITEMS = 10` sits exactly at the underwater point: the
relay's worst-case legal job is its least profitable. That is an open griefing
invariant violation — a hostile (or merely thrifty) user can have the relay
inject at a loss all day.

A second consequence: because storage bytes are deterministic from the
client-built sapling transaction (spend/output counts are known before
submission), the true cost is **pre-quotable on the client** — there is no
oracle problem. We just never priced it.

## 2. Proposed model: quantized linear schedule

```
fee(txCount) = quantizeUp(baseMutez + perTxMutez × txCount, quantumMutez)
```

Recommended starting parameters (calibrated to the measured costs above):

| Parameter | Value | Rationale |
| --- | --- | --- |
| `baseMutez` | 250_000 (0.25 XTZ) | covers Phase-1 payment injection + amortized fee-redemption leg + ops margin |
| `perTxMutez` | 150_000 (0.15 XTZ) | covers per-tx storage burn (0.077–0.093) + gas with ~60% headroom for note-shape variance |
| `quantumMutez` | 250_000 (0.25 XTZ) | privacy quantization — see §4 |

Resulting tier table (quantize **up**, never down):

| txCount | raw (XTZ) | charged (XTZ) | est. cost | margin |
| --- | --- | --- | --- | --- |
| 1 | 0.40 | **0.50** | ~0.18 | ~64% |
| 2 | 0.55 | **0.75** | ~0.27 | ~64% |
| 3 | 0.70 | **0.75** | ~0.36 | ~52% |
| 5 | 1.00 | **1.00** | ~0.54 | ~46% |
| 10 | 1.75 | **1.75** | ~0.99–1.12 | ~36–43% |

Singles get *cheaper* than today (0.50 vs 1.00) while the batch cap becomes
solidly profitable. Note the whole table collapses to only a handful of
distinct on-chain-visible values: {0.50, 0.75, 1.00, 1.25, 1.50, 1.75} — that
is deliberate (§4).

## 3. Protocol changes (`shield-relay/1` → additive, not breaking)

### 3.1 Quote at `POST /get-worker-info`

The client already knows its item count before requesting worker info. Add an
optional request body:

```jsonc
{ "txCount": 3 }   // omitted by legacy clients
```

`Processor.getWorkerInfo()` (`src/runtime/processor.ts`) computes
`quotedFeeMutez = schedule(txCount)` and:

- stores `quotedFeeMutez` **and** `quotedTxCount` on the job row (new columns,
  written in the same `store.createJob` call — the quote must be durable, it is
  what Phase 1 verification checks after a restart);
- returns them in the response alongside the existing fields. The response
  already carries `paymentAmount` as a string — keep that field but make it the
  *quoted* amount, so a schedule-aware client needs no new parsing.
- additionally returns the raw schedule
  (`feeSchedule: { baseMutez, perTxMutez, quantumMutez }`) so clients can show
  a fee preview *before* hitting the endpoint (e.g. while the user builds a
  batch).

**No `txCount` in the request** → legacy path: quote `PAYMENT_AMOUNT_MUTEZ`
(flat 1 XTZ) and mark the job `legacyQuote = true`. See §5 for the cap that
makes this safe.

### 3.2 Verify at Phase 1 — already 90% built

`verifyPaymentMemo(sdk, memo, expectedMutez)` (`src/core/payment.ts`) already
does an integer-mutez `receivedMutez >= expectedMutez` check. The only change:
the processor passes the job's stored `quotedFeeMutez` instead of the global
`PAYMENT_AMOUNT_MUTEZ` (`src/runtime/processor.ts`, the
`verifyPaymentMemo(worker.sdk, job.memo, …)` call).

### 3.3 Enforce at Phase 2 — **before** injection

`submitUserTransaction` must count the sapling transactions in the submitted
`userTransaction` payload and reject with a 4xx **before enqueueing** if
`actualTxCount > job.quotedTxCount`. This closes the obvious dodge (quote for
1, submit 10). Rejecting before injection means the user loses nothing they
hadn't already spent; the job stays in a resumable state so the client can
re-quote and retry with a top-up payment — or simply fail with a clear error
("batch has 10 transactions but the fee paid covers 1").

Submitting *fewer* txs than quoted is always fine (user overpaid; their
choice; do not refund — refunds would create an amount-correlation channel).

### 3.4 Publish in the relay descriptor

When `GET /.well-known/shield-relay.json` lands (DESIGN.md blueprint), the
schedule belongs in it:

```jsonc
{
  "protocol": "shield-relay/1",
  "feeSchedule": { "baseMutez": 250000, "perTxMutez": 150000, "quantumMutez": 250000 }
}
```

This is what makes a future multi-relay client able to show fees without
creating a job — and it keeps the network's "sort by trust, never by fee"
stance honest, because fees are public and comparable but not the ranking key.

### 3.5 Config

```
FEE_BASE_MUTEZ      (default 250_000)
FEE_PER_TX_MUTEZ    (default 150_000)
FEE_QUANTUM_MUTEZ   (default 250_000)
LEGACY_FLAT_MAX_TXS (default 5 — see §5)
```

`PAYMENT_AMOUNT_MUTEZ` stays as the legacy flat quote. Setting
`FEE_PER_TX_MUTEZ=0` and `FEE_BASE_MUTEZ=PAYMENT_AMOUNT_MUTEZ` reproduces
today's behavior exactly, so the feature ships dark.

## 4. Why quantized: the fee-redemption fingerprint

The fee payment itself is a shielded transfer (zet → worker zet) — its amount
is **not** public. But the redemption leg is: `refillWorkerGas`
(`src/core/gasRefill.ts`) unshields the worker's **entire accumulated sapling
balance** to its public tz1, and unshield boundary amounts are visible
on-chain.

With exact per-byte pricing, that unshield amount is a subset-sum over a large
set of distinct per-job fees — frequently decomposable, letting a passive
observer recover the relay's job-shape mix (and, with timing, sometimes
individual jobs). With 0.25-quantized fees, every redemption amount is a
multiple of 0.25 XTZ composed from ~6 possible values — the decomposition is
maximally degenerate and the observer learns little beyond "n jobs, roughly".

Two cheap hardenings to adopt alongside (both already consistent with the
gas-refill design):

1. **Threshold-triggered, not schedule-triggered** redemption (already true:
   refill fires on gas balance, not a timer tick per job).
2. **Leave a random remainder**: unshield
   `balance − uniform(0, 2 × quantum)` rounded to the quantum instead of the
   full balance, so consecutive redemptions don't telescope into an exact
   running sum. One-line change in `refillWorkerGas`; costs nothing.

The same logic is why the schedule should stay **coarse**. Resist per-byte or
per-output precision: every extra distinct fee value is anonymity-set
fragmentation in the redemption stream. The headroom in `perTxMutez` is the
price of privacy, and at ~40–60% margins it is affordable.

## 5. Back-compat and rollout

The deployed clients (V2 root + legacy) pay a hardcoded flat 1 XTZ and never
send `txCount`. The v3 client hardcodes `RELAY_FEE_XTZ = 1`
(`src/app/core/bridge/engine.ts` in shield-bridge). None of them break:

1. **Relay ships dark** (defaults reproduce flat pricing, §3.5).
2. **Flip the schedule on.** Legacy (no-`txCount`) jobs keep being quoted the
   flat 1 XTZ — but Phase 2 enforces `LEGACY_FLAT_MAX_TXS` (default 5, the
   point where flat 1 XTZ still clears cost). A legacy client submitting a
   6–10-item batch gets a clean 4xx before injection with a "please update"
   message. This converts the silent loss into an explicit, harmless error
   for the rare large-batch legacy user.
3. **Clients adopt the quote.** shield-bridge changes, in order:
   - read `paymentAmount` from the `get-worker-info` response instead of the
     hardcoded constant (the response field already exists — today's clients
     just ignore it in favor of the constant);
   - send `txCount` (single ops send 1; `useBatch` knows its valid-item count);
   - surface the quoted fee in the existing fee rows (Bridge single-form fee
     row, batch cart fee row, ScanToPay "Via" row) — all three currently
     render the `RELAY_FEE_XTZ` constant, so this is a presentation swap, not
     new UI;
   - use `feeSchedule` from the descriptor for the pre-submit preview while
     building a batch (live "Relay fee: 0.75 XTZ" as rows are added).
4. **Eventually** drop `LEGACY_FLAT_MAX_TXS` once flat-fee client traffic is
   gone (observable: jobs with `legacyQuote = true` per week → 0).

Singles getting cheaper (1.00 → 0.50) means the upgrade is user-positive on
day one, which is the adoption story: there is no "fee increase" framing —
batches stop being subsidized by the relay, singles stop subsidizing batches.

## 6. Open questions

1. **Note-shape variance.** The 307–371-byte range comes from one measured
   operation. 2-output notes (change + payment) sit at the high end; worth
   measuring a wider sample before locking `perTxMutez = 0.15`. The one
   unverified economic input flagged in the network design doc applies here
   too: an empirical sweep over note shapes would firm up the constant.
2. **XTZ vs FA-token pools.** The measured op mixed pools; gas differs (XTZ
   set ~82k vs ~31k) but storage — the dominant term — does not vary much by
   pool. Proposal treats all pools identically; revisit only if a measured
   gap exceeds the quantum.
3. **Should `txCount` count sapling txs or contents?** This doc assumes
   *sapling transactions* (what the client calls batch items), since storage
   burn scales with those. If a single item can expand to multiple sapling
   txs (e.g. note-management splits), count the expanded number — the client
   builds the params, so it knows.
4. **Quote TTL.** The quote is pinned to the job row and jobs already expire
   (`JOB_TTL_SECONDS`); no separate quote expiry is needed unless schedule
   changes mid-flight become common. Recommendation: schedule changes only
   apply to new jobs; stored quotes are honored until job expiry.
