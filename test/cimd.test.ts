import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import type { JWK } from 'jose';
import { authorizeInBrowser } from './auth-flow.js';
import { createHub } from '../src/index.js';
import { CimdResolver, isClientIdMetadataUrl, isPrivateAddress, setCimdFetch, validateDocument } from '../src/auth/cimd.js';
import { isLoopbackOnly, isSafeRedirectUri } from '../src/auth/redirect-uri.js';
import { guardedRequest, pinnedLookup } from '../src/auth/pinned-fetch.js';
import { escapeHtml } from '../src/auth/page.js';
import { clampDisplayName, logSafe } from '../src/auth/text.js';

const EVERYTHING = path.resolve('node_modules/@modelcontextprotocol/server-everything/dist/index.js');
const PASSWORD = 'test-password';
const REDIRECT_URI = 'http://localhost:33418/callback';
const CLIENT_ID = 'https://client.example/oauth/client.json';

let tmpDir: string;
let hub: Awaited<ReturnType<typeof createHub>>;

/** Documents the stubbed fetch serves, keyed by URL. */
let documents: Map<string, { body: string; contentType?: string; status?: number; cacheControl?: string; contentLength?: string }>;
let fetchCount: Map<string, number>;

function serve(url: string, document: unknown, extra: { contentType?: string; cacheControl?: string } = {}): void {
  documents.set(url, { body: typeof document === 'string' ? document : JSON.stringify(document), ...extra });
}

function publicClientDocument(clientId = CLIENT_ID, redirectUris = [REDIRECT_URI]): Record<string, unknown> {
  return {
    client_id: clientId,
    client_name: 'Vitest CIMD client',
    client_uri: 'https://client.example',
    redirect_uris: redirectUris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none'
  };
}

/** Stands in for the client's own web server. Never reaches the network. */
const stubFetch: typeof fetch = async input => {
  const url = input instanceof Request ? input.url : String(input);
  fetchCount.set(url, (fetchCount.get(url) ?? 0) + 1);
  const entry = documents.get(url);
  if (!entry) return new Response('not found', { status: 404 });
  const headers = new Headers({ 'content-type': entry.contentType ?? 'application/json' });
  if (entry.cacheControl) headers.set('cache-control', entry.cacheControl);
  if (entry.contentLength) headers.set('content-length', entry.contentLength);
  return new Response(entry.body, { status: entry.status ?? 200, headers });
};

function pkcePair() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
}

/**
 * Starts an authorization and follows through to whichever page the flow shows.
 *
 * Written to work regardless of where that page lives: the hand-written server
 * rendered it straight from /authorize, the replacement redirects to its own
 * interaction URL first. Only a redirect back to the CLIENT is returned as-is,
 * because that is the outcome the tests want to inspect.
 */
async function authorize(
  clientId: string,
  challenge: string,
  redirectUri: string = REDIRECT_URI,
  agent?: ReturnType<typeof request.agent>
) {
  const caller = agent ?? request.agent(hub.app);
  const started = await caller
    .get('/authorize')
    .query({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'xyz',
      resource: 'http://localhost:3000/hub'
    })
    .redirects(0);
  const location = started.headers.location as string | undefined;
  if (!location || location.startsWith(redirectUri)) return started;
  const path = location.startsWith('http') ? new URL(location).pathname : location;
  return caller.get(path).redirects(0);
}

/** Signs in for real; forging a cookie no longer makes a session. */
async function signedInAgent(): Promise<ReturnType<typeof request.agent>> {
  const agent = request.agent(hub.app);
  const bootstrap = await request(hub.app)
    .post('/register')
    .send({ redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: 'none', client_name: 'cimd-bootstrap' })
    .expect(201);
  await authorizeInBrowser(hub.app, bootstrap.body.client_id, {
    password: PASSWORD,
    redirectUri: REDIRECT_URI,
    resource: 'http://localhost:3000/hub',
    agent
  });
  return agent;
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-cimd-'));
  const configPath = path.join(tmpDir, 'mcp.json');
  fs.writeFileSync(configPath, JSON.stringify({ mcpServers: { everything: { command: process.execPath, args: [EVERYTHING] } } }));
  hub = await createHub({
    externalUrl: 'http://localhost:3000',
    configPath,
    dataPath: path.join(tmpDir, 'data'),
    password: PASSWORD,
    idleTimeoutMinutes: 0,
    // The stubbed fetch answers for client.example, but the SSRF guard would
    // still try to resolve it. Blocking is covered by its own suite below.
    cimdAllowPrivateAddresses: true
  });
  await hub.supervisor.waitUntilSettled();
}, 30_000);

afterAll(async () => {
  setCimdFetch(undefined);
  hub?.watcher.stop();
  await hub?.supervisor.stop();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  documents = new Map();
  fetchCount = new Map();
  setCimdFetch(stubFetch);
});

afterEach(() => {
  setCimdFetch(undefined);
});

describe('client_id metadata document URLs', () => {
  it('accepts https URLs with a path and rejects everything else', () => {
    expect(isClientIdMetadataUrl('https://client.example/oauth/client.json')).toBe(true);
    expect(isClientIdMetadataUrl('https://client.example/c')).toBe(true);
    expect(isClientIdMetadataUrl('http://client.example/c.json')).toBe(false); // not https
    expect(isClientIdMetadataUrl('https://client.example')).toBe(false); // no path
    expect(isClientIdMetadataUrl('https://client.example/')).toBe(false); // root only
    expect(isClientIdMetadataUrl('https://client.example/c.json#f')).toBe(false); // fragment
    expect(isClientIdMetadataUrl('https://user:pw@client.example/c.json')).toBe(false); // credentials
    expect(isClientIdMetadataUrl('https://client.example/a/../c.json')).toBe(false); // dot segment
    // A dynamically registered client_id must keep going down the DCR path.
    expect(isClientIdMetadataUrl('mV5xQ2sJk1Tz')).toBe(false);
  });
});

