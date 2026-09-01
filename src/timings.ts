/**
 * How long the supervisor waits, in one place and overridable.
 *
 * These numbers are chosen for a hosted hub, where a minute of extra patience
 * costs nothing and a restart storm costs everything. They are wrong for a test
 * that has to observe the behaviour they govern: waiting out a 60-second idle
 * sweep or a 120-second wake timeout is four minutes of sleeping per run, and a
 * test suite that sleeps for four minutes is a test suite somebody deletes.
 *
 * The 5-minute backoff ceiling is worse than slow — it is unreachable. A test
 * would have to let a server crash-loop for a quarter of an hour to see it.
 *
 * So the values move here and read the environment, exactly as `mcp-limits.ts`
 * does for the call deadline and `subscriptions.ts` for the debounce window.
 * Same contract as those two: a bad value warns and falls back rather than
 * exiting, because this module is imported by the request path, and index.ts is
 * the only place allowed to end the process over a bad environment.
 *
 * The Supervisor's own options still win where they exist — the environment
 * sets the default, it does not override a caller who asked for something
 * specific. In-process tests keep passing options; a hub in another process or
 * a container has only the environment, which is the whole reason this file
 * exists.
 */
import { nonNegativeIntegerEnv, positiveIntegerEnv } from './mcp-limits.js';

/** First wait after a child exits; doubles from here. */
export const BACKOFF_INITIAL_MS = positiveIntegerEnv('MCP_BACKOFF_INITIAL_MS', 1_000);

/** The ceiling the doubling stops at, so a permanently broken server retries hourly-ish rather than never. */
export const BACKOFF_MAX_MS = positiveIntegerEnv('MCP_BACKOFF_MAX_MS', 5 * 60_000);

/** How long a child must have stayed up before its next crash counts as the first one again. */
export const BACKOFF_RESET_AFTER_MS = positiveIntegerEnv('MCP_BACKOFF_RESET_AFTER_MS', 5 * 60_000);

/** How often a running child is pinged to find out it has gone quietly. */
export const PING_INTERVAL_MS = positiveIntegerEnv('MCP_PING_INTERVAL_MS', 60_000);

/** How long that ping may take before the child counts as gone. */
export const PING_TIMEOUT_MS = positiveIntegerEnv('MCP_PING_TIMEOUT_MS', 30_000);

/** How long a sleeping child gets to come back before the caller is told it did not. */
export const WAKE_TIMEOUT_MS = positiveIntegerEnv('MCP_WAKE_TIMEOUT_MS', 120_000);

/** Restarts of a server nobody asked for, before it is left asleep instead. */
export const MAX_UNUSED_RESTARTS = nonNegativeIntegerEnv('MCP_MAX_UNUSED_RESTARTS', 5);

/** How often the idle sweep looks for servers to put to sleep. */
export const IDLE_SWEEP_INTERVAL_MS = positiveIntegerEnv('MCP_IDLE_SWEEP_INTERVAL_MS', 60_000);

/**
 * How often the config file is polled, on top of watching its directory.
 *
 * `fs.watch` does not fire for a single-file bind mount, which is the shape
 * every Docker deployment of this hub had before the directory mount was
 * documented — so the poll is the fallback that makes hot reload work at all,
 * not an optimisation.
 */
export const CONFIG_POLL_INTERVAL_MS = positiveIntegerEnv('MCP_CONFIG_POLL_INTERVAL_MS', 3_000);

/**
 * Idle timeout in milliseconds, when minutes are too coarse.
 *
 * `IDLE_TIMEOUT_MINUTES` stays the documented knob and the one a deployment
 * should use; this is its finer-grained sibling, so a test can watch a server
 * fall asleep in a second instead of in a minute. `0` means "not set" and
 * leaves the minute value in charge — which is why it cannot also mean "never
 * sleep": that is `IDLE_TIMEOUT_MINUTES=0`, and it already has a meaning.
 */
export const IDLE_TIMEOUT_MS = nonNegativeIntegerEnv('IDLE_TIMEOUT_MS', 0);
