// Renders the unlock page in both colour schemes for the docs: npm run build && npm run assets:unlock
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

import { mintApiToken } from '../dist/auth/api-tokens.js';
import { base32Encode } from '../dist/auth/totp.js';
import { createHub } from '../dist/index.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const chrome = process.env.CHROME_PATH ?? 'chromium';
const origin = 'http://localhost:3000';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-shots-'));
const configPath = path.join(dir, 'mcp.json');
fs.writeFileSync(
  configPath,
  JSON.stringify({
    mcpServers: { tickets: { command: process.execPath, args: [path.join(root, 'demo/servers/tickets.mjs')], unlock: { tools: ['create_ticket'], maxMinutes: 120 } } }
  })
);

const hub = await createHub({
  externalUrl: origin,
  configPath,
  dataPath: path.join(dir, 'data'),
  password: 'demo',
  twoFactor: 'totp',
  totpSecret: base32Encode(Buffer.from('screenshot-only-secret')),
  idleTimeoutMinutes: 0
});
await hub.supervisor.waitUntilSettled();
const listener = hub.app.listen(0);
const base = `http://127.0.0.1:${listener.address().port}`;
try {
  const { token } = await mintApiToken(hub.store, origin, new URL('/tickets/mcp', origin), 1, 'screenshots');
  const client = new Client({ name: 'Claude', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/tickets/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  const result = await client.callTool({ name: 'create_ticket', arguments: { title: 'Printer on the 3rd floor is jammed', priority: 'high' } });
  await client.close();
  const link = /\/unlock\/r\/[\w-]+/.exec(result.content.map(part => part.text ?? '').join(''))?.[0];
  if (!link) throw new Error('the locked call returned no link');
  for (const [scheme, flags] of [
    ['light', []],
    ['dark', ['--force-dark-mode']]
  ]) {
    const out = path.join(root, 'docs/public', `unlock-${scheme}.png`);
    // Not execFileSync: the hub serving the page lives in this process.
    await promisify(execFile)(chrome, ['--headless', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=2', '--window-size=640,1180', ...flags, `--screenshot=${out}`, `${base}${link}`], { timeout: 60_000 });
    console.log(`wrote ${path.relative(root, out)}`);
  }
} finally {
  listener.close();
  hub.stopMaintenance();
  hub.watcher.stop();
  await hub.supervisor.stop();
  fs.rmSync(dir, { recursive: true, force: true });
}