describe('metadata document validation', () => {
  it('accepts a well-formed document', () => {
    const client = validateDocument(publicClientDocument(), CLIENT_ID);
    expect(client.client_id).toBe(CLIENT_ID);
    expect(client.redirect_uris).toEqual([REDIRECT_URI]);
    expect(client.client_secret).toBeUndefined();
  });

  it('cuts a client name down to something the consent page can show', () => {
    // Escaping alone would still render this: the redirect target and the
    // loopback warning below it would be pushed out of view.
    const document = {
      ...publicClientDocument(),
      client_name: `Trusted App\n\n\nYour session expired — re-enter your password${'.'.repeat(400)}`
    };
    const client = validateDocument(document, CLIENT_ID);
    expect(client.client_name).not.toContain('\n');
    expect(client.client_name!.length).toBeLessThanOrEqual(65);
  });

  it('rejects a document whose client_name is only control characters', () => {
    expect(() => validateDocument({ ...publicClientDocument(), client_name: '\n\t\u0000' }, CLIENT_ID)).toThrow();
  });

  const rejections: [string, unknown][] = [
    ['client_id does not match the URL', { ...publicClientDocument(), client_id: 'https://evil.example/c.json' }],
    ['client_name is missing', { ...publicClientDocument(), client_name: undefined }],
    ['redirect_uris is empty', { ...publicClientDocument(), redirect_uris: [] }],
    ['redirect_uris is absent', { ...publicClientDocument(), redirect_uris: undefined }],
    ['a redirect_uri is not a URL', { ...publicClientDocument(), redirect_uris: ['not-a-url'] }],
    ['a redirect_uri is plain http on a remote host', { ...publicClientDocument(), redirect_uris: ['http://evil.example/cb'] }],
    ['the document carries a client_secret', { ...publicClientDocument(), client_secret: 'hunter2' }],
    ['auth needs a shared secret', { ...publicClientDocument(), token_endpoint_auth_method: 'client_secret_post' }],
    ['private_key_jwt has no keys', { ...publicClientDocument(), token_endpoint_auth_method: 'private_key_jwt' }],
    ['a redirect_uri is not a string', { ...publicClientDocument(), redirect_uris: [42] }],
    ['the document is an array', []],
    ['the document is not an object', 'nope']
  ];
  for (const [name, document] of rejections) {
    it(`rejects a document where ${name}`, () => {
      expect(() => validateDocument(document, CLIENT_ID)).toThrow();
    });
  }
});

describe('private address detection', () => {
  it('classifies the ranges a client may not host its document on', () => {
    for (const address of ['127.0.0.1', '10.0.0.1', '172.16.5.4', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    for (const address of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700::1111']) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
    // Anything that is not an address at all is refused rather than trusted.
    expect(isPrivateAddress('not-an-address')).toBe(true);
  });

  it('sees through the IPv6 forms that carry an IPv4 address', () => {
    // NAT64 and 6to4 hide the destination in hex, so a textual range check
    // would wave `169.254.169.254` straight through on an IPv6-only host.
    for (const address of ['64:ff9b::a9fe:a9fe', '64:ff9b::7f00:1', '64:ff9b::a00:1', '2002:7f00:1::', '2002:a9fe:a9fe::']) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
  });

  it('refuses the reserved IPv4 ranges a public client cannot be on', () => {
    for (const address of ['192.0.0.1', '192.0.2.5', '198.18.0.1', '198.19.255.1', '198.51.100.7', '203.0.113.9']) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    // Neighbouring, genuinely routable space stays allowed.
    for (const address of ['192.0.1.1', '198.20.0.1', '203.0.114.1']) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });
});

describe('untrusted text on its way into a log or a page', () => {
  it('keeps a forged log record on one line', () => {
    const forged = logSafe('https://evil.example/a\nmcp-hub: authentication failure from 203.0.113.7');
    expect(forged).not.toContain('\n');
    expect(forged).toContain('\\x0a');
    expect(forged).toContain('203.0.113.7'); // still legible, just not a record
  });

  it('caps how much one value can write', () => {
    expect(logSafe('x'.repeat(5_000)).length).toBeLessThanOrEqual(201);
  });

  it('escapes invisible characters above the byte range too', () => {
    // U+2028 is a line separator some viewers render as a break, and U+200B is
    // simply invisible; neither should reach a log line as itself.
    expect(logSafe('a\u200bb\u2028c')).toBe('a\\u{200b}b\\u{2028}c');
  });

  it('reduces a display name to a single short line', () => {
    expect(clampDisplayName('Vitest  CIMD\n\nclient')).toBe('Vitest CIMD client');
    expect(clampDisplayName('x'.repeat(500))?.length).toBeLessThanOrEqual(65);
    expect(clampDisplayName('   ')).toBeUndefined();
    expect(clampDisplayName(42)).toBeUndefined();
  });
});

describe('address pinning', () => {
  // The whole point of resolving once: whatever the name would resolve to on a
  // second lookup, the connection goes to the address that was checked.
  it('answers every lookup with the address that was already vetted', async () => {
    const lookup = pinnedLookup('93.184.216.34');
    const single = await new Promise(resolve =>
      (lookup as unknown as (h: string, o: unknown, c: unknown) => void)('rebound.example', {}, (_e: unknown, address: string, family: number) =>
        resolve(`${address}/${family}`)
      )
    );
    expect(single).toBe('93.184.216.34/4');

    // Node asks for every address in some code paths; that shape has to be
    // answered too, or the socket falls back to a fresh resolution.
    const all = await new Promise(resolve =>
      (lookup as unknown as (h: string, o: unknown, c: unknown) => void)('rebound.example', { all: true }, (_e: unknown, results: unknown) =>
        resolve(results)
      )
    );
    expect(all).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });

  it('pins an IPv6 address with the right family', async () => {
    const lookup = pinnedLookup('2606:4700::1111');
    const single = await new Promise(resolve =>
      (lookup as unknown as (h: string, o: unknown, c: unknown) => void)('rebound.example', {}, (_e: unknown, address: string, family: number) =>
        resolve(`${address}/${family}`)
      )
    );
    expect(single).toBe('2606:4700::1111/6');
  });
});

describe('the jwks_uri fetch', () => {
  it('refuses a key set that is not served over https', async () => {
    const resolver = new CimdResolver({ fetchImpl: stubFetch });
    await expect(resolver.safeFetch('http://client.example/jwks.json')).rejects.toThrow(/not https/);
  });

  it('refuses a key set on a private address', async () => {
    const resolver = new CimdResolver({ fetchImpl: stubFetch });
    await expect(resolver.safeFetch('https://127.0.0.1/jwks.json')).rejects.toThrow(/private address/);
  });

  it('caps the key set, which jose would otherwise parse whole', async () => {
    const resolver = new CimdResolver({
      allowPrivateAddresses: true,
      fetchImpl: async () =>
        new Response('x'.repeat(70 * 1024), { status: 200, headers: { 'content-type': 'application/json' } })
    });
    await expect(resolver.safeFetch('https://client.example/jwks.json')).rejects.toThrow(/exceeds/);
  });

  it('forwards request headers in each shape a caller may hand it', async () => {
    const seen: string[] = [];
    const resolver = new CimdResolver({
      allowPrivateAddresses: true,
      fetchImpl: async (_url, init) => {
        seen.push(Object.keys(init?.headers as Record<string, string>).join(','));
        return new Response('{"keys":[]}', { status: 200, headers: { 'content-type': 'application/json' } });
      }
    });
    // jose passes a Headers instance; other callers pass a record or pairs.
    await resolver.safeFetch('https://client.example/j.json', { headers: new Headers({ 'x-a': '1' }) });
    await resolver.safeFetch('https://client.example/j.json', { headers: { 'x-b': '2' } });
    await resolver.safeFetch('https://client.example/j.json', { headers: [['x-c', '3']] });
    await resolver.safeFetch('https://client.example/j.json');
    expect(seen).toEqual(['x-a', 'x-b', 'x-c', '']);
  });
});

describe('the guarded transport', () => {
  let server: http.Server;
  let port: number;
  let seen: http.IncomingMessage | undefined;
  let respond: (res: http.ServerResponse) => void;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      seen = req;
      respond(res);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  // The hostname deliberately does not resolve: reaching the server at all is
  // proof that the pinned address, not DNS, decided where the socket went.
  const get = (path: string, maxBytes = 5 * 1024, timeoutMs = 5_000) =>
    guardedRequest(new URL(`http://pinned.invalid:${port}${path}`), {
      pinnedAddress: '127.0.0.1',
      headers: { Accept: 'application/json' },
      timeoutMs,
      maxBytes
    });

  it('reaches a host that DNS cannot resolve, and preserves it as the Host header', async () => {
    respond = res => {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'max-age=600' });
      res.end(JSON.stringify({ ok: true }));
    };
    const response = await get('/doc.json?x=1');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('max-age=600');
    expect(await response.json()).toEqual({ ok: true });
    // The certificate would be checked against this name, not the address.
    expect(seen?.headers.host).toBe(`pinned.invalid:${port}`);
    expect(seen?.url).toBe('/doc.json?x=1');
    expect(seen?.headers.accept).toBe('application/json');
    // Compression would make the byte cap measure the wrong thing.
    expect(seen?.headers['accept-encoding']).toBe('identity');
  });

  it('refuses a redirect rather than following it', async () => {
    respond = res => {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
      res.end();
    };
    await expect(get('/redirect')).rejects.toThrow(/redirect/i);
  });

  it('stops reading once the body passes the cap', async () => {
    respond = res => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('x'.repeat(20 * 1024));
    };
    await expect(get('/big', 1024)).rejects.toThrow(/exceeds/);
  });

  it('refuses a body whose declared length is already too large', async () => {
    respond = res => {
      const payload = 'x'.repeat(4 * 1024);
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(payload.length) });
      res.end(payload);
    };
    await expect(get('/declared', 1024)).rejects.toThrow(/exceeds/);
  });

  it('bounds the whole exchange, not just an idle socket', async () => {
    respond = res => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{');
      // Never finished: a body trickled out slowly must not hold the request open.
    };
    await expect(get('/slow', 5 * 1024, 150)).rejects.toThrow(/timed out/);
  });

  it('represents an empty body without inventing one', async () => {
    respond = res => {
      res.writeHead(204);
      res.end();
    };
    const response = await get('/empty');
    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
  });

  it('surfaces a failed status instead of throwing', async () => {
    respond = res => {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end('{}');
    };
    expect((await get('/down')).status).toBe(503);
  });
});

