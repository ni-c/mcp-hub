import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

import { authorizeInBrowser, registerPublicClient } from './auth-flow.js';
import { createHub } from '../src/index.js';

/**
 * The hub answers both protocol eras from one endpoint.
 *
 * The point of these tests is not that the modern era works — it is that a
 * client cannot tell which era it is on by what it gets back. Same tools, same
 * names, same endpoint. The era is a wire detail; the surface is the contract.
 */

const EVERYTHING = path.resolve('node_modules/@modelcontextprotocol/server-everything/dist/index.js');
const PASSWORD = 'test-password';
const REDIRECT_URI = 'http://localhost:33418/callback';

let tmpDir: string;
let hub: Awaited<ReturnType<typeof createHub>>;
let httpServer: ReturnType<Awaited<ReturnType<typeof createHub>>['app']['listen']>;
let baseUrl: string;
let token: string;

/**
 * A client on the era of its choosing, connected to one of the hub's routes.
 *
 * The era it ended up on is asserted here rather than left implicit. `mode:
 * 'auto'` falls back to the legacy era whenever the modern probe fails — so
 * without this check every test below would pass just as happily against a hub
 * that does not speak 2026 at all, which is the one thing they exist to prove.
 */
async function connect(pathname: string, era: 'legacy' | 'auto'): Promise<Client> {
  const client = new Client(
    { name: 'dual-era-test', version: '0.0.0' },
    { versionNegotiation: { mode: era } }
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}${pathname}`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } }
    })
  );
  expect(client.getProtocolEra(), `${pathname} negotiated with mode=${era}`).toBe(
    era === 'auto' ? 'modern' : 'legacy'
  );
  return client;
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-dual-era-'));
  const configPath = path.join(tmpDir, 'mcp.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({ mcpServers: { everything: { command: process.execPath, args: [EVERYTHING] } } })
  );
  hub = await createHub({
    externalUrl: 'http://localhost:3000',
    configPath,
    dataPath: path.join(tmpDir, 'data'),
    password: PASSWORD,
    requireResourceBoundTokens: false,
    idleTimeoutMinutes: 0
  });
  await hub.supervisor.waitUntilSettled();
  httpServer = hub.app.listen(0);
  baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;

  const clientId = await registerPublicClient(hub.app, REDIRECT_URI);
  const { code, verifier } = await authorizeInBrowser(hub.app, clientId, {
    password: PASSWORD,
    redirectUri: REDIRECT_URI
  });
  const tokens = await request(hub.app)
    .post('/token')
    .type('form')
    .send({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT_URI })
    .expect(200);
  token = tokens.body.access_token as string;
}, 30_000);

afterAll(async () => {
  httpServer?.close();
  hub?.watcher.stop();
  await hub?.supervisor.stop();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('both protocol eras from one endpoint', () => {
  it('serves the same tool list to a 2025 client and a 2026 client', async () => {
    const legacy = await connect('/everything/mcp', 'legacy');
    const modern = await connect('/everything/mcp', 'auto');

    const legacyNames = (await legacy.listTools()).tools.map(t => t.name).sort();
    const modernNames = (await modern.listTools()).tools.map(t => t.name).sort();

    expect(legacyNames.length).toBeGreaterThan(0);
    expect(modernNames).toEqual(legacyNames);

    await legacy.close();
    await modern.close();
  }, 30_000);

  it('answers the aggregate endpoint on both eras too', async () => {
    // /hub is a different construction from /<name>/mcp — a high-level
    // McpServer rather than a forwarding one — and goes through the same choke
    // point, so it needs its own assertion rather than an assumption.
    const legacy = await connect('/hub', 'legacy');
    const modern = await connect('/hub', 'auto');

    const legacyNames = (await legacy.listTools()).tools.map(t => t.name).sort();
    const modernNames = (await modern.listTools()).tools.map(t => t.name).sort();

    expect(legacyNames).toContain('list_servers');
    expect(modernNames).toEqual(legacyNames);

    await legacy.close();
    await modern.close();
  }, 30_000);

  it('calls a tool identically on both eras', async () => {
    const legacy = await connect('/everything/mcp', 'legacy');
    const modern = await connect('/everything/mcp', 'auto');

    const args = { name: 'echo', arguments: { message: 'same on both' } };
    const fromLegacy = await legacy.callTool(args);
    const fromModern = await modern.callTool(args);

    expect(JSON.stringify(fromModern.content)).toBe(JSON.stringify(fromLegacy.content));

    await legacy.close();
    await modern.close();
  }, 30_000);

  it('reads resources identically on both eras', async () => {
    // Every row of the capability matrix in docs/reference/standards.md has a
    // test, and this is the resources row. Listing, templates and a read, all
    // three, because the proxy registers them as three separate handlers.
    const legacy = await connect('/everything/mcp', 'legacy');
    const modern = await connect('/everything/mcp', 'auto');

    const uri = (await legacy.listResources()).resources[0].uri;
    expect((await modern.listResources()).resources[0].uri).toBe(uri);
    expect(JSON.stringify((await modern.listResourceTemplates()).resourceTemplates)).toBe(
      JSON.stringify((await legacy.listResourceTemplates()).resourceTemplates)
    );
    expect(JSON.stringify((await modern.readResource({ uri })).contents)).toBe(
      JSON.stringify((await legacy.readResource({ uri })).contents)
    );

    await legacy.close();
    await modern.close();
  }, 30_000);

  it('gets prompts identically on both eras', async () => {
    const legacy = await connect('/everything/mcp', 'legacy');
    const modern = await connect('/everything/mcp', 'auto');

    const names = (await legacy.listPrompts()).prompts.map(p => p.name).sort();
    expect(names.length).toBeGreaterThan(0);
    expect((await modern.listPrompts()).prompts.map(p => p.name).sort()).toEqual(names);

    const args = { name: 'args-prompt', arguments: { city: 'Luxembourg' } };
    expect(JSON.stringify((await modern.getPrompt(args)).messages)).toBe(
      JSON.stringify((await legacy.getPrompt(args)).messages)
    );

    await legacy.close();
    await modern.close();
  }, 30_000);

  it('completes an argument identically on both eras', async () => {
    const legacy = await connect('/everything/mcp', 'legacy');
    const modern = await connect('/everything/mcp', 'auto');

    const args = {
      ref: { type: 'ref/prompt' as const, name: 'completable-prompt' },
      argument: { name: 'department', value: '' }
    };
    const fromLegacy = await legacy.complete(args);
    expect(fromLegacy.completion.values.length).toBeGreaterThan(0);
    expect(JSON.stringify((await modern.complete(args)).completion)).toBe(
      JSON.stringify(fromLegacy.completion)
    );

    await legacy.close();
    await modern.close();
  }, 30_000);

  it('sends a broken modern request to the modern handler, not to the legacy one', async () => {
    // The routing predicate is one-way by contract: everything it calls false
    // belongs to the modern path, "including its validation-ladder rejections".
    // A request whose header names a modern revision but that carries no
    // envelope is exactly such a case — it must come back as the modern
    // handler's -32602, not be quietly served as 2025 traffic.
    const response = await request(hub.app)
      .post('/hub')
      .set('Authorization', `Bearer ${token}`)
      .set('MCP-Protocol-Version', '2026-07-28')
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

    expect(response.body.error?.code, JSON.stringify(response.body)).toBe(-32602);
  });

  it('still answers a 2025 GET with an open stream rather than 405', async () => {
    // The modern handler's own `legacy: 'stateless'` fallback would answer 405
    // here. claude.ai opens this stream on every reconnect, so the hub keeps
    // serving it from the transport that always did — see handleLegacyRequest.
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 1_000);
    let opened = false;
    try {
      const response = await fetch(`${baseUrl}/hub`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
        signal: abort.signal
      });
      opened = response.status === 200 && response.headers.get('content-type') === 'text/event-stream';
      await response.body?.cancel();
    } catch {
      // Aborting a held-open stream is the pass condition too.
      opened = true;
    }
    clearTimeout(timer);
    expect(opened).toBe(true);
  }, 20_000);
});
