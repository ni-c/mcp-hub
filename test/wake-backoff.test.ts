/**
 * A caller that repeatedly calls wake() on a crash-looping on-demand server
 * must not be able to drive more restart attempts than the server's own
 * exponential backoff and MAX_UNUSED_RESTARTS give-up ceiling would allow on
 * its own: wake() must not cancel a pending restart timer or reset the
 * backoff/attempt counters just because it was called again. These tests
 * exercise the wake()/onExit/start() interaction directly on ManagedServer,
 * the same class every real request path (forward.ts, proxy.ts, hub.ts)
 * calls wake() on.
 */
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManagedServer } from '../src/supervisor.js';
import type { SocketServerConfig, StdioServerConfig } from '../src/config.js';

const EVERYTHING = path.resolve('node_modules/@modelcontextprotocol/server-everything/dist/index.js');

const everythingConfig: StdioServerConfig = {
  kind: 'stdio',
  command: process.execPath,
  args: [EVERYTHING],
  env: {},
  hub: true
};

const brokenConfig: StdioServerConfig = { kind: 'stdio', command: '/bin/false', args: [], env: {}, hub: true };

/** A TCP port nothing listens on: ECONNREFUSED arrives in a millisecond or
 *  two, which is what makes the timing assertions below tight enough to be
 *  useful without being flaky — see test/transports.test.ts's own use of the
 *  same config for the same reason. */
const closedPortConfig: SocketServerConfig = { kind: 'socket', transport: 'tcp', host: '127.0.0.1', port: 1, hub: true };

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  vi.restoreAllMocks();
});

