import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import bcrypt from 'bcryptjs';
import express from 'express';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { Express } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CimdResolver } from '../src/auth/cimd.js';
import { mountOidcProvider } from '../src/auth/oidc/mount.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';

import { createOidcInteractionRoutes } from '../src/auth/oidc/interactions.js';
import { OidcTokenVerifier } from '../src/auth/oidc/verifier.js';
import { mintApiToken } from '../src/auth/provider.js';
import { buildOidcProvider } from '../src/auth/oidc/provider.js';
import { AuthStore } from '../src/auth/store.js';

const EXTERNAL_URL = 'http://127.0.0.1:9977/';
const REDIRECT_URI = 'https://claude.ai/api/mcp/auth_callback';

let tmpDir: string;
let store: AuthStore;
let app: Express;

const PASSWORD = 'test-password';

/** supertest speaks paths. Redirects out of the provider are absolute; the one
 *  to the interaction page is relative, because that URL is ours. */
function toPath(url: string): string {
  if (!url.startsWith('http')) return url;
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
}

/**
 * Drives the real login page: follow to the interaction, submit the password,
 * follow back to the resume route, and read the code off the callback. This is
 * the whole journey a connector makes, with nothing stubbed out.
 */
async function authorize(
  application: Express,
  clientId: string,
  extraQuery: Record<string, string> = {}
): Promise<{ code: string; agent: ReturnType<typeof request.agent>; verifier: string }> {
  const agent = request.agent(application);
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const query = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'xyz',
    ...extraQuery
  });

  let location = `/authorize?${query.toString()}`;
  for (let hop = 0; hop < 12; hop += 1) {
    if (location.startsWith(REDIRECT_URI)) {
      const code = new URL(location).searchParams.get('code');
      if (!code) throw new Error(`authorization refused: ${location}`);
      return { code, agent, verifier };
    }
    const res = await agent.get(location).redirects(0);
    if (res.status === 200 && /name="password"/.test(res.text)) {
      // The login page. Its hidden `request` field carries the interaction id.
      const uid = /name="request" value="([^"]+)"/.exec(res.text)?.[1];
      const submitted = await agent
        .post(`/interaction/${uid}/login`)
        .type('form')
        .send({ password: PASSWORD, request: uid! })
        .redirects(0);
      location = toPath(submitted.headers.location as string);
      continue;
    }
    const next = res.headers.location as string | undefined;
    if (!next) throw new Error(`stalled at hop ${hop}: ${res.status} ${res.text.slice(0, 200)}`);
    location = next.startsWith(REDIRECT_URI) ? next : toPath(next);
  }
  throw new Error('authorization did not settle');
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
  app.use(createOidcInteractionRoutes({ provider, store, externalUrl: EXTERNAL_URL, password: PASSWORD }));

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
    const registration = await request(app)
      .post('/register')
      .send({ client_name: 'vitest', redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: 'none', response_types: ['code'] })
      .expect(201);
    const clientId = registration.body.client_id as string;

    // No `scope` parameter anywhere, which is what real MCP clients send.
    const { code, agent, verifier } = await authorize(app, clientId);
    const tokens = await agent
      .post('/token')
      .type('form')
      .send({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, client_id: clientId, code_verifier: verifier })
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

