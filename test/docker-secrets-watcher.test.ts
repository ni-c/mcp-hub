import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig, type HubConfig } from '../src/config.js';
import { SecretsWatcher } from '../src/docker-proxy/secrets-watcher.js';
import { recreateSandbox } from '../src/docker-proxy/server.js';
import { SecretStore } from '../src/docker-proxy/secrets.js';
import { OWNER_LABEL, OWNER_VALUE, SERVER_LABEL } from '../src/sandbox/container-spec.js';

/**
 * The watcher that turns a secrets edit into a sandbox restart.
 *
 * The filesystem is real (tmpdir, real fs.watch/watchFile with short
 * intervals); the daemon behind recreateSandbox is the same kind of stand-in
 * the proxy suite uses.
 */

const CONFIG_JSON = JSON.stringify({
  mcpServers: {
    // Two servers on the same set: one change must fan out to both.
    scraper: { type: 'docker', image: 'scraper:test', env: { EXAMPLE: 'from-hub' }, secretsFrom: 'shared' },
    indexer: { type: 'docker', image: 'indexer:test', secretsFrom: 'shared' },
    solo: { type: 'docker', image: 'solo:test', secretsFrom: 'solo' },
    plain: { command: 'plain-mcp' }
  }
});

const POLL_MS = 60;
const DEBOUNCE_MS = 50;
// Long enough for poll + debounce + slack; negative checks wait this long too.
const SETTLE_MS = 500;

let dir: string;
let config: HubConfig;
let store: SecretStore;
let watcher: SecretsWatcher | undefined;

function writeSecret(name: string, content: string): void {
  // In place, not rename: mirrors how an operator edits a bind-mounted file,
  // and keeps the inode stable for fs.watchFile.
  fs.writeFileSync(path.join(dir, `${name}.env`), content, { mode: 0o600 });
}

function startWatcher(configView: () => HubConfig = () => config): {
  changes: Array<{ set: string; servers: string[] }>;
  errors: Error[];
  watcher: SecretsWatcher;
} {
  const changes: Array<{ set: string; servers: string[] }> = [];
  const errors: Error[] = [];
  watcher = new SecretsWatcher(store, dir, configView, POLL_MS, DEBOUNCE_MS);
  watcher.on('change', (set: string, servers: string[]) => changes.push({ set, servers }));
  watcher.on('error', (error: Error) => errors.push(error));
  watcher.start();
  return { changes, errors, watcher };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not reached in time');
    await sleep(20);
  }
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-secrets-watch-'));
  config = parseConfig(CONFIG_JSON, {} as NodeJS.ProcessEnv, { expand: false });
  store = new SecretStore(dir);
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  watcher?.stop();
  watcher = undefined;
});

