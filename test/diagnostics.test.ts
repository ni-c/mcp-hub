import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { CallToolResult } from '@modelcontextprotocol/server';

import { authorizeInBrowser, registerPublicClient } from './auth-flow.js';
import { createHub } from '../src/index.js';
import { decidePassthrough } from '../src/elicitation.js';
import { forgetRefusalsForTests, noteRefusal } from '../src/forward.js';

/**
 * The hub's own self-description, and the log line that says a question was
 * dropped.
 *
 * Both exist for one reason: a connector that cannot be asked looks exactly
 * like a server that chose not to ask. Everything here is about telling those
 * two apart — from inside the client for the tool, from the operator's side for
 * the log.
 */

const PASSWORD = 'test-password';
const REDIRECT_URI = 'http://localhost:33418/callback';

let tmpDir: string;
let hub: Awaited<ReturnType<typeof createHub>>;
let httpServer: ReturnType<Awaited<ReturnType<typeof createHub>>['app']['listen']>;
let baseUrl: string;
let token: string;

/**
 * A client on the era of its choosing, optionally able to be asked something.
 *
 * The negotiated era is asserted rather than assumed: `mode: 'auto'` falls back
 * to the legacy era whenever the modern probe fails, and a test that did not
 * check would pass just as happily against a hub serving one era.
 */
