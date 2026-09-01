import net from 'node:net';

/**
 * A free TCP port, chosen before the thing that will listen on it exists.
 *
 * Every test in `test/` uses `listen(0)` and reads the port back, which is
 * race-free and unavailable here: `EXTERNAL_URL` is the hub's own issuer
 * identifier, it goes into the environment of a process that has not started
 * yet, and the hub compares it byte-for-byte against what clients send back. So
 * the port has to be known first, and there is an unavoidable gap between
 * choosing it and binding it.
 *
 * Two things close that gap far enough to be reliable:
 *
 *  1. A band per vitest worker. Workers run concurrently and are the only other
 *     thing on this machine doing the same dance; giving each its own 200-port
 *     range removes worker-versus-worker collisions entirely, leaving only the
 *     rest of the system.
 *  2. Probing inside the band rather than trusting the kernel's ephemeral
 *     choice, and remembering what this process already handed out — the
 *     ephemeral range is where everything *else* lands, which is precisely
 *     where not to put a port that must stay free for a second or two.
 *
 * The residual race is real and is handled where it lands: `startGateway`
 * retries the spawn when the child reports EADDRINUSE.
 */

const BAND_SIZE = 200;
const FIRST_BAND = 20_000;

/** Handed out by this process and not yet known to be listening. */
const claimed = new Set<number>();

/**
 * Which band this worker owns.
 *
 * `VITEST_POOL_ID`, not `VITEST_WORKER_ID`. The names suggest the opposite, and
 * getting it wrong is silent: `VITEST_WORKER_ID` is **0** for the first worker
 * and is not the concurrency slot, so a `worker - 1` with a positive guard maps
 * every worker onto band 0. Everything passes in a single-file run and the
 * whole scheme collapses the moment two files run at once — which is how it was
 * found, as a container failing to bind a port a spawned hub already had.
 *
 * `VITEST_POOL_ID` is 1-based and unique among *concurrent* workers, which is
 * exactly the property a band needs. Outside vitest there is one process, so
 * band 0 is right.
 */
export function band(): { from: number; to: number } {
  const slot = Number(process.env.VITEST_POOL_ID ?? 1);
  const index = Number.isSafeInteger(slot) && slot > 0 ? slot - 1 : 0;
  const from = FIRST_BAND + index * BAND_SIZE;
  return { from, to: from + BAND_SIZE - 1 };
}

function probe(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    // The same interface the hub will bind, or the probe proves nothing.
    server.listen(port, '127.0.0.1');
  });
}

export async function freePort(): Promise<number> {
  const { from, to } = band();
  for (let port = from; port <= to; port += 1) {
    if (claimed.has(port)) continue;
    if (await probe(port)) {
      claimed.add(port);
      return port;
    }
  }
  throw new Error(`mcp-hub e2e: no free port in ${from}-${to}. Something else is using this worker's band.`);
}

/** Gives a port back after the thing that held it has stopped. */
export function releasePort(port: number): void {
  claimed.delete(port);
}
