import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authorizeInBrowser, registerPublicClient } from './auth-flow.js';
import { createHub } from '../src/index.js';

const ORIGIN = 'http://localhost:3000';
const PASSWORD = 'test-password';
const REDIRECT_URI = 'http://localhost:33418/callback';

/**
 * Cross-client compatibility behaviours: the DEFAULT_RESOURCE fallback for
 * clients that omit RFC 8707, the ChatGPT registration quirks, and the
 * discovery documents non-Claude clients actually probe.
 */
describe('client compatibility', () => {
  let dir: string;
  let hub: Awaited<ReturnType<typeof createHub>>;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-compat-'));
    const configPath = path.join(dir, 'mcp.json');
    fs.writeFileSync(configPath, JSON.stringify({ mcpServers: {} }));
    hub = await createHub({
      externalUrl: ORIGIN,
      configPath,
      dataPath: path.join(dir, 'data'),
      password: PASSWORD,
      defaultResource: 'hub'
    });
  }, 30_000);

  afterAll(async () => {
    hub?.watcher.stop();
    await hub?.supervisor.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('binds resource-less authorizations to DEFAULT_RESOURCE instead of refusing', async () => {
    const clientId = await registerPublicClient(hub.app, REDIRECT_URI);
    // Deliberately no resource parameter — older Codex, ADK, Gemini Enterprise.
    const { code, verifier } = await authorizeInBrowser(hub.app, clientId, {
      password: PASSWORD,
      redirectUri: REDIRECT_URI
    });
    const tokens = await request(hub.app)
      .post('/token')
      .type('form')
      .send({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT_URI })
      .expect(200);
    const info = await hub.verifier.verifyAccessToken(tokens.body.access_token);
    expect(info.resource?.href).toBe(`${ORIGIN}/hub`);
    // The bound token works on /hub and nowhere else — it is not a global token.
    await request(hub.app)
      .post('/hub')
      .set('Authorization', `Bearer ${tokens.body.access_token}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', method: 'ping', id: 1 })
      .expect(200);
  });

  it('rejects createHub when defaultResource names no configured server', async () => {
    const badDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-compat-bad-'));
    const configPath = path.join(badDir, 'mcp.json');
    fs.writeFileSync(configPath, JSON.stringify({ mcpServers: {} }));
    await expect(
      createHub({ externalUrl: ORIGIN, configPath, dataPath: path.join(badDir, 'data'), password: PASSWORD, defaultResource: 'nope' })
    ).rejects.toThrow(/defaultResource/);
    fs.rmSync(badDir, { recursive: true, force: true });
  });

  it('hands public-client registrations a non-expiring client_secret without storing it (ChatGPT quirk)', async () => {
    const registration = await request(hub.app)
      .post('/register')
      .send({ redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: 'none', client_name: 'chatgpt-like' })
      .expect(201);
    expect(typeof registration.body.client_secret).toBe('string');
    expect(registration.body.client_secret_expires_at).toBe(0);
    // Not persisted: the stored client must not demand the secret later,
    // otherwise every correct public client (Claude) would break.
    expect(hub.store.getClient(registration.body.client_id)?.client_secret).toBeUndefined();
  });

  it('keeps confidential-client secrets non-expiring', async () => {
    const registration = await request(hub.app)
      .post('/register')
      .send({ redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: 'client_secret_post' })
      .expect(201);
    expect(typeof registration.body.client_secret).toBe('string');
    expect(registration.body.client_secret_expires_at).toBe(0);
    expect(hub.store.getClient(registration.body.client_id)?.client_secret).toBe(registration.body.client_secret);
  });

  it('serves the OIDC discovery alias with the same document and no-store', async () => {
    const rfc8414 = await request(hub.app).get('/.well-known/oauth-authorization-server').expect(200);
    for (const p of ['/.well-known/openid-configuration', '/.well-known/openid-configuration/everything/mcp']) {
      const oidc = await request(hub.app).get(p).expect(200);
      expect(oidc.body.issuer).toBe(rfc8414.body.issuer);
      expect(oidc.body.token_endpoint).toBe(rfc8414.body.token_endpoint);
      expect(oidc.headers['cache-control']).toBe('no-store');
    }
  });

  it('marks every discovery and registration response no-store', async () => {
    for (const p of [
      '/.well-known/oauth-authorization-server',
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/hub'
    ]) {
      const response = await request(hub.app).get(p).expect(200);
      expect(response.headers['cache-control']).toBe('no-store');
    }
  });

  it('advertises S256 and the supported client auth methods', async () => {
    const metadata = await request(hub.app).get('/.well-known/oauth-authorization-server').expect(200);
    expect(metadata.body.code_challenge_methods_supported).toEqual(['S256']);
    expect(metadata.body.token_endpoint_auth_methods_supported).toContain('none');
    expect(metadata.body.token_endpoint_auth_methods_supported).toContain('client_secret_post');
  });

  it('issues refresh tokens without requiring an offline_access scope (SEP-2207)', async () => {
    const clientId = await registerPublicClient(hub.app, REDIRECT_URI);
    // No scope parameter at all — most clients never ask for offline_access.
    const { code, verifier } = await authorizeInBrowser(hub.app, clientId, {
      password: PASSWORD,
      redirectUri: REDIRECT_URI,
      resource: `${ORIGIN}/hub`
    });
    const tokens = await request(hub.app)
      .post('/token')
      .type('form')
      .send({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        resource: `${ORIGIN}/hub`
      })
      .expect(200);
    expect(typeof tokens.body.refresh_token).toBe('string');
  });
});
