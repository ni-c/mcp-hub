import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ManagedServer } from '../src/supervisor.js';
import { AuthStore, MAX_UNAPPROVED_CLIENTS } from '../src/auth/store.js';
import { LoginRateLimiter } from '../src/auth/routes.js';
import { ClientRequestGate } from '../src/limits.js';
import type { NextFunction, Request, Response } from 'express';

const tmpDirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-hardening-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe('ManagedServer restart reporting', () => {
  it('ignores a second exit report for the same run', async () => {
    const server = new ManagedServer('double', { kind: 'stdio', command: '/bin/false', args: [], env: {}, hub: true });

    server['onExit']('first report');
    expect(server.state).toBe('down');
    expect(server.lastError).toBe('first report');
    const backoffAfterFirst = server['backoffMs'];

    // A failed start reports twice (transport.onclose plus start()'s catch);
    // the second must not schedule another child or advance the backoff.
    server['onExit']('second report');
    expect(server.lastError).toBe('first report');
    expect(server['backoffMs']).toBe(backoffAfterFirst);

    await server.stop();
  });

  it('survives the client disappearing while a ping is in flight', async () => {
    const server = new ManagedServer('racy', { kind: 'stdio', command: '/bin/false', args: [], env: {}, hub: true });
    server.state = 'up';
    // The realistic sequence: the ping fails *because* the connection went
    // away, so transport.onclose -> onExit has already cleared the client by
    // the time the catch block runs. Reading this.client.close() there throws
    // synchronously, so the attached .catch() never applies and the whole
    // checkAlive() promise rejects unobserved.
    server.client = {
      ping: async () => {
        server['onExit']('connection closed');
        throw new Error('Connection closed');
      },
      close: async () => {}
    } as unknown as NonNullable<ManagedServer['client']>;

    await expect(server['checkAlive']()).resolves.toBeUndefined();
    expect(server.state).toBe('down'); // onExit still scheduled the restart

    await server.stop();
  });

  it('does not reject when the client goes away during stop()', async () => {
    const server = new ManagedServer('racy-stop', { kind: 'stdio', command: '/bin/false', args: [], env: {}, hub: true });
    server.state = 'up';
    server.client = {
      ping: async () => {},
      close: async () => {
        server['onExit']('child process exited');
      }
    } as unknown as NonNullable<ManagedServer['client']>;

    // Supervisor.stop() and applyDiff() await this; a rejection here would
    // escape into the shutdown and config-reload paths.
    await expect(server.stop()).resolves.toBeUndefined();
    expect(server.state).toBe('stopped');
  });
});

describe('LoginRateLimiter', () => {
  it('blocks after the configured number of failures', () => {
    const limiter = new LoginRateLimiter();
    for (let i = 0; i < 10; i++) limiter.recordFailure('10.0.0.1');
    expect(limiter.isBlocked('10.0.0.1')).toBe(true);
    expect(limiter.isBlocked('10.0.0.2')).toBe(false);
    limiter.reset('10.0.0.1');
    expect(limiter.isBlocked('10.0.0.1')).toBe(false);
  });

  it('blocks every address once the global cap is reached', () => {
    const limiter = new LoginRateLimiter();
    // 100 distinct addresses, one failure each: no per-IP counter is anywhere
    // near its limit, which is exactly what rotating X-Forwarded-For looks like.
    for (let i = 0; i < 100; i++) limiter.recordFailure(`10.0.0.${i}`);
    expect(limiter.isBlocked('192.168.0.1')).toBe(true);
  });

  it('drops entries whose window has passed instead of growing forever', () => {
    const limiter = new LoginRateLimiter();
    limiter.recordFailure('10.0.0.1');
    limiter['attempts'].get('10.0.0.1')!.resetAt = Date.now() - 1;

    limiter.recordFailure('10.0.0.2');
    expect(limiter['attempts'].has('10.0.0.1')).toBe(false);
    expect(limiter['attempts'].size).toBe(1);
  });
});

describe('ClientRequestGate', () => {
  it('limits concurrent requests per OAuth client and releases on finish', () => {
    const gate = new ClientRequestGate(10, 1);
    const listeners = new Map<string, () => void>();
    const response = {
      once: (event: string, handler: () => void) => listeners.set(event, handler),
      set: () => response,
      status: () => response,
      json: () => response
    } as unknown as Response;
    const request = { auth: { clientId: 'client-1' } } as Request;
    let passed = 0;
    gate.middleware(request, response, (() => passed++) as NextFunction);
    gate.middleware(request, response, (() => passed++) as NextFunction);
    expect(passed).toBe(1);
    listeners.get('finish')?.();
    gate.middleware(request, response, (() => passed++) as NextFunction);
    expect(passed).toBe(2);
  });
});

