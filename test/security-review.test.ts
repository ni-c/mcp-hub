import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dns from 'node:dns/promises';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHub } from '../src/index.js';
import { operatorCredential } from '../src/auth/password.js';
import { parseEnvFile } from '../src/docker-proxy/secrets.js';
import { sanitiseInputRequests } from '../src/elicitation.js';
import { authorizeInBrowser, registerPublicClient } from './auth-flow.js';

const REDIRECT_URI = 'https://client.example/cb';
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
async function hubWith(credentials: { password?: string; passwordHash?: string }) {
  const dir = directory();
  fs.writeFileSync(path.join(dir, 'mcp.json'), '{"mcpServers":{}}');
  const hub = await createHub({ externalUrl: 'http://localhost/', configPath: path.join(dir, 'mcp.json'), dataPath: path.join(dir, 'data'), idleTimeoutMinutes: 0, ...credentials });
  hubs.push(hub);
  return hub;
}
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const hub of hubs.splice(0)) { hub.watcher.stop(); hub.stopMaintenance(); await hub.supervisor.stop(); }
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('HTTP password configuration fails closed at the login, not at startup', () => {
  /** The login page of a fresh authorization, the way a browser reaches it. */
  async function loginPage(hub: Awaited<ReturnType<typeof createHub>>) {
    const clientId = await registerPublicClient(hub.app, REDIRECT_URI);
    const agent = request.agent(hub.app);
    const query = new URLSearchParams({
      client_id: clientId, redirect_uri: REDIRECT_URI, response_type: 'code', code_challenge: 'a'.repeat(43),
      code_challenge_method: 'S256', state: 'xyz', resource: 'http://localhost/hub'
    });
    let location = `/authorize?${query}`;
    for (let hop = 0; hop < 6; hop += 1) {
      const res = await agent.get(location).redirects(0);
      if (!res.headers.location) return { agent, location, res };
      location = new URL(res.headers.location as string, 'http://localhost/').pathname;
    }
    throw new Error('login page not reached');
  }

  it.each([undefined, '', ' \t\n'])('starts without a password %j, warns, and refuses every login', async password => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const hub = await hubWith({ password });
    expect(warn.mock.calls.map(call => String(call[0]))).toContainEqual(expect.stringContaining('neither PASSWORD_HASH nor PASSWORD is set'));
    await request(hub.app).get('/livez').expect(200);
    const { agent, location, res } = await loginPage(hub);
    expect(res.status).toBe(503);
    expect(res.text).toContain('Sign-in is disabled');
    const requestToken = /name="request" value="([^"]+)"/.exec(res.text)![1];
    // The empty field that used to log in, and a guess: neither may approve.
    for (const attempt of ['', 'anything']) {
      const submitted = await agent.post(`${location}login`).type('form').send({ request: requestToken, password: attempt }).redirects(0);
      expect(submitted.status).toBe(503);
      expect(submitted.text).toContain('Sign-in is disabled');
    }
    expect(Object.keys(hub.store.listApprovals())).toEqual([]);
    // Not a failed guess either: the fail2ban line is for people guessing.
    expect(warn.mock.calls.map(call => String(call[0]))).not.toContainEqual(expect.stringContaining('authentication failure'));
  });

  it('disables the login for a malformed hash instead of falling back to the plaintext password', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const hub = await hubWith({ passwordHash: 'not-a-hash-but-a-secret-value', password: 'valid-fallback' });
    const warned = warn.mock.calls.map(call => String(call[0])).find(line => line.includes('PASSWORD_HASH'))!;
    expect(warned).toContain('not a bcrypt hash');
    expect(warned).not.toContain('not-a-hash-but-a-secret-value');
    const { agent, location, res } = await loginPage(hub);
    expect(res.status).toBe(503);
    const requestToken = /name="request" value="([^"]+)"/.exec(res.text)![1];
    const submitted = await agent.post(`${location}login`).type('form').send({ request: requestToken, password: 'valid-fallback' }).redirects(0);
    expect(submitted.status).toBe(503);
    expect(Object.keys(hub.store.listApprovals())).toEqual([]);
  });

  it('accepts a hash without a plaintext password and signs the operator in with it', async () => {
    const hub = await hubWith({ passwordHash: bcrypt.hashSync('test-password', 4) });
    await request(hub.app).get('/livez').expect(200);
    const clientId = await registerPublicClient(hub.app, REDIRECT_URI);
    const { code } = await authorizeInBrowser(hub.app, clientId, { password: 'test-password', redirectUri: REDIRECT_URI, resource: 'http://localhost/hub' });
    expect(code).toBeTruthy();
  });

  it('decides the credential without ever comparing an empty buffer as equal', () => {
    for (const options of [{}, { password: '' }, { password: '   ' }, { passwordHash: '' }, { passwordHash: '$2b$04$short' }]) {
      const credential = operatorCredential(options);
      expect(credential.enabled).toBe(false);
      expect(credential.check('')).toBe(false);
      expect(credential.problem).toBeDefined();
    }
    const plain = operatorCredential({ password: 'pw' });
    expect(plain.enabled).toBe(true);
    expect(plain.check('pw')).toBe(true);
    expect(plain.check('')).toBe(false);
    expect(plain.check('pw\u0000')).toBe(false);
    const hashed = operatorCredential({ passwordHash: bcrypt.hashSync('pw', 4), password: 'other' });
    expect(hashed.check('pw')).toBe(true);
    expect(hashed.check('other')).toBe(false);
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

describe('prototype names are not identifiers', () => {
  const names = ['constructor', '__proto__', 'hasOwnProperty', 'toString', 'valueOf'];

  it('answers undefined for every state lookup by a prototype name', () => {
    const store = new AuthStore(directory());
    for (const name of names) {
      expect(store.getClient(name)).toBeUndefined();
      expect(store.getApproval(name)).toBeUndefined();
      expect(store.getRevokedBefore(name)).toBeUndefined();
      expect(store.isOperatorManaged(name)).toBe(false);
      expect(store.verifyRegistrationToken(name, 'x')).toBe(false);
      expect(store.getApiToken(name)).toBeUndefined();
      expect(store.getUpstreamCredentials(name, 'fp')).toBeUndefined();
      expect(store.takeUpstreamLogin(name)).toBeUndefined();
      expect(store.oidcFind('AccessToken', name)).toBeUndefined();
      expect(store.deleteClient(name)).toBe(false);
    }
    expect(store.getRevokedBefore('constructor')).toBeUndefined();
  });

  it('survives a state file that carries such names, and a client called that way', () => {
    const dir = directory();
    const first = new AuthStore(dir);
    first.saveApproval('constructor', 'https://client.example/cb', 'Named like a prototype');
    const again = new AuthStore(dir);
    expect(again.getApproval('constructor')?.clientName).toBe('Named like a prototype');
    expect(again.getApproval('__proto__')).toBeUndefined();
    expect(again.getClient('constructor')).toBeUndefined();
    // The map itself must stay a map: the name did not become a prototype.
    expect(Object.getPrototypeOf(again.listApprovals())).not.toBeNull();
    expect(Object.keys(again.listApprovals())).toEqual(['constructor']);
  });

  it.each(['constructor', 'hasOwnProperty', '__proto__'])('refuses %s as a client_id with 400, not 500', async name => {
    const hub = await hubWith({ password: 'test-password' });
    const failed = vi.spyOn(console, 'error').mockImplementation(() => {});
    const authorize = await request(hub.app).get('/authorize').query({
      client_id: name, redirect_uri: 'https://x.example/cb', response_type: 'code',
      code_challenge: 'a'.repeat(43), code_challenge_method: 'S256', resource: 'http://localhost/hub'
    });
    expect(authorize.status).toBe(400);
    expect(authorize.body.error).not.toBe('server_error');
    const token = await request(hub.app).post('/token').type('form').send({
      grant_type: 'authorization_code', client_id: name, code: 'x', code_verifier: 'y', redirect_uri: 'https://x.example/cb', client_secret: 's'
    });
    // An unknown client at the token endpoint is `invalid_client`, a 401.
    expect([400, 401]).toContain(token.status);
    expect(token.body.error).not.toBe('server_error');
    await request(hub.app).get(`/register/${name}`).set('Authorization', 'Bearer x').expect(401);
    expect(failed.mock.calls.map(call => String(call[0]))).not.toContainEqual(expect.stringContaining('authorization server failed'));
  });
});

describe('a prototype name in a child-chosen key', () => {
  it('keeps a secrets variable called __proto__ instead of losing it', () => {
    const parsed = parseEnvFile('__proto__=evil\nA=b\nconstructor=c\n');
    expect(Object.keys(parsed).toSorted()).toEqual(['A', '__proto__', 'constructor']);
    expect(Object.hasOwn(parsed, '__proto__')).toBe(true);
    expect(parsed.A).toBe('b');
    expect(() => parseEnvFile('__proto__=1\n__proto__=2\n')).toThrow(/duplicates/);
  });

  it('forwards an elicitation keyed __proto__ instead of swallowing it', () => {
    const requests = JSON.parse(
      '{"__proto__": {"method": "elicitation/create", "params": {"message": "first"}}, "ok": {"method": "elicitation/create", "params": {"message": "second"}}}'
    ) as never;
    const { requests: out, dropped } = sanitiseInputRequests(requests, 'srv');
    expect(dropped).toEqual([]);
    expect(Object.keys(out).toSorted()).toEqual(['__proto__', 'ok']);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    // `out['__proto__']` would answer the prototype; the own property is the
    // one the wire carries, so it is read the way JSON.stringify reads it.
    const wire = JSON.parse(JSON.stringify(out)) as Record<string, unknown>;
    const forwarded = Object.getOwnPropertyDescriptor(wire, '__proto__')?.value as { params: { message: string } };
    expect(forwarded.params.message).toBe('Server "srv" asks:\n\nfirst');
  });
});

const urlElicitation = (target: unknown) =>
  ({ open: { method: 'elicitation/create', params: { mode: 'url', message: 'Sign in', elicitationId: 'e1', url: target } } }) as never;

describe('a URL-mode elicitation names a page the hub can vouch for', () => {
  const cases: [string, unknown][] = [
    ['javascript:alert(1)', 'javascript:alert(1)'],
    ['http://phish.example/', 'http://phish.example/'],
    ['file:///etc/passwd', 'file:///etc/passwd'],
    ['com.example.app:/cb', 'com.example.app:/cb'],
    ['https://user:pw@x.example/', 'https://user:pw@x.example/'],
    ['a number', 42],
    ['nothing', undefined],
    ['a 9 kB address', 'https://' + 'a'.repeat(9000)]
  ];
  it.each(cases)('drops %s', (_label, target) => {
      const { requests, dropped } = sanitiseInputRequests(urlElicitation(target), 'srv');
      expect(Object.keys(requests)).toEqual([]);
      expect(dropped).toEqual(['open']);
  });

  it('carries an https page, attributed', () => {
    const { requests, dropped } = sanitiseInputRequests(urlElicitation('https://idp.example/login?x=1'), 'srv');
    expect(dropped).toEqual([]);
    const forwarded = (requests as Record<string, { params: Record<string, unknown> }>).open.params;
    expect(forwarded.url).toBe('https://idp.example/login?x=1');
    expect(forwarded.message).toBe('Server "srv" asks:\n\nSign in');
  });
});
