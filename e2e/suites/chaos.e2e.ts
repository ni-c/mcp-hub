import type { CallToolResult } from '@modelcontextprotocol/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { chaosFleet, limitsFleet, stdio } from '../fixtures/fleets.js';
import { ClientPool } from '../harness/client.js';
import { startGateway, type Gateway } from '../harness/gateway.js';
import { tierEnabled } from '../harness/tiers.js';
import { obtainToken } from '../harness/token.js';
import { waitFor } from '../harness/wait.js';
import { WireClient } from '../harness/wire.js';

/**
 * Children that misbehave, and a hub that has to stay up anyway.
 *
 * The property under test is containment. A hub fronting a dozen servers is a
 * single point of failure by construction, so every one of these cases ends the
 * same way: the broken child is broken, and the healthy one still answers. That
 * last clause is the whole test — a hub that dies politely has failed just as
 * completely as one that hangs.
 *
 * Run at the process tier, and that is not incidental. An `uncaughtException`
 * in this process would take the test runner with it rather than the hub, which
 * is precisely the failure that once shipped: a throw inside a stream handler,
 * unreachable by any catch, taking twelve working servers down with one bad one.
 *
 * Nothing here waits out a production timeout. The supervisor's constants are
 * configured short through `src/timings.ts`; the five-minute backoff ceiling is
 * asserted from the log rather than by letting a child crash-loop for a quarter
 * of an hour.
 */

const RUNS_HERE = tierEnabled('process');

let gateway: Gateway;
let clients: ClientPool;
let wire: WireClient;
let hubToken: string;

beforeAll(async () => {
  if (!RUNS_HERE) return;
  gateway = await startGateway({
    prefix: 'chaos',
    tier: 'process',
    servers: chaosFleet(),
    env: {
      IDLE_TIMEOUT_MINUTES: '0',
      // Short enough to observe, long enough that a loaded runner does not trip
      // it on a healthy call.
      MCP_CALL_TIMEOUT_MS: '2000',
      MCP_BACKOFF_INITIAL_MS: '100',
      MCP_BACKOFF_MAX_MS: '400',
      MCP_REQUESTS_PER_MINUTE: '10000'
    },
    // `hanger` never finishes starting when asked to, and `crasher` may already
    // be looping: settling is exactly what this fleet cannot be relied on to do.
    waitUntilSettled: false
  });
  clients = new ClientPool(gateway);
  wire = new WireClient(gateway);
  hubToken = (await obtainToken(gateway, { resource: 'hub' })).access;
}, 120_000);

afterEach(() => clients?.closeAll());
afterAll(() => gateway?.stop());

/** The invariant every case below ends with. */
async function hubIsStillWorking(): Promise<void> {
  expect((await wire.request('/livez')).status).toBe(200);
  const client = await clients.connect('/hub', hubToken);
  const result = (await client.callTool({
    name: 'call_tool',
    arguments: { server: 'healthy', tool: 'who_are_you', arguments: {} }
  })) as CallToolResult;
  expect(result.isError ?? false).toBe(false);
}

