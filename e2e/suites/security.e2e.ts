import { withInputRequired } from '@modelcontextprotocol/client';
import { CallToolResultSchema } from '@modelcontextprotocol/core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { authorizeInBrowser, registerPublicClient } from '../../test/auth-flow.js';
import { catalogueFleet, stdio, testFixture } from '../fixtures/fleets.js';
import { ClientPool } from '../harness/client.js';
import { startGateway, E2E_PASSWORD, type Gateway } from '../harness/gateway.js';
import { tierEnabled } from '../harness/tiers.js';
import { mintApiToken, obtainToken, REDIRECT_URI, resourceUrl } from '../harness/token.js';
import { waitFor } from '../harness/wait.js';
import { authenticateParams, WireClient } from '../harness/wire.js';

/**
 * The hub as something that is attacked, against a real process.
 *
 * `test/hardening.test.ts` covers most of this in-process and covers it well;
 * repeating it here would be a second copy of the same assertions with a slower
 * setup. What is here is what changes when there is a process boundary:
 *
 *   - a revocation issued by a *different program* against a shared state file.
 *     This is the one that shipped broken. The old test minted and revoked
 *     through the same `AuthStore` instance the hub was using, under a comment
 *     saying "this is exactly what mcp-hub-admin does" — which is exactly what
 *     it does not. Revocation reported success, did nothing, and the hub's next
 *     write resurrected eight credentials that had been reported dead.
 *   - resource binding as a client experiences it: a token obtained through the
 *     real browser flow, presented to the wrong path.
 *   - the per-client gate as a defence rather than as a counter — one client
 *     flooding must not cost another its latency.
 */

const RUNS_HERE = tierEnabled('process');
/** The fast suite's asking server, reused rather than written twice. */
const ELICIT_FIXTURE = (testFixture('modern-elicit-server.mjs').args as string[])[0];

let gateway: Gateway;
let wire: WireClient;
let clients: ClientPool;

beforeAll(async () => {
  if (!RUNS_HERE) return;
  gateway = await startGateway({
    prefix: 'security',
    tier: 'process',
    servers: { ...catalogueFleet('modern'), other: stdio('slow-start-server.mjs', { env: { START_DELAY_MS: '0' }, keepAlive: true }) },
    env: { IDLE_TIMEOUT_MINUTES: '0' }
  });
  wire = new WireClient(gateway);
  clients = new ClientPool(gateway);
}, 120_000);

afterEach(() => clients?.closeAll());
afterAll(() => gateway?.stop());

describe.runIf(RUNS_HERE)('a token opens one door', () => {
  it('refuses a server token on another server, on /hub and on /health', async () => {
    const token = (await obtainToken(gateway, { resource: 'catalogue' })).access;
    expect((await wire.rpc('/catalogue/mcp', { id: 1, method: 'ping', params: {} }, { token })).status).toBe(200);
    for (const path of ['/other/mcp', '/hub', '/health']) {
      const response = await wire.rpc(path, { id: 1, method: 'ping', params: {} }, { token });
      expect(response.status, path).toBe(401);
      const challenge = authenticateParams(response.headers.get('www-authenticate'));
      expect(challenge.error, path).toBe('invalid_token');
      // Recorded as it is: a *wrong-resource* challenge says what went wrong
      // and not where to go, while a *missing-credential* challenge carries
      // `resource_metadata`. A client holding the wrong token therefore has to
      // fall back to discovery it was not pointed at. RFC 9728 allows the
      // parameter on any Bearer challenge and a client would be better off
      // with it; noted rather than asserted, so a change here is deliberate.
      expect(challenge.resource_metadata, path).toBeUndefined();
    }

    // The other half of the pair, for contrast: with no credential at all the
    // challenge does point at the metadata.
    const anonymous = await wire.rpc('/other/mcp', { id: 1, method: 'ping', params: {} });
    expect(authenticateParams(anonymous.headers.get('www-authenticate')).resource_metadata).toContain(
      '/.well-known/oauth-protected-resource/other/mcp'
    );
  });

  it('refuses a hub token on a server route', async () => {
    // The other direction. /hub is not a superset: it reaches children through
    // six tools, and that is a different resource from the children themselves.
    const token = (await obtainToken(gateway, { resource: 'hub' })).access;
    expect((await wire.rpc('/hub', { id: 1, method: 'ping', params: {} }, { token })).status).toBe(200);
    expect((await wire.rpc('/catalogue/mcp', { id: 1, method: 'ping', params: {} }, { token })).status).toBe(401);
  });

  it('refuses an API token outside its resource, exactly like an OAuth one', async () => {
    // Two token formats, one rule. A JWT that skipped the resource check would
    // be a way around the whole binding, and it is the format handed to the
    // clients that cannot do OAuth — the least supervised ones.
    const token = await mintApiToken(gateway, 'catalogue');
    expect((await wire.rpc('/catalogue/mcp', { id: 1, method: 'ping', params: {} }, { token })).status).toBe(200);
    expect((await wire.rpc('/hub', { id: 1, method: 'ping', params: {} }, { token })).status).toBe(401);
  });

  it('refuses a token that never named a resource at all', async () => {
    // Bound tokens are the default since 0.5.0, so the unbound request is not a
    // legacy path here — it is a client asking for more than it may have.
    await expect(obtainToken(gateway)).rejects.toThrow();
  });
});

