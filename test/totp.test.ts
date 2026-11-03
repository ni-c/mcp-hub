import { describe, expect, it } from 'vitest';

import {
  appleOtpauthUri,
  base32Decode,
  base32Encode,
  generateTotpSecret,
  hotp,
  otpauthUri,
  parseTotpSecret,
  TOTP_PERIOD_S,
  totpStep,
  verifyTotp
} from '../src/auth/totp.js';

/** RFC 6238 appendix B: the SHA-1 seed is the ASCII string "12345678901234567890". */
const RFC_KEY = Buffer.from('12345678901234567890', 'ascii');
const at = (seconds: number) => seconds * 1000;

describe('hotp', () => {
  // RFC 4226 appendix D, the same 20-byte seed.
  it.each([
    [0, '755224'],
    [1, '287082'],
    [2, '359152'],
    [9, '520489']
  ])('counter %i gives %s', (counter, code) => {
    expect(hotp(RFC_KEY, counter)).toBe(code);
  });
});

describe('totp', () => {
  // RFC 6238 appendix B, SHA-1 column, reduced to six digits.
  it.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
    [20000000000, '353130']
  ])('at T=%i the code is %s', (seconds, code) => {
    expect(hotp(RFC_KEY, totpStep(at(seconds)))).toBe(code);
  });

  it('counts 30-second steps from the epoch', () => {
    expect(TOTP_PERIOD_S).toBe(30);
    expect(totpStep(0)).toBe(0);
    expect(totpStep(at(29.999))).toBe(0);
    expect(totpStep(at(30))).toBe(1);
  });
});

describe('verifyTotp', () => {
  const now = at(1234567890);
  const step = totpStep(now);
  const codeFor = (offset: number) => hotp(RFC_KEY, step + offset);

  it('accepts the current step and returns it', () => {
    expect(verifyTotp(RFC_KEY, codeFor(0), now)).toBe(step);
  });

  it.each([-1, 1])('accepts one step of drift (%i) and names the step it matched', offset => {
    expect(verifyTotp(RFC_KEY, codeFor(offset), now)).toBe(step + offset);
  });

  it.each([-2, 2, -10, 10])('refuses a code %i steps away', offset => {
    expect(verifyTotp(RFC_KEY, codeFor(offset), now)).toBeUndefined();
  });

  it('accepts the code with the spaces an authenticator shows', () => {
    const code = codeFor(0);
    expect(verifyTotp(RFC_KEY, `${code.slice(0, 3)} ${code.slice(3)}`, now)).toBe(step);
    expect(verifyTotp(RFC_KEY, ` ${code}\t`, now)).toBe(step);
  });

  it.each(['', '      ', '12345', '1234567', 'abcdef', '12 34 5', '١٢٣٤٥٦', '+12345', '1e5000'])('refuses the malformed code %j', code => {
    expect(verifyTotp(RFC_KEY, code, now)).toBeUndefined();
  });

  it('refuses a code made with another key', () => {
    const other = Buffer.from('09876543210987654321', 'ascii');
    expect(verifyTotp(RFC_KEY, hotp(other, step), now)).toBeUndefined();
  });

  it('works at the very first step, where there is no previous one', () => {
    expect(verifyTotp(RFC_KEY, hotp(RFC_KEY, 0), 0)).toBe(0);
    expect(verifyTotp(RFC_KEY, hotp(RFC_KEY, 1), 0)).toBe(1);
  });
});

