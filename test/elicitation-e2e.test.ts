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
async function connectAsking(): Promise<Client> {
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
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/elicit/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } }
    })
  );
  expect(client.getProtocolEra()).toBe('modern');
  return client;
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
        quiet: { command: process.execPath, args: [FIXTURE], passthrough: 'off' }
      }
    })
  );
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