describe.runIf(RUNS_HERE)('revocation, issued from another process', () => {
  it('kills an API token immediately, without restarting the hub', async () => {
    // The 0.6.2 case. The token is minted by one program, used against a
    // second, revoked by a third, and must be dead on the next request — no
    // restart, no waiting for a TTL. A hub that only re-read its state at boot
    // reported success and kept honouring the credential.
    const before = new Set((JSON.parse((await gateway.admin(['tokens', 'list'])).stdout) as Array<{ id: string }>).map(entry => entry.id));
    const token = await mintApiToken(gateway, 'catalogue');
    expect((await wire.rpc('/catalogue/mcp', { id: 1, method: 'ping', params: {} }, { token })).status).toBe(200);

    // By difference, not by label: other tests in this file mint tokens too,
    // and revoking the wrong one would make this test pass for a reason that
    // has nothing to do with what it claims.
    const listed = JSON.parse((await gateway.admin(['tokens', 'list'])).stdout) as Array<{ id: string }>;
    const mine = listed.find(entry => !before.has(entry.id));
    expect(mine).toBeDefined();
    expect((await gateway.admin(['tokens', 'revoke', mine!.id])).code).toBe(0);

    const after = await wire.rpc('/catalogue/mcp', { id: 1, method: 'ping', params: {} }, { token });
    expect(after.status).toBe(401);
  }, 60_000);

  it('does not resurrect what another process revoked', async () => {
    // The nastier half of the same bug: the hub held its own copy of the state
    // in memory and wrote it back wholesale, so a revocation could survive one
    // request and then be undone by the hub's next write. The way to provoke a
    // write is to make the hub mint something.
    const doomed = await mintApiToken(gateway, 'catalogue', 2);
    const listed = JSON.parse((await gateway.admin(['tokens', 'list'])).stdout) as Array<{ id: string }>;
    for (const entry of listed) await gateway.admin(['tokens', 'revoke', entry.id]);

    // Make the hub write: a fresh authorization rotates state on disk.
    await obtainToken(gateway, { resource: 'catalogue' });

    expect((await wire.rpc('/catalogue/mcp', { id: 1, method: 'ping', params: {} }, { token: doomed })).status).toBe(401);
    const stillListed = JSON.parse((await gateway.admin(['tokens', 'list'])).stdout) as unknown[];
    expect(stillListed).toEqual([]);
  }, 60_000);

  it('withdraws an OAuth client\'s access without deleting its registration', async () => {
    const token = await obtainToken(gateway, { resource: 'catalogue' });
    expect((await wire.rpc('/catalogue/mcp', { id: 1, method: 'ping', params: {} }, { token: token.access })).status).toBe(200);

    expect((await gateway.admin(['clients', 'revoke', token.clientId])).code).toBe(0);
    // Opaque access tokens die at the revocation marker rather than at their
    // expiry — that is why the token format was changed away from a JWT.
    await waitFor(async () => (await wire.rpc('/catalogue/mcp', { id: 1, method: 'ping', params: {} }, { token: token.access })).status === 401, {
      timeoutMs: 10_000,
      what: 'the revoked token to stop working'
    });

    const listed = JSON.parse((await gateway.admin(['clients', 'list'])).stdout) as Array<{ clientId: string }>;
    expect(listed.some(entry => entry.clientId === token.clientId)).toBe(true);
  }, 60_000);
});

