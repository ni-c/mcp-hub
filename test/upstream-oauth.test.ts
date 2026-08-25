import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import request from 'supertest';
import { z } from 'zod';
import { importJWK, jwtVerify } from 'jose';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHub } from '../src/index.js';
import { handleMcpRequest } from '../src/proxy.js';
import { AuthStore } from '../src/auth/store.js';
import { signPayload } from '../src/auth/signed-token.js';
import { UpstreamAuth } from '../src/upstream/auth.js';
import { UpstreamAuthProvider, clientDocumentId, clientMetadataUrl, credentialFingerprint, hubClientMetadata } from '../src/upstream/provider.js';
import { requireOAuthServer, startUpstreamLogin, upstreamStatus } from '../src/upstream/login.js';
import { loadConfig } from '../src/config.js';

/**
 * The hub as an OAuth client. Everything here runs against a fake upstream that
 * is its own authorization server, so the whole exchange is real — discovery,
 * PKCE, registration, refresh — without touching the network.
 */

const PASSWORD = 'test-password';

/** Records what the upstream and its authorization server actually saw, which
 *  is what the leak assertions below are built on. */
interface Recorded {
  path: string;
  headers: Record<string, string | undefined>;
  body: Record<string, string>;
}

interface FakeUpstream {
  port: number;
  url: string;
  calls: Recorded[];
  close: () => Promise<void>;
  /** Flips the access token the resource server will accept. */
  expireAccessToken: () => void;
  /** Back to a pristine authorization server; the token counters are closure
   *  state and would otherwise leak between tests. */
  reset: () => void;
  tokenRequests: () => Recorded[];
  options: {
    supportsCimd: boolean;
    rotateRefreshToken: boolean;
    /** Refresh tokens the upstream has already retired. */
    retired: Set<string>;
  };
}

async function startFakeUpstream(): Promise<FakeUpstream> {
  const app = express();
  const calls: Recorded[] = [];
  const options = { supportsCimd: false, rotateRefreshToken: true, retired: new Set<string>() };
  const challenges = new Map<string, { challenge: string; clientId: string }>();
  const registrations = new Map<string, { secret?: string }>();
  let accessToken = 'access-1';
  let refreshToken = 'refresh-1';
  let counter = 1;
  let server: ReturnType<express.Express['listen']>;

  const record = (req: express.Request): void => {
    calls.push({ path: req.path, headers: { ...req.headers } as Record<string, string | undefined>, body: { ...req.body } });
  };

  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  const base = (): string => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  app.get('/.well-known/oauth-protected-resource', (req, res) => {
    record(req);
    res.json({ resource: `${base()}/mcp`, authorization_servers: [base()] });
  });

  app.get('/.well-known/oauth-authorization-server', (req, res) => {
    record(req);
    res.json({
      issuer: base(),
      authorization_endpoint: `${base()}/authorize`,
      token_endpoint: `${base()}/token`,
      registration_endpoint: `${base()}/register`,
      revocation_endpoint: `${base()}/revoke`,
      jwks_uri: `${base()}/jwks`,
      response_types_supported: ['code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
      ...(options.supportsCimd ? { client_id_metadata_document_supported: true } : {})
    });
  });

  app.post('/register', (req, res) => {
    record(req);
    const clientId = `dcr-client-${registrations.size + 1}`;
    registrations.set(clientId, {});
    res.status(201).json({
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      registration_access_token: 'rat-1',
      registration_client_uri: `${base()}/register/${clientId}`,
      redirect_uris: req.body.redirect_uris ?? []
    });
  });

  app.delete('/register/:id', (req, res) => {
    record(req);
    res.status(204).end();
  });

  // Stands in for the browser: hands back a code bound to the PKCE challenge.
  app.get('/authorize', (req, res) => {
    record(req);
    const code = `code-${counter++}`;
    challenges.set(code, { challenge: String(req.query.code_challenge), clientId: String(req.query.client_id) });
    res.json({ code, state: req.query.state });
  });

  app.post('/token', (req, res) => {
    record(req);
    const grant = req.body.grant_type;
    if (grant === 'authorization_code') {
      const pending = challenges.get(req.body.code);
      if (!pending) return void res.status(400).json({ error: 'invalid_grant' });
      const digest = crypto.createHash('sha256').update(String(req.body.code_verifier)).digest('base64url');
      if (digest !== pending.challenge) return void res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE mismatch' });
      challenges.delete(req.body.code);
    } else if (grant === 'refresh_token') {
      const presented = String(req.body.refresh_token);
      // Reuse detection, which is what makes an unserialized refresh visible.
      if (options.retired.has(presented)) return void res.status(400).json({ error: 'invalid_grant', error_description: 'reused' });
      if (presented !== refreshToken) return void res.status(400).json({ error: 'invalid_grant' });
      if (options.rotateRefreshToken) {
        options.retired.add(presented);
        refreshToken = `refresh-${++counter}`;
      }
    } else if (grant !== 'client_credentials') {
      return void res.status(400).json({ error: 'unsupported_grant_type' });
    }
    accessToken = `access-${++counter}`;
    res.json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: 3600,
      ...(grant === 'client_credentials' ? {} : { refresh_token: refreshToken })
    });
  });

  app.post('/revoke', (req, res) => {
    record(req);
    res.status(200).end();
  });

  app.all('/mcp', (req, res) => {
    record(req);
    if (req.headers.authorization !== `Bearer ${accessToken}`) {
      res.set('WWW-Authenticate', `Bearer resource_metadata="${base()}/.well-known/oauth-protected-resource"`);
      res.status(401).json({ error: 'invalid_token' });
      return;
    }
    void handleMcpRequest(() => {
      const mcp = new McpServer({ name: 'upstream-fixture', version: '1.0.0' });
      mcp.registerTool('upstream_echo', { description: 'echo', inputSchema: { msg: z.string() } }, async ({ msg }) => ({
        content: [{ type: 'text', text: `upstream:${msg}` }]
      }));
      return mcp.server;
    }, req, res);
  });

  await new Promise<void>(resolve => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server!.address() as AddressInfo).port;
  return {
    port,
    url: `http://127.0.0.1:${port}/mcp`,
    calls,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
    expireAccessToken: () => {
      accessToken = `rotated-${++counter}`;
    },
    reset: () => {
      calls.length = 0;
      challenges.clear();
      registrations.clear();
      options.supportsCimd = false;
      options.rotateRefreshToken = true;
      options.retired.clear();
      accessToken = 'access-1';
      refreshToken = 'refresh-1';
      counter = 1;
    },
    tokenRequests: () => calls.filter(call => call.path === '/token'),
    options
  };
}

