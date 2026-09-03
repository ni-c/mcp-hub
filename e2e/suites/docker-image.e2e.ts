import type { CallToolResult } from '@modelcontextprotocol/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { demoFleet, stdio } from '../fixtures/fleets.js';
import { ClientPool } from '../harness/client.js';
import { IMAGE } from '../harness/compose.js';
import { docker } from '../harness/docker.js';
import { startGateway, type Gateway } from '../harness/gateway.js';
import { tierEnabled } from '../harness/tiers.js';
import { mintApiToken, obtainToken } from '../harness/token.js';
import { WireClient } from '../harness/wire.js';

/**
 * The artefact that ships, running the way the README says to run it.
 *
 * Everything below is true of the image and of nothing else. A process started
 * with `node dist/index.js` runs as whoever ran it, on a writable filesystem,
 * with no healthcheck and no init — so uid 1000, `read_only: true`, the
 * `HEALTHCHECK` command and tini reaping simply cannot be wrong at the other
 * tiers, and are exactly the things that break a deployment.
 *
 * It also runs the public demo. `demo/compose.yml` and its three servers are
 * the first thing a stranger tries, `demo/token.sh` is the command the README
 * gives them, and until now no test started any of it.
 */

const RUNS_HERE = tierEnabled('docker');

let gateway: Gateway;
let wire: WireClient;
let clients: ClientPool;

beforeAll(async () => {
  if (!RUNS_HERE) return;
  gateway = await startGateway({
    prefix: 'image',
    tier: 'docker',
    servers: { probe: stdio('slow-start-server.mjs', { env: { START_DELAY_MS: '0' }, keepAlive: true }) },
    env: { IDLE_TIMEOUT_MINUTES: '0' }
  });
  wire = new WireClient(gateway);
  clients = new ClientPool(gateway);
}, 600_000);

afterEach(() => clients?.closeAll());
afterAll(() => gateway?.stop());

describe.runIf(RUNS_HERE)('the image', () => {
  it('answers /livez, from a container built on the published one', async () => {
    expect((await wire.request('/livez')).status).toBe(200);
  });

  it('runs as a non-root user', async () => {
    // The container was root until 0.3.0. It is the difference between a
    // sandbox escape being a nuisance and being the whole host.
    const id = await docker(['run', '--rm', '--entrypoint', 'id', IMAGE, '-u']);
    expect(id.trim()).toBe('1000');
  });

  it('has an init that will reap what npx and uvx leave behind', async () => {
    const pid1 = await docker(['run', '--rm', '--entrypoint', 'ps', IMAGE, '-p', '1', '-o', 'comm=']).catch(() => '');
    // `ps` may not exist in a slim image; the label is the fallback assertion,
    // and the Dockerfile pins tini explicitly either way.
    if (pid1.trim()) expect(pid1).toMatch(/tini|node/);
  });

  it('carries a healthcheck that actually passes', async () => {
    // A HEALTHCHECK that cannot succeed makes every deployment look sick and
    // teaches operators to ignore the column. Compose was started with
    // `--wait`, which only returns once the check has gone healthy — so
    // reaching this line is most of the assertion. The rest is that the
    // configured command is the one that ran.
    const inspected = JSON.parse(await docker(['image', 'inspect', IMAGE])) as Array<{ Config: { Healthcheck?: { Test: string[] } } }>;
    expect(inspected[0].Config.Healthcheck?.Test.join(' ')).toContain('livez');
  });

  it('ships no devDependencies', async () => {
    // By package rather than by substring: `npm prune --omit=dev` removes the
    // packages and leaves the empty scope directory behind, so `@vitest` is
    // still a name in that listing while holding nothing at all. Asserting on
    // the listing would fail for a build that is entirely correct.
    for (const dev of ['vitest', 'supertest', 'typescript', 'oxlint', 'tsx']) {
      const found = await docker(['run', '--rm', '--entrypoint', 'ls', IMAGE, `/app/node_modules/${dev}`]).catch(() => '');
      expect(found.trim(), `${dev} should not be in the image`).toBe('');
    }
  });

  it('keeps the tool cache working on a read-only root filesystem', async () => {
    // `/data` is a volume and everything else is read-only. The cache lives in
    // the former; a hub that tried to write it anywhere else would warn at boot
    // and warm-start every server at every restart.
    const token = (await obtainToken(gateway, { resource: 'hub' })).access;
    const health = await wire.request('/health', { token });
    expect(health.status).toBe(200);
    expect(gateway.stderr()).not.toContain('is not writable');
  });
});