describe('SecretsWatcher', () => {
  it('fires once per content change, for every server on the set', async () => {
    writeSecret('shared', 'TOKEN=one\n');
    writeSecret('solo', 'KEY=a\n');
    const { changes } = startWatcher();

    writeSecret('shared', 'TOKEN=two\n');
    await waitFor(() => changes.length > 0);

    expect(changes).toEqual([{ set: 'shared', servers: ['scraper', 'indexer'] }]);
  });

  it('ignores a touch and a comment-only edit', async () => {
    writeSecret('shared', 'TOKEN=one\n');
    writeSecret('solo', 'KEY=a\n');
    const { changes } = startWatcher();

    const file = path.join(dir, 'shared.env');
    const later = new Date(Date.now() + 5_000);
    fs.utimesSync(file, later, later);
    await sleep(SETTLE_MS);
    writeSecret('shared', '# rotated yesterday\nTOKEN=one\n');
    await sleep(SETTLE_MS);

    expect(changes).toEqual([]);
  });

  it('keeps the old baseline on a broken edit and still fires on the next valid one', async () => {
    writeSecret('shared', 'TOKEN=one\n');
    writeSecret('solo', 'KEY=a\n');
    const { changes, errors } = startWatcher();

    writeSecret('shared', 'THIS IS NOT AN ENV LINE\n');
    await waitFor(() => errors.length > 0);
    expect(changes).toEqual([]);

    writeSecret('shared', 'TOKEN=two\n');
    await waitFor(() => changes.length > 0);
    expect(changes).toEqual([{ set: 'shared', servers: ['scraper', 'indexer'] }]);
  });

  it('treats unsafe permissions as a broken edit, not a change', async () => {
    writeSecret('shared', 'TOKEN=one\n');
    writeSecret('solo', 'KEY=a\n');
    const { changes, errors } = startWatcher();

    writeSecret('shared', 'TOKEN=two\n');
    fs.chmodSync(path.join(dir, 'shared.env'), 0o666);
    await waitFor(() => errors.length > 0);
    expect(errors[0].message).toContain('unsafe permissions');
    expect(changes).toEqual([]);

    fs.chmodSync(path.join(dir, 'shared.env'), 0o600);
  });

  it('refuses a secret that collides with a configured env key', async () => {
    writeSecret('shared', 'TOKEN=one\n');
    writeSecret('solo', 'KEY=a\n');
    const { changes, errors } = startWatcher();

    // EXAMPLE is fixed by the hub's config for "scraper".
    writeSecret('shared', 'TOKEN=one\nEXAMPLE=shadowed\n');
    await waitFor(() => errors.length > 0);
    expect(errors[0].message).toContain('collides with a configured env key');
    expect(changes).toEqual([]);
  });

  it('ignores files no docker server references', async () => {
    writeSecret('shared', 'TOKEN=one\n');
    writeSecret('solo', 'KEY=a\n');
    const { changes } = startWatcher();

    writeSecret('unreferenced', 'ANYTHING=1\n');
    writeSecret('unreferenced', 'ANYTHING=2\n');
    await sleep(SETTLE_MS);

    expect(changes).toEqual([]);
  });

  it('follows the config: a dropped reference stops firing, a new one starts', async () => {
    writeSecret('shared', 'TOKEN=one\n');
    writeSecret('solo', 'KEY=a\n');
    writeSecret('late', 'L=1\n');
    let view = config;
    const { changes } = startWatcher(() => view);

    // "solo" loses its reference, "late" gains one.
    view = parseConfig(
      JSON.stringify({ mcpServers: { scraper: { type: 'docker', image: 'scraper:test', secretsFrom: 'late' } } }),
      {} as NodeJS.ProcessEnv,
      { expand: false }
    );
    watcher?.refresh();

    writeSecret('solo', 'KEY=b\n');
    writeSecret('late', 'L=2\n');
    await waitFor(() => changes.length > 0);
    await sleep(SETTLE_MS);

    expect(changes).toEqual([{ set: 'late', servers: ['scraper'] }]);
  });
});

describe('recreateSandbox', () => {
  let daemonSocket: string;
  let daemon: http.Server;
  const requests: Array<{ method: string; url: string }> = [];
  let labelsOwned = true;
  let containerExists = true;

  beforeAll(async () => {
    daemonSocket = path.join(dir, 'docker.sock');
    daemon = http.createServer((request, response) => {
      requests.push({ method: request.method ?? '', url: request.url ?? '' });
      const send = (status: number, body: unknown) => {
        const payload = JSON.stringify(body);
        response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
        response.end(payload);
      };
      const url = (request.url ?? '').split('?')[0];
      if (url.endsWith('/json')) {
        if (!containerExists) return send(404, { message: 'no such container' });
        return send(200, {
          Config: { Labels: { [OWNER_LABEL]: labelsOwned ? OWNER_VALUE : 'foreign', [SERVER_LABEL]: 'scraper' } }
        });
      }
      if (url.endsWith('/stop')) return send(204, {});
      return send(500, { message: `fake daemon has no route for ${url}` });
    });
    await new Promise<void>(resolve => daemon.listen(daemonSocket, resolve));
  });

  afterAll(async () => {
    daemon.closeAllConnections();
    await new Promise<void>(resolve => daemon.close(() => resolve()));
  });

  it('verifies ownership, then stops with a grace period', async () => {
    requests.length = 0;
    const result = await recreateSandbox({ dockerSocket: daemonSocket }, 'scraper');
    expect(result).toBe('stopped');
    expect(requests[0].method).toBe('GET');
    expect(requests[0].url).toContain('/containers/mcp-sandbox-scraper/json');
    expect(requests[1].method).toBe('POST');
    expect(requests[1].url).toContain('/containers/mcp-sandbox-scraper/stop?t=5');
  });

  it('reports an absent container as a no-op instead of an error', async () => {
    containerExists = false;
    requests.length = 0;
    const result = await recreateSandbox({ dockerSocket: daemonSocket }, 'scraper');
    containerExists = true;
    expect(result).toBe('absent');
    expect(requests.some(entry => entry.url.includes('/stop'))).toBe(false);
  });

  it('refuses to stop a container without the exact ownership labels', async () => {
    labelsOwned = false;
    requests.length = 0;
    await expect(recreateSandbox({ dockerSocket: daemonSocket }, 'scraper')).rejects.toThrow('owner and server labels');
    labelsOwned = true;
    expect(requests.some(entry => entry.url.includes('/stop'))).toBe(false);
  });
});