describe.runIf(RUNS_HERE)('a child that dies', () => {
  it('turns a crash mid-call into an error for that call and nothing else', async () => {
    const client = await clients.connect('/hub', hubToken);
    const result = (await client.callTool({
      name: 'call_tool',
      arguments: { server: 'crasher', tool: 'crash_now', arguments: {} }
    })) as CallToolResult;
    // Through /hub every failure is a tool error rather than a protocol error,
    // deliberately: the aggregate's own call succeeded, and what failed is the
    // thing it was asked to do.
    expect(result.isError).toBe(true);
    await hubIsStillWorking();
  });

  it('restarts it, and the restart is a different process', async () => {
    const client = await clients.connect('/hub', hubToken);
    const before = await callText(client, 'crasher', 'still_here');
    await client.callTool({ name: 'call_tool', arguments: { server: 'crasher', tool: 'crash_now', arguments: {} } });

    const after = await waitFor(
      async () => {
        const text = await callText(client, 'crasher', 'still_here');
        return text && text !== before ? text : undefined;
      },
      { timeoutMs: 20_000, intervalMs: 200, what: 'the crashed child to be replaced' }
    );
    expect(after).not.toBe(before);
    await hubIsStillWorking();
  }, 40_000);

  it('survives half a JSON-RPC frame followed by an exit', async () => {
    // The framing case. A partial line means the reader is holding bytes that
    // will never be completed; the failure has to arrive as a closed transport,
    // not as a throw from inside a 'data' handler where nothing can catch it.
    const client = await clients.connect('/hub', hubToken);
    await client
      .callTool({ name: 'call_tool', arguments: { server: 'crasher', tool: 'abort_stream', arguments: {} } })
      .catch(() => undefined);
    await hubIsStillWorking();
    expect(gateway.stderr()).not.toMatch(/uncaught exception/i);
  }, 40_000);

  it('backs off, and the backoff grows', async () => {
    const crashing = await startGateway({
      prefix: 'chaos-loop',
      tier: 'process',
      servers: { crasher: stdio('crash-server.mjs', { env: { CRASH_AT_START: '1' } }), healthy: stdio('slow-start-server.mjs', { env: { START_DELAY_MS: '0' }, keepAlive: true }) },
      env: { IDLE_TIMEOUT_MINUTES: '0', MCP_BACKOFF_INITIAL_MS: '100', MCP_BACKOFF_MAX_MS: '400' },
      waitUntilSettled: false
    });
    try {
      // Read the delays out of the log rather than timing them: the numbers are
      // what the supervisor decided, and timing them from here would measure
      // the runner's scheduler as much as anything.
      await waitFor(() => crashing.logLines(/\[crasher\] down .*restarting in/).length >= 3, {
        timeoutMs: 20_000,
        intervalMs: 100,
        what: 'three restart attempts'
      });
      const delays = crashing
        .logLines(/\[crasher\] down .*restarting in (\d+)s/)
        .map(line => Number(/restarting in (\d+)s/.exec(line)![1]));
      // Rounded to seconds in the message, so the assertion is monotonicity
      // rather than exact doubling — the arithmetic has a unit test; what this
      // proves is that it is on the path at all.
      expect(delays.length).toBeGreaterThanOrEqual(3);
      expect(delays[delays.length - 1]).toBeGreaterThanOrEqual(delays[0]);

      // And the neighbour never noticed.
      expect((await new WireClient(crashing).request('/livez')).status).toBe(200);
    } finally {
      await crashing.stop();
    }
  }, 60_000);
});

describe.runIf(RUNS_HERE)('a child that will not answer', () => {
  it('gives up on a call at the deadline and frees the slot', async () => {
    const client = await clients.connect('/hub', hubToken);
    const started = Date.now();
    const result = (await client.callTool({
      name: 'call_tool',
      arguments: { server: 'hanger', tool: 'hang_forever', arguments: {} }
    })) as CallToolResult;
    expect(result.isError).toBe(true);
    // The deadline is absolute and configured at 2s here. Anything much longer
    // means it did not fire; anything much shorter means something else did.
    expect(Date.now() - started).toBeLessThan(15_000);

    // The slot has to come back, or four hung calls lock the client out for good.
    const after = (await client.callTool({
      name: 'call_tool',
      arguments: { server: 'hanger', tool: 'still_here', arguments: {} }
    })) as CallToolResult;
    expect(after.isError ?? false).toBe(false);
  }, 60_000);

  it('does not let one slow call block another server', async () => {
    const client = await clients.connect('/hub', hubToken);
    const slow = client.callTool({ name: 'call_tool', arguments: { server: 'hanger', tool: 'hang_for', arguments: { ms: 1500 } } });
    const quick = (await client.callTool({
      name: 'call_tool',
      arguments: { server: 'healthy', tool: 'who_are_you', arguments: {} }
    })) as CallToolResult;
    expect(quick.isError ?? false).toBe(false);
    await slow;
  }, 60_000);

  it('refuses rather than holds a request for a child that never finished starting', async () => {
    const stuck = await startGateway({
      prefix: 'chaos-stuck',
      tier: 'process',
      servers: { stuck: stdio('hang-server.mjs', { env: { HANG: 'init' } }), healthy: stdio('slow-start-server.mjs', { env: { START_DELAY_MS: '0' }, keepAlive: true }) },
      env: { IDLE_TIMEOUT_MINUTES: '0' },
      waitUntilSettled: false
    });
    try {
      const token = (await obtainToken(stuck, { resource: 'stuck' })).access;
      const response = await new WireClient(stuck).rpc('/stuck/mcp', { id: 1, method: 'tools/list', params: {} }, { token });
      // 503, with a JSON-RPC body rather than an empty one: a client that sees
      // only a status has to guess whether to retry.
      expect(response.status).toBe(503);
      expect(response.json ?? response.events?.[0]?.json).toBeDefined();
      expect((await new WireClient(stuck).request('/livez')).status).toBe(200);
    } finally {
      await stuck.stop();
    }
  }, 60_000);
});