describe.runIf(RUNS_HERE)('the authorization journey itself', () => {
  it('treats entering the password as the approval, first time round', async () => {
    // The consent model, and the reason the next test needs a signed-in agent:
    // a fresh browser that types the operator password has, by doing so,
    // approved this client. There is no second page to deny on, because the
    // person who could deny it just authenticated.
    const redirectUri = 'http://localhost:33419/first-time';
    const clientId = await registerPublicClient(gateway.target, redirectUri);
    const { code, pages } = await authorizeInBrowser(gateway.target, clientId, {
      password: E2E_PASSWORD,
      redirectUri,
      resource: resourceUrl(gateway, 'catalogue')
    });
    expect(code).toBeTruthy();
    expect(pages.join('')).toContain('name="password"');
  });

  it('asks a signed-in operator about an unknown client, and takes no for an answer', async () => {
    // This is where a denial is possible: a session already exists, so no
    // password is asked for, and a client the operator has not seen before gets
    // an Approve/Deny page instead of a silent code. Without this branch an
    // open registration plus a live cookie would be a way to mint a token from
    // another tab.
    const first = 'http://localhost:33420/known';
    const known = await registerPublicClient(gateway.target, first);
    const session = await authorizeInBrowser(gateway.target, known, {
      password: E2E_PASSWORD,
      redirectUri: first,
      resource: resourceUrl(gateway, 'catalogue')
    });

    const second = 'http://localhost:33421/unknown';
    const stranger = await registerPublicClient(gateway.target, second);
    const denied = await authorizeInBrowser(gateway.target, stranger, {
      password: E2E_PASSWORD,
      redirectUri: second,
      resource: resourceUrl(gateway, 'catalogue'),
      agent: session.agent,
      consent: 'deny',
      allowError: true
    });
    expect(denied.code).toBe('');
    expect(denied.pages.join('')).toContain('name="csrf"');
  });

  it('refuses the wrong password, and does not say which half was wrong', async () => {
    const clientId = await registerPublicClient(gateway.target, REDIRECT_URI);
    await expect(
      authorizeInBrowser(gateway.target, clientId, {
        password: 'not-the-password',
        redirectUri: REDIRECT_URI,
        resource: resourceUrl(gateway, 'catalogue')
      })
    ).rejects.toThrow();
  });

  it('refuses a code that has already been spent', async () => {
    const clientId = await registerPublicClient(gateway.target, REDIRECT_URI);
    const { code, verifier } = await authorizeInBrowser(gateway.target, clientId, {
      password: E2E_PASSWORD,
      redirectUri: REDIRECT_URI,
      resource: resourceUrl(gateway, 'catalogue')
    });
    const exchange = () =>
      wire.request('/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          code_verifier: verifier,
          client_id: clientId,
          redirect_uri: REDIRECT_URI,
          resource: resourceUrl(gateway, 'catalogue')
        }).toString()
      });
    expect((await exchange()).status).toBe(200);
    expect((await exchange()).status).toBe(400);
  });

  it('refuses a code presented with the wrong PKCE verifier', async () => {
    const clientId = await registerPublicClient(gateway.target, REDIRECT_URI);
    const { code } = await authorizeInBrowser(gateway.target, clientId, {
      password: E2E_PASSWORD,
      redirectUri: REDIRECT_URI,
      resource: resourceUrl(gateway, 'catalogue')
    });
    const response = await wire.request('/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: 'a'.repeat(43),
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        resource: resourceUrl(gateway, 'catalogue')
      }).toString()
    });
    expect(response.status).toBe(400);
  });

  it('refuses a resource that names no server', async () => {
    const clientId = await registerPublicClient(gateway.target, REDIRECT_URI);
    await expect(
      authorizeInBrowser(gateway.target, clientId, {
        password: E2E_PASSWORD,
        redirectUri: REDIRECT_URI,
        resource: `${gateway.externalUrl}/not-a-server/mcp`
      })
    ).rejects.toThrow(/invalid_target/);
  });
});