describe('redirect URI policy', () => {
  it('allows https anywhere and plain http only on this machine', () => {
    const strict = { allowPrivateUseSchemes: false };
    expect(isSafeRedirectUri('https://app.example/cb', strict)).toBe(true);
    expect(isSafeRedirectUri('http://127.0.0.1:5000/cb', strict)).toBe(true);
    expect(isSafeRedirectUri('http://localhost/cb', strict)).toBe(true);
    // The code would travel in the clear on the last hop.
    expect(isSafeRedirectUri('http://app.example/cb', strict)).toBe(false);
    expect(isSafeRedirectUri('not-a-url', strict)).toBe(false);
  });

  it('admits a private-use scheme only where the policy says so', () => {
    expect(isSafeRedirectUri('com.example.app:/cb', { allowPrivateUseSchemes: true })).toBe(true);
    expect(isSafeRedirectUri('com.example.app:/cb', { allowPrivateUseSchemes: false })).toBe(false);
    // Never, under either policy.
    for (const uri of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd']) {
      expect(isSafeRedirectUri(uri, { allowPrivateUseSchemes: true }), uri).toBe(false);
    }
  });
});

describe('the resolver', () => {
  it('refuses an origin that is not on the allowlist', async () => {
    serve(CLIENT_ID, publicClientDocument());
    const resolver = new CimdResolver({ allowedOrigins: ['https://chatgpt.com'], allowPrivateAddresses: true, fetchImpl: stubFetch });
    expect(await resolver.resolve(CLIENT_ID)).toBeUndefined();
    expect(fetchCount.get(CLIENT_ID)).toBeUndefined(); // refused before any request
    expect(await resolver.resolve('https://chatgpt.com/oauth/x.json')).toBeUndefined(); // admitted, but nothing served
  });

  it('refuses a private address literal', async () => {
    const clientId = 'https://127.0.0.1/oauth/client.json';
    serve(clientId, publicClientDocument(clientId));
    const resolver = new CimdResolver({ fetchImpl: stubFetch });
    expect(await resolver.resolve(clientId)).toBeUndefined();
    expect(fetchCount.get(clientId)).toBeUndefined();
  });

  it('refuses a hostname that resolves to a private address', async () => {
    const clientId = 'https://localhost/oauth/client.json';
    serve(clientId, publicClientDocument(clientId));
    const resolver = new CimdResolver({ fetchImpl: stubFetch });
    expect(await resolver.resolve(clientId)).toBeUndefined();
    expect(fetchCount.get(clientId)).toBeUndefined();
  });

  it('refuses a hostname that does not resolve at all', async () => {
    const clientId = 'https://nothing.invalid/oauth/client.json';
    serve(clientId, publicClientDocument(clientId));
    const resolver = new CimdResolver({ fetchImpl: stubFetch });
    expect(await resolver.resolve(clientId)).toBeUndefined();
    expect(fetchCount.get(clientId)).toBeUndefined();
  });

  it('accepts a public address literal', async () => {
    const clientId = 'https://93.184.216.34/oauth/client.json';
    serve(clientId, publicClientDocument(clientId));
    const resolver = new CimdResolver({ fetchImpl: stubFetch });
    expect((await resolver.resolve(clientId))?.client_id).toBe(clientId);
  });

  it('refuses a response with no body', async () => {
    const clientId = 'https://client.example/empty.json';
    const resolver = new CimdResolver({
      allowPrivateAddresses: true,
      fetchImpl: async () => new Response(null, { status: 200, headers: { 'content-type': 'application/json' } })
    });
    expect(await resolver.resolve(clientId)).toBeUndefined();
  });

  it('holds a no-store document only for the minimum lifetime', async () => {
    const clientId = 'https://client.example/nostore.json';
    serve(clientId, publicClientDocument(clientId), { cacheControl: 'no-store' });
    const resolver = new CimdResolver({ allowPrivateAddresses: true, fetchImpl: stubFetch });
    expect((await resolver.resolve(clientId))?.client_id).toBe(clientId);
    await resolver.resolve(clientId);
    expect(fetchCount.get(clientId)).toBe(1);
  });

  it('evicts the least recently used entry once the cache is full', async () => {
    const resolver = new CimdResolver({ allowPrivateAddresses: true, fetchImpl: stubFetch });
    const first = 'https://client.example/lru-0.json';
    serve(first, publicClientDocument(first), { cacheControl: 'max-age=3600' });
    await resolver.resolve(first);
    for (let i = 1; i <= 200; i++) {
      const id = `https://client.example/lru-${i}.json`;
      serve(id, publicClientDocument(id), { cacheControl: 'max-age=3600' });
      await resolver.resolve(id);
    }
    // The oldest entry is gone, so asking for it again costs a second fetch.
    await resolver.resolve(first);
    expect(fetchCount.get(first)).toBe(2);
  });

  it('refuses a non-JSON content type, a bad status and unparseable JSON', async () => {
    const resolver = new CimdResolver({ allowPrivateAddresses: true, fetchImpl: stubFetch });
    serve('https://client.example/html.json', publicClientDocument('https://client.example/html.json'), { contentType: 'text/html' });
    expect(await resolver.resolve('https://client.example/html.json')).toBeUndefined();

    documents.set('https://client.example/500.json', { body: '{}', status: 500 });
    expect(await resolver.resolve('https://client.example/500.json')).toBeUndefined();

    serve('https://client.example/broken.json', '{ not json');
    expect(await resolver.resolve('https://client.example/broken.json')).toBeUndefined();
  });

  it('accepts a JSON media type with a suffix', async () => {
    const clientId = 'https://client.example/suffix.json';
    serve(clientId, publicClientDocument(clientId), { contentType: 'application/client-metadata+json; charset=utf-8' });
    const resolver = new CimdResolver({ allowPrivateAddresses: true, fetchImpl: stubFetch });
    expect((await resolver.resolve(clientId))?.client_name).toBe('Vitest CIMD client');
  });

  it('refuses a document larger than five kilobytes', async () => {
    const clientId = 'https://client.example/big.json';
    const padded = { ...publicClientDocument(clientId), padding: 'x'.repeat(6 * 1024) };
    serve(clientId, padded);
    const resolver = new CimdResolver({ allowPrivateAddresses: true, fetchImpl: stubFetch });
    expect(await resolver.resolve(clientId)).toBeUndefined();
  });

  it('refuses a document whose declared length is already too large', async () => {
    const clientId = 'https://client.example/lying.json';
    documents.set(clientId, { body: JSON.stringify(publicClientDocument(clientId)), contentLength: String(9 * 1024) });
    const resolver = new CimdResolver({ allowPrivateAddresses: true, fetchImpl: stubFetch });
    expect(await resolver.resolve(clientId)).toBeUndefined();
  });

  it('never follows a redirect', async () => {
    const clientId = 'https://client.example/redirect.json';
    const resolver = new CimdResolver({
      allowPrivateAddresses: true,
      fetchImpl: async (_input, init) => {
        expect((init as RequestInit).redirect).toBe('error');
        throw new TypeError('unexpected redirect');
      }
    });
    expect(await resolver.resolve(clientId)).toBeUndefined();
  });

  it('caches a document and collapses concurrent lookups into one fetch', async () => {
    serve(CLIENT_ID, publicClientDocument(), { cacheControl: 'max-age=600' });
    const resolver = new CimdResolver({ allowPrivateAddresses: true, fetchImpl: stubFetch });
    const [a, b] = await Promise.all([resolver.resolve(CLIENT_ID), resolver.resolve(CLIENT_ID)]);
    expect(a?.client_name).toBe('Vitest CIMD client');
    expect(b?.client_name).toBe('Vitest CIMD client');
    await resolver.resolve(CLIENT_ID);
    expect(fetchCount.get(CLIENT_ID)).toBe(1);
  });

  it('remembers a rejection briefly so a bad client_id cannot be used to hammer a third party', async () => {
    const clientId = 'https://client.example/missing.json';
    const resolver = new CimdResolver({ allowPrivateAddresses: true, fetchImpl: stubFetch });
    expect(await resolver.resolve(clientId)).toBeUndefined();
    expect(await resolver.resolve(clientId)).toBeUndefined();
    expect(fetchCount.get(clientId)).toBe(1);
  });

  it('stops fetching an origin that keeps failing, however the client_id is varied', async () => {
    const resolver = new CimdResolver({ allowPrivateAddresses: true, fetchImpl: stubFetch });
    // The query string is part of the client_id, so every one of these is a
    // distinct identifier and the per-URL negative cache never fires. Nothing
    // is served, so each lookup fails.
    for (let index = 0; index < 25; index++) await resolver.resolve(`https://flood.example/c.json?n=${index}`);
    const reached = [...fetchCount.keys()].filter(url => url.startsWith('https://flood.example/')).length;
    expect(reached).toBe(10); // MAX_ORIGIN_FAILURES, then the origin is left alone
  });

  it('cannot be made to forge a second log record through the client_id', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // The URL parser strips the newlines, so this passes every structural
      // check — while the raw string is what would reach the log.
      const forged = 'https://client.example/a\nmcp-hub: authentication failure from 203.0.113.7\n';
      expect(isClientIdMetadataUrl(forged)).toBe(true);
      const resolver = new CimdResolver({ allowPrivateAddresses: true, fetchImpl: stubFetch });
      expect(await resolver.resolve(forged)).toBeUndefined();
      const lines = warn.mock.calls.map(call => String(call[0]));
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(line).not.toContain('\n');
    } finally {
      warn.mockRestore();
    }
  });
});

