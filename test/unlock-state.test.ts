import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuthStore } from '../src/auth/store.js';
import type { UnlockGrant } from '../src/auth/store.js';
import { argsHash, canonicalArgs, canonicalJson, fitsOnPage } from '../src/unlock/args.js';
import { DENY_COOLDOWN_MS, REQUEST_TTL_MS, TICKET_TTL_MS, UnlockRuntime, matchingCode } from '../src/unlock/runtime.js';

let dir: string;
let store: AuthStore;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-unlock-'));
  store = new AuthStore(dir);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const NOW = Date.now();
const grant = (overrides: Partial<UnlockGrant> = {}): UnlockGrant => ({
  server: 'ssh',
  clientId: 'claude',
  grantId: 'g1',
  kind: 'window',
  grantedAt: NOW,
  expiresAt: NOW + 30 * 60_000,
  by: 'page',
  ...overrides
});

describe('canonical arguments', () => {
  it('ignores key order, keeps array order', () => {
    expect(canonicalJson({ b: 1, a: [2, 1], c: { y: null, x: 'z' } })).toBe('{"a":[2,1],"b":1,"c":{"x":"z","y":null}}');
    expect(argsHash(canonicalArgs({ b: 1, a: 2 }))).toBe(argsHash(canonicalArgs({ a: 2, b: 1 })));
    expect(argsHash(canonicalArgs({ a: [1, 2] }))).not.toBe(argsHash(canonicalArgs({ a: [2, 1] })));
  });

  it('treats absent arguments as an empty object', () => {
    expect(canonicalArgs(undefined)).toBe('{}');
    expect(canonicalArgs(null)).toBe('{}');
    expect(argsHash(canonicalArgs(undefined))).toBe(argsHash(canonicalArgs({})));
  });

  it('keeps a "__proto__" key, which an object rebuilt from it would drop', () => {
    const parsed = JSON.parse('{"command":"ls","__proto__":{"x":1}}');
    expect(canonicalJson(parsed)).toBe('{"__proto__":{"x":1},"command":"ls"}');
    expect(argsHash(canonicalArgs(parsed))).not.toBe(argsHash(canonicalArgs({ command: 'ls' })));
  });

  it('tells a call that fits on the page from one that does not', () => {
    expect(fitsOnPage(canonicalArgs({ c: 'x'.repeat(2000) }))).toBe(true);
    expect(fitsOnPage(canonicalArgs({ c: 'x'.repeat(2100) }))).toBe(false);
    expect(fitsOnPage(canonicalArgs({ c: 'ü'.repeat(1100) }))).toBe(false);
  });
});

describe('unlock grants in the store', () => {
  it('lists live grants and forgets expired ones', () => {
    store.addUnlockGrant(grant());
    store.addUnlockGrant(grant({ server: 'gone', expiresAt: NOW - 1 }));
    expect(store.unlockGrants(NOW).map(g => g.server)).toEqual(['ssh']);
    expect(store.unlockGrants(NOW + 30 * 60_000)).toEqual([]);
  });

  it('matches the authorization it was granted to, or every authorization when it names none', () => {
    const [own] = [grant()];
    expect(AuthStore.grantMatches(own, { server: 'ssh', clientId: 'claude', grantId: 'g1' })).toBe(true);
    expect(AuthStore.grantMatches(own, { server: 'ssh', clientId: 'claude', grantId: 'g2' })).toBe(false);
    expect(AuthStore.grantMatches(own, { server: 'ssh', clientId: 'claude' })).toBe(false);
    expect(AuthStore.grantMatches(own, { server: 'ssh', clientId: 'chatgpt', grantId: 'g1' })).toBe(false);
    expect(AuthStore.grantMatches(own, { server: 'smtp', clientId: 'claude', grantId: 'g1' })).toBe(false);
    const wide = grant({ grantId: undefined });
    expect(AuthStore.grantMatches(wide, { server: 'ssh', clientId: 'claude', grantId: 'any' })).toBe(true);
    expect(AuthStore.grantMatches(wide, { server: 'ssh', clientId: '' })).toBe(false);
  });

  it('spends a once-grant exactly once, and only on the call it was made for', () => {
    store.addUnlockGrant(grant({ kind: 'once', tool: 'run', argsHash: 'h1', expiresAt: NOW + 600_000 }));
    const call = { server: 'ssh', clientId: 'claude', grantId: 'g1', tool: 'run', argsHash: 'h1' };
    expect(store.takeOnceGrant({ ...call, argsHash: 'h2' }, NOW)).toBeUndefined();
    expect(store.takeOnceGrant({ ...call, tool: 'other' }, NOW)).toBeUndefined();
    const elsewhere = new AuthStore(dir);
    const results = [store.takeOnceGrant(call, NOW), elsewhere.takeOnceGrant(call, NOW), store.takeOnceGrant(call, NOW)];
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('does not spend an expired once-grant, and treats the expiry instant as expired', () => {
    store.addUnlockGrant(grant({ kind: 'once', tool: 'run', argsHash: 'h', expiresAt: NOW }));
    expect(store.takeOnceGrant({ server: 'ssh', clientId: 'claude', grantId: 'g1', tool: 'run', argsHash: 'h' }, NOW)).toBeUndefined();
    expect(store.unlockGrants(NOW)).toEqual([]);
  });

  it('revokes by server, client, authorization or id, and a client-wide grant goes with any of its authorizations', () => {
    const own = store.addUnlockGrant(grant());
    store.addUnlockGrant(grant({ grantId: undefined }));
    store.addUnlockGrant(grant({ grantId: 'g2' }));
    store.addUnlockGrant(grant({ server: 'smtp' }));
    expect(store.revokeUnlockGrants({ server: 'ssh', clientId: 'claude', grantId: 'g1' })).toBe(2);
    expect(store.unlockGrants(NOW).map(g => `${g.server}:${g.grantId}`).toSorted()).toEqual(['smtp:g1', 'ssh:g2']);
    expect(store.revokeUnlockGrants({ id: own })).toBe(0);
    expect(store.revokeUnlockGrants({ server: 'smtp' })).toBe(1);
    expect(store.revokeUnlockGrants({})).toBe(1);
  });

  it('ignores a grant older than a revocation of its client', () => {
    store.addUnlockGrant(grant({ grantedAt: Date.now() - 1000 }));
    store.revokeClientAccess('claude');
    expect(store.unlockGrants()).toEqual([]);
  });

  it('is shared with another process through the state file', () => {
    store.addUnlockGrant(grant());
    expect(new AuthStore(dir).unlockGrants(NOW)).toHaveLength(1);
  });

  it('drops malformed grants from an existing state file', () => {
    const file = path.join(dir, 'state.json');
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...state, unlockGrants: { a: { server: 'ssh' }, b: grant(), c: null, d: 'x' } }));
    expect(new AuthStore(dir).unlockGrants(NOW).map(g => g.id)).toEqual(['b']);
  });
});