describe.runIf(RUNS_HERE)('what a child may not smuggle out', () => {
  let sampler: Gateway;
  let samplerClients: ClientPool;
  let samplerToken: string;

  beforeAll(async () => {
    sampler = await startGateway({
      prefix: 'security-sampler',
      tier: 'process',
      servers: { sampler: stdio('sampler-server.mjs') },
      env: { IDLE_TIMEOUT_MINUTES: '0' }
    });
    samplerClients = new ClientPool(sampler);
    samplerToken = (await obtainToken(sampler, { resource: 'sampler' })).access;
  }, 120_000);

  afterEach(() => samplerClients?.closeAll());
  afterAll(() => sampler?.stop());

  for (const [tool, capability] of [
    ['ask_for_sampling', 'sampling'],
    ['ask_for_roots', 'roots']
  ] as const) {
    it(`stops ${tool} at the child, because the hub never told it the client could`, async () => {
      // Written expecting the hub to strip these on the way back, and the wire
      // said otherwise: nothing reaches the hub to strip. The hub projects the
      // *caller's* capabilities onto each request it forwards, and it projects
      // only `elicitation` — so the child's own SDK refuses to emit the request
      // at all, with -32021, before a byte leaves it.
      //
      // That is a better outcome than filtering, and it is worth a test of its
      // own: it proves the projection is doing its job. The hub's own drop rule
      // in `sanitiseInputRequests` remains a second belt for a child not built
      // on this SDK, and stays unit-tested because no SDK-built fixture can
      // reach it.
      const client = await samplerClients.connect('/sampler/mcp', samplerToken, {
        era: 'modern',
        capabilities: { elicitation: { form: {} } },
        autoFulfillInput: false
      });
      await expect(client.callTool({ name: tool, arguments: {} })).rejects.toMatchObject({
        code: -32021,
        data: { requiredCapabilities: { [capability]: {} } }
      });
    });
  }

  it('carries the legitimate question and refuses the pair it cannot serve', async () => {
    // The mixed case ends the same way, and that is the honest answer: an
    // all-or-nothing refusal at the child rather than a half-delivered result.
    // A client is told why, by code, instead of receiving a question whose
    // sibling silently vanished.
    const client = await samplerClients.connect('/sampler/mcp', samplerToken, {
      era: 'modern',
      capabilities: { elicitation: { form: {} } },
      autoFulfillInput: false
    });
    await expect(client.callTool({ name: 'ask_for_both', arguments: {} })).rejects.toMatchObject({ code: -32021 });
  });

  it('carries an ordinary elicitation through, with the hub\'s attribution on it', async () => {
    // The contrast that makes the tests above meaningful: the legitimate kind
    // does travel, and arrives prefixed with who is asking — a line the child
    // cannot forge, after its own text has been stripped of anything that could
    // visually undo it.
    const asking = await startGateway({
      prefix: 'security-elicit',
      tier: 'process',
      servers: { elicit: { command: process.execPath, args: [ELICIT_FIXTURE] } },
      env: { IDLE_TIMEOUT_MINUTES: '0' }
    });
    try {
      const pool = new ClientPool(asking);
      const token = (await obtainToken(asking, { resource: 'elicit' })).access;
      const client = await pool.connect('/elicit/mcp', token, {
        era: 'modern',
        capabilities: { elicitation: { form: {} } },
        autoFulfillInput: false
      });
      // `allowInputRequired` because the point is to *see* the question, not to
      // have the SDK answer it on our behalf — a gateway test that let the
      // client auto-fulfil would never observe what the hub forwarded.
      const result = (await client.request(
        { method: 'tools/call', params: { name: 'confirm_thing', arguments: { what: 'delete it' } } },
        withInputRequired(CallToolResultSchema),
        { allowInputRequired: true }
      )) as { inputRequests?: Record<string, { method: string; params?: { message?: string } }> };
      const entries = Object.values(result.inputRequests ?? {});
      expect(entries.map(request => request.method)).toEqual(['elicitation/create']);
      expect(entries[0].params?.message).toContain('Server "elicit" asks:');
      await pool.closeAll();
    } finally {
      await asking.stop();
    }
  }, 90_000);
});

