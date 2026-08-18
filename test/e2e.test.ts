import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { Response } from 'express';
import { createHub } from '../src/index.js';
import { handleMcpRequest } from '../src/proxy.js';
import type { ManagedServer } from '../src/supervisor.js';

const EVERYTHING = path.resolve('node_modules/@modelcontextprotocol/server-everything/dist/index.js');
const PASSWORD = 'test-password';
const REDIRECT_URI = 'http://localhost:33418/callback';

let tmpDir: string;
let hub: Awaited<ReturnType<typeof createHub>>;
let httpServer: ReturnType<Awaited<ReturnType<typeof createHub>>['app']['listen']>;
let baseUrl: string;
let accessToken: string;
let refreshToken: string;

function pkcePair() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

async function obtainToken(
  app: Express.Application,
  resource?: string,
  displayedResource = resource // the login page shows the canonical form
): Promise<{ access: string; refresh: string; clientId: string }> {
  const registration = await request(app)
    .post('/register')
    .send({ redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: 'none', client_name: 'vitest' })
    .expect(201);
  const clientId = registration.body.client_id as string;

  const { verifier, challenge } = pkcePair();
  const authorize = await request(app)
    .get('/authorize')
    .query({
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'xyz',
      ...(resource ? { resource } : {})
    })
    .expect(200);
  const requestToken = authorize.text.match(/name="request" value="([^"]+)"/)?.[1];
  expect(requestToken).toBeDefined();
  if (displayedResource) expect(authorize.text).toContain(displayedResource);

  const login = await request(app).post('/login').type('form').send({ password: PASSWORD, request: requestToken }).expect(302);
  const location = new URL(login.headers.location);
  expect(location.searchParams.get('state')).toBe('xyz');
  const code = location.searchParams.get('code')!;

  const tokens = await request(app)
    .post('/token')
    .type('form')
    .send({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      ...(resource ? { resource } : {})
    })
    .expect(200);
  expect(tokens.body.expires_in).toBe(15 * 60);
  return { access: tokens.body.access_token, refresh: tokens.body.refresh_token, clientId };
}

async function registerClient(clientName: string, redirectUris: string[] = [REDIRECT_URI]): Promise<string> {
  const registration = await request(hub.app)
    .post('/register')
    .send({ redirect_uris: redirectUris, token_endpoint_auth_method: 'none', client_name: clientName })
    .expect(201);
  return registration.body.client_id as string;
}

function sessionCookie(): string {
  return `mcp_hub_session=${encodeURIComponent(hub.provider.createSessionCookie())}`;
}

function authorizeWithSession(clientId: string, cookie: string, redirectUri: string = REDIRECT_URI) {
  const { challenge } = pkcePair();
  return request(hub.app)
    .get('/authorize')
    .set('Cookie', cookie)
    .query({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'xyz'
    });
}

function consentFields(html: string): { request?: string; csrf?: string } {
  return {
    request: html.match(/name="request" value="([^"]+)"/)?.[1],
    csrf: html.match(/name="csrf" value="([^"]+)"/)?.[1]
  };
}

