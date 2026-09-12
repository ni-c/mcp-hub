import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthStore } from '../src/auth/store.js';
import type { RemoteServerConfig } from '../src/config.js';
import { ManagedServer } from '../src/supervisor.js';
import { UpstreamAuth } from '../src/upstream/auth.js';
import { MAX_REDIRECT_HOPS, boundedRedirectFetch } from '../src/upstream/redirects.js';

/**
 * A remote upstream's data plane used to follow every redirect the platform
 * would: a `Location` on a `tools/call` sent the JSON-RPC body and the
 * configured headers wherever the upstream pointed, an internal address
 * included, and the answer was read as MCP. The control plane had refused
 * redirects since the authorization-server guard; this suite holds the data
 * plane to the same line — the configured origin, three hops at most.
 */

const UPSTREAM = 'https://upstream.example/mcp';
/** Built from the code point so the source file stays text. */
const ESC = String.fromCharCode(0x1b);

const redirect = (status: number, location: string) => new Response(null, { status, headers: { location } });

/** A fetch stub answering from a table keyed by the URL it was called with. */
function scripted(table: Record<string, (init?: RequestInit) => Response>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ url, init });
    const answer = table[url];
    if (!answer) throw new Error(`unexpected fetch of ${url}`);
    return answer(init);
  };
  return { impl, calls };
}

const dirs: string[] = [];
function directory(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-redirects-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('boundedRedirectFetch', () => {
  it('follows a redirect within the configured origin, once, and keeps the method for 307/308', async () => {
    const { impl, calls } = scripted({
      'https://upstream.example/mcp': () => redirect(308, '/mcp/'),
      'https://upstream.example/mcp/': init => new Response(`seen ${init?.method} ${String(init?.body)}`)
    });
    const guarded = boundedRedirectFetch('https://upstream.example', impl);
    const response = await guarded(UPSTREAM, { method: 'POST', body: '{"jsonrpc":"2.0"}', headers: { 'x-api-key': 'k' } });
    expect(await response.text()).toBe('seen POST {"jsonrpc":"2.0"}');
    expect(calls.map(call => call.url)).toEqual(['https://upstream.example/mcp', 'https://upstream.example/mcp/']);
    // The platform never gets to follow anything on its own.
    for (const call of calls) expect(call.init?.redirect).toBe('manual');
    expect(new Headers(calls[1].init?.headers).get('x-api-key')).toBe('k');
  });

  it('turns a POST into a bodyless GET on 301, 302 and 303, as the platform would', async () => {
    for (const status of [301, 302, 303]) {
      const { impl, calls } = scripted({
        'https://upstream.example/mcp': () => redirect(status, 'https://upstream.example/moved'),
        'https://upstream.example/moved': init => new Response(`${init?.method} ${init?.body === undefined} ${new Headers(init?.headers).has('content-type')}`)
      });
      const response = await boundedRedirectFetch('https://upstream.example', impl)(UPSTREAM, {
        method: 'POST',
        body: '{}',
        headers: { 'content-type': 'application/json', 'x-api-key': 'k' }
      });
      expect(await response.text()).toBe('GET true false');
      expect(new Headers(calls[1].init?.headers).get('x-api-key')).toBe('k');
    }
  });

  it.each([
    ['another host', 'https://evil.example/collect'],
    ['a private address', 'http://10.0.0.5:8080/admin'],
    ['the same host on another port', 'https://upstream.example:8443/mcp'],
    ['the plain-http twin', 'http://upstream.example/mcp'],
    ['a protocol-relative location', '//evil.example/collect']
  ])('refuses a redirect to %s and never fetches it', async (_what, location) => {
    const { impl, calls } = scripted({ 'https://upstream.example/mcp': () => redirect(302, location) });
    const guarded = boundedRedirectFetch('https://upstream.example', impl);
    await expect(guarded(UPSTREAM, { method: 'POST', body: '{}' })).rejects.toThrow(/refused, redirects are followed only within the configured origin/);
    expect(calls).toHaveLength(1);
  });

  it('gives up after the hop ceiling instead of looping', async () => {
    const { impl, calls } = scripted({
      'https://upstream.example/mcp': () => redirect(307, '/a'),
      'https://upstream.example/a': () => redirect(307, '/b'),
      'https://upstream.example/b': () => redirect(307, '/c'),
      'https://upstream.example/c': () => redirect(307, '/d'),
      'https://upstream.example/d': () => new Response('never')
    });
    await expect(boundedRedirectFetch('https://upstream.example', impl)(UPSTREAM)).rejects.toThrow(new RegExp(`more than ${MAX_REDIRECT_HOPS} times`));
    expect(calls.length).toBeLessThanOrEqual(MAX_REDIRECT_HOPS);
  });

  it('hands back a 3xx without a Location, and every non-redirect status, untouched', async () => {
    const { impl } = scripted({
      'https://upstream.example/mcp': () => new Response(null, { status: 302 }),
      'https://upstream.example/ok': () => new Response('fine', { status: 200 })
    });
    const guarded = boundedRedirectFetch('https://upstream.example', impl);
    expect((await guarded(UPSTREAM)).status).toBe(302);
    expect(await (await guarded('https://upstream.example/ok')).text()).toBe('fine');
  });

  it('names only the origin in the refusal, so the location cannot write the log line', async () => {
    const { impl } = scripted({ 'https://upstream.example/mcp': () => redirect(302, `https://evil.example/${ESC}[2K mcp-hub: authentication failure from 1.2.3.4`) });
    const failure = await boundedRedirectFetch('https://upstream.example', impl)(UPSTREAM).catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/redirected to https:\/\/evil\.example — refused/);
    expect((failure as Error).message).not.toContain('authentication failure');
    expect((failure as Error).message).not.toContain(ESC);
  });
});