describe('loopback-only clients', () => {
  it('recognises a client that can only receive codes on this machine', () => {
    expect(isLoopbackOnly(['http://localhost:1/cb', 'http://127.0.0.1:2/cb'])).toBe(true);
    expect(isLoopbackOnly(['http://127.0.0.1:2/cb', 'https://app.example/cb'])).toBe(false);
    expect(isLoopbackOnly(['not-a-url'])).toBe(false);
    expect(isLoopbackOnly([])).toBe(false);
    expect(isLoopbackOnly(undefined)).toBe(false);
  });
});

// The hand-rolled replay guard is gone: the authorization server rejects a
// reused jti through its own ReplayDetection model, which is exercised
// end-to-end in oidc-mount.test.ts rather than as a unit here.

describe('authorization server metadata', () => {
  it('advertises CIMD support and private_key_jwt on every discovery document', async () => {
    for (const url of [
      '/.well-known/oauth-authorization-server',
      '/.well-known/oauth-authorization-server/everything/mcp',
      '/.well-known/openid-configuration'
    ]) {
      const metadata = await request(hub.app).get(url).expect(200);
      expect(metadata.body.client_id_metadata_document_supported, url).toBe(true);
      expect(metadata.body.token_endpoint_auth_methods_supported, url).toContain('private_key_jwt');
      expect(metadata.body.token_endpoint_auth_signing_alg_values_supported, url).toContain('ES256');
      // Dynamic registration stays advertised beside it.
      expect(metadata.body.registration_endpoint, url).toContain('/register');
    }
  });
});

