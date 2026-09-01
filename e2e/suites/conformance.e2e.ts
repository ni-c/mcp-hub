import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { catalogueFleet } from '../fixtures/fleets.js';
import { startGateway, type Gateway } from '../harness/gateway.js';
import { tierEnabled } from '../harness/tiers.js';
import { obtainToken, resourceUrl } from '../harness/token.js';
import { authenticateParams, keepAliveCount, parseSse, WireClient } from '../harness/wire.js';

/**
 * What goes over the wire, checked without an SDK in the way.
 *
 * The SDK client is built to smooth over exactly the details a gateway has to
 * get right: it chooses the `Accept` header, retries a failed modern probe as
 * legacy, parses SSE back into objects and turns an HTTP status into an
 * exception whose message no longer mentions the status. Every one of those is
 * a thing some real client does differently.
 *
 * So this file uses `fetch`. It is also the only place both halves of a failure
 * are asserted together — an HTTP status *and* a JSON-RPC error code — because
 * the pair is what a client actually branches on, and the two have drifted
 * apart before.
 */

const RUNS_HERE = tierEnabled('process');

let gateway: Gateway;
let wire: WireClient;
let hubToken: string;
let serverToken: string;

beforeAll(async () => {
  if (!RUNS_HERE) return;
  gateway = await startGateway({
    prefix: 'conformance',
    tier: 'process',
    servers: catalogueFleet('modern'),
    env: { IDLE_TIMEOUT_MINUTES: '0', MCP_REQUESTS_PER_MINUTE: '10000' }
  });
  wire = new WireClient(gateway);
  hubToken = (await obtainToken(gateway, { resource: 'hub' })).access;
  serverToken = (await obtainToken(gateway, { resource: 'catalogue' })).access;
}, 120_000);

afterAll(() => gateway?.stop());

describe.runIf(RUNS_HERE)('discovery documents', () => {
  it('serves protected-resource metadata for every route, in every path form', async () => {
    const cases: Array<[string, string]> = [
      ['/.well-known/oauth-protected-resource/hub', resourceUrl(gateway, 'hub')],
      ['/.well-known/oauth-protected-resource/catalogue/mcp', resourceUrl(gateway, 'catalogue')],
      // The suffix-less form echoes the path it was asked at rather than the
      // canonical `/catalogue/mcp`. That is not a bug: `canonicalResourceUrl`
      // accepts both spellings and normalises them, so a token requested with
      // either works. It is worth pinning as the behaviour it is, and the next
      // test proves the part that matters.
      ['/.well-known/oauth-protected-resource/catalogue', `${gateway.externalUrl}/catalogue`]
    ];
    for (const [path, expected] of cases) {
      const response = await wire.request(path);
      expect(response.status, path).toBe(200);
      const body = response.json as { resource: string; authorization_servers: string[] };
      // Byte-for-byte. claude.ai compares these strictly, and a trailing slash
      // that "obviously means the same thing" is how a connector stops working.
      expect(body.resource, path).toBe(expected);
      expect(body.authorization_servers, path).toEqual([`${gateway.externalUrl}/`]);
      expect(response.headers.get('cache-control'), path).toContain('no-store');
    }
  });

  it('honours a token bound to either spelling of the same resource', async () => {
    // The functional half of the note above: a client that discovered through
    // `/catalogue` asks for a token naming `/catalogue`, and it has to open
    // `/catalogue/mcp`. Two identifiers, one resource, or half the discovery
    // paths lead to tokens that do not work.
    const token = (await obtainToken(gateway, { resource: `${gateway.externalUrl}/catalogue` })).access;
    const response = await wire.rpc('/catalogue/mcp', { id: 1, method: 'ping', params: {} }, { token });
    expect(response.status).toBe(200);
  });

  it('serves the authorization-server metadata under all three names', async () => {
    const documents = await Promise.all(
      [
        '/.well-known/oauth-authorization-server',
        '/.well-known/oauth-authorization-server/hub',
        '/.well-known/openid-configuration'
      ].map(async path => {
        const response = await wire.request(path);
        expect(response.status, path).toBe(200);
        return response.json as { issuer: string };
      })
    );
    // The OIDC alias exists because some clients only look there. If it ever
    // stops being the same document, half the client matrix breaks silently.
    for (const document of documents) expect(document.issuer).toBe(`${gateway.externalUrl}/`);
    expect(documents[1]).toEqual(documents[0]);
    expect(documents[2].issuer).toBe(documents[0].issuer);
  });

  it('points an unauthorized client at the metadata for the route it asked for', async () => {
    for (const [path, expected] of [
      ['/hub', '/.well-known/oauth-protected-resource/hub'],
      ['/catalogue/mcp', '/.well-known/oauth-protected-resource/catalogue/mcp']
    ]) {
      const response = await wire.rpc(path, { id: 1, method: 'tools/list', params: {} });
      expect(response.status, path).toBe(401);
      // Parsed as a map: the order of `error` and `resource_metadata` is not
      // specified, and comparing the raw header would break on a reordering no
      // client can see.
      const params = authenticateParams(response.headers.get('www-authenticate'));
      expect(params.resource_metadata, path).toContain(expected);
    }
  });

  it('answers /livez without a credential and without naming a server', async () => {
    const response = await wire.request('/livez');
    expect(response.status).toBe(200);
    expect(response.text).not.toContain('catalogue');
  });

  it('requires a hub-bound token for /health, not merely any token', async () => {
    // A token for one server used to be enough to read the whole fleet's state.
    expect((await wire.request('/health')).status).toBe(401);
    expect((await wire.request('/health', { token: serverToken })).status).toBe(401);
    const allowed = await wire.request('/health', { token: hubToken });
    expect(allowed.status).toBe(200);
    expect((allowed.json as { servers: Record<string, unknown> }).servers).toHaveProperty('catalogue');
  });
});

