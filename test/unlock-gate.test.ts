import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { Client, InMemoryTransport, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { CallToolResult } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { mintApiToken } from '../src/auth/api-tokens.js';
import { createHub } from '../src/index.js';
import { createStdioHub } from '../src/stdio.js';
import { argsHash, canonicalArgs } from '../src/unlock/args.js';

const EVERYTHING = path.resolve('node_modules/@modelcontextprotocol/server-everything/dist/index.js');
const ORIGIN = 'http://localhost:3000';
const PASSWORD = 'test-password';

type Hub = Awaited<ReturnType<typeof createHub>>;

const servers = {
  // get-* locked, echo free
  listed: { command: process.execPath, args: [EVERYTHING], unlock: { tools: ['get-*'] } },
  // everything locked, resources and prompts included
  whole: { command: process.execPath, args: [EVERYTHING], unlock: true },
  // only reachable through its own door
  hidden: { command: process.execPath, args: [EVERYTHING], hub: false, unlock: true }
};

let dir: string;
let hub: Hub;
let baseUrl: string;
let listen: ReturnType<Hub['app']['listen']>;
const tokens: Record<string, { token: string; clientId: string }> = {};

async function token(label: string, resource: string) {
  const minted = await mintApiToken(hub.store, ORIGIN, new URL(resource, ORIGIN), 1, label);
  return { token: minted.token, clientId: `token:${minted.id}` };
}

async function connect(pathname: string, bearer: string): Promise<Client> {
  const client = new Client({ name: 'vitest', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}${pathname}`), { requestInit: { headers: { Authorization: `Bearer ${bearer}` } } }));
  return client;
}

async function hubCall(bearer: string, server: string, tool: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
  const client = await connect('/hub', bearer);
  try {
    return (await client.callTool({ name: 'call_tool', arguments: { server, tool, arguments: args } })) as CallToolResult;
  } finally {
    await client.close();
  }
}

const text = (result: CallToolResult) => result.content.map(part => ('text' in part ? part.text : '')).join('\n');
const linkIn = (result: CallToolResult) => /http:\/\/localhost:3000\/unlock\/r\/[\w-]+/.exec(text(result))?.[0];
const window = (clientId: string, server: string, minutes = 30) =>
  hub.store.addUnlockGrant({ server, clientId, kind: 'window', grantedAt: Date.now(), expiresAt: Date.now() + minutes * 60_000, by: 'cli' });

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-gate-'));
  const configPath = path.join(dir, 'mcp.json');
  fs.writeFileSync(configPath, JSON.stringify({ mcpServers: servers }));
  hub = await createHub({ externalUrl: ORIGIN, configPath, dataPath: path.join(dir, 'data'), password: PASSWORD, idleTimeoutMinutes: 0 });
  await hub.supervisor.waitUntilSettled();
  listen = hub.app.listen(0);
  baseUrl = `http://127.0.0.1:${(listen.address() as AddressInfo).port}`;
  tokens.a = await token('a', '/hub');
  tokens.b = await token('b', '/hub');
  tokens.whole = await token('whole', '/whole/mcp');
  tokens.hidden = await token('hidden', '/hidden/mcp');
}, 30_000);

afterAll(async () => {
  listen?.close();
  hub?.stopMaintenance();
  hub?.watcher.stop();
  await hub?.supervisor.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('a locked tool', () => {
  it('runs as before when the server does not lock it', async () => {
    const result = await hubCall(tokens.a.token, 'listed', 'echo', { message: 'hi' });
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain('hi');
  });

  it('answers with a link to the unlock page and a matching code instead of running', async () => {
    const result = await hubCall(tokens.a.token, 'listed', 'get-sum', { a: 1, b: 2 });
    expect(result.isError).toBe(true);
    expect(linkIn(result)).toBeDefined();
    expect(text(result)).toMatch(/matching code [A-Z2-9]{3}-[A-Z2-9]{3}/);
    expect(text(result)).not.toMatch(/sum of/i);
  });

  it('hands out the same link for the same ask while it is open', async () => {
    const first = await hubCall(tokens.a.token, 'listed', 'get-sum', { a: 1, b: 2 });
    const again = await hubCall(tokens.a.token, 'listed', 'get-sum', { b: 2, a: 1 });
    expect(linkIn(again)).toBe(linkIn(first));
  });

  it('refuses a name the server does not list, so a variant of a locked name cannot slip through', async () => {
    for (const name of ['GET-SUM', 'get-sum ', 'get-everything-else']) {
      expect(text(await hubCall(tokens.a.token, 'listed', name))).toContain(`Unknown tool "${name}"`);
    }
  });

  it('runs while the caller holds a window, and only for that caller', async () => {
    window(tokens.a.clientId, 'listed');
    expect(text(await hubCall(tokens.a.token, 'listed', 'get-sum', { a: 1, b: 2 }))).toContain('3');
    expect((await hubCall(tokens.b.token, 'listed', 'get-sum', { a: 1, b: 2 })).isError).toBe(true);
    hub.store.revokeUnlockGrants({ server: 'listed' });
    expect((await hubCall(tokens.a.token, 'listed', 'get-sum', { a: 1, b: 2 })).isError).toBe(true);
  });

  it('runs once on a single-call unlock with the same arguments, in any key order, and never twice', async () => {
    const add = (args: Record<string, unknown>) =>
      hub.store.addUnlockGrant({
        server: 'listed',
        clientId: tokens.b.clientId,
        kind: 'once',
        tool: 'get-sum',
        argsHash: argsHash(canonicalArgs(args)),
        grantedAt: Date.now(),
        expiresAt: Date.now() + 600_000,
        by: 'cli'
      });
    add({ a: 5, b: 6 });
    expect((await hubCall(tokens.b.token, 'listed', 'get-sum', { a: 5, b: 7 })).isError).toBe(true);
    expect(text(await hubCall(tokens.b.token, 'listed', 'get-sum', { b: 6, a: 5 }))).toContain('11');
    expect((await hubCall(tokens.b.token, 'listed', 'get-sum', { a: 5, b: 6 })).isError).toBe(true);

    add({ a: 2, b: 2 });
    const both = await Promise.all([1, 2].map(() => hubCall(tokens.b.token, 'listed', 'get-sum', { a: 2, b: 2 })));
    expect(both.filter(result => !result.isError)).toHaveLength(1);
  });
});

describe('a whole-locked server', () => {
  it('lists its tools but no resources or prompts, and serves none of them', async () => {
    const client = await connect('/whole/mcp', tokens.whole.token);
    try {
      expect((await client.listTools()).tools.length).toBeGreaterThan(0);
      expect((await client.listResources()).resources).toEqual([]);
      expect((await client.listPrompts()).prompts).toEqual([]);
      await expect(client.readResource({ uri: 'demo://resource/static/document/architecture.md' })).rejects.toThrow(/is locked/);
      const call = (await client.callTool({ name: 'echo', arguments: { message: 'x' } })) as CallToolResult;
      expect(call.isError).toBe(true);
      expect(linkIn(call)).toBeDefined();
    } finally {
      await client.close();
    }
  });

  it('opens everything for the caller once unlocked', async () => {
    window(tokens.whole.clientId, 'whole');
    const client = await connect('/whole/mcp', tokens.whole.token);
    try {
      expect((await client.listResources()).resources.length).toBeGreaterThan(0);
      expect(text((await client.callTool({ name: 'echo', arguments: { message: 'open' } })) as CallToolResult)).toContain('open');
    } finally {
      await client.close();
    }
  });

  it('is locked through its own door when it is hidden from /hub', async () => {
    const client = await connect('/hidden/mcp', tokens.hidden.token);
    try {
      const call = (await client.callTool({ name: 'echo', arguments: { message: 'x' } })) as CallToolResult;
      expect(call.isError).toBe(true);
      expect(linkIn(call)).toBeDefined();
    } finally {
      await client.close();
    }
  });
});

describe('a hub that cannot unlock', () => {
  it('says so instead of handing out a link, when no operator sign-in is usable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const noPassDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-gate-nopass-'));
    const configPath = path.join(noPassDir, 'mcp.json');
    fs.writeFileSync(configPath, JSON.stringify({ mcpServers: { listed: servers.listed } }));
    const locked = await createHub({ externalUrl: ORIGIN, configPath, dataPath: path.join(noPassDir, 'data'), idleTimeoutMinutes: 0 });
    try {
      await locked.supervisor.waitUntilSettled();
      const server = locked.app.listen(0);
      const minted = await mintApiToken(locked.store, ORIGIN, new URL('/listed/mcp', ORIGIN), 1, 'x');
      const client = new Client({ name: 'vitest', version: '0.0.0' });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/listed/mcp`), {
          requestInit: { headers: { Authorization: `Bearer ${minted.token}` } }
        })
      );
      const call = (await client.callTool({ name: 'get-sum', arguments: { a: 1, b: 1 } })) as CallToolResult;
      expect(call.isError).toBe(true);
      expect(text(call)).toContain('mcp-hub-admin unlock grant listed <minutes>');
      expect(linkIn(call)).toBeUndefined();
      expect(locked.unlockRuntime.pending()).toEqual([]);
      await client.close();
      server.close();
    } finally {
      locked.stopMaintenance();
      locked.watcher.stop();
      await locked.supervisor.stop();
      warn.mockRestore();
      fs.rmSync(noPassDir, { recursive: true, force: true });
    }
  });

  it('keeps a locked tool shut over stdio, where there is no page to unlock it on', async () => {
    const stdioDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-gate-stdio-'));
    const configPath = path.join(stdioDir, 'mcp.json');
    fs.writeFileSync(configPath, JSON.stringify({ mcpServers: { listed: servers.listed } }));
    const stdio = createStdioHub({ configPath, idleTimeoutMinutes: 0 });
    try {
      await stdio.supervisor.waitUntilSettled();
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await stdio.build('modern').connect(serverTransport);
      const client = new Client({ name: 'vitest', version: '0.0.0' });
      await client.connect(clientTransport);
      const locked = (await client.callTool({ name: 'call_tool', arguments: { server: 'listed', tool: 'get-sum', arguments: { a: 1, b: 1 } } })) as CallToolResult;
      expect(locked.isError).toBe(true);
      expect(text(locked)).toContain('cannot unlock it');
      const free = (await client.callTool({ name: 'call_tool', arguments: { server: 'listed', tool: 'echo', arguments: { message: 'ok' } } })) as CallToolResult;
      expect(text(free)).toContain('ok');
      await client.close();
    } finally {
      stdio.watcher.stop();
      await stdio.supervisor.stop();
      fs.rmSync(stdioDir, { recursive: true, force: true });
    }
  });
});
