import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManagedServer, Supervisor, setDockerClient } from '../src/supervisor.js';
import { DockerTransport } from '../src/transports/docker.js';
import type { DockerClient } from '../src/sandbox/docker-client.js';
import { ToolCache } from '../src/tool-cache.js';
import { parseConfig } from '../src/config.js';
import type { DockerServerConfig, HubConfig, StdioServerConfig } from '../src/config.js';

const EVERYTHING = path.resolve('node_modules/@modelcontextprotocol/server-everything/dist/index.js');

const everythingConfig: StdioServerConfig = {
  kind: 'stdio',
  command: process.execPath,
  args: [EVERYTHING],
  env: {},
  hub: true
};

const brokenConfig: StdioServerConfig = { kind: 'stdio', command: '/bin/false', args: [], env: {}, hub: true };

const tmpDirs: string[] = [];
const cleanups: (() => Promise<void> | void)[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-ondemand-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  setDockerClient(undefined);
  vi.restoreAllMocks();
});

async function until(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not reached in time');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

describe('ManagedServer sleep/wake', () => {
  it('sleep() tears the child down but keeps the snapshot; wake() brings it back', async () => {
    const server = new ManagedServer('everything', everythingConfig, { onDemand: true, idleMs: 60_000 });
    cleanups.push(() => server.stop());
    await server.start();
    expect(server.state).toBe('up');
    const toolCount = server.tools.length;
    expect(toolCount).toBeGreaterThan(0);

    await server.sleep();
    expect(server.state).toBe('sleeping');
    expect(server.client).toBeUndefined();
    expect(server.tools).toHaveLength(toolCount); // snapshot survives for cached tools/list
    expect(server.hasSnapshot).toBe(true);

    await server.wake();
    expect(server.state).toBe('up');
    expect(server.client).toBeDefined();
  });

  it('concurrent wake() calls share one in-flight start', async () => {
    const server = new ManagedServer('everything', everythingConfig, { onDemand: true, idleMs: 60_000 });
    cleanups.push(() => server.stop());
    await server.start();
    await server.sleep();

    await Promise.all([server.wake(), server.wake(), server.wake()]);
    expect(server.state).toBe('up');
    // The generation advances once per start attempt and once per teardown:
    // initial start (1), sleep (2), then exactly ONE start for all three wakes.
    expect(server['generation']).toBe(3);
  });

  it('wake() rejects with the last error once the timeout passes', async () => {
    const server = new ManagedServer('broken', brokenConfig, {
      onDemand: true,
      idleMs: 60_000,
      wakeTimeoutMs: 400,
      backoffInitialMs: 20
    });
    cleanups.push(() => server.stop());
    server.hydrate({ fingerprint: 'fp', serverInfo: { name: 'broken', version: '0' }, tools: [], updatedAt: '' });

    await expect(server.wake()).rejects.toThrow(/did not start within 0s/);
    expect(server.lastError).toBeTruthy();
  });

  it('gives up restarting an unused crashing server and goes back to sleeping', async () => {
    const server = new ManagedServer('broken', brokenConfig, {
      onDemand: true,
      idleMs: 60_000,
      backoffInitialMs: 5,
      maxUnusedRestarts: 3
    });
    void server.start();
    await until(() => server.state === 'sleeping');
    expect(server.lastError).toBeTruthy();
    const generation = server['generation'];

    // No further restarts once asleep — the backoff chain is dead.
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(server['generation']).toBe(generation);
    expect(server.state).toBe('sleeping');

    // The next wake starts fresh (and, still broken, is rejected again).
    await expect(server.wake()).rejects.toThrow();
    expect(server['generation']).toBeGreaterThan(generation);
    await server.stop();
  });

  it('a keepAlive-style server (no options) keeps restarting like today', async () => {
    const server = new ManagedServer('broken', brokenConfig, { backoffInitialMs: 5 } as never);
    void server.start();
    await until(() => server.state === 'down');
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(server.state).not.toBe('sleeping'); // never gives up
    await server.stop();
  });
});

describe('Supervisor on-demand lifecycle', () => {
  function stdioConfigMap(entries: Record<string, Record<string, unknown>>): HubConfig {
    return parseConfig(JSON.stringify({ mcpServers: entries }), {});
  }

  it('boots a cached on-demand server straight into sleeping without spawning it', async () => {
    const config = stdioConfigMap({ everything: { command: process.execPath, args: [EVERYTHING] } });
    const cache = new ToolCache(path.join(tmpDir(), 'tool-cache.json'));
    cache.put('everything', {
      fingerprint: ToolCache.fingerprint(config.get('everything')!),
      serverInfo: { name: 'everything', version: '1.0.0' },
      capabilities: { tools: {} },
      tools: [{ name: 'echo', inputSchema: { type: 'object' } }],
      updatedAt: new Date().toISOString()
    });
    const supervisor = new Supervisor(config, { idleTimeoutMinutes: 60, cache });
    cleanups.push(() => supervisor.stop());
    supervisor.start();
    await supervisor.waitUntilSettled();

    const managed = supervisor.get('everything')!;
    expect(managed.state).toBe('sleeping');
    expect(managed.client).toBeUndefined();
    expect(managed.tools.map(t => t.name)).toEqual(['echo']);
  });

  it('warm-starts on a cache miss and persists the snapshot for the next boot', async () => {
    const config = stdioConfigMap({ everything: { command: process.execPath, args: [EVERYTHING] } });
    const cache = new ToolCache(path.join(tmpDir(), 'tool-cache.json'));
    const supervisor = new Supervisor(config, { idleTimeoutMinutes: 60, cache });
    cleanups.push(() => supervisor.stop());
    supervisor.start();
    await supervisor.waitUntilSettled();

    const managed = supervisor.get('everything')!;
    expect(managed.state).toBe('up');
    expect(managed.onDemand).toBe(true);
    const entry = cache.get('everything', ToolCache.fingerprint(config.get('everything')!));
    expect(entry?.tools.length).toBeGreaterThan(0);
    expect(entry?.serverInfo?.name).toBeTruthy();
  });

  it('keepAlive and idleTimeoutMinutes=0 both mean always-running', async () => {
    const config = stdioConfigMap({
      pinned: { command: process.execPath, args: [EVERYTHING], keepAlive: true },
      lazy: { command: process.execPath, args: [EVERYTHING] }
    });
    const onDemandSup = new Supervisor(config, { idleTimeoutMinutes: 60 });
    const disabledSup = new Supervisor(config, { idleTimeoutMinutes: 0 });
    cleanups.push(() => onDemandSup.stop(), () => disabledSup.stop());
    onDemandSup.start();
    disabledSup.start();
    await Promise.all([onDemandSup.waitUntilSettled(), disabledSup.waitUntilSettled()]);

    expect(onDemandSup.get('pinned')!.onDemand).toBe(false);
    expect(onDemandSup.get('lazy')!.onDemand).toBe(true);
    expect(disabledSup.get('lazy')!.onDemand).toBe(false);
  });

  it('the idle sweep puts only idle on-demand servers to sleep', async () => {
    const config = stdioConfigMap({
      pinned: { command: process.execPath, args: [EVERYTHING], keepAlive: true },
      idle: { command: process.execPath, args: [EVERYTHING] },
      busy: { command: process.execPath, args: [EVERYTHING] }
    });
    const supervisor = new Supervisor(config, { idleTimeoutMinutes: 60 });
    cleanups.push(() => supervisor.stop());
    supervisor.start();
    await supervisor.waitUntilSettled();

    const idle = supervisor.get('idle')!;
    const busy = supervisor.get('busy')!;
    idle.lastUsedAt = Date.now() - idle.idleMs - 1;
    busy.markUsed();
    supervisor['sweepIdle']();
    await until(() => idle.state === 'sleeping');

    expect(busy.state).toBe('up');
    expect(supervisor.get('pinned')!.state).toBe('up');
  });

  it('applyDiff invalidates the cache entry of a changed server and warm-starts the replacement', async () => {
    const before = stdioConfigMap({ everything: { command: process.execPath, args: [EVERYTHING] } });
    const cache = new ToolCache(path.join(tmpDir(), 'tool-cache.json'));
    const supervisor = new Supervisor(before, { idleTimeoutMinutes: 60, cache });
    cleanups.push(() => supervisor.stop());
    supervisor.start();
    await supervisor.waitUntilSettled();
    const oldFingerprint = ToolCache.fingerprint(before.get('everything')!);
    expect(cache.get('everything', oldFingerprint)).toBeDefined();

    const after = stdioConfigMap({ everything: { command: process.execPath, args: [EVERYTHING], idleMinutes: 30 } });
    await supervisor.applyDiff(after, { added: [], removed: [], changed: ['everything'] });

    const managed = supervisor.get('everything')!;
    expect(managed.state).toBe('up'); // warm start fills the fresh cache entry
    expect(managed.idleMs).toBe(30 * 60_000);
    expect(cache.get('everything', oldFingerprint)).toBeUndefined();
    expect(cache.get('everything', ToolCache.fingerprint(after.get('everything')!))).toBeDefined();
  });
});

describe('docker teardown', () => {
  it('DockerTransport.close() removes the container, so a sleeping sandbox holds nothing', async () => {
    const stream = new PassThrough();
    const removed: string[] = [];
    const client = {
      imageExists: async () => true,
      removeContainer: async (name: string) => void removed.push(name),
      createContainer: async () => 'id',
      attach: async () => stream,
      startContainer: async () => undefined
    } as unknown as DockerClient;
    const config: DockerServerConfig = {
      kind: 'docker', image: 'x@sha256:abc', pull: 'never', env: {}, volumes: [], ports: [], network: 'none',
      memory: 512 * 1024 * 1024, pidsLimit: 256, cpus: 1, readOnly: true, tmpfs: ['/tmp'], hub: true
    };
    const transport = new DockerTransport('sleepy', config, client, () => {});
    await transport.start();
    removed.length = 0;
    await transport.close();
    expect(removed).toContain('mcp-sandbox-sleepy');
  });
});
