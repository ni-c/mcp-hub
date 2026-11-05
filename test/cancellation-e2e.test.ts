import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import express from 'express';
import request from 'supertest';
import { z } from 'zod';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { Client, InMemoryTransport, StreamableHTTPClientTransport, withInputRequired } from '@modelcontextprotocol/client';
import type { ClientOptions } from '@modelcontextprotocol/client';
import { CallToolResultSchema, ReadResourceResultSchema } from '@modelcontextprotocol/core';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { authorizeInBrowser, registerPublicClient } from './auth-flow.js';
import { createHub } from '../src/index.js';
import { createStdioHub } from '../src/stdio.js';
import { createRoute, handleMcpRequest } from '../src/proxy.js';
import { CLIENT_CANCELLED } from '../src/relay.js';

/**
 * A client giving up on a call, and the child hearing about it.
 *
 * Before #129 the hub never passed the client's cancellation on: the child
 * worked until it answered or the hub's five minutes ran out, holding whatever
 * it held — for imap-mcp a connection and the mailbox lock. Every door a
 * request can come through is covered here, on every era where the client's
 * cancellation can reach the hub at all, plus progress travelling the other way.
 */

const FIXTURE = path.resolve('test/fixtures/cancel-server.mjs');
const PASSWORD = 'test-password';
const REDIRECT_URI = 'http://localhost:33419/callback';

interface Event {
  at: number;
  event: string;
  what?: string;
  id?: number | string;
  requestId?: number | string;
  reason?: string;
  method?: string;
  name?: string;
  progressToken?: unknown;
  sawToken?: boolean;
}

let tmpDir: string;
let hub: Awaited<ReturnType<typeof createHub>>;
let httpServer: http.Server;
let upstreamServer: http.Server;
let baseUrl: string;
let token: string;
const remoteEvents: string[] = [];

const recordOf = (name: string) => path.join(tmpDir, `${name}.jsonl`);

function events(name: string): Event[] {
  const file = recordOf(name);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as Event);
}

