import path from 'node:path';

import type { CallToolResult, ListToolsResult } from '@modelcontextprotocol/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { ClientPool } from '../harness/client.js';
import { startGateway, type Gateway } from '../harness/gateway.js';
import { tiersFor, type Tier } from '../harness/tiers.js';
import { mintApiToken, obtainToken } from '../harness/token.js';
import { WireClient } from '../harness/wire.js';
import { REPO_ROOT } from '../harness/workspace.js';

/**
 * The shortest path from nothing to a tool result, at every tier that is on.
 *
 * This is the file that proves the harness before anything is built on it: a
 * config on disk, a hub, a child process, the OAuth journey, a real MCP client,
 * a call, an answer. It is deliberately thin — the interesting assertions live
 * in the suites that come after, and if this one is red none of those can be
 * trusted anyway.
 *
 * `describe.each` over the enabled tiers rather than one file per tier: the
 * behaviour is supposed to be identical across them, and writing it once is the
 * only way that claim stays true.
 */

const EVERYTHING = path.join(REPO_ROOT, 'node_modules', '@modelcontextprotocol', 'server-everything', 'dist', 'index.js');
const DEMO_SERVERS = path.join(REPO_ROOT, 'demo', 'servers');

const FLEET = {
  // A rich, third-party child on the 2025 era.
  everything: { command: process.execPath, args: [EVERYTHING] },
  // The public demo's own server, which until now no test has ever started.
  weather: { command: process.execPath, args: [path.join(DEMO_SERVERS, 'weather.mjs')], keepAlive: true }
};

// Not the docker tier: this fleet includes `server-everything` from
// node_modules, which is not mounted into the container, and the container
// already has a suite of its own. `docker-image.e2e.ts` covers the same ground
// with a fleet the image can actually see.
const tiers = tiersFor(['docker'], 'smoke runs server-everything from node_modules, which the container cannot see');

describe.runIf(tiers.length === 0)('the smoke suite', () => {
  // A file that registers no suite at all is a *failed* file in vitest, not an
  // empty one — so a docker-only run would go red for a suite that was never
  // meant to run in it. One placeholder keeps the file honest and green.
  it('does not apply to this tier', () => {
    expect(tiers).toEqual([]);
  });
});

describe.each(tiers)('a hub at the %s tier', (tier: Tier) => {
  let gateway: Gateway;
  let clients: ClientPool;
  let wire: WireClient;

  beforeAll(async () => {
    gateway = await startGateway({ prefix: `smoke-${tier}`, tier, servers: FLEET });
    clients = new ClientPool(gateway);
    wire = new WireClient(gateway);
  }, 120_000);

  afterEach(() => clients.closeAll());
  afterAll(() => gateway?.stop());

  it('reports itself alive without a credential', async () => {
    const response = await wire.request('/livez');
    expect(response.status).toBe(200);
    // Nothing about the fleet: /livez is the unauthenticated one, and the
    // server names are topology.
    expect(response.text).not.toContain('weather');
  });

  it('really is running at the tier it was asked for', () => {
    expect(gateway.tier).toBe(tier);
    // The process tier is a URL because there is a socket in the way; the
    // in-process tier is the app itself. Anything else means a tier silently
    // substituted another, which is a green tick for coverage that does not exist.
    expect(typeof gateway.target === 'string').toBe(tier === 'process');
  });

  it('refuses an MCP route without a token, and says where to get one', async () => {
    const response = await wire.rpc('/hub', { id: 1, method: 'tools/list', params: {} });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('/.well-known/oauth-protected-resource/hub');
  });

  it('walks the whole OAuth journey and answers on /hub', async () => {
    const token = await obtainToken(gateway, { resource: 'hub' });
    expect(token.access).toBeTruthy();
    // The login page names what is being authorized. A user who cannot see
    // which resource they are approving is not really consenting to it.
    expect(token.pages.join('')).toContain('/hub');

    const client = await clients.connect('/hub', token.access);
    const tools = (await client.listTools()) as ListToolsResult;
    expect(tools.tools.map(tool => tool.name).sort()).toEqual([
      'call_tool',
      'get_tool_schema',
      'list_servers',
      'list_tools',
      'sleep_server',
      'wake_server'
    ]);

    const servers = (await client.callTool({ name: 'list_servers', arguments: {} })) as CallToolResult;
    const listed = JSON.parse((servers.content[0] as { text: string }).text) as Array<{ name: string; status: string }>;
    expect(listed.map(server => server.name).sort()).toEqual(['everything', 'weather']);
    expect(listed.every(server => server.status === 'up')).toBe(true);
  });

  it('reaches a child through /hub and through its own route, with the same answer', async () => {
    const hubToken = await obtainToken(gateway, { resource: 'hub' });
    const directToken = await obtainToken(gateway, { resource: 'weather' });

    const viaHub = await clients.connect('/hub', hubToken.access);
    const aggregated = (await viaHub.callTool({
      name: 'call_tool',
      arguments: { server: 'weather', tool: 'list_stations', arguments: {} }
    })) as CallToolResult;

    const direct = await clients.connect('/weather/mcp', directToken.access);
    const straight = (await direct.callTool({ name: 'list_stations', arguments: {} })) as CallToolResult;

    // The two doors are different code paths — `hub.ts` versus `proxy.ts` —
    // sharing one `forwardToolCall`. That they agree is the property the
    // aggregate is worth having for.
    expect(aggregated.content).toEqual(straight.content);
    expect(aggregated.isError ?? false).toBe(false);
  });

  it('binds a token to one resource and nothing else', async () => {
    const token = await obtainToken(gateway, { resource: 'weather' });
    const allowed = await wire.rpc('/weather/mcp', { id: 1, method: 'ping', params: {} }, { token: token.access });
    expect(allowed.status).toBe(200);

    // The feature working, not a mistake in the test: since 0.5.0 a token names
    // the one path it opens.
    const refused = await wire.rpc('/hub', { id: 1, method: 'ping', params: {} }, { token: token.access });
    expect(refused.status).toBe(401);
  });

  it('accepts an API token minted by the CLI in another process', async () => {
    // The whole point of doing this through the binary: `mcp-hub-admin` writes
    // the state file that the running hub is also holding. A test that minted
    // in-process would prove the hub can read its own memory.
    const token = await mintApiToken(gateway, 'hub');
    const client = await clients.connect('/hub', token);
    const tools = (await client.listTools()) as ListToolsResult;
    expect(tools.tools).toHaveLength(6);

    const listed = await gateway.admin(['tokens', 'list']);
    expect(listed.code).toBe(0);
    expect(JSON.parse(listed.stdout)).toHaveLength(1);
  });

  it('says what happened when a child cannot start', async () => {
    // Not an error path for its own sake: this is the assertion that the
    // harness attaches the hub's output to a failure. Without it, every
    // subsequent failure in this suite reads as "Connection closed".
    const broken = await startGateway({
      prefix: `smoke-broken-${tier}`,
      tier,
      servers: { nope: { command: process.execPath, args: [path.join(REPO_ROOT, 'no-such-file.mjs')] } },
      waitUntilSettled: false
    });
    try {
      await broken.waitForLog(/\[nope\] down/, 20_000);
      expect(broken.stderr()).toMatch(/\[nope\] down/);
      // One broken child, and the hub is still serving.
      expect((await new WireClient(broken).request('/livez')).status).toBe(200);
    } finally {
      await broken.stop();
    }
  }, 60_000);
});