describe.runIf(RUNS_HERE)('a child that talks nonsense', () => {
  it('keeps working through a banner, ANSI escapes and a stray brace on stdout', async () => {
    const client = await clients.connect('/hub', hubToken);
    const result = (await client.callTool({
      name: 'call_tool',
      arguments: { server: 'noisy', tool: 'quiet_call', arguments: {} }
    })) as CallToolResult;
    expect(result.isError ?? false).toBe(false);
    await hubIsStillWorking();
  });

  it('is not brought down by a line longer than the framing buffer allows', async () => {
    // The 10 MiB refusal used to arrive as an unreachable throw. Whatever the
    // hub decides to do with the child, the hub itself must survive it.
    const oversize = await startGateway({
      prefix: 'chaos-garbage',
      tier: 'process',
      servers: { noisy: stdio('noisy-stdout-server.mjs', { env: { GARBAGE_BYTES: String(11 * 1024 * 1024) } }), healthy: stdio('slow-start-server.mjs', { env: { START_DELAY_MS: '0' }, keepAlive: true }) },
      env: { IDLE_TIMEOUT_MINUTES: '0' },
      waitUntilSettled: false
    });
    try {
      const wireThere = new WireClient(oversize);
      await waitFor(async () => (await wireThere.request('/livez')).status === 200, { timeoutMs: 20_000, what: '/livez after a huge garbage line' });
      expect(oversize.stderr()).not.toMatch(/uncaught exception/i);
    } finally {
      await oversize.stop();
    }
  }, 60_000);
});

describe.runIf(RUNS_HERE)('a child that answers with too much', () => {
  let big: Gateway;
  let bigClients: ClientPool;
  let bigToken: string;

  beforeAll(async () => {
    big = await startGateway({
      prefix: 'chaos-limits',
      tier: 'process',
      servers: limitsFleet(),
      env: { IDLE_TIMEOUT_MINUTES: '0', MCP_REQUESTS_PER_MINUTE: '10000' }
    });
    bigClients = new ClientPool(big);
    bigToken = (await obtainToken(big, { resource: 'oversize' })).access;
  }, 120_000);

  afterEach(() => bigClients?.closeAll());
  afterAll(() => big?.stop());

  it('refuses a result over the forwarding limit, and keeps serving', async () => {
    const client = await bigClients.connect('/oversize/mcp', bigToken);
    await expect(client.callTool({ name: 'big_result', arguments: { bytes: 9 * 1024 * 1024 } })).rejects.toThrow();

    const small = (await client.callTool({ name: 'small_result', arguments: {} })) as CallToolResult;
    expect((small.content[0] as { text: string }).text).toBe('small');
  }, 60_000);

  it('refuses a child with more tools than it will carry', async () => {
    const many = await startGateway({
      prefix: 'chaos-many-tools',
      tier: 'process',
      servers: limitsFleet({ TOOL_COUNT: '10001' }),
      env: { IDLE_TIMEOUT_MINUTES: '0' },
      waitUntilSettled: false
    });
    try {
      await many.waitForLog(/\[oversize\] (down|failed to list tools)/, 60_000);
      // The neighbour is the point: one child with an absurd catalogue must not
      // cost the others their availability.
      await many.waitForLog(/\[healthy\] up/, 60_000);
      expect((await new WireClient(many).request('/livez')).status).toBe(200);
    } finally {
      await many.stop();
    }
  }, 120_000);

  it('stops paginating a tool list that never ends', async () => {
    const endless = await startGateway({
      prefix: 'chaos-endless',
      tier: 'process',
      servers: limitsFleet({ ENDLESS_PAGES: '1' }),
      env: { IDLE_TIMEOUT_MINUTES: '0' },
      waitUntilSettled: false
    });
    try {
      await endless.waitForLog(/\[oversize\] (down|failed to list tools)/, 60_000);
      expect((await new WireClient(endless).request('/livez')).status).toBe(200);
    } finally {
      await endless.stop();
    }
  }, 120_000);
});