async function mcpClient(pathname: string, token: string): Promise<Client> {
  const client = new Client({ name: 'vitest', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}${pathname}`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } }
  });
  await client.connect(transport);
  return client;
}

let upstreamServer: ReturnType<express.Express['listen']>;

/** Remote upstream fixture: rejects requests without the configured bearer,
 * proving that mcp-hub injects headers on every request. */
function startRemoteUpstream(): Promise<number> {
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.all('/mcp', (req, res) => {
    if (req.headers.authorization !== 'Bearer remote-secret') {
      res.status(401).json({ error: 'missing upstream auth' });
      return;
    }
    void handleMcpRequest(() => {
      const server = new McpServer({ name: 'remote-fixture', version: '1.0.0' });
      server.registerTool(
        'remote_echo',
        { description: 'echo back', inputSchema: { msg: z.string() } },
        async ({ msg }) => ({ content: [{ type: 'text', text: `remote:${msg}` }] })
      );
      return server.server;
    }, req, res);
  });
  return new Promise(resolve => {
    upstreamServer = app.listen(0, () => resolve((upstreamServer.address() as AddressInfo).port));
  });
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-test-'));
  const upstreamPort = await startRemoteUpstream();
  process.env.REMOTE_SECRET = 'remote-secret';
  const configPath = path.join(tmpDir, 'mcp.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      mcpServers: {
        everything: { command: process.execPath, args: [EVERYTHING] },
        hidden: { command: process.execPath, args: [EVERYTHING], hub: false },
        broken: { command: '/bin/false' },
        remote: {
          type: 'http',
          url: `http://127.0.0.1:${upstreamPort}/mcp`,
          headers: { Authorization: 'Bearer ${REMOTE_SECRET}' }
        }
      }
    })
  );
  hub = await createHub({
    externalUrl: 'http://localhost:3000',
    configPath,
    dataPath: path.join(tmpDir, 'data'),
    password: PASSWORD,
    // Deliberately the pre-0.5 migration mode. One unbound token reaches /hub,
    // /health and every server, which is what lets the suite below share a
    // single token — and it keeps that legacy path under test. The default
    // (bound) behaviour has its own suite further down.
    requireResourceBoundTokens: false
  });
  await hub.supervisor.waitUntilSettled();
  httpServer = hub.app.listen(0);
  baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  const tokens = await obtainToken(hub.app);
  accessToken = tokens.access;
  refreshToken = tokens.refresh;
}, 30_000);

