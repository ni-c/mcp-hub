import type { Tool } from '@modelcontextprotocol/sdk/types.js';

/**
 * The per-server tool filter: `allowTools` and `denyTools` in mcp.json.
 *
 * Deliberately its own module. `config.ts` parses and nothing else, and both
 * `proxy.ts` and `hub.ts` need to *apply* the filter — importing a value out of
 * `supervisor.ts` for that would tie two request paths to the lifecycle code.
 *
 * The syntax is identical to the `<PREFIX>_ALLOW_TOOLS` environment variables of
 * ni-c's own MCP servers, so a list moves between the two verbatim. What does
 * not move is their `essential` preset: that is a property of one server's
 * tools, and the hub has no business knowing an upstream's semantics.
 */
export interface ToolFilterConfig {
  allowTools?: string[];
  denyTools?: string[];
}

/** True when this server has a filter at all. */
export function hasToolFilter(config: ToolFilterConfig): boolean {
  return config.allowTools !== undefined || config.denyTools !== undefined;
}

function matches(patterns: readonly string[], name: string): boolean {
  return patterns.some(pattern => (pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern));
}

/**
 * Whether `name` survives the filter.
 *
 * Note `allowTools !== undefined` rather than a length check: an empty array is
 * legal and means *no tools*, which is the one-token way to cut a server off
 * without removing its entry. Conflating "empty" with "absent" is the easiest
 * bug to write here.
 */
export function toolAllowed(config: ToolFilterConfig, name: string): boolean {
  if (config.allowTools !== undefined && !matches(config.allowTools, name)) return false;
  if (config.denyTools !== undefined && matches(config.denyTools, name)) return false;
  return true;
}

/** Returns `tools` unchanged when there is no filter, so the common path allocates nothing. */
export function filterTools(config: ToolFilterConfig, tools: Tool[]): Tool[] {
  if (!hasToolFilter(config)) return tools;
  return tools.filter(tool => toolAllowed(config, tool.name));
}

/**
 * Entries that matched no tool the upstream actually offers.
 *
 * The hub cannot reject these at config-parse time the way the ni-c servers do —
 * an upstream's tools are unknown until it has started, and taking the whole hub
 * down because one upstream renamed a tool would be worse than the problem. So
 * they are reported at the moment of filtering instead, which is also the moment
 * the operator is looking: a filter edit bounces that one server and reprints it.
 */
export function unmatchedPatterns(config: ToolFilterConfig, tools: Tool[]): string[] {
  const names = tools.map(tool => tool.name);
  return [...(config.allowTools ?? []), ...(config.denyTools ?? [])].filter(
    pattern => !names.some(name => matches([pattern], name))
  );
}

/** Control characters would let a caller forge lines in a log LOG_FILE mirrors to disk. */
// eslint-disable-next-line no-control-regex -- matching them is the point
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;
const MAX_LOGGED_NAME = 100;

/**
 * The name a refusal logs, made safe to print.
 *
 * A refused name comes straight off the wire — the whole point of the call
 * guards is that a client may ask for anything — and it lands in a line
 * `LOG_FILE` mirrors to disk, the same file fail2ban reads. Same treatment the
 * docker proxy gives a caller-controlled URL: control characters out, length
 * bounded.
 */
export function loggableToolName(name: string): string {
  const safe = name.replace(CONTROL_CHARACTERS, '?');
  return safe.length > MAX_LOGGED_NAME ? `${safe.slice(0, MAX_LOGGED_NAME)}...` : safe;
}
