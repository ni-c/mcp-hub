import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import express from 'express';
import type { Express } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mountOidcProvider } from '../src/auth/oidc/mount.js';
import { buildOidcProvider, HUB_ACCOUNT_ID } from '../src/auth/oidc/provider.js';
import { AuthStore } from '../src/auth/store.js';

const EXTERNAL_URL = 'http://127.0.0.1:9977/';
const REDIRECT_URI = 'https://claude.ai/api/mcp/auth_callback';

let tmpDir: string;
let store: AuthStore;
let app: Express;

/**
 * Stands in for the hub's own login and consent pages, which stay Express and
 * are swapped in when the authorization server takes over from HubOAuthProvider.
 * Approving unconditionally is what makes the MOUNT testable in isolation.
 */
function autoApproveInteractions(application: Express, provider: ReturnType<typeof buildOidcProvider>): void {
  application.get('/interaction/:uid', async (req, res, next) => {
    try {
      const details = await provider.interactionDetails(req, res);
      if (details.prompt.name === 'login') {
        await provider.interactionFinished(req, res, { login: { accountId: HUB_ACCOUNT_ID } }, { mergeWithLastSubmission: false });
        return;
      }
      const grant = new provider.Grant({ accountId: details.session?.accountId, clientId: String(details.params.client_id) });
      const grantId = await grant.save();
      await provider.interactionFinished(req, res, { consent: { grantId } }, { mergeWithLastSubmission: true });
    } catch (error) {
      next(error);
    }
  });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-oidc-'));
  store = new AuthStore(tmpDir);
  app = express();
  app.get('/livez', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  const provider = buildOidcProvider(store, {
    externalUrl: EXTERNAL_URL,
    defaultResource: new URL('/hub', EXTERNAL_URL),
    interactionPath: '/interaction'
  });
  autoApproveInteractions(app, provider);

  mountOidcProvider(app, provider, store, {
    externalUrl: EXTERNAL_URL,
    common: [
      (_req, res, next) => {
        res.set('Cache-Control', 'no-store');
        res.set('X-Frame-Options', 'DENY');
        next();
      }
    ]
  });

  app.use((_req, res) => {
    res.status(404).json({ reached: 'express' });
  });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('the mount boundary', () => {
  it('keeps the hub paths with a root issuer', async () => {
    const meta = await request(app).get('/.well-known/oauth-authorization-server').expect(200);
    expect(meta.body.issuer).toBe('http://127.0.0.1:9977');
    expect(meta.body.authorization_endpoint).toBe('http://127.0.0.1:9977/authorize');
    expect(meta.body.token_endpoint).toBe('http://127.0.0.1:9977/token');
    expect(meta.body.registration_endpoint).toBe('http://127.0.0.1:9977/register');
    expect(meta.body.revocation_endpoint).toBe('http://127.0.0.1:9977/revoke');
  });

  it('answers openid-configuration with the same document', async () => {
    // ChatGPT probes this path instead of, or before, the RFC 8414 one. The hub
    // used to build the alias by hand; here it is the library's own behaviour.
    const rfc8414 = await request(app).get('/.well-known/oauth-authorization-server').expect(200);
    const openid = await request(app).get('/.well-known/openid-configuration').expect(200);
    expect(openid.body).toEqual(rfc8414.body);
  });

  it('pins the values clients key their behaviour on', async () => {
    const meta = await request(app).get('/.well-known/oauth-authorization-server').expect(200);
    expect(meta.body.code_challenge_methods_supported).toEqual(['S256']);
    expect(meta.body.response_types_supported).toEqual(['code']);
    expect(meta.body.grant_types_supported).toContain('refresh_token');
  });

  it('does not swallow the rest of the app', async () => {
    // app.use(provider.callback()) at the root would answer everything: Koa's
    // handleRequest always responds, so a mounted app is a dead end.
    await request(app).get('/livez').expect(200, { status: 'ok' });
    await request(app).get('/definitely-not-oidc').expect(404, { reached: 'express' });
  });

  it('applies the hub security headers to provider routes', async () => {
    // These live in the Express router, which the Koa app never enters, so they
    // only apply because the mount puts them in front explicitly.
    const res = await request(app).get('/.well-known/oauth-authorization-server').expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-frame-options']).toBe('DENY');
  });

  it('answers the RFC 8414 path-insertion form as well', async () => {
    // Clients probing a specific resource try
    // /.well-known/oauth-authorization-server/<name>/mcp before the root
    // document. oidc-provider registers only the exact path, so the suffix form
    // exists because the mount adds it.
    const root = await request(app).get('/.well-known/oauth-authorization-server').expect(200);
    for (const suffix of ['/hub', '/files/mcp']) {
      const res = await request(app).get(`/.well-known/oauth-authorization-server${suffix}`).expect(200);
      expect(res.body).toEqual(root.body);
      const alias = await request(app).get(`/.well-known/openid-configuration${suffix}`).expect(200);
      expect(alias.body).toEqual(root.body);
    }
  });

  it('mounts the resume route, not just the endpoints', async () => {
    // initialize_app.js registers `resume` at `${routes.authorization}/:uid`.
    // Leaving it out dead-ends every authorization at the hub's 404 handler.
    const res = await request(app).get('/authorize/does-not-exist');
    expect(res.status).not.toBe(404);
    expect(res.body.reached).toBeUndefined();
  });
});

describe('the client quirks', () => {
  async function register(overrides: Record<string, unknown> = {}): Promise<Record<string, string>> {
    const res = await request(app)
      .post('/register')
      .send({
        client_name: 'vitest',
        redirect_uris: [REDIRECT_URI],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code'],
        response_types: ['code'],
        ...overrides
      })
      .expect(201);
    return res.body;
  }

  it('never expires a client secret', async () => {
    // ChatGPT registers once per connector and never re-registers.
    const client = await register();
    expect(client.client_secret_expires_at).toBe(0);
  });

  it('returns a throwaway secret to a public client but stores none', async () => {
    // ChatGPT refuses its own registration without one; Claude is correct and
    // would break if the stored client then demanded it.
    const client = await register();
    expect(typeof client.client_secret).toBe('string');
    expect(client.client_secret!.length).toBeGreaterThan(20);

    const stored = store.getClient(client.client_id!);
    expect(stored).toBeDefined();
    expect(stored!.client_secret).toBeUndefined();
  });

  it('registers into the store the admin CLI reads, not a parallel one', async () => {
    // `mcp-hub-admin clients list|prune|revoke`, the ceiling on unapproved
    // clients and the activity stamps all work on AuthStore.clients. A client
    // model kept in the generic artifact slot would leave the CLI reporting an
    // empty hub while the authorization server served a full one.
    const client = await register();
    expect(Object.keys(store.listClients())).toContain(client.client_id);
    expect(store.planClientPrune()).toBeDefined();
  });

  it('forces refresh_token into grant_types the client did not ask for', async () => {
    const client = await register({ grant_types: ['authorization_code'] });
    const stored = store.getClient(client.client_id!);
    expect(stored!.grant_types).toContain('refresh_token');
  });
});

describe('a full authorization, the way MCP clients actually do it', () => {
  async function flow(): Promise<{ tokens: Record<string, string>; clientId: string; agent: ReturnType<typeof request.agent> }> {
    const agent = request.agent(app);
    const registration = await agent
      .post('/register')
      .send({ client_name: 'vitest', redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: 'none', response_types: ['code'] })
      .expect(201);
    const clientId = registration.body.client_id as string;

    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

    let location =
      `/authorize?client_id=${clientId}&response_type=code&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
      `&code_challenge=${challenge}&code_challenge_method=S256&state=xyz`;
    // NOTE: no `scope` parameter, which is what real MCP clients send.

    let code: string | null = null;
    for (let hop = 0; hop < 10 && !code; hop += 1) {
      const res = await agent.get(location).redirects(0);
      const next = res.headers.location as string | undefined;
      if (!next) throw new Error(`authorization stalled at hop ${hop}: ${res.status} ${JSON.stringify(res.body)}`);
      if (next.startsWith(REDIRECT_URI)) {
        code = new URL(next).searchParams.get('code');
        if (!code) throw new Error(`authorization refused: ${next}`);
        break;
      }
      location = next.startsWith('http') ? new URL(next).pathname : next;
    }

    const tokens = await agent
      .post('/token')
      .type('form')
      .send({ grant_type: 'authorization_code', code: code!, redirect_uri: REDIRECT_URI, client_id: clientId, code_verifier: verifier })
      .expect(200);
    return { tokens: tokens.body, clientId, agent };
  }

  it('completes without a scope parameter', async () => {
    // oidc-provider filters granted scopes by requested ones and refuses an
    // empty intersection, so this only works because the mount defaults it.
    const { tokens } = await flow();
    expect(tokens.access_token).toBeTruthy();
  });

  it('keeps expires_in at the value clients cached', async () => {
    const { tokens } = await flow();
    expect(tokens.expires_in).toBe(15 * 60);
  });

  it('issues a refresh token without offline_access', async () => {
    const { tokens } = await flow();
    expect(typeof tokens.refresh_token).toBe('string');
  });

  it('issues an opaque access token, not a JWT', async () => {
    // The whole revocation story depends on this: oidc-provider never persists
    // a JWT access token, so a JWT could not be revoked before it expires.
    const { tokens } = await flow();
    expect(tokens.access_token.split('.')).toHaveLength(1);
    // An opaque token's value IS its jti (formats/opaque.js), so the record has
    // to be reachable in the store — that reachability is what makes immediate
    // revocation possible at all.
    const stored = store.oidcFind('AccessToken', tokens.access_token);
    expect(stored).toBeDefined();
    expect(stored!.clientId).toBeTruthy();
  });

  it('tolerates a client that presents the throwaway secret', async () => {
    // The hub ignored a presented secret before; oidc-provider would answer
    // 401 invalid_client, which would brick the connector that asked for it.
    const agent = request.agent(app);
    const registration = await agent
      .post('/register')
      .send({ client_name: 'vitest', redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: 'none', response_types: ['code'] })
      .expect(201);

    const res = await agent.post('/token').type('form').send({
      grant_type: 'refresh_token',
      refresh_token: 'not-a-real-token',
      client_id: registration.body.client_id,
      client_secret: registration.body.client_secret
    });
    // The grant is bad, but the CLIENT authenticated: 400, not 401.
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });

  it('revokes every existing token of a client immediately', async () => {
    const { tokens, clientId, agent } = await flow();

    // Control: without the cutoff the token works, so a later failure cannot be
    // blamed on refresh rotation.
    const before = await agent
      .post('/token')
      .type('form')
      .send({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId })
      .expect(200);

    store.revokeClientAccess(clientId);

    const after = await agent
      .post('/token')
      .type('form')
      .send({ grant_type: 'refresh_token', refresh_token: before.body.refresh_token, client_id: clientId });
    expect(after.status).toBe(400);
    expect(after.body.error).toBe('invalid_grant');
  });
});
