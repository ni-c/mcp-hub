import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { CallToolResult } from '@modelcontextprotocol/client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { mintApiToken } from '../src/auth/api-tokens.js';
import { base32Encode } from '../src/auth/totp.js';
import { createHub } from '../src/index.js';
import { totpCode } from './auth-flow.js';

const EVERYTHING = path.resolve('node_modules/@modelcontextprotocol/server-everything/dist/index.js');
const ORIGIN = 'http://localhost:3000';
const PASSWORD = 'test-password';
const SECRET = base32Encode(Buffer.from('unlock-pages-test-key'));

type Hub = Awaited<ReturnType<typeof createHub>>;
let dir: string;
let hub: Hub;
let baseUrl: string;
let listen: ReturnType<Hub['app']['listen']>;
let caller: { token: string; clientId: string };
let warn: { mock: { calls: unknown[][] }; mockRestore(): void };
const app = () => hub.app as Parameters<typeof request>[0];
const warnings = () => warn.mock.calls.map((call: unknown[]) => String(call[0]));

let clock = Date.UTC(2026, 10, 3, 9, 0, 15);
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  clock += 120_000;
  vi.setSystemTime(clock);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
  vi.useRealTimers();
});

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-unlock-pages-'));
  const configPath = path.join(dir, 'mcp.json');
  fs.writeFileSync(configPath, JSON.stringify({ mcpServers: { box: { command: process.execPath, args: [EVERYTHING], unlock: { tools: ['get-sum'], maxMinutes: 60 } } } }));
  hub = await createHub({ externalUrl: ORIGIN, configPath, dataPath: path.join(dir, 'data'), password: PASSWORD, twoFactor: 'totp', totpSecret: SECRET, idleTimeoutMinutes: 0 });
  await hub.supervisor.waitUntilSettled();
  listen = hub.app.listen(0);
  baseUrl = `http://127.0.0.1:${(listen.address() as AddressInfo).port}`;
}, 30_000);