let upstream: FakeUpstream;
let tmpDir: string;

async function makeHub(oauth: Record<string, unknown>, extra: Record<string, unknown> = {}, externalUrl = 'http://localhost:3000') {
  const dir = fs.mkdtempSync(path.join(tmpDir, 'hub-'));
  const configPath = path.join(dir, 'mcp.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({ mcpServers: { saas: { type: 'http', url: upstream.url, oauth, ...extra } } })
  );
  const hub = await createHub({
    externalUrl,
    configPath,
    dataPath: path.join(dir, 'data'),
    password: PASSWORD,
    idleTimeoutMinutes: 0
  });
  return { hub, configPath, dataPath: path.join(dir, 'data') };
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-upstream-'));
  upstream = await startFakeUpstream();
}, 30_000);

afterAll(async () => {
  await upstream?.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  upstream.reset();
});

describe('client_credentials', () => {
  it('connects with no operator interaction at all', async () => {
    const { hub } = await makeHub({ mode: 'static', clientId: 'cc-client', clientSecret: 'cc-secret', grant: 'client_credentials' });
    try {
      await hub.supervisor.waitUntilSettled();
      expect(hub.supervisor.get('saas')?.state).toBe('up');

      const token = upstream.tokenRequests().at(0)!;
      expect(token.body.grant_type).toBe('client_credentials');
      // client_secret_basic, so the credential is in the header, not the body.
      expect(token.headers.authorization).toBe(`Basic ${Buffer.from('cc-client:cc-secret').toString('base64')}`);
      expect(token.body.client_secret).toBeUndefined();
    } finally {
      hub.stopMaintenance();
      hub.watcher.stop();
      await hub.supervisor.stop();
    }
  });

  it('never shows the authorization server an upstream token or a configured header', async () => {
    const { hub } = await makeHub(
      { mode: 'static', clientId: 'cc-client', clientSecret: 'cc-secret', grant: 'client_credentials' },
      { headers: { 'X-Tenant': 'super-secret-tenant' } }
    );
    try {
      await hub.supervisor.waitUntilSettled();
      const controlPlane = upstream.calls.filter(call => call.path !== '/mcp');
      expect(controlPlane.length).toBeGreaterThan(0);
      for (const call of controlPlane) {
        expect(JSON.stringify(call.headers)).not.toContain('super-secret-tenant');
        expect(call.headers.authorization ?? '').not.toContain('Bearer access');
      }
      // …while the upstream itself does get the configured header.
      const data = upstream.calls.filter(call => call.path === '/mcp');
      expect(data.some(call => call.headers['x-tenant'] === 'super-secret-tenant')).toBe(true);
    } finally {
      hub.stopMaintenance();
      hub.watcher.stop();
      await hub.supervisor.stop();
    }
  });
});