describe('the authorization flow with a metadata document', () => {
  it('runs end to end and binds the tokens to the document URL', async () => {
    serve(CLIENT_ID, publicClientDocument());
    const page = await authorize(CLIENT_ID, pkcePair().challenge);
    expect(page.status).toBe(200);
    // Draft §6.4: the URL that vouches for the self-declared name is shown.
    expect(page.text).toContain('Identified by');
    expect(page.text).toContain(escapeHtml(CLIENT_ID));
    expect(page.text).toContain('Vitest CIMD client');
    // Every redirect URI is local, which nobody can attribute.
    expect(page.text).toContain('any program running here could be the one asking');

    const { code, verifier } = await authorizeInBrowser(hub.app, CLIENT_ID, {
      password: PASSWORD,
      redirectUri: REDIRECT_URI,
      resource: 'http://localhost:3000/hub'
    });

    const tokens = await request(hub.app)
      .post('/token')
      .type('form')
      .send({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        resource: 'http://localhost:3000/hub'
      })
      .expect(200);
    expect(tokens.body.token_type).toBe('Bearer');

    const auth = await hub.verifier.verifyAccessToken(tokens.body.access_token);
    expect(auth.clientId).toBe(CLIENT_ID);
    expect(auth.resource?.href).toBe('http://localhost:3000/hub');

    // The approval is what a metadata-document client leaves behind; the
    // document itself is never persisted.
    expect(hub.store.listApprovals()[CLIENT_ID]?.clientName).toBe('Vitest CIMD client');
    expect(hub.store.listClients()[CLIENT_ID]).toBeUndefined();

    // A second authorization with a live session goes through silently.
    const cookie = await signedInAgent();
    const silent = await authorize(CLIENT_ID, pkcePair().challenge, REDIRECT_URI, cookie);
    expect(silent.status).toBe(303);
    expect(new URL(silent.headers.location).searchParams.get('code')).toBeTruthy();
  });

  it('registers a document that declares a grant this server does not have', async () => {
    // claude.ai's real document, reduced to the part that mattered: it declares
    // jwt-bearer alongside the two grants it actually uses. oidc-provider
    // refuses a registration outright when it sees a grant type the server does
    // not offer, so 0.11.0 answered every attempt with
    // `invalid_client_metadata: grant_types can only contain
    // 'authorization_code' or 'refresh_token'` and claude.ai could not connect
    // at all. The hand-written server this replaced ignored the extras, which
    // is why the failure arrived with the rewrite rather than with the client.
    const clientId = 'https://client.example/extra-grants.json';
    serve(clientId, {
      ...publicClientDocument(clientId),
      grant_types: ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:jwt-bearer']
    });

    const { code, verifier } = await authorizeInBrowser(hub.app, clientId, {
      password: PASSWORD,
      redirectUri: REDIRECT_URI,
      resource: 'http://localhost:3000/hub'
    });
    const tokens = await request(hub.app)
      .post('/token')
      .type('form')
      .send({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        resource: 'http://localhost:3000/hub'
      })
      .expect(200);
    expect(tokens.body.token_type).toBe('Bearer');

    // The grant it does not have was dropped, not honoured: asking for it is
    // still refused, so trimming the declaration widened nothing.
    const refused = await request(hub.app)
      .post('/token')
      .type('form')
      .send({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: 'irrelevant',
        client_id: clientId
      });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.body.error).toBe('unsupported_grant_type');
  });

  it('settles when the client asks for the scope the hub advertises', async () => {
    // The hub's discovery document says `scopes_supported: ["openid"]` and
    // cannot say otherwise — oidc-provider adds it unconditionally. So a client
    // that reads the document asks for it, and claude.ai does.
    //
    // A requested scope the grant does not carry leaves the consent prompt
    // unsatisfied: the resume sends the browser back to the interaction, the
    // consent page renders again, approving it finishes the interaction, the
    // resume finds the same missing scope. From the outside that is an approve
    // button that reloads the page and never does anything. This walk gives up
    // after twelve hops, so the loop is what fails the test.
    const clientId = 'https://client.example/openid-scope.json';
    serve(clientId, publicClientDocument(clientId));

    const { code } = await authorizeInBrowser(hub.app, clientId, {
      password: PASSWORD,
      redirectUri: REDIRECT_URI,
      resource: 'http://localhost:3000/hub',
      scope: 'openid'
    });
    expect(code).toBeTruthy();
  });

  it('refuses a document whose grants this server has none of', async () => {
    // Trimming a superset is a kindness to a client that talks to many
    // servers. Trimming everything away is not: it would register a client
    // that has no way to get a token, and the failure would surface later and
    // somewhere else.
    const clientId = 'https://client.example/no-usable-grant.json';
    serve(clientId, {
      ...publicClientDocument(clientId),
      grant_types: ['urn:ietf:params:oauth:grant-type:jwt-bearer']
    });

    const page = await authorize(clientId, pkcePair().challenge);
    expect(page.status).toBeGreaterThanOrEqual(400);
  });

  it('asks for consent before issuing a code to a document it has not seen', async () => {
    const clientId = 'https://client.example/unapproved.json';
    serve(clientId, publicClientDocument(clientId, ['https://app.example/cb']));
    const cookie = await signedInAgent();
    const page = await authorize(clientId, pkcePair().challenge, 'https://app.example/cb', cookie);
    expect(page.status).toBe(200);
    expect(page.text).toContain('Authorize access?');
    expect(page.text).toContain(clientId);
    // A remote redirect URI is attributable, so no local-program warning.
    expect(page.text).not.toContain('any program running here could be the one asking');
  });

  it('shows a clamped name on the page instead of a wall of text', async () => {
    const clientId = 'https://client.example/loud.json';
    serve(clientId, {
      ...publicClientDocument(clientId, ['https://app.example/cb']),
      client_name: `Trusted App\n\nSession expired, re-enter your password${'!'.repeat(400)}`
    });
    const page = await authorize(clientId, pkcePair().challenge, 'https://app.example/cb');
    expect(page.status).toBe(200);
    // One line, and short enough that the redirect target below it stays visible.
    expect(page.text).toContain('Trusted App Session expired');
    expect(page.text).not.toContain('!'.repeat(30));
    expect(page.text).toContain('Codes will be sent to');
    expect(page.text).toContain('https://app.example/cb');
  });

  it('refuses a document whose client_id does not match its URL, without saying why', async () => {
    const clientId = 'https://client.example/impostor.json';
    serve(clientId, publicClientDocument('https://chatgpt.com/oauth/x.json'));
    const response = await authorize(clientId, pkcePair().challenge);
    expect(response.status).toBe(400);
    expect(['invalid_client', 'invalid_request']).toContain(response.body.error);
    expect(JSON.stringify(response.body)).not.toContain('does not match');
  });

  it('refuses a client_id with no document at all', async () => {
    const response = await authorize('https://client.example/nothing.json', pkcePair().challenge);
    expect(response.status).toBe(400);
    expect(['invalid_client', 'invalid_request']).toContain(response.body.error);
  });

  it('refuses a redirect_uri the document does not list', async () => {
    serve(CLIENT_ID, publicClientDocument());
    const response = await authorize(CLIENT_ID, pkcePair().challenge, 'http://localhost:33418/elsewhere');
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_redirect_uri');
  });

  it('allows the ephemeral port a native client picks on each run', async () => {
    const clientId = 'https://client.example/native.json';
    serve(clientId, publicClientDocument(clientId, ['http://127.0.0.1:1/callback']));
    expect((await authorize(clientId, pkcePair().challenge, 'http://127.0.0.1:52341/callback')).status).toBe(200);
  });
});