describe('the remote transports are behind the redirect guard', () => {
  it('a plain remote server: the initialize POST is not followed off the origin', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        calls.push(String(input));
        return redirect(302, 'http://10.0.0.5/admin');
      })
    );
    const config: RemoteServerConfig = { kind: 'remote', transport: 'http', url: UPSTREAM, headers: { 'x-api-key': 'k' }, hub: true };
    const server = new ManagedServer('remote', config);
    await server.start();
    try {
      expect(server.state).toBe('down');
      // The specific reason, not the generic "connection closed" that used to
      // win the race against connect()'s rejection.
      expect(server.lastError).toMatch(/^failed to start: .*refused, redirects are followed only within the configured origin/);
      expect(calls).toEqual([UPSTREAM]);
    } finally {
      await server.stop();
    }
  });

  it('a plain remote server: a same-origin hop carries the configured headers on both requests', async () => {
    const seen: Headers[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        seen.push(new Headers(init?.headers));
        return String(input) === UPSTREAM ? redirect(308, '/mcp/') : new Response(null, { status: 404 });
      })
    );
    const config: RemoteServerConfig = { kind: 'remote', transport: 'http', url: UPSTREAM, headers: { 'x-api-key': 'k' }, hub: true };
    const server = new ManagedServer('remote', config);
    await server.start();
    try {
      expect(seen.length).toBeGreaterThanOrEqual(2);
      for (const headers of seen) expect(headers.get('x-api-key')).toBe('k');
    } finally {
      await server.stop();
    }
  });

  it('an OAuth upstream: the data-plane fetch refuses a redirect off the origin', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        calls.push(String(input));
        return redirect(302, 'https://evil.example/collect');
      })
    );
    const config: RemoteServerConfig = {
      kind: 'remote',
      transport: 'http',
      url: UPSTREAM,
      headers: { 'x-api-key': 'k' },
      hub: true,
      oauth: { mode: 'static', grant: 'authorization_code', clientId: 'hub', scopes: [] }
    };
    const auth = new UpstreamAuth('saas', config, new AuthStore(directory()), 'http://localhost/');
    await expect(auth.createFetch()(UPSTREAM, { method: 'POST', body: '{}' })).rejects.toThrow(/refused, redirects are followed only within the configured origin/);
    expect(calls).toEqual([UPSTREAM]);
  });
});