describe('a server that needs a login', () => {
  it('lands in unauthorized instead of restarting for ever', async () => {
    const { hub } = await makeHub({ mode: 'dcr', grant: 'authorization_code' });
    try {
      await hub.supervisor.waitUntilSettled();
      const server = hub.supervisor.get('saas')!;
      expect(server.state).toBe('unauthorized');
      // The whole point: no backoff loop against an upstream that will keep
      // refusing until a human acts.
      const restarts = server.restarts;
      await new Promise(resolve => setTimeout(resolve, 150));
      expect(server.state).toBe('unauthorized');
      expect(server.restarts).toBe(restarts);
    } finally {
      hub.stopMaintenance();
      hub.watcher.stop();
      await hub.supervisor.stop();
    }
  });

  it('reports 503 rather than hanging a request for the wake timeout', async () => {
    const { hub } = await makeHub({ mode: 'dcr', grant: 'authorization_code' });
    try {
      await hub.supervisor.waitUntilSettled();
      const response = await request(hub.app).post('/saas/mcp').send({ jsonrpc: '2.0', method: 'ping', id: 1 });
      expect(response.status).toBe(401); // no bearer for the hub itself
    } finally {
      hub.stopMaintenance();
      hub.watcher.stop();
      await hub.supervisor.stop();
    }
  });
});

describe('the interactive login', () => {
  it('runs end to end and brings the server up', async () => {
    const { hub, configPath, dataPath } = await makeHub({ mode: 'dcr', grant: 'authorization_code' });
    try {
      await hub.supervisor.waitUntilSettled();
      expect(hub.supervisor.get('saas')?.state).toBe('unauthorized');

      // What `mcp-hub-admin upstream login` does.
      const config = loadConfig(configPath);
      const server = config.get('saas')!;
      const auth = new UpstreamAuth('saas', server as never, hub.store, 'http://localhost:3000/');
      const { authorizationUrl } = await startUpstreamLogin(hub.store, auth);

      const authorizeUrl = new URL(authorizationUrl);
      expect(authorizeUrl.searchParams.get('code_challenge_method')).toBe('S256');
      expect(authorizeUrl.searchParams.get('redirect_uri')).toBe('http://localhost:3000/upstream/callback');
      const state = authorizeUrl.searchParams.get('state')!;

      // Stand in for the browser: collect the code from the upstream.
      const authorized = await fetch(authorizationUrl);
      const { code } = (await authorized.json()) as { code: string };

      const cookie = `mcp_hub_session=${encodeURIComponent(hub.provider.createSessionCookie())}`;
      const callback = await request(hub.app)
        .get('/upstream/callback')
        .set('Cookie', cookie)
        .query({ code, state })
        .expect(200);
      expect(callback.text).toContain('authorized');

      // reauthorize() runs in the background; give it a moment to connect.
      for (let i = 0; i < 40 && hub.supervisor.get('saas')?.state !== 'up'; i++) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      expect(hub.supervisor.get('saas')?.state).toBe('up');

      // The credential really is on disk, and readable by a second process.
      const second = new AuthStore(dataPath);
      expect(second.listUpstreamCredentials().saas?.tokens).toBeDefined();
    } finally {
      hub.stopMaintenance();
      hub.watcher.stop();
      await hub.supervisor.stop();
    }
  }, 30_000);

  it('refuses a callback with a forged state, an unknown state, or no hub session', async () => {
    const { hub, configPath } = await makeHub({ mode: 'dcr', grant: 'authorization_code' });
    try {
      await hub.supervisor.waitUntilSettled();
      const config = loadConfig(configPath);
      const auth = new UpstreamAuth('saas', config.get('saas') as never, hub.store, 'http://localhost:3000/');
      const { authorizationUrl } = await startUpstreamLogin(hub.store, auth);
      const state = new URL(authorizationUrl).searchParams.get('state')!;
      const cookie = `mcp_hub_session=${encodeURIComponent(hub.provider.createSessionCookie())}`;

      // Signed by somebody else.
      const forged = signPayload({ n: 'saas', exp: Date.now() + 60_000 }, 'not-the-hub-secret');
      await request(hub.app).get('/upstream/callback').set('Cookie', cookie).query({ code: 'x', state: forged }).expect(400);

      // Correctly signed but already elapsed.
      const stale = signPayload({ n: 'saas', exp: Date.now() - 1 }, hub.store.cookieSecret);
      await request(hub.app).get('/upstream/callback').set('Cookie', cookie).query({ code: 'x', state: stale }).expect(400);

      // The real state, but from a browser that is not signed in to the hub.
      await request(hub.app).get('/upstream/callback').query({ code: 'x', state }).expect(401);

      // …and the pending login survived all of that, because none of them got
      // far enough to consume it.
      expect(Object.keys(hub.store.listUpstreamLogins()).length).toBe(1);
    } finally {
      hub.stopMaintenance();
      hub.watcher.stop();
      await hub.supervisor.stop();
    }
  }, 30_000);

  it('lets a callback be used only once', async () => {
    const { hub, configPath } = await makeHub({ mode: 'dcr', grant: 'authorization_code' });
    try {
      await hub.supervisor.waitUntilSettled();
      const config = loadConfig(configPath);
      const auth = new UpstreamAuth('saas', config.get('saas') as never, hub.store, 'http://localhost:3000/');
      const { authorizationUrl } = await startUpstreamLogin(hub.store, auth);
      const state = new URL(authorizationUrl).searchParams.get('state')!;
      const { code } = (await (await fetch(authorizationUrl)).json()) as { code: string };
      const cookie = `mcp_hub_session=${encodeURIComponent(hub.provider.createSessionCookie())}`;

      await request(hub.app).get('/upstream/callback').set('Cookie', cookie).query({ code, state }).expect(200);
      // A refreshed browser tab must not redeem the same code again.
      await request(hub.app).get('/upstream/callback').set('Cookie', cookie).query({ code, state }).expect(400);
    } finally {
      hub.stopMaintenance();
      hub.watcher.stop();
      await hub.supervisor.stop();
    }
  }, 30_000);
});

