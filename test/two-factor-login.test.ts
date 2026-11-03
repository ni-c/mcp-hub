import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createHub } from '../src/index.js';
import type { HubOptions } from '../src/index.js';
import { createSessionCookie, readSessionCookie } from '../src/auth/session.js';
import { base32Encode } from '../src/auth/totp.js';
import { authorizeInBrowser, pkcePair, registerPublicClient, totpCode } from './auth-flow.js';

const PASSWORD = 'test-password';
const SECRET = base32Encode(Buffer.from('two-factor-login-key')); // 20 bytes
const REDIRECT_URI = 'http://localhost:33418/callback';
const EXTERNAL_URL = 'http://localhost:3000';
const RESOURCE = `${EXTERNAL_URL}/hub`;

type Hub = Awaited<ReturnType<typeof createHub>>;

/** Every test runs two minutes after the previous one, so each gets one-time codes of its own. */
let clock = Date.UTC(2026, 10, 3, 12, 0, 15);
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  clock += 120_000;
  vi.setSystemTime(clock);
});
afterEach(() => {
  vi.useRealTimers();
});

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

async function startHub(options: Partial<HubOptions> = {}, dataDir?: string): Promise<{ hub: Hub; dataPath: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-2fa-'));
  dirs.push(dir);
  const configPath = path.join(dir, 'mcp.json');
  fs.writeFileSync(configPath, JSON.stringify({ mcpServers: {} }));
  const dataPath = dataDir ?? path.join(dir, 'data');
  const hub = await createHub({ externalUrl: EXTERNAL_URL, configPath, dataPath, password: PASSWORD, idleTimeoutMinutes: 0, ...options });
  return { hub, dataPath };
}

async function stopHub(hub: Hub): Promise<void> {
  hub.stopMaintenance();
  hub.watcher.stop();
  await hub.supervisor.stop();
}

/** Follows /authorize to the login page and returns what a browser would hold there. */
async function openLoginPage(hub: Hub) {
  const clientId = await registerPublicClient(hub.app, REDIRECT_URI);
  const agent = request.agent(hub.app);
  const { challenge } = pkcePair();
  let location = `/authorize?${new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'xyz',
    resource: RESOURCE
  })}`;
  for (let hop = 0; hop < 6; hop++) {
    const res = await agent.get(location).redirects(0);
    if (/name="request"/.test(res.text ?? '')) {
      const uid = /name="request" value="([^"]+)"/.exec(res.text)?.[1];
      if (!uid) throw new Error(`no login form at ${location}`);
      const post = (fields: Record<string, string>) =>
        agent
          .post(`${location.split('?')[0]}login`)
          .type('form')
          .send({ request: uid, ...fields })
          .redirects(0);
      return { html: res.text, status: res.status, post };
    }
    const next = res.headers.location as string | undefined;
    if (!next) throw new Error(`stalled at ${location}: ${res.status} ${res.text.slice(0, 200)}`);
    location = next.startsWith('http') ? `${new URL(next).pathname}${new URL(next).search}` : next;
  }
  throw new Error('the login page never came');
}

async function exchange(hub: Hub | string, clientId: string, code: string, verifier: string) {
  return request(typeof hub === 'string' ? hub : (hub.app as Parameters<typeof request>[0]))
    .post('/token')
    .type('form')
    .send({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT_URI, resource: RESOURCE });
}