describe('client ID metadata documents and private_key_jwt', () => {
  const CLIENT_ID = 'https://client.example/oauth/client.json';
  let documents: Map<string, string>;
  let fetched: string[];
  let cimdApp: Express;
  let cimdStore: AuthStore;
  let cimdDir: string;

  /** Stands in for the client's own web server; never reaches the network. */
  const stubFetch: typeof fetch = async input => {
    const url = input instanceof Request ? input.url : String(input);
    fetched.push(url);
    const body = documents.get(url);
    if (!body) return new Response('not found', { status: 404 });
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  };

  function serve(url: string, document: unknown): void {
    documents.set(url, JSON.stringify(document));
  }

  beforeEach(() => {
    documents = new Map();
    fetched = [];
    cimdDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-cimd-oidc-'));
    cimdStore = new AuthStore(cimdDir);
    cimdApp = express();
    const resolver = new CimdResolver({ fetchImpl: stubFetch, allowPrivateAddresses: true });
    const provider = buildOidcProvider(cimdStore, {
      externalUrl: EXTERNAL_URL,
      defaultResource: new URL('/hub', EXTERNAL_URL),
      interactionPath: '/interaction',
      cimd: resolver
    });
    cimdApp.use(createOidcInteractionRoutes({ provider, store: cimdStore, externalUrl: EXTERNAL_URL, password: PASSWORD, cimd: resolver }));
    mountOidcProvider(cimdApp, provider, cimdStore, { externalUrl: EXTERNAL_URL });
    cimdApp.use((_req, res) => {
      res.status(404).json({ reached: 'express' });
    });
  });

  afterEach(() => {
    fs.rmSync(cimdDir, { recursive: true, force: true });
  });

  it('advertises CIMD and exactly the three client auth methods', async () => {
    const meta = await request(cimdApp).get('/.well-known/oauth-authorization-server').expect(200);
    expect(meta.body.client_id_metadata_document_supported).toBe(true);
    // Narrower than oidc-provider's default, which also offers
    // client_secret_basic and client_secret_jwt: nothing the hub issues can use
    // them, so they would be surface without a purpose.
    expect(meta.body.token_endpoint_auth_methods_supported.sort()).toEqual(['client_secret_post', 'none', 'private_key_jwt']);
    expect(meta.body.token_endpoint_auth_signing_alg_values_supported).toContain('EdDSA');
  });

  it('resolves an https client_id through the hub resolver, not the library one', async () => {
    serve(CLIENT_ID, {
      client_id: CLIENT_ID,
      client_name: 'Vitest CIMD client',
      redirect_uris: [REDIRECT_URI],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none'
    });

    const res = await request(cimdApp)
      .get('/authorize')
      .query({
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: 'code',
        code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
        code_challenge_method: 'S256',
        state: 'xyz'
      })
      .redirects(0);

    // Recognised: it is sent to log in rather than refused as an unknown client.
    expect(res.status).toBe(303);
    expect(res.headers.location).toMatch(/^\/interaction\//);
    // The hub's own fetch did the work. oidc-provider's fetcher would not go
    // through this stub at all.
    expect(fetched).toEqual([CLIENT_ID]);
    // And nothing was persisted: a CIMD client is not a registration.
    expect(cimdStore.getClient(CLIENT_ID)).toBeUndefined();
  });

  it('refuses an https client_id the hub resolver rejected, without fetching again', async () => {
    // Nothing served, so the document 404s and the resolver says no. The
    // library must not then try its own fetch: allowFetch refuses.
    const res = await request(cimdApp)
      .get('/authorize')
      .query({
        client_id: 'https://client.example/unknown.json',
        redirect_uri: REDIRECT_URI,
        response_type: 'code',
        code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
        code_challenge_method: 'S256',
        state: 'xyz'
      })
      .redirects(0);
    expect(res.status).toBe(400);
    expect(fetched).toEqual(['https://client.example/unknown.json']);
  });

  it('authenticates a private_key_jwt client at the token endpoint', async () => {
    const { publicKey, privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
    const jwk = await exportJWK(publicKey);
    serve(CLIENT_ID, {
      client_id: CLIENT_ID,
      client_name: 'Vitest confidential client',
      redirect_uris: [REDIRECT_URI],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'private_key_jwt',
      token_endpoint_auth_signing_alg: 'EdDSA',
      jwks: { keys: [{ ...jwk, alg: 'EdDSA', use: 'sig' }] }
    });

    const { code, agent, verifier } = await authorize(cimdApp, CLIENT_ID);
    expect(code).toBeTruthy();

    // RFC 7523: the client proves itself with a JWT it signed, because a
    // metadata-document client can hold no shared secret.
    const assertion = await new SignJWT({})
      .setProtectedHeader({ alg: 'EdDSA' })
      .setIssuer(CLIENT_ID)
      .setSubject(CLIENT_ID)
      .setAudience(`${new URL(EXTERNAL_URL).origin}/token`)
      .setJti(crypto.randomBytes(16).toString('hex'))
      .setIssuedAt()
      .setExpirationTime('2m')
      .sign(privateKey);

    const tokens = await agent.post('/token').type('form').send({
      grant_type: 'authorization_code',
      code: code!,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: verifier,
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: assertion
    });
    expect(tokens.status).toBe(200);
    expect(tokens.body.access_token).toBeTruthy();
  });

  it('refuses a replayed private_key_jwt assertion', async () => {
    // The jti is accepted exactly once; without ReplayDetection a captured
    // assertion would be reusable until it expires.
    const { publicKey, privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
    const jwk = await exportJWK(publicKey);
    serve(CLIENT_ID, {
      client_id: CLIENT_ID,
      client_name: 'Vitest confidential client',
      redirect_uris: [REDIRECT_URI],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'private_key_jwt',
      token_endpoint_auth_signing_alg: 'EdDSA',
      jwks: { keys: [{ ...jwk, alg: 'EdDSA', use: 'sig' }] }
    });

    const assertion = await new SignJWT({})
      .setProtectedHeader({ alg: 'EdDSA' })
      .setIssuer(CLIENT_ID)
      .setSubject(CLIENT_ID)
      .setAudience(`${new URL(EXTERNAL_URL).origin}/token`)
      .setJti(crypto.randomBytes(16).toString('hex'))
      .setIssuedAt()
      .setExpirationTime('2m')
      .sign(privateKey);

    const body = {
      grant_type: 'refresh_token',
      refresh_token: 'not-a-real-token',
      client_id: CLIENT_ID,
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: assertion
    };
    // First use: the client authenticates, only the grant is bad.
    const first = await request(cimdApp).post('/token').type('form').send(body);
    expect(first.body.error).toBe('invalid_grant');
    // Second use of the same jti: the CLIENT is now refused.
    const second = await request(cimdApp).post('/token').type('form').send(body);
    expect(second.body.error).toBe('invalid_client');
  });
});

describe('the login and consent pages', () => {
  async function register(): Promise<string> {
    const res = await request(app)
      .post('/register')
      .send({ client_name: 'vitest', redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: 'none', response_types: ['code'] })
      .expect(201);
    return res.body.client_id as string;
  }

  /**
   * Submits the password AND follows the resume redirect. The session is only
   * established when the authorization request is resumed and consumes the
   * login result, so stopping at the POST leaves the operator signed out.
   */
  async function signIn(agent: ReturnType<typeof request.agent>, uid: string): Promise<void> {
    const submitted = await agent.post(`/interaction/${uid}/login`).type('form').send({ password: PASSWORD, request: uid }).redirects(0);
    await agent.get(toPath(submitted.headers.location as string)).redirects(0);
  }

  /** Walks to the interaction page and returns it, without submitting. */
  async function reachInteraction(agent: ReturnType<typeof request.agent>, clientId: string) {
    const query = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: REDIRECT_URI,
      code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      code_challenge_method: 'S256',
      state: 'xyz'
    });
    const started = await agent.get(`/authorize?${query.toString()}`).redirects(0);
    if (!started.headers.location) throw new Error(`authorize: ${started.status} ${started.text.slice(0, 300)}`);
    const location = toPath(started.headers.location as string);
    return { page: await agent.get(location).redirects(0), path: location };
  }

  it('refuses a wrong password and says so on the same form', async () => {
    const clientId = await register();
    const agent = request.agent(app);
    const { page } = await reachInteraction(agent, clientId);
    const uid = /name="request" value="([^"]+)"/.exec(page.text)![1];

    const wrong = await agent.post(`/interaction/${uid}/login`).type('form').send({ password: 'nope', request: uid });
    expect(wrong.status).toBe(401);
    expect(wrong.text).toContain('Wrong password');
    // The retry form has to reach the same interaction.
    expect(wrong.text).toContain(`value="${uid}"`);
  });

  it('sets the session cookie the upstream callback reads', async () => {
    // hasValidSession() is used outside the auth layer, by the upstream OAuth
    // callback. If only oidc-provider's own cookie were set, the operator would
    // have to log in a second time for something that looks unrelated.
    const clientId = await register();
    const agent = request.agent(app);
    const { page } = await reachInteraction(agent, clientId);
    const uid = /name="request" value="([^"]+)"/.exec(page.text)![1];
    const ok = await agent.post(`/interaction/${uid}/login`).type('form').send({ password: PASSWORD, request: uid });
    const cookies = (ok.headers['set-cookie'] as unknown as string[]).join('; ');
    expect(cookies).toContain('mcp_hub_session=');
  });

  it('asks for consent when a signed-in operator meets a NEW client', async () => {
    // Typing the password approves the client that triggered it, and only that
    // one. A second client has to be shown, or a page that exists to ask "did
    // you start this?" would never appear again.
    const first = await register();
    const agent = request.agent(app);
    const { page } = await reachInteraction(agent, first);
    await signIn(agent, /name="request" value="([^"]+)"/.exec(page.text)![1]);

    const second = await register();
    const { page: consent } = await reachInteraction(agent, second);
    expect(consent.text).toContain('Authorize access?');
    expect(consent.text).toContain('name="csrf"');
  });

  it('refuses a consent submission with a bad CSRF token', async () => {
    const first = await register();
    const agent = request.agent(app);
    const { page } = await reachInteraction(agent, first);
    await signIn(agent, /name="request" value="([^"]+)"/.exec(page.text)![1]);

    const second = await register();
    const { page: consent } = await reachInteraction(agent, second);
    const consentUid = /name="request" value="([^"]+)"/.exec(consent.text)![1];
    const refused = await agent
      .post(`/interaction/${consentUid}/consent`)
      .type('form')
      .send({ request: consentUid, csrf: 'forged', action: 'approve' });
    expect(refused.status).toBe(403);
  });

  it('completes the flow when consent is approved', async () => {
    const first = await register();
    const agent = request.agent(app);
    const { page } = await reachInteraction(agent, first);
    await signIn(agent, /name="request" value="([^"]+)"/.exec(page.text)![1]);

    const second = await register();
    const { page: consent } = await reachInteraction(agent, second);
    const consentUid = /name="request" value="([^"]+)"/.exec(consent.text)![1];
    const csrf = /name="csrf" value="([^"]+)"/.exec(consent.text)![1];
    const approved = await agent
      .post(`/interaction/${consentUid}/consent`)
      .type('form')
      .send({ request: consentUid, csrf, action: 'approve' })
      .redirects(0);
    const back = await agent.get(toPath(approved.headers.location as string)).redirects(0);
    expect(back.headers.location).toContain('code=');
    // Approving is remembered, so the same client is not asked again.
    expect(store.getApproval(second)).toBeDefined();
  });

  it('tells the operator plainly when the window was left open too long', async () => {
    const res = await request(app).get('/interaction/not-a-real-interaction');
    expect(res.status).toBe(400);
    expect(res.text).toContain('expired');
  });

  it('blocks after repeated wrong passwords', async () => {
    const clientId = await register();
    const agent = request.agent(app);
    const { page } = await reachInteraction(agent, clientId);
    const uid = /name="request" value="([^"]+)"/.exec(page.text)![1];
    let last = 0;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const res = await agent.post(`/interaction/${uid}/login`).type('form').send({ password: 'nope', request: uid });
      last = res.status;
    }
    expect(last).toBe(429);
  });

  it('sends the client away when consent is denied', async () => {
    const first = await register();
    const agent = request.agent(app);
    const { page } = await reachInteraction(agent, first);
    await signIn(agent, /name="request" value="([^"]+)"/.exec(page.text)![1]);

    const second = await register();
    const { page: consent } = await reachInteraction(agent, second);
    const consentUid = /name="request" value="([^"]+)"/.exec(consent.text)![1];
    const csrf = /name="csrf" value="([^"]+)"/.exec(consent.text)![1];
    const denied = await agent
      .post(`/interaction/${consentUid}/consent`)
      .type('form')
      .send({ request: consentUid, csrf, action: 'deny' })
      .redirects(0);
    // Resumes, and the resume redirects back to the client with the refusal.
    const location = toPath(denied.headers.location as string);
    const back = await agent.get(location).redirects(0);
    expect(back.headers.location).toContain('error=access_denied');
  });
});