describe('private_key_jwt outbound', () => {
  it('signs an assertion with a key the published document carries', async () => {
    const { hub } = await makeHub(
      { mode: 'cimd', grant: 'client_credentials', clientAuth: 'private_key_jwt', scopes: ['a'] },
      {},
      'https://hub.example'
    );
    try {
      upstream.options.supportsCimd = true;
      const auth = hub.upstreamAuth.get('saas')!;
      await auth.prepare({ force: true });

      const token = upstream.tokenRequests().at(-1)!;
      expect(token.body.grant_type).toBe('client_credentials');
      expect(token.body.client_assertion_type).toBe('urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
      // No shared secret anywhere — that is the point of the mechanism.
      expect(token.body.client_secret).toBeUndefined();
      expect(token.headers.authorization).toBeUndefined();

      // The document the upstream would fetch carries the verifying key…
      const url = clientMetadataUrl('https://hub.example/', 'saas', hub.store.cookieSecret);
      const document = await request(hub.app).get(new URL(url).pathname).expect(200);
      expect(document.body.token_endpoint_auth_method).toBe('private_key_jwt');
      const jwk = document.body.jwks.keys[0];
      expect(jwk.kty).toBe('OKP');

      // …and it really verifies the assertion that was sent.
      const { payload } = await jwtVerify(token.body.client_assertion, await importJWK(jwk, 'EdDSA'), {
        issuer: url,
        subject: url
      });
      expect(payload.jti).toBeTruthy();
      expect(payload.exp! - payload.iat!).toBeLessThanOrEqual(300);
    } finally {
      hub.stopMaintenance();
      hub.watcher.stop();
      await hub.supervisor.stop();
    }
  }, 30_000);

  it('keeps the outbound key separate from the token-signing key', async () => {
    const { hub, dataPath } = await makeHub(
      { mode: 'cimd', grant: 'client_credentials', clientAuth: 'private_key_jwt' },
      {},
      'https://hub.example'
    );
    try {
      upstream.options.supportsCimd = true;
      await hub.upstreamAuth.get('saas')!.prepare({ force: true });
      // One key signs credentials the hub issues, the other proves the hub's
      // identity to a stranger. Sharing one key across both jobs is what this
      // guards against.
      const own = fs.readFileSync(path.join(dataPath, 'jwt-key.pem'), 'utf8');
      const outbound = fs.readFileSync(path.join(dataPath, 'upstream-key.pem'), 'utf8');
      expect(outbound).not.toBe(own);
      expect(fs.statSync(path.join(dataPath, 'upstream-key.pem')).mode & 0o777).toBe(0o600);
    } finally {
      hub.stopMaintenance();
      hub.watcher.stop();
      await hub.supervisor.stop();
    }
  }, 30_000);
});

describe('refreshing', () => {
  /**
   * Drives a full login and hands back the hub's own manager.
   *
   * Deliberately the registry's instance rather than a fresh one: single flight
   * is per manager, and the registry is what guarantees there is exactly one per
   * server. A test that built its own would be measuring two independent
   * managers and would see two refreshes — correctly.
   */
  async function loggedIn(hub: Awaited<ReturnType<typeof createHub>>, configPath: string): Promise<UpstreamAuth> {
    const auth = hub.upstreamAuth.get('saas')!;
    const { authorizationUrl } = await startUpstreamLogin(hub.store, auth);
    const state = new URL(authorizationUrl).searchParams.get('state')!;
    const { code } = (await (await fetch(authorizationUrl)).json()) as { code: string };
    const cookie = `mcp_hub_session=${encodeURIComponent(hub.provider.createSessionCookie())}`;
    await request(hub.app).get('/upstream/callback').set('Cookie', cookie).query({ code, state }).expect(200);
    return auth;
  }

  it('spends the refresh token exactly once when requests collide', async () => {
    const { hub, configPath } = await makeHub({ mode: 'dcr', grant: 'authorization_code' });
    try {
      await hub.supervisor.waitUntilSettled();
      const auth = await loggedIn(hub, configPath);
      // The live connection would react to the expiry on its own and blur the
      // count; this test is about what happens when callers collide.
      await hub.supervisor.stop();

      upstream.expireAccessToken();
      upstream.calls.length = 0;
      const guarded = auth.createFetch();

      // The failure this guards against: the SDK refreshes reactively per 401
      // with no single flight, so five collisions would replay one rotating
      // refresh token five times and the upstream would retire the family.
      const responses = await Promise.all(
        Array.from({ length: 5 }, () =>
          guarded(upstream.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
        )
      );

      expect(upstream.tokenRequests()).toHaveLength(1);
      expect(upstream.tokenRequests()[0].body.grant_type).toBe('refresh_token');
      // Every caller got the retried request, not the 401.
      for (const response of responses) expect(response.status).not.toBe(401);
      // And nothing was replayed, so the upstream never saw a retired token.
      expect(upstream.options.retired.size).toBe(1);
    } finally {
      hub.stopMaintenance();
      hub.watcher.stop();
      await hub.supervisor.stop();
    }
  }, 30_000);

  it('stores the rotated refresh token, so the next refresh also works', async () => {
    const { hub, configPath } = await makeHub({ mode: 'dcr', grant: 'authorization_code' });
    try {
      await hub.supervisor.waitUntilSettled();
      const auth = await loggedIn(hub, configPath);
      const first = (hub.store.getUpstreamCredentials('saas', auth.fingerprint)?.tokens as { refresh_token: string }).refresh_token;

      await auth.prepare({ force: true });
      const second = (hub.store.getUpstreamCredentials('saas', auth.fingerprint)?.tokens as { refresh_token: string }).refresh_token;
      expect(second).not.toBe(first);

      // Proves the stored one is the live one rather than the retired one.
      await expect(auth.prepare({ force: true })).resolves.toBeUndefined();
    } finally {
      hub.stopMaintenance();
      hub.watcher.stop();
      await hub.supervisor.stop();
    }
  }, 30_000);

  it('asks for a login again once the refresh token is refused', async () => {
    const { hub, configPath } = await makeHub({ mode: 'dcr', grant: 'authorization_code' });
    try {
      await hub.supervisor.waitUntilSettled();
      const auth = await loggedIn(hub, configPath);
      // What a replayed or revoked token looks like from the upstream's side.
      const stored = hub.store.getUpstreamCredentials('saas', auth.fingerprint)!;
      upstream.options.retired.add((stored.tokens as { refresh_token: string }).refresh_token);

      await expect(auth.prepare({ force: true })).rejects.toThrow(/refresh failed/);
    } finally {
      hub.stopMaintenance();
      hub.watcher.stop();
      await hub.supervisor.stop();
    }
  }, 30_000);
});

describe('the client identity the hub presents', () => {
  const identity = (oauth: Record<string, unknown>) =>
    ({ serverName: 'saas', serverUrl: 'https://saas.example/mcp', oauth, externalUrl: 'https://hub.example/' }) as never;

  it('describes an interactive client with the callback as its redirect', () => {
    const metadata = hubClientMetadata(identity({ mode: 'dcr', grant: 'authorization_code', scopes: ['a', 'b'] }));
    expect(metadata.redirect_uris).toEqual(['https://hub.example/upstream/callback']);
    expect(metadata.grant_types).toEqual(['authorization_code', 'refresh_token']);
    // The SDK reads the scope from here and nowhere else on the token request.
    expect(metadata.scope).toBe('a b');
  });

  it('describes a machine client with no redirect at all', () => {
    const metadata = hubClientMetadata(identity({ mode: 'static', clientId: 'x', grant: 'client_credentials', scopes: [] }));
    expect(metadata.redirect_uris).toEqual([]);
    expect(metadata.grant_types).toEqual(['client_credentials']);
    expect(metadata.scope).toBeUndefined();
  });

  it('changes fingerprint when the identity moves, but not when a header does', () => {
    const base = { mode: 'dcr', grant: 'authorization_code', scopes: ['a'] };
    const first = credentialFingerprint(identity(base));
    expect(credentialFingerprint(identity({ ...base, scopes: ['a'] }))).toBe(first);
    // Order is not meaning.
    expect(credentialFingerprint(identity({ ...base, scopes: ['a'] }))).toBe(first);
    expect(credentialFingerprint(identity({ ...base, scopes: ['a', 'b'] }))).not.toBe(first);
    expect(credentialFingerprint(identity({ ...base, grant: 'client_credentials' }))).not.toBe(first);
  });
});

describe('the provider handed to the SDK', () => {
  let store: AuthStore;
  const identity = {
    serverName: 'saas',
    serverUrl: 'https://saas.example/mcp',
    oauth: { mode: 'dcr' as const, grant: 'authorization_code' as const, scopes: [] },
    externalUrl: 'https://hub.example/'
  };

  beforeEach(() => {
    store = new AuthStore(fs.mkdtempSync(path.join(tmpDir, 'store-')));
  });

  it('withholds the refresh token from the SDK', () => {
    const provider = new UpstreamAuthProvider(identity, store);
    provider.saveTokens({ access_token: 'a', token_type: 'Bearer', refresh_token: 'r', expires_in: 60 } as never);
    // The SDK would otherwise refresh reactively, unserialized, on every 401.
    expect(provider.tokens()).toMatchObject({ access_token: 'a' });
    expect(provider.tokens()?.refresh_token).toBeUndefined();
    expect(provider.storedTokens()?.refresh_token).toBe('r');
  });

  it('keeps the RFC 7592 credentials a dynamic registration hands back', () => {
    const provider = new UpstreamAuthProvider(identity, store);
    provider.saveClientInformation({
      client_id: 'c1',
      client_secret: 's1',
      registration_access_token: 'rat',
      registration_client_uri: 'https://as.example/register/c1'
    } as never);
    expect(provider.clientInformation()).toEqual({ client_id: 'c1', client_secret: 's1' });
    const record = store.listUpstreamCredentials().saas;
    expect(record.registrationAccessToken).toBe('rat');
    expect(record.registrationClientUri).toBe('https://as.example/register/c1');
  });

  it('prefers configured credentials over anything stored', () => {
    const staticIdentity = { ...identity, oauth: { mode: 'static' as const, grant: 'client_credentials' as const, clientId: 'cfg', clientSecret: 'sec', scopes: [] } };
    const provider = new UpstreamAuthProvider(staticIdentity, store);
    provider.saveClientInformation({ client_id: 'ignored' } as never);
    expect(provider.clientInformation()).toEqual({ client_id: 'cfg', client_secret: 'sec' });
  });

  it('only offers a metadata document URL in cimd mode', () => {
    expect(new UpstreamAuthProvider(identity, store).clientMetadataUrl).toBeUndefined();
    const cimd = { ...identity, oauth: { ...identity.oauth, mode: 'cimd' as const } };
    expect(new UpstreamAuthProvider(cimd, store).clientMetadataUrl).toBe(
      clientMetadataUrl('https://hub.example/', 'saas', store.cookieSecret)
    );
  });

  it('has no redirect URL for the non-interactive grant, which is what selects it', () => {
    const machine = { ...identity, oauth: { ...identity.oauth, grant: 'client_credentials' as const } };
    expect(new UpstreamAuthProvider(machine, store).redirectUrl).toBeUndefined();
    expect(new UpstreamAuthProvider(identity, store).redirectUrl).toBe('https://hub.example/upstream/callback');
  });

  it('clears the right things for each invalidation scope', () => {
    const provider = new UpstreamAuthProvider(identity, store);
    provider.saveClientInformation({ client_id: 'c1', client_secret: 's1' } as never);
    provider.saveTokens({ access_token: 'a', token_type: 'Bearer', refresh_token: 'r' } as never);

    provider.invalidateCredentials('tokens');
    expect(provider.storedTokens()).toBeUndefined();
    expect(provider.clientInformation()).toEqual({ client_id: 'c1', client_secret: 's1' });

    provider.invalidateCredentials('client');
    expect(provider.clientInformation()).toBeUndefined();

    provider.saveTokens({ access_token: 'a2', token_type: 'Bearer' } as never);
    provider.invalidateCredentials('all');
    expect(store.listUpstreamCredentials().saas).toBeUndefined();
  });

  it('replaces rather than merges a record from a superseded configuration', () => {
    new UpstreamAuthProvider(identity, store).saveTokens({ access_token: 'old', token_type: 'Bearer' } as never);
    const moved = { ...identity, oauth: { ...identity.oauth, scopes: ['new-scope'] } };
    const provider = new UpstreamAuthProvider(moved, store);
    // The old tokens describe an identity the upstream no longer knows.
    expect(provider.storedTokens()).toBeUndefined();
    provider.saveClientInformation({ client_id: 'fresh' } as never);
    expect(store.listUpstreamCredentials().saas.tokens).toBeUndefined();
  });
});

describe('the CIMD document the hub publishes', () => {
  it('is not served when no upstream uses that mode', async () => {
    const { hub } = await makeHub({ mode: 'dcr', grant: 'authorization_code' });
    try {
      await hub.supervisor.waitUntilSettled();
      const id = clientDocumentId('saas', hub.store.cookieSecret);
      await request(hub.app).get(`/.well-known/mcp-hub-client/${id}.json`).expect(404);
    } finally {
      hub.stopMaintenance();
      hub.watcher.stop();
      await hub.supervisor.stop();
    }
  });

  it('names itself byte-for-byte when one does', async () => {
    // cimd needs an https issuer, because the upstream fetches the document.
    const { hub } = await makeHub({ mode: 'cimd', grant: 'authorization_code', scopes: ['read'] }, {}, 'https://hub.example');
    try {
      await hub.supervisor.waitUntilSettled();
      const url = clientMetadataUrl('https://hub.example/', 'saas', hub.store.cookieSecret);
      const document = await request(hub.app).get(new URL(url).pathname).expect(200);
      // An authorization server refuses a document whose client_id is not the
      // URL it was fetched from.
      expect(document.body.client_id).toBe(url);
      // The path must not give away the server's name.
      expect(new URL(url).pathname).not.toContain('saas');
      expect(document.body.redirect_uris).toEqual(['https://hub.example/upstream/callback']);
      expect(document.body.scope).toBe('read');
    } finally {
      hub.stopMaintenance();
      hub.watcher.stop();
      await hub.supervisor.stop();
    }
  });

  it('gives two upstreams two documents, so their scopes cannot be confused', async () => {
    // The bug this guards: one shared document meant the second server was
    // registered with the first server's scopes.
    const dir = fs.mkdtempSync(path.join(tmpDir, 'two-cimd-'));
    const configPath = path.join(dir, 'mcp.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          alpha: { type: 'http', url: upstream.url, oauth: { mode: 'cimd', grant: 'authorization_code', scopes: ['alpha.read'] } },
          beta: { type: 'http', url: upstream.url, oauth: { mode: 'cimd', grant: 'authorization_code', scopes: ['beta.write'] } }
        }
      })
    );
    const hub = await createHub({
      externalUrl: 'https://hub.example',
      configPath,
      dataPath: path.join(dir, 'data'),
      password: PASSWORD,
      idleTimeoutMinutes: 0
    });
    try {
      await hub.supervisor.waitUntilSettled();
      const alpha = clientMetadataUrl('https://hub.example/', 'alpha', hub.store.cookieSecret);
      const beta = clientMetadataUrl('https://hub.example/', 'beta', hub.store.cookieSecret);
      expect(alpha).not.toBe(beta);

      const a = await request(hub.app).get(new URL(alpha).pathname).expect(200);
      const b = await request(hub.app).get(new URL(beta).pathname).expect(200);
      expect(a.body.scope).toBe('alpha.read');
      expect(b.body.scope).toBe('beta.write');
      expect(a.body.client_id).toBe(alpha);
      expect(b.body.client_id).toBe(beta);

      // An identifier nobody publishes is simply not there.
      await request(hub.app).get('/.well-known/mcp-hub-client/nothing.json').expect(404);
    } finally {
      hub.stopMaintenance();
      hub.watcher.stop();
      await hub.supervisor.stop();
    }
  }, 30_000);

  it('refuses cimd behind a plain-http issuer at boot', async () => {
    // The upstream has to fetch the document over https; failing here beats
    // failing at the first login.
    await expect(makeHub({ mode: 'cimd', grant: 'authorization_code' }, {}, 'http://localhost:3000')).rejects.toThrow(/https EXTERNAL_URL/);
  });
});