afterAll(async () => {
  listen?.close();
  hub?.stopMaintenance();
  hub?.watcher.stop();
  await hub?.supervisor.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Each test asks as a client of its own, so open requests of earlier tests do not count against it. */
async function freshCaller(): Promise<void> {
  const minted = await mintApiToken(hub.store, ORIGIN, new URL('/box/mcp', ORIGIN), 1, 'pages');
  caller = { token: minted.token, clientId: `token:${minted.id}` };
}
beforeEach(async () => {
  if (hub) await freshCaller();
});

async function callSum(args: Record<string, unknown>): Promise<CallToolResult> {
  const client = new Client({ name: 'vitest', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/box/mcp`), { requestInit: { headers: { Authorization: `Bearer ${caller.token}` } } }));
  try {
    return (await client.callTool({ name: 'get-sum', arguments: args })) as CallToolResult;
  } finally {
    await client.close();
  }
}

const text = (result: CallToolResult) => result.content.map(part => ('text' in part ? part.text : '')).join('\n');

/** A fresh ask; returns the page path and what the form needs. */
async function ask(args: Record<string, unknown> = { a: Math.random(), b: 1 }) {
  const answer = text(await callSum(args));
  const link = /http:\/\/localhost:3000(\/unlock\/r\/[\w-]+)/.exec(answer)?.[1];
  if (!link) throw new Error(`no link in: ${answer}`);
  const page = await request(app()).get(link);
  const csrf = /name="csrf" value="([^"]+)"/.exec(page.text)?.[1] ?? '';
  return { link, page, csrf, code: /\b([A-Z2-9]{3}-[A-Z2-9]{3})\b/.exec(answer)?.[1] };
}

const unlock = (link: string, fields: Record<string, string>) => request(app()).post(link).type('form').send(fields);

describe('the unlock page', () => {
  it('shows what asked, from the hub record, and no script', async () => {
    const { page, code } = await ask({ a: 2, b: '<b>3</b>' });
    expect(page.status).toBe(200);
    expect(page.headers['cache-control']).toContain('no-store');
    expect(page.headers['x-frame-options']).toBe('DENY');
    expect(page.headers['referrer-policy']).toBe('no-referrer');
    expect(page.text).not.toMatch(/<script/i);
    expect(page.text).toContain(code);
    expect(page.text).toContain('<h1>Unlock "box"?</h1>');
    expect(page.text).toContain('{&#34;a&#34;:2,&#34;b&#34;:&#34;&#60;b&#62;3&#60;/b&#62;&#34;}');
    expect(page.text).toContain('written by the model');
    expect(page.text).toMatch(/<option value="once">Only this call<\/option><option value="15">15 minutes<\/option><option value="30" selected>30 minutes<\/option><option value="60">1 hour<\/option><\/select>/);
    expect(page.text).toContain('autocomplete="current-password"');
    expect(page.text).toContain('autocomplete="one-time-code"');
  });

  it('answers 404 for a link it does not know', async () => {
    expect((await request(app()).get('/unlock/r/nope')).status).toBe(404);
  });

  it('refuses a post without the form token', async () => {
    const { link } = await ask();
    expect((await unlock(link, { action: 'unlock', duration: '30', password: PASSWORD, code: totpCode(SECRET) })).status).toBe(403);
  });

  it('refuses wrong factors and logs them apart, without unlocking', async () => {
    const { link, csrf } = await ask();
    const wrongPassword = await unlock(link, { csrf, action: 'unlock', duration: '30', password: 'nope', code: totpCode(SECRET) });
    const wrongCode = await unlock(link, { csrf, action: 'unlock', duration: '30', password: PASSWORD, code: '000000' });
    for (const res of [wrongPassword, wrongCode]) {
      expect(res.status).toBe(401);
      expect(res.text).toContain('Wrong password or code');
    }
    expect(warnings()).toEqual(['mcp-hub: authentication failure from ::ffff:127.0.0.1', 'mcp-hub: second-factor failure from ::ffff:127.0.0.1'].map(line => line.replace('::ffff:', '')));
    expect(hub.store.unlockGrants()).toEqual([]);
  });

  it('refuses a duration the server does not offer', async () => {
    const { link, csrf } = await ask();
    for (const duration of ['240', '0', 'forever', '']) {
      expect((await unlock(link, { csrf, action: 'unlock', duration, password: PASSWORD, code: totpCode(SECRET) })).status).toBe(400);
    }
  });

  it('unlocks for the chosen window, for the caller that asked, and the call runs', async () => {
    const { link, csrf } = await ask({ a: 20, b: 22 });
    const res = await unlock(link, { csrf, action: 'unlock', duration: '15', password: PASSWORD, code: totpCode(SECRET) });
    expect(res.status).toBe(200);
    expect(res.text).toContain('&#34;box&#34; is unlocked for 15 minutes');
    expect(res.text).toContain('Lock now');
    const [grant] = hub.store.unlockGrants();
    expect(grant).toMatchObject({ server: 'box', clientId: caller.clientId, kind: 'window', expiresAt: clock + 15 * 60_000, by: 'page' });
    expect(text(await callSum({ a: 20, b: 22 }))).toContain('42');
    expect((await request(app()).get(link)).text).toContain('Already unlocked');
    hub.store.revokeUnlockGrants({});
  });

  it('unlocks a single call that runs once', async () => {
    const { link, csrf } = await ask({ a: 7, b: 8 });
    expect((await unlock(link, { csrf, action: 'unlock', duration: 'once', password: PASSWORD, code: totpCode(SECRET) })).status).toBe(200);
    expect(text(await callSum({ b: 8, a: 7 }))).toContain('15');
    expect((await callSum({ a: 7, b: 8 })).isError).toBe(true);
  });

  it('denies without factors, and the model hears it on its next try', async () => {
    const args = { a: 1, b: 99 };
    const { link, csrf } = await ask(args);
    const res = await unlock(link, { csrf, action: 'deny' });
    expect(res.status).toBe(200);
    expect(res.text).toContain('stays locked');
    expect(text(await callSum(args))).toContain('denied unlocking server "box"');
  });
});

describe('the unlocks overview', () => {
  it('signs in with the factors and reveals nothing before that', async () => {
    const page = await request(app()).get('/unlock');
    expect(page.status).toBe(200);
    expect(page.text).not.toMatch(/value="box"|>box</);
    const wrong = await request(app()).post('/unlock').type('form').send({ password: PASSWORD, code: '000000' });
    expect(wrong.status).toBe(401);
    expect(wrong.text).not.toMatch(/value="box"|>box</);
  });

  it('lists open requests to decide on, unlocks ahead of a call, and locks again', async () => {
    const { code } = await ask({ a: 3, b: 4 });
    hub.store.saveApproval('approved-client', 'http://localhost:1/cb', 'Approved Client', []);
    const signedIn = await request(app()).post('/unlock').type('form').send({ password: PASSWORD, code: totpCode(SECRET) });
    expect(signedIn.status).toBe(200);
    expect(signedIn.text).toContain(code);
    const ticket = /name="ticket" value="([^"]+)"/.exec(signedIn.text)![1];
    const requestId = hub.unlockRuntime.pending().find(open => open.code === code)!.id;
    expect(signedIn.text).toContain(`name="request" value="${requestId}"`);

    const decided = await request(app()).post('/unlock/decide').type('form').send({ ticket, request: requestId, action: 'unlock', duration: '30' });
    expect(decided.text).toContain('is unlocked for 30 minutes');
    expect(text(await callSum({ a: 3, b: 4 }))).toContain('7');

    const ahead = await request(app()).post('/unlock/grant').type('form').send({ ticket, server: 'box', client: 'approved-client', duration: '60' });
    expect(ahead.text).toContain('for every authorization of that client');
    const wide = hub.store.unlockGrants().find(grant => grant.clientId === 'approved-client');
    expect(wide?.kind).toBe('window');
    expect(wide).not.toHaveProperty('grantId');

    for (const grant of hub.store.unlockGrants()) {
      const locked = await request(app()).post('/unlock/lock').type('form').send({ ticket, grant: grant.id });
      expect(locked.text).toContain('Locked again.');
    }
    expect(hub.store.unlockGrants()).toEqual([]);
    expect((await callSum({ a: 3, b: 4 })).isError).toBe(true);
  });

  it('refuses dashboard actions without a live ticket', async () => {
    for (const action of ['/unlock/decide', '/unlock/grant', '/unlock/lock']) {
      const res = await request(app()).post(action).type('form').send({ ticket: 'forged' });
      expect(res.status).toBe(401);
    }
    const signedIn = await request(app()).post('/unlock').type('form').send({ password: PASSWORD, code: totpCode(SECRET) });
    const ticket = /name="ticket" value="([^"]+)"/.exec(signedIn.text)?.[1] ?? '';
    vi.setSystemTime(clock + 5 * 60_000);
    expect((await request(app()).post('/unlock/lock').type('form').send({ ticket, grant: 'x' })).status).toBe(401);
  });
});
