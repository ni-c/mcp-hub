import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManagedServer, listAllTools } from '../src/supervisor.js';
import { AuthStore, MAX_UNAPPROVED_CLIENTS } from '../src/auth/store.js';
import { LoginRateLimiter } from '../src/auth/rate-limit.js';
import { earlyRateLimit, rateLimitKey } from '../src/auth/rate-limit.js';
import { stripPhantomSecret, withoutPhantomSecret } from '../src/auth/oidc/quirks.js';
import { ClientRequestGate } from '../src/limits.js';
import type { NextFunction, Request, Response } from 'express';
import { ABSOLUTE_CALL_OPTIONS, ABSOLUTE_CALL_TIMEOUT_MS, MAX_FORWARDED_RESULT_BYTES, assertForwardedResultSize } from '../src/mcp-limits.js';

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

  /**
   * The global ceiling used to block every address, which is what made the
   * lockout below possible. It now refuses the callers that are guessing — on
   * their first failure rather than their tenth, so the total number of guesses
   * still collapses — and leaves alone the ones that are not.
   */
  it('refuses a caller that has failed once the global cap is reached', () => {
    const limiter = new LoginRateLimiter();
    // 100 distinct addresses, one failure each: no per-caller counter is
    // anywhere near its limit, which is what rotating X-Forwarded-For looks like.
    for (let i = 0; i < 100; i++) limiter.recordFailure(`10.0.0.${i}`);
    expect(limiter.isBlocked('10.0.0.42')).toBe(true);
    expect(limiter.isBlocked('192.168.0.1')).toBe(false);
  });

  /**
   * The lockout this prevents cost one host under a second: a hundred wrong
   * passwords out of one /64, and the operator holding the correct password was
   * refused from an address that had never touched the form.
   */
  it('does not lock out a caller that has not guessed, once the global ceiling is reached', () => {
    const limiter = new LoginRateLimiter();
    for (let network = 0; network < 10; network++) {
      for (let attempt = 0; attempt < 10; attempt++) limiter.recordFailure(`2001:db8:0:${network}::1`);
    }

    // The ceiling is reached: every caller that has been guessing is refused.
    expect(limiter.isBlocked('2001:db8:0:5::1')).toBe(true);
    // ...and the operator, from an address with nothing recorded against it,
    // still gets to type the password.
    expect(limiter.isBlocked('198.51.100.7')).toBe(false);

    // The ceiling still bites the moment that address does guess.
    limiter.recordFailure('198.51.100.7');
    expect(limiter.isBlocked('198.51.100.7')).toBe(true);
  });

  it('counts a whole IPv6 /64 as one caller', () => {
    const limiter = new LoginRateLimiter();
    // Ten different addresses, one subscriber network.
    for (let host = 1; host <= 10; host++) limiter.recordFailure(`2001:db8:1:1::${host}`);
    expect(limiter.isBlocked('2001:db8:1:1::999')).toBe(true);
    // A different /64 is a different caller.
    expect(limiter.isBlocked('2001:db8:1:2::1')).toBe(false);
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
  /** Collects the finish/close handlers so a test can end the request itself. */
  const stubResponse = () => {
    const listeners = new Map<string, () => void>();
    const body: Record<string, unknown>[] = [];
    const response = {
      once: (event: string, handler: () => void) => listeners.set(event, handler),
      set: () => response,
      status: () => response,
      json: (payload: Record<string, unknown>) => {
        body.push(payload);
        return response;
      }
    } as unknown as Response;
    return { response, listeners, body };
  };

  it('limits concurrent requests per OAuth client and releases on finish', () => {
    const gate = new ClientRequestGate(10, 1, 10);
    const { response, listeners } = stubResponse();
    const request = { method: 'POST', auth: { clientId: 'client-1' } } as Request;
    let passed = 0;
    gate.middleware(request, response, (() => passed++) as NextFunction);
    gate.middleware(request, response, (() => passed++) as NextFunction);
    expect(passed).toBe(1);
    listeners.get('finish')?.();
    gate.middleware(request, response, (() => passed++) as NextFunction);
    expect(passed).toBe(2);
  });

  it('keeps open listening streams out of the in-flight budget', () => {
    // The regression this guards: a GET is the session's SSE channel and stays
    // open for its lifetime, so counting it as in-flight work locked a client
    // out of its own hub after `maxConcurrent` connected sessions.
    const gate = new ClientRequestGate(100, 1, 10);
    const { response } = stubResponse();
    const clientId = 'client-1';
    let passed = 0;
    const next = (() => passed++) as NextFunction;

    for (let i = 0; i < 4; i++) gate.middleware({ method: 'GET', auth: { clientId } } as Request, response, next);
    expect(passed).toBe(4);

    gate.middleware({ method: 'POST', auth: { clientId } } as Request, response, next);
    expect(passed).toBe(5);
  });

  it('keeps a subscriptions/listen POST out of the in-flight budget too', () => {
    // The same regression as the GET above, in the shape 2026-07-28 gave it:
    // there is no standing GET any more, and `subscriptions/listen` is a POST
    // whose response stays open for the life of the subscription. Counted as
    // in-flight work it would hold a slot the whole time, and with the default
    // of four a handful of subscribed clients would lock every tool call on the
    // hub out with a 429 while nothing was actually running.
    const gate = new ClientRequestGate(100, 1, 10);
    const { response } = stubResponse();
    const clientId = 'client-1';
    let passed = 0;
    const next = (() => passed++) as NextFunction;
    const listen = { method: 'POST', body: { jsonrpc: '2.0', id: 1, method: 'subscriptions/listen' }, auth: { clientId } } as Request;

    for (let i = 0; i < 4; i++) gate.middleware(listen, response, next);
    expect(passed).toBe(4);

    // The one in-flight slot is still free for real work.
    gate.middleware({ method: 'POST', body: { method: 'tools/call' }, auth: { clientId } } as Request, response, next);
    expect(passed).toBe(5);
  });

  it('charges a plain GET route such as /health to the request budget', () => {
    const gate = new ClientRequestGate(100, 1, 10);
    const { response, body } = stubResponse();
    const request = { method: 'GET', auth: { clientId: 'client-1' } } as Request;
    let passed = 0;
    const next = (() => passed++) as NextFunction;

    gate.requestMiddleware(request, response, next);
    gate.requestMiddleware(request, response, next);
    expect(passed).toBe(1);
    expect(body.at(-1)).toMatchObject({ error: { message: 'Too many concurrent MCP requests' } });
  });

  it('still bounds how many streams one client may hold open', () => {
    const gate = new ClientRequestGate(100, 4, 2);
    const { response, listeners, body } = stubResponse();
    const request = { method: 'GET', auth: { clientId: 'client-1' } } as Request;
    let passed = 0;
    const next = (() => passed++) as NextFunction;

    gate.middleware(request, response, next);
    gate.middleware(request, response, next);
    gate.middleware(request, response, next);
    expect(passed).toBe(2);
    expect(body.at(-1)).toMatchObject({ error: { message: 'Too many concurrent MCP streams' } });

    // A client that drops its connection frees the slot again.
    listeners.get('close')?.();
    gate.middleware(request, response, next);
    expect(passed).toBe(3);
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
describe('earlyRateLimit', () => {
  /** Drives the middleware with just enough of an Express request/response. */
  function call(middleware: ReturnType<typeof earlyRateLimit>, ip: string) {
    const headers: Record<string, string> = {};
    let status = 0;
    let passed = false;
    const res = {
      set: (key: string, value: string) => {
        headers[key.toLowerCase()] = value;
        return res;
      },
      status: (code: number) => {
        status = code;
        return res;
      },
      json: () => res
    };
    middleware({ ip } as Request, res as unknown as Response, (() => {
      passed = true;
    }) as NextFunction);
    return { status, headers, passed };
  }

  it('lets a caller through up to its budget and then says when to come back', () => {
    const middleware = earlyRateLimit(60_000, 2, 100);
    expect(call(middleware, '203.0.113.1').passed).toBe(true);
    expect(call(middleware, '203.0.113.1').passed).toBe(true);

    const refused = call(middleware, '203.0.113.1');
    expect(refused.passed).toBe(false);
    expect(refused.status).toBe(429);
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);

    // Another address still has its own budget.
    expect(call(middleware, '203.0.113.2').passed).toBe(true);
  });

  it('holds a global ceiling so a spread of addresses cannot walk around it', () => {
    const middleware = earlyRateLimit(60_000, 100, 2);
    expect(call(middleware, '203.0.113.1').passed).toBe(true);
    expect(call(middleware, '203.0.113.2').passed).toBe(true);
    expect(call(middleware, '203.0.113.3').passed).toBe(false);
  });

  /**
   * Without this every per-caller budget in the file is decorative: a /64 is
   * what one subscriber is handed, and spending a budget once per address in it
   * is free.
   */
  it('spends one budget for a whole IPv6 /64', () => {
    const middleware = earlyRateLimit(60_000, 2, 100);
    expect(call(middleware, '2001:db8:abcd:1::1').passed).toBe(true);
    expect(call(middleware, '2001:db8:abcd:1::2').passed).toBe(true);
    expect(call(middleware, '2001:db8:abcd:1::3').passed).toBe(false);
    // The neighbouring network is a different caller and has its own.
    expect(call(middleware, '2001:db8:abcd:2::1').passed).toBe(true);
  });

  it('gives the budget back once the window has passed, and drops the stale entries', () => {
    vi.useFakeTimers();
    try {
      const middleware = earlyRateLimit(1_000, 1, 3);
      for (const ip of ['203.0.113.1', '203.0.113.2', '203.0.113.3']) {
        expect(call(middleware, ip).passed).toBe(true);
      }
      expect(call(middleware, '203.0.113.4').passed).toBe(false);

      vi.setSystemTime(Date.now() + 2_000);
      // The table is at its ceiling but every entry in it has expired, so a new
      // caller is admitted rather than the map being allowed to grow.
      expect(call(middleware, '203.0.113.4').passed).toBe(true);
      expect(call(middleware, '203.0.113.1').passed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('rateLimitKey', () => {
  it('buckets IPv6 by /64 regardless of how the address is written', () => {
    expect(rateLimitKey('2001:0db8:0000:0001:dead:beef:0:1')).toBe(rateLimitKey('2001:db8:0:1::2'));
    expect(rateLimitKey('[2001:db8:0:1::2]')).toBe(rateLimitKey('2001:db8:0:1::3'));
    expect(rateLimitKey('2001:db8:0:1::1')).not.toBe(rateLimitKey('2001:db8:0:2::1'));
  });

  it('keeps an IPv4 address whole, mapped form included', () => {
    expect(rateLimitKey('203.0.113.9')).toBe('203.0.113.9');
    // What a dual-stack listener reports for an IPv4 peer — the same caller,
    // and it must not get a second budget for arriving that way.
    expect(rateLimitKey('::ffff:203.0.113.9')).toBe('203.0.113.9');
    expect(rateLimitKey('203.0.113.9')).not.toBe(rateLimitKey('203.0.113.10'));
  });

  it('passes anything unparseable through rather than collapsing it', () => {
    expect(rateLimitKey('unknown')).toBe('unknown');
  });
});

describe('stripPhantomSecret', () => {
  /**
   * The status code alone proves nothing here — an oversized body is refused
   * either way, because the authorization server would reject it a layer down.
   * What the ceiling changes is whether the hub reads the whole thing first,
   * and `/token` is unauthenticated by nature, so that is the number worth
   * pinning.
   */
  it('stops reading a token body at the ceiling rather than buffering it', async () => {
    const chunk = Buffer.alloc(64 * 1024, 'a');
    const total = 64 * chunk.length; // 4 MiB, if anyone were willing to read it
    let produced = 0;
    const req = Readable.from(
      (function* () {
        for (let i = 0; i < 64; i++) {
          produced += chunk.length;
          yield chunk;
        }
      })()
    ) as Readable & Record<string, unknown>;
    Object.assign(req, { method: 'POST', headers: {}, url: '/token', httpVersion: '1.1', socket: {} });

    let status = 0;
    let forwarded = false;
    const finished = new Promise<void>(resolve => {
      const res = {
        status: (code: number) => {
          status = code;
          return res;
        },
        set: () => res,
        end: () => {
          resolve();
          return res;
        }
      };
      const store = { getClient: () => undefined } as unknown as AuthStore;
      stripPhantomSecret(store, () => {
        forwarded = true;
      })(req as unknown as Request, res as unknown as Response, (() => {}) as NextFunction);
    });
    await finished;

    expect(forwarded).toBe(false);
    expect(status).toBe(400);
    // One chunk of slack: the ceiling is noticed on the chunk that crosses it.
    expect(produced).toBeLessThanOrEqual(56 * 1024 + chunk.length);
    expect(produced).toBeLessThan(total);
  });

  it('refuses on a declared length above the ceiling without reading at all', async () => {
    const req = Readable.from([Buffer.from('grant_type=authorization_code')]) as Readable & Record<string, unknown>;
    Object.assign(req, {
      method: 'POST',
      headers: { 'content-length': String(10 * 1024 * 1024) },
      url: '/token',
      httpVersion: '1.1',
      socket: {}
    });
    let status = 0;
    let forwarded = false;
    const res = {
      status: (code: number) => {
        status = code;
        return res;
      },
      set: () => res,
      end: () => res
    };
    const store = { getClient: () => undefined } as unknown as AuthStore;
    stripPhantomSecret(store, () => {
      forwarded = true;
    })(req as unknown as Request, res as unknown as Response, (() => {}) as NextFunction);

    expect(status).toBe(400);
    expect(forwarded).toBe(false);
  });
});

describe('withoutPhantomSecret', () => {
  it('drops a secret a public client cannot use', () => {
    const cleaned = withoutPhantomSecret({
      client_id: 'abc',
      token_endpoint_auth_method: 'none',
      client_secret: 'minted-because-the-field-was-omitted',
      client_secret_expires_at: 0
    });
    expect(cleaned).toEqual({ client_id: 'abc', token_endpoint_auth_method: 'none' });
  });

  it('keeps the secret of a client that authenticates with one', () => {
    const record = { client_id: 'abc', token_endpoint_auth_method: 'client_secret_post', client_secret: 's' };
    expect(withoutPhantomSecret(record)).toBe(record);
  });

  it('keeps the secret when an HMAC response algorithm signs with it', () => {
    const record = {
      client_id: 'abc',
      token_endpoint_auth_method: 'none',
      id_token_signed_response_alg: 'HS256',
      client_secret: 's'
    };
    expect(withoutPhantomSecret(record)).toBe(record);
  });

  it('leaves a record without a secret untouched', () => {
    const record = { client_id: 'abc', token_endpoint_auth_method: 'none' };
    expect(withoutPhantomSecret(record)).toBe(record);
  });
});

describe('client registration lifecycle', () => {
  const HOUR = 3600;
  const DAY = 86_400;
  // Real windows, so the rules are exercised as configured rather than as
  // degenerate zero-length ones.
  const limits = { maxClients: 5, pendingTtlSeconds: 24 * HOUR, inactiveSeconds: 90 * DAY };
  const register = (store: AuthStore, id: string, token?: string) =>
    store.addClient({ client_id: id, redirect_uris: ['https://x.test/cb'] }, token);

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps a registration that was never approved only for the pending window', () => {
    vi.useFakeTimers();
    const store = new AuthStore(tmpDir(), limits);
    register(store, 'pending');
    register(store, 'confirmed');
    store.saveApproval('confirmed', 'https://x.test/cb');

    vi.setSystemTime(Date.now() + 23 * HOUR * 1000);
    expect(store.pruneClients().pending).toEqual([]);

    vi.setSystemTime(Date.now() + 2 * HOUR * 1000);
    expect(store.pruneClients().pending).toEqual(['pending']);
    expect(store.getClient('pending')).toBeUndefined();
    // Approval is what separates the two; the confirmed one is not on a clock
    // until the much longer inactivity window.
    expect(store.getClient('confirmed')).toBeDefined();
  });

  it('lets an authorization attempt extend the pending window', () => {
    vi.useFakeTimers();
    const store = new AuthStore(tmpDir(), limits);
    register(store, 'slow');

    // The user is still typing their password twenty hours later.
    vi.setSystemTime(Date.now() + 20 * HOUR * 1000);
    store.touchClient('slow');

    vi.setSystemTime(Date.now() + 10 * HOUR * 1000); // 30h after registering
    expect(store.pruneClients().pending).toEqual([]);
    expect(store.getClient('slow')).toBeDefined();
  });

  it('forgets an approved registration nobody has used, along with its grants', () => {
    vi.useFakeTimers();
    const store = new AuthStore(tmpDir(), limits);
    register(store, 'stale');
    store.saveApproval('stale', 'https://x.test/cb');
    store.saveRefreshToken('rt', { clientId: 'stale', scopes: [], expiresAt: Math.floor(Date.now() / 1000) + 400 * DAY });

    vi.setSystemTime(Date.now() + 89 * DAY * 1000);
    expect(store.pruneClients().inactive).toEqual([]);

    vi.setSystemTime(Date.now() + 2 * DAY * 1000);
    expect(store.pruneClients().inactive).toEqual(['stale']);
    expect(store.getClient('stale')).toBeUndefined();
    expect(store.getApproval('stale')).toBeUndefined();
    expect(store.getRefreshToken('rt')).toBeUndefined();
  });

  it('starts the clock rather than deleting when a state file predates activity tracking', () => {
    vi.useFakeTimers();
    const dir = tmpDir();
    const store = new AuthStore(dir, limits);
    // What an upgrade looks like: a client with no lifecycle record whose
    // registration date is far outside the inactivity window.
    store.saveClient({ client_id: 'legacy', client_id_issued_at: 1, redirect_uris: ['https://x.test/cb'] });
    store.saveApproval('legacy', 'https://x.test/cb');

    expect(store.pruneClients()).toEqual({ pending: [], inactive: [] });
    expect(store.getClient('legacy')).toBeDefined();

    // And from there it ages normally.
    vi.setSystemTime(Date.now() + 91 * DAY * 1000);
    expect(store.pruneClients().inactive).toEqual(['legacy']);
  });

  it('refuses a new registration rather than evicting a confirmed one', () => {
    const store = new AuthStore(tmpDir(), limits);
    for (let i = 0; i < limits.maxClients; i++) {
      expect(register(store, `c${i}`)).toBe(true);
      store.saveApproval(`c${i}`, 'https://x.test/cb');
    }
    // Every slot holds a client somebody confirmed, so making room would take
    // a working connector offline.
    expect(register(store, 'newcomer')).toBe(false);
    expect(store.getClient('newcomer')).toBeUndefined();
    expect(store.getClient('c0')).toBeDefined();
  });

  it('makes room by dropping the oldest unconfirmed registration', () => {
    const store = new AuthStore(tmpDir(), limits);
    store.addClient({ client_id: 'oldest', client_id_issued_at: 1, redirect_uris: ['https://x.test/cb'] });
    for (let i = 1; i < limits.maxClients; i++) {
      store.addClient({ client_id: `c${i}`, client_id_issued_at: 100 + i, redirect_uris: ['https://x.test/cb'] });
      store.saveApproval(`c${i}`, 'https://x.test/cb');
    }
    expect(register(store, 'newcomer')).toBe(true);
    expect(store.getClient('oldest')).toBeUndefined();
    expect(store.getClient('newcomer')).toBeDefined();
  });

  it('never expires a client the operator created by hand', () => {
    vi.useFakeTimers();
    const store = new AuthStore(tmpDir(), limits);
    store.addClient({ client_id: 'operator', redirect_uris: ['https://x.test/cb'] }, undefined, { operatorManaged: true });
    register(store, 'self-registered');

    // Far past both windows. The self-registered one was never approved and
    // goes; the hand-made one stays whatever happens.
    vi.setSystemTime(Date.now() + 200 * DAY * 1000);
    const removed = store.pruneClients();
    expect(removed.pending).toEqual(['self-registered']);
    expect(removed.inactive).toEqual([]);
    expect(store.getClient('operator')).toBeDefined();
    expect(store.isOperatorManaged('operator')).toBe(true);
    expect(store.isOperatorManaged('self-registered')).toBe(false);
  });

  it('lets the operator add a client even when the hub is full', () => {
    const store = new AuthStore(tmpDir(), limits);
    for (let i = 0; i < limits.maxClients; i++) {
      register(store, `c${i}`);
      store.saveApproval(`c${i}`, 'https://x.test/cb');
    }
    // A self-registering newcomer is refused here — but the person who
    // administers the hub is not a stranger asking for a slot.
    expect(register(store, 'stranger')).toBe(false);
    expect(store.addClient({ client_id: 'operator', redirect_uris: ['https://x.test/cb'] }, undefined, { operatorManaged: true })).toBe(true);
    expect(store.getClient('operator')).toBeDefined();
  });

  it('never evicts an operator-created client to make room', () => {
    const store = new AuthStore(tmpDir(), limits);
    // Unapproved and the oldest, so ordinarily the first to go.
    store.addClient({ client_id: 'operator', client_id_issued_at: 1, redirect_uris: ['https://x.test/cb'] }, undefined, {
      operatorManaged: true
    });
    for (let i = 1; i < limits.maxClients; i++) {
      store.addClient({ client_id: `c${i}`, client_id_issued_at: 100 + i, redirect_uris: ['https://x.test/cb'] });
      store.saveApproval(`c${i}`, 'https://x.test/cb');
    }
    expect(register(store, 'newcomer')).toBe(false);
    expect(store.getClient('operator')).toBeDefined();
  });

  it('removes a registration outright, unlike revoke', () => {
    const store = new AuthStore(tmpDir(), limits);
    register(store, 'gone');
    store.saveApproval('gone', 'https://x.test/cb');
    store.saveRefreshToken('rt', { clientId: 'gone', scopes: [], expiresAt: Math.floor(Date.now() / 1000) + 600 });

    expect(store.deleteClient('gone')).toBe(true);
    expect(store.getClient('gone')).toBeUndefined();
    expect(store.getApproval('gone')).toBeUndefined();
    expect(store.getRefreshToken('rt')).toBeUndefined();
    // Live access tokens stop working now, not in fifteen minutes.
    expect(store.getRevokedBefore('gone')).toBeDefined();
    expect(store.deleteClient('gone')).toBe(false);
  });

  it('checks a registration access token without storing it', () => {
    const dir = tmpDir();
    const store = new AuthStore(dir, limits);
    register(store, 'managed', 'the-secret-token');

    expect(store.verifyRegistrationToken('managed', 'the-secret-token')).toBe(true);
    expect(store.verifyRegistrationToken('managed', 'wrong')).toBe(false);
    expect(store.verifyRegistrationToken('unknown', 'the-secret-token')).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).not.toContain('the-secret-token');
  });

  it('drops revocation markers once they cannot reject anything any more', () => {
    vi.useFakeTimers();
    const store = new AuthStore(tmpDir(), limits);
    store.saveClient({ client_id: 'revoked', redirect_uris: ['https://x.test/cb'] });
    store.revokeClientAccess('revoked');
    expect(store.getRevokedBefore('revoked')).toBeDefined();

    // Longer than any refresh token could survive, so the marker is answering
    // a question nobody can ask.
    vi.setSystemTime(Date.now() + 40 * DAY * 1000);
    store.saveApproval('unrelated', 'https://x.test/cb'); // any write triggers the sweep
    expect(store.getRevokedBefore('revoked')).toBeUndefined();
  });
});

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

  const runWriter = (dir: string, mode: 'create' | 'revoke', prefix: string) =>
    new Promise<void>((resolve, reject) => {
      const source = `
        import { AuthStore } from './src/auth/store.ts';
        const [dir, mode, prefix] = process.argv.slice(1);
        const store = new AuthStore(dir);
        const now = Math.floor(Date.now() / 1000);
        if (mode === 'revoke') store.revokeApiToken('doomed');
        else for (let i = 0; i < 50; i++) store.saveApiToken(prefix + i, { label: prefix, resource: 'https://hub.test/hub', createdAt: now, expiresAt: now + 3600 });
      `;
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source, dir, mode, prefix], {
        cwd: path.resolve('.'),
        stdio: ['ignore', 'ignore', 'pipe']
      });
      let stderr = '';
      child.stderr.on('data', chunk => (stderr += chunk));
      child.on('error', reject);
      child.on('exit', code => (code === 0 ? resolve() : reject(new Error(`child exited ${code}: ${stderr}`))));
    });

  it('serializes simultaneous writers in separate OS processes', async () => {
    const dir = tmpDir();
    new AuthStore(dir);
    await Promise.all([runWriter(dir, 'create', 'left-'), runWriter(dir, 'create', 'right-')]);
    const tokens = new AuthStore(dir).listApiTokens();
    expect(Object.keys(tokens).filter(id => id.startsWith('left-'))).toHaveLength(50);
    expect(Object.keys(tokens).filter(id => id.startsWith('right-'))).toHaveLength(50);
  });

  it('does not resurrect a revocation racing an unrelated OS-process writer', async () => {
    const dir = tmpDir();
    const store = new AuthStore(dir);
    store.saveApiToken('doomed', record('doomed'));
    await Promise.all([runWriter(dir, 'revoke', 'unused'), runWriter(dir, 'create', 'kept-')]);
    const reloaded = new AuthStore(dir);
    expect(reloaded.getApiToken('doomed')).toBeUndefined();
    expect(Object.keys(reloaded.listApiTokens()).filter(id => id.startsWith('kept-'))).toHaveLength(50);
  });

  it('breaks a lock whose owner file was never written', () => {
    const dir = tmpDir();
    new AuthStore(dir);
    // The lock directory is created before the owner file: a process killed
    // between the two leaves a lock nobody can attribute. Without the age
    // fallback this wedges the data directory permanently.
    const lock = path.join(dir, '.auth-state.lock');
    fs.mkdirSync(lock);
    const stale = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, stale, stale);

    const store = new AuthStore(dir);
    store.saveApiToken('after', record('after'));
    expect(new AuthStore(dir).getApiToken('after')).toBeDefined();
  });

  it('rewrites a state file that vanished under a running store', () => {
    const dir = tmpDir();
    const hub = new AuthStore(dir);
    hub.saveApiToken('live', record('live'));
    fs.rmSync(path.join(dir, 'state.json'));

    // Refusing here would break every refresh-token rotation until restart.
    hub.saveApiToken('after', record('after'));
    const reloaded = new AuthStore(dir);
    expect(reloaded.getApiToken('live')).toBeDefined();
    expect(reloaded.getApiToken('after')).toBeDefined();
  });
});

describe('MCP response and discovery budgets', () => {
  /** A child that answers `tools/list` however the test wants it to. */
  const upstream = (reply: (params: { cursor?: string }) => unknown) =>
    ({
      request: async (req: { method: string; params?: { cursor?: string } }) => reply(req.params ?? {})
    }) as never;

  it('caps pagination even when an upstream always returns another cursor', async () => {
    let page = 0;
    await expect(listAllTools(upstream(() => ({ tools: [], nextCursor: `page-${++page}` })))).rejects.toThrow(/100 pages/);
  });

  it('caps tool count and metadata independently', async () => {
    const many = Array.from({ length: 10_001 }, (_, i) => ({ name: `t${i}`, inputSchema: { type: 'object' as const } }));
    await expect(listAllTools(upstream(() => ({ tools: many })))).rejects.toThrow(/10000 tools/);
    const huge = [{ name: 'huge', description: 'x'.repeat(17 * 1024 * 1024), inputSchema: { type: 'object' as const } }];
    await expect(listAllTools(upstream(() => ({ tools: huge })))).rejects.toThrow(/metadata/);
  });

  it('walks the pagination itself, one request per page', async () => {
    // The budgets above are per page, so they only bind if the hub asks for
    // one page at a time. SDK v2's `listTools()` walks the whole pagination
    // internally whenever it is called without a cursor — which is every first
    // call — and returns one merged result; every budget above would then be
    // measured once, against everything, having already been buffered. So the
    // shape of the calls is the thing under test, not just the outcome.
    const cursors: (string | undefined)[] = [];
    const tools = await listAllTools(
      upstream(({ cursor }) => {
        cursors.push(cursor);
        return cursor === 'second' ? { tools: [{ name: 'b', inputSchema: { type: 'object' } }] } : { tools: [{ name: 'a', inputSchema: { type: 'object' } }], nextCursor: 'second' };
      })
    );
    expect(cursors).toEqual([undefined, 'second']);
    expect(tools.map(t => t.name)).toEqual(['a', 'b']);
  });

  it('rejects forwarded results above 8 MiB and keeps the timeout absolute', () => {
    expect(() => assertForwardedResultSize({ content: 'x'.repeat(MAX_FORWARDED_RESULT_BYTES) })).toThrow(/forwarding limit/);
    expect(ABSOLUTE_CALL_TIMEOUT_MS).toBe(5 * 60_000);
    expect(ABSOLUTE_CALL_OPTIONS.resetTimeoutOnProgress).toBe(false);
  });

  // The options are read once at module load, so each case needs a fresh import.
  const limitsWith = async (env: Record<string, string>) => {
    vi.resetModules();
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    try {
      return await import('../src/mcp-limits.js');
    } finally {
      vi.unstubAllEnvs();
    }
  };

  it('lets a deployment raise the deadline and opt back into progress extending it', async () => {
    const limits = await limitsWith({ MCP_CALL_TIMEOUT_MS: '1800000', MCP_RESET_TIMEOUT_ON_PROGRESS: 'true' });
    expect(limits.ABSOLUTE_CALL_OPTIONS.timeout).toBe(30 * 60_000);
    expect(limits.ABSOLUTE_CALL_OPTIONS.resetTimeoutOnProgress).toBe(true);
  });

  it('falls back to the hardened defaults instead of exiting on nonsense', async () => {
    const limits = await limitsWith({ MCP_CALL_TIMEOUT_MS: 'soon', MCP_RESET_TIMEOUT_ON_PROGRESS: 'maybe' });
    expect(limits.ABSOLUTE_CALL_OPTIONS.timeout).toBe(limits.DEFAULT_CALL_TIMEOUT_MS);
    expect(limits.ABSOLUTE_CALL_OPTIONS.resetTimeoutOnProgress).toBe(false);
  });
});