describe('operator-facing errors', () => {
  it('explains why a server cannot be used', async () => {
    const { hub, configPath } = await makeHub({ mode: 'dcr', grant: 'authorization_code' });
    try {
      const config = loadConfig(configPath);
      expect(() => requireOAuthServer(config, 'nope')).toThrow(/Unknown server/);
      expect(() => upstreamStatus(hub.store, config, 'nope')).toThrow(/Unknown server/);
    } finally {
      hub.stopMaintenance();
      hub.watcher.stop();
      await hub.supervisor.stop();
    }
  });

  it('refuses to start a browser login for a machine grant', async () => {
    const { hub } = await makeHub({ mode: 'static', clientId: 'c', clientSecret: 's', grant: 'client_credentials' });
    try {
      await hub.supervisor.waitUntilSettled();
      await expect(startUpstreamLogin(hub.store, hub.upstreamAuth.get('saas')!)).rejects.toThrow(/needs no browser/);
    } finally {
      hub.stopMaintenance();
      hub.watcher.stop();
      await hub.supervisor.stop();
    }
  });

  it('says so when the upstream does not accept metadata documents', async () => {
    const { hub } = await makeHub({ mode: 'cimd', grant: 'authorization_code' }, {}, 'https://hub.example');
    try {
      const auth = hub.upstreamAuth.get('saas')!;
      // The fixture advertises no support, so cimd cannot work against it.
      await expect(auth.prepare({ force: true })).rejects.toThrow(/does not accept client ID metadata documents/);
    } finally {
      hub.stopMaintenance();
      hub.watcher.stop();
      await hub.supervisor.stop();
    }
  });
});

