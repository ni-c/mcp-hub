import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import express from 'express';
import type { Express } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildOidcProvider } from '../src/auth/oidc/provider.js';
import { defaultRateLimits, mountOidcProvider } from '../src/auth/oidc/mount.js';
import { AuthStore } from '../src/auth/store.js';

/**
 * '/revoke' used to run through the same client-authentication chain as
 * '/token' -- including a real private_key_jwt signature verification for a
 * client that self-registered through the hub's own open DCR -- with no
 * rate limit in front of it. This file exercises the fix, `defaultRateLimits()`
 * now carrying a '/revoke' entry, through the real mount rather than the
 * isolated middleware: the gap was not in `earlyRateLimit` itself (which
 * already had unit coverage in test/hardening.test.ts) but in
 * `defaultRateLimits()` never wiring it in front of this one path.
 */

const EXTERNAL_URL = 'http://127.0.0.1:9977/';
const REDIRECT_URI = 'https://claude.ai/api/mcp/auth_callback';

let tmpDir: string;
let store: AuthStore;
let app: Express;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-revoke-'));
  store = new AuthStore(tmpDir);
  app = express();

  const provider = buildOidcProvider(store, {
    externalUrl: EXTERNAL_URL,
    defaultResource: new URL('/hub', EXTERNAL_URL)
  });

  mountOidcProvider(app, provider, store, { externalUrl: EXTERNAL_URL });

  app.use((_req, res) => {
    res.status(404).json({ reached: 'express' });
  });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** A public client, registered through the hub's own open DCR -- reachable
 *  by anyone, with no operator approval or password required. */
async function registerClient(): Promise<string> {
  const res = await request(app)
    .post('/register')
    .send({
      client_name: 'vitest',
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code']
    })
    .expect(201);
  return res.body.client_id as string;
}

/** Fires `count` sequential POST requests at `path` and returns their status
 *  codes in order. Sequential, not concurrent, because the limiter counts
 *  requests and concurrency would only add scheduling noise to that count. */
async function flood(pathname: string, body: Record<string, string>, count: number): Promise<number[]> {
  const statuses: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const res = await request(app).post(pathname).type('form').send(body);
    statuses.push(res.status);
  }
  return statuses;
}

describe('defaultRateLimits budgets /revoke', () => {
  it('carries the same budget object shape /token uses', () => {
    // `defaultRateLimits()` is rebuilt per call (mountOidcProvider only calls
    // it once and keeps the result, so a fresh call here does not share state
    // with `app`'s own limiter) -- this just pins that the entry exists and
    // that the design intent (share /token's budget) has not silently drifted
    // to some other shape.
    const limits = defaultRateLimits();
    expect(limits['/revoke']).toBeDefined();
    expect(limits['/revoke']).toHaveLength(1);
    expect(limits['/token']).toHaveLength(1);
  });

  it('answers the 51st /revoke request from one address with 429, matching /token', async () => {
    const clientId = await registerClient();
    const body = { token: 'irrelevant-opaque-value', client_id: clientId };

    // mount.ts:84's '/token' budget is earlyRateLimit(15min, 50, 500): 50
    // requests per address pass, the 51st is throttled. '/revoke' has to
    // behave identically now.
    const statuses = await flood('/revoke', body, 51);
    expect(statuses.slice(0, 50)).not.toContain(429);
    expect(statuses[50]).toBe(429);
  });

  it('does not throttle a legitimate revocation before the budget is spent', async () => {
    const clientId = await registerClient();
    // A handful of ordinary revoke calls (well under the 50-per-window budget)
    // must reach the real handler, not the limiter -- confirmed by every
    // response coming back as oidc-provider's own answer (200, per RFC 7009,
    // which revokes-or-no-ops without distinguishing an unknown token) rather
    // than the limiter's 429 json shape.
    for (let i = 0; i < 5; i += 1) {
      const res = await request(app).post('/revoke').type('form').send({ token: `t${i}`, client_id: clientId });
      expect(res.status).toBe(200);
    }
  });

  it('keeps /revoke and /token on independent budgets: exhausting one leaves the other open', async () => {
    const clientId = await registerClient();

    // Spend the entire /revoke budget for this address.
    const revokeStatuses = await flood('/revoke', { token: 'x', client_id: clientId }, 51);
    expect(revokeStatuses[50]).toBe(429);

    // /token must be unaffected: it is a different path, hence a different
    // `earlyRateLimit()` closure with its own counters (mount.ts builds the
    // `before` map once, calling earlyRateLimit separately per key).
    const tokenRes = await request(app)
      .post('/token')
      .type('form')
      .send({ grant_type: 'authorization_code', code: 'nope', redirect_uri: REDIRECT_URI, client_id: clientId });
    expect(tokenRes.status).not.toBe(429);
  });

  it('keeps /token and /revoke on independent budgets the other way round', async () => {
    const clientId = await registerClient();

    // Spend the entire /token budget for this address.
    const tokenStatuses = await flood(
      '/token',
      { grant_type: 'authorization_code', code: 'nope', redirect_uri: REDIRECT_URI, client_id: clientId },
      51
    );
    expect(tokenStatuses[50]).toBe(429);

    // /revoke must be unaffected by /token's exhausted budget.
    const revokeRes = await request(app).post('/revoke').type('form').send({ token: 'x', client_id: clientId });
    expect(revokeRes.status).not.toBe(429);
  });
});
