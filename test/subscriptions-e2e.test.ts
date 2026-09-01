import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { McpSubscription } from '@modelcontextprotocol/client';

import { authorizeInBrowser, registerPublicClient } from './auth-flow.js';
import { createHub } from '../src/index.js';

/**
 * A child's change notifications reaching the client that asked for them.
 *
 * The counterpart to elicitation-e2e: that file proves a question can travel
 * out and an answer back; this one proves the hub can push at all, which it
 * could not before. Every row the capability table gained has a case here,
 * including the ones that say "no".
 */

const FIXTURE = path.resolve('test/fixtures/modern-notify-server.mjs');
/** SDK 1.30, so it speaks the 2025 era and only knows `resources/subscribe`. */
const EVERYTHING = path.resolve('node_modules/@modelcontextprotocol/server-everything/dist/index.js');
const PASSWORD = 'test-password';
const REDIRECT_URI = 'http://localhost:33418/callback';
const WATCHED = 'test://watched';
const OTHER = 'test://other';

let tmpDir: string;
let hub: Awaited<ReturnType<typeof createHub>>;
let httpServer: ReturnType<Awaited<ReturnType<typeof createHub>>['app']['listen']>;
let baseUrl: string;
let token: string;

/** What one connected client saw, in arrival order. */
interface Watcher {
  client: Client;
  seen: string[];
  subscription?: McpSubscription;
  close(): Promise<void>;
}

async function connect(pathname: string, era: 'modern' | 'legacy' = 'modern'): Promise<Client> {
  const client = new Client(
    { name: 'listening-client', version: '0.0.0' },
    { versionNegotiation: era === 'modern' ? { mode: 'auto' } : { mode: 'legacy' } }
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}${pathname}`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } }
    })
  );
  expect(client.getProtocolEra()).toBe(era);
  return client;
}

/**
 * A client with the four handlers registered before it listens.
 *
 * Registered first on purpose: `listen()` resolves on the acknowledgment, and
 * a notification may follow it immediately — a handler attached afterwards
 * would race the first event it was supposed to see.
 */
async function watch(pathname: string, filter: Record<string, unknown>): Promise<Watcher> {
  const client = await connect(pathname);
  const seen: string[] = [];
  client.setNotificationHandler('notifications/tools/list_changed', () => void seen.push('tools'));
  client.setNotificationHandler('notifications/prompts/list_changed', () => void seen.push('prompts'));
  client.setNotificationHandler('notifications/resources/list_changed', () => void seen.push('resources'));
  client.setNotificationHandler('notifications/resources/updated', n => void seen.push(`updated:${n.params.uri}`));
  const subscription = await client.listen(filter);
  const watcher: Watcher = {
    client,
    seen,
    subscription,
    close: async () => {
      await subscription.close().catch(() => {});
      await client.close().catch(() => {});
    }
  };
  return watcher;
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Trigger something, then wait for it to show up.
 *
 * Retried rather than awaited once: the hub establishes its own upstream
 * subscription off the request path, so a trigger fired immediately after the
 * acknowledgment can legitimately land before the hub is listening upstream.
 * Retrying is what a client would do; a fixed sleep would only hide the race.
 */
async function until(seen: string[], want: string, trigger: () => Promise<unknown>, attempts = 12): Promise<string[]> {
  for (let i = 0; i < attempts; i++) {
    await trigger();
    // Comfortably past the 250ms coalescing window.
    await sleep(400);
    if (seen.includes(want)) return seen;
  }
  throw new Error(`never saw "${want}"; saw [${seen.join(', ')}]`);
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-subs-'));
  const configPath = path.join(tmpDir, 'mcp.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      mcpServers: {
        notify: { command: process.execPath, args: [FIXTURE], keepAlive: true },
        // Same fixture, allowed to sleep, so the nap-and-resync case is real.
        napper: { command: process.execPath, args: [FIXTURE], idleMinutes: 1 },
        // The operator's off switch: reachable, useful, and not allowed to push.
        quiet: { command: process.execPath, args: [FIXTURE], subscriptions: 'off', keepAlive: true },
        // A child stuck on the old era, to prove the hub bridges the two.
        legacychild: { command: process.execPath, args: [EVERYTHING], keepAlive: true }
      }
    })
  );
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
  hub?.watcher.stop();
  await hub?.supervisor.stop();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('what the hub announces', () => {
  it('offers listChanged and subscribe on the era that carries them', async () => {
    const client = await connect('/notify/mcp');
    const caps = client.getServerCapabilities();
    expect(caps?.tools?.listChanged).toBe(true);
    expect(caps?.resources?.listChanged).toBe(true);
    expect(caps?.resources?.subscribe).toBe(true);
    await client.close();
  });

  it('offers neither to a 2025 client, which has no way to receive them', async () => {
    const client = await connect('/notify/mcp', 'legacy');
    const caps = client.getServerCapabilities();
    expect(caps?.tools?.listChanged).toBeUndefined();
    expect(caps?.resources?.listChanged).toBeUndefined();
    expect(caps?.resources?.subscribe).toBeUndefined();
    await client.close();
  });

  it('never offers logging, on either era, because setLevel has no handler', async () => {
    for (const era of ['modern', 'legacy'] as const) {
      const client = await connect('/notify/mcp', era);
      expect(client.getServerCapabilities()?.logging).toBeUndefined();
      await client.close();
    }
  });

  it('offers nothing for a server the operator switched off', async () => {
    const client = await connect('/quiet/mcp');
    const caps = client.getServerCapabilities();
    expect(caps?.tools?.listChanged).toBeUndefined();
    expect(caps?.resources?.subscribe).toBeUndefined();
    await client.close();
  });
});

describe('delivery', () => {
  it('carries a tool-list change through to a subscriber', async () => {
    const watcher = await watch('/notify/mcp', { toolsListChanged: true });
    await until(watcher.seen, 'tools', () =>
      watcher.client.callTool({ name: 'announce_tools_changed', arguments: {} })
    );
    await watcher.close();
  }, 30_000);

  it('carries a resource update, and only to whoever named that URI', async () => {
    const watching = await watch('/notify/mcp', { resourceSubscriptions: [WATCHED] });
    const elsewhere = await watch('/notify/mcp', { resourceSubscriptions: [OTHER] });
    await until(watching.seen, `updated:${WATCHED}`, () =>
      watching.client.callTool({ name: 'touch_resource', arguments: { uri: WATCHED } })
    );
    // The other subscriber named a different URI and must have been left out of
    // every one of those rounds — the case a reference count gets wrong.
    expect(elsewhere.seen).toEqual([]);
    await elsewhere.close();
    await watching.close();
  }, 30_000);

  it('keeps delivering to one client after another unsubscribes', async () => {
    const staying = await watch('/notify/mcp', { resourceSubscriptions: [WATCHED] });
    const leaving = await watch('/notify/mcp', { resourceSubscriptions: [WATCHED] });
    await leaving.close();
    await sleep(200);
    await until(staying.seen, `updated:${WATCHED}`, () =>
      staying.client.callTool({ name: 'touch_resource', arguments: { uri: WATCHED } })
    );
    await staying.close();
  }, 30_000);

  it('delivers nothing for a server the operator switched off', async () => {
    const watcher = await watch('/quiet/mcp', { toolsListChanged: true });
    for (let i = 0; i < 3; i++) {
      await watcher.client.callTool({ name: 'announce_tools_changed', arguments: {} });
      await sleep(400);
    }
    expect(watcher.seen).toEqual([]);
    await watcher.close();
  }, 30_000);

  it('relays a child tool-list change to the /hub aggregate', async () => {
    const watcher = await watch('/hub/mcp', { toolsListChanged: true });
    const driver = await connect('/notify/mcp');
    await until(watcher.seen, 'tools', () => driver.callTool({ name: 'announce_tools_changed', arguments: {} }));
    await driver.close();
    await watcher.close();
  }, 30_000);
});

describe('limits', () => {
  it('refuses a filter naming more URIs than the hub will hold', async () => {
    const uris = Array.from({ length: 65 }, (_, i) => `test://bulk/${i}`);
    const response = await request(hub.app)
      .post('/notify/mcp')
      .set('Authorization', `Bearer ${token}`)
      .set('MCP-Protocol-Version', '2026-07-28')
      .set('Accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'subscriptions/listen',
        params: {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientInfo': { name: 'bulk', version: '0.0.0' },
            'io.modelcontextprotocol/clientCapabilities': {}
          },
          notifications: { resourceSubscriptions: uris }
        }
      });
    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/at most 64 resource URIs/);
  });
});