async function connect(era: 'legacy' | 'auto', options: { canBeAsked?: boolean } = {}): Promise<Client> {
  const client = new Client(
    { name: 'diagnostics-test', version: '0.0.0' },
    {
      versionNegotiation: { mode: era },
      ...(options.canBeAsked ? { capabilities: { elicitation: { form: {} } }, inputRequired: { autoFulfill: false } } : {})
    }
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/hub`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } }
    })
  );
  expect(client.getProtocolEra()).toBe(era === 'auto' ? 'modern' : 'legacy');
  return client;
}

async function describeConnection(client: Client, args: Record<string, unknown> = {}) {
  const result = (await client.callTool({ name: 'describe_connection', arguments: args })) as CallToolResult;
  return result;
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-diagnostics-'));
  const configPath = path.join(tmpDir, 'mcp.json');
  // No children: every assertion here is about the hub's answer about itself.
  fs.writeFileSync(configPath, JSON.stringify({ mcpServers: {} }));
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

afterEach(() => {
  delete process.env.MCP_DIAGNOSTICS;
  vi.restoreAllMocks();
  forgetRefusalsForTests();
});

describe('the diagnostics switch', () => {
  it('keeps the aggregate at six tools when it is not set', async () => {
    // The number is the argument for the aggregate, quoted in the README and
    // asserted in three e2e suites. A seventh tool that appeared by default
    // would make all of them wrong at once.
    const client = await connect('auto');
    const names = (await client.listTools()).tools.map(tool => tool.name).sort();
    expect(names).toEqual(['call_tool', 'get_tool_schema', 'list_servers', 'list_tools', 'sleep_server', 'wake_server']);
    await client.close();
  });

  it('adds the seventh tool when it is', async () => {
    process.env.MCP_DIAGNOSTICS = 'true';
    const client = await connect('auto');
    const names = (await client.listTools()).tools.map(tool => tool.name);
    expect(names).toContain('describe_connection');
    expect(names).toHaveLength(7);
    await client.close();
  });

  it('is read per request, so the six come back when it goes away', async () => {
    process.env.MCP_DIAGNOSTICS = 'true';
    const client = await connect('auto');
    expect((await client.listTools()).tools).toHaveLength(7);

    delete process.env.MCP_DIAGNOSTICS;
    expect((await client.listTools()).tools).toHaveLength(6);
    await client.close();
  });
});

describe('describe_connection', () => {
  it('names the era a 2026 client is on, and that it could be asked', async () => {
    process.env.MCP_DIAGNOSTICS = 'true';
    const client = await connect('auto', { canBeAsked: true });
    const result = await describeConnection(client);
    expect(result.structuredContent).toMatchObject({
      era: 'modern',
      revision: '2026-07-28',
      caller: { declaresElicitation: true }
    });
    await client.close();
  });

  it('tells a 2025 client that its era carries no capability envelope', async () => {
    // The whole reason this tool exists: from inside the client, "nobody asked
    // me" and "I cannot be asked" are the same silence.
    process.env.MCP_DIAGNOSTICS = 'true';
    const client = await connect('legacy', { canBeAsked: true });
    const answer = result(await describeConnection(client));
    expect(answer.era).toBe('legacy');
    expect(answer.revision).toBe('2025-11-25');
    expect(answer.caller).toEqual({ declaresElicitation: false });
    expect(answer.elicitation.wouldForward).toBe(false);
    expect(answer.elicitation.reason).toMatch(/declared no elicitation capability/);
    await client.close();
  });

  it('says the rest depends on a server rather than guessing one', async () => {
    process.env.MCP_DIAGNOSTICS = 'true';
    const client = await connect('auto', { canBeAsked: true });
    const answer = result(await describeConnection(client));
    // Nothing about the caller refuses, and no server was named, so the honest
    // answer is neither true nor false.
    expect(answer.elicitation.wouldForward).toBeUndefined();
    expect(answer.elicitation.reason).toMatch(/depends on that server/);
    await client.close();
  });

  it('refuses a server it does not have, in the words the other tools use', async () => {
    process.env.MCP_DIAGNOSTICS = 'true';
    const client = await connect('auto');
    const refused = await describeConnection(client, { server: 'nonexistent' });
    expect(refused.isError).toBe(true);
    expect((refused.content[0] as { text: string }).text).toContain('Unknown server "nonexistent"');
    await client.close();
  });

  it('reports the hub version, so an answer can be pinned to a build', async () => {
    process.env.MCP_DIAGNOSTICS = 'true';
    const client = await connect('auto');
    expect(result(await describeConnection(client)).hubVersion).toMatch(/^\d+\.\d+\.\d+/);
    await client.close();
  });
});

function result(call: CallToolResult) {
  return call.structuredContent as {
    era: string;
    revision: string;
    hubVersion: string;
    caller: { declaresElicitation: boolean };
    elicitation: { wouldForward?: boolean; reason?: string; server?: string };
  };
}

describe('the pass-through decision', () => {
  // One function decides, and both callers ask it: forwardToolCall to act,
  // describe_connection to explain. These pin the order the conditions are
  // checked in, because the order is what the person reading the answer sees.
  it('refuses for the operator first, whatever else is wrong', () => {
    expect(decidePassthrough({ config: { passthrough: 'off' }, declaredElicitation: undefined, childEra: 'legacy' })).toEqual({
      forward: false,
      refusal: 'operator'
    });
  });

  it('blames the caller before the child', () => {
    expect(decidePassthrough({ config: {}, declaredElicitation: undefined, childEra: 'legacy' })).toEqual({
      forward: false,
      refusal: 'caller'
    });
  });

  it('separates a sleeping child from one on the wrong era', () => {
    expect(decidePassthrough({ config: {}, declaredElicitation: { form: {} }, childEra: undefined })).toEqual({
      forward: false,
      refusal: 'child-asleep'
    });
    expect(decidePassthrough({ config: {}, declaredElicitation: { form: {} }, childEra: 'legacy' })).toEqual({
      forward: false,
      refusal: 'child-era'
    });
  });

  it('carries the question when all four hold', () => {
    expect(decidePassthrough({ config: {}, declaredElicitation: { form: {} }, childEra: 'modern' })).toEqual({ forward: true });
  });
});

describe('the refusal log line', () => {
  it('says it once per client, server and reason', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    noteRefusal('freshrss', 'client-a', 'caller');
    noteRefusal('freshrss', 'client-a', 'caller');
    noteRefusal('freshrss', 'client-a', 'caller');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('[freshrss]');
    expect(warn.mock.calls[0][0]).toContain('client-a');
  });

  it('speaks again for a different server, client or reason', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    noteRefusal('freshrss', 'client-a', 'caller');
    noteRefusal('mealie', 'client-a', 'caller');
    noteRefusal('freshrss', 'client-b', 'caller');
    noteRefusal('freshrss', 'client-a', 'operator');
    expect(warn).toHaveBeenCalledTimes(4);
  });

  it('keeps a registered client from forging a line in the file fail2ban reads', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    noteRefusal('freshrss', 'evil [2Kmcp-hub: everything is fine', 'caller');
    const line = warn.mock.calls[0][0] as string;
    expect(line).not.toMatch(/[ -]/);
    expect(line).toContain('everything is fine');
  });

  it('names an unauthenticated caller rather than printing an empty pair of quotes', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    noteRefusal('freshrss', '', 'caller');
    expect(warn.mock.calls[0][0]).toContain('(anonymous)');
  });

  it('stops remembering rather than stops logging once the cap is reached', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Past the cap the same refusal repeats in the log. That is the deliberate
    // trade: a noisy log beats a set that grows for the life of the process.
    for (let i = 0; i < 520; i++) noteRefusal('server', `client-${i}`, 'caller');
    expect(warn).toHaveBeenCalledTimes(520);
    warn.mockClear();
    noteRefusal('server', 'client-1', 'caller');
    expect(warn).toHaveBeenCalledTimes(0);
    noteRefusal('server', 'client-519', 'caller');
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