afterAll(async () => {
  httpServer?.close();
  upstreamServer?.close();
  hub?.watcher.stop();
  await hub?.supervisor.stop();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('OAuth', () => {
  it('serves AS metadata at root and path-scoped PRM documents', async () => {
    const as = await request(hub.app).get('/.well-known/oauth-authorization-server').expect(200);
    expect(as.body.issuer).toBe('http://localhost:3000/');
    expect(as.body.registration_endpoint).toContain('/register');

    const prm = await request(hub.app).get('/.well-known/oauth-protected-resource/everything/mcp').expect(200);
    expect(prm.body.resource).toBe('http://localhost:3000/everything/mcp');
    expect(prm.body.authorization_servers).toEqual(['http://localhost:3000/']);

    await request(hub.app).get('/.well-known/oauth-authorization-server/everything/mcp').expect(200);
  });

  it('sets anti-clickjacking and browser hardening headers on interactive auth pages', async () => {
    const clientId = await registerClient('headers');
    const response = await authorizeWithSession(clientId, sessionCookie()).expect(200);
    expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(response.headers['content-security-policy']).toContain("form-action 'self'");
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
  });

  it('rejects a wrong password and logs the attempt', async () => {
    const registration = await request(hub.app)
      .post('/register')
      .send({ redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: 'none' })
      .expect(201);
    const { challenge } = pkcePair();
    const authorize = await request(hub.app)
      .get('/authorize')
      .query({
        client_id: registration.body.client_id,
        redirect_uri: REDIRECT_URI,
        response_type: 'code',
        code_challenge: challenge,
        code_challenge_method: 'S256'
      })
      .expect(200);
    const requestToken = authorize.text.match(/name="request" value="([^"]+)"/)?.[1];
    await request(hub.app).post('/login').type('form').send({ password: 'nope', request: requestToken }).expect(401);
  });

  it('never issues a code to an unapproved client, even with a valid session', async () => {
    // The drive-by: a page registers its own client and walks a signed-in
    // user through /authorize. A code here would be a full-access token.
    const clientId = await registerClient('drive-by');
    const response = await authorizeWithSession(clientId, sessionCookie()).expect(200);
    expect(response.headers.location).toBeUndefined();
    expect(response.text).toContain('Authorize access?');
    expect(response.text).toContain(REDIRECT_URI); // the user gets to see where codes would go
  });

  it('issues codes silently once the client is approved', async () => {
    const clientId = await registerClient('approved');
    const cookie = sessionCookie();
    const consent = await authorizeWithSession(clientId, cookie).expect(200);
    const { request: token, csrf } = consentFields(consent.text);

    const approved = await request(hub.app)
      .post('/consent')
      .set('Cookie', cookie)
      .type('form')
      .send({ request: token, csrf, action: 'approve' })
      .expect(302);
    const location = new URL(approved.headers.location);
    expect(location.searchParams.get('code')).toBeTruthy();
    expect(location.searchParams.get('state')).toBe('xyz');

    const again = await authorizeWithSession(clientId, sessionCookie()).expect(302);
    expect(new URL(again.headers.location).searchParams.get('code')).toBeTruthy();
  });

  it('redirects with access_denied when consent is refused', async () => {
    const clientId = await registerClient('denied');
    const cookie = sessionCookie();
    const consent = await authorizeWithSession(clientId, cookie).expect(200);
    const { request: token, csrf } = consentFields(consent.text);

    const denied = await request(hub.app)
      .post('/consent')
      .set('Cookie', cookie)
      .type('form')
      .send({ request: token, csrf, action: 'deny' })
      .expect(302);
    const location = new URL(denied.headers.location);
    expect(location.searchParams.get('error')).toBe('access_denied');
    expect(location.searchParams.get('state')).toBe('xyz');
    expect(location.searchParams.get('code')).toBeNull();

    await authorizeWithSession(clientId, sessionCookie()).expect(200); // still unapproved
  });

  it('rejects consent without a session or with a bad CSRF token', async () => {
    const clientId = await registerClient('csrf');
    const cookie = sessionCookie();
    const consent = await authorizeWithSession(clientId, cookie).expect(200);
    const { request: token, csrf } = consentFields(consent.text);

    await request(hub.app).post('/consent').type('form').send({ request: token, csrf, action: 'approve' }).expect(401);
    await request(hub.app)
      .post('/consent')
      .set('Cookie', cookie)
      .type('form')
      .send({ request: token, csrf: 'wrong', action: 'approve' })
      .expect(403);
  });

  it('treats a successful password login as consent for that client', async () => {
    const clientId = await registerClient('password-consent');
    const { challenge } = pkcePair();
    const authorize = await request(hub.app)
      .get('/authorize')
      .query({
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        response_type: 'code',
        code_challenge: challenge,
        code_challenge_method: 'S256'
      })
      .expect(200);
    const token = authorize.text.match(/name="request" value="([^"]+)"/)?.[1];
    await request(hub.app).post('/login').type('form').send({ password: PASSWORD, request: token }).expect(302);

    await authorizeWithSession(clientId, sessionCookie()).expect(302); // no second prompt
  });

  it('binds the approval to the redirect target, ignoring the loopback port', async () => {
    const approvedUri = 'http://localhost:33418/callback';
    const clientId = await registerClient('loopback', [approvedUri, 'http://localhost:44000/other']);
    const cookie = sessionCookie();
    const consent = await authorizeWithSession(clientId, cookie, approvedUri).expect(200);
    const { request: token, csrf } = consentFields(consent.text);
    await request(hub.app)
      .post('/consent')
      .set('Cookie', cookie)
      .type('form')
      .send({ request: token, csrf, action: 'approve' })
      .expect(302);

    // same target on another port — RFC 8252 says that is the same client
    await authorizeWithSession(clientId, sessionCookie(), 'http://localhost:51234/callback').expect(302);
    // a different path is a different target and needs its own approval
    await authorizeWithSession(clientId, sessionCookie(), 'http://localhost:44000/other').expect(200);
  });

  it('rotates refresh tokens', async () => {
    const registration = await request(hub.app).get('/.well-known/oauth-authorization-server').expect(200);
    expect(registration.body.grant_types_supported).toContain('refresh_token');
    const clientId = JSON.parse(fs.readFileSync(path.join(tmpDir, 'data', 'state.json'), 'utf8'));
    const firstClient = Object.keys(clientId.clients)[0];
    const refreshed = await request(hub.app)
      .post('/token')
      .type('form')
      .send({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: firstClient })
      .expect(200);
    expect(refreshed.body.access_token).toBeTruthy();
    // the old refresh token is now invalid (rotation)
    await request(hub.app)
      .post('/token')
      .type('form')
      .send({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: firstClient })
      .expect(400);
    refreshToken = refreshed.body.refresh_token;
  });

  it('rejects a refresh that asks for more scope than was granted', async () => {
    const tokens = await obtainToken(hub.app);
    await request(hub.app)
      .post('/token')
      .type('form')
      .send({ grant_type: 'refresh_token', refresh_token: tokens.refresh, client_id: tokens.clientId, scope: 'admin' })
      .expect(400);
  });

  it('revokes the whole token family when a rotated refresh token is replayed', async () => {
    const tokens = await obtainToken(hub.app);
    const rotated = await request(hub.app)
      .post('/token')
      .type('form')
      .send({ grant_type: 'refresh_token', refresh_token: tokens.refresh, client_id: tokens.clientId })
      .expect(200);
    const successor = rotated.body.refresh_token as string;

    // replaying the consumed token means the chain leaked
    await request(hub.app)
      .post('/token')
      .type('form')
      .send({ grant_type: 'refresh_token', refresh_token: tokens.refresh, client_id: tokens.clientId })
      .expect(400);

    // so the successor must be dead too
    await request(hub.app)
      .post('/token')
      .type('form')
      .send({ grant_type: 'refresh_token', refresh_token: successor, client_id: tokens.clientId })
      .expect(400);
  });

  it('rejects MCP requests without a token, with WWW-Authenticate pointing at the PRM', async () => {
    const response = await request(hub.app)
      .post('/everything/mcp')
      .send({ jsonrpc: '2.0', method: 'ping', id: 1 })
      .expect(401);
    expect(response.headers['www-authenticate']).toContain('/.well-known/oauth-protected-resource/everything/mcp');
  });

  it('rejects a garbage bearer token', async () => {
    await request(hub.app)
      .post('/everything/mcp')
      .set('Authorization', 'Bearer nonsense')
      .send({ jsonrpc: '2.0', method: 'ping', id: 1 })
      .expect(401);
  });

  it('binds an RFC 8707 token to one canonical MCP resource', async () => {
    const tokens = await obtainToken(hub.app, 'http://localhost:3000/everything');
    const client = await mcpClient('/everything/mcp', tokens.access);
    await client.listTools();
    await client.close();

    await request(hub.app)
      .post('/hidden/mcp')
      .set('Authorization', `Bearer ${tokens.access}`)
      .send({ jsonrpc: '2.0', method: 'ping', id: 1 })
      .expect(401);

    await request(hub.app)
      .post('/token')
      .type('form')
      .send({
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh,
        client_id: tokens.clientId,
        resource: 'http://localhost:3000/hidden/mcp'
      })
      .expect(400);
  });

  it('canonicalizes the /hub/mcp resource to /hub', async () => {
    const tokens = await obtainToken(hub.app, 'http://localhost:3000/hub/mcp', 'http://localhost:3000/hub');
    const client = await mcpClient('/hub/mcp', tokens.access);
    await client.listTools();
    await client.close();
  });

  it('can require a resource indicator for every newly issued token', async () => {
    const isolatedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-resource-'));
    const configPath = path.join(isolatedDir, 'mcp.json');
    fs.writeFileSync(configPath, JSON.stringify({ mcpServers: {} }));
    const isolated = await createHub({
      externalUrl: 'http://localhost:3000',
      configPath,
      dataPath: path.join(isolatedDir, 'data'),
      password: PASSWORD,
      requireResourceBoundTokens: true
    });
    try {
      const registration = await request(isolated.app)
        .post('/register')
        .send({ redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: 'none' })
        .expect(201);
      const { challenge } = pkcePair();
      const response = await request(isolated.app)
        .get('/authorize')
        .query({
          client_id: registration.body.client_id,
          redirect_uri: REDIRECT_URI,
          response_type: 'code',
          code_challenge: challenge,
          code_challenge_method: 'S256'
        })
        .expect(302);
      expect(new URL(response.headers.location).searchParams.get('error')).toBe('invalid_target');
    } finally {
      isolated.watcher.stop();
      await isolated.supervisor.stop();
      fs.rmSync(isolatedDir, { recursive: true, force: true });
    }
  });

  it('revokes a client access token and every refresh token immediately', async () => {
    const tokens = await obtainToken(hub.app);
    hub.store.revokeClientAccess(tokens.clientId);

    await request(hub.app)
      .post('/everything/mcp')
      .set('Authorization', `Bearer ${tokens.access}`)
      .send({ jsonrpc: '2.0', method: 'ping', id: 1 })
      .expect(401);
    await request(hub.app)
      .post('/token')
      .type('form')
      .send({ grant_type: 'refresh_token', refresh_token: tokens.refresh, client_id: tokens.clientId })
      .expect(400);
  });

  it('authenticates before parsing an oversized MCP body', async () => {
    const oversized = JSON.stringify({ value: 'x'.repeat(1_100_000) });
    await request(hub.app).post('/everything/mcp').set('Content-Type', 'application/json').send(oversized).expect(401);
    await request(hub.app)
      .post('/everything/mcp')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Content-Type', 'application/json')
      .send(oversized)
      .expect(413);
  });
});