describe('AuthStore', () => {
  it('restores its state across restarts', () => {
    const dir = tmpDir();
    const first = new AuthStore(dir);
    first.saveRefreshToken('rt_example', { clientId: 'c1', scopes: [], expiresAt: Math.floor(Date.now() / 1000) + 600 });

    const second = new AuthStore(dir);
    expect(second.cookieSecret).toBe(first.cookieSecret);
    expect(second.getRefreshToken('rt_example')?.clientId).toBe('c1');
  });

  it('remembers client approvals across restarts and accumulates redirect uris', () => {
    const dir = tmpDir();
    const first = new AuthStore(dir);
    first.saveApproval('client-1', 'https://example.test/cb', 'Example');
    first.saveApproval('client-1', 'https://example.test/other');
    first.saveApproval('client-1', 'https://example.test/cb'); // no duplicate

    const second = new AuthStore(dir);
    expect(second.getApproval('client-1')?.redirectUris).toEqual(['https://example.test/cb', 'https://example.test/other']);
    expect(second.getApproval('client-1')?.clientName).toBe('Example');
    expect(second.getApproval('unknown')).toBeUndefined();
  });

  it('treats clients from a state file predating approvals as unapproved', () => {
    const dir = tmpDir();
    fs.writeFileSync(
      path.join(dir, 'state.json'),
      JSON.stringify({
        cookieSecret: 'kept-secret',
        clients: { old: { client_id: 'old', redirect_uris: ['https://old.test/cb'] } },
        refreshTokens: {}
      })
    );

    const store = new AuthStore(dir);

    expect(store.cookieSecret).toBe('kept-secret'); // not mistaken for corrupt
    expect(store.getClient('old')).toBeDefined();
    expect(store.getApproval('old')).toBeUndefined(); // must be confirmed once
    expect(fs.readdirSync(dir).some(f => f.startsWith('state.json.corrupt-'))).toBe(false);
  });

  it('boots with fresh state when state.json is corrupt, keeping the old file', () => {
    const dir = tmpDir();
    const statePath = path.join(dir, 'state.json');
    fs.writeFileSync(statePath, '{"cookieSecret": "truncated');

    const store = new AuthStore(dir);

    expect(store.cookieSecret).toBeTruthy();
    expect(fs.readdirSync(dir).some(f => f.startsWith('state.json.corrupt-'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(statePath, 'utf8')).cookieSecret).toBe(store.cookieSecret);
  });

  it('treats a structurally unusable state file as corrupt', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'state.json'), '42');

    const store = new AuthStore(dir);

    expect(store.cookieSecret).toBeTruthy();
    expect(fs.readdirSync(dir).some(f => f.startsWith('state.json.corrupt-'))).toBe(true);
  });

  it('caps never-approved clients so open registration cannot grow state without bound', () => {
    const dir = tmpDir();
    const store = new AuthStore(dir);
    const total = MAX_UNAPPROVED_CLIENTS + 50;
    for (let i = 0; i < total; i++) {
      store.saveClient({ client_id: `c${i}`, client_id_issued_at: 1000 + i, redirect_uris: ['https://x.test/cb'] });
    }

    const remaining = Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).clients);
    expect(remaining.length).toBe(MAX_UNAPPROVED_CLIENTS);
    // The oldest were evicted; the most recent survive.
    expect(store.getClient('c0')).toBeUndefined();
    expect(store.getClient(`c${total - 1}`)).toBeDefined();
  });

  it('never evicts approved clients even when the cap is exceeded', () => {
    const dir = tmpDir();
    const store = new AuthStore(dir);
    store.saveClient({ client_id: 'approved', client_id_issued_at: 1, redirect_uris: ['https://x.test/cb'] });
    store.saveApproval('approved', 'https://x.test/cb');

    for (let i = 0; i < MAX_UNAPPROVED_CLIENTS + 10; i++) {
      store.saveClient({ client_id: `c${i}`, client_id_issued_at: 1000 + i, redirect_uris: ['https://x.test/cb'] });
    }

    expect(store.getClient('approved')).toBeDefined(); // oldest, but confirmed
  });

  it('revokes approval and every refresh token for a client', () => {
    const dir = tmpDir();
    const store = new AuthStore(dir);
    store.saveClient({ client_id: 'client-1', redirect_uris: ['https://x.test/cb'] });
    store.saveApproval('client-1', 'https://x.test/cb');
    store.saveRefreshToken('one', { clientId: 'client-1', scopes: [], expiresAt: Math.floor(Date.now() / 1000) + 600 });
    store.saveRefreshToken('other-client', { clientId: 'client-2', scopes: [], expiresAt: Math.floor(Date.now() / 1000) + 600 });

    const result = store.revokeClientAccess('client-1');
    expect(result.refreshTokens).toBe(1);
    expect(store.getApproval('client-1')).toBeUndefined();
    expect(store.getRefreshToken('one')).toBeUndefined();
    expect(store.getRefreshToken('other-client')).toBeDefined();
    expect(store.getRevokedBefore('client-1')).toBe(result.revokedBefore);
  });
});

