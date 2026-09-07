import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dns from 'node:dns/promises';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHub } from '../src/index.js';
import { AuthStore } from '../src/auth/store.js';
import { boundedResponse } from '../src/auth/pinned-fetch.js';
import { createSessionCookie, readSessionCookie } from '../src/auth/session.js';
import { readSignedPayload, signPayload, signatureMatches } from '../src/auth/signed-token.js';
import { UpstreamAuth } from '../src/upstream/auth.js';
import { UpstreamAuthRegistry } from '../src/supervisor.js';
import type { RemoteServerConfig } from '../src/config.js';

const dirs: string[] = [];
const hubs: Awaited<ReturnType<typeof createHub>>[] = [];
function directory(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-review-'));
  dirs.push(dir);
  return dir;
}
function config(url = 'https://upstream.example/mcp'): RemoteServerConfig {
  return { kind: 'remote', transport: 'http', url, headers: {}, hub: true, oauth: { mode: 'dcr', grant: 'authorization_code', scopes: [] } };
}
function discovery(endpoint = 'https://127.0.0.1/register') {
  return {
    authorizationServerUrl: 'https://authorization.example', fetchedAt: 0,
    authorizationServerMetadata: { issuer: 'https://authorization.example', authorization_endpoint: 'https://authorization.example/authorize', token_endpoint: 'https://authorization.example/token', response_types_supported: ['code'], registration_endpoint: endpoint }
  };
}
async function hubWith(passwordOptions: { password?: string; passwordHash?: string }) {
  const dir = directory();
  fs.writeFileSync(path.join(dir, 'mcp.json'), '{"mcpServers":{}}');
  const hub = await createHub({ externalUrl: 'http://localhost/', configPath: path.join(dir, 'mcp.json'), dataPath: path.join(dir, 'data'), idleTimeoutMinutes: 0, ...passwordOptions });
  hubs.push(hub);
  return hub;
}
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const hub of hubs.splice(0)) { hub.watcher.stop(); hub.stopMaintenance(); await hub.supervisor.stop(); }
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('HTTP password configuration fails closed', () => {
  it.each([undefined, '', ' \t\n'])('refuses missing or blank password %j before creating state', async password => {
    const dir = directory();
    await expect(createHub({ externalUrl: 'http://localhost/', configPath: path.join(dir, 'absent.json'), dataPath: path.join(dir, 'data'), password })).rejects.toThrow(/PASSWORD_HASH or a non-empty PASSWORD/);
    expect(fs.existsSync(path.join(dir, 'data'))).toBe(false);
  });
  it('refuses a malformed hash even when a plaintext fallback is configured', async () => {
    await expect(hubWith({ passwordHash: 'not-a-hash', password: 'valid-fallback' })).rejects.toThrow(/valid bcrypt hash/);
  });
  it('accepts a hash without a plaintext password', async () => {
    const hub = await hubWith({ passwordHash: bcrypt.hashSync('test-password', 4) });
    await request(hub.app).get('/livez').expect(200);
  });
});

describe('untrusted signatures are refused without throwing', () => {
  it.each(['é'.repeat(43), 'a'.repeat(42), '💥'.repeat(43)])('rejects a malformed signature', signature => {
    expect(signatureMatches('payload', signature, 'secret')).toBe(false);
    expect(readSignedPayload(`e30.${signature}`, 'secret')).toBeUndefined();
  });
  it('requires the entire signed value to match', () => {
    const signed = signPayload({ a: 1 }, 'secret');
    expect(readSignedPayload(signed, 'secret')).toEqual({ a: 1 });
    expect(readSignedPayload(`${signed}.extra`, 'secret')).toBeUndefined();
    const cookie = createSessionCookie('secret');
    expect(readSessionCookie(`mcp_hub_session=${cookie}`, 'secret')).toBe(cookie);
    expect(readSessionCookie(`mcp_hub_session=${cookie}.extra`, 'secret')).toBeUndefined();
  });
  it('rejects broken cookie percent encoding', () => {
    expect(readSessionCookie('mcp_hub_session=%GG', 'secret')).toBeUndefined();
  });
  it('never throws for arbitrary caller-controlled strings', () => {
    fc.assert(fc.property(fc.string(), value => {
      expect(() => readSignedPayload(`e30.${value}`, 'secret')).not.toThrow();
      expect(() => readSessionCookie(`mcp_hub_session=${value}`, 'secret')).not.toThrow();
    }));
  });
  it('answers a forged upstream callback with 400 instead of leaving it pending', async () => {
    const hub = await hubWith({ password: 'test-password' });
    await request(hub.app).get('/upstream/callback').query({ state: `e30.${'é'.repeat(43)}` }).timeout(1000).expect(400);
  });
});