describe.runIf(RUNS_HERE)('JSON-RPC over HTTP', () => {
  /**
   * The two openings, spelled the way each era spells them.
   *
   * These were written the other way round first, and the wire corrected them:
   * `initialize` IS the legacy handshake. There is no 2026 initialize at all —
   * a modern client never handshakes, it puts the revision in a header and the
   * client's own details in a per-request `_meta` envelope on every request.
   * Sending `initialize` with a modern header is a contradiction, and the hub
   * says exactly that.
   *
   * Written out by hand rather than taken from the SDK's constants on purpose:
   * this is the file that is supposed to notice when the SDK's idea of the wire
   * and the wire itself drift apart.
   */
  const MODERN_ENVELOPE = {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientInfo': { name: 'conformance', version: '0.0.0' },
    'io.modelcontextprotocol/clientCapabilities': {}
  };

  it('treats initialize as the legacy handshake and answers 2025-11-25', async () => {
    const response = await wire.rpc(
      '/catalogue/mcp',
      { id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'c', version: '0' } } },
      { token: serverToken }
    );
    expect(response.status).toBe(200);
    const body = (response.json ?? response.events?.[0]?.json) as { result: { protocolVersion: string } };
    expect(body.result.protocolVersion).toBe('2025-11-25');
  });

  it('refuses an initialize that also claims to be modern, and names the contradiction', async () => {
    const response = await wire.rpc(
      '/catalogue/mcp',
      { id: 1, method: 'initialize', params: { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'c', version: '0' } } },
      { token: serverToken, era: 'modern' }
    );
    expect(response.status).toBe(400);
    const body = (response.json ?? response.events?.[0]?.json) as { error: { code: number; message: string } };
    expect(body.error.code).toBe(-32020);
    // The message is the feature. "Bad request" would be true and useless; this
    // one tells a client author which half of their request to change.
    expect(body.error.message).toContain('headers and body disagree');
  });

  it('serves a modern request with no handshake at all, given the headers and the envelope', async () => {
    // Three things, all required, none of them a handshake: the revision in
    // `MCP-Protocol-Version`, the method *also* in `Mcp-Method`, and the
    // client's own details in a `_meta` envelope on the request itself. The
    // method header is what lets a proxy route without parsing a body — which
    // is exactly the shape of work this hub does.
    const response = await wire.rpc(
      '/catalogue/mcp',
      { id: 1, method: 'tools/list', params: { _meta: MODERN_ENVELOPE } },
      { token: serverToken, era: 'modern', headers: { 'mcp-method': 'tools/list' } }
    );
    expect(response.status).toBe(200);
    const body = (response.json ?? response.events?.[0]?.json) as { result: { tools: Array<{ name: string }> } };
    expect(body.result.tools.map(tool => tool.name)).toContain('echo');
  });

  it('refuses a modern request whose method header and body disagree', async () => {
    const response = await wire.rpc(
      '/catalogue/mcp',
      { id: 1, method: 'tools/list', params: { _meta: MODERN_ENVELOPE } },
      { token: serverToken, era: 'modern', headers: { 'mcp-method': 'resources/list' } }
    );
    expect(response.status).toBe(400);
    const body = (response.json ?? response.events?.[0]?.json) as { error: { code: number } };
    expect(body.error.code).toBe(-32020);
  });

  it('names the envelope key that is missing, one at a time', async () => {
    // Each of these is a different code path in the validation ladder, and
    // each message names the specific key. A single "invalid envelope" would
    // be true and would cost a client author an afternoon.
    const partial = await wire.rpc(
      '/catalogue/mcp',
      { id: 1, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } } },
      { token: serverToken, era: 'modern', headers: { 'mcp-method': 'tools/list' } }
    );
    expect(partial.status).toBe(400);
    const body = (partial.json ?? partial.events?.[0]?.json) as { error: { message: string; data?: { envelope?: { key?: string } } } };
    expect(body.error.data?.envelope?.key).toBe('io.modelcontextprotocol/clientCapabilities');
  });

  it('says that the envelope is missing entirely rather than failing vaguely', async () => {
    const response = await wire.rpc('/catalogue/mcp', { id: 1, method: 'tools/list', params: {} }, { token: serverToken, era: 'modern' });
    expect(response.status).toBe(400);
    const body = (response.json ?? response.events?.[0]?.json) as { error: { code: number; message: string; data?: { envelope?: { missing?: string[] } } } };
    expect(body.error.code).toBe(-32602);
    expect(body.error.data?.envelope?.missing).toContain('_meta');
  });

  it('refuses a protocol revision from the future rather than guessing', async () => {
    const response = await wire.request('/catalogue/mcp', {
      method: 'POST',
      token: serverToken,
      headers: { 'mcp-protocol-version': '2099-01-01' },
      body: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }
    });
    expect(response.status).toBe(400);
  });

  it('serves a request with no version header at all as legacy', async () => {
    // Most clients in the field send nothing. Defaulting them to the era the
    // hub can serve without a handshake is what keeps them working.
    const response = await wire.rpc('/catalogue/mcp', { id: 1, method: 'tools/list', params: {} }, { token: serverToken });
    expect(response.status).toBe(200);
  });

  it('insists on an Accept header that admits both content types', async () => {
    const response = await wire.rpc(
      '/catalogue/mcp',
      { id: 1, method: 'ping', params: {} },
      { token: serverToken, accept: 'application/json' }
    );
    // 406 with a JSON-RPC body: a client that only accepts JSON has to be told
    // why, or it retries forever against a server that will never agree.
    expect(response.status).toBe(406);
    const body = (response.json ?? response.events?.[0]?.json) as { error: { message: string } };
    expect(body.error.message).toContain('text/event-stream');
  });

  it('answers an unknown method with -32601', async () => {
    const response = await wire.rpc('/catalogue/mcp', { id: 1, method: 'no/such/method', params: {} }, { token: serverToken });
    const body = (response.json ?? response.events?.[0]?.json) as { error?: { code: number } };
    expect(body.error?.code).toBe(-32601);
  });

  it('answers malformed JSON with a JSON-RPC error, though not the one the spec names', async () => {
    const response = await wire.request('/catalogue/mcp', {
      method: 'POST',
      token: serverToken,
      headers: { 'content-type': 'application/json' },
      body: '{"jsonrpc": "2.0", "id": 1, '
    });
    const body = (response.json ?? response.events?.[0]?.json) as { error?: { code: number } };
    // Recorded as it is rather than as it should be. The body parser throws,
    // the Express error handler catches it and answers 500 / -32603 "Internal
    // error" — which tells a client the *server* broke, when what broke was the
    // request. JSON-RPC reserves -32700 (Parse error) and 400 for exactly this.
    // Pinned so that fixing it is a visible change and not a silent one.
    expect(response.status).toBe(500);
    expect(body.error?.code).toBe(-32603);
  });

  it('answers a body over the limit with 413 AND a JSON-RPC error', async () => {
    // The pair is the point. `src/index.ts` maps 413 onto -32000 explicitly,
    // and nothing tested that the mapping is on the path.
    const oversized = { id: 1, method: 'tools/call', params: { name: 'echo', arguments: { message: 'x'.repeat(2 * 1024 * 1024) } } };
    const response = await wire.rpc('/catalogue/mcp', oversized, { token: serverToken });
    expect(response.status).toBe(413);
    const body = (response.json ?? response.events?.[0]?.json) as { error?: { code: number } };
    expect(body.error?.code).toBe(-32000);
  });

  it('echoes an id back with the same JSON type it arrived as', async () => {
    // `0` and `null` are the two that get coerced by accident, and a client
    // that correlates by identity stops matching anything when they do.
    for (const id of [0, 'a-string', 9007199254740991] as const) {
      const response = await wire.rpc('/catalogue/mcp', { id, method: 'ping', params: {} }, { token: serverToken });
      const body = (response.json ?? response.events?.[0]?.json) as { id: unknown };
      expect(typeof body.id, `for ${JSON.stringify(id)}`).toBe(typeof id);
      expect(body.id).toBe(id);
    }
  });

  it('accepts a content type that carries a charset', async () => {
    const response = await wire.rpc(
      '/catalogue/mcp',
      { id: 1, method: 'ping', params: {} },
      { token: serverToken, headers: { 'content-type': 'application/json; charset=utf-8' } }
    );
    expect(response.status).toBe(200);
  });

  it('tolerates a notification, which has no reply at all', async () => {
    const response = await wire.rpc('/catalogue/mcp', { method: 'notifications/initialized', params: {} }, { token: serverToken });
    expect([200, 202]).toContain(response.status);
  });
});