describe('private_key_jwt client authentication', () => {
  let privateKey: CryptoKey;
  let jwks: { keys: JWK[] };
  const clientId = 'https://client.example/confidential.json';

  // One key pair for the whole block: the resolver caches the document, so a
  // fresh pair per test would be verified against the first one it saw.
  beforeAll(async () => {
    const pair = await generateKeyPair('ES256', { extractable: true });
    privateKey = pair.privateKey;
    jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'test-key', alg: 'ES256', use: 'sig' }] };
  });

  beforeEach(() => {
    serve(clientId, { ...publicClientDocument(clientId), token_endpoint_auth_method: 'private_key_jwt', jwks });
  });

  async function assertion(overrides: { aud?: string; jti?: string; expSeconds?: number; sub?: string; iss?: string } = {}): Promise<string> {
    const jwt = new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
      .setIssuer(overrides.iss ?? clientId)
      .setSubject(overrides.sub ?? clientId)
      .setAudience(overrides.aud ?? 'http://localhost:3000/token')
      .setIssuedAt()
      .setJti(overrides.jti ?? crypto.randomBytes(8).toString('hex'));
    return jwt.setExpirationTime(`${overrides.expSeconds ?? 120}s`).sign(privateKey);
  }

  /** Runs the authorization leg and returns a redeemable code. */
  async function codeFor(): Promise<{ code: string; verifier: string }> {
    const { code, verifier } = await authorizeInBrowser(hub.app, clientId, {
      password: PASSWORD,
      redirectUri: REDIRECT_URI,
      resource: 'http://localhost:3000/hub'
    });
    return { code, verifier };
  }

  function redeem(code: string, verifier: string, clientAssertion: string) {
    return request(hub.app).post('/token').type('form').send({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      resource: 'http://localhost:3000/hub',
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: clientAssertion
    });
  }

  it('exchanges a code for tokens when the assertion verifies', async () => {
    const { code, verifier } = await codeFor();
    const tokens = await redeem(code, verifier, await assertion()).expect(200);
    expect(tokens.body.access_token).toBeTruthy();
    expect((await hub.verifier.verifyAccessToken(tokens.body.access_token)).clientId).toBe(clientId);
  });

  it('accepts the issuer identifier as the audience', async () => {
    const { code, verifier } = await codeFor();
    await redeem(code, verifier, await assertion({ aud: 'http://localhost:3000/' })).expect(200);
  });

  // A client that declared private_key_jwt has no client_secret, and the SDK's
  // client authentication only ever looks for one — so leaving the assertion
  // out entirely must not be a way to be treated as a public client.
  it('refuses a code exchange that simply omits the assertion', async () => {
    const { code, verifier } = await codeFor();
    const response = await request(hub.app)
      .post('/token')
      .type('form')
      .send({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        resource: 'http://localhost:3000/hub'
      })
      ;
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(['invalid_client', 'invalid_request']).toContain(response.body.error);
  });

  it('refuses a refresh token presented without the assertion', async () => {
    const { code, verifier } = await codeFor();
    const tokens = await redeem(code, verifier, await assertion()).expect(200);
    // This is the case the private key exists for: the token alone must not be
    // enough to mint a new one.
    const response = await request(hub.app)
      .post('/token')
      .type('form')
      .send({ grant_type: 'refresh_token', refresh_token: tokens.body.refresh_token, client_id: clientId })
      ;
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(['invalid_client', 'invalid_request']).toContain(response.body.error);

    // The legitimate holder, who can sign, still gets through.
    await request(hub.app)
      .post('/token')
      .type('form')
      .send({
        grant_type: 'refresh_token',
        refresh_token: tokens.body.refresh_token,
        client_id: clientId,
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: await assertion()
      })
      .expect(200);
  });

  it('leaves a public metadata-document client able to redeem without one', async () => {
    // Only a client that promised private_key_jwt owes an assertion.
    serve(CLIENT_ID, publicClientDocument());
    const { code, verifier } = await authorizeInBrowser(hub.app, CLIENT_ID, {
      password: PASSWORD,
      redirectUri: REDIRECT_URI,
      resource: 'http://localhost:3000/hub'
    });

    const response = await request(hub.app)
      .post('/token')
      .type('form')
      .send({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        resource: 'http://localhost:3000/hub'
      })
      .expect(200);
    expect(response.body.access_token).toBeTruthy();
  });

  it('refuses a key set larger than the cap instead of buffering it', async () => {
    const hugeClientId = 'https://client.example/huge-keys.json';
    const jwksUri = 'https://client.example/huge-jwks.json';
    serve(hugeClientId, { ...publicClientDocument(hugeClientId), token_endpoint_auth_method: 'private_key_jwt', jwks_uri: jwksUri });
    // jose hands the body straight to response.json(); without a cap of our
    // own this is what a client gets to push into the heap.
    serve(jwksUri, { keys: jwks.keys, padding: 'x'.repeat(80 * 1024) });
    const response = await request(hub.app)
      .post('/token')
      .type('form')
      .send({
        grant_type: 'authorization_code',
        code: 'irrelevant',
        code_verifier: 'irrelevant',
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: await assertion({ iss: hugeClientId, sub: hugeClientId })
      })
      ;
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(['invalid_client', 'invalid_request']).toContain(response.body.error);
  });

  it('refuses an assertion for another audience', async () => {
    const { code, verifier } = await codeFor();
    const response = await redeem(code, verifier, await assertion({ aud: 'https://evil.example/token' }));
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(['invalid_client', 'invalid_request']).toContain(response.body.error);
  });

  it('refuses an expired assertion', async () => {
    const { code, verifier } = await codeFor();
    const response = await redeem(code, verifier, await assertion({ expSeconds: -600 }));
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(['invalid_client', 'invalid_request']).toContain(response.body.error);
  });

  it('refuses an assertion whose lifetime is longer than five minutes', async () => {
    const { code, verifier } = await codeFor();
    const response = await redeem(code, verifier, await assertion({ expSeconds: 3600 }));
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(['invalid_client', 'invalid_request']).toContain(response.body.error);
  });

  it('refuses an assertion whose subject is not the client', async () => {
    const { code, verifier } = await codeFor();
    const response = await redeem(code, verifier, await assertion({ sub: 'https://client.example/other.json' }));
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(['invalid_client', 'invalid_request']).toContain(response.body.error);
  });

  it('refuses a replayed jti', async () => {
    const jti = crypto.randomBytes(8).toString('hex');
    const first = await codeFor();
    await redeem(first.code, first.verifier, await assertion({ jti })).expect(200);
    const second = await codeFor();
    const response = await redeem(second.code, second.verifier, await assertion({ jti }));
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(['invalid_client', 'invalid_request']).toContain(response.body.error);
  });

  it('refuses an assertion signed by a key the document does not publish', async () => {
    const other = await generateKeyPair('ES256', { extractable: true });
    const forged = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
      .setIssuer(clientId)
      .setSubject(clientId)
      .setAudience('http://localhost:3000/token')
      .setIssuedAt()
      .setJti(crypto.randomBytes(8).toString('hex'))
      .setExpirationTime('120s')
      .sign(other.privateKey);
    const { code, verifier } = await codeFor();
    const response = await redeem(code, verifier, forged);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(['invalid_client', 'invalid_request']).toContain(response.body.error);
  });

  it('refuses an assertion from a client that does not declare private_key_jwt', async () => {
    serve(CLIENT_ID, publicClientDocument());
    const response = await request(hub.app)
      .post('/token')
      .type('form')
      .send({
        grant_type: 'authorization_code',
        code: 'irrelevant',
        code_verifier: 'irrelevant',
        client_id: CLIENT_ID,
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: await assertion({ iss: CLIENT_ID, sub: CLIENT_ID })
      })
      ;
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(['invalid_client', 'invalid_request']).toContain(response.body.error);
  });

  it('verifies against a jwks_uri when the document publishes no inline keys', async () => {
    const remoteClientId = 'https://client.example/remote-keys.json';
    const jwksUri = 'https://client.example/jwks.json';
    serve(remoteClientId, {
      ...publicClientDocument(remoteClientId),
      token_endpoint_auth_method: 'private_key_jwt',
      jwks_uri: jwksUri
    });
    serve(jwksUri, jwks);
    const { code, verifier } = await authorizeInBrowser(hub.app, remoteClientId, {
      password: PASSWORD,
      redirectUri: REDIRECT_URI,
      resource: 'http://localhost:3000/hub'
    });
    const signed = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
      .setIssuer(remoteClientId)
      .setSubject(remoteClientId)
      .setAudience('http://localhost:3000/token')
      .setIssuedAt()
      .setJti(crypto.randomBytes(8).toString('hex'))
      .setExpirationTime('120s')
      .sign(privateKey);
    await request(hub.app)
      .post('/token')
      .type('form')
      .send({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        client_id: remoteClientId,
        redirect_uri: REDIRECT_URI,
        resource: 'http://localhost:3000/hub',
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: signed
      })
      .expect(200);
    expect(fetchCount.get(jwksUri)).toBeGreaterThanOrEqual(1);
  });

  it('refuses a document whose jwks is not a key set and has no jwks_uri', async () => {
    const brokenClientId = 'https://client.example/broken-keys.json';
    serve(brokenClientId, { ...publicClientDocument(brokenClientId), token_endpoint_auth_method: 'private_key_jwt', jwks: 'not-a-key-set' });
    const response = await request(hub.app)
      .post('/token')
      .type('form')
      .send({
        grant_type: 'authorization_code',
        code: 'irrelevant',
        code_verifier: 'irrelevant',
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: await assertion({ iss: brokenClientId, sub: brokenClientId })
      })
      ;
    // A document that publishes neither a usable jwks nor a jwks_uri cannot
    // authenticate anything; refused as bad metadata rather than as a bad
    // client, which is the more accurate of the two.
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(['invalid_client', 'invalid_request', 'invalid_client_metadata']).toContain(response.body.error);
  });

  const malformed: [string, () => Promise<string> | string][] = [
    ['is not a JWS', () => 'only.two'],
    ['has an unreadable payload', () => 'aGVhZGVy.bm90LWpzb24.c2ln'],
    ['carries no iss', () => `aGVhZGVy.${Buffer.from(JSON.stringify({ sub: 'x' })).toString('base64url')}.c2ln`],
    ['names a client_id that is not a document URL', () => assertion({ iss: 'plain-client-id', sub: 'plain-client-id' })],
    ['names a document nobody serves', () => assertion({ iss: 'https://client.example/gone.json', sub: 'https://client.example/gone.json' })]
  ];
  for (const [name, build] of malformed) {
    it(`refuses an assertion that ${name}`, async () => {
      const response = await request(hub.app)
        .post('/token')
        .type('form')
        .send({
          grant_type: 'authorization_code',
          client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
          client_assertion: await build()
        })
        ;
      // Refused either as a bad request or as a client that could not be
      // authenticated, depending on how far the assertion got. The property
      // under test is that a malformed one never buys a token.
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(['invalid_client', 'invalid_request']).toContain(response.body.error);
      expect(response.body.access_token).toBeUndefined();
    });
  }

  it('refuses a client_id form field that disagrees with the assertion issuer', async () => {
    const response = await request(hub.app)
      .post('/token')
      .type('form')
      .send({
        grant_type: 'authorization_code',
        client_id: 'https://client.example/someone-else.json',
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: await assertion()
      })
      ;
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(['invalid_client', 'invalid_request']).toContain(response.body.error);
  });

  it('refuses an assertion with no jti and one with no exp', async () => {
    const base = () =>
      new SignJWT({})
        .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
        .setIssuer(clientId)
        .setSubject(clientId)
        .setAudience('http://localhost:3000/token')
        .setIssuedAt();
    for (const assertionJwt of [await base().setExpirationTime('120s').sign(privateKey), await base().setJti('x').sign(privateKey)]) {
      const response = await request(hub.app)
        .post('/token')
        .type('form')
        .send({
          grant_type: 'authorization_code',
          client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
          client_assertion: assertionJwt
        })
        ;
      // Refused either as a bad request or as a client that could not be
      // authenticated, depending on how far the assertion got. The property
      // under test is that a malformed one never buys a token.
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(['invalid_client', 'invalid_request']).toContain(response.body.error);
      expect(response.body.access_token).toBeUndefined();
    }
  });

  it('refuses a client_assertion_type with no assertion', async () => {
    const response = await request(hub.app)
      .post('/token')
      .type('form')
      .send({ grant_type: 'authorization_code', client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer' })
      ;
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(['invalid_client', 'invalid_request']).toContain(response.body.error);
  });

  it('refuses an unknown client_assertion_type', async () => {
    const response = await request(hub.app)
      .post('/token')
      .type('form')
      .send({ grant_type: 'authorization_code', client_assertion_type: 'urn:something:else', client_assertion: 'x' })
      ;
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(['invalid_client', 'invalid_request']).toContain(response.body.error);
  });

  it('leaves a request without an assertion to the SDK', async () => {
    const response = await request(hub.app).post('/token').type('form').send({ grant_type: 'authorization_code', client_id: 'unknown-client' });
    expect(['invalid_client', 'invalid_request']).toContain(response.body.error);
    expect(response.body.error_description).not.toBe('Client authentication failed');
  });
});

