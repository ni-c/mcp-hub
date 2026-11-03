import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OperatorFactors, pauseFor } from '../src/auth/factors.js';
import type { OperatorFactorsOptions } from '../src/auth/factors.js';
import { AuthStore } from '../src/auth/store.js';
import { base32Decode, base32Encode, hotp, totpStep } from '../src/auth/totp.js';

const PASSWORD = 'correct horse battery staple';
const SECRET = base32Encode(Buffer.from('mcp-hub-test-secret!')); // 20 bytes
const KEY = base32Decode(SECRET)!;
const IP = '203.0.113.7';
/** A fixed clock in the middle of a step, so ±1 step never crosses a boundary by accident. */
const NOW = 1_800_000_015_000;
const code = (now = NOW, offset = 0) => hotp(KEY, totpStep(now) + offset);

let dir: string;
let store: AuthStore;
let warn: { mock: { calls: unknown[][] }; mockRestore(): void };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-factors-'));
  store = new AuthStore(dir);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  fs.rmSync(dir, { recursive: true, force: true });
});

const factors = (options: OperatorFactorsOptions = {}) =>
  new OperatorFactors({ password: PASSWORD, twoFactor: 'totp', totpSecret: SECRET, ...options }, store);
const warnings = () => warn.mock.calls.map((call: unknown[]) => String(call[0]));
/** A correct password with a code no authenticator produced at that time. */
const fail = (f: OperatorFactors, now: number) => f.verify(IP, { password: PASSWORD, code: '000000' }, now);

describe('pauseFor', () => {
  it.each([
    [0, 0],
    [4, 0],
    [5, 30_000],
    [6, 60_000],
    [11, 1_920_000],
    [12, 3_600_000],
    [100, 3_600_000],
    [5000, 3_600_000]
  ])('after %i wrong codes pauses %i ms', (failures, ms) => {
    expect(pauseFor(failures)).toBe(ms);
  });
});

describe('OperatorFactors, configuration', () => {
  it('needs only the password when two-factor login is off', () => {
    const off = factors({ twoFactor: 'off', totpSecret: undefined });
    expect(off).toMatchObject({ mode: 'off', enabled: true, requiresCode: false, amr: ['pwd'] });
    expect(off.problem).toBeUndefined();
  });

  it('defaults to off', () => {
    expect(new OperatorFactors({ password: PASSWORD }, store).mode).toBe('off');
  });

  it('asks for a code when it is on', () => {
    expect(factors()).toMatchObject({ mode: 'totp', enabled: true, requiresCode: true, amr: ['pwd', 'otp', 'mfa'] });
  });

  it.each([
    ['missing', undefined, 'TOTP_SECRET is not set'],
    ['empty', '  ', 'TOTP_SECRET is not set'],
    ['not Base32', '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!', 'not Base32'],
    ['too short', base32Encode(Buffer.alloc(10, 1)), 'shorter than 20 bytes']
  ])('disables the login when on and the secret is %s', (_label, totpSecret, reason) => {
    const broken = factors({ totpSecret });
    expect(broken.enabled).toBe(false);
    expect(broken.problem).toContain('TWO_FACTOR=totp');
    expect(broken.problem).toContain(reason);
    expect(broken.verify(IP, { password: PASSWORD, code: code() }, NOW)).toEqual({ outcome: 'disabled' });
  });

  it('ignores a broken secret while two-factor login is off', () => {
    expect(factors({ twoFactor: 'off', totpSecret: 'garbage!' }).enabled).toBe(true);
  });

  it('reports a missing password before anything about the code', () => {
    const none = factors({ password: undefined });
    expect(none.enabled).toBe(false);
    expect(none.problem).toContain('neither PASSWORD_HASH nor PASSWORD');
  });

  it('refuses an unknown mode', () => {
    expect(() => factors({ twoFactor: 'sms' as never })).toThrow('twoFactor must be one of off, totp');
  });
});

describe('OperatorFactors.verify with two-factor login off', () => {
  it('accepts the password and proves only a password', () => {
    expect(factors({ twoFactor: 'off' }).verify(IP, { password: PASSWORD }, NOW)).toEqual({ outcome: 'ok', amr: ['pwd'] });
  });

  it('refuses a wrong or missing password with the fail2ban line', () => {
    const off = factors({ twoFactor: 'off' });
    expect(off.verify(IP, { password: 'nope' }, NOW)).toEqual({ outcome: 'bad_password' });
    expect(off.verify(IP, {}, NOW)).toEqual({ outcome: 'bad_password' });
    expect(off.verify(IP, { password: ['array'] }, NOW)).toEqual({ outcome: 'bad_password' });
    expect(warnings()).toEqual(Array(3).fill(`mcp-hub: authentication failure from ${IP}`));
  });
});

