import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHub } from '../src/index.js';
import { AuthStore } from '../src/auth/store.js';
import { createSessionCookie } from '../src/auth/session.js';
import { startUpstreamLogin } from '../src/upstream/login.js';
import { authorizeInBrowser, registerPublicClient } from './auth-flow.js';

/**
 * Consent has to be bound to the exact resource it was shown for: approving
 * server A must never silently approve server B, and the hub's own aggregate
 * resource needs a page of its own. Alongside that: a DPoP capability the
 * discovery document still advertised without either side implementing it,
 * `mcp-hub-admin clients revoke` under-reporting how many refresh tokens it
 * actually invalidated, and the admin CLI printing a remote upstream's raw
 * error text unsanitised to the operator's terminal.
 */

const PASSWORD = 'test-password';
const REDIRECT_URI = 'http://localhost:33418/callback';
const ANNOTATED = path.resolve('test/fixtures/annotated-server.mjs');

function tmpStoreDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-consent-store-'));
}

/** Runs the real mcp-hub-admin CLI as a separate process, exactly the
 *  documented `docker exec` invocation, and hands back its raw output bytes
 *  -- unlike a string, a Buffer cannot have already lost a control byte to
 *  whatever decoded it, which matters for the terminal-sanitisation tests
 *  below. */
function runAdminCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: Buffer; stderr: Buffer }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', path.resolve('src/admin.ts'), ...args], {
      cwd: path.resolve('.'),
      env: { ...process.env, ...env }
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    child.on('error', reject);
    child.on('exit', code => resolve({ code, stdout: Buffer.concat(stdoutChunks), stderr: Buffer.concat(stderrChunks) }));
  });
}

function initializeCall(app: Parameters<typeof request>[0], pathname: string, token: string) {
  return request(app)
    .post(pathname)
    .set('Authorization', `Bearer ${token}`)
    .set('Accept', 'application/json, text/event-stream')
    .send({
      jsonrpc: '2.0',
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'vitest', version: '0.0.0' } },
      id: 1
    });
}

