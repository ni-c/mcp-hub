import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { STDIO_DEFAULT_MAX_BUFFER_SIZE } from '@modelcontextprotocol/server';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuthStore } from '../src/auth/store.js';
import type { RemoteServerConfig } from '../src/config.js';
import { ManagedServer } from '../src/supervisor.js';
import { UpstreamAuth, UpstreamLoginRequiredError } from '../src/upstream/auth.js';
import { credentialFingerprint, UpstreamAuthProvider } from '../src/upstream/provider.js';
import { boundedRedirectFetch, MAX_UPSTREAM_RESPONSE_BYTES } from '../src/upstream/redirects.js';
import { MAX_RESOURCE_URI_BYTES, SubscriptionRegistry } from '../src/subscriptions.js';
import type { ServerNotifier } from '@modelcontextprotocol/server';

/**
 * A remote upstream's data-plane fetch (`buildRemoteTransport` /
 * `UpstreamAuth.createFetch`) needs a byte ceiling somewhere between the wire
 * and the SDK's `response.json()` — otherwise an ordinary JSON reply or a
 * single SSE event can be arbitrarily large, growing the hub's heap in lock
 * step, with only a container's `mem_limit` as a backstop. `resources/updated`
 * notifications need the same guard one layer up: `SubscriptionRegistry.publish`
 * caps how many distinct URIs a window holds, but that alone says nothing
 * about how large one URI is.
 *
 * Separately, an upstream's `access_token`/`refresh_token` needs validating
 * before it is stored. A token containing CR/LF would corrupt every later
 * request to that server — `Headers.set()` throws and quotes the raw value in
 * its own message — and an authorization server that omits `expires_in`
 * would make the corruption permanent, since `secondsLeft()` never expires it.
 */

const UPSTREAM = 'https://upstream.example/mcp';

afterEach(() => {
  vi.unstubAllGlobals();
});

const dirs: string[] = [];
function directory(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-upstream-limits-'));
  dirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// --- shared byte-stream helpers -------------------------------------------

/** A ReadableStream that hands out `chunks` one at a time, like a real socket
 *  would — never the whole body in one piece. */
function chunkStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[i++]!);
    }
  });
}

/** `n` bytes of `fill`, split into realistic ~64 KiB network chunks. */
function bytesOf(n: number, fill = 0x61): Uint8Array[] {
  const out: Uint8Array[] = [];
  let remaining = n;
  const chunkSize = 64 * 1024;
  while (remaining > 0) {
    const size = Math.min(chunkSize, remaining);
    out.push(new Uint8Array(size).fill(fill));
    remaining -= size;
  }
  return out;
}

function defaultTokenResponse(): Record<string, unknown> {
  return { access_token: 'access-1', token_type: 'Bearer', expires_in: 3600 };
}

function sseEvents(events: string[]): Uint8Array[] {
  const encoder = new TextEncoder();
  return events.map(event => encoder.encode(event));
}

/** Drains a body, returning the total byte count or rethrowing a stream error. */
async function drain(response: Response): Promise<number> {
  const reader = response.body!.getReader();
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return total;
    total += value.byteLength;
  }
}

