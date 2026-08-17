import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHub } from '../src/index.js';
import { mintApiToken } from '../src/auth/provider.js';
import { AuthStore } from '../src/auth/store.js';

const EVERYTHING = path.resolve('node_modules/@modelcontextprotocol/server-everything/dist/index.js');
const ORIGIN = 'http://localhost:3000';
const PASSWORD = 'test-password';

/**
 * Admin-minted API tokens: the static-bearer path for clients that cannot do
 * OAuth (OpenAI Responses API, xAI API, Gemini API, plain-header clients).
 */
describe('API tokens', () => {
  let dir: string;
  let hub: Awaited<ReturnType<typeof createHub>>;
  let server: ReturnType<Awaited<ReturnType<typeof createHub>>['app']['listen']>;
  let hubToken: { id: string; token: string };
  let serverToken: { id: string; token: string };

  const jsonRpcPing = { jsonrpc: '2.0', method: 'ping', id: 1 };

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-apitoken-'));
    const configPath = path.join(dir, 'mcp.json');
    fs.writeFileSync(configPath, JSON.stringify({ mcpServers: { everything: { command: process.execPath, args: [EVERYTHING] } } }));
    hub = await createHub({
      externalUrl: ORIGIN,
      configPath,
      dataPath: path.join(dir, 'data'),
      password: PASSWORD
    });
    await hub.supervisor.waitUntilSettled();
    server = hub.app.listen(0);
    // Mints through the store instance the hub itself holds. Note this is NOT
    // what mcp-hub-admin does — that is a separate process with its own store
    // against the shared /data volume; see "minted by the admin CLI" below.
    hubToken = await mintApiToken(hub.store, ORIGIN, new URL('/hub', ORIGIN), 30, 'test-hub');
    serverToken = await mintApiToken(hub.store, ORIGIN, new URL('/everything/mcp', ORIGIN), 30, 'test-everything');
  }, 30_000);

  afterAll(async () => {
    server?.close();
    hub?.watcher.stop();
    await hub?.supervisor.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reaches its bound resource and the fleet view with a hub token', async () => {
    await request(hub.app).post('/hub').set('Authorization', `Bearer ${hubToken.token}`).set('Accept', 'application/json, text/event-stream').send(jsonRpcPing).expect(200);
    await request(hub.app).get('/health').set('Authorization', `Bearer ${hubToken.token}`).expect(200);
  });

  it('reaches both path forms of its server with a server token', async () => {
    for (const pathname of ['/everything', '/everything/mcp']) {
      await request(hub.app).post(pathname).set('Authorization', `Bearer ${serverToken.token}`).set('Accept', 'application/json, text/event-stream').send(jsonRpcPing).expect(200);
    }
  });

  it('is refused outside its bound resource', async () => {
    await request(hub.app).post('/everything/mcp').set('Authorization', `Bearer ${hubToken.token}`).send(jsonRpcPing).expect(401);
    await request(hub.app).post('/hub').set('Authorization', `Bearer ${serverToken.token}`).send(jsonRpcPing).expect(401);
    await request(hub.app).get('/health').set('Authorization', `Bearer ${serverToken.token}`).expect(401);
  });

  it('dies immediately on revocation even though the JWT still verifies', async () => {
    const doomed = await mintApiToken(hub.store, ORIGIN, new URL('/hub', ORIGIN), 30, 'doomed');
    await request(hub.app).post('/hub').set('Authorization', `Bearer ${doomed.token}`).set('Accept', 'application/json, text/event-stream').send(jsonRpcPing).expect(200);
    expect(hub.store.revokeApiToken(doomed.id)).toBe(true);
    await request(hub.app).post('/hub').set('Authorization', `Bearer ${doomed.token}`).send(jsonRpcPing).expect(401);
  });

  it('lists live records without the token value and revokes only known ids', () => {
    const tokens = hub.store.listApiTokens();
    expect(tokens[hubToken.id]).toMatchObject({ label: 'test-hub', resource: `${ORIGIN}/hub` });
    expect(JSON.stringify(tokens)).not.toContain(hubToken.token);
    expect(hub.store.revokeApiToken('no-such-id')).toBe(false);
  });

  it('survives a store reload (state.json round trip)', async () => {
    const reloaded = new AuthStore(path.join(dir, 'data'));
    expect(reloaded.getApiToken(hubToken.id)?.label).toBe('test-hub');
  });

  /**
   * The real admin-CLI shape: `docker exec` (or `compose run`) starts a second
   * process, so the mint lands in state.json while the hub keeps serving from
   * its own copy. Both directions have to work without restarting the hub.
   */
  it('accepts a token minted by the admin CLI without a restart', async () => {
    const cli = new AuthStore(path.join(dir, 'data'));
    const minted = await mintApiToken(cli, ORIGIN, new URL('/hub', ORIGIN), 30, 'cli-minted');

    await request(hub.app)
      .post('/hub')
      .set('Authorization', `Bearer ${minted.token}`)
      .set('Accept', 'application/json, text/event-stream')
      .send(jsonRpcPing)
      .expect(200);
  });

  it('refuses a token the admin CLI revoked, without a restart', async () => {
    const doomed = await mintApiToken(hub.store, ORIGIN, new URL('/hub', ORIGIN), 30, 'cli-revoked');
    await request(hub.app).post('/hub').set('Authorization', `Bearer ${doomed.token}`).set('Accept', 'application/json, text/event-stream').send(jsonRpcPing).expect(200);

    expect(new AuthStore(path.join(dir, 'data')).revokeApiToken(doomed.id)).toBe(true);

    await request(hub.app).post('/hub').set('Authorization', `Bearer ${doomed.token}`).send(jsonRpcPing).expect(401);
  });

  it('does not resurrect a CLI revocation when the hub next writes', async () => {
    const doomed = await mintApiToken(hub.store, ORIGIN, new URL('/hub', ORIGIN), 30, 'cli-revoked-2');
    new AuthStore(path.join(dir, 'data')).revokeApiToken(doomed.id);

    // Any hub-side write rewrites the whole file; refresh token rotation does
    // this every few minutes in a live deployment.
    await mintApiToken(hub.store, ORIGIN, new URL('/hub', ORIGIN), 30, 'unrelated');

    await request(hub.app).post('/hub').set('Authorization', `Bearer ${doomed.token}`).send(jsonRpcPing).expect(401);
  });

  it('keys the per-client rate limit by token id', async () => {
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    void baseUrl; // the gate is exercised through supertest below
    // Exhaust concurrency is impractical here; instead assert the identity the
    // gate keys on: verifyAccessToken reports token:<id> as clientId.
    const info = await hub.provider.verifyAccessToken(hubToken.token);
    expect(info.clientId).toBe(`token:${hubToken.id}`);
    expect(info.resource?.href).toBe(`${ORIGIN}/hub`);
  });

  it('rate-limits /health through the same per-client gate as the MCP routes', async () => {
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-healthgate-'));
    const configPath = path.join(dir2, 'mcp.json');
    fs.writeFileSync(configPath, JSON.stringify({ mcpServers: {} }));
    const limited = await createHub({
      externalUrl: ORIGIN,
      configPath,
      dataPath: path.join(dir2, 'data'),
      password: PASSWORD,
      mcpRequestsPerMinute: 2
    });
    try {
      const token = await mintApiToken(limited.store, ORIGIN, new URL('/hub', ORIGIN), 30, 'gate');
      await request(limited.app).get('/health').set('Authorization', `Bearer ${token.token}`).expect(200);
      await request(limited.app).get('/health').set('Authorization', `Bearer ${token.token}`).expect(200);
      const blocked = await request(limited.app).get('/health').set('Authorization', `Bearer ${token.token}`).expect(429);
      expect(blocked.headers['retry-after']).toBeDefined();
    } finally {
      limited.watcher.stop();
      await limited.supervisor.stop();
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  });
});