describe('per-server proxy', () => {
  it('proxies initialize/tools/call to the child (both /<name> and /<name>/mcp)', async () => {
    for (const pathname of ['/everything', '/everything/mcp']) {
      const client = await mcpClient(pathname, accessToken);
      const tools = await client.listTools();
      expect(tools.tools.map(t => t.name)).toContain('echo');
      const result = (await client.callTool({ name: 'echo', arguments: { message: 'hallo' } })) as CallToolResult;
      expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('hallo') });
      await client.close();
    }
  });

  it('returns 503 for a server whose child is down', async () => {
    await request(hub.app)
      .post('/broken/mcp')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '0' } }, id: 1 })
      .expect(503);
  });

  it('proxies a remote http upstream with injected auth headers', async () => {
    const client = await mcpClient('/remote/mcp', accessToken);
    const tools = await client.listTools();
    expect(tools.tools.map(t => t.name)).toEqual(['remote_echo']);
    const result = (await client.callTool({ name: 'remote_echo', arguments: { msg: 'hi' } })) as CallToolResult;
    expect(result.content[0]).toMatchObject({ type: 'text', text: 'remote:hi' });
    await client.close();
  });

  it('exposes the remote upstream through /hub like any other server', async () => {
    const client = await mcpClient('/hub', accessToken);
    const result = (await client.callTool({
      name: 'call_tool',
      arguments: { server: 'remote', tool: 'remote_echo', arguments: { msg: 'via hub' } }
    })) as CallToolResult;
    expect((result.content[0] as { text: string }).text).toBe('remote:via hub');
    await client.close();
  });

  it('returns 404 for unknown servers', async () => {
    await request(hub.app)
      .post('/doesnotexist/mcp')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ jsonrpc: '2.0', method: 'ping', id: 1 })
      .expect(404);
  });

  /**
   * The proxy used to hand the child's capabilities straight to the client.
   * server-everything advertises resources.subscribe and implements it, but the
   * proxy registers no Subscribe handler, so a client that believed the
   * advertisement got -32601 at call time. Announce only what we serve.
   */
  it('does not advertise resource subscriptions it cannot serve', async () => {
    const client = await mcpClient('/everything/mcp', accessToken);
    const caps = client.getServerCapabilities();

    expect(caps?.resources).toBeDefined();
    expect(caps?.resources?.subscribe).toBeUndefined();

    // Only the key is gone, not the capability: list and read still work.
    const resources = await client.listResources();
    expect(resources.resources.length).toBeGreaterThan(0);

    await client.close();
  });

  it('refuses a subscribe request, which is why it is no longer advertised', async () => {
    const response = await request(hub.app)
      .post('/everything/mcp')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', method: 'resources/subscribe', params: { uri: 'test://static/resource/1' }, id: 1 })
      .expect(200);
    expect(response.body.error?.code).toBe(-32601);
  });
});

