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
import { authorizeInBrowser, registerPublicClient } from './auth-flow.js';
import { createHub } from '../src/index.js';
import { loadConfig } from '../src/config.js';
import { ToolCache } from '../src/tool-cache.js';

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

async function obtainToken(app: Express.Application): Promise<string> {
  const clientId = await registerPublicClient(app, REDIRECT_URI);
  const { code, verifier } = await authorizeInBrowser(app, clientId, { password: PASSWORD, redirectUri: REDIRECT_URI });
  const tokens = await request(app)
    .post('/token')
    .type('form')
    .send({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT_URI })
    .expect(200);
  return tokens.body.access_token as string;
}

async function mcpClient(pathname: string): Promise<Client> {
  const client = new Client({ name: 'vitest', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}${pathname}`), {
    requestInit: { headers: { Authorization: `Bearer ${accessToken}` } }
  });
  await client.connect(transport);
  return client;
}

async function hubTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  const client = await mcpClient('/hub');
  try {
    return (await client.callTool({ name, arguments: args })) as CallToolResult;
  } finally {
    await client.close();
  }
}

async function until(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not reached in time');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-ondemand-e2e-'));
  const configPath = path.join(tmpDir, 'mcp.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      mcpServers: {
        everything: { command: process.execPath, args: [EVERYTHING] },
        pinned: { command: process.execPath, args: [EVERYTHING], keepAlive: true },
        secret: { command: process.execPath, args: [EVERYTHING], hub: false },
        lazyfiltered: { command: process.execPath, args: [EVERYTHING], allowTools: ['echo'] }
      }
    })
  );
  // Seed the cache so `everything` can boot straight into `sleeping`. The
  // snapshot deliberately differs from the live server (cached_echo) to make
  // cache-served and live answers distinguishable below.
  const toolCachePath = path.join(tmpDir, 'data', 'tool-cache.json');
  const seeded = new ToolCache(toolCachePath);
  seeded.put('everything', {
    fingerprint: ToolCache.fingerprint(loadConfig(configPath).get('everything')!),
    serverInfo: { name: 'everything-cached', version: '0.0.1' },
    capabilities: { tools: {} },
    tools: [{ name: 'cached_echo', description: 'from the cache', inputSchema: { type: 'object' } }],
    updatedAt: new Date().toISOString()
  });

  // Seeded with a tool the filter forbids, on purpose: hydrate() must filter it
  // out too, so the invariant does not rest on the fingerprint check alone.
  seeded.put('lazyfiltered', {
    fingerprint: ToolCache.fingerprint(loadConfig(configPath).get('lazyfiltered')!),
    serverInfo: { name: 'lazy-cached', version: '0.0.1' },
    capabilities: { tools: {} },
    tools: [
      { name: 'echo', description: 'from the cache', inputSchema: { type: 'object' } },
      { name: 'cached_forbidden', description: 'from the cache', inputSchema: { type: 'object' } }
    ],
    updatedAt: new Date().toISOString()
  });

  hub = await createHub({
    externalUrl: 'http://localhost:3000',
    configPath,
    dataPath: path.join(tmpDir, 'data'),
    password: PASSWORD,
    requireResourceBoundTokens: false,
    idleTimeoutMinutes: 60
  });
  await hub.supervisor.waitUntilSettled();
  httpServer = hub.app.listen(0);
  baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  accessToken = await obtainToken(hub.app);
}, 30_000);

afterAll(async () => {
  httpServer?.close();
  hub?.watcher.stop();
  await hub?.supervisor.stop();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('on-demand boot', () => {
  it('hydrates the cached server into sleeping and starts the keepAlive one', () => {
    expect(hub.supervisor.get('everything')!.state).toBe('sleeping');
    expect(hub.supervisor.get('everything')!.client).toBeUndefined();
    expect(hub.supervisor.get('pinned')!.state).toBe('up');
  });

  it('answers initialize and tools/list from the cache without waking the server', async () => {
    const client = await mcpClient('/everything/mcp');
    const tools = await client.listTools();
    expect(tools.tools.map(t => t.name)).toEqual(['cached_echo']);
    await client.close();
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(hub.supervisor.get('everything')!.state).toBe('sleeping');
  });

  it('filters the cached snapshot too, without waking the server', async () => {
    // The cached branch of tools/list, and the defensive filter in hydrate():
    // the seeded snapshot carries cached_forbidden, which allowTools excludes.
    const client = await mcpClient('/lazyfiltered/mcp');
    expect((await client.listTools()).tools.map(t => t.name)).toEqual(['echo']);
    await client.close();
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(hub.supervisor.get('lazyfiltered')!.state).toBe('sleeping');
  });

  it('does not wake a sleeping server for a forbidden tool', async () => {
    // The load-bearing one: refusing after the wake would make the filter cost
    // a process start for every probe of a name it forbids.
    const client = await mcpClient('/lazyfiltered/mcp');
    await expect(client.callTool({ name: 'get-env', arguments: {} })).rejects.toThrow(/Unknown tool/);
    await client.close();
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(hub.supervisor.get('lazyfiltered')!.state).toBe('sleeping');
  });

  it('reports exposed but not hidden while the server is still asleep', async () => {
    // Runs before the wake below, deliberately. The seeded snapshot is already
    // filtered, so "how many did the filter remove" has no honest answer yet —
    // and neither has "which entries matched nothing", because every denyTools
    // entry would look unmatched against an array those tools were cut from.
    const response = await request(hub.app).get('/health').set('Authorization', `Bearer ${accessToken}`);
    const filter = response.body.servers.lazyfiltered.toolFilter as Record<string, unknown>;
    expect(hub.supervisor.get('lazyfiltered')!.state).toBe('sleeping');
    expect(filter.exposed).toBe(1);
    expect(filter).not.toHaveProperty('hidden');
    expect(filter).not.toHaveProperty('unmatched');
  });

  it('still filters once the server is awake, on the live branch', async () => {
    const client = await mcpClient('/lazyfiltered/mcp');
    await client.callTool({ name: 'echo', arguments: { message: 'hi' } });
    expect(hub.supervisor.get('lazyfiltered')!.state).toBe('up');
    // Now answered live by the real child, not from the seeded snapshot.
    expect((await client.listTools()).tools.map(t => t.name)).toEqual(['echo']);
    await client.close();
  });

  it('fills in hidden and unmatched once the server has really listed its tools', async () => {
    // Waiting on the field, not on the state: refreshTools() populates it after
    // the wake and asynchronously, so `state === 'up'` alone races it.
    const server = hub.supervisor.get('lazyfiltered')!;
    const deadline = Date.now() + 10_000;
    while (server.toolsHidden === undefined) {
      if (Date.now() > deadline) throw new Error('the tool filter was never measured');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const response = await request(hub.app).get('/health').set('Authorization', `Bearer ${accessToken}`);
    const filter = response.body.servers.lazyfiltered.toolFilter as Record<string, unknown>;
    expect(filter.exposed).toBe(1);
    // server-everything offers well over one tool, and `allowTools: ['echo']`
    // matches exactly one of them — so something was hidden and nothing dangles.
    expect(filter.hidden).toBeGreaterThan(0);
    expect(filter.unmatched).toEqual([]);
  });

  it('reports a sleeping server as healthy', async () => {
    const response = await request(hub.app).get('/health').set('Authorization', `Bearer ${accessToken}`).expect(200);
    expect(response.body.status).toBe('ok');
    expect(response.body.servers.everything.state).toBe('sleeping');
    expect(response.body.servers.pinned.state).toBe('up');
  });

  it('shows the sleeping state in list_servers', async () => {
    const result = await hubTool('list_servers', {});
    const servers = JSON.parse((result.content[0] as { text: string }).text) as { name: string; status: string }[];
    expect(servers.find(s => s.name === 'everything')?.status).toBe('sleeping');
    expect(servers.find(s => s.name === 'pinned')?.status).toBe('up');
  });
});

describe('waking', () => {
  it('a tool call wakes the server, blocks until it is up and then answers live', async () => {
    const client = await mcpClient('/everything/mcp');
    const result = (await client.callTool({ name: 'echo', arguments: { message: 'hallo' } })) as CallToolResult;
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('hallo') });
    expect(hub.supervisor.get('everything')!.state).toBe('up');
    // Live now: tools/list is forwarded and shows the real tool set.
    const tools = await client.listTools();
    expect(tools.tools.map(t => t.name)).toContain('echo');
    expect(tools.tools.map(t => t.name)).not.toContain('cached_echo');
    await client.close();
  });

  it('sleep_server puts it back to sleep immediately', async () => {
    const result = await hubTool('sleep_server', { server: 'everything' });
    expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({ status: 'sleeping' });
    expect(hub.supervisor.get('everything')!.state).toBe('sleeping');
  });

  it('list_tools answers from the snapshot and pre-warms the server in the background', async () => {
    const result = await hubTool('list_tools', { server: 'everything' });
    expect(result.isError).toBeFalsy();
    const names = (JSON.parse((result.content[0] as { text: string }).text) as { name: string }[]).map(t => t.name);
    expect(names).toContain('echo'); // refreshed live before it went to sleep
    await until(() => hub.supervisor.get('everything')!.state === 'up');
  });

  it('wake_server reports the running state and refuses for always-running servers', async () => {
    const woken = await hubTool('wake_server', { server: 'everything' });
    expect(JSON.parse((woken.content[0] as { text: string }).text)).toMatchObject({ status: 'up' });

    for (const tool of ['wake_server', 'sleep_server']) {
      const refused = await hubTool(tool, { server: 'pinned' });
      expect(refused.isError).toBe(true);
      expect((refused.content[0] as { text: string }).text).toContain('always running');
    }
  });

  it('updates the persisted snapshot after a wake, so the next boot serves fresh tools', () => {
    const cache = new ToolCache(path.join(tmpDir, 'data', 'tool-cache.json'));
    cache.load();
    const managed = hub.supervisor.get('everything')!;
    const entry = cache.get('everything', ToolCache.fingerprint(managed.config));
    expect(entry?.tools.map(t => t.name)).toContain('echo');
    expect(entry?.serverInfo?.name).not.toBe('everything-cached');
  });
});

describe('hidden (hub: false) servers', () => {
  it('appear in list_servers with a hidden marker', async () => {
    const result = await hubTool('list_servers', {});
    const servers = JSON.parse((result.content[0] as { text: string }).text) as { name: string; status: string; hidden?: boolean }[];
    const secret = servers.find(s => s.name === 'secret');
    expect(secret?.hidden).toBe(true);
    expect(servers.find(s => s.name === 'everything')?.hidden).toBeUndefined();
  });

  it('refuse tool access with a pointer to their own endpoint', async () => {
    for (const [tool, args] of [
      ['list_tools', { server: 'secret' }],
      ['get_tool_schema', { server: 'secret', tool: 'echo' }],
      ['call_tool', { server: 'secret', tool: 'echo', arguments: {} }]
    ] as const) {
      const result = await hubTool(tool, args as Record<string, unknown>);
      expect(result.isError).toBe(true);
      expect((result.content[0] as { text: string }).text).toContain('not exposed through /hub');
      expect((result.content[0] as { text: string }).text).toContain('/secret/mcp');
    }
  });

  it('are still managed by sleep_server and wake_server', async () => {
    const slept = await hubTool('sleep_server', { server: 'secret' });
    expect(JSON.parse((slept.content[0] as { text: string }).text)).toMatchObject({ status: 'sleeping' });
    expect(hub.supervisor.get('secret')!.state).toBe('sleeping');

    const woken = await hubTool('wake_server', { server: 'secret' });
    expect(JSON.parse((woken.content[0] as { text: string }).text)).toMatchObject({ status: 'up' });
    expect(hub.supervisor.get('secret')!.state).toBe('up');
  });
});

describe('fallbacks', () => {
  it('warm-starts at boot when the tool cache is not writable', async () => {
    const isolatedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-ondemand-ro-'));
    const configPath = path.join(isolatedDir, 'mcp.json');
    fs.writeFileSync(configPath, JSON.stringify({ mcpServers: { everything: { command: process.execPath, args: [EVERYTHING] } } }));
    const readOnly = path.join(isolatedDir, 'readonly');
    fs.mkdirSync(readOnly, { mode: 0o500 });
    const isolated = await createHub({
      externalUrl: 'http://localhost:3000',
      configPath,
      dataPath: path.join(isolatedDir, 'data'),
      password: PASSWORD,
      requireResourceBoundTokens: false,
      idleTimeoutMinutes: 60,
      toolCachePath: path.join(readOnly, 'tool-cache.json')
    });
    try {
      await isolated.supervisor.waitUntilSettled();
      const managed = isolated.supervisor.get('everything')!;
      expect(managed.state).toBe('up'); // no snapshot possible, so it warm-started
      expect(managed.onDemand).toBe(true);
    } finally {
      isolated.watcher.stop();
      await isolated.supervisor.stop();
      fs.chmodSync(readOnly, 0o700);
      fs.rmSync(isolatedDir, { recursive: true, force: true });
    }
  }, 30_000);
});
