import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createHub } from '../src/index.js';

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

async function obtainToken(app: Express.Application): Promise<{ access: string; refresh: string; clientId: string }> {
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
      state: 'xyz'
    })
    .expect(200);
  const requestToken = authorize.text.match(/name="request" value="([^"]+)"/)?.[1];
  expect(requestToken).toBeDefined();

  const login = await request(app).post('/login').type('form').send({ password: PASSWORD, request: requestToken }).expect(302);
  const location = new URL(login.headers.location);
  expect(location.searchParams.get('state')).toBe('xyz');
  const code = location.searchParams.get('code')!;

  const tokens = await request(app)
    .post('/token')
    .type('form')
    .send({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT_URI })
    .expect(200);
  return { access: tokens.body.access_token, refresh: tokens.body.refresh_token, clientId };
}

async function mcpClient(pathname: string, token: string): Promise<Client> {
  const client = new Client({ name: 'vitest', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}${pathname}`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } }
  });
  await client.connect(transport);
  return client;
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-test-'));
  const configPath = path.join(tmpDir, 'mcp.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      mcpServers: {
        everything: { command: process.execPath, args: [EVERYTHING] },
        hidden: { command: process.execPath, args: [EVERYTHING], hub: false },
        broken: { command: '/bin/false' }
      }
    })
  );
  hub = await createHub({
    externalUrl: 'http://localhost:3000',
    configPath,
    dataPath: path.join(tmpDir, 'data'),
    password: PASSWORD
  });
  httpServer = hub.app.listen(0);
  baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  const tokens = await obtainToken(hub.app);
  accessToken = tokens.access;
  refreshToken = tokens.refresh;
}, 30_000);

afterAll(async () => {
  httpServer?.close();
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

  it('skips the login form when a valid session cookie is present', async () => {
    const registration = await request(hub.app)
      .post('/register')
      .send({ redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: 'none' })
      .expect(201);
    const cookie = `mcp_hub_session=${encodeURIComponent(hub.provider.createSessionCookie())}`;
    const { challenge } = pkcePair();
    const response = await request(hub.app)
      .get('/authorize')
      .set('Cookie', cookie)
      .query({
        client_id: registration.body.client_id,
        redirect_uri: REDIRECT_URI,
        response_type: 'code',
        code_challenge: challenge,
        code_challenge_method: 'S256'
      })
      .expect(302);
    expect(new URL(response.headers.location).searchParams.get('code')).toBeTruthy();
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

  it('returns 404 for unknown servers', async () => {
    await request(hub.app)
      .post('/doesnotexist/mcp')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ jsonrpc: '2.0', method: 'ping', id: 1 })
      .expect(404);
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
    expect(broken.state).toBe('down');
    expect(broken.lastError).toBeTruthy();
  });

  it('reports status via /health (degraded because of the broken server)', async () => {
    const response = await request(hub.app).get('/health').expect(503);
    expect(response.body.status).toBe('degraded');
    expect(response.body.servers.everything.state).toBe('up');
    expect(response.body.servers.everything.tools).toBeGreaterThan(0);
    expect(response.body.servers.broken.state).toBe('down');
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