describe('dynamic registration holds redirect URIs to the same rule', () => {
  const register = (redirectUris: string[], clientName = 'vitest') =>
    request(hub.app).post('/register').send({ redirect_uris: redirectUris, client_name: clientName, token_endpoint_auth_method: 'none' });

  it('refuses a plaintext callback on a remote host', async () => {
    // The SDK only keeps javascript:, data: and vbscript: out, so this used to
    // register happily and have the code delivered in the clear.
    // Refused with the more specific code than the hub used to send; the
    // property under test is that it is refused at all.
    const response = await register(['http://app.example.com/cb']).expect(400);
    expect(response.body.error).toBe('invalid_redirect_uri');
  });

  it('refuses a file:// callback', async () => {
    await register(['file:///tmp/cb']).expect(400);
  });

  it('accepts https, loopback and the private-use scheme a native client needs', async () => {
    for (const uri of ['https://app.example.com/cb', 'http://127.0.0.1:5000/cb', 'com.example.app:/cb']) {
      const response = await register([uri]).expect(201);
      expect(response.body.redirect_uris, uri).toEqual([uri]);
    }
  });

  it('shortens a client name that would take over the consent page', async () => {
    const response = await register(['https://app.example.com/cb'], `A\n\nB${'x'.repeat(300)}`).expect(201);
    expect(response.body.client_name).not.toContain('\n');
    expect(response.body.client_name.length).toBeLessThanOrEqual(65);
  });
});