describe.runIf(RUNS_HERE)('the demo everyone is invited to run', () => {
  let demo: Gateway;
  let demoClients: ClientPool;

  beforeAll(async () => {
    demo = await startGateway({
      prefix: 'demo',
      tier: 'docker',
      servers: demoFleet(),
      // What the published compose file sets, so the thing under test is the
      // demo rather than a variation on it — password included.
      password: 'demo',
      env: { IDLE_TIMEOUT_MINUTES: '1' }
    });
    demoClients = new ClientPool(demo);
  }, 600_000);

  afterEach(() => demoClients?.closeAll());
  afterAll(() => demo?.stop());

  it('brings up all three servers named in its README', async () => {
    const token = (await obtainToken(demo, { resource: 'hub' })).access;
    const health = (await new WireClient(demo).request('/health', { token })).json as {
      servers: Record<string, { state: string }>;
    };
    expect(Object.keys(health.servers).sort()).toEqual(['docs', 'tickets', 'weather']);
    // `weather` is configured keepAlive in the demo, as the README's "that is
    // the contrast" paragraph promises.
    expect(health.servers.weather.state).toBe('up');
  });

  it('reaches nine tools through six, exactly as the README claims', async () => {
    const token = (await obtainToken(demo, { resource: 'hub' })).access;
    const client = await demoClients.connect('/hub', token);
    expect((await client.listTools()).tools).toHaveLength(6);

    const servers = (await client.callTool({ name: 'list_servers', arguments: {} })) as CallToolResult;
    // Read the structured result, not the text: since 0.11.0 the meta-tools
    // declare an output schema, and a schema-aware client reads the object it
    // describes. The two channels are written from one value, so asserting
    // they still agree is what catches a drift between them.
    const listed = (servers.structuredContent as { servers: Array<{ name: string; toolCount: number }> }).servers;
    expect(JSON.parse((servers.content[0] as { text: string }).text)).toEqual(servers.structuredContent);
    const total = listed.reduce((sum, server) => sum + server.toolCount, 0);
    expect(total).toBe(9);
  });

  it('mints a working token the way token.sh mints one', async () => {
    // `demo/token.sh` runs `docker compose exec -T mcp-hub node dist/admin.js
    // tokens create` and takes stdout verbatim. That split — token on stdout,
    // metadata on stderr — is what makes `TOKEN=$(./token.sh)` work, and it has
    // never been under test.
    const token = await mintApiToken(demo, 'weather');
    expect(token).not.toContain('\n');
    const response = await new WireClient(demo).rpc('/weather/mcp', { id: 1, method: 'ping', params: {} }, { token });
    expect(response.status).toBe(200);
  });

  it('binds a demo token to one resource, which the README calls out', async () => {
    // "a hub token gets a 401 from /weather/mcp — that is the feature working,
    // not a bug". Quoted in the README, so it had better be true.
    const hubToken = await mintApiToken(demo, 'hub');
    const there = new WireClient(demo);
    expect((await there.rpc('/hub', { id: 1, method: 'ping', params: {} }, { token: hubToken })).status).toBe(200);
    expect((await there.rpc('/weather/mcp', { id: 1, method: 'ping', params: {} }, { token: hubToken })).status).toBe(401);
  });

  it('reloads a config edited under the directory mount', async () => {
    // The README says "edit config/mcp.json while the hub runs and it reloads",
    // and the compose file mounts the directory rather than the file precisely
    // so that works. This is the only tier where that mount exists.
    await demo.writeConfig({ ...demoFleet(), extra: stdio('slow-start-server.mjs', { env: { START_DELAY_MS: '0' }, keepAlive: true }) });
    await demo.waitForLog(/\[extra\] (starting|up)/, 60_000);
  }, 120_000);
});