describe('more operator-facing errors', () => {
  it('refuses a server that is not remote, and one without an oauth block', async () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'mixed-'));
    const configPath = path.join(dir, 'mcp.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          local: { command: '/bin/false' },
          plain: { type: 'http', url: upstream.url }
        }
      })
    );
    const config = loadConfig(configPath);
    expect(() => requireOAuthServer(config, 'local')).toThrow(/not a remote server/);
    expect(() => requireOAuthServer(config, 'plain')).toThrow(/no "oauth" block/);
  });

  it('reports an expired access token and a superseded record distinctly', async () => {
    const { hub, configPath } = await makeHub({ mode: 'dcr', grant: 'authorization_code' });
    try {
      await hub.supervisor.waitUntilSettled();
      const auth = hub.upstreamAuth.get('saas')!;
      const provider = auth.provider();
      provider.saveTokens({ access_token: 'a', token_type: 'Bearer', expires_in: -10 } as never);
      expect(upstreamStatus(hub.store, loadConfig(configPath))[0].state).toBe('expired');

      // A record left behind by a configuration that has since moved on.
      hub.store.updateUpstreamCredentials('saas', current => ({ ...current!, fingerprint: 'from-an-older-config' }));
      expect(upstreamStatus(hub.store, loadConfig(configPath))[0].state).toBe('stale');
    } finally {
      hub.stopMaintenance();
      hub.watcher.stop();
      await hub.supervisor.stop();
    }
  });
});

