import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHub } from '../src/index.js';

/**
 * RFC 7592 registration management, none of which the SDK provides: its
 * registration router accepts POST and answers 405 to everything else.
 */

const EVERYTHING = path.resolve('node_modules/@modelcontextprotocol/server-everything/dist/index.js');
const PASSWORD = 'test-password';
const REDIRECT = 'https://app.example.com/cb';

let tmpDir: string;
let hub: Awaited<ReturnType<typeof createHub>>;

interface Registration {
  client_id: string;
  registration_access_token: string;
  registration_client_uri: string;
  client_secret?: string;
}

async function registerClient(overrides: Record<string, unknown> = {}): Promise<Registration> {
  const response = await request(hub.app)
    .post('/register')
    .send({ redirect_uris: [REDIRECT], client_name: 'vitest', token_endpoint_auth_method: 'none', ...overrides })
    .expect(201);
  return response.body as Registration;
}

/** The path of registration_client_uri, so the test drives the URL the hub
 *  itself advertised rather than one it assumed. */
const managementPath = (registration: Registration): string => new URL(registration.registration_client_uri).pathname;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-registration-'));
  const configPath = path.join(tmpDir, 'mcp.json');
  fs.writeFileSync(configPath, JSON.stringify({ mcpServers: { everything: { command: process.execPath, args: [EVERYTHING] } } }));
  hub = await createHub({
    externalUrl: 'http://localhost:3000',
    configPath,
    dataPath: path.join(tmpDir, 'data'),
    password: PASSWORD,
    idleTimeoutMinutes: 0
  });
  await hub.supervisor.waitUntilSettled();
}, 30_000);

