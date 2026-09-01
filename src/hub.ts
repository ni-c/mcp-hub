import { McpServer } from '@modelcontextprotocol/server';
import type { CallToolResult, InputRequiredResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ManagedServer, Supervisor } from './supervisor.js';
import { VERSION } from './version.js';
import { forwardToolCall } from './forward.js';
import { loggableToolName, toolAllowed } from './tool-filter.js';

function text(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

function toolError(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function firstLine(description: string | undefined): string {
  if (!description) return '';
  const line = description.split('\n', 1)[0].trim();
  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}

/**
 * The /hub aggregate: one connector exposing every hub-enabled server through
 * six meta-tools, so a client's context holds 6 tool schemas instead of 9×N.
 */

/**
 * Refuses a tool the server's allowTools/denyTools filter removed.
 *
 * The message is verbatim what get_tool_schema already answers for a tool that
 * genuinely does not exist, so a filtered tool is indistinguishable from an
 * absent one — /hub tokens go to third-party connectors, and a refusal that
 * enumerated what was hidden would be a disclosure. The operator's signal goes
 * to the hub log instead.
 */
const requireAllowedTool = (managed: ManagedServer, tool: string, server: string): CallToolResult | undefined => {
  if (toolAllowed(managed.config, tool)) return undefined;
  console.warn(`[${managed.name}] refused "${loggableToolName(tool)}": not permitted by allowTools/denyTools`);
  return toolError(`Unknown tool "${tool}" on server "${server}". Use list_tools to see available tools.`);
};

export function buildHubServer(supervisor: Supervisor, secret: string): McpServer {
  const hub = new McpServer({ name: 'mcp-hub', version: VERSION });

  const findServer = (name: string) => supervisor.get(name);

  /**
   * `hub: false` hides a server's TOOLS from the aggregate — those are meant
   * to be used through the server's own endpoint. Its lifecycle is a different
   * matter: wake_server/sleep_server manage hidden servers too, so the error
   * points at the right door instead of pretending the server does not exist
   * (/health names every server to the same token anyway).
   */
  const requireExposed = (managed: ManagedServer): CallToolResult | undefined => {
    if (managed.config.hub) return undefined;
    return toolError(`Server "${managed.name}" is not exposed through /hub — connect to its own endpoint /${managed.name}/mcp instead.`);
  };

  /**
   * Asking about an on-demand server's tools is the strongest hint that a
   * call follows, so a sleeping server is pre-warmed in the background while
   * the cached snapshot answers. Only a server with nothing cached yet (first
   * ever run) blocks on the start — there is nothing truthful to answer from.
   * Always-running servers pass through untouched.
   */
  const prepare = async (managed: ManagedServer): Promise<CallToolResult | undefined> => {
    if (!managed.onDemand) return undefined;
    if (!managed.hasSnapshot) {
      try {
        await managed.wake();
      } catch (error) {
        return toolError(`Server "${managed.name}" failed to start: ${(error as Error).message}`);
      }
    } else if (managed.state === 'sleeping') {
      void managed.wake().catch(() => {});
    }
    return undefined;
  };

  hub.registerTool(
    'list_servers',
    {
      title: 'List MCP servers',
      description:
        'List all MCP servers available through this hub, with their status. Call this first to see what is available. ' +
        'Servers marked "hidden" serve their tools only via their own endpoint, but wake_server/sleep_server still manage them.',
      inputSchema: z.object({})
    },
    async () =>
      text(
        [...supervisor.servers.values()].map(s => ({
          name: s.name,
          description: (s.serverInfo as { title?: string } | undefined)?.title ?? s.serverInfo?.name ?? '',
          status: s.state,
          toolCount: s.tools.length,
          ...(s.config.hub ? {} : { hidden: true })
        }))
      )
  );

  hub.registerTool(
    'list_tools',
    {
      title: 'List tools of a server',
      description: 'List the tools of one MCP server with one-line descriptions. Use get_tool_schema before calling a tool for the first time.',
      inputSchema: z.object({ server: z.string().describe('Server name from list_servers') })
    },
    async ({ server }) => {
      const managed = findServer(server);
      if (!managed) return toolError(`Unknown server "${server}". Use list_servers to see available servers.`);
      const hidden = requireExposed(managed);
      if (hidden) return hidden;
      if (!managed.onDemand && managed.state !== 'up') return toolError(`Server "${server}" is ${managed.state}.`);
      const failed = await prepare(managed);
      if (failed) return failed;
      return text(managed.tools.map(t => ({ name: t.name, description: firstLine(t.description) })));
    }
  );

  hub.registerTool(
    'get_tool_schema',
    {
      title: 'Get the full schema of a tool',
      description: 'Get the full description and JSON input schema of one tool, needed to construct arguments for call_tool.',
      inputSchema: z.object({
        server: z.string().describe('Server name from list_servers'),
        tool: z.string().describe('Tool name from list_tools')
      })
    },
    async ({ server, tool }) => {
      const managed = findServer(server);
      if (!managed) return toolError(`Unknown server "${server}". Use list_servers to see available servers.`);
      const hidden = requireExposed(managed);
      if (hidden) return hidden;
      // Before prepare(): that background-pre-warms a sleeping server, so a
      // forbidden name would still cost a start even though the lookup below
      // would fail anyway.
      const filtered = requireAllowedTool(managed, tool, server);
      if (filtered) return filtered;
      const failed = await prepare(managed);
      if (failed) return failed;
      const found = managed.tools.find(t => t.name === tool);
      if (!found) return toolError(`Unknown tool "${tool}" on server "${server}". Use list_tools to see available tools.`);
      return text({ name: found.name, description: found.description ?? '', inputSchema: found.inputSchema });
    }
  );

  hub.registerTool(
    'call_tool',
    {
      title: 'Call a tool on a server',
      description: 'Call a tool on one of the MCP servers. Arguments must match the schema from get_tool_schema.',
      inputSchema: z.object({
        server: z.string().describe('Server name from list_servers'),
        tool: z.string().describe('Tool name from list_tools'),
        arguments: z.record(z.string(), z.unknown()).optional().describe('Tool arguments matching its input schema')
      })
    },
    async ({ server, tool, arguments: args }, ctx): Promise<CallToolResult | InputRequiredResult> => {
      const managed = findServer(server);
      if (!managed) return toolError(`Unknown server "${server}". Use list_servers to see available servers.`);
      const hidden = requireExposed(managed);
      if (hidden) return hidden;
      // Before the wake: hiding is not a boundary here, because the hub
      // forwards by name. Refusing first also means a forbidden name cannot
      // start a sleeping server.
      const filtered = requireAllowedTool(managed, tool, server);
      if (filtered) return filtered;
      // The wake stays here rather than being left to the forward, which would
      // do it too: this endpoint answers with tool results, and "failed to
      // start" is a different thing for a caller to read than "tool call
      // failed". Once it is up the forward's own wake is a no-op.
      if (managed.onDemand && (managed.state !== 'up' || !managed.client)) {
        try {
          await managed.wake();
        } catch (error) {
          return toolError(`Server "${server}" failed to start: ${(error as Error).message}`);
        }
      }
      if (managed.state !== 'up' || !managed.client) return toolError(`Server "${server}" is ${managed.state}, try again later.`);
      try {
        // Same forwarding rules as the per-server path, from the same code: a
        // child that asks something reaches the person through this door too.
        // `via: 'hub'` binds the sealed request state to this endpoint — the
        // same tool is reachable both ways, and resuming one call through the
        // other door is not something a caller should be able to do.
        return await forwardToolCall({
          managed,
          tool,
          params: { name: tool, arguments: (args ?? {}) as Record<string, unknown> },
          ctx,
          secret,
          via: 'hub'
        });
      } catch (error) {
        // Aggregate semantics: every failure here is a tool result, never a
        // protocol error, because six meta-tools stand in for every server and
        // one unreachable child must not look like a broken hub.
        return toolError(`Tool call failed: ${(error as Error).message}`);
      }
    }
  );

  hub.registerTool(
    'wake_server',
    {
      title: 'Wake a sleeping server',
      description: 'Start an on-demand server now so its first tool call is fast. No-op if it is already running.',
      inputSchema: z.object({ server: z.string().describe('Server name from list_servers') })
    },
    async ({ server }) => {
      const managed = findServer(server);
      if (!managed) return toolError(`Unknown server "${server}". Use list_servers to see available servers.`);
      if (!managed.onDemand) return toolError(`Server "${server}" is always running.`);
      try {
        await managed.wake();
      } catch (error) {
        return toolError(`Server "${server}" failed to start: ${(error as Error).message}`);
      }
      managed.markUsed();
      return text({ name: managed.name, status: managed.state, toolCount: managed.tools.length });
    }
  );

  hub.registerTool(
    'sleep_server',
    {
      title: 'Put a server to sleep',
      description: 'Stop an on-demand server immediately instead of waiting for its idle timeout. It restarts automatically on the next tool call.',
      inputSchema: z.object({ server: z.string().describe('Server name from list_servers') })
    },
    async ({ server }) => {
      const managed = findServer(server);
      if (!managed) return toolError(`Unknown server "${server}". Use list_servers to see available servers.`);
      if (!managed.onDemand) return toolError(`Server "${server}" is always running.`);
      await managed.sleep();
      return text({ name: managed.name, status: managed.state });
    }
  );

  return hub;
}