async function until(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not reached in time');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

describe('wake() vs. the crash-recovery backoff and give-up ceiling', () => {
  it('repeated wake() calls during the backoff wait add no restart attempts beyond the natural schedule', async () => {
    const backoffInitialMs = 120;
    const windowMs = 500;

    // Baseline: one wake() kicks the server off from a healthy 'sleeping'
    // snapshot (the steady-state case — a cached tool-cache.json — every real
    // request reaches), then nothing else touches it. Its own backoff timer
    // drives whatever attempts happen.
    const natural = new ManagedServer('natural', closedPortConfig, {
      onDemand: true,
      idleMs: 60_000,
      backoffInitialMs,
      maxUnusedRestarts: 100, // high enough that give-up never enters this window
      wakeTimeoutMs: windowMs + 1000
    });
    cleanups.push(() => natural.stop());
    natural.hydrate({ fingerprint: 'fp', serverInfo: { name: 'natural', version: '0' }, tools: [], updatedAt: '' });
    void natural.wake().catch(() => {});
    await new Promise(resolve => setTimeout(resolve, windowMs));
    const naturalAttempts = natural['generation'];
    expect(naturalAttempts).toBeGreaterThan(0); // sanity: the baseline itself did retry

    // Attack: the same server, but a caller re-asks every 30ms for the whole
    // window — well inside a default rate limit, and far faster than the
    // backoff — exactly forward.ts/proxy.ts/hub.ts's `await managed.wake()`
    // on every request to a not-'up' server.
    const attacked = new ManagedServer('attacked', closedPortConfig, {
      onDemand: true,
      idleMs: 60_000,
      backoffInitialMs,
      maxUnusedRestarts: 100,
      wakeTimeoutMs: windowMs + 1000
    });
    cleanups.push(() => attacked.stop());
    attacked.hydrate({ fingerprint: 'fp', serverInfo: { name: 'attacked', version: '0' }, tools: [], updatedAt: '' });
    const deadline = Date.now() + windowMs;
    while (Date.now() < deadline) {
      void attacked.wake().catch(() => {});
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    const attackedAttempts = attacked['generation'];

    // The fixed wake() no longer cancels the pending restartTimer or resets
    // the backoff on a 'down' server, so a caller riding along the existing
    // cycle gets no more attempts than an unattended one would.
    expect(attackedAttempts).toBeLessThanOrEqual(naturalAttempts + 1);
  });

  it('gives up strictly after maxUnusedRestarts failures — exactly at the limit still retries, one more gives up', async () => {
    const server = new ManagedServer('boundary', closedPortConfig, {
      onDemand: true,
      idleMs: 60_000,
      backoffInitialMs: 15,
      maxUnusedRestarts: 2
    });
    cleanups.push(() => server.stop());
    void server.start();

    // restartsSinceUse === maxUnusedRestarts is still "at the limit", not
    // over it — the condition in onExit is strictly greater-than, so this
    // must still be a live, retrying server.
    await until(() => server['restartsSinceUse'] === 2);
    expect(server.state).toBe('down');

    // One more failure (restartsSinceUse === 3, limit + 1) crosses it.
    await until(() => server.state === 'sleeping');
    expect(server['restartsSinceUse']).toBe(3);
  });

  it('after give-up, a second wake() inside the current backoff interval is refused without a new attempt; one after the interval revives', async () => {
    const server = new ManagedServer('giveup-throttle', closedPortConfig, {
      onDemand: true,
      idleMs: 60_000,
      backoffInitialMs: 30,
      maxUnusedRestarts: 1,
      wakeTimeoutMs: 5000
    });
    cleanups.push(() => server.stop());
    void server.start();
    await until(() => server.state === 'sleeping');
    const generationAtGiveUp = server['generation'];
    const backoffAtGiveUp: number = server['backoffMs'];

    // Accept-good direction: the first ask since give-up revives immediately
    // — "users can still revive a server" — even though it is still broken
    // and rejects again once that attempt fails.
    const first = server.wake();
    expect(server['generation']).toBe(generationAtGiveUp + 1);
    await expect(first).rejects.toThrow(/failed to start/);
    const generationAfterFirstRetry = server['generation'];

    // Reject-bad direction: a second ask inside the same backoff interval
    // must not add another attempt. It is refused right away — well under
    // the interval it would otherwise have to wait out — with the same
    // wording the give-up itself already produced, per the design ("fails
    // fast with the same error it gets today while the server is down"),
    // rather than being queued for the (much longer) wake timeout.
    const rejectedAt = Date.now();
    await expect(server.wake()).rejects.toThrow(/failed to start/);
    expect(Date.now() - rejectedAt).toBeLessThan(backoffAtGiveUp / 2);
    expect(server['generation']).toBe(generationAfterFirstRetry);

    // Once a full backoff interval has actually elapsed, the next ask is
    // allowed to try again — "at most one new attempt per current backoff
    // interval", not zero forever.
    await new Promise(resolve => setTimeout(resolve, backoffAtGiveUp + 40));
    const second = server.wake();
    expect(server['generation']).toBeGreaterThan(generationAfterFirstRetry);
    await expect(second).rejects.toThrow(/failed to start/);
  });

  it('a start that reaches up resets the give-up ceiling, so a later crash gets the full allowance again', async () => {
    const server = new ManagedServer('resets', everythingConfig, {
      onDemand: true,
      idleMs: 60_000,
      backoffInitialMs: 15,
      maxUnusedRestarts: 2
    });
    cleanups.push(() => server.stop());
    // Simulate a server that already used up part of its give-up allowance
    // before this attempt — the state a real crash-then-recover cycle would
    // leave — to prove the reset happens on success, not merely by being
    // asked for (that half is covered by the wake()-throttle test above) and
    // not only through markUsed(), which a supervisor-triggered warm start
    // never reaches.
    server['restartsSinceUse'] = 2;
    server['lastGiveUpRetryAt'] = Date.now();

    await server.start();
    expect(server.state).toBe('up');
    expect(server['restartsSinceUse']).toBe(0);
    expect(server['lastGiveUpRetryAt']).toBe(0);

    await server.sleep();
    // Swap in a config that will now fail, the way an operator's config
    // reload or a fresh crash would, and confirm the give-up ceiling starts
    // counting from zero again rather than remembering the old count.
    server.config = brokenConfig;
    void server.wake().catch(() => {});
    await until(() => server.state === 'down' || server.state === 'sleeping');
    // maxUnusedRestarts is 2: a single fresh failure must not be enough to
    // give up if the ceiling truly reset.
    expect(server.state).toBe('down');
  });
});
