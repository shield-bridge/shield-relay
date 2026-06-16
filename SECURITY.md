# Security Policy

`shield-relay` is a key-custody, fee-handling **privacy** relay. We take security and
operator/user anonymity seriously and welcome responsible disclosure.

> **Status:** this repository is an early scaffold (see the README). It has not yet
> cleared the production-migration gates in [`DESIGN.md`](./DESIGN.md) §8. Run it on
> shadownet or low-value flows until then.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Report privately, via either:

1. **GitHub private vulnerability reporting** (preferred) — on this repo, go to the
   **Security** tab → **Report a vulnerability**. This opens a private advisory only
   the maintainer can see.
2. **Email** — `andrewkishino@gmail.com` with `[shield-relay security]` in the subject.

Please include: a description, affected version/commit, reproduction steps or a PoC,
and the impact you believe it has. If you'd like, tell us how you want to be credited.

**Response expectations:** this is a small, best-effort open-source project — there is
no bug bounty. We aim to acknowledge a report within a few days and to coordinate a fix
and disclosure timeline with you. Please give us a reasonable window to remediate before
any public disclosure.

## What's in scope

The relay's trust model is deliberately **bounded**: a malicious or buggy relay can at
worst *refuse* to broadcast, costing a user at most one prepaid fee — it cannot see a
user's amount/asset/sender/recipient and cannot redirect funds. Reports that
**break that bound** are the most valuable. In particular:

- **Free-injection / payment bypass** — getting the relay to broadcast a user op without
  a verified, applied fee payment to the worker's `tz1` (the verify-before-broadcast
  firewall in `src/core/payment.ts`).
- **Fee theft or double-spend / replay** — bypassing the `paymentDigest` replay guard or
  the post-confirmation applied-check.
- **Broadcast hijack / fund redirection** — making the relay sign or broadcast something
  other than the exact op the user submitted, or pay a fee to the wrong address.
- **Key-custody exposure** — any path that leaks a worker secret key / pool mnemonic, or
  logs/images key material (the redaction allowlist in `src/observability/logger.ts`).
- **Anonymity / unlinkability breaks** — deanonymizing the payer or pairing the public
  fee receipt with a user's op beyond what the two-worker design already discloses
  (note: `WORKER_COUNT=1` *intentionally* collapses both phases onto one `tz1` — that is
  documented, not a vulnerability).
- **Auth bypass** — defeating the per-job `jobSecret` gate (`src/server/auth.ts`).
- **Remote crashes / RCE / resource exhaustion** beyond the documented rate limits.

## Out of scope

- Issues that require a misconfigured deployment the docs warn against (e.g. exposing
  `/metrics` without a token, or putting `DATA_DIR` on a networked filesystem).
- The bounded "a relay can refuse" behavior itself.
- Vulnerabilities in third-party dependencies with no demonstrated impact here (report
  those upstream; tell us if the relay is exploitable through one).

## Supported versions

The project is pre-1.0; only the latest `main` is supported. Fixes land on `main` and in
the next tagged release.
