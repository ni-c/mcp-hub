import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import express from 'express';
import type { Express } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requireBearerAuth } from '@modelcontextprotocol/express';

/**
 * A rejected bearer on the MCP data-plane routes used to cost as much as a
 * real one: `fromApiToken` ran a genuine Ed25519 `jwtVerify` for any
 * 3-segment, EdDSA-shaped garbage -- a decode-only rejection is roughly 20x
 * cheaper. `OidcTokenVerifier` now decodes the bearer first -- the header
 * alg must be EdDSA, sub must be the API-token subject, and jti must name a
 * live record -- before ever running the real signature check, so this file
 * spies on `jose.jwtVerify` to prove that check is skipped for garbage while
 * every legitimate flow (opaque OAuth tokens, valid API tokens, revocation)
 * is unchanged. The pre-check can only ever reject early, never accept
 * early. There is deliberately no per-address pre-auth limiter on these
 * routes: behind a proxy missing from TRUSTED_PROXIES every client shares
 * one address, and a failure limiter would lock all of them out together
 * with the attacker. Revocation is still checked after verification, so a
 * token revoked while its signature is being checked is refused.
 */
const { jwtVerifySpy } = vi.hoisted(() => ({ jwtVerifySpy: vi.fn() }));
vi.mock('jose', async importOriginal => {
  const actual = await importOriginal<typeof import('jose')>();
  return {
    ...actual,
    jwtVerify: (...args: Parameters<typeof actual.jwtVerify>) => {
      jwtVerifySpy();
      return actual.jwtVerify(...args);
    }
  };
});

// Imported AFTER vi.mock so the module under test picks up the mocked 'jose'.
const { OidcTokenVerifier } = await import('../src/auth/oidc/verifier.js');
const { mintApiToken, API_TOKEN_SUBJECT } = await import('../src/auth/api-tokens.js');
const { AuthStore } = await import('../src/auth/store.js');
const { buildOidcProvider } = await import('../src/auth/oidc/provider.js');
const { mountOidcProvider } = await import('../src/auth/oidc/mount.js');
const { createOidcInteractionRoutes } = await import('../src/auth/oidc/interactions.js');
const { SignJWT } = await import('jose');
const { authorizeInBrowser, registerPublicClient } = await import('./auth-flow.js');

const EXTERNAL_URL = 'http://127.0.0.1:9977/';
const REDIRECT_URI = 'https://claude.ai/api/mcp/auth_callback';
const RESOURCE = new URL('/hub', EXTERNAL_URL);
const PASSWORD = 'test-password';

let tmpDir: string;
let store: InstanceType<typeof AuthStore>;
let guarded: Express;

/** A protected route using the SDK middleware exactly as src/index.ts wires
 *  '/hub' and '/:name'/'/:name/mcp', so the pre-check is exercised through the
 *  real bearer path, not just by calling the verifier class directly. */