async function waitFor<T>(probe: () => T | undefined | null | false, timeoutMs = 10_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > until) throw new Error(`waited ${timeoutMs} ms in vain`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function connect(pathname: string, era: 'legacy' | 'auto', options: ClientOptions = {}): Promise<Client> {
  const client = new Client({ name: 'cancel-test', version: '0.0.0' }, { ...options, versionNegotiation: { mode: era } });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}${pathname}`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } }
    })
  );
  expect(client.getProtocolEra()).toBe(era === 'auto' ? 'modern' : 'legacy');
  return client;
}

const toolCall = (name: string, args: Record<string, unknown> = {}) => ({ method: 'tools/call' as const, params: { name, arguments: args } });
const viaHub = (tool: string, args: Record<string, unknown> = {}) => toolCall('call_tool', { server: 'cancel', tool, arguments: args });

/** A 2025-era POST written by hand, so a test can drop its socket mid-call. */
function rawLegacyPost(pathname: string, body: unknown): http.ClientRequest {
  const req = http.request(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-11-25'
    }
  });
  req.on('error', () => {});
  req.end(JSON.stringify(body));
  return req;
}

/** The first `started` event for `what` that is newer than `since`. */
function startedSince(name: string, what: string, since: number): Promise<Event> {
  return waitFor(() => events(name).find(e => e.event === 'started' && e.what === what && e.at >= since));
}

/** Waits until the child saw its call aborted, and returns that event plus every cancellation naming it. */
async function abortedAtChild(name: string, started: Event) {
  const aborted = await waitFor(() => events(name).find(e => e.event === 'aborted' && e.id === started.id));
  const cancels = events(name).filter(e => e.event === 'cancel' && e.requestId === started.id);
  return { aborted, cancels };
}

function startRemoteUpstream(): Promise<number> {
  const app = express();
  app.use(express.json());
  const route = createRoute(
    () => {
      const server = new McpServer({ name: 'remote-cancel-fixture', version: '1.0.0' });
      server.registerTool('remote_wait', { description: 'Waits until cancelled.', inputSchema: z.object({}) }, async (_args, ctx) => {
        remoteEvents.push('started');
        await new Promise<void>(resolve => {
          if (ctx.mcpReq.signal.aborted) return resolve();
          ctx.mcpReq.signal.addEventListener('abort', () => resolve(), { once: true });
          setTimeout(resolve, 20_000);
        });
        remoteEvents.push(ctx.mcpReq.signal.aborted ? 'aborted' : 'not-cancelled');
        return { content: [{ type: 'text', text: 'done' }] };
      });
      return server.server;
    },
    { label: 'remote-cancel-fixture' }
  );
  app.all('/mcp', (req, res) => void handleMcpRequest(route, req, res));
  return new Promise(resolve => {
    upstreamServer = app.listen(0, () => resolve((upstreamServer.address() as AddressInfo).port));
  });
}

let logs: MockInstance<typeof console.log>;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-cancel-'));
  const upstreamPort = await startRemoteUpstream();
  const configPath = path.join(tmpDir, 'mcp.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      mcpServers: {
        cancel: { command: process.execPath, args: [FIXTURE], env: { CANCEL_RECORD: recordOf('cancel') } },
        // Slow to come up, so a test can act while the hub is still waking it.
        slow: { command: process.execPath, args: [FIXTURE], env: { CANCEL_RECORD: recordOf('slow'), START_DELAY_MS: '1500' } },
        remote: { type: 'http', url: `http://127.0.0.1:${upstreamPort}/mcp` }
      }
    })
  );
  hub = await createHub({
    externalUrl: 'http://localhost:3000',
    configPath,
    dataPath: path.join(tmpDir, 'data'),
    password: PASSWORD,
    requireResourceBoundTokens: false,
    // On demand, so a test can put a child to sleep; never idle enough to meet the sweep.
    idleTimeoutMinutes: 60
  });
  await hub.supervisor.waitUntilSettled();
  httpServer = hub.app.listen(0);
  baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;

  const clientId = await registerPublicClient(hub.app, REDIRECT_URI);
  const { code, verifier } = await authorizeInBrowser(hub.app, clientId, { password: PASSWORD, redirectUri: REDIRECT_URI });
  const tokens = await request(hub.app)
    .post('/token')
    .type('form')
    .send({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT_URI })
    .expect(200);
  token = tokens.body.access_token as string;
}, 30_000);

afterAll(async () => {
  httpServer?.close();
  upstreamServer?.close();
  hub?.watcher.stop();
  await hub?.supervisor.stop();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  logs = vi.spyOn(console, 'log');
});

afterEach(() => {
  vi.restoreAllMocks();
});

const cancelLines = () => logs.mock.calls.map(call => String(call[0])).filter(line => line.includes('client cancelled'));

