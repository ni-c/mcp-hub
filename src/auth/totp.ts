import crypto from 'node:crypto';

// RFC 6238 TOTP: SHA-1, six digits, 30-second steps.

export const TOTP_PERIOD_S = 30;
const DIGITS = 6;
const MIN_SECRET_BYTES = 20;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Case, spaces and trailing padding are forgiven; anything else outside the alphabet is not. */
export function base32Decode(text: string): Buffer | undefined {
  let cleaned = text.replace(/\s+/g, '').toUpperCase();
  let end = cleaned.length;
  while (end > 0 && cleaned[end - 1] === '=') end--;
  cleaned = cleaned.slice(0, end);
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of cleaned) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) return undefined;
    value = ((value << 5) | index) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function generateTotpSecret(): string {
  return base32Encode(crypto.randomBytes(MIN_SECRET_BYTES));
}

export function hotp(key: Buffer, counter: number): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', key).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

export function totpStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_PERIOD_S);
}

/** The step a code belongs to (one step of drift either way), or undefined. */
export function verifyTotp(key: Buffer, code: string, nowMs: number): number | undefined {
  const given = code.replace(/\s+/g, '');
  if (!/^[0-9]{6}$/.test(given)) return undefined;
  const current = totpStep(nowMs);
  let matched: number | undefined;
  for (const step of [current - 1, current, current + 1]) {
    if (step < 0) continue;
    if (crypto.timingSafeEqual(Buffer.from(hotp(key, step)), Buffer.from(given))) matched = step;
  }
  return matched;
}

export interface TotpSecret {
  key?: Buffer;
  problem?: string;
}

export function parseTotpSecret(raw: string | undefined): TotpSecret {
  if (raw === undefined || raw.trim() === '') return { problem: 'TOTP_SECRET is not set' };
  const key = base32Decode(raw);
  if (!key) return { problem: 'TOTP_SECRET is not Base32 (A–Z and 2–7, spaces and padding allowed)' };
  if (key.length < MIN_SECRET_BYTES) {
    return { problem: `TOTP_SECRET is shorter than ${MIN_SECRET_BYTES} bytes (160 bits) — generate one with mcp-hub-admin totp init` };
  }
  return { key };
}

export function otpauthUri(secret: string, account: string, issuer = 'mcp-hub'): string {
  const query = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(TOTP_PERIOD_S) });
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?${query}`;
}

export function appleOtpauthUri(secret: string, account: string, issuer = 'mcp-hub'): string {
  return otpauthUri(secret, account, issuer).replace(/^otpauth:/, 'apple-otpauth:');
}