afterAll(async () => {
  hub?.stopMaintenance();
  hub?.watcher.stop();
  await hub?.supervisor.stop();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('the registration response', () => {
  it('hands out a management credential and the URL it works at', async () => {
    const registration = await registerClient();
    expect(registration.registration_access_token).toBeTruthy();
    expect(registration.registration_client_uri).toBe(`http://localhost:3000/register/${registration.client_id}`);
  });

  it('keeps only a hash of that credential', async () => {
    const registration = await registerClient();
    const state = fs.readFileSync(path.join(tmpDir, 'data', 'state.json'), 'utf8');
    // The one moment the client could learn it was the response above.
    expect(state).not.toContain(registration.registration_access_token);
    expect(state).toContain(registration.client_id);
  });
});

describe('reading a registration', () => {
  it('returns the metadata to the holder of the credential', async () => {
    const registration = await registerClient({ client_name: 'readable' });
    const response = await request(hub.app)
      .get(managementPath(registration))
      .set('Authorization', `Bearer ${registration.registration_access_token}`)
      .expect(200);
    expect(response.body.client_id).toBe(registration.client_id);
    expect(response.body.client_name).toBe('readable');
    expect(response.body.redirect_uris).toEqual([REDIRECT]);
    expect(response.body.registration_client_uri).toBe(registration.registration_client_uri);
  });

  it('answers the same way for a wrong credential and a client that does not exist', async () => {
    const registration = await registerClient();
    const wrongToken = await request(hub.app)
      .get(managementPath(registration))
      .set('Authorization', 'Bearer not-the-token')
      .expect(401);
    const noSuchClient = await request(hub.app).get('/register/does-not-exist').set('Authorization', 'Bearer not-the-token').expect(401);
    // Otherwise this would be a way to find out which client_ids exist.
    expect(wrongToken.body).toEqual(noSuchClient.body);
    await request(hub.app).get(managementPath(registration)).expect(401);
  });

  it('does not accept another client\'s credential', async () => {
    const [mine, theirs] = [await registerClient(), await registerClient()];
    await request(hub.app)
      .get(managementPath(mine))
      .set('Authorization', `Bearer ${theirs.registration_access_token}`)
      .expect(401);
  });
});

describe('updating a registration', () => {
  const put = (registration: Registration, body: Record<string, unknown>) =>
    request(hub.app)
      .put(managementPath(registration))
      .set('Authorization', `Bearer ${registration.registration_access_token}`)
      .send(body);

  it('changes metadata and leaves an existing approval alone', async () => {
    const registration = await registerClient({ client_name: 'before' });
    hub.store.saveApproval(registration.client_id, REDIRECT, 'before');

    const response = await put(registration, {
      client_id: registration.client_id,
      redirect_uris: [REDIRECT],
      client_name: 'after'
    }).expect(200);

    expect(response.body.client_name).toBe('after');
    // The destination did not move, so consent still means what it meant.
    expect(hub.store.getApproval(registration.client_id)).toBeDefined();
  });

  it('withdraws the approval when the redirect URIs move', async () => {
    const registration = await registerClient();
    hub.store.saveApproval(registration.client_id, REDIRECT, 'vitest');

    await put(registration, {
      client_id: registration.client_id,
      redirect_uris: ['https://app.example.com/somewhere-else']
    }).expect(200);

    // Consent was given for a destination; the client does not get to move it
    // afterwards and keep the approval.
    expect(hub.store.getApproval(registration.client_id)).toBeUndefined();
    expect(hub.store.getClient(registration.client_id)?.redirect_uris).toEqual(['https://app.example.com/somewhere-else']);
  });

  it('treats a reordered list as unchanged', async () => {
    const registration = await registerClient({ redirect_uris: [REDIRECT, 'https://app.example.com/second'] });
    hub.store.saveApproval(registration.client_id, REDIRECT, 'vitest');

    await put(registration, {
      client_id: registration.client_id,
      redirect_uris: ['https://app.example.com/second', REDIRECT]
    }).expect(200);

    expect(hub.store.getApproval(registration.client_id)).toBeDefined();
  });

  it('refuses a body that names a different client', async () => {
    const registration = await registerClient();
    const response = await put(registration, { client_id: 'someone-else', redirect_uris: [REDIRECT] }).expect(400);
    expect(response.body.error).toBe('invalid_client_metadata');
  });

  it('holds the new redirect URIs to the same rule as registration', async () => {
    const registration = await registerClient();
    await put(registration, { client_id: registration.client_id, redirect_uris: ['http://app.example.com/cb'] }).expect(400);
    // The stored registration is untouched by a rejected update.
    expect(hub.store.getClient(registration.client_id)?.redirect_uris).toEqual([REDIRECT]);
  });

  it('will not let a confidential client change its own secret', async () => {
    const registration = await registerClient({ token_endpoint_auth_method: 'client_secret_post' });
    expect(registration.client_secret).toBeTruthy();
    const response = await put(registration, {
      client_id: registration.client_id,
      redirect_uris: [REDIRECT],
      client_secret: 'a-secret-i-picked'
    }).expect(400);
    expect(response.body.error).toBe('invalid_client_metadata');
    expect(hub.store.getClient(registration.client_id)?.client_secret).toBe(registration.client_secret);
  });

  it('tolerates a public client echoing back the secret it was handed', async () => {
    // A public client is given a throwaway secret in its registration response
    // that is never stored; sending it back must not read as an attempt to
    // change anything.
    const registration = await registerClient();
    expect(registration.client_secret).toBeTruthy();
    await put(registration, {
      client_id: registration.client_id,
      redirect_uris: [REDIRECT],
      client_secret: registration.client_secret
    }).expect(200);
    expect(hub.store.getClient(registration.client_id)?.client_secret).toBeUndefined();
  });

  it('shortens a client name the same way registration does', async () => {
    const registration = await registerClient();
    const response = await put(registration, {
      client_id: registration.client_id,
      redirect_uris: [REDIRECT],
      client_name: `A\n\nB${'x'.repeat(300)}`
    }).expect(200);
    expect(response.body.client_name).not.toContain('\n');
    expect(response.body.client_name.length).toBeLessThanOrEqual(65);
  });
});

describe('deleting a registration', () => {
  it('removes the client, its approval and its tokens', async () => {
    const registration = await registerClient();
    hub.store.saveApproval(registration.client_id, REDIRECT, 'vitest');
    hub.store.saveRefreshToken('rt-self-delete', {
      clientId: registration.client_id,
      scopes: [],
      expiresAt: Math.floor(Date.now() / 1000) + 600
    });

    await request(hub.app)
      .delete(managementPath(registration))
      .set('Authorization', `Bearer ${registration.registration_access_token}`)
      .expect(204);

    expect(hub.store.getClient(registration.client_id)).toBeUndefined();
    expect(hub.store.getApproval(registration.client_id)).toBeUndefined();
    expect(hub.store.getRefreshToken('rt-self-delete')).toBeUndefined();
  });

  it('leaves the credential useless afterwards', async () => {
    const registration = await registerClient();
    const auth = `Bearer ${registration.registration_access_token}`;
    await request(hub.app).delete(managementPath(registration)).set('Authorization', auth).expect(204);
    await request(hub.app).delete(managementPath(registration)).set('Authorization', auth).expect(401);
    await request(hub.app).get(managementPath(registration)).set('Authorization', auth).expect(401);
  });

  it('stops the client_id from being usable at /authorize', async () => {
    const registration = await registerClient();
    await request(hub.app)
      .delete(managementPath(registration))
      .set('Authorization', `Bearer ${registration.registration_access_token}`)
      .expect(204);

    const response = await request(hub.app)
      .get('/authorize')
      .query({
        client_id: registration.client_id,
        redirect_uri: REDIRECT,
        response_type: 'code',
        code_challenge: 'x'.repeat(43),
        code_challenge_method: 'S256'
      })
      .expect(400);
    expect(response.body.error).toBe('invalid_client');
  });

  it('refuses a delete with no credential', async () => {
    const registration = await registerClient();
    await request(hub.app).delete(managementPath(registration)).expect(401);
    expect(hub.store.getClient(registration.client_id)).toBeDefined();
  });
});

describe('cross-origin preflight', () => {
  it('lets a browser-based client reach the management endpoints', async () => {
    const response = await request(hub.app).options('/register/anything').expect(204);
    expect(response.headers['access-control-allow-origin']).toBe('*');
    expect(response.headers['access-control-allow-methods']).toContain('DELETE');
    expect(response.headers['access-control-allow-headers']).toContain('Authorization');
  });
});

describe('with dynamic registration turned off', () => {
  let cimdOnly: Awaited<ReturnType<typeof createHub>>;
  let dir: string;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-registration-off-'));
    const configPath = path.join(dir, 'mcp.json');
    fs.writeFileSync(configPath, JSON.stringify({ mcpServers: { everything: { command: process.execPath, args: [EVERYTHING] } } }));
    cimdOnly = await createHub({
      externalUrl: 'http://localhost:3000',
      configPath,
      dataPath: path.join(dir, 'data'),
      password: PASSWORD,
      idleTimeoutMinutes: 0,
      clientRegistration: ['cimd']
    });
    await cimdOnly.supervisor.waitUntilSettled();
  }, 30_000);

  afterAll(async () => {
    cimdOnly?.stopMaintenance();
    cimdOnly?.watcher.stop();
    await cimdOnly?.supervisor.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('does not serve the management endpoints either', async () => {
    // There is nothing to manage, so these must not be a separate surface.
    await request(cimdOnly.app).get('/register/whatever').set('Authorization', 'Bearer x').expect(404);
    await request(cimdOnly.app).delete('/register/whatever').set('Authorization', 'Bearer x').expect(404);
  });
});

describe('at the registration ceiling', () => {
  let small: Awaited<ReturnType<typeof createHub>>;
  let dir: string;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-registration-cap-'));
    const configPath = path.join(dir, 'mcp.json');
    fs.writeFileSync(configPath, JSON.stringify({ mcpServers: { everything: { command: process.execPath, args: [EVERYTHING] } } }));
    small = await createHub({
      externalUrl: 'http://localhost:3000',
      configPath,
      dataPath: path.join(dir, 'data'),
      password: PASSWORD,
      idleTimeoutMinutes: 0,
      dcrMaxClients: 2
    });
    await small.supervisor.waitUntilSettled();
  }, 30_000);

  afterAll(async () => {
    small?.stopMaintenance();
    small?.watcher.stop();
    await small?.supervisor.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a newcomer rather than evicting a confirmed client', async () => {
    const register = () =>
      request(small.app).post('/register').send({ redirect_uris: [REDIRECT], client_name: 'vitest', token_endpoint_auth_method: 'none' });

    for (let i = 0; i < 2; i++) {
      const created = await register().expect(201);
      small.store.saveApproval(created.body.client_id, REDIRECT, 'vitest');
    }
    const response = await register().expect(400);
    expect(response.body.error).toBe('too_many_requests');
    expect(Object.keys(small.store.listClients()).length).toBe(2);
  });
});