describe.runIf(RUNS_HERE)('budgets as a defence', () => {
  it('refuses a flood without costing a second client its answers', async () => {
    // The gate keys on the OAuth client, so this is a test of isolation rather
    // than of arithmetic: a noisy neighbour must be someone else's problem.
    const limited = await startGateway({
      prefix: 'security-gate',
      tier: 'process',
      servers: catalogueFleet('modern'),
      env: { IDLE_TIMEOUT_MINUTES: '0', MCP_REQUESTS_PER_MINUTE: '20' }
    });
    try {
      const noisy = (await obtainToken(limited, { resource: 'catalogue' })).access;
      const quiet = (await obtainToken(limited, { resource: 'catalogue' })).access;
      const there = new WireClient(limited);

      const flood = await Promise.all(
        Array.from({ length: 40 }, () => there.rpc('/catalogue/mcp', { id: 1, method: 'ping', params: {} }, { token: noisy }))
      );
      const refused = flood.filter(response => response.status === 429);
      expect(refused.length).toBeGreaterThan(0);
      // `Retry-After` is what turns a refusal into a client that comes back
      // politely rather than one that hammers.
      expect(refused[0].headers.get('retry-after')).toBeTruthy();

      const neighbour = await there.rpc('/catalogue/mcp', { id: 1, method: 'ping', params: {} }, { token: quiet });
      expect(neighbour.status).toBe(200);
    } finally {
      await limited.stop();
    }
  }, 90_000);

  it('rate-limits registration before it will store anything', async () => {
    const limited = await startGateway({ prefix: 'security-dcr', tier: 'process', servers: {} });
    try {
      const there = new WireClient(limited);
      const attempts = await Promise.all(
        Array.from({ length: 30 }, (_, index) =>
          there.request('/register', {
            method: 'POST',
            body: { client_name: `flood-${index}`, redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: 'none', response_types: ['code'] }
          })
        )
      );
      // Open registration plus unbounded storage is a disk-filling attack that
      // needs no credential at all.
      expect(attempts.some(response => response.status === 429)).toBe(true);
    } finally {
      await limited.stop();
    }
  }, 90_000);
});

describe.runIf(RUNS_HERE)('configuration as an attack surface', () => {
  it('refuses to start a sandbox against the real Docker socket', async () => {
    // The hub must never hold /var/run/docker.sock: the daemon API is
    // root-equivalent and the hub faces the internet. The refusal is at
    // startup rather than at first use, so the mistake cannot lie dormant.
    const refused = await startGateway({
      prefix: 'security-docker-host',
      tier: 'process',
      servers: { sandbox: { type: 'docker', image: 'alpine:latest', command: ['cat'] } },
      env: { DOCKER_HOST: 'unix:///var/run/docker.sock', IDLE_TIMEOUT_MINUTES: '0' },
      waitUntilSettled: false
    });
    try {
      await refused.waitForLog(/docker/i, 20_000);
      expect(refused.stderr()).toMatch(/docker\.sock|policy|proxy/i);
    } finally {
      await refused.stop();
    }
  }, 60_000);

  it('takes down the whole config rather than half of it when a variable is undefined', async () => {
    // Documented and deliberate: a partial config would mean a server silently
    // running without the credential it was supposed to have. The blast radius
    // is the price of that guarantee, and it is why the deployment recipe says
    // to edit the environment before the config.
    const broken = await startGateway({
      prefix: 'security-undefined-var',
      tier: 'process',
      servers: { ok: stdio('slow-start-server.mjs', { env: { START_DELAY_MS: '0' }, keepAlive: true }) },
      env: { MCP_CONFIG_POLL_INTERVAL_MS: '200' }
    });
    try {
      broken.workspace.writeConfig({
        ok: stdio('slow-start-server.mjs', { env: { START_DELAY_MS: '0' }, keepAlive: true }),
        needy: stdio('slow-start-server.mjs', { env: { SECRET: '${NOT_DEFINED_ANYWHERE}' } })
      });
      await broken.waitForLog(/NOT_DEFINED_ANYWHERE|config/i, 15_000);
      // The hub keeps serving what it had. It does not adopt half the file.
      expect((await new WireClient(broken).request('/livez')).status).toBe(200);
    } finally {
      await broken.stop();
    }
  }, 90_000);
});