describe('a callback the upstream turned down', () => {
  it('reports the refusal and leaves the server alone', async () => {
    const { hub } = await makeHub({ mode: 'dcr', grant: 'authorization_code' });
    try {
      await hub.supervisor.waitUntilSettled();
      const auth = hub.upstreamAuth.get('saas')!;
      const { authorizationUrl } = await startUpstreamLogin(hub.store, auth);
      const state = new URL(authorizationUrl).searchParams.get('state')!;
      const cookie = `mcp_hub_session=${encodeURIComponent(hub.provider.createSessionCookie())}`;

      const denied = await request(hub.app)
        .get('/upstream/callback')
        .set('Cookie', cookie)
        .query({ error: 'access_denied', state })
        .expect(400);
      expect(denied.text).toContain('access_denied');
      expect(hub.supervisor.get('saas')?.state).toBe('unauthorized');
      // Nothing was stored, and the one-shot record is gone either way.
      expect(hub.store.listUpstreamCredentials().saas?.tokens).toBeUndefined();
    } finally {
      hub.stopMaintenance();
      hub.watcher.stop();
      await hub.supervisor.stop();
    }
  }, 30_000);

  it('refuses a callback that carries no code at all', async () => {
    const { hub } = await makeHub({ mode: 'dcr', grant: 'authorization_code' });
    try {
      await hub.supervisor.waitUntilSettled();
      const { authorizationUrl } = await startUpstreamLogin(hub.store, hub.upstreamAuth.get('saas')!);
      const state = new URL(authorizationUrl).searchParams.get('state')!;
      const cookie = `mcp_hub_session=${encodeURIComponent(hub.provider.createSessionCookie())}`;
      await request(hub.app).get('/upstream/callback').set('Cookie', cookie).query({ state }).expect(400);
    } finally {
      hub.stopMaintenance();
      hub.watcher.stop();
      await hub.supervisor.stop();
    }
  }, 30_000);
});