/**
 * The admin CLI is a separate process against the same /data volume, so two
 * AuthStore instances on one directory is not an exotic case — it is the
 * documented way to list and revoke. `hub` stands for the long-running server,
 * `cli` for one mcp-hub-admin invocation.
 */
describe('AuthStore across processes', () => {
  const record = (label: string) => ({
    label,
    resource: 'https://hub.test/hub',
    createdAt: Math.floor(Date.now() / 1000),
    expiresAt: Math.floor(Date.now() / 1000) + 3600
  });

  it('sees an API token minted by another process', () => {
    const dir = tmpDir();
    const hub = new AuthStore(dir);
    const cli = new AuthStore(dir);

    cli.saveApiToken('minted-by-cli', record('cli'));

    // Without this the hub answers "Access token has been revoked" for a token
    // it was never told about, until someone restarts the container.
    expect(hub.getApiToken('minted-by-cli')?.label).toBe('cli');
  });

  it('honours an API token revoked by another process', () => {
    const dir = tmpDir();
    const hub = new AuthStore(dir);
    hub.saveApiToken('doomed', record('doomed'));

    expect(new AuthStore(dir).revokeApiToken('doomed')).toBe(true);

    // A revocation that reports success but leaves the token usable is the
    // worst failure mode this store has.
    expect(hub.getApiToken('doomed')).toBeUndefined();
  });

  it('does not resurrect a revoked token on its next unrelated write', () => {
    const dir = tmpDir();
    const hub = new AuthStore(dir);
    hub.saveApiToken('doomed', record('doomed'));
    new AuthStore(dir).revokeApiToken('doomed');

    // persist() writes the whole file, and the hub persists on every refresh
    // token rotation — minutes apart in practice.
    hub.saveApiToken('unrelated', record('unrelated'));

    expect(new AuthStore(dir).getApiToken('doomed')).toBeUndefined();
    expect(new AuthStore(dir).getApiToken('unrelated')).toBeDefined();
  });

  it('honours a client revocation performed by another process', () => {
    const dir = tmpDir();
    const hub = new AuthStore(dir);
    hub.saveClient({ client_id: 'c1', redirect_uris: ['https://x.test/cb'] });
    hub.saveApproval('c1', 'https://x.test/cb');
    hub.saveRefreshToken('rt', { clientId: 'c1', scopes: [], expiresAt: Math.floor(Date.now() / 1000) + 600 });

    new AuthStore(dir).revokeClientAccess('c1');

    expect(hub.getApproval('c1')).toBeUndefined();
    expect(hub.getRefreshToken('rt')).toBeUndefined();
    expect(hub.getRevokedBefore('c1')).toBeDefined();
  });

  it('keeps its state when a reload cannot be parsed', () => {
    const dir = tmpDir();
    const hub = new AuthStore(dir);
    hub.saveApiToken('live', record('live'));
    const secret = hub.cookieSecret;

    fs.writeFileSync(path.join(dir, 'state.json'), '{"cookieSecret": "truncated');

    // Unlike the constructor, a reload must not quarantine the file and start
    // fresh: rotating cookieSecret under a running hub logs out every session.
    expect(hub.cookieSecret).toBe(secret);
    expect(hub.getApiToken('live')).toBeDefined();
    expect(fs.readdirSync(dir).some(f => f.startsWith('state.json.corrupt-'))).toBe(false);
  });

  it('never leaves a shared temporary file behind', () => {
    const dir = tmpDir();
    const hub = new AuthStore(dir);
    hub.saveApiToken('a', record('a'));

    // A fixed "state.json.tmp" would let two writers scribble over each other.
    expect(fs.readdirSync(dir).filter(f => f.includes('.tmp'))).toEqual([]);
  });
});