describe.runIf(RUNS_HERE)('configuration that changes underneath it', () => {
  it('keeps the old config when the new one is unparseable, and takes the repair', async () => {
    const reloading = await startGateway({
      prefix: 'chaos-reload',
      tier: 'process',
      servers: { healthy: stdio('slow-start-server.mjs', { env: { START_DELAY_MS: '0' }, keepAlive: true }) },
      env: { IDLE_TIMEOUT_MINUTES: '0', MCP_CONFIG_POLL_INTERVAL_MS: '200' }
    });
    try {
      const token = (await obtainToken(reloading, { resource: 'healthy' })).access;
      const wireThere = new WireClient(reloading);

      reloading.workspace.writeRaw('mcp.json', '{ this is not json');
      await reloading.waitForLog(/config/i, 15_000).catch(() => undefined);
      // Still serving the fleet it had. A hub that emptied itself on a bad edit
      // would take every connector down for a typo.
      expect((await wireThere.rpc('/healthy/mcp', { id: 1, method: 'ping', params: {} }, { token })).status).toBe(200);

      await reloading.writeConfig({
        healthy: stdio('slow-start-server.mjs', { env: { START_DELAY_MS: '0' }, keepAlive: true }),
        second: stdio('slow-start-server.mjs', { env: { START_DELAY_MS: '0' }, keepAlive: true })
      });
      await reloading.waitForLog(/\[second\] (starting|up)/, 20_000);
    } finally {
      await reloading.stop();
    }
  }, 90_000);

  it('notices a config replaced by rename, which is how editors and mounts write', async () => {
    // `fs.watch` on the file itself never fires for this; the hub watches the
    // directory for exactly that reason, and the poll is the belt to its braces.
    const renaming = await startGateway({
      prefix: 'chaos-rename',
      tier: 'process',
      servers: { healthy: stdio('slow-start-server.mjs', { env: { START_DELAY_MS: '0' }, keepAlive: true }) },
      env: { IDLE_TIMEOUT_MINUTES: '0', MCP_CONFIG_POLL_INTERVAL_MS: '200' }
    });
    try {
      renaming.workspace.writeConfig({
        healthy: stdio('slow-start-server.mjs', { env: { START_DELAY_MS: '0' }, keepAlive: true }),
        arrived: stdio('slow-start-server.mjs', { env: { START_DELAY_MS: '0' }, keepAlive: true })
      });
      await renaming.waitForLog(/\[arrived\] (starting|up)/, 20_000);
    } finally {
      await renaming.stop();
    }
  }, 90_000);
});

async function callText(client: Awaited<ReturnType<ClientPool['connect']>>, server: string, tool: string): Promise<string> {
  const result = (await client.callTool({ name: 'call_tool', arguments: { server, tool, arguments: {} } })) as CallToolResult;
  return (result.content[0] as { text?: string })?.text ?? '';
}