describe('sleeping children', () => {
  it('answers a subscription without waking the child, then resyncs when it wakes', async () => {
    const napper = hub.supervisor.get('napper');
    // Put it to sleep first, so the subscription is genuinely taken against a
    // server that holds no connection at all.
    await napper?.sleep();
    expect(napper?.state).toBe('sleeping');

    const watcher = await watch('/napper/mcp', { toolsListChanged: true, resourceSubscriptions: [WATCHED] });
    // The acknowledgment came from the cached capabilities. Waking here would
    // have undone on-demand for every server anyone ever watched.
    expect(napper?.state).toBe('sleeping');

    // Anything that is real usage wakes it, and the wake is what replays the
    // subscription upstream and tells the client to read everything again.
    await watcher.client.callTool({ name: 'announce_tools_changed', arguments: {} });
    await sleep(600);
    expect(napper?.state).toBe('up');
    expect(watcher.seen).toContain('tools');
    expect(watcher.seen).toContain(`updated:${WATCHED}`);
    await watcher.close();
  }, 30_000);
});


describe('a child on the old era', () => {
  it('has its updates carried to a client on the new one', async () => {
    // The half of this feature that is not symmetrical. `server-everything` is
    // built on SDK 1.30: it has never heard of `subscriptions/listen` and can
    // only be asked with `resources/subscribe`, which the 2026 revision removed.
    // The hub asks it the way it understands, and delivers what comes back on
    // the stream the modern client is holding — so the era gap is the hub's
    // problem rather than either end's.
    const client = await connect('/legacychild/mcp');
    expect(client.getServerCapabilities()?.resources?.subscribe).toBe(true);

    const uri = 'test://static/resource/1';
    const seen: string[] = [];
    client.setNotificationHandler('notifications/resources/updated', n => void seen.push(`updated:${n.params.uri}`));
    const subscription = await client.listen({ resourceSubscriptions: [uri] });

    // Starts the fixture's simulated updates for whatever it has been asked to
    // watch — which, thanks to the hub, includes the URI above.
    await until(seen, `updated:${uri}`, () => client.callTool({ name: 'toggle-subscriber-updates', arguments: {} }), 4);

    await subscription.close();
    await client.close();
  }, 40_000);
});