describe('boundedRedirectFetch: a byte ceiling on the remote data plane', () => {
  const CAP = 2048;

  it('delivers a non-SSE body whose length is exactly the cap', async () => {
    const impl: typeof fetch = async () => new Response(chunkStream(bytesOf(CAP)), { status: 200, headers: { 'content-type': 'application/json' } });
    const response = await boundedRedirectFetch('https://upstream.example', impl, CAP)(UPSTREAM);
    expect(response.status).toBe(200);
    await expect(drain(response)).resolves.toBe(CAP);
  });

  it('errors the stream once a chunked (no content-length) non-SSE body exceeds the cap', async () => {
    const impl: typeof fetch = async () => new Response(chunkStream(bytesOf(CAP + 1)), { status: 200, headers: { 'content-type': 'application/json' } });
    const response = await boundedRedirectFetch('https://upstream.example', impl, CAP)(UPSTREAM);
    await expect(drain(response)).rejects.toThrow(new RegExp(`exceeds the ${CAP} byte limit`));
  });

  it('rejects early, before reading a byte, when content-length alone already exceeds the cap', async () => {
    const calls: number[] = [];
    const impl: typeof fetch = async () => {
      calls.push(1);
      return new Response(chunkStream(bytesOf(CAP + 1)), {
        status: 200,
        headers: { 'content-type': 'application/json', 'content-length': String(CAP + 1) }
      });
    };
    // The rejection is on the returned promise itself, matching "reject early"
    // — the caller never gets a Response to read from at all.
    await expect(boundedRedirectFetch('https://upstream.example', impl, CAP)(UPSTREAM)).rejects.toThrow(
      new RegExp(`declared a ${CAP + 1} byte response, exceeding the ${CAP} byte limit`)
    );
    expect(calls).toHaveLength(1); // the fetch itself still happened once — the check runs on its response.
  });

  it('never treats an oversized response as a redirect off the origin or a hop it should follow', async () => {
    // Regression guard for the two guards living in the same function: an
    // oversized 200 must not be confused with a 3xx, and the byte cap must not
    // fire on a redirect's (cancelled) body before the location check runs.
    const impl: typeof fetch = async (input: unknown) =>
      String(input) === UPSTREAM
        ? new Response(null, { status: 302, headers: { location: '/mcp/' } })
        : new Response(chunkStream(bytesOf(CAP)), { status: 200, headers: { 'content-type': 'application/json' } });
    const response = await boundedRedirectFetch('https://upstream.example', impl, CAP)(UPSTREAM);
    expect(response.status).toBe(200);
    await expect(drain(response)).resolves.toBe(CAP);
  });

  describe('text/event-stream: the cap is per event, not per connection', () => {
    it('accepts many small events whose total comfortably exceeds the cap', async () => {
      const events = Array.from({ length: 40 }, (_, i) => `data: event-${i}-${'x'.repeat(40)}\n\n`);
      const totalBytes = events.join('').length;
      expect(totalBytes).toBeGreaterThan(CAP); // the property under test: total > cap, each event < cap.
      const impl: typeof fetch = async () => new Response(chunkStream(sseEvents(events)), { status: 200, headers: { 'content-type': 'text/event-stream' } });
      const response = await boundedRedirectFetch('https://upstream.example', impl, CAP)(UPSTREAM);
      await expect(drain(response)).resolves.toBe(totalBytes);
    });

    it('errors the stream when a single event exceeds the cap', async () => {
      const bigEvent = `data: ${'x'.repeat(CAP + 100)}\n\n`;
      const impl: typeof fetch = async () => new Response(chunkStream(sseEvents([bigEvent])), { status: 200, headers: { 'content-type': 'text/event-stream' } });
      const response = await boundedRedirectFetch('https://upstream.example', impl, CAP)(UPSTREAM);
      await expect(drain(response)).rejects.toThrow(new RegExp(`SSE event exceeds the ${CAP} byte limit`));
    });

    it('gives an oversized event that arrives after several normal ones the same treatment', async () => {
      // The counter has to reset at each boundary, not just accumulate: a
      // stream that behaved for a while and then sent one huge event must
      // still be caught, not grandfathered in by the earlier small ones.
      const events = ['data: fine\n\n', 'data: also fine\n\n', `data: ${'x'.repeat(CAP + 50)}\n\n`, 'data: unreachable\n\n'];
      const impl: typeof fetch = async () => new Response(chunkStream(sseEvents(events)), { status: 200, headers: { 'content-type': 'text/event-stream' } });
      const response = await boundedRedirectFetch('https://upstream.example', impl, CAP)(UPSTREAM);
      await expect(drain(response)).rejects.toThrow(new RegExp(`SSE event exceeds the ${CAP} byte limit`));
    });

    it.each([
      ['LF', '\n\n'],
      ['CRLF', '\r\n\r\n'],
      ['bare CR', '\r\r'],
      ['CRLF then LF', '\r\n\n'],
      ['LF then CRLF', '\n\r\n']
    ])('recognises a %s blank line as an event boundary, including when it is split across chunks', async (_label, boundary) => {
      const encoder = new TextEncoder();
      const full = encoder.encode(`data: one${boundary}data: two${boundary}`);
      // Split the input in the middle of the boundary sequence itself, so the
      // one byte of CR lookahead has to survive a transform() call boundary.
      const splitAt = Math.max(1, full.indexOf(encoder.encode(boundary)[0]!) + 1);
      const chunks = [full.slice(0, splitAt), full.slice(splitAt)];
      const impl: typeof fetch = async () => new Response(chunkStream(chunks), { status: 200, headers: { 'content-type': 'text/event-stream' } });
      // A cap far smaller than either single event, but each event on its own
      // is tiny — so acceptance proves the boundary was actually recognised
      // and the counter reset, not that the cap was simply never hit.
      const response = await boundedRedirectFetch('https://upstream.example', impl, 20)(UPSTREAM);
      await expect(drain(response)).resolves.toBe(full.byteLength);
    });
  });

  it('defaults to the byte-stream transports’ own read-buffer limit, not an invented number', () => {
    expect(MAX_UPSTREAM_RESPONSE_BYTES).toBe(STDIO_DEFAULT_MAX_BUFFER_SIZE);
  });

  it('applies the default cap when none is passed, rejecting early on a declared oversized content-length', async () => {
    const impl: typeof fetch = async () =>
      new Response(chunkStream([new Uint8Array(1)]), {
        status: 200,
        headers: { 'content-type': 'application/json', 'content-length': String(MAX_UPSTREAM_RESPONSE_BYTES + 1) }
      });
    // No third argument: proves the wiring, not just the mechanism — cheap
    // because content-length rejection never reads a body.
    await expect(boundedRedirectFetch('https://upstream.example', impl)(UPSTREAM)).rejects.toThrow(/exceeding the \d+ byte limit/);
  });

  describe('wired into the remote transports, a failed size check is a failed connection, not a crash', () => {
    it('a plain remote server: an oversized reply to the initial request lands the server in "down"', async () => {
      // ManagedServer always wires the production default cap, not a test-sized
      // one — so this proves the byte limit at the real size via the cheap,
      // content-length-only rejection rather than generating 10+ MiB of body.
      const overCap = MAX_UPSTREAM_RESPONSE_BYTES + 1;
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(chunkStream([new Uint8Array(1)]), { status: 200, headers: { 'content-type': 'application/json', 'content-length': String(overCap) } }))
      );
      const config: RemoteServerConfig = { kind: 'remote', transport: 'http', url: UPSTREAM, headers: {}, hub: true };
      const server = new ManagedServer('remote', config);
      await server.start();
      try {
        expect(server.state).toBe('down');
        expect(server.lastError).toMatch(/byte limit/);
      } finally {
        await server.stop();
      }
    });

    it('an OAuth upstream: the data-plane fetch rejects an oversized reply the same way', async () => {
      const config: RemoteServerConfig = {
        kind: 'remote',
        transport: 'http',
        url: UPSTREAM,
        headers: {},
        hub: true,
        oauth: { mode: 'static', grant: 'authorization_code', clientId: 'hub', scopes: [] }
      };
      const overCap = STDIO_DEFAULT_MAX_BUFFER_SIZE + 1;
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(chunkStream([new Uint8Array(1)]), { status: 200, headers: { 'content-type': 'application/json', 'content-length': String(overCap) } }))
      );
      // Built after the stub: `boundedRedirectFetch`'s fetch default binds to
      // whatever the global is at call time, not at module load.
      const auth = new UpstreamAuth('saas', config, new AuthStore(directory()), 'http://localhost/');
      const guarded = auth.createFetch();
      await expect(guarded(UPSTREAM, { method: 'POST', body: '{}' })).rejects.toThrow(/byte limit/);
    });
  });
});

