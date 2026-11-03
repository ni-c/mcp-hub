import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { Client, StreamableHTTPClientTransport, withInputRequired } from '@modelcontextprotocol/client';
import { CallToolResultSchema } from '@modelcontextprotocol/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { mintApiToken } from '../src/auth/api-tokens.js';
import { createHub } from '../src/index.js';

const EVERYTHING = path.resolve('node_modules/@modelcontextprotocol/server-everything/dist/index.js');
const ORIGIN = 'http://localhost:3000';

type Hub = Awaited<ReturnType<typeof createHub>>;
let dir: string;
let hub: Hub;
let baseUrl: string;
let listen: ReturnType<Hub['app']['listen']>;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-unlock-elicit-'));
  const configPath = path.join(dir, 'mcp.json');
  fs.writeFileSync(configPath, JSON.stringify({ mcpServers: { locked: { command: process.execPath, args: [EVERYTHING], unlock: { tools: ['get-sum'] } } } }));
  hub = await createHub({ externalUrl: ORIGIN, configPath, dataPath: path.join(dir, 'data'), password: 'pw', idleTimeoutMinutes: 0 });
  await hub.supervisor.waitUntilSettled();
  listen = hub.app.listen(0);
  baseUrl = `http://127.0.0.1:${(listen.address() as AddressInfo).port}`;
}, 30_000);

afterAll(async () => {
  listen?.close();
  hub?.stopMaintenance();
  hub?.watcher.stop();
  await hub?.supervisor.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function connect(elicitation: { form?: Record<string, never>; url?: Record<string, never> } | undefined) {
  const minted = await mintApiToken(hub.store, ORIGIN, new URL('/locked/mcp', ORIGIN), 1, 'x');
  const client = new Client(
    { name: 'vitest', version: '0.0.0' },
    { capabilities: elicitation ? { elicitation } : {}, versionNegotiation: { mode: 'auto' }, inputRequired: { autoFulfill: false } }
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/locked/mcp`), { requestInit: { headers: { Authorization: `Bearer ${minted.token}` } } })
  );
  expect(client.getProtocolEra()).toBe('modern');
  return { client, clientId: `token:${minted.id}` };
}

const call = (client: Client, extra: Record<string, unknown> = {}) =>
  client.request(
    { method: 'tools/call', params: { name: 'get-sum', arguments: { a: 2, b: 3 }, ...extra } },
    withInputRequired(CallToolResultSchema),
    { allowInputRequired: true }
  ) as Promise<Record<string, unknown>>;

type Asked = { resultType?: string; inputRequests?: Record<string, { method: string; params: { mode: string; url: string; message: string } }> };

describe('the unlock question for a client that opens pages itself', () => {
  it('arrives as a URL-mode elicitation that names the hub, the server and the code', async () => {
    const { client } = await connect({ url: {} });
    const asked = (await call(client)) as Asked;
    expect(asked.resultType).toBe('input_required');
    const request = asked.inputRequests?.['mcp-hub-unlock'];
    expect(request?.method).toBe('elicitation/create');
    expect(request?.params.mode).toBe('url');
    expect(request?.params.url).toMatch(/^http:\/\/localhost:3000\/unlock\/r\/[\w-]+$/);
    expect(request?.params.message).toMatch(/^mcp-hub at localhost:3000 asks you to unlock server "locked" before "get-sum" runs\. The page shows the code [A-Z2-9]{3}-[A-Z2-9]{3}\.$/);
    await client.close();
  });

  it('runs on the retry once the person has unlocked', async () => {
    const { client, clientId } = await connect({ url: {} });
    expect(((await call(client)) as Asked).resultType).toBe('input_required');
    hub.store.addUnlockGrant({ server: 'locked', clientId, kind: 'window', grantedAt: Date.now(), expiresAt: Date.now() + 60_000, by: 'cli' });
    const done = await call(client, { inputResponses: { 'mcp-hub-unlock': { action: 'accept' } } });
    expect(JSON.stringify(done)).toContain('5');
    expect(done.isError).toBeFalsy();
    await client.close();
  });

  it('is told the user declined, and asks no second time while the link is open', async () => {
    const { client } = await connect({ url: {} });
    expect(((await call(client)) as Asked).resultType).toBe('input_required');
    const declined = await call(client, { inputResponses: { 'mcp-hub-unlock': { action: 'decline' } } });
    expect(JSON.stringify(declined)).toContain('declined to unlock');
    const again = await call(client);
    expect(again.resultType).toBeUndefined();
    expect(JSON.stringify(again)).toContain('/unlock/r/');
    await client.close();
  });
});

describe('the unlock question for any other client', () => {
  it.each([
    ['form-only elicitation', { form: {} }],
    ['no elicitation at all', undefined]
  ])('arrives as a text link with %s', async (_label, elicitation) => {
    const { client } = await connect(elicitation);
    const result = await call(client);
    expect(result.resultType).toBeUndefined();
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toMatch(/unlock\/r\/[\w-]+/);
    await client.close();
  });
});
