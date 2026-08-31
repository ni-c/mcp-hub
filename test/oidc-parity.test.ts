import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CimdResolver } from '../src/auth/cimd.js';
import { mountOidcProvider } from '../src/auth/oidc/mount.js';
import { buildOidcProvider } from '../src/auth/oidc/provider.js';
import { AuthStore } from '../src/auth/store.js';
import { createHub } from '../src/index.js';

const EXTERNAL_URL = 'http://localhost:3000/';

/**
 * The discovery documents the hand-written authorization server published,
 * captured from it before it was removed.
 *
 * Frozen as data rather than compared against a live copy, because the live
 * copy is gone: the point of this file is that a client which learned these
 * values from the old server still finds them, and nobody can quietly drop one
 * while refactoring the new one. Every difference below has to be a decision
 * somebody wrote down.
 */
const LEGACY_AS = {
  issuer: 'http://localhost:3000/',
  authorization_endpoint: 'http://localhost:3000/authorize',
  response_types_supported: ['code'],
  code_challenge_methods_supported: ['S256'],
  token_endpoint: 'http://localhost:3000/token',
  token_endpoint_auth_methods_supported: ['client_secret_post', 'none', 'private_key_jwt'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  revocation_endpoint: 'http://localhost:3000/revoke',
  revocation_endpoint_auth_methods_supported: ['client_secret_post'],
  registration_endpoint: 'http://localhost:3000/register',
  client_id_metadata_document_supported: true,
  token_endpoint_auth_signing_alg_values_supported: [
    'RS256',
    'RS384',
    'RS512',
    'PS256',
    'PS384',
    'PS512',
    'ES256',
    'ES384',
    'ES512',
    'EdDSA'
  ]
} as const;

const LEGACY_PRM_ROOT = {
  resource: 'http://localhost:3000/',
  authorization_servers: ['http://localhost:3000/'],
  resource_name: 'mcp-hub'
} as const;

const LEGACY_PRM_PATH = {
  resource: 'http://localhost:3000/everything/mcp',
  authorization_servers: ['http://localhost:3000/'],
  bearer_methods_supported: ['header'],
  resource_name: 'mcp-hub'
} as const;

/**
 * Differences that are deliberate. Each needs a reason, and a field that
 * changes for any OTHER reason still fails — an allowlist that only says "may
 * differ" rots within a quarter.
 */
const INTENTIONAL: Record<string, { value: unknown; because: string }> = {
  revocation_endpoint_auth_methods_supported: {
    value: ['client_secret_post', 'none', 'private_key_jwt'],
    because:
      'The old document understated it: the SDK hardcoded client_secret_post while the hub ' +
      'accepted none and private_key_jwt at /revoke as well — and none is what every public ' +
      'MCP client uses. Same rule as everywhere else here: advertise what is actually served.'
  }
};

let tmpDir: string;
let hub: Awaited<ReturnType<typeof createHub>>;
let current: Record<string, unknown>;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-parity-'));
  const configPath = path.join(tmpDir, 'mcp.json');
  fs.writeFileSync(configPath, JSON.stringify({ mcpServers: { everything: { command: 'true' } } }));

  hub = await createHub({
    externalUrl: 'http://localhost:3000',
    configPath,
    dataPath: path.join(tmpDir, 'data'),
    password: 'test-password',
    idleTimeoutMinutes: 0
  });
  current = (await request(hub.app).get('/.well-known/oauth-authorization-server')).body;
}, 30_000);

afterAll(async () => {
  hub?.watcher.stop();
  await hub?.supervisor.stop();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('everything the previous authorization server advertised is still advertised', () => {
  it('offers every field the old document had', () => {
    expect(Object.keys(LEGACY_AS).filter(key => !(key in current))).toEqual([]);
  });

  it('gives the same value for every field, bar the ones with a reason on file', () => {
    const changed = Object.entries(LEGACY_AS)
      .filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(current[key]))
      .filter(([key]) => JSON.stringify(INTENTIONAL[key]?.value) !== JSON.stringify(current[key]))
      .map(([key, value]) => `${key}: ${JSON.stringify(value)} -> ${JSON.stringify(current[key])}`);
    expect(changed).toEqual([]);
  });

  it('has no stale waivers', () => {
    for (const [field, { because }] of Object.entries(INTENTIONAL)) {
      expect(because.length, field).toBeGreaterThan(40);
      // A waiver for a field that no longer differs is one nobody reread.
      expect(JSON.stringify(LEGACY_AS[field as keyof typeof LEGACY_AS]), field).not.toBe(JSON.stringify(current[field]));
    }
  });

  it('keeps the trailing slash on the issuer, which claude.ai compares byte for byte', () => {
    // `.origin` would drop it. The same string has to appear in `iss`, `aud`,
    // this document and the PRM `authorization_servers` entry.
    expect(current.issuer).toBe(EXTERNAL_URL);
  });

  it('serves both protected-resource documents unchanged', async () => {
    // The resource server's own metadata, which no authorization server owns —
    // and which therefore had to be moved out by hand rather than inherited.
    const root = await request(hub.app).get('/.well-known/oauth-protected-resource').expect(200);
    expect(root.body).toEqual(LEGACY_PRM_ROOT);
    const scoped = await request(hub.app).get('/.well-known/oauth-protected-resource/everything/mcp').expect(200);
    expect(scoped.body).toEqual(LEGACY_PRM_PATH);
    expect(root.headers['cache-control']).toBe('no-store');
  });

  it('advertises no endpoint it does not serve', async () => {
    // PAR and RP-initiated logout are on by default in oidc-provider and would
    // be published while unmounted — a client that believed the document would
    // get a 404 from the hub's catch-all.
    const store = new AuthStore(path.join(tmpDir, 'endpoints'));
    const app = express();
    const provider = buildOidcProvider(store, { externalUrl: EXTERNAL_URL, cimd: new CimdResolver() });
    mountOidcProvider(app, provider, store, { externalUrl: EXTERNAL_URL });
    app.use((_req, res) => {
      res.status(404).json({ reached: 'express' });
    });

    const document = (await request(app).get('/.well-known/oauth-authorization-server')).body as Record<string, string>;
    for (const [field, value] of Object.entries(document)) {
      if (!field.endsWith('_endpoint') && field !== 'jwks_uri') continue;
      const res = await request(app).get(new URL(value).pathname);
      expect(res.body.reached, `${field} -> ${value}`).not.toBe('express');
    }
  });
});