describe('a cancelled call is cancelled at the child', () => {
  it.each([
    ['/cancel/mcp', toolCall('wait_for_cancel')],
    ['/hub', viaHub('wait_for_cancel')]
  ])('through %s on 2026-07-28', async (pathname, call) => {
    const client = await connect(pathname, 'auto');
    const since = Date.now();
    const abort = new AbortController();
    const pending = client.request(call, CallToolResultSchema, { signal: abort.signal });

    const started = await startedSince('cancel', 'wait_for_cancel', since);
    abort.abort();
    await expect(pending).rejects.toThrow();

    const { aborted, cancels } = await abortedAtChild('cancel', started);
    expect(aborted.reason).toBe(CLIENT_CANCELLED);
    expect(cancels).toHaveLength(1);
    expect(cancels[0].reason).toBe(CLIENT_CANCELLED);
    await waitFor(() => hub.supervisor.get('cancel')!.inFlight === 0);
    await waitFor(() => cancelLines().length === 1);
    expect(cancelLines()[0]).toMatch(/^\[cancel\] client cancelled tools\/call "wait_for_cancel" after \d+(\.\d)?s$/);
    await client.close();
  }, 30_000);

  it('through a 2025-era POST whose connection drops', async () => {
    // The one way a 2025 client's cancellation reaches a stateless hub: its own
    // notifications/cancelled arrives on a fresh POST and names a call that
    // instance never saw.
    const since = Date.now();
    const req = rawLegacyPost('/cancel/mcp', { jsonrpc: '2.0', id: 1, ...toolCall('wait_for_cancel') });
    const started = await startedSince('cancel', 'wait_for_cancel', since);
    req.destroy();

    const { aborted, cancels } = await abortedAtChild('cancel', started);
    expect(aborted.reason).toBe(CLIENT_CANCELLED);
    expect(cancels).toHaveLength(1);
    await waitFor(() => hub.supervisor.get('cancel')!.inFlight === 0);
  }, 30_000);

  it('through a resources/read', async () => {
    const client = await connect('/cancel/mcp', 'auto');
    const since = Date.now();
    const abort = new AbortController();
    const pending = client.request({ method: 'resources/read', params: { uri: 'slow://wait' } }, ReadResourceResultSchema, { signal: abort.signal });

    const started = await startedSince('cancel', 'slow://wait', since);
    abort.abort();
    await expect(pending).rejects.toThrow();

    const { aborted } = await abortedAtChild('cancel', started);
    expect(aborted.reason).toBe(CLIENT_CANCELLED);
    await waitFor(() => cancelLines().length === 1);
    expect(cancelLines()[0]).toMatch(/^\[cancel\] client cancelled resources\/read after/);
    await client.close();
  }, 30_000);

  it('through a remote 2026-era upstream, by closing the request stream', async () => {
    remoteEvents.length = 0;
    const client = await connect('/remote/mcp', 'auto');
    const abort = new AbortController();
    const pending = client.request(toolCall('remote_wait'), CallToolResultSchema, { signal: abort.signal });

    await waitFor(() => remoteEvents.includes('started'));
    abort.abort();
    await expect(pending).rejects.toThrow();

    await waitFor(() => remoteEvents.includes('aborted'));
    expect(remoteEvents).not.toContain('not-cancelled');
    await waitFor(() => hub.supervisor.get('remote')!.inFlight === 0);
    await client.close();
  }, 30_000);

  it('cancels only the round of an input-required exchange it was sent in', async () => {
    const client = await connect('/cancel/mcp', 'auto', {
      capabilities: { elicitation: { form: {} } },
      inputRequired: { autoFulfill: false }
    });
    const options = { allowInputRequired: true } as const;
    const asked = (await client.request(toolCall('ask_then_wait', { wait: true }), withInputRequired(CallToolResultSchema), options)) as {
      resultType?: string;
      requestState?: string;
    };
    expect(asked.resultType).toBe('input_required');
    const answer = { inputResponses: { go: { action: 'accept', content: { go: true } } }, requestState: asked.requestState };

    const since = Date.now();
    const abort = new AbortController();
    const round = client.request(
      { method: 'tools/call', params: { name: 'ask_then_wait', arguments: { wait: true }, ...answer } },
      withInputRequired(CallToolResultSchema),
      { ...options, signal: abort.signal }
    );
    const started = await startedSince('cancel', 'ask_then_wait', since);
    abort.abort();
    await expect(round).rejects.toThrow();
    const { aborted } = await abortedAtChild('cancel', started);
    expect(aborted.reason).toBe(CLIENT_CANCELLED);

    // The state the hub sealed for this exchange is still good for another attempt.
    const again = await client.request(
      { method: 'tools/call', params: { name: 'ask_then_wait', arguments: { wait: false }, ...answer } },
      withInputRequired(CallToolResultSchema),
      options
    );
    expect(JSON.stringify(again)).toContain('answered');
    await client.close();
  }, 30_000);
});