describe('unlock requests and tickets', () => {
  let now = 1_000_000;
  const runtime = () => new UnlockRuntime(() => now);
  const ask = { server: 'ssh', clientId: 'claude', grantId: 'g1', door: '/ssh/mcp', tool: 'run', argsHash: 'h' };

  it('makes codes of six unambiguous characters', () => {
    for (let i = 0; i < 50; i++) expect(matchingCode()).toMatch(/^[A-HJ-NP-Z2-9]{3}-[A-HJ-NP-Z2-9]{3}$/);
  });

  it('gives the same ask the same request while it is open, and a new one afterwards', () => {
    now = 1_000_000;
    const r = runtime();
    const first = r.open(ask);
    const again = r.open(ask);
    expect('request' in first && 'request' in again && first.request.id === again.request.id).toBe(true);
    expect(first).toMatchObject({ fresh: true });
    expect(again).toMatchObject({ fresh: false });
    const other = r.open({ ...ask, argsHash: 'other' });
    expect('request' in other && other.request.id).not.toBe('request' in first && first.request.id);
    now += REQUEST_TTL_MS;
    expect(r.get('request' in first ? first.request.id : '')).toBeUndefined();
    expect(r.open(ask)).toMatchObject({ fresh: true });
  });

  it('holds the same ask off for two minutes after a denial', () => {
    now = 2_000_000;
    const r = runtime();
    const opened = r.open(ask);
    if (!('request' in opened)) throw new Error('not opened');
    expect(r.decide(opened.request.id, 'denied')?.status).toBe('denied');
    expect(r.decide(opened.request.id, 'approved')).toBeUndefined();
    expect(r.open(ask)).toMatchObject({ refused: 'denied' });
    expect(r.open({ ...ask, tool: 'other' })).toMatchObject({ fresh: true });
    now += REQUEST_TTL_MS + DENY_COOLDOWN_MS;
    expect(r.open(ask)).toMatchObject({ fresh: true });
  });

  it('caps open requests per client and in total, and refuses rather than evicting', () => {
    now = 3_000_000;
    const r = runtime();
    for (let i = 0; i < 5; i++) expect(r.open({ ...ask, argsHash: `h${i}` })).toMatchObject({ fresh: true });
    expect(r.open({ ...ask, argsHash: 'h5' })).toEqual({ refused: 'full' });
    for (let c = 0; c < 9; c++) for (let i = 0; i < 5; i++) r.open({ ...ask, clientId: `c${c}`, argsHash: `h${i}` });
    expect(r.pending()).toHaveLength(50);
    expect(r.open({ ...ask, clientId: 'new' })).toEqual({ refused: 'full' });
    expect(r.pending()).toHaveLength(50);
  });

  it('accepts a ticket until it expires, and nothing that was not issued', () => {
    now = 4_000_000;
    const r = runtime();
    const ticket = r.issueTicket();
    expect(r.ticketValid(ticket)).toBe(true);
    expect(r.ticketValid(`${ticket}x`)).toBe(false);
    expect(r.ticketValid('')).toBe(false);
    expect(r.ticketValid(undefined)).toBe(false);
    now += TICKET_TTL_MS;
    expect(r.ticketValid(ticket)).toBe(false);
  });
});
