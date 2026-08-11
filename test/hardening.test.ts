import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ManagedServer } from '../src/supervisor.js';
import { AuthStore } from '../src/auth/store.js';
import { LoginRateLimiter } from '../src/auth/routes.js';

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

  it('drops entries whose window has passed instead of growing forever', () => {
    const limiter = new LoginRateLimiter();
    limiter.recordFailure('10.0.0.1');
    limiter['attempts'].get('10.0.0.1')!.resetAt = Date.now() - 1;

    limiter.recordFailure('10.0.0.2');
    expect(limiter['attempts'].has('10.0.0.1')).toBe(false);
    expect(limiter['attempts'].size).toBe(1);
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
});
