import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { Client, InMemoryTransport, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { CallToolResult } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { mintApiToken } from '../src/auth/api-tokens.js';
import { createHub } from '../src/index.js';
import { createStdioHub } from '../src/stdio.js';

const EVERYTHING = path.resolve('node_modules/@modelcontextprotocol/server-everything/dist/index.js');
const ORIGIN = 'http://localhost:3000';
type Hub = Awaited<ReturnType<typeof createHub>>;

async function startHub(mcpServers: Record<string, unknown>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-unlock-tools-'));
  const configPath = path.join(dir, 'mcp.json');
  fs.writeFileSync(configPath, JSON.stringify({ mcpServers }));
  const hub = await createHub({ externalUrl: ORIGIN, configPath, dataPath: path.join(dir, 'data'), password: 'pw', idleTimeoutMinutes: 0 });
  await hub.supervisor.waitUntilSettled();
  const listen = hub.app.listen(0);
  const baseUrl = `http://127.0.0.1:${(listen.address() as AddressInfo).port}`;
  const stop = async () => {
    listen.close();
    hub.stopMaintenance();
    hub.watcher.stop();
    await hub.supervisor.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { hub, baseUrl, stop };
}

async function hubClient(hub: Hub, baseUrl: string) {
  const minted = await mintApiToken(hub.store, ORIGIN, new URL('/hub', ORIGIN), 1, 'tools');
  const client = new Client({ name: 'vitest', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/hub`), { requestInit: { headers: { Authorization: `Bearer ${minted.token}` } } }));
  return { client, clientId: `token:${minted.id}` };
}

const structured = (result: unknown) => (result as CallToolResult).structuredContent as Record<string, unknown>;

describe('a hub that locks nothing', () => {
  it('keeps its six meta-tools', async () => {
    const { hub, baseUrl, stop } = await startHub({ plain: { command: process.execPath, args: [EVERYTHING] } });
    try {
      const { client } = await hubClient(hub, baseUrl);
      const names = (await client.listTools()).tools.map(tool => tool.name);
      expect(names).not.toContain('request_unlock');
      expect(names).not.toContain('lock_server');
      expect(names).toHaveLength(6);
      await client.close();
    } finally {
      await stop();
    }
  }, 30_000);
});

describe('a hub that locks servers', () => {
  let started: Awaited<ReturnType<typeof startHub>>;
  beforeAll(async () => {
    started = await startHub({
      listed: { command: process.execPath, args: [EVERYTHING], unlock: { tools: ['get-sum', 'get-env'] } },
      whole: { command: process.execPath, args: [EVERYTHING], unlock: true },
      hidden: { command: process.execPath, args: [EVERYTHING], hub: false, unlock: true },
      plain: { command: process.execPath, args: [EVERYTHING] }
    });
  }, 30_000);
  afterAll(() => started.stop());

  it('offers request_unlock and lock_server, annotated, with output schemas', async () => {
    const { client } = await hubClient(started.hub, started.baseUrl);
    const tools = (await client.listTools()).tools;
    for (const name of ['request_unlock', 'lock_server']) {
      const tool = tools.find(t => t.name === name)!;
      expect(tool.outputSchema).toBeDefined();
      expect(tool.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    }
    await client.close();
  });

  it('shows in list_servers what is locked for the caller', async () => {
    const { client, clientId } = await hubClient(started.hub, started.baseUrl);
    const byName = async () =>
      Object.fromEntries((structured(await client.callTool({ name: 'list_servers', arguments: {} })).servers as Array<Record<string, unknown>>).map(s => [s.name, s]));
    let servers = await byName();
    expect(servers.listed).toMatchObject({ locked: true, lockedTools: ['get-sum', 'get-env'] });
    expect(servers.whole).toMatchObject({ locked: true });
    expect(servers.whole).not.toHaveProperty('lockedTools');
    expect(servers.plain).not.toHaveProperty('locked');
    const until = Date.now() + 600_000;
    started.hub.store.addUnlockGrant({ server: 'whole', clientId, kind: 'window', grantedAt: Date.now(), expiresAt: until, by: 'cli' });
    servers = await byName();
    expect(servers.whole).toMatchObject({ locked: false, unlockedUntil: new Date(until).toISOString() });
    await client.close();
  });

  it('hands out a link ahead of a call, the same one while it is open', async () => {
    const { client } = await hubClient(started.hub, started.baseUrl);
    const first = structured(await client.callTool({ name: 'request_unlock', arguments: { server: 'listed' } }));
    expect(first).toMatchObject({ server: 'listed', status: 'pending' });
    expect(first.url).toMatch(/^http:\/\/localhost:3000\/unlock\/r\/[\w-]+$/);
    expect(first.code).toMatch(/^[A-Z2-9]{3}-[A-Z2-9]{3}$/);
    const again = structured(await client.callTool({ name: 'request_unlock', arguments: { server: 'listed' } }));
    expect(again.url).toBe(first.url);
    expect(structured(await client.callTool({ name: 'request_unlock', arguments: { server: 'plain' } }))).toMatchObject({ status: 'unlocked' });
    await client.close();
  });

  it('points a hidden server at its own connector rather than unlocking the wrong authorization', async () => {
    const { client } = await hubClient(started.hub, started.baseUrl);
    const result = (await client.callTool({ name: 'request_unlock', arguments: { server: 'hidden' } })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('/hidden/mcp');
    await client.close();
  });

  it('ends only the caller’s own unlocks', async () => {
    const mine = await hubClient(started.hub, started.baseUrl);
    const now = Date.now();
    started.hub.store.addUnlockGrant({ server: 'listed', clientId: mine.clientId, kind: 'window', grantedAt: now, expiresAt: now + 600_000, by: 'cli' });
    started.hub.store.addUnlockGrant({ server: 'listed', clientId: 'someone-else', kind: 'window', grantedAt: now, expiresAt: now + 600_000, by: 'cli' });
    expect(structured(await mine.client.callTool({ name: 'lock_server', arguments: { server: 'listed' } }))).toEqual({ server: 'listed', locked: true, ended: 1 });
    expect(started.hub.store.unlockGrants().filter(grant => grant.server === 'listed').map(grant => grant.clientId)).toEqual(['someone-else']);
    await mine.client.close();
  });
});

describe('a hub over stdio', () => {
  it('offers no unlock tools, since nothing could unlock there', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-unlock-tools-stdio-'));
    const configPath = path.join(dir, 'mcp.json');
    fs.writeFileSync(configPath, JSON.stringify({ mcpServers: { whole: { command: process.execPath, args: [EVERYTHING], unlock: true } } }));
    const stdio = createStdioHub({ configPath, idleTimeoutMinutes: 0 });
    try {
      await stdio.supervisor.waitUntilSettled();
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await stdio.build('modern').connect(serverTransport);
      const client = new Client({ name: 'vitest', version: '0.0.0' });
      await client.connect(clientTransport);
      const names = (await client.listTools()).tools.map(tool => tool.name);
      expect(names).not.toContain('request_unlock');
      const servers = structured(await client.callTool({ name: 'list_servers', arguments: {} })).servers as Array<Record<string, unknown>>;
      expect(servers[0]).toMatchObject({ name: 'whole', locked: true });
      await client.close();
    } finally {
      stdio.watcher.stop();
      await stdio.supervisor.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