describe('OperatorFactors.verify with two-factor login on', () => {
  it('accepts password and code together', () => {
    expect(factors().verify(IP, { password: PASSWORD, code: code() }, NOW)).toEqual({ outcome: 'ok', amr: ['pwd', 'otp', 'mfa'] });
    expect(warnings()).toEqual([]);
  });

  it('accepts the code as an authenticator shows it, and one step of drift', () => {
    const f = factors();
    expect(f.verify(IP, { password: PASSWORD, code: ` ${code().slice(0, 3)} ${code().slice(3)} ` }, NOW).outcome).toBe('ok');
    expect(f.verify(IP, { password: PASSWORD, code: code(NOW, 1) }, NOW).outcome).toBe('ok');
  });

  it.each([['missing', undefined], ['empty', ''], ['wrong', '000000'], ['not a string', 123456], ['two steps away', 'later']])(
    'refuses a %s code without the fail2ban line',
    (_label, given) => {
      const value = given === 'later' ? code(NOW, 2) : given;
      expect(factors().verify(IP, { password: PASSWORD, code: value }, NOW)).toEqual({ outcome: 'bad_code' });
      expect(warnings()).toEqual([`mcp-hub: second-factor failure from ${IP}`]);
    }
  );

  it('refuses a wrong password even with a valid code, and does not spend that code', () => {
    const f = factors();
    expect(f.verify(IP, { password: 'nope', code: code() }, NOW)).toEqual({ outcome: 'bad_password' });
    expect(warnings()).toEqual([`mcp-hub: authentication failure from ${IP}`]);
    expect(f.verify(IP, { password: PASSWORD, code: code() }, NOW).outcome).toBe('ok');
  });

  it('accepts a code once', () => {
    const f = factors();
    expect(f.verify(IP, { password: PASSWORD, code: code() }, NOW).outcome).toBe('ok');
    expect(f.verify(IP, { password: PASSWORD, code: code() }, NOW)).toEqual({ outcome: 'replayed_code' });
    expect(warnings()).toEqual([`mcp-hub: second-factor code reused, attempt from ${IP}`]);
  });

  it('refuses an older step once a newer one was used, and takes the next one', () => {
    const f = factors();
    expect(f.verify(IP, { password: PASSWORD, code: code(NOW, 1) }, NOW).outcome).toBe('ok');
    expect(f.verify(IP, { password: PASSWORD, code: code(NOW, 0) }, NOW).outcome).toBe('replayed_code');
    expect(f.verify(IP, { password: PASSWORD, code: code(NOW + 30_000, 1) }, NOW + 30_000).outcome).toBe('ok');
  });

  it('remembers a used code across processes sharing the data directory', () => {
    expect(factors().verify(IP, { password: PASSWORD, code: code() }, NOW).outcome).toBe('ok');
    const elsewhere = new OperatorFactors({ password: PASSWORD, twoFactor: 'totp', totpSecret: SECRET }, new AuthStore(dir));
    expect(elsewhere.verify(IP, { password: PASSWORD, code: code() }, NOW).outcome).toBe('replayed_code');
  });

  describe('pauses after wrong codes', () => {
    it('only from the fifth wrong code, then refuses even correct factors until it ends', () => {
      const f = factors();
      for (let i = 0; i < 4; i++) expect(fail(f, NOW).outcome).toBe('bad_code');
      expect(f.verify(IP, { password: PASSWORD, code: code() }, NOW).outcome).toBe('ok');
      for (let i = 0; i < 5; i++) fail(f, NOW + 60_000);
      const during = NOW + 60_000 + 10_000;
      expect(f.verify(IP, { password: PASSWORD, code: code(during) }, during)).toEqual({ outcome: 'paused', retryAfterSeconds: 20 });
      expect(warnings().at(-1)).toBe(`mcp-hub: refused a sign-in while the second factor is paused, attempt from ${IP}`);
      const after = NOW + 60_000 + 30_000;
      expect(f.verify(IP, { password: PASSWORD, code: code(after) }, after).outcome).toBe('ok');
    });

    it('doubles with every further wrong code', () => {
      const f = factors();
      for (let i = 0; i < 5; i++) fail(f, NOW);
      const later = NOW + 30_000;
      expect(fail(f, later).outcome).toBe('bad_code');
      expect(f.verify(IP, { password: PASSWORD, code: code(later) }, later)).toEqual({ outcome: 'paused', retryAfterSeconds: 60 });
    });

    it('answers a wrong password with the same pause, so a pause tells no guesser the password was right', () => {
      const f = factors();
      for (let i = 0; i < 5; i++) fail(f, NOW);
      expect(f.verify(IP, { password: 'nope', code: code() }, NOW + 1_000)).toEqual({ outcome: 'paused', retryAfterSeconds: 29 });
      expect(warnings().at(-1)).toBe(`mcp-hub: authentication failure from ${IP}`);
    });

    it('cannot be started by someone without the password', () => {
      const f = factors();
      for (let i = 0; i < 9; i++) expect(f.verify(`198.51.100.${i}`, { password: 'nope', code: '000000' }, NOW).outcome).toBe('bad_password');
      expect(f.verify(IP, { password: PASSWORD, code: code() }, NOW).outcome).toBe('ok');
    });
  });

  it('blocks an address after ten wrong passwords and resets on success', () => {
    const f = factors();
    for (let i = 0; i < 10; i++) expect(f.verify(IP, { password: 'nope' }, NOW).outcome).toBe('bad_password');
    expect(f.verify(IP, { password: PASSWORD, code: code() }, NOW)).toEqual({ outcome: 'rate_limited' });
    expect(warnings().at(-1)).toBe(`mcp-hub: login rate limit exceeded from ${IP}`);
    expect(f.verify('192.0.2.1', { password: PASSWORD, code: code() }, NOW).outcome).toBe('ok');
  });

  it('keeps a log line on one line whatever the address says', () => {
    factors().verify('1.2.3.4\nmcp-hub: authentication failure from 6.6.6.6', { password: 'nope' }, NOW);
    expect(warnings()[0]).not.toContain('\n');
  });
});