describe('two-factor login on', () => {
  let hub: Hub;
  let warn: { mock: { calls: unknown[][] }; mockRestore(): void };
  const warnings = () => warn.mock.calls.map((call: unknown[]) => String(call[0]));

  beforeAll(async () => {
    ({ hub } = await startHub({ twoFactor: 'totp', totpSecret: SECRET }));
  });
  afterAll(async () => {
    await stopHub(hub);
  });
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it('asks for the code next to the password, the way an authenticator can fill it in', async () => {
    const { html, status } = await openLoginPage(hub);
    expect(status).toBe(200);
    expect(html).toContain('name="password"');
    expect(html).toMatch(/<input type="text" name="code" [^>]*autocomplete="one-time-code" inputmode="numeric"/);
  });

  it('signs in with password and code, and the tokens record that a code was given', async () => {
    const clientId = await registerPublicClient(hub.app, REDIRECT_URI);
    const { code, verifier } = await authorizeInBrowser(hub.app, clientId, { password: PASSWORD, redirectUri: REDIRECT_URI, resource: RESOURCE, totpSecret: SECRET });
    const tokens = await exchange(hub, clientId, code, verifier);
    expect(tokens.status).toBe(200);
    expect(hub.store.oidcFind('RefreshToken', tokens.body.refresh_token)?.amr).toEqual(['pwd', 'otp', 'mfa']);
  });

  it('answers a wrong code and a wrong password alike, and logs them apart', async () => {
    const wrongCode = await (await openLoginPage(hub)).post({ password: PASSWORD, code: '000000' });
    const wrongPassword = await (await openLoginPage(hub)).post({ password: 'nope', code: totpCode(SECRET) });
    for (const res of [wrongCode, wrongPassword]) {
      expect(res.status).toBe(401);
      expect(res.text).toContain('Wrong password or code');
      expect(res.text).toContain('name="code"');
    }
    expect(warnings()).toEqual(['mcp-hub: second-factor failure from 127.0.0.1', 'mcp-hub: authentication failure from 127.0.0.1']);
  });

  it('refuses a missing code', async () => {
    const res = await (await openLoginPage(hub)).post({ password: PASSWORD });
    expect(res.status).toBe(401);
    expect(res.text).toContain('Wrong password or code');
  });

  it('takes a code once', async () => {
    const code = totpCode(SECRET);
    expect((await (await openLoginPage(hub)).post({ password: PASSWORD, code })).status).toBe(303);
    const again = await (await openLoginPage(hub)).post({ password: PASSWORD, code });
    expect(again.status).toBe(401);
    expect(again.text).toContain('This code was already used. Wait for the next one.');
  });

  it('pauses after the fifth wrong code and says when to try again', async () => {
    for (let i = 0; i < 5; i++) await (await openLoginPage(hub)).post({ password: PASSWORD, code: '000000' });
    const paused = await (await openLoginPage(hub)).post({ password: PASSWORD, code: totpCode(SECRET) });
    expect(paused.status).toBe(429);
    expect(paused.headers['retry-after']).toBe('30');
    expect(paused.text).toContain('Too many attempts. Try again in 30 seconds.');
  });
});

describe('two-factor login on without a usable secret', () => {
  it('keeps everyone out, and says why at boot and on the page', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { hub } = await startHub({ twoFactor: 'totp', totpSecret: 'too-short' });
      try {
        expect(warn.mock.calls.map(call => String(call[0]))).toContain(
          'mcp-hub: TWO_FACTOR=totp but TOTP_SECRET is not Base32 (A–Z and 2–7, spaces and padding allowed) — the operator login is disabled, no client can be approved'
        );
        const page = await openLoginPage(hub);
        expect(page.status).toBe(503);
        expect(page.html).toContain('two-factor login is on, but this hub has no usable TOTP secret configured');
        const res = await page.post({ password: PASSWORD, code: '123456' });
        expect(res.status).toBe(503);
        expect(res.text).toContain('two-factor login is on, but this hub has no usable TOTP secret configured');
      } finally {
        await stopHub(hub);
      }
    } finally {
      warn.mockRestore();
    }
  });
});

describe('two-factor login off', () => {
  it('asks for the password alone, as before', async () => {
    const { hub } = await startHub();
    try {
      const { html } = await openLoginPage(hub);
      expect(html).not.toContain('name="code"');
      const clientId = await registerPublicClient(hub.app, REDIRECT_URI);
      const { code, verifier } = await authorizeInBrowser(hub.app, clientId, { password: PASSWORD, redirectUri: REDIRECT_URI, resource: RESOURCE });
      const tokens = await exchange(hub, clientId, code, verifier);
      expect(tokens.status).toBe(200);
      expect(hub.store.oidcFind('RefreshToken', tokens.body.refresh_token)?.amr).toEqual(['pwd']);
      const wrong = await (await openLoginPage(hub)).post({ password: 'nope' });
      expect(wrong.text).toContain('Wrong password');
      expect(wrong.text).not.toContain('or code');
    } finally {
      await stopHub(hub);
    }
  });
});

