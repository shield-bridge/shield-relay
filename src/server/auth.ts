import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

/** Mint a 192-bit URL-safe per-job capability token. */
export function generateJobSecret(): string {
  return randomBytes(24).toString('base64url');
}

/** sha256 hex — only the hash is ever stored. */
export function hashJobSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

export function verifyJobSecret(provided: string | undefined, expectedHash: string | undefined): boolean {
  if (!provided || !expectedHash) return false;
  const a = Buffer.from(hashJobSecret(provided), 'hex');
  const b = Buffer.from(expectedHash, 'hex');
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

export type JobSecretCheck = 'ok' | 'missing' | 'mismatch';

/**
 * Decide whether a request may act on a job. No stored hash (legacy) → ok; a
 * present-but-wrong secret is ALWAYS 'mismatch' (rejected regardless of `required`).
 */
export function checkJobSecret(
  provided: string | undefined,
  expectedHash: string | undefined,
  required: boolean,
): JobSecretCheck {
  if (!expectedHash) return 'ok';
  if (!provided) return required ? 'missing' : 'ok';
  return verifyJobSecret(provided, expectedHash) ? 'ok' : 'mismatch';
}

const MEMO_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** 8-char alphanumeric payment memo (matches the existing relay). */
export function generateMemo(): string {
  const bytes = randomBytes(8);
  let memo = '';
  for (let i = 0; i < 8; i++) memo += MEMO_CHARS[bytes[i]! % MEMO_CHARS.length];
  return memo;
}