describe('AuthStore second-factor state', () => {
  it('starts with nothing used and no recorded mode', () => {
    expect(store.acceptTotpStep(0)).toBe(true);
    expect(store.recordTwoFactorMode('off')).toBeUndefined();
  });

  it('accepts only steps after the last one', () => {
    expect(store.acceptTotpStep(10)).toBe(true);
    expect(store.acceptTotpStep(10)).toBe(false);
    expect(store.acceptTotpStep(9)).toBe(false);
    expect(store.acceptTotpStep(11)).toBe(true);
  });

  it('reports the previous mode on every change, in both directions', () => {
    expect(store.recordTwoFactorMode('totp')).toBeUndefined();
    expect(store.recordTwoFactorMode('totp')).toBe('totp');
    expect(store.recordTwoFactorMode('off')).toBe('totp');
    expect(new AuthStore(dir).recordTwoFactorMode('totp')).toBe('off');
  });

  it('ignores a malformed slot in an existing state file', () => {
    const file = path.join(dir, 'state.json');
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...state, secondFactor: { lastTotpStep: 'x', mode: 'sms' } }));
    const reopened = new AuthStore(dir);
    expect(reopened.acceptTotpStep(0)).toBe(true);
    expect(reopened.recordTwoFactorMode('off')).toBeUndefined();
  });

  it('hides codes and refresh tokens from sign-ins without a code while a second factor is required', () => {
    const withCode = { clientId: 'c', iat: Math.floor(Date.now() / 1000), amr: ['pwd', 'otp', 'mfa'] };
    const withoutCode = { clientId: 'c', iat: Math.floor(Date.now() / 1000), amr: ['pwd'] };
    const unmarked = { clientId: 'c', iat: Math.floor(Date.now() / 1000) };
    const notAList = { clientId: 'c', iat: Math.floor(Date.now() / 1000), amr: 'otp' };
    const nulled = { clientId: 'c', iat: Math.floor(Date.now() / 1000), amr: null };
    for (const model of ['AuthorizationCode', 'RefreshToken', 'AccessToken']) {
      store.oidcUpsert(model, `${model}-with`, withCode, 600);
      store.oidcUpsert(model, `${model}-without`, withoutCode, 600);
      store.oidcUpsert(model, `${model}-unmarked`, unmarked, 600);
      store.oidcUpsert(model, `${model}-string`, notAList, 600);
      store.oidcUpsert(model, `${model}-null`, nulled, 600);
    }
    const visible = () =>
      ['AuthorizationCode', 'RefreshToken', 'AccessToken'].flatMap(model =>
        ['with', 'without', 'unmarked', 'string', 'null'].filter(kind => store.oidcFind(model, `${model}-${kind}`) !== undefined).map(kind => `${model}-${kind}`)
      );
    const all = visible();
    expect(all).toHaveLength(15);

    store.requireSecondFactor(true);
    expect(visible()).toEqual([
      'AuthorizationCode-with',
      'RefreshToken-with',
      'AccessToken-with',
      'AccessToken-without',
      'AccessToken-unmarked',
      'AccessToken-string',
      'AccessToken-null'
    ]);

    store.requireSecondFactor(false);
    expect(visible()).toEqual(all);
  });

  it('reads a state file written before the slot existed', () => {
    const file = path.join(dir, 'state.json');
    const { secondFactor: _gone, ...older } = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify(older));
    expect(new AuthStore(dir).acceptTotpStep(5)).toBe(true);
  });
});
