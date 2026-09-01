/**
 * Budgets for everything a child server sends back.
 *
 * The hub forwards what an MCP server produces, so an oversized or endless
 * response is the child's way of exhausting the hub's memory and, through it,
 * every other server's availability. These are the ceilings; they are not
 * meant to be reached by anything legitimate.
 */
export const MAX_TOOL_LIST_PAGES = 100;
export const MAX_TOOLS = 10_000;
export const MAX_TOOL_METADATA_BYTES = 16 * 1024 * 1024;
export const MAX_FORWARDED_RESULT_BYTES = 8 * 1024 * 1024;
export const DEFAULT_CALL_TIMEOUT_MS = 5 * 60_000;

/**
 * How long one forwarded call may take.
 *
 * The default deadline is absolute: `resetTimeoutOnProgress` would let a child
 * hold a request open forever by emitting a progress notification every few
 * seconds, and a stuck call holds one of the per-client concurrency slots. A
 * deployment that genuinely runs long tools — a build, a large crawl — can
 * raise the deadline with `MCP_CALL_TIMEOUT_MS` or opt back into progress
 * extending it with `MCP_RESET_TIMEOUT_ON_PROGRESS=true`. Both are read once,
 * here, because the options are used by the per-server proxy and the /hub
 * aggregate alike and threading two numbers through the supervisor would buy
 * nothing.
 */
export const ABSOLUTE_CALL_TIMEOUT_MS = positiveIntegerEnv('MCP_CALL_TIMEOUT_MS', DEFAULT_CALL_TIMEOUT_MS);
export const ABSOLUTE_CALL_OPTIONS = {
  timeout: ABSOLUTE_CALL_TIMEOUT_MS,
  resetTimeoutOnProgress: booleanEnv('MCP_RESET_TIMEOUT_ON_PROGRESS', false)
} as const;

/**
 * Warn and fall back rather than exit: this module is imported by the request
 * path and by the tests, and index.ts is the only place allowed to end the
 * process over a bad environment.
 */
export function positiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    console.error(`mcp-hub: ${name} must be a positive integer, using ${fallback}`);
    return fallback;
  }
  return value;
}

export function booleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  console.error(`mcp-hub: ${name} must be true or false, using ${fallback}`);
  return fallback;
}

export function jsonSize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

export function assertForwardedResultSize<T>(result: T): T {
  const size = jsonSize(result);
  if (size > MAX_FORWARDED_RESULT_BYTES) {
    throw new Error(`MCP result exceeds the ${MAX_FORWARDED_RESULT_BYTES} byte forwarding limit`);
  }
  return result;
}
