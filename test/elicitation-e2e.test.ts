import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport, withInputRequired } from '@modelcontextprotocol/client';
import { CallToolResultSchema } from '@modelcontextprotocol/core';

import { authorizeInBrowser, registerPublicClient } from './auth-flow.js';
import { createHub } from '../src/index.js';

/**
 * A child's question reaching the person at the far end, through the hub.
 *
 * This is what the whole SDK migration was for: `smtp-mcp` and `imap-mcp` ask
 * before doing something irreversible, and behind the hub that question used to
 * have nowhere to go — so they silently fell back to a weaker check.
 */

const FIXTURE = path.resolve('test/fixtures/modern-elicit-server.mjs');
const PASSWORD = 'test-password';
const REDIRECT_URI = 'http://localhost:33418/callback';

let tmpDir: string;
let hub: Awaited<ReturnType<typeof createHub>>;
let httpServer: ReturnType<Awaited<ReturnType<typeof createHub>>['app']['listen']>;
let baseUrl: string;
let token: string;

/** A modern client that can answer questions, like Claude Code. */
async function connectAsking(pathname = '/elicit/mcp'): Promise<Client> {
  const client = new Client(
    { name: 'asking-client', version: '0.0.0' },
    {
      capabilities: { elicitation: { form: {} } },
      versionNegotiation: { mode: 'auto' },
      // A gateway test must see the question, not have the client answer it.
      inputRequired: { autoFulfill: false }
    }
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}${pathname}`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } }
    })
  );
  expect(client.getProtocolEra()).toBe('modern');
  return client;
}

/** The same call, dressed as the /hub aggregate wants it. */
function through(server: string, tool: string, args: Record<string, unknown> = {}) {
  return { arguments: { server, tool, arguments: args } };
}

/** One `tools/call` leg, with whatever the previous leg asked for. */
async function call(client: Client, name: string, extra: Record<string, unknown> = {}) {
  return client.request(
    { method: 'tools/call', params: { name, arguments: {}, ...extra } },
    withInputRequired(CallToolResultSchema),
    { allowInputRequired: true }
  );
}

function asInputRequired(result: unknown) {
  return result as { resultType?: string; requestState?: string; inputRequests?: Record<string, { params: { message: string } }> };
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-elicit-'));
  const configPath = path.join(tmpDir, 'mcp.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      mcpServers: {
        elicit: { command: process.execPath, args: [FIXTURE] },
        // A second server that may also ask, so the state binding is actually
        // reached — against the switched-off one the hub never looks at it.
        elsewhere: { command: process.execPath, args: [FIXTURE] },
        quiet: { command: process.execPath, args: [FIXTURE], passthrough: 'off' },
        // Reachable through /hub, but with the asking tool denied — a filtered
        // name must be refused before anything is forwarded.
        filtered: { command: process.execPath, args: [FIXTURE], denyTools: ['confirm_thing'] }
      }
    })
  );
  hub = await createHub({
    externalUrl: 'http://localhost:3000',
    configPath,
    dataPath: path.join(tmpDir, 'data'),
    password: PASSWORD,
    requireResourceBoundTokens: false,
    // On-demand, so a server can be put to sleep mid-file. The era verdict
    // lives on the child's client and a sleeping child has none — see the
    // sleeping case below. 60 minutes because no test here should ever meet
    // the idle sweep by accident.
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

describe('a question reaching the far end', () => {
  it('carries the child question out and the answer back', async () => {
    const client = await connectAsking();

    const asked = asInputRequired(await call(client, 'confirm_thing', { arguments: { what: 'delete it' } }));
    expect(asked.resultType).toBe('input_required');
    expect(asked.inputRequests?.confirm?.params.message).toContain('Really delete it?');
    expect(asked.requestState).toBeTruthy();

    const answered = await call(client, 'confirm_thing', {
      arguments: { what: 'delete it' },
      inputResponses: { confirm: { action: 'accept', content: { confirm: true } } },
      requestState: asked.requestState
    });
    expect(JSON.stringify(answered)).toContain('did delete it');

    await client.close();
  }, 30_000);

  it('carries the first question of a server that was asleep', async () => {
    // Whether the child speaks the modern era is read off its client, and a
    // sleeping child has none. Deciding that before the wake made the very
    // first question after a nap fall back silently — and the second one work.
    // A guarantee that holds on the second try is not one.
    const managed = hub.supervisor.get('elicit');
    await managed?.sleep();
    expect(managed?.state).toBe('sleeping');

    const client = await connectAsking();
    const asked = asInputRequired(await call(client, 'confirm_thing', { arguments: { what: 'delete it' } }));
    expect(asked.resultType).toBe('input_required');
    expect(asked.inputRequests?.confirm?.params.message).toContain('Really delete it?');
    await client.close();
  }, 30_000);

  it('attributes the question to the server that asked it', async () => {
    // The message is rendered to a person as though the hub were asking. It has
    // to say who actually did.
    const client = await connectAsking();
    const asked = asInputRequired(await call(client, 'confirm_thing', { arguments: { what: 'x' } }));
    expect(asked.inputRequests?.confirm?.params.message.startsWith('Server "elicit" asks:')).toBe(true);
    await client.close();
  }, 30_000);

  it('carries a declined answer through unchanged', async () => {
    const client = await connectAsking();
    const asked = asInputRequired(await call(client, 'confirm_thing', { arguments: { what: 'delete it' } }));
    const answered = await call(client, 'confirm_thing', {
      arguments: { what: 'delete it' },
      inputResponses: { confirm: { action: 'accept', content: { confirm: false } } },
      requestState: asked.requestState
    });
    expect(JSON.stringify(answered)).toContain('refused delete it');
    await client.close();
  }, 30_000);

  it('survives more than one round', async () => {
    const client = await connectAsking();
    const first = asInputRequired(await call(client, 'confirm_twice'));
    expect(first.inputRequests?.confirm?.params.message).toContain('First question?');

    const second = asInputRequired(
      await call(client, 'confirm_twice', {
        inputResponses: { confirm: { action: 'accept', content: { confirm: true } } },
        requestState: first.requestState
      })
    );
    expect(second.inputRequests?.confirm?.params.message).toContain('Second question?');
    expect(second.requestState).not.toBe(first.requestState);

    const done = await call(client, 'confirm_twice', {
      inputResponses: { confirm: { action: 'accept', content: { confirm: true } } },
      requestState: second.requestState
    });
    expect(JSON.stringify(done)).toContain('asked twice');
    await client.close();
  }, 30_000);

  it('strips the misleading characters and the child _meta', async () => {
    // Sampling and roots are deliberately not exercised here: the SDK refuses
    // to put them on the wire toward a caller that did not declare the matching
    // capability, so no real child can produce them. The hub drops them anyway
    // — a hand-built result is legal — and test/elicitation.test.ts covers that.
    const client = await connectAsking();
    const asked = asInputRequired(await call(client, 'ask_with_nasty_text'));
    const request = asked.inputRequests?.confirm as unknown as { params: Record<string, unknown> } | undefined;
    const message = String(request?.params.message ?? '');

    expect(message).toContain('plainreversedhidden');
    for (const ch of ['‮', '‬', '​']) expect(message).not.toContain(ch);
    expect(message.startsWith('Server "elicit" asks:')).toBe(true);
    expect(request?.params._meta).toBeUndefined();

    await client.close();
  }, 30_000);

  it('refuses a request state that belongs to another server', async () => {
    // The seal binds server, tool and OAuth client. A state pasted onto a
    // different call must not resume it.
    const client = await connectAsking();
    const asked = asInputRequired(await call(client, 'confirm_thing', { arguments: { what: 'x' } }));

    const other = new Client(
      { name: 'asking-client', version: '0.0.0' },
      { capabilities: { elicitation: { form: {} } }, versionNegotiation: { mode: 'auto' }, inputRequired: { autoFulfill: false } }
    );
    await other.connect(
      new StreamableHTTPClientTransport(new URL(`${baseUrl}/elsewhere/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } }
      })
    );
    await expect(
      call(other, 'confirm_thing', {
        arguments: { what: 'x' },
        inputResponses: { confirm: { action: 'accept', content: { confirm: true } } },
        requestState: asked.requestState
      })
    ).rejects.toThrow();

    await other.close();
    await client.close();
  }, 30_000);

  it('asks nothing when the operator switched that server off', async () => {
    // passthrough: "off" is a phishing judgement, not an availability one — the
    // server keeps working, it just may not put words in front of the user.
    const client = new Client(
      { name: 'asking-client', version: '0.0.0' },
      { capabilities: { elicitation: { form: {} } }, versionNegotiation: { mode: 'auto' }, inputRequired: { autoFulfill: false } }
    );
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${baseUrl}/quiet/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } }
      })
    );
    const result = await call(client, 'confirm_thing', { arguments: { what: 'x' } });
    expect(asInputRequired(result).resultType).not.toBe('input_required');
    // And the child noticed: it took its own fallback rather than erroring.
    expect(JSON.stringify(result)).toContain('cannot ask about x');
    await client.close();
  }, 30_000);

  it('asks nothing of a client that cannot answer', async () => {
    // A 2025 client has no way to receive the question from a stateless hub.
    // Announcing the capability upstream anyway would produce a question with
    // nowhere to go, so the hub does not announce it.
    const legacy = new Client({ name: 'legacy-client', version: '0.0.0' }, { versionNegotiation: { mode: 'legacy' } });
    await legacy.connect(
      new StreamableHTTPClientTransport(new URL(`${baseUrl}/elicit/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } }
      })
    );
    expect(legacy.getProtocolEra()).toBe('legacy');
    const result = await legacy.callTool({ name: 'confirm_thing', arguments: { what: 'x' } });
    expect(JSON.stringify(result)).not.toContain('input_required');
    expect(JSON.stringify(result)).toContain('cannot ask about x');
    await legacy.close();
  }, 30_000);
});

describe('the same question through the /hub aggregate', () => {
  // /hub is the other door to the same children. Six meta-tools stand in for
  // every server, so a child's question arrives wrapped in a call_tool — and
  // used to end there as an opaque "Tool call failed".

  it('carries the question out and the answer back', async () => {
    const client = await connectAsking('/hub');

    const asked = asInputRequired(await call(client, 'call_tool', through('elicit', 'confirm_thing', { what: 'delete it' })));
    expect(asked.resultType).toBe('input_required');
    expect(asked.inputRequests?.confirm?.params.message).toContain('Really delete it?');

    const answered = await call(client, 'call_tool', {
      ...through('elicit', 'confirm_thing', { what: 'delete it' }),
      inputResponses: { confirm: { action: 'accept', content: { confirm: true } } },
      requestState: asked.requestState
    });
    expect(JSON.stringify(answered)).toContain('did delete it');

    await client.close();
  }, 30_000);

  it('names the child, not the hub, as the one asking', async () => {
    // Through this door every question would otherwise look like it came from
    // "mcp-hub" — the aggregate is what the client is talking to.
    const client = await connectAsking('/hub');
    const asked = asInputRequired(await call(client, 'call_tool', through('elicit', 'confirm_thing', { what: 'x' })));
    expect(asked.inputRequests?.confirm?.params.message.startsWith('Server "elicit" asks:')).toBe(true);
    await client.close();
  }, 30_000);

  it('survives more than one round', async () => {
    const client = await connectAsking('/hub');
    const first = asInputRequired(await call(client, 'call_tool', through('elicit', 'confirm_twice')));
    expect(first.inputRequests?.confirm?.params.message).toContain('First question?');

    const second = asInputRequired(
      await call(client, 'call_tool', {
        ...through('elicit', 'confirm_twice'),
        inputResponses: { confirm: { action: 'accept', content: { confirm: true } } },
        requestState: first.requestState
      })
    );
    expect(second.inputRequests?.confirm?.params.message).toContain('Second question?');

    const done = await call(client, 'call_tool', {
      ...through('elicit', 'confirm_twice'),
      inputResponses: { confirm: { action: 'accept', content: { confirm: true } } },
      requestState: second.requestState
    });
    expect(JSON.stringify(done)).toContain('asked twice');
    await client.close();
  }, 30_000);

  it('refuses a state minted at the other door', async () => {
    // Same server, same tool, same client — only the endpoint differs. The two
    // are different calls to everyone involved (different downstream tool name,
    // different resource on the token), so one may not resume the other.
    const viaHub = await connectAsking('/hub');
    const asked = asInputRequired(await call(viaHub, 'call_tool', through('elicit', 'confirm_thing', { what: 'x' })));
    expect(asked.requestState).toBeTruthy();

    const direct = await connectAsking();
    await expect(
      call(direct, 'confirm_thing', {
        arguments: { what: 'x' },
        inputResponses: { confirm: { action: 'accept', content: { confirm: true } } },
        requestState: asked.requestState
      })
    ).rejects.toThrow();

    await direct.close();
    await viaHub.close();
  }, 30_000);

  it('asks nothing for a tool the filter removed', async () => {
    // The refusal has to stay the neutral one, and it has to come before the
    // forward — a denied name must not reach the child at all, let alone get a
    // question out of it.
    const client = await connectAsking('/hub');
    const result = await call(client, 'call_tool', through('filtered', 'confirm_thing', { what: 'x' }));
    expect(JSON.stringify(result)).toContain('Unknown tool');
    expect(asInputRequired(result).resultType).not.toBe('input_required');
    await client.close();
  }, 30_000);
});