describe('logging out', () => {
  it('revokes at the upstream and deletes the dynamic registration', async () => {
    const { hub, configPath } = await makeHub({ mode: 'dcr', grant: 'authorization_code' });
    try {
      await hub.supervisor.waitUntilSettled();
      const auth = hub.upstreamAuth.get('saas')!;
      const { authorizationUrl } = await startUpstreamLogin(hub.store, auth);
      const state = new URL(authorizationUrl).searchParams.get('state')!;
      const { code } = (await (await fetch(authorizationUrl)).json()) as { code: string };
      const cookie = `mcp_hub_session=${encodeURIComponent(hub.provider.createSessionCookie())}`;
      await request(hub.app).get('/upstream/callback').set('Cookie', cookie).query({ code, state }).expect(200);
      upstream.calls.length = 0;

      const problems = await auth.revokeRemotely();
      expect(problems).toEqual([]);
      expect(upstream.calls.map(call => call.path)).toContain('/revoke');
      expect(upstream.calls.some(call => call.path.startsWith('/register/'))).toBe(true);

      expect(hub.store.forgetUpstreamCredentials('saas')).toBe(true);
      expect(hub.store.listUpstreamCredentials().saas).toBeUndefined();
      expect(loadConfig(configPath).get('saas')).toBeDefined();
    } finally {
      hub.stopMaintenance();
      hub.watcher.stop();
      await hub.supervisor.stop();
    }
  }, 30_000);
});

describe('status reporting', () => {
  it('describes what the operator has to do next', async () => {
    const { hub, configPath } = await makeHub({ mode: 'dcr', grant: 'authorization_code', scopes: ['a', 'b'] });
    try {
      await hub.supervisor.waitUntilSettled();
      const rows = upstreamStatus(hub.store, loadConfig(configPath));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ server: 'saas', mode: 'dcr', grant: 'authorization_code', state: 'login_required' });
      expect(rows[0].scopes).toEqual(['a', 'b']);
    } finally {
      hub.stopMaintenance();
      hub.watcher.stop();
      await hub.supervisor.stop();
    }
  });
});