describe('bearer authentication with both token shapes', () => {
  /** A protected route standing in for /hub, using the SDK middleware the hub
   *  uses, so the verifier is exercised exactly as it will be in production. */
  function protectedApp(store: AuthStore, resource: URL) {
    const guarded = express();
    const verifier = new OidcTokenVerifier(store, {
      externalUrl: EXTERNAL_URL,
      requireResource: true,
      resolveResource: url => (url.href === resource.href ? resource : undefined)
    });
    guarded.get('/hub', requireBearerAuth({ verifier }), (_req, res) => {
      res.json({ ok: true });
    });
    return guarded;
  }

  it('accepts an opaque OAuth token and refuses it again once revoked', async () => {
    const registration = await request(app)
      .post('/register')
      .send({ client_name: 'vitest', redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: 'none', response_types: ['code'] })
      .expect(201);
    const clientId = registration.body.client_id as string;
    const { code, agent, verifier } = await authorize(app, clientId, { resource: `${new URL(EXTERNAL_URL).origin}/hub` });
    const tokens = await agent
      .post('/token')
      .type('form')
      .send({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, client_id: clientId, code_verifier: verifier })
      .expect(200);

    const guarded = protectedApp(store, new URL('/hub', EXTERNAL_URL));
    await request(guarded).get('/hub').set('Authorization', `Bearer ${tokens.body.access_token}`).expect(200);

    // This is the whole reason access tokens are opaque: a JWT could not be
    // withdrawn before it expired.
    store.revokeClientAccess(clientId);
    await request(guarded).get('/hub').set('Authorization', `Bearer ${tokens.body.access_token}`).expect(401);
  });

  it('still accepts an admin-minted API token, which stays a JWT', async () => {
    const resource = new URL('/hub', EXTERNAL_URL);
    const minted = await mintApiToken(store, EXTERNAL_URL, resource, 30, 'vitest');
    const guarded = protectedApp(store, resource);
    await request(guarded).get('/hub').set('Authorization', `Bearer ${minted.token}`).expect(200);

    store.revokeApiToken(minted.id);
    await request(guarded).get('/hub').set('Authorization', `Bearer ${minted.token}`).expect(401);
  });

  it('refuses a token minted for another resource', async () => {
    const minted = await mintApiToken(store, EXTERNAL_URL, new URL('/other/mcp', EXTERNAL_URL), 30, 'vitest');
    const guarded = protectedApp(store, new URL('/hub', EXTERNAL_URL));
    await request(guarded).get('/hub').set('Authorization', `Bearer ${minted.token}`).expect(401);
  });

  it('refuses a syntactically valid but unknown token', async () => {
    const guarded = protectedApp(store, new URL('/hub', EXTERNAL_URL));
    await request(guarded).get('/hub').set('Authorization', 'Bearer not-a-token-at-all').expect(401);
  });
});

