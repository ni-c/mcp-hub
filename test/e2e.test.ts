import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { authorizeInBrowser, registerPublicClient } from './auth-flow.js';
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
  const clientId = await registerPublicClient(app, REDIRECT_URI);
  const { code, verifier, pages } = await authorizeInBrowser(app, clientId, {
    password: PASSWORD,
    redirectUri: REDIRECT_URI,
    resource
  });
  if (displayedResource) expect(pages.join('')).toContain(displayedResource);

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
        // allow and deny in one entry, so the subtraction is exercised too. The
        // upstream's names are hyphenated, which also shows the pattern syntax
        // is not tied to the underscore names ni-c's own servers use.
        filtered: {
          command: process.execPath,
          args: [EVERYTHING],
          allowTools: ['echo', 'get-*'],
          denyTools: ['get-env']
        },
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
    requireResourceBoundTokens: false,
    // This suite asserts the always-running behaviour (503 while down, endless
    // restarts); the on-demand lifecycle has its own suite in on-demand-e2e.
    idleTimeoutMinutes: 0
  });
  await hub.supervisor.waitUntilSettled();
  httpServer = hub.app.listen(0);
  baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  const tokens = await obtainToken(hub.app);
  accessToken = tokens.access;
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

  /**
   * Signs in for real and hands back the agent that carries the session.
   *
   * Forging a session cookie is no longer enough: "signed in" is the
   * authorization server's own session, and the hub cookie beside it exists for
   * the upstream OAuth callback. Logging in once is also what the operator
   * actually does.
   */
  let sharedSession: ReturnType<typeof request.agent> | undefined;
  async function signedIn(): Promise<ReturnType<typeof request.agent>> {
    // Memoised: /register allows 20 per hour per address, and a bootstrap
    // client per test would spend that budget on scaffolding.
    if (!sharedSession) {
      const agent = request.agent(hub.app);
      const bootstrap = await registerClient('bootstrap');
      await authorizeInBrowser(hub.app, bootstrap, { password: PASSWORD, redirectUri: REDIRECT_URI, agent });
      sharedSession = agent;
    }
    return sharedSession;
  }

  /** GETs /authorize and follows to whichever page the flow lands on. */
  async function authPage(agent: ReturnType<typeof request.agent>, clientId: string, redirectUri = REDIRECT_URI) {
    const { challenge } = pkcePair();
    const started = await agent
      .get('/authorize')
      .query({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state: 'xyz'
      })
      .redirects(0);
    if (started.status !== 303 && started.status !== 302) return started;
    const location = started.headers.location as string;
    // Straight back to the client means no page was needed: already approved.
    if (location.startsWith(redirectUri)) return started;
    const path = location.startsWith('http') ? new URL(location).pathname : location;
    return agent.get(path).redirects(0);
  }

  function formFields(html: string): { request: string; csrf?: string; action: string } {
    return {
      request: /name="request" value="([^"]+)"/.exec(html)![1],
      csrf: /name="csrf" value="([^"]+)"/.exec(html)?.[1],
      action: /<form[^>]*action="([^"]*)"/.exec(html)![1]
    };
  }

  it('sets anti-clickjacking and browser hardening headers on interactive auth pages', async () => {
    const agent = await signedIn();
    const clientId = await registerClient('headers');
    const page = await authPage(agent, clientId);
    expect(page.status).toBe(200);
    expect(page.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(page.headers['content-security-policy']).toContain("form-action 'self'");
    expect(page.headers['x-frame-options']).toBe('DENY');
    expect(page.headers['x-content-type-options']).toBe('nosniff');
    expect(page.headers['referrer-policy']).toBe('no-referrer');
  });

  // A form submission is checked against form-action at every hop, and the last
  // hop is the redirect back to the client. Without the client's origin the
  // browser blocks it and the login window silently does nothing.
  it('lets the interactive pages redirect to the client that was authorized', async () => {
    const clientId = await registerClient('form-action');
    const page = await authPage(request.agent(hub.app), clientId);
    expect(page.headers['content-security-policy']).toContain("form-action 'self' http://localhost:33418;");

    // The retry after a wrong password has to reach the same redirect.
    const { request: token, action } = formFields(page.text);
    const retry = await request
      .agent(hub.app)
      .post(action.startsWith('/') ? action : `${page.request.url.replace(/^https?:\/\/[^/]+/, '').replace(/[^/]*$/, '')}${action}`)
      .type('form')
      .send({ password: 'nope', request: token });
    expect([401, 400]).toContain(retry.status);

    // Nothing else on the hub is widened.
    const metadata = await request(hub.app).get('/.well-known/oauth-authorization-server').expect(200);
    expect(metadata.headers['content-security-policy']).toContain("form-action 'self';");
  });

  it('rejects a wrong password and logs the attempt', async () => {
    const clientId = await registerClient('wrong-password');
    const agent = request.agent(hub.app);
    const page = await authPage(agent, clientId);
    const { request: token, action } = formFields(page.text);
    const base = new URL(page.request.url).pathname;
    const target = new URL(action, `http://x${base}`).pathname;
    const refused = await agent.post(target).type('form').send({ password: 'nope', request: token });
    expect(refused.status).toBe(401);
    expect(refused.text).toContain('Wrong password');
  });

  it('never issues a code to an unapproved client, even with a valid session', async () => {
    // The drive-by: a page registers its own client and walks a signed-in
    // user through /authorize. A code here would be a full-access token.
    const agent = await signedIn();
    const clientId = await registerClient('drive-by');
    const page = await authPage(agent, clientId);
    expect(page.status).toBe(200);
    expect(page.text).toContain('Authorize access?');
    expect(page.text).toContain(REDIRECT_URI); // the user gets to see where codes would go
  });

  it('issues codes silently once the client is approved', async () => {
    const agent = await signedIn();
    const clientId = await registerClient('approved');
    const { code } = await authorizeInBrowser(hub.app, clientId, {
      password: PASSWORD,
      redirectUri: REDIRECT_URI,
      agent
    });
    expect(code).toBeTruthy();

    // Second time round there is no page at all.
    const again = await authPage(agent, clientId);
    expect(again.status).not.toBe(200);
    expect(new URL(again.headers.location as string).searchParams.get('code')).toBeTruthy();
  });

  it('redirects with access_denied when consent is refused', async () => {
    const agent = await signedIn();
    const clientId = await registerClient('denied');
    const result = await authorizeInBrowser(hub.app, clientId, {
      password: PASSWORD,
      redirectUri: REDIRECT_URI,
      agent,
      consent: 'deny',
      allowError: true
    });
    expect(result.code).toBe('');

    // Still unapproved: the page comes back.
    const again = await authPage(agent, clientId);
    expect(again.status).toBe(200);
    expect(again.text).toContain('Authorize access?');
  });

  it('rejects consent without a session or with a bad CSRF token', async () => {
    const agent = await signedIn();
    const clientId = await registerClient('csrf');
    const page = await authPage(agent, clientId);
    const { request: token, csrf, action } = formFields(page.text);
    const base = new URL(page.request.url).pathname;
    const target = new URL(action, `http://x${base}`).pathname;

    // No cookies at all. Refused earlier than it used to be -- without the
    // interaction cookie the request cannot even be tied to an authorization,
    // so it never reaches the session check. Still a refusal, which is the
    // property that matters.
    const anonymous = await request(hub.app).post(target).type('form').send({ request: token, csrf, action: 'approve' });
    expect(anonymous.status).toBeGreaterThanOrEqual(400);
    expect(anonymous.headers.location).toBeUndefined();
    // Signed in, but the token does not belong to this session.
    await agent.post(target).type('form').send({ request: token, csrf: 'wrong', action: 'approve' }).expect(403);
  });

  it('treats a successful password login as consent for that client', async () => {
    const agent = request.agent(hub.app);
    const clientId = await registerClient('password-consent');
    await authorizeInBrowser(hub.app, clientId, { password: PASSWORD, redirectUri: REDIRECT_URI, agent });

    // No second prompt for the same client.
    const again = await authPage(agent, clientId);
    expect(again.status).not.toBe(200);
    expect(new URL(again.headers.location as string).searchParams.get('code')).toBeTruthy();
  });

  it('binds the approval to the redirect target, ignoring the loopback port', async () => {
    const approvedUri = 'http://localhost:33418/callback';
    const clientId = await registerClient('loopback', [approvedUri, 'http://localhost:44000/other']);
    const agent = request.agent(hub.app);
    await authorizeInBrowser(hub.app, clientId, { password: PASSWORD, redirectUri: approvedUri, agent });

    // Same target on another port — RFC 8252 says that is the same client.
    const otherPort = await authPage(agent, clientId, 'http://localhost:51234/callback');
    expect(otherPort.status).not.toBe(200);

    // A different path is a different target and needs its own approval.
    const otherPath = await authPage(agent, clientId, 'http://localhost:44000/other');
    expect(otherPath.status).toBe(200);
    expect(otherPath.text).toContain('Authorize access?');
  });

  it('rotates refresh tokens', async () => {
    const registration = await request(hub.app).get('/.well-known/oauth-authorization-server').expect(200);
    expect(registration.body.grant_types_supported).toContain('refresh_token');

    // Its own client, deliberately. Replaying a rotated refresh token is
    // treated as a leak and now takes the whole grant with it -- the access
    // tokens included, which the JWT design could not do. Doing that to the
    // token the rest of the suite shares would log the suite out halfway.
    const own = await obtainToken(hub.app);
    const refreshed = await request(hub.app)
      .post('/token')
      .type('form')
      .send({ grant_type: 'refresh_token', refresh_token: own.refresh, client_id: own.clientId })
      .expect(200);
    expect(refreshed.body.access_token).toBeTruthy();
    // the old refresh token is now invalid (rotation)
    await request(hub.app)
      .post('/token')
      .type('form')
      .send({ grant_type: 'refresh_token', refresh_token: own.refresh, client_id: own.clientId })
      .expect(400);
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
        // 303, not 302: oidc-provider uses the code that tells a browser to
        // follow with GET. Both are redirects and every client follows both.
        .expect(303);
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

  it('lists only the tools allowTools/denyTools leave', async () => {
    // This suite runs with idleTimeoutMinutes 0, so every server is UP — which
    // makes this the live branch of the tools/list handler, the one that
    // forwards the upstream's own answer instead of the cached snapshot.
    const client = await mcpClient('/filtered/mcp', accessToken);
    const names = (await client.listTools()).tools.map(t => t.name);
    expect(names).toContain('echo');
    expect(names).toContain('get-sum');
    // Allowed by `get-*`, then taken back out by the deny list.
    expect(names).not.toContain('get-env');
    // Never allowed in the first place.
    expect(names).not.toContain('toggle-simulated-logging');
    await client.close();
  });

  it('refuses a filtered tool without saying it was filtered', async () => {
    // Hiding is not a boundary here: the hub forwards by name, so a client
    // holding a stale schema would still reach it.
    const client = await mcpClient('/filtered/mcp', accessToken);
    await expect(client.callTool({ name: 'get-env', arguments: {} })).rejects.toThrow(/Unknown tool/);
    await expect(client.callTool({ name: 'toggle-simulated-logging', arguments: {} })).rejects.toThrow(
      /Unknown tool/
    );
    await client.close();
  });

  it('leaves an unfiltered server untouched', async () => {
    const client = await mcpClient('/everything/mcp', accessToken);
    expect((await client.listTools()).tools.map(t => t.name)).toContain('get-env');
    await client.close();
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
  it('exposes exactly the six meta-tools', async () => {
    const client = await mcpClient('/hub', accessToken);
    const tools = await client.listTools();
    expect(tools.tools.map(t => t.name).sort()).toEqual(['call_tool', 'get_tool_schema', 'list_servers', 'list_tools', 'sleep_server', 'wake_server']);
    await client.close();
  });

  it('shows a filtered server only its allowed tools, through every meta-tool', async () => {
    const client = await mcpClient('/hub', accessToken);

    const listed = (await client.callTool({ name: 'list_tools', arguments: { server: 'filtered' } })) as CallToolResult;
    expect(JSON.stringify(listed.content)).toContain('echo');
    expect(JSON.stringify(listed.content)).not.toContain('get-env');

    // get_tool_schema is guarded before prepare(), which would otherwise
    // pre-warm a sleeping server for a name it is about to refuse.
    const schema = (await client.callTool({
      name: 'get_tool_schema',
      arguments: { server: 'filtered', tool: 'get-env' }
    })) as CallToolResult;
    expect(schema.isError).toBe(true);
    expect(JSON.stringify(schema.content)).toContain('Unknown tool');

    const called = (await client.callTool({
      name: 'call_tool',
      arguments: { server: 'filtered', tool: 'get-env', arguments: {} }
    })) as CallToolResult;
    expect(called.isError).toBe(true);
    // Indistinguishable from a tool that never existed: /hub tokens go to
    // third-party connectors, so the refusal must not enumerate what was hidden.
    expect(JSON.stringify(called.content)).toContain('Unknown tool');
    expect(JSON.stringify(called.content)).not.toContain('denyTools');

    await client.close();
  });

  it('counts only the exposed tools in list_servers and /health', async () => {
    const client = await mcpClient('/hub', accessToken);
    const listed = (await client.callTool({ name: 'list_servers', arguments: {} })) as CallToolResult;
    const servers = JSON.parse((listed.content[0] as { text: string }).text) as { name: string; toolCount: number }[];
    expect(servers.find(s => s.name === 'filtered')!.toolCount).toBeLessThan(
      servers.find(s => s.name === 'everything')!.toolCount
    );
    await client.close();

    // No .expect(200): this fixture deliberately holds a `broken` server, so
    // /health answers 503 by design. The body is what this test is about.
    const health = await request(hub.app).get('/health').set('Authorization', `Bearer ${accessToken}`);
    expect(health.body.servers.filtered.toolFilter).toMatchObject({ hidden: expect.any(Number) });
    expect(health.body.servers.everything.toolFilter).toBeUndefined();
  });

  it('walks the list_servers -> list_tools -> get_tool_schema -> call_tool flow', async () => {
    const client = await mcpClient('/hub', accessToken);

    const servers = (await client.callTool({ name: 'list_servers', arguments: {} })) as CallToolResult;
    const serverList = JSON.parse((servers.content[0] as { text: string }).text) as Array<{ name: string; status: string; hidden?: boolean }>;
    expect(serverList.map(s => s.name)).toContain('everything');
    expect(serverList.find(s => s.name === 'everything')?.hidden).toBeUndefined();
    // hub: false servers are listed (their lifecycle is manageable) but marked.
    expect(serverList.find(s => s.name === 'hidden')?.hidden).toBe(true);
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

    // Hidden: the error names the right door; a nonexistent server stays "Unknown".
    const hidden = (await client.callTool({ name: 'call_tool', arguments: { server: 'hidden', tool: 'echo', arguments: { message: 'x' } } })) as CallToolResult;
    expect(hidden.isError).toBe(true);
    expect((hidden.content[0] as { text: string }).text).toContain('not exposed through /hub');
    expect((hidden.content[0] as { text: string }).text).toContain('/hidden/mcp');
    const hiddenList = (await client.callTool({ name: 'list_tools', arguments: { server: 'hidden' } })) as CallToolResult;
    expect(hiddenList.isError).toBe(true);
    expect((hiddenList.content[0] as { text: string }).text).toContain('not exposed through /hub');
    const missing = (await client.callTool({ name: 'call_tool', arguments: { server: 'nope', tool: 'x' } })) as CallToolResult;
    expect((missing.content[0] as { text: string }).text).toContain('Unknown server');

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

  it('sweeps expired authorization artifacts', () => {
    // Authorization codes used to live in a Map the provider swept itself. They
    // are adapter records now, and every write to state.json prunes whatever
    // has aged out — so the sweep is the store's, and it covers every model
    // rather than only codes.
    hub.store.oidcUpsert('AuthorizationCode', 'stale-code', { clientId: 'sweeper', iat: 1 }, 1);
    hub.store.oidcUpsert('AuthorizationCode', 'fresh-code', { clientId: 'sweeper', iat: 1 }, 600);
    expect(hub.store.oidcFind('AuthorizationCode', 'fresh-code')).toBeDefined();

    const before = Object.keys(
      JSON.parse(fs.readFileSync(path.join(tmpDir, 'data', 'state.json'), 'utf8')).oidcArtifacts.AuthorizationCode
    ).length;

    vi.setSystemTime(Date.now() + 5_000);
    try {
      // Any write triggers the prune; the expired one is gone from disk, not
      // merely hidden by the read path.
      hub.store.oidcUpsert('AuthorizationCode', 'later', { clientId: 'sweeper', iat: 1 }, 600);
      expect(hub.store.oidcFind('AuthorizationCode', 'stale-code')).toBeUndefined();
      expect(hub.store.oidcFind('AuthorizationCode', 'fresh-code')).toBeDefined();
      // Gone from disk, not merely filtered out on the way back: one record was
      // added by the write above and the count did not grow, so one was removed.
      const state = JSON.parse(fs.readFileSync(path.join(tmpDir, 'data', 'state.json'), 'utf8'));
      expect(Object.keys(state.oidcArtifacts.AuthorizationCode).length).toBe(before);
    } finally {
      vi.useRealTimers();
    }
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
      .expect(303);
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
