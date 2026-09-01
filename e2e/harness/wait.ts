import { assertLoopback } from './loopback.js';

/**
 * Everything in this suite that waits, waits here.
 *
 * A fixed `sleep` is both too long on a warm machine and too short on a cold
 * one, and when it is too short the failure surfaces somewhere else entirely —
 * as a tool call returning ECONNREFUSED, which reads like a bug in the tool.
 * Every wait is therefore a predicate with a deadline and a short poll, and
 * every timeout carries the last thing that went wrong rather than only the
 * fact that time ran out.
 *
 * Adapted from `mcp-integration-harness/src/wait.ts`.
 */

export class WaitTimeout extends Error {}

export interface WaitOptions {
  /** How long to keep trying. */
  timeoutMs?: number;
  /** Between attempts. Short on purpose — see the note on sleeping above. */
  intervalMs?: number;
  /** Named in the failure message, so a timeout says what was expected. */
  what?: string;
}

/**
 * Polls until the predicate is true, or explains what it last saw.
 *
 * The predicate may return a value; it is returned on success, so a caller can
 * both wait for a thing and take it in one step.
 */
export async function waitFor<T>(predicate: () => T | Promise<T>, options: WaitOptions = {}): Promise<NonNullable<T>> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const intervalMs = options.intervalMs ?? 25;
  const what = options.what ?? 'condition';
  const deadline = Date.now() + timeoutMs;
  let last = 'never evaluated';

  for (;;) {
    try {
      const value = await predicate();
      if (value !== undefined && value !== null && value !== false) return value as NonNullable<T>;
      last = `returned ${JSON.stringify(value) ?? String(value)}`;
    } catch (error) {
      last = String(error);
    }
    if (Date.now() >= deadline) {
      throw new WaitTimeout(`mcp-hub e2e: ${what} did not hold within ${timeoutMs}ms. Last attempt ${last}.`);
    }
    await sleep(intervalMs);
  }
}

export interface HttpWaitOptions extends WaitOptions {
  /** What counts as ready. Default: any response at all. */
  ready?: (response: Response) => boolean;
  /**
   * Aborts the wait early when the thing being waited for has already died.
   *
   * A hub that refuses to start writes its reason and exits in under a second;
   * without this the suite would keep polling a port nobody is listening on
   * until the deadline, and report a timeout for a process that told us exactly
   * what was wrong thirty seconds earlier.
   */
  abandonIf?: () => string | undefined;
}

export async function waitForHttp(url: string, options: HttpWaitOptions = {}): Promise<void> {
  assertLoopback(url);
  const timeoutMs = options.timeoutMs ?? 30_000;
  const intervalMs = options.intervalMs ?? 50;
  const ready = options.ready ?? (() => true);
  const deadline = Date.now() + timeoutMs;
  let last = 'no attempt completed';

  for (;;) {
    const abandon = options.abandonIf?.();
    if (abandon !== undefined) throw new Error(`mcp-hub e2e: gave up waiting for ${url}: ${abandon}`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000), redirect: 'manual' });
      if (ready(response)) return;
      last = `HTTP ${response.status}`;
    } catch (error) {
      // `String(error)` rather than `error.message`: the message alone is often
      // just "fetch failed", and the constructor name is the half that says
      // whether nothing was listening or the request timed out.
      last = String(error);
    }
    if (Date.now() >= deadline) {
      throw new WaitTimeout(`mcp-hub e2e: ${url} did not answer within ${timeoutMs}ms. Last attempt: ${last}.`);
    }
    await sleep(intervalMs);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