describe('consent is bound to the resource it was shown for', () => {
  let hub: Awaited<ReturnType<typeof createHub>>;
  let tmpDir: string;
  let externalUrl: string;
  let resourceA: string;
  let resourceB: string;
  let hubResource: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-consent-'));
    const configPath = path.join(tmpDir, 'mcp.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          servera: { command: process.execPath, args: [ANNOTATED] },
          serverb: { command: process.execPath, args: [ANNOTATED] }
        }
      })
    );
    externalUrl = 'http://localhost:4100';
    hub = await createHub({
      externalUrl,
      configPath,
      dataPath: path.join(tmpDir, 'data'),
      password: PASSWORD,
      // requireResourceBoundTokens intentionally omitted: the documented
      // default deployment.
      idleTimeoutMinutes: 0
    });
    await hub.supervisor.waitUntilSettled();
    const origin = new URL(externalUrl).origin;
    resourceA = `${origin}/servera/mcp`;
    resourceB = `${origin}/serverb/mcp`;
    hubResource = `${origin}/hub`;
  }, 30_000);

  afterAll(async () => {
    hub?.stopMaintenance();
    hub?.watcher.stop();
    await hub?.supervisor.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it(
    'approves per resource, not per client: A (1 page) -> B shown, denied, then approved -> A silent -> hub shown -> legacy approval shown -> refresh for A still works',
    async () => {
      const clientId = await registerPublicClient(hub.app, REDIRECT_URI);
      const agent = request.agent(hub.app);

      // Approve for A: exactly one page -- typing the password is the consent.
      const first = await authorizeInBrowser(hub.app, clientId, { password: PASSWORD, redirectUri: REDIRECT_URI, resource: resourceA, agent });
      expect(first.pages.length).toBe(1);
      expect(first.code).toBeTruthy();
      const tokensA = await request(hub.app)
        .post('/token')
        .type('form')
        .send({
          grant_type: 'authorization_code',
          code: first.code,
          code_verifier: first.verifier,
          client_id: clientId,
          redirect_uri: REDIRECT_URI,
          resource: resourceA
        })
        .expect(200);
      const refreshA = tokensA.body.refresh_token as string;
      await initializeCall(hub.app, '/servera/mcp', tokensA.body.access_token as string).expect(200);

      // Same client, same live session, a DIFFERENT resource: not silent.
      const denyAttempt = await authorizeInBrowser(hub.app, clientId, {
        password: PASSWORD,
        redirectUri: REDIRECT_URI,
        resource: resourceB,
        agent,
        consent: 'deny',
        allowError: true
      });
      expect(denyAttempt.pages.length).toBeGreaterThan(0);
      expect(denyAttempt.code).toBe('');

      // Approving now gives a token for B.
      const secondB = await authorizeInBrowser(hub.app, clientId, {
        password: PASSWORD,
        redirectUri: REDIRECT_URI,
        resource: resourceB,
        agent
      });
      expect(secondB.pages.length).toBeGreaterThan(0);
      expect(secondB.code).toBeTruthy();
      const tokensB = await request(hub.app)
        .post('/token')
        .type('form')
        .send({
          grant_type: 'authorization_code',
          code: secondB.code,
          code_verifier: secondB.verifier,
          client_id: clientId,
          redirect_uri: REDIRECT_URI,
          resource: resourceB
        })
        .expect(200);
      await initializeCall(hub.app, '/serverb/mcp', tokensB.body.access_token as string).expect(200);

      // A again: silent, because it really was approved before.
      const again = await authorizeInBrowser(hub.app, clientId, { password: PASSWORD, redirectUri: REDIRECT_URI, resource: resourceA, agent });
      expect(again.pages.length).toBe(0);

      // The hub aggregate is its own resource and was never shown: not silent.
      const hubAttempt = await authorizeInBrowser(hub.app, clientId, { password: PASSWORD, redirectUri: REDIRECT_URI, resource: hubResource, agent });
      expect(hubAttempt.pages.length).toBeGreaterThan(0);

      // A legacy approval (redirect_uri approved, no `resources` recorded --
      // what a state.json from <= 0.11.3 loads as) still shows a page for a
      // brand-new resource, even under the SAME live session.
      const legacyClientId = await registerPublicClient(hub.app, REDIRECT_URI);
      hub.store.saveApproval(legacyClientId, REDIRECT_URI, 'legacy client');
      expect(hub.store.getApproval(legacyClientId)?.resources).toEqual([]);
      const legacyAttempt = await authorizeInBrowser(hub.app, legacyClientId, {
        password: PASSWORD,
        redirectUri: REDIRECT_URI,
        resource: resourceA,
        agent
      });
      expect(legacyAttempt.pages.length).toBeGreaterThan(0);

      // Refresh tokens never pass through /authorize, so none of the above
      // touches them: A's refresh token still works.
      const refreshed = await request(hub.app)
        .post('/token')
        .type('form')
        .send({ grant_type: 'refresh_token', refresh_token: refreshA, client_id: clientId })
        .expect(200);
      expect(refreshed.body.access_token).toBeTruthy();
    },
    30_000
  );

  it('revoke reports every live refresh token and makes all of them unusable', async () => {
    const clientId = await registerPublicClient(hub.app, REDIRECT_URI);
    const agent = request.agent(hub.app);

    const flow1 = await authorizeInBrowser(hub.app, clientId, { password: PASSWORD, redirectUri: REDIRECT_URI, resource: resourceA, agent });
    const tokens1 = await request(hub.app)
      .post('/token')
      .type('form')
      .send({ grant_type: 'authorization_code', code: flow1.code, code_verifier: flow1.verifier, client_id: clientId, redirect_uri: REDIRECT_URI, resource: resourceA })
      .expect(200);

    // Same client, same already-approved resource: silent, and a second,
    // independent authorization_code round trip -- so two LIVE refresh
    // tokens exist for the one client at once.
    const flow2 = await authorizeInBrowser(hub.app, clientId, { password: PASSWORD, redirectUri: REDIRECT_URI, resource: resourceA, agent });
    expect(flow2.pages.length).toBe(0);
    const tokens2 = await request(hub.app)
      .post('/token')
      .type('form')
      .send({ grant_type: 'authorization_code', code: flow2.code, code_verifier: flow2.verifier, client_id: clientId, redirect_uri: REDIRECT_URI, resource: resourceA })
      .expect(200);

    const result = hub.store.revokeClientAccess(clientId);
    expect(result.refreshTokens).toBe(2);

    await request(hub.app)
      .post('/token')
      .type('form')
      .send({ grant_type: 'refresh_token', refresh_token: tokens1.body.refresh_token, client_id: clientId })
      .expect(400);
    await request(hub.app)
      .post('/token')
      .type('form')
      .send({ grant_type: 'refresh_token', refresh_token: tokens2.body.refresh_token, client_id: clientId })
      .expect(400);
  });

  it('reports zero for a client that never obtained a refresh token', async () => {
    const clientId = await registerPublicClient(hub.app, REDIRECT_URI);
    const result = hub.store.revokeClientAccess(clientId);
    expect(result.refreshTokens).toBe(0);
  });

  it('does not advertise DPoP support in discovery', async () => {
    const metadata = await request(hub.app).get('/.well-known/oauth-authorization-server').expect(200);
    expect(metadata.body.dpop_signing_alg_values_supported).toBeUndefined();
  });

  it('ignores a DPoP proof header at /token and mints a plain bearer token', async () => {
    const clientId = await registerPublicClient(hub.app, REDIRECT_URI);
    const flow = await authorizeInBrowser(hub.app, clientId, { password: PASSWORD, redirectUri: REDIRECT_URI, resource: resourceA });
    const tokens = await request(hub.app)
      .post('/token')
      .set('DPoP', 'garbage-that-a-real-dpop-check-would-reject')
      .type('form')
      .send({ grant_type: 'authorization_code', code: flow.code, code_verifier: flow.verifier, client_id: clientId, redirect_uri: REDIRECT_URI, resource: resourceA })
      .expect(200);
    expect(tokens.body.token_type).toBe('Bearer');
  });
});