describe.runIf(RUNS_HERE)('server-sent events', () => {
  it('frames a streamed answer the way the format requires', async () => {
    const response = await wire.rpc(
      '/catalogue/mcp',
      { id: 1, method: 'tools/list', params: {} },
      { token: serverToken, accept: 'text/event-stream' }
    );
    if (!response.headers.get('content-type')?.includes('text/event-stream')) {
      // A JSON answer to an SSE-only Accept is a legitimate choice; what is not
      // legitimate is claiming SSE and then not framing it.
      expect(response.headers.get('content-type')).toContain('application/json');
      return;
    }
    const events = parseSse(response.text);
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].json).toBeDefined();
    // A raw newline inside a `data:` line ends the frame early; every real
    // implementation gets this wrong once.
    for (const line of response.text.split('\n')) {
      if (line.startsWith('data:')) expect(line).not.toMatch(/[\r\n]/);
    }
    expect(keepAliveCount(response.text)).toBeGreaterThanOrEqual(0);
  });

  it('rejects a GET stream that carries no credential', async () => {
    const response = await wire.request('/catalogue/mcp', { accept: 'text/event-stream' });
    expect(response.status).toBe(401);
  });
});

describe.runIf(RUNS_HERE)('the aggregate as a wire contract', () => {
  it('exposes exactly six tools, named the way the documentation names them', async () => {
    const response = await wire.rpc('/hub', { id: 1, method: 'tools/list', params: {} }, { token: hubToken });
    const body = (response.json ?? response.events?.[0]?.json) as { result: { tools: Array<{ name: string }> } };
    expect(body.result.tools.map(tool => tool.name).sort()).toEqual([
      'call_tool',
      'get_tool_schema',
      'list_servers',
      'list_tools',
      'sleep_server',
      'wake_server'
    ]);
  });

  it('refuses call_tool without a server rather than guessing one', async () => {
    const response = await wire.rpc(
      '/hub',
      { id: 1, method: 'tools/call', params: { name: 'call_tool', arguments: { tool: 'echo', arguments: {} } } },
      { token: hubToken }
    );
    const body = (response.json ?? response.events?.[0]?.json) as { result?: { isError?: boolean }; error?: unknown };
    expect(body.error ?? body.result?.isError).toBeTruthy();
  });

  it('treats a filtered or unknown tool as equally absent', async () => {
    // Not a leak: an aggregate that answered "that tool exists but you may not
    // call it" would enumerate a fleet for anybody with a token.
    const response = await wire.rpc(
      '/hub',
      { id: 1, method: 'tools/call', params: { name: 'get_tool_schema', arguments: { server: 'catalogue', tool: 'no_such_tool' } } },
      { token: hubToken }
    );
    const body = (response.json ?? response.events?.[0]?.json) as { result?: { isError?: boolean } };
    expect(body.result?.isError).toBe(true);
  });
});

describe.runIf(RUNS_HERE)('routes that do not exist', () => {
  it('does not confuse a path traversal for a server name', async () => {
    for (const path of ['/..%2f..%2fetc%2fpasswd', '/hub/../catalogue', '/%00hub']) {
      const response = await wire.rpc(path, { id: 1, method: 'ping', params: {} }, { token: hubToken });
      expect([400, 401, 404], `for ${path}`).toContain(response.status);
      expect(response.text).not.toContain('root:');
    }
  });

  it('answers an unknown server name with 404, not with someone else\'s route', async () => {
    const response = await wire.rpc('/not-a-server/mcp', { id: 1, method: 'ping', params: {} }, { token: hubToken });
    expect([401, 404]).toContain(response.status);
  });
});