describe('what is not cancelled', () => {
  it('sends no cancellation for a call that completes, and logs nothing', async () => {
    const client = await connect('/cancel/mcp', 'auto');
    const since = Date.now();
    const result = await client.request(toolCall('quick'), CallToolResultSchema);
    expect(JSON.stringify(result)).toContain('quick');

    const sent = await waitFor(() => events('cancel').find(e => e.event === 'request' && e.name === 'quick' && e.at >= since));
    await pause(300);
    expect(events('cancel').filter(e => e.event === 'cancel' && e.requestId === sent.id)).toEqual([]);
    expect(hub.supervisor.get('cancel')!.inFlight).toBe(0);
    expect(cancelLines()).toEqual([]);
    await client.close();
  }, 30_000);

  it('never sends a call whose client left while the child was waking', async () => {
    const managed = hub.supervisor.get('slow')!;
    await managed.sleep();
    const since = Date.now();
    const client = await connect('/slow/mcp', 'auto');
    const abort = new AbortController();
    const pending = client.request(toolCall('wait_for_cancel'), CallToolResultSchema, { signal: abort.signal });

    await waitFor(() => managed.state === 'starting');
    abort.abort();
    await expect(pending).rejects.toThrow();
    await waitFor(() => managed.state === 'up');
    await pause(500);

    expect(events('slow').filter(e => e.event === 'request' && e.at >= since)).toEqual([]);
    expect(managed.inFlight).toBe(0);
    expect(cancelLines()).toEqual([]);
    await client.close();
  }, 30_000);

  it('never dispatches a 2025 POST whose socket closed during a first-ever wake', async () => {
    const managed = hub.supervisor.get('slow')!;
    await managed.sleep();
    // As on a first-ever run: nothing cached, so the route blocks on the wake before dispatching.
    managed.serverInfo = undefined;
    managed.tools = [];
    const since = Date.now();
    const req = rawLegacyPost('/slow/mcp', { jsonrpc: '2.0', id: 1, ...toolCall('wait_for_cancel') });

    await waitFor(() => managed.state === 'starting');
    req.destroy();
    await waitFor(() => managed.state === 'up');
    await pause(500);

    expect(events('slow').filter(e => e.event === 'request' && e.at >= since)).toEqual([]);
  }, 30_000);
});

describe('progress travels back', () => {
  it.each([
    ['/cancel/mcp', 'auto', toolCall('report_progress', { count: 3, intervalMs: 300 })],
    ['/cancel/mcp', 'legacy', toolCall('report_progress', { count: 3, intervalMs: 300 })],
    ['/hub', 'auto', viaHub('report_progress', { count: 3, intervalMs: 300 })],
    ['/hub', 'legacy', viaHub('report_progress', { count: 3, intervalMs: 300 })]
  ] as const)('through %s on era %s, under the client token, with the child text cleaned', async (pathname, era, call) => {
    const client = await connect(pathname, era);
    const seen: Array<{ progress: number; total?: number; message?: string }> = [];
    await client.request(call, CallToolResultSchema, { onprogress: progress => seen.push(progress) });

    expect(seen.map(p => p.progress)).toEqual([1, 2, 3]);
    expect(seen[0]).toMatchObject({ total: 3, message: 'step 1 of 3' });
    await client.close();
  }, 30_000);

  it('drops what arrives faster than four a second', async () => {
    const client = await connect('/cancel/mcp', 'auto');
    const seen: number[] = [];
    // 20 ms apart, so every message reaches the hub on its own: the SDK client runs progress
    // handlers a microtask late, and a progress that shares a chunk with the result is lost.
    await client.request(toolCall('report_progress', { count: 5, intervalMs: 20 }), CallToolResultSchema, {
      onprogress: progress => seen.push(progress.progress)
    });
    expect(seen).toEqual([1]);
    await client.close();
  }, 30_000);

  it('through a resources/read', async () => {
    const client = await connect('/cancel/mcp', 'auto');
    const seen: number[] = [];
    await client.request({ method: 'resources/read', params: { uri: 'slow://progress' } }, ReadResourceResultSchema, {
      onprogress: progress => seen.push(progress.progress)
    });
    expect(seen).toEqual([1, 2, 3]);
    await client.close();
  }, 30_000);

  it('answers a 2025 POST that asks for progress as a stream', async () => {
    const response = await fetch(`${baseUrl}/cancel/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2025-11-25'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'report_progress', arguments: { count: 2, intervalMs: 300 }, _meta: { progressToken: 'tok' } }
      })
    });
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const body = await response.text();
    expect(body).toContain('"method":"notifications/progress"');
    expect(body).toContain('"progressToken":"tok"');
    expect(body).toContain('reported');
  }, 30_000);

  it('leaves a call that asks for nothing untouched, and its 2025 answer JSON', async () => {
    const since = Date.now();
    const response = await fetch(`${baseUrl}/cancel/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2025-11-25'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...toolCall('report_progress', { count: 2, intervalMs: 0 }) })
    });
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.text()).toContain('reported');
    const call = await waitFor(() => events('cancel').find(e => e.event === 'progress-call' && e.at >= since));
    expect(call.sawToken).toBe(false);
  }, 30_000);
});