function protectedApp(authStore: InstanceType<typeof AuthStore>, resource: URL): Express {
  const app = express();
  const verifier = new OidcTokenVerifier(authStore, {
    externalUrl: EXTERNAL_URL,
    requireResource: true,
    resolveResource: url => (url.href === resource.href ? resource : undefined)
  });
  app.get('/hub', requireBearerAuth({ verifier }), (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-bearer-precheck-'));
  store = new AuthStore(tmpDir);
  guarded = protectedApp(store, RESOURCE);
  jwtVerifySpy.mockClear();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function jwtShaped(overrides: { alg?: string; sub?: string; jti?: string; signer?: crypto.KeyObject }): Promise<string> {
  const { privateKey: fallbackSigner } = crypto.generateKeyPairSync('ed25519');
  return new SignJWT({})
    .setProtectedHeader({ alg: overrides.alg ?? 'EdDSA' })
    .setIssuer(EXTERNAL_URL)
    .setAudience(RESOURCE.href)
    .setSubject(overrides.sub ?? API_TOKEN_SUBJECT)
    .setIssuedAt()
    .setExpirationTime('30d')
    .setJti(overrides.jti ?? crypto.randomBytes(8).toString('base64url'))
    .sign(overrides.signer ?? fallbackSigner);
}

describe('JWT-shaped garbage bearers are refused by decoding alone, before any signature check', () => {
  it('rejects a JWT-shaped bearer with an unknown jti WITHOUT running jwtVerify', async () => {
    const garbage = await jwtShaped({});
    await request(guarded).get('/hub').set('Authorization', `Bearer ${garbage}`).expect(401);
    expect(jwtVerifySpy).not.toHaveBeenCalled();
  });

  it('rejects a JWT-shaped bearer with the wrong algorithm WITHOUT running jwtVerify', async () => {
    // HS256 needs no asymmetric key at all -- the cheapest garbage an
    // attacker can mint -- and the hub never signs with it, so the header
    // alone is enough to refuse it.
    const wrongAlg = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(EXTERNAL_URL)
      .setSubject(API_TOKEN_SUBJECT)
      .setJti(crypto.randomBytes(8).toString('base64url'))
      .sign(Buffer.from('thirty-two-byte-hmac-secret-value'));
    await request(guarded).get('/hub').set('Authorization', `Bearer ${wrongAlg}`).expect(401);
    expect(jwtVerifySpy).not.toHaveBeenCalled();
  });

  it('rejects a non-JWT-shaped bearer WITHOUT running jwtVerify', async () => {
    // No dots at all: decodeProtectedHeader/decodeJwt throw, the pre-check
    // returns false from the catch branch, exactly as a malformed value
    // was always refused before -- just without paying for a doomed crypto
    // call first.
    await request(guarded).get('/hub').set('Authorization', 'Bearer not-a-token-at-all').expect(401);
    expect(jwtVerifySpy).not.toHaveBeenCalled();
  });

  it('rejects an empty bearer WITHOUT running jwtVerify', async () => {
    await request(guarded).get('/hub').set('Authorization', 'Bearer ').expect(401);
    expect(jwtVerifySpy).not.toHaveBeenCalled();
  });

  it('still accepts a genuine, admin-minted API token, and DOES run jwtVerify for it', async () => {
    const minted = await mintApiToken(store, EXTERNAL_URL, RESOURCE, 30, 'vitest');
    await request(guarded).get('/hub').set('Authorization', `Bearer ${minted.token}`).expect(200);
    // The pre-check can only reject early; a token that could conceivably be
    // real still has to pass the real signature check to be trusted.
    expect(jwtVerifySpy).toHaveBeenCalledTimes(1);
  });

  it('refuses a token revoked while its signature is being verified', async () => {
    // The pre-check saw a live record; the revocation lands during jwtVerify.
    // The check after verification is what still refuses the request.
    const minted = await mintApiToken(store, EXTERNAL_URL, RESOURCE, 30, 'vitest');
    jwtVerifySpy.mockImplementationOnce(() => {
      expect(store.revokeApiToken(minted.id)).toBe(true);
    });
    await request(guarded).get('/hub').set('Authorization', `Bearer ${minted.token}`).expect(401);
    expect(jwtVerifySpy).toHaveBeenCalledTimes(1);
  });

  it('still refuses a revoked API token immediately, without needing jwtVerify to do it', async () => {
    const minted = await mintApiToken(store, EXTERNAL_URL, RESOURCE, 30, 'vitest');
    expect(store.revokeApiToken(minted.id)).toBe(true);
    await request(guarded).get('/hub').set('Authorization', `Bearer ${minted.token}`).expect(401);
    // Revocation immediacy is unchanged (getApiToken re-reads the state file
    // on every call, before and after this fix) -- but it is now also
    // rejected at the cheap pre-check, one call earlier than before.
    expect(jwtVerifySpy).not.toHaveBeenCalled();
  });

  it('does NOT let a forged token through just because it names a live jti: still runs jwtVerify and still refuses it', async () => {
    // The attacker cannot mint their own valid token, but jti values are not
    // secret by themselves (the admin CLI lists them). A token that copies a
    // real jti but is signed with a different key must still fail -- the
    // pre-check must never become a substitute for the real signature check.
    const minted = await mintApiToken(store, EXTERNAL_URL, RESOURCE, 30, 'vitest');
    const { privateKey: attackerKey } = crypto.generateKeyPairSync('ed25519');
    const forged = await jwtShaped({ jti: minted.id, signer: attackerKey });
    await request(guarded).get('/hub').set('Authorization', `Bearer ${forged}`).expect(401);
    expect(jwtVerifySpy).toHaveBeenCalledTimes(1);
  });

  it('keeps accepting a valid opaque OAuth token end to end, without the pre-check touching it', async () => {
    // Opaque tokens are tried first in verifyAccessToken and, on a hit, never
    // fall through to fromApiToken at all -- confirming the pre-check changes
    // nothing about the other token shape or the ordinary connector flow.
    const provider = buildOidcProvider(store, { externalUrl: EXTERNAL_URL, defaultResource: RESOURCE, interactionPath: '/interaction' });
    const app = express();
    app.use(createOidcInteractionRoutes({ provider, store, externalUrl: EXTERNAL_URL, password: PASSWORD }));
    mountOidcProvider(app, provider, store, { externalUrl: EXTERNAL_URL });

    const clientId = await registerPublicClient(app, REDIRECT_URI);
    const { code, agent, verifier } = await authorizeInBrowser(app, clientId, {
      password: PASSWORD,
      redirectUri: REDIRECT_URI,
      resource: RESOURCE.href
    });
    const tokenRes = await agent
      .post('/token')
      .type('form')
      .send({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, client_id: clientId, code_verifier: verifier })
      .expect(200);

    jwtVerifySpy.mockClear();
    await request(guarded).get('/hub').set('Authorization', `Bearer ${tokenRes.body.access_token}`).expect(200);
    expect(jwtVerifySpy).not.toHaveBeenCalled();
  });
});