describe('switching two-factor login', () => {
  it('announces the change at the next start, in both directions', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const first = await startHub();
      await stopHub(first.hub);
      expect(warn.mock.calls.flat().join('\n')).not.toContain('switched');

      const second = await startHub({ twoFactor: 'totp', totpSecret: SECRET }, first.dataPath);
      await stopHub(second.hub);
      expect(warn.mock.calls.flat()).toContain('mcp-hub: two-factor login was switched on since the last start — sessions and refresh tokens from sign-ins without a code are no longer accepted, so every connector signs in once more');
      expect(log.mock.calls.flat()).toContain('mcp-hub: two-factor login is on — every sign-in needs the password and a TOTP code');

      const third = await startHub({}, first.dataPath);
      await stopHub(third.hub);
      expect(warn.mock.calls.flat()).toContain('mcp-hub: two-factor login was switched off since the last start — the password alone signs in again');
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
  });
});

describe('sign-ins from before two-factor login was switched on', () => {
  it('stop counting: their refresh tokens, codes and browser sessions all need a code now', async () => {
    let current: Hub | undefined;
    const server = http.createServer((req, res) => {
      (current!.app as unknown as http.RequestListener)(req, res);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const off = await startHub();
      current = off.hub;
      const agent = request.agent(base);
      const clientId = await registerPublicClient(base, REDIRECT_URI);
      const signIn = { password: PASSWORD, redirectUri: REDIRECT_URI, resource: RESOURCE, agent };
      const first = await authorizeInBrowser(base, clientId, signIn);
      const tokens = await exchange(base, clientId, first.code, first.verifier);
      expect(tokens.status).toBe(200);
      const reused = await authorizeInBrowser(base, clientId, signIn);
      expect(reused.pages).toEqual([]); // the browser session alone gets a code while the second factor is off
      await stopHub(off.hub);

      const on = await startHub({ twoFactor: 'totp', totpSecret: SECRET }, off.dataPath);
      current = on.hub;
      try {
        const refreshed = await request(base)
          .post('/token')
          .type('form')
          .send({ grant_type: 'refresh_token', refresh_token: tokens.body.refresh_token, client_id: clientId, resource: RESOURCE });
        expect(refreshed.status).toBe(400);
        expect(refreshed.body.error).toBe('invalid_grant');

        const pending = await exchange(base, clientId, reused.code, reused.verifier);
        expect(pending.status).toBe(400);
        expect(pending.body.error).toBe('invalid_grant');

        const again = await authorizeInBrowser(base, clientId, { ...signIn, totpSecret: SECRET });
        expect(again.pages.some(page => page.includes('name="code"'))).toBe(true);
        const fresh = await exchange(base, clientId, again.code, again.verifier);
        expect(fresh.status).toBe(200);
        const rotated = await request(base)
          .post('/token')
          .type('form')
          .send({ grant_type: 'refresh_token', refresh_token: fresh.body.refresh_token, client_id: clientId, resource: RESOURCE });
        expect(rotated.status).toBe(200);
      } finally {
        await stopHub(on.hub);
      }
    } finally {
      server.close();
    }
  });
});

const sessionHeader = (value: string) => `mcp_hub_session=${encodeURIComponent(value)}`;

describe('the operator session cookie', () => {
  const secret = 'cookie-secret';
  const header = sessionHeader;

  it('reads as before while two-factor login is off', () => {
    const value = createSessionCookie(secret);
    expect(readSessionCookie(header(value), secret)).toBe(value);
    expect(readSessionCookie(header(value), secret, false, '')).toBe(value);
  });

  it('does not survive a change of the two-factor mode, in either direction', () => {
    const plain = createSessionCookie(secret);
    const scoped = createSessionCookie(secret, 'totp');
    expect(readSessionCookie(header(scoped), secret, false, 'totp')).toBe(scoped);
    expect(readSessionCookie(header(plain), secret, false, 'totp')).toBeUndefined();
    expect(readSessionCookie(header(scoped), secret, false, '')).toBeUndefined();
  });
});