describe('mcp-hub-stdio', () => {
  let stdioDir: string;
  let stdioHub: ReturnType<typeof createStdioHub>;

  beforeAll(async () => {
    stdioDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-cancel-stdio-'));
    const configPath = path.join(stdioDir, 'mcp.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: { cancel: { command: process.execPath, args: [FIXTURE], env: { CANCEL_RECORD: path.join(stdioDir, 'cancel.jsonl') } } }
      })
    );
    stdioHub = createStdioHub({ configPath, idleTimeoutMinutes: 0 });
    await stdioHub.supervisor.waitUntilSettled();
  }, 30_000);

  afterAll(async () => {
    stdioHub?.watcher.stop();
    await stdioHub?.supervisor.stop();
    fs.rmSync(stdioDir, { recursive: true, force: true });
  });

  async function connectStdio(era: 'legacy' | 'auto') {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const handle = serveStdio(ctx => stdioHub.build(ctx.era), { transport: serverTransport });
    const client = new Client({ name: 'cancel-test', version: '0.0.0' }, { versionNegotiation: { mode: era } });
    await client.connect(clientTransport);
    expect(client.getProtocolEra()).toBe(era === 'auto' ? 'modern' : 'legacy');
    return {
      client,
      close: async () => {
        await client.close();
        await handle.close();
      }
    };
  }

  const stdioEvents = () =>
    fs
      .readFileSync(path.join(stdioDir, 'cancel.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as Event);

  it.each(['legacy', 'auto'] as const)('carries notifications/cancelled on era %s', async era => {
    const { client, close } = await connectStdio(era);
    const since = Date.now();
    const abort = new AbortController();
    const pending = client.request(viaHub('wait_for_cancel'), CallToolResultSchema, { signal: abort.signal });

    const started = await waitFor(() => fs.existsSync(path.join(stdioDir, 'cancel.jsonl')) && stdioEvents().find(e => e.event === 'started' && e.at >= since));
    abort.abort();
    await expect(pending).rejects.toThrow();

    const aborted = await waitFor(() => stdioEvents().find(e => e.event === 'aborted' && e.id === started.id));
    expect(aborted.reason).toBe(CLIENT_CANCELLED);
    await waitFor(() => stdioHub.supervisor.get('cancel')!.inFlight === 0);
    await close();
  }, 30_000);

  it('carries progress', async () => {
    const { client, close } = await connectStdio('auto');
    const seen: number[] = [];
    await client.request(viaHub('report_progress', { count: 3, intervalMs: 300 }), CallToolResultSchema, {
      onprogress: progress => seen.push(progress.progress)
    });
    expect(seen).toEqual([1, 2, 3]);
    await close();
  }, 30_000);
});

/** What /health reports as a server's calls in flight. */
async function inFlight(server: string): Promise<number> {
  const response = await request(hub.app).get('/health').set('Authorization', `Bearer ${token}`);
  return (response.body as { servers: Record<string, { inFlight: number }> }).servers[server].inFlight;
}

describe('/health', () => {
  it('counts the calls a server has in flight, and stops counting one its client cancelled', async () => {
    expect(await inFlight('cancel')).toBe(0);
    const client = await connect('/cancel/mcp', 'auto');
    const since = Date.now();
    const abort = new AbortController();
    const pending = client.request(toolCall('wait_for_cancel'), CallToolResultSchema, { signal: abort.signal });
    await startedSince('cancel', 'wait_for_cancel', since);
    expect(await inFlight('cancel')).toBe(1);

    abort.abort();
    await expect(pending).rejects.toThrow();
    const until = Date.now() + 5_000;
    while ((await inFlight('cancel')) !== 0) {
      if (Date.now() > until) throw new Error('inFlight never went back to 0');
      await pause(25);
    }
    await client.close();
  }, 30_000);
});