describe('/hub aggregate', () => {
  it('exposes exactly the four meta-tools', async () => {
    const client = await mcpClient('/hub', accessToken);
    const tools = await client.listTools();
    expect(tools.tools.map(t => t.name).sort()).toEqual(['call_tool', 'get_tool_schema', 'list_servers', 'list_tools']);
    await client.close();
  });

  it('walks the list_servers -> list_tools -> get_tool_schema -> call_tool flow', async () => {
    const client = await mcpClient('/hub', accessToken);

    const servers = (await client.callTool({ name: 'list_servers', arguments: {} })) as CallToolResult;
    const serverList = JSON.parse((servers.content[0] as { text: string }).text) as Array<{ name: string; status: string }>;
    expect(serverList.map(s => s.name)).toContain('everything');
    expect(serverList.map(s => s.name)).not.toContain('hidden'); // hub: false
    expect(serverList.find(s => s.name === 'broken')?.status).not.toBe('up');

    const tools = (await client.callTool({ name: 'list_tools', arguments: { server: 'everything' } })) as CallToolResult;
    expect((tools.content[0] as { text: string }).text).toContain('echo');

    const schema = (await client.callTool({ name: 'get_tool_schema', arguments: { server: 'everything', tool: 'echo' } })) as CallToolResult;
    const parsed = JSON.parse((schema.content[0] as { text: string }).text);
    expect(parsed.inputSchema.properties.message).toBeDefined();

    const result = (await client.callTool({
      name: 'call_tool',
      arguments: { server: 'everything', tool: 'echo', arguments: { message: 'via hub' } }
    })) as CallToolResult;
    expect((result.content[0] as { text: string }).text).toContain('via hub');

    const hidden = (await client.callTool({ name: 'call_tool', arguments: { server: 'hidden', tool: 'echo', arguments: { message: 'x' } } })) as CallToolResult;
    expect(hidden.isError).toBe(true);

    await client.close();
  });
});