describe('upstream OAuth network boundary', () => {
  it.each([
    { addresses: [{ address: '93.184.216.34', family: 4 }] },
    { addresses: [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }] }
  ])('refuses private AS targets for public or mixed DNS answers', async ({ addresses }) => {
    vi.spyOn(dns, 'lookup').mockResolvedValue(addresses as never);
    const fetchSpy = vi.fn(async () => Response.json({ client_id: 'test' }));
    vi.stubGlobal('fetch', fetchSpy);
    const auth = new UpstreamAuth('test', config(), new AuthStore(directory()), 'http://localhost/');
    await expect(auth.clientInformation(discovery())).rejects.toThrow(/private address/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('does not enable private access after a DNS failure and retries resolution', async () => {
    const lookup = vi.spyOn(dns, 'lookup').mockRejectedValueOnce(new Error('DNS unavailable')).mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const auth = new UpstreamAuth('test', config(), new AuthStore(directory()), 'http://localhost/');
    await expect(auth.clientInformation(discovery())).rejects.toThrow(/DNS unavailable/);
    await expect(auth.clientInformation(discovery())).rejects.toThrow(/private address/);
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('still allows an internal hostname to use its internal authorization server', async () => {
    vi.spyOn(dns, 'lookup').mockResolvedValue([{ address: '10.0.0.2', family: 4 }] as never);
    const fetchSpy = vi.fn(async (_input: unknown, _init?: RequestInit) => Response.json({ client_id: 'internal-client' }));
    vi.stubGlobal('fetch', fetchSpy);
    const auth = new UpstreamAuth('test', config('http://internal.example/mcp'), new AuthStore(directory()), 'http://localhost/');
    await expect(auth.clientInformation(discovery('http://127.0.0.1/register'))).resolves.toMatchObject({ client_id: 'internal-client' });
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe('http://127.0.0.1/register');
  });
  it('refuses plaintext authorization endpoints for public upstreams', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const auth = new UpstreamAuth('test', config('https://93.184.216.34/mcp'), new AuthStore(directory()), 'http://localhost/');
    await expect(auth.clientInformation(discovery('http://93.184.216.34/register'))).rejects.toThrow(/HTTPS/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('enforces the response cap on the private-address fetch path', async () => {
    const cancelled = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(300 * 1024)); }, cancel: cancelled
    }))));
    const auth = new UpstreamAuth('test', config('http://127.0.0.1/mcp'), new AuthStore(directory()), 'http://localhost/');
    await expect(auth.clientInformation(discovery('http://127.0.0.1/register'))).rejects.toThrow(/262144 bytes/);
    expect(cancelled).toHaveBeenCalledOnce();
  });
});

describe('bounded native fetch responses', () => {
  it.each([200, 401, 500])('cancels an oversized streaming body with status %i', async status => {
    const cancelled = vi.fn();
    const response = new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(128)); }, cancel: cancelled }), { status });
    await expect(boundedResponse(response, 64)).rejects.toThrow(/64 bytes/);
    expect(cancelled).toHaveBeenCalledOnce();
  });
  it('cancels a declared oversized body without reading it', async () => {
    const cancelled = vi.fn();
    const response = new Response(new ReadableStream({ cancel: cancelled }), { headers: { 'content-length': '100' } });
    await expect(boundedResponse(response, 64)).rejects.toThrow(/64 bytes/);
    expect(cancelled).toHaveBeenCalledOnce();
  });
  it('preserves bounded content and status while dropping stale transfer headers', async () => {
    const result = await boundedResponse(new Response('body', { status: 401, headers: { 'content-length': '4', 'content-encoding': 'gzip', 'content-type': 'text/plain' } }), 4);
    expect(result.status).toBe(401);
    expect(await result.text()).toBe('body');
    expect(result.headers.has('content-length')).toBe(false);
    expect(result.headers.has('content-encoding')).toBe(false);
    expect(result.headers.get('content-type')).toBe('text/plain');
  });
  it('preserves a bodyless response', async () => {
    const response = new Response(null, { status: 204 });
    expect(await boundedResponse(response, 64)).toBe(response);
  });
});

describe('upstream configuration rotation', () => {
  it('applies rotated secrets, headers and authentication methods without losing stored tokens', async () => {
    const store = new AuthStore(directory());
    const registry = new UpstreamAuthRegistry(store, 'http://localhost/');
    const original: RemoteServerConfig = { ...config(), headers: { 'X-API-Key': 'old-key' }, oauth: { mode: 'static', grant: 'authorization_code', clientId: 'test-client', clientSecret: 'old-secret', scopes: [] } };
    const first = registry.for('test', original)!;
    first.provider().saveTokens({ access_token: 'test-token', token_type: 'Bearer' });
    const updated: RemoteServerConfig = { ...original, headers: { 'X-API-Key': 'new-key' }, oauth: { ...original.oauth!, clientSecret: 'new-secret' } };
    const next = registry.for('test', updated)!;
    expect(next.provider().clientInformation()?.client_secret).toBe('new-secret');
    expect(next.provider().tokens()?.access_token).toBe('test-token');
    let sent: Headers | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: RequestInit) => { sent = new Headers(init?.headers); return new Response(null, { status: 204 }); }));
    await next.createFetch()(updated.url);
    expect(sent?.get('X-API-Key')).toBe('new-key');
    expect(sent?.get('Authorization')).toBe('Bearer test-token');
    expect(registry.for('test', updated)).toBe(next);
    const withKey = registry.for('test', { ...updated, oauth: { ...updated.oauth!, clientAuth: 'private_key_jwt' } })!;
    const params = new URLSearchParams();
    await withKey.provider().addClientAuthentication(new Headers(), params, 'https://authorization.example/token');
    expect(params.get('client_assertion_type')).toBe('urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
    expect(params.get('client_assertion')).toBeTruthy();
  });
});