describe('the resource actually bound when none is requested', () => {
  it('stores the unbound-mode default audience, so a repeat with no resource stays silent', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-consent-default-'));
    const configPath = path.join(dir, 'mcp.json');
    fs.writeFileSync(configPath, JSON.stringify({ mcpServers: {} }));
    const externalUrl = 'http://localhost:4101';
    const hub = await createHub({
      externalUrl,
      configPath,
      dataPath: path.join(dir, 'data'),
      password: PASSWORD,
      // Unbound mode: a request naming no resource binds to the issuer
      // itself, per resourceIndicators.defaultResource in provider.ts.
      requireResourceBoundTokens: false,
      idleTimeoutMinutes: 0
    });
    try {
      await hub.supervisor.waitUntilSettled();
      const clientId = await registerPublicClient(hub.app, REDIRECT_URI);
      const agent = request.agent(hub.app);
      const first = await authorizeInBrowser(hub.app, clientId, { password: PASSWORD, redirectUri: REDIRECT_URI, agent });
      expect(first.pages.length).toBe(1);

      const issuer = new URL(externalUrl).href;
      expect(hub.store.getApproval(clientId)?.resources).toEqual([issuer]);

      // Same client, still no resource named: silent, because what got
      // stored above is exactly what loadExistingGrant compares against.
      const again = await authorizeInBrowser(hub.app, clientId, { password: PASSWORD, redirectUri: REDIRECT_URI, agent });
      expect(again.pages.length).toBe(0);
    } finally {
      hub.stopMaintenance();
      hub.watcher.stop();
      await hub.supervisor.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('AuthStore: resource-scoped approvals (store-level edge cases)', () => {
  it('accumulates resources across repeated approvals, without duplicates', () => {
    const store = new AuthStore(tmpStoreDir());
    store.saveApproval('c1', 'https://x.test/cb', 'Example', ['https://x.test/servera/mcp']);
    store.saveApproval('c1', 'https://x.test/cb', undefined, ['https://x.test/serverb/mcp']);
    store.saveApproval('c1', 'https://x.test/cb', undefined, ['https://x.test/servera/mcp']); // no duplicate
    expect(store.getApproval('c1')?.resources.toSorted()).toEqual(['https://x.test/servera/mcp', 'https://x.test/serverb/mcp']);
  });

  it('defaults to no approved resource when none is given, matching mcp-hub-admin clients add', () => {
    const store = new AuthStore(tmpStoreDir());
    store.saveApproval('c1', 'https://x.test/cb', 'Example');
    expect(store.getApproval('c1')?.resources).toEqual([]);
  });

  it('treats an approval from a state.json written before this field existed as approved for no resource', () => {
    const dir = tmpStoreDir();
    fs.writeFileSync(
      path.join(dir, 'state.json'),
      JSON.stringify({
        cookieSecret: 'kept-secret',
        approvals: { 'legacy-client': { redirectUris: ['https://x.test/cb'], clientName: 'Old', approvedAt: 1000 } }
      })
    );
    const store = new AuthStore(dir);
    const approval = store.getApproval('legacy-client');
    expect(approval).toBeDefined();
    expect(approval!.resources).toEqual([]);
    expect(Array.isArray(approval!.resources)).toBe(true);
  });

  it('tolerates a malformed resources field rather than refusing to load the file, prototype names included', () => {
    const dir = tmpStoreDir();
    fs.writeFileSync(
      path.join(dir, 'state.json'),
      JSON.stringify({
        cookieSecret: 'kept-secret',
        approvals: {
          'weird-client': { redirectUris: ['https://x.test/cb'], resources: 'not-an-array', approvedAt: 1000 },
          constructor: { redirectUris: ['https://x.test/cb'], resources: [123, null, 'https://x.test/hub'], approvedAt: 1000 }
        }
      })
    );
    const store = new AuthStore(dir);
    expect(store.getApproval('weird-client')?.resources).toEqual([]);
    expect(store.getApproval('constructor')?.resources).toEqual(['https://x.test/hub']);
    // The prototype-safety invariant the rest of the file already relies on.
    expect(Object.getPrototypeOf(store.listApprovals())).not.toBeNull();
  });

  it('counts a live oidc-provider RefreshToken artifact alongside a legacy-map one', () => {
    const store = new AuthStore(tmpStoreDir());
    store.saveApproval('c1', 'https://x.test/cb');
    store.oidcUpsert('RefreshToken', 'rt-live', { clientId: 'c1', iat: Math.floor(Date.now() / 1000) }, 3600);
    store.saveRefreshToken('legacy-token', { clientId: 'c1', scopes: [], expiresAt: Math.floor(Date.now() / 1000) + 3600 });

    const result = store.revokeClientAccess('c1');
    expect(result.refreshTokens).toBe(2);
    expect(store.oidcFind('RefreshToken', 'rt-live')).toBeUndefined();
    expect(store.getRefreshToken('legacy-token')).toBeUndefined();
  });

  it('does not count an already-expired or already-consumed RefreshToken artifact', () => {
    const store = new AuthStore(tmpStoreDir());
    store.oidcUpsert('RefreshToken', 'expired', { clientId: 'c1', iat: 1 }, -10);
    store.oidcUpsert('RefreshToken', 'consumed', { clientId: 'c1', iat: Math.floor(Date.now() / 1000) }, 3600);
    store.oidcConsume('RefreshToken', 'consumed');
    store.oidcUpsert('RefreshToken', 'live', { clientId: 'c1', iat: Math.floor(Date.now() / 1000) }, 3600);

    const result = store.revokeClientAccess('c1');
    expect(result.refreshTokens).toBe(1);
  });
});

describe('admin CLI sanitizes upstream error text', () => {
  const MALICIOUS = '\u001b]0;PWNED\u0007\u001b[31mFAKE ERROR: your refresh token was revoked\r‮evil\u001b[0m';

  async function startMaliciousUpstream(): Promise<{ url: string; close: () => Promise<void> }> {
    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));
    const challenges = new Map<string, { challenge: string }>();
    let counter = 1;
    let server: ReturnType<express.Express['listen']>;
    const base = (): string => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    app.get('/.well-known/oauth-authorization-server', (_req, res) => {
      res.json({
        issuer: base(),
        authorization_endpoint: `${base()}/authorize`,
        token_endpoint: `${base()}/token`,
        registration_endpoint: `${base()}/register`,
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none']
      });
    });
    app.post('/register', (req, res) => {
      res.status(201).json({
        client_id: 'dcr-client-1',
        client_id_issued_at: Math.floor(Date.now() / 1000),
        redirect_uris: req.body.redirect_uris ?? []
      });
    });
    app.get('/authorize', (req, res) => {
      const code = `code-${counter++}`;
      challenges.set(code, { challenge: String(req.query.code_challenge) });
      res.json({ code, state: req.query.state });
    });
    app.post('/token', (req, res) => {
      const grant = req.body.grant_type;
      if (grant === 'authorization_code') {
        const pending = challenges.get(String(req.body.code));
        if (!pending) return void res.status(400).json({ error: 'invalid_grant' });
        challenges.delete(String(req.body.code));
        res.json({ access_token: 'access-1', token_type: 'Bearer', expires_in: 3600, refresh_token: 'refresh-1' });
        return;
      }
      if (grant === 'refresh_token') {
        // A malicious or compromised upstream authorization server's own
        // error text -- the whole attack surface this describe block covers.
        res.status(400).json({ error: 'invalid_grant', error_description: MALICIOUS });
        return;
      }
      res.status(400).json({ error: 'unsupported_grant_type' });
    });

    await new Promise<void>(resolve => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    return { url: base(), close: () => new Promise<void>(resolve => server.close(() => resolve())) };
  }

  it('escapes ESC/BEL/CR/bidi bytes from a malicious upstream instead of writing them raw to the operator terminal', async () => {
    const upstream = await startMaliciousUpstream();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-consent-admin-cli-'));
    try {
      const configPath = path.join(dir, 'mcp.json');
      fs.writeFileSync(
        configPath,
        JSON.stringify({ mcpServers: { saas: { type: 'http', url: `${upstream.url}/mcp`, oauth: { mode: 'dcr', grant: 'authorization_code' } } } })
      );
      const dataPath = path.join(dir, 'data');
      const externalUrl = 'http://localhost:4102/';

      const hub = await createHub({ externalUrl, configPath, dataPath, password: PASSWORD, idleTimeoutMinutes: 0 });
      try {
        await hub.supervisor.waitUntilSettled();
        const auth = hub.upstreamAuth.get('saas')!;
        const { authorizationUrl } = await startUpstreamLogin(hub.store, auth);
        const state = new URL(authorizationUrl).searchParams.get('state')!;
        const { code } = (await (await fetch(authorizationUrl)).json()) as { code: string };
        const cookie = `mcp_hub_session=${encodeURIComponent(createSessionCookie(hub.store.cookieSecret))}`;
        await request(hub.app).get('/upstream/callback').set('Cookie', cookie).query({ code, state }).expect(200);
      } finally {
        hub.stopMaintenance();
        hub.watcher.stop();
        await hub.supervisor.stop();
      }

      // A separate process now, exactly the documented `docker exec`
      // invocation: reading the same DATA_PATH/CONFIG_PATH the hub just wrote.
      const result = await runAdminCli(['upstream', 'refresh', 'saas'], { CONFIG_PATH: configPath, DATA_PATH: dataPath, EXTERNAL_URL: externalUrl });
      expect(result.code).toBe(2);
      const stderrText = result.stderr.toString('utf8');
      expect(stderrText).toContain('FAKE ERROR');
      // The raw control/format bytes must never reach the terminal...
      expect(result.stderr.includes(0x1b)).toBe(false); // ESC
      expect(result.stderr.includes(0x07)).toBe(false); // BEL
      expect(result.stderr.includes(0x0d)).toBe(false); // CR
      expect(stderrText).not.toContain('‮'); // bidi override
      // ...and show up as logSafe's escaped form instead.
      expect(stderrText).toContain('\\x1b');
      expect(stderrText).toContain('\\x07');
      expect(stderrText).toContain('\\x0d');
      expect(stderrText).toContain('\\u{202e}');
    } finally {
      await upstream.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
