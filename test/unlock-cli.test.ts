import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mintApiToken } from '../src/auth/api-tokens.js';
import { AuthStore } from '../src/auth/store.js';
import { parseConfig } from '../src/config.js';
import { planGrant } from '../src/unlock/cli.js';

const config = parseConfig(
  JSON.stringify({
    mcpServers: {
      ssh: { command: 'x', unlock: { maxMinutes: 120 } },
      once: { command: 'x', unlock: { maxMinutes: 0 } },
      free: { command: 'x' }
    }
  }),
  {}
);

let dir: string;
let store: AuthStore;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-unlock-cli-'));
  store = new AuthStore(dir);
  store.saveApproval('claude', 'http://localhost:1/cb', 'Claude', []);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const plan = (server?: string, minutes?: string, clientId?: string) => planGrant({ config, store, server, minutes, clientId, now: 1_000 });

describe('mcp-hub-admin unlock grant', () => {
  it('grants a window for every authorization of an approved client', () => {
    expect(plan('ssh', '30', 'claude')).toEqual({ server: 'ssh', clientId: 'claude', kind: 'window', grantedAt: 1_000, expiresAt: 1_000 + 30 * 60_000, by: 'cli' });
  });

  it('accepts an API token as the client', async () => {
    const minted = await mintApiToken(store, 'http://localhost:3000', new URL('http://localhost:3000/ssh/mcp'), 1, 'cli');
    expect(plan('ssh', '5', `token:${minted.id}`)).toMatchObject({ clientId: `token:${minted.id}` });
    expect(plan('ssh', '5', 'token:unknown')).toContain('No approved client or API token');
  });

  it.each([
    [undefined, '30', 'claude', 'Usage:'],
    ['ssh', undefined, 'claude', 'Usage:'],
    ['ssh', '30', undefined, 'Usage:'],
    ['ssh', '30', '', 'Usage:'],
    ['nope', '30', 'claude', 'is not configured'],
    ['free', '30', 'claude', 'is not locked'],
    ['ssh', '0', 'claude', 'from 1 to 120'],
    ['ssh', '121', 'claude', 'from 1 to 120'],
    ['ssh', '1.5', 'claude', 'from 1 to 120'],
    ['ssh', '-5', 'claude', 'from 1 to 120'],
    ['once', '5', 'claude', 'single calls only'],
    ['ssh', '30', 'stranger', 'No approved client']
  ])('refuses server %j, minutes %j, client %j', (server, minutes, clientId, message) => {
    expect(plan(server, minutes, clientId)).toContain(message);
  });
});