describe('with dynamic registration turned off', () => {
  let cimdOnly: Awaited<ReturnType<typeof createHub>>;
  let dir: string;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-cimd-only-'));
    const configPath = path.join(dir, 'mcp.json');
    fs.writeFileSync(configPath, JSON.stringify({ mcpServers: { everything: { command: process.execPath, args: [EVERYTHING] } } }));
    cimdOnly = await createHub({
      externalUrl: 'http://localhost:3000',
      configPath,
      dataPath: path.join(dir, 'data'),
      password: PASSWORD,
      idleTimeoutMinutes: 0,
      clientRegistration: ['cimd'],
      cimdAllowPrivateAddresses: true
    });
    await cimdOnly.supervisor.waitUntilSettled();
  }, 30_000);

  afterAll(async () => {
    cimdOnly?.watcher.stop();
    await cimdOnly?.supervisor.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('drops the registration endpoint from the discovery document', async () => {
    const metadata = await request(cimdOnly.app).get('/.well-known/oauth-authorization-server').expect(200);
    expect(metadata.body.registration_endpoint).toBeUndefined();
    expect(metadata.body.client_id_metadata_document_supported).toBe(true);
  });

  it('stops serving /register', async () => {
    await request(cimdOnly.app).post('/register').send({ redirect_uris: [REDIRECT_URI], client_name: 'vitest' }).expect(404);
  });

  it('still authorizes a metadata document client', async () => {
    serve(CLIENT_ID, publicClientDocument());
    const agent = request.agent(cimdOnly.app);
    const started = await agent
      .get('/authorize')
      .query({
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: 'code',
        code_challenge: pkcePair().challenge,
        code_challenge_method: 'S256',
        resource: 'http://localhost:3000/hub'
      })
      .redirects(0);
    const page = await agent.get(new URL(started.headers.location as string, 'http://x').pathname).expect(200);
    expect(page.text).toContain('Vitest CIMD client');
  });
});

describe('with client ID metadata documents turned off', () => {
  let dcrOnly: Awaited<ReturnType<typeof createHub>>;
  let dir: string;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-dcr-only-'));
    const configPath = path.join(dir, 'mcp.json');
    fs.writeFileSync(configPath, JSON.stringify({ mcpServers: { everything: { command: process.execPath, args: [EVERYTHING] } } }));
    dcrOnly = await createHub({
      externalUrl: 'http://localhost:3000',
      configPath,
      dataPath: path.join(dir, 'data'),
      password: PASSWORD,
      idleTimeoutMinutes: 0,
      clientRegistration: ['dcr']
    });
    await dcrOnly.supervisor.waitUntilSettled();
  }, 30_000);

  afterAll(async () => {
    dcrOnly?.watcher.stop();
    await dcrOnly?.supervisor.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('does not advertise CIMD and treats a URL client_id as unknown', async () => {
    const metadata = await request(dcrOnly.app).get('/.well-known/oauth-authorization-server').expect(200);
    expect(metadata.body.client_id_metadata_document_supported).toBeUndefined();
    expect(metadata.body.registration_endpoint).toContain('/register');

    serve(CLIENT_ID, publicClientDocument());
    const response = await request(dcrOnly.app)
      .get('/authorize')
      .query({ client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, response_type: 'code', code_challenge: 'x', code_challenge_method: 'S256' })
      ;
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(['invalid_client', 'invalid_request']).toContain(response.body.error);
    expect(fetchCount.get(CLIENT_ID)).toBeUndefined();
  });
});