describe('RFC 7592 registration management', () => {
  async function register() {
    const res = await request(app)
      .post('/register')
      .send({ client_name: 'vitest', redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: 'none', response_types: ['code'] })
      .expect(201);
    return res.body as { client_id: string; registration_access_token: string; registration_client_uri: string };
  }

  it('hands out a management URI and a token that reads the registration back', async () => {
    const client = await register();
    expect(client.registration_client_uri).toBe(`${new URL(EXTERNAL_URL).origin}/register/${client.client_id}`);
    const read = await request(app)
      .get(`/register/${client.client_id}`)
      .set('Authorization', `Bearer ${client.registration_access_token}`)
      .expect(200);
    expect(read.body.client_id).toBe(client.client_id);
  });

  it('refuses management without the registration token', async () => {
    const client = await register();
    await request(app).get(`/register/${client.client_id}`).expect(401);
    await request(app).get(`/register/${client.client_id}`).set('Authorization', 'Bearer wrong').expect(401);
  });

  it('updates and then deletes the registration, and the client is gone from the store', async () => {
    const client = await register();
    const updated = await request(app)
      .put(`/register/${client.client_id}`)
      .set('Authorization', `Bearer ${client.registration_access_token}`)
      .send({
        client_id: client.client_id,
        client_name: 'renamed',
        redirect_uris: [REDIRECT_URI],
        token_endpoint_auth_method: 'none',
        response_types: ['code'],
        grant_types: ['authorization_code', 'refresh_token']
      })
      .expect(200);
    expect(updated.body.client_name).toBe('renamed');
    expect(store.getClient(client.client_id)?.client_name).toBe('renamed');

    await request(app)
      .delete(`/register/${client.client_id}`)
      .set('Authorization', `Bearer ${client.registration_access_token}`)
      .expect(204);
    // The admin CLI's view has to agree: one store, not two.
    expect(store.getClient(client.client_id)).toBeUndefined();
  });
});

describe('the password check', () => {
  it('accepts a bcrypt hash instead of a plaintext password', async () => {
    // How the hub is meant to be configured in production: PASSWORD_HASH
    // rather than PASSWORD, so the secret is not readable in the environment.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-oidc-hash-'));
    try {
      const hashed = new AuthStore(dir);
      const hashedApp = express();
      const provider = buildOidcProvider(hashed, { externalUrl: EXTERNAL_URL, defaultResource: new URL('/hub', EXTERNAL_URL) });
      hashedApp.use(
        createOidcInteractionRoutes({
          provider,
          store: hashed,
          externalUrl: EXTERNAL_URL,
          passwordHash: bcrypt.hashSync(PASSWORD, 4)
        })
      );
      mountOidcProvider(hashedApp, provider, hashed, { externalUrl: EXTERNAL_URL });

      const registration = await request(hashedApp)
        .post('/register')
        .send({ client_name: 'vitest', redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: 'none', response_types: ['code'] })
        .expect(201);
      const { code } = await authorize(hashedApp, registration.body.client_id);
      expect(code).toBeTruthy();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