describe('supervisor', () => {
  it('marks the broken server down and schedules restarts', () => {
    const broken = hub.supervisor.get('broken')!;
    // Not `toBe('down')`: scheduling the restart is the point, so the state
    // flips back to 'starting' for each attempt and this assertion would race
    // the backoff timer — which it lost on a slow CI runner. What must never
    // happen is 'up', and lastError survives the retries.
    expect(broken.state).not.toBe('up');
    expect(broken.lastError).toBeTruthy();
  });

  it('keeps liveness minimal and detailed health behind bearer auth', async () => {
    expect((await request(hub.app).get('/livez').expect(200)).body).toEqual({ status: 'ok' });
    await request(hub.app).get('/health').expect(401);
    const response = await request(hub.app).get('/health').set('Authorization', `Bearer ${accessToken}`).expect(503);
    expect(response.body.status).toBe('degraded');
    expect(response.body.servers.everything.state).toBe('up');
    expect(response.body.servers.everything.tools).toBeGreaterThan(0);
    expect(response.body.servers.broken.state).toBe('down');
  });

  it('keeps error details out of the authenticated /health response', async () => {
    const response = await request(hub.app).get('/health').set('Authorization', `Bearer ${accessToken}`).expect(503);
    expect(response.body.servers.broken.lastError).toBeUndefined();
    expect(hub.supervisor.get('broken')!.lastError).toBeTruthy(); // still available internally
  });

  it('answers with an error instead of crashing when the proxy path throws', async () => {
    const poisoned = {
      name: 'poisoned',
      state: 'up',
      client: {},
      tools: [],
      restarts: 0,
      config: { hub: true },
      get capabilities(): never {
        throw new Error('boom');
      }
    } as unknown as ManagedServer;
    hub.supervisor.servers.set('poisoned', poisoned);
    try {
      const response = await request(hub.app)
        .post('/poisoned/mcp')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Accept', 'application/json, text/event-stream')
        .send({ jsonrpc: '2.0', method: 'ping', id: 1 })
        .expect(500);
      expect(response.body.error.code).toBe(-32603);
    } finally {
      hub.supervisor.servers.delete('poisoned');
    }

    // the hub still serves other requests
    await request(hub.app).get('/health').set('Authorization', `Bearer ${accessToken}`).expect(503);
  });

  it('sweeps expired authorization codes', () => {
    const codes = hub.provider['codes'] as Map<string, { expiresAt: number }>;
    const client = { client_id: 'sweeper' } as OAuthClientInformationFull;
    const res = { redirect: () => undefined } as unknown as Response;

    hub.provider.redirectWithCode(client, { redirectUri: REDIRECT_URI, codeChallenge: 'challenge' }, res);
    const stale = [...codes.keys()];
    expect(stale.length).toBeGreaterThan(0);
    for (const key of stale) codes.get(key)!.expiresAt = Date.now() - 1;

    hub.provider.redirectWithCode(client, { redirectUri: REDIRECT_URI, codeChallenge: 'challenge' }, res);
    for (const key of stale) expect(codes.has(key)).toBe(false);
    expect(codes.size).toBe(1);
  });

  it('applies config diffs without touching unchanged servers', async () => {
    const before = hub.supervisor.get('everything');
    const config = new Map(hub.supervisor['servers'].size ? [...hub.watcher.current] : []);
    config.delete('broken');
    await hub.supervisor.applyDiff(config, { added: [], removed: ['broken'], changed: [] });
    expect(hub.supervisor.get('broken')).toBeUndefined();
    expect(hub.supervisor.get('everything')).toBe(before); // untouched instance
  });
});