function freshRegistry(): { registry: SubscriptionRegistry; delivered: string[] } {
  const delivered: string[] = [];
  const notifier = {
    toolsChanged: () => {},
    promptsChanged: () => {},
    resourcesChanged: () => {},
    resourceUpdated: (uri: string) => delivered.push(uri)
  } as unknown as ServerNotifier;
  return { registry: new SubscriptionRegistry(notifier, { debounceMs: 0 }), delivered };
}

describe('SubscriptionRegistry: dropping oversized resource_updated uris', () => {
  it('delivers a uri exactly at the cap', () => {
    const { registry: reg, delivered } = freshRegistry();
    const uri = `r:${'a'.repeat(MAX_RESOURCE_URI_BYTES - 2)}`;
    expect(Buffer.byteLength(uri, 'utf8')).toBe(MAX_RESOURCE_URI_BYTES);
    reg.publish({ kind: 'resource_updated', uri });
    expect(delivered).toEqual([uri]);
  });

  it('drops a uri one byte over the cap, without delivering it', () => {
    const { registry: reg, delivered } = freshRegistry();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const uri = `r:${'a'.repeat(MAX_RESOURCE_URI_BYTES - 1)}`;
      expect(Buffer.byteLength(uri, 'utf8')).toBe(MAX_RESOURCE_URI_BYTES + 1);
      reg.publish({ kind: 'resource_updated', uri });
      expect(delivered).toEqual([]);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]![0]).toMatch(/dropped a resources\/updated notification/);
    } finally {
      spy.mockRestore();
    }
  });

  it('keeps delivering ordinary, short uris — an oversized one does not jam the registry', () => {
    const { registry: reg, delivered } = freshRegistry();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    reg.publish({ kind: 'resource_updated', uri: `r:${'a'.repeat(MAX_RESOURCE_URI_BYTES + 10)}` });
    reg.publish({ kind: 'resource_updated', uri: 'file:///a.txt' });
    reg.publish({ kind: 'resource_updated', uri: 'file:///b.txt' });
    expect(delivered.toSorted()).toEqual(['file:///a.txt', 'file:///b.txt']);
    vi.restoreAllMocks();
  });

  it('rate-limits the dropped-uri log line to once per window, then logs again after it passes', () => {
    vi.useFakeTimers();
    try {
      const { registry: reg } = freshRegistry();
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const big = 'x'.repeat(MAX_RESOURCE_URI_BYTES + 1);
      for (let i = 0; i < 5; i++) reg.publish({ kind: 'resource_updated', uri: `${big}${i}` });
      expect(spy).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(60_001);
      reg.publish({ kind: 'resource_updated', uri: big });
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it('leaves the pending-count cap (MAX_PENDING_EVENTS) doing its own job, unaffected by the size check', () => {
    // Not a change under test — a guard that the size cap above did not quietly
    // replace the count cap for ordinary, well-sized notifications.
    const { registry: reg, delivered } = freshRegistry();
    for (let i = 0; i < 1100; i++) reg.publish({ kind: 'resource_updated', uri: `file:///${i}.txt` });
    expect(delivered).toHaveLength(1100);
  });
});

describe('UpstreamAuthProvider.saveTokens: rejecting malformed tokens', () => {
  const identity = {
    serverName: 'saas',
    serverUrl: 'https://saas.example/mcp',
    oauth: { mode: 'dcr' as const, grant: 'authorization_code' as const, scopes: [] },
    externalUrl: 'https://hub.example/'
  };

  function provider(): { provider: UpstreamAuthProvider; store: AuthStore } {
    const store = new AuthStore(directory());
    return { provider: new UpstreamAuthProvider(identity, store), store };
  }

  it('rejects an access_token containing CR/LF, storing nothing and never echoing it', () => {
    const { provider: p, store } = provider();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      let thrown: Error | undefined;
      try {
        p.saveTokens({ access_token: 'POISON\r\nX-Injected-Header: evil-value', token_type: 'Bearer' } as never);
      } catch (error) {
        thrown = error as Error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect(thrown!.message).not.toContain('POISON');
      expect(thrown!.message).not.toContain('X-Injected-Header');
      expect(store.listUpstreamCredentials().saas).toBeUndefined();
      // A malformed token can still be a secret: the log names the field and
      // the length, never the value.
      expect(spy).toHaveBeenCalledTimes(1);
      const line = String(spy.mock.calls[0]![0]);
      expect(line).toContain('access_token');
      expect(line).not.toContain('POISON');
      expect(line).not.toContain('X-Injected-Header');
    } finally {
      spy.mockRestore();
    }
  });

  it('rejects a refresh_token containing whitespace, storing nothing', () => {
    const { provider: p, store } = provider();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => p.saveTokens({ access_token: 'fine', token_type: 'Bearer', refresh_token: 'has a space' } as never)).toThrow(
        /malformed refresh_token/
      );
      expect(store.listUpstreamCredentials().saas).toBeUndefined();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('accepts a token exactly 16 KiB long', () => {
    const { provider: p } = provider();
    const token = 'a'.repeat(16 * 1024);
    expect(() => p.saveTokens({ access_token: token, token_type: 'Bearer' } as never)).not.toThrow();
    expect(p.storedTokens()?.access_token).toBe(token);
  });

  it('rejects a token one byte past 16 KiB, leaving a previously stored good token untouched', () => {
    const { provider: p } = provider();
    const good = 'a'.repeat(16 * 1024);
    p.saveTokens({ access_token: good, token_type: 'Bearer' } as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => p.saveTokens({ access_token: 'a'.repeat(16 * 1024 + 1), token_type: 'Bearer' } as never)).toThrow();
      expect(p.storedTokens()?.access_token).toBe(good);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('leaves an ordinary token pair unchanged — the legitimate flow this must not break', () => {
    const { provider: p } = provider();
    p.saveTokens({ access_token: 'access-1', token_type: 'Bearer', refresh_token: 'refresh-1', expires_in: 3600 } as never);
    expect(p.tokens()).toMatchObject({ access_token: 'access-1' });
    expect(p.storedTokens()).toMatchObject({ access_token: 'access-1', refresh_token: 'refresh-1' });
  });

  it('stores a registration access token only when it could be sent as a header', () => {
    const { provider: p, store } = provider();
    p.saveClientInformation({ client_id: 'c1', registration_access_token: 'bad\r\ntoken', registration_client_uri: 'https://as.example/reg/c1' });
    expect(store.listUpstreamCredentials().saas?.registrationAccessToken).toBeUndefined();
    expect(store.listUpstreamCredentials().saas?.clientId).toBe('c1');
    p.saveClientInformation({ client_id: 'c1', registration_access_token: 'good-token', registration_client_uri: 'https://as.example/reg/c1' });
    expect(store.listUpstreamCredentials().saas?.registrationAccessToken).toBe('good-token');
  });

  it('treats a token record written without validation (a stale format, or another process) as absent, not as trusted', () => {
    const { provider: p, store } = provider();
    // Bypasses saveTokens entirely — simulates a record written directly by
    // another process, or a stale on-disk format that predates validation.
    // The fingerprint must match what the provider itself computes for
    // `identity`, or getUpstreamCredentials() discards the record before
    // saveTokens's own validation is ever reached.
    store.updateUpstreamCredentials('saas', current => ({
      ...(current ?? { fingerprint: credentialFingerprint(identity), obtainedAt: 0 }),
      tokens: { access_token: 'bad\r\ntoken', token_type: 'Bearer' } as never
    }));
    expect(p.tokens()).toBeUndefined();
    expect(p.storedTokens()).toBeUndefined();
  });
});

describe('a malicious authorization server cannot poison the hub with a CRLF token, end-to-end', () => {
  interface Recorded {
    path: string;
    body: Record<string, string>;
  }

  interface FakeAuthServer {
    base: () => string;
    requests: Recorded[];
    setTokenResponse: (build: () => Record<string, unknown>) => void;
    close: () => Promise<void>;
  }

  async function startFakeAuthServer(): Promise<FakeAuthServer> {
    const app = express();
    const requests: Recorded[] = [];
    let tokenResponse: () => Record<string, unknown> = defaultTokenResponse;
    let server: ReturnType<express.Express['listen']>;
    const base = (): string => `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;

    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));
    app.get('/.well-known/oauth-authorization-server', (_req, res) => {
      res.json({
        issuer: base(),
        authorization_endpoint: `${base()}/authorize`,
        token_endpoint: `${base()}/token`,
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'none']
      });
    });
    app.post('/token', (req, res) => {
      requests.push({ path: req.path, body: { ...req.body } });
      res.json(tokenResponse());
    });

    await new Promise<void>(resolve => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    return {
      base,
      requests,
      setTokenResponse: build => {
        tokenResponse = build;
      },
      close: () => new Promise<void>(resolve => server.close(() => resolve()))
    };
  }

  function clientCredentialsAuth(as: FakeAuthServer): UpstreamAuth {
    const config: RemoteServerConfig = {
      kind: 'remote',
      transport: 'http',
      url: `${as.base()}/mcp`,
      headers: {},
      hub: true,
      oauth: { mode: 'static', clientId: 'cc-client', grant: 'client_credentials', scopes: [] }
    };
    return new UpstreamAuth('saas', config, new AuthStore(directory()), 'http://localhost/');
  }

  let as: FakeAuthServer;
  beforeAll(async () => {
    as = await startFakeAuthServer();
  });
  afterAll(async () => {
    await as.close();
  });

  it('a CRLF-poisoned access_token fails authorization instead of being stored', async () => {
    as.setTokenResponse(() => ({ access_token: 'POISON\r\nX-Injected-Header: evil-value', token_type: 'Bearer' }));
    const auth = clientCredentialsAuth(as);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      let thrown: Error | undefined;
      try {
        await auth.prepare({ force: true });
      } catch (error) {
        thrown = error as Error;
      }
      // The same failure class as any other unusable credential — not a raw
      // TypeError, and not the token itself.
      expect(thrown).toBeInstanceOf(UpstreamLoginRequiredError);
      expect(thrown!.message).not.toContain('POISON');
      expect(thrown!.message).not.toContain('X-Injected-Header');
      // send() never got a token to build a header from, because nothing was
      // ever persisted — so a subsequent data-plane call cannot repeat the
      // original bug (Headers.set() throwing with the raw value inside it).
      vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })));
      const guarded = auth.createFetch();
      const response = await guarded(`${as.base()}/mcp`, { method: 'POST', body: '{}' });
      expect(response.status).toBe(200);
      const sentHeaders = (vi.mocked(fetch).mock.calls[0]![1] as RequestInit).headers as Headers;
      expect(new Headers(sentHeaders).has('authorization')).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('an ordinary token response keeps working — the legitimate client_credentials flow', async () => {
    as.setTokenResponse(() => ({ access_token: 'clean-access-token', token_type: 'Bearer', expires_in: 3600 }));
    const auth = clientCredentialsAuth(as);
    await expect(auth.prepare({ force: true })).resolves.toBeUndefined();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })));
    const guarded = auth.createFetch();
    await guarded(`${as.base()}/mcp`, { method: 'POST', body: '{}' });
    const sentHeaders = new Headers((vi.mocked(fetch).mock.calls[0]![1] as RequestInit).headers);
    expect(sentHeaders.get('authorization')).toBe('Bearer clean-access-token');
  });
});
