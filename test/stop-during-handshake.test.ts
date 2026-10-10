/**
 * A child that never finishes its handshake is still a child.
 *
 * Until it answers `initialize`, the supervisor holds no client for it — only
 * the transport inside start(). stop() and sleep() used to close the client
 * alone, so a child stuck in `starting` outlived its server: across a config
 * reload it kept running beside its replacement, and when the hub exited it was
 * left behind as an orphan. The e2e chaos suite leaked one per run this way.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ManagedServer } from '../src/supervisor.js';
import type { StdioServerConfig } from '../src/config.js';

/** Writes its pid, holds stdin open and never speaks — and, like a wedged
 *  server, ignores stdin closing, so only a signal ends it. */
const SILENT_CHILD = `
require('node:fs').writeFileSync(process.argv[1], String(process.pid));
process.stdin.resume();
process.stdin.on('end', () => {});
setInterval(() => {}, 1 << 30);
`;

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function silentChild(): { config: StdioServerConfig; pidFile: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-handshake-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pidFile = path.join(dir, 'pid');
  return { config: { kind: 'stdio', command: process.execPath, args: ['-e', SILENT_CHILD, pidFile], env: {}, hub: true }, pidFile };
}

async function until<T>(probe: () => T | undefined, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('condition not reached in time');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Starts the server and waits until its child is running but still silent. */
async function startStuck(server: ManagedServer, pidFile: string): Promise<number> {
  void server.start();
  const pid = await until(() => (fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8')) || undefined : undefined));
  expect(server.state).toBe('starting');
  cleanups.push(() => {
    if (alive(pid)) process.kill(pid, 'SIGKILL');
  });
  return pid;
}

describe('a child stuck in its handshake', () => {
  it('is ended by stop()', async () => {
    const { config, pidFile } = silentChild();
    const server = new ManagedServer('stuck', config);
    const pid = await startStuck(server, pidFile);

    await server.stop();

    expect(server.state).toBe('stopped');
    await until(() => (alive(pid) ? undefined : true));
  }, 20_000);

  it('is ended by sleep(), and the server stays wakeable', async () => {
    const { config, pidFile } = silentChild();
    const server = new ManagedServer('stuck', config, { onDemand: true, idleMs: 60_000 });
    cleanups.push(() => server.stop());
    const pid = await startStuck(server, pidFile);

    await server.sleep();

    expect(server.state).toBe('sleeping');
    await until(() => (alive(pid) ? undefined : true));
  }, 20_000);

  it('does not report the closed handshake as a crash to restart from', async () => {
    const { config, pidFile } = silentChild();
    const server = new ManagedServer('stuck', config, { backoffInitialMs: 10 });
    const pid = await startStuck(server, pidFile);
    fs.rmSync(pidFile);

    await server.stop();
    await until(() => (alive(pid) ? undefined : true));
    // Long past the 10 ms backoff: a restart would have written a new pid.
    await new Promise(resolve => setTimeout(resolve, 200));

    expect(server.state).toBe('stopped');
    expect(fs.existsSync(pidFile)).toBe(false);
  }, 20_000);

  it('still leaves stop() a no-op for a server that never started', async () => {
    const { config } = silentChild();
    const server = new ManagedServer('idle', config);

    await server.stop();

    expect(server.state).toBe('stopped');
  });
});