/**
 * The behaviour you get without asking for it since 0.5.0: every token is bound
 * to exactly one resource. The suite above deliberately runs the opposite mode,
 * so this one builds its own hub with the plain default.
 */
describe('resource-bound tokens (default)', () => {
  const ORIGIN = 'http://localhost:3000';
  let boundDir: string;
  let bound: Awaited<ReturnType<typeof createHub>>;
  let boundServer: ReturnType<Awaited<ReturnType<typeof createHub>>['app']['listen']>;
  let boundUrl: string;
  let hubToken: string;
  let serverToken: string;

  const boundClient = async (pathname: string, token: string): Promise<Client> => {
    const client = new Client({ name: 'vitest', version: '0.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${boundUrl}${pathname}`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } }
      })
    );
    return client;
  };

  beforeAll(async () => {
    boundDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-bound-'));
    const configPath = path.join(boundDir, 'mcp.json');
    fs.writeFileSync(configPath, JSON.stringify({ mcpServers: { everything: { command: process.execPath, args: [EVERYTHING] } } }));
    bound = await createHub({
      externalUrl: ORIGIN,
      configPath,
      dataPath: path.join(boundDir, 'data'),
      password: PASSWORD
      // requireResourceBoundTokens intentionally omitted — that is the point.
    });
    await bound.supervisor.waitUntilSettled();
    boundServer = bound.app.listen(0);
    boundUrl = `http://127.0.0.1:${(boundServer.address() as AddressInfo).port}`;
    hubToken = (await obtainToken(bound.app, `${ORIGIN}/hub`)).access;
    serverToken = (await obtainToken(bound.app, `${ORIGIN}/everything/mcp`)).access;
  }, 30_000);

  afterAll(async () => {
    boundServer?.close();
    bound?.watcher.stop();
    await bound?.supervisor.stop();
    fs.rmSync(boundDir, { recursive: true, force: true });
  });

  it('refuses an authorization request that names no resource', async () => {
    const clientId = (
      await request(bound.app)
        .post('/register')
        .send({ redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: 'none' })
        .expect(201)
    ).body.client_id as string;
    const { challenge } = pkcePair();
    const response = await request(bound.app)
      .get('/authorize')
      .query({
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        response_type: 'code',
        code_challenge: challenge,
        code_challenge_method: 'S256'
      })
      .expect(302);
    expect(new URL(response.headers.location).searchParams.get('error')).toBe('invalid_target');
  });

  it('canonicalises the short path, so one token serves /<name> and /<name>/mcp', async () => {
    for (const pathname of ['/everything', '/everything/mcp']) {
      const client = await boundClient(pathname, serverToken);
      expect((await client.listTools()).tools.map(t => t.name)).toContain('echo');
      await client.close();
    }
  });

  it('lets a /hub token reach the aggregate and the fleet view', async () => {
    const client = await boundClient('/hub', hubToken);
    expect((await client.listTools()).tools.map(t => t.name)).toContain('list_servers');
    await client.close();
    await request(bound.app).get('/health').set('Authorization', `Bearer ${hubToken}`).expect(200);
  });

  it('refuses a /hub token on a server path', async () => {
    await request(bound.app)
      .post('/everything/mcp')
      .set('Authorization', `Bearer ${hubToken}`)
      .send({ jsonrpc: '2.0', method: 'ping', id: 1 })
      .expect(401);
  });

  it('refuses a server token on /hub and on /health', async () => {
    await request(bound.app)
      .post('/hub')
      .set('Authorization', `Bearer ${serverToken}`)
      .send({ jsonrpc: '2.0', method: 'ping', id: 1 })
      .expect(401);
    // /health enumerates every server, so a token for one of them must not read it.
    await request(bound.app).get('/health').set('Authorization', `Bearer ${serverToken}`).expect(401);
  });
});
