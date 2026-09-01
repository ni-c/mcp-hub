import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { bothCataloguesFleet, everythingFleet } from '../fixtures/fleets.js';
import { runAgent, transcript, type Scenario } from '../harness/agent.js';
import { ClientPool } from '../harness/client.js';
import { startGateway, type Gateway } from '../harness/gateway.js';
import { obtainToken } from '../harness/token.js';

/**
 * A consumer that discovers, plans and calls — the "fake model".
 *
 * Everything about how and why is in `agent.ts`; this file is the scenarios and
 * the properties they are run for. The scenarios are deliberately few and
 * broad: the value is in what the loop checks on every call, not in the number
 * of scenarios, and each one that exists has to earn its wall-clock.
 */

let gateway: Gateway;
let clients: ClientPool;
let hubToken: string;
let modernToken: string;
let everythingGateway: Gateway;
let everythingClients: ClientPool;
let everythingToken: string;

beforeAll(async () => {
  gateway = await startGateway({
    prefix: 'agent',
    servers: bothCataloguesFleet(),
    // The agent makes a request per tool per discovery pass, all as one OAuth
    // client. The per-client budget defaults to 120/minute and is a real
    // feature with its own tests in the security suite; leaving it at the
    // default here would mean this suite fails for a reason it is not about.
    env: { IDLE_TIMEOUT_MINUTES: '0', MCP_REQUESTS_PER_MINUTE: '10000' }
  });
  clients = new ClientPool(gateway);
  hubToken = (await obtainToken(gateway, { resource: 'hub' })).access;
  modernToken = (await obtainToken(gateway, { resource: 'modern' })).access;

  everythingGateway = await startGateway({
    prefix: 'agent-everything',
    servers: everythingFleet(),
    env: { IDLE_TIMEOUT_MINUTES: '0', MCP_REQUESTS_PER_MINUTE: '10000' }
  });
  everythingClients = new ClientPool(everythingGateway);
  everythingToken = (await obtainToken(everythingGateway, { resource: 'everything' })).access;
}, 120_000);

afterEach(async () => {
  await clients.closeAll();
  await everythingClients.closeAll();
});

afterAll(async () => {
  await gateway?.stop();
  await everythingGateway?.stop();
});

const CATALOGUE_VIA_HUB: Scenario = {
  name: 'catalogue-via-hub',
  via: 'hub',
  budget: { ms: 20_000, requests: 60 }
};

const CATALOGUE_DIRECT: Scenario = {
  name: 'catalogue-direct',
  via: { server: 'modern' },
  budget: { ms: 20_000, requests: 30 }
};

describe('the agent loop', () => {
  it('reaches every tool the aggregate exposes, deriving arguments from their schemas', async () => {
    const client = await clients.connect('/hub', hubToken);
    const run = await runAgent(gateway, client, CATALOGUE_VIA_HUB);

    // Both children, every tool of each. The coverage assertion inside
    // runAgent has already failed the test if anything was missed; this is the
    // readable form of the same claim.
    expect(run.called.size).toBe(5);
    expect(run.steps.map(step => step.server)).toEqual(
      expect.arrayContaining(['legacy', 'modern'])
    );
    console.log(`agent: ${run.steps.length} calls, ${run.requests} requests, ${run.durationMs}ms`);
  });

  it('produces a byte-identical transcript when run twice', async () => {
    // The property that catches unordered iteration — a `Map` walked in
    // insertion order here and hash order there is invisible until a client
    // starts seeing its tool list shuffle between reconnects.
    const first = await runAgent(gateway, await clients.connect('/hub', hubToken), CATALOGUE_VIA_HUB);
    const second = await runAgent(gateway, await clients.connect('/hub', hubToken), CATALOGUE_VIA_HUB);
    expect(transcript(second)).toBe(transcript(first));
  });

  it('gets the same answers through /hub as through the server route', async () => {
    const viaHub = await runAgent(gateway, await clients.connect('/hub', hubToken), {
      ...CATALOGUE_VIA_HUB,
      name: 'compare'
    });
    const direct = await runAgent(gateway, await clients.connect('/modern/mcp', modernToken), {
      ...CATALOGUE_DIRECT,
      name: 'compare'
    });

    // Same seed (both scenarios are named `compare`), so the derived arguments
    // match and the results are comparable. The aggregate filters to one
    // server, so compare that slice.
    const throughHub = viaHub.steps.filter(step => step.server === 'modern').map(({ tool, args, isError, shape, text }) => ({ tool, args, isError, shape, text }));
    const straight = direct.steps.map(({ tool, args, isError, shape, text }) => ({ tool, args, isError, shape, text }));
    expect(throughHub).toEqual(straight);
  });

  it('drives a third-party server it has never been told about', async () => {
    // `server-everything` is not ours: its schemas, its content types, its
    // error shapes. An agent that only works against fixtures written next to
    // it is proving something about the fixtures.
    const client = await everythingClients.connect('/everything/mcp', everythingToken);
    const run = await runAgent(everythingGateway, client, {
      name: 'everything',
      via: { server: 'everything' },
      outOfReach: {
        'trigger-long-running-operation': 'runs for ten seconds by design; the budget check exists to catch exactly that, so this one is excused rather than allowed to define the budget',
        'get-env': "returns the child's environment, which would put the hub's own variables into a transcript that gets read in CI logs",
        'get-tiny-image': 'returns base64 image data that dwarfs every other step in the transcript',
        'get-annotated-message': 'same: its image variant makes the twice-and-identical comparison unreadable',
        'toggle-simulated-logging': 'starts a timer that keeps emitting after the run ends, so the next scenario inherits its noise',
        'toggle-subscriber-updates': 'the same, for resource updates; the subscriptions suite drives it deliberately'
      },
      budget: { ms: 30_000, requests: 60 }
    });
    expect(run.called.size).toBeGreaterThan(3);
  });
});

describe('what the agent notices that a fixed call list would not', () => {
  it('refuses a schema that requires a property it does not describe', async () => {
    // Not a test of a fixture but of the guard itself: this is the shape a
    // damaged schema takes, and `argsFor` has to fail rather than call the
    // tool without the argument and blame the child.
    const { argsFor } = await import('../harness/args.js');
    expect(() => argsFor({ type: 'object', required: ['id'], properties: {} }, 'seed')).toThrow(/does not describe it/);
  });

  it('derives the same argument for the same field every time, and different ones across fields', async () => {
    const { argsFor } = await import('../harness/args.js');
    const schema = { type: 'object', required: ['a', 'b'], properties: { a: { type: 'string' }, b: { type: 'string' } } };
    const once = argsFor(schema, 'seed');
    const again = argsFor(schema, 'seed');
    expect(again).toEqual(once);
    expect(once.a).not.toBe(once.b);
  });

  it('prefers what the schema states over anything it would invent', async () => {
    const { argsFor } = await import('../harness/args.js');
    const args = argsFor(
      {
        type: 'object',
        required: ['mode', 'count', 'name'],
        properties: {
          mode: { type: 'string', enum: ['fast', 'slow'] },
          count: { type: 'integer', default: 7 },
          name: { type: 'string', const: 'fixed' }
        }
      },
      'seed'
    );
    expect(args).toEqual({ mode: 'fast', count: 7, name: 'fixed' });
  });
});