describe('base32', () => {
  // RFC 4648 §10, without padding.
  it.each([
    ['', ''],
    ['f', 'MY'],
    ['fo', 'MZXQ'],
    ['foo', 'MZXW6'],
    ['foob', 'MZXW6YQ'],
    ['fooba', 'MZXW6YTB'],
    ['foobar', 'MZXW6YTBOI']
  ])('encodes %j as %s', (plain, encoded) => {
    expect(base32Encode(Buffer.from(plain))).toBe(encoded);
    expect(base32Decode(encoded)?.toString()).toBe(plain);
  });

  it('decodes the forms people paste: lower case, groups, padding', () => {
    expect(base32Decode('mzxw 6ytb oi======')?.toString()).toBe('foobar');
    expect(base32Decode('MZXW6YTBOI==')?.toString()).toBe('foobar');
  });

  it.each(['MZXW1', 'MZXW8', 'MZ=XW', 'MZXW6YTBOI=x', 'é'])('refuses %j', text => {
    expect(base32Decode(text)).toBeUndefined();
  });

  it('stays linear on a long run of padding that is not at the end', () => {
    const hostile = `${'='.repeat(100_000)}x`;
    const started = performance.now();
    expect(base32Decode(hostile)).toBeUndefined();
    expect(base32Decode(`MZXW6YTBOI${'='.repeat(100_000)}`)?.toString()).toBe('foobar');
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it('round-trips random bytes', () => {
    for (let length = 0; length < 40; length++) {
      const bytes = Buffer.from(Array.from({ length }, (_, i) => (i * 37 + length) & 0xff));
      expect(base32Decode(base32Encode(bytes))?.equals(bytes)).toBe(true);
    }
  });
});

describe('generateTotpSecret', () => {
  it('makes 160-bit secrets that parse, and different ones each time', () => {
    const first = generateTotpSecret();
    const second = generateTotpSecret();
    expect(first).toMatch(/^[A-Z2-7]{32}$/);
    expect(first).not.toBe(second);
    expect(parseTotpSecret(first).key?.length).toBe(20);
  });
});

describe('parseTotpSecret', () => {
  it('reports a missing secret', () => {
    expect(parseTotpSecret(undefined)).toEqual({ problem: expect.stringContaining('TOTP_SECRET is not set') });
    expect(parseTotpSecret('   ')).toEqual({ problem: expect.stringContaining('TOTP_SECRET is not set') });
  });

  it('refuses a secret that is not Base32 without echoing it', () => {
    const result = parseTotpSecret('not!base32-at-all-but-quite-long');
    expect(result.key).toBeUndefined();
    expect(result.problem).toContain('not Base32');
    expect(result.problem).not.toContain('not!base32');
  });

  it('refuses a secret under 160 bits', () => {
    const short = base32Encode(Buffer.alloc(16, 7));
    expect(parseTotpSecret(short)).toEqual({ problem: expect.stringContaining('shorter than 20 bytes') });
  });

  it('accepts 160 bits and more, in pasted form', () => {
    const encoded = base32Encode(Buffer.alloc(20, 9));
    expect(parseTotpSecret(encoded).key?.equals(Buffer.alloc(20, 9))).toBe(true);
    expect(parseTotpSecret(` ${encoded.toLowerCase().replace(/(.{4})/g, '$1 ')} `).key?.length).toBe(20);
    expect(parseTotpSecret(base32Encode(Buffer.alloc(32, 1))).key?.length).toBe(32);
  });
});

describe('otpauth URIs', () => {
  it('builds the Key URI format authenticators read', () => {
    const uri = new URL(otpauthUri('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', 'hub.example.com'));
    expect(uri.protocol).toBe('otpauth:');
    expect(uri.host).toBe('totp');
    expect(decodeURIComponent(uri.pathname)).toBe('/mcp-hub:hub.example.com');
    expect(Object.fromEntries(uri.searchParams)).toEqual({
      secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
      issuer: 'mcp-hub',
      algorithm: 'SHA1',
      digits: '6',
      period: '30'
    });
  });

  it('encodes a label that would otherwise break the URI', () => {
    const uri = otpauthUri('JBSWY3DPEHPK3PXP', 'a b/c:d?e');
    expect(uri).toContain('mcp-hub:a%20b%2Fc%3Ad%3Fe?');
  });

  it('offers the same URI under the scheme the iOS Passwords app opens', () => {
    const plain = otpauthUri('JBSWY3DPEHPK3PXP', 'hub');
    expect(appleOtpauthUri('JBSWY3DPEHPK3PXP', 'hub')).toBe(plain.replace(/^otpauth:/, 'apple-otpauth:'));
  });
});
