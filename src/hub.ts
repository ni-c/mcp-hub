import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Supervisor } from './supervisor.js';
import { VERSION } from './version.js';

const CALL_TIMEOUT_MS = 5 * 60_000;

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
 * four meta-tools, so a client's context holds 4 tool schemas instead of 9×N.
 */
export function buildHubServer(supervisor: Supervisor): McpServer {
  const hub = new McpServer({ name: 'mcp-hub', version: VERSION });

  const findServer = (name: string) => {
    const managed = supervisor.get(name);
    if (!managed || !managed.config.hub) return undefined;
    return managed;
  };

  hub.registerTool(
    'list_servers',
    {
      title: 'List MCP servers',
      description: 'List all MCP servers available through this hub, with their status. Call this first to see what is available.',
      inputSchema: {}
    },
    async () =>
      text(
        supervisor.hubServers().map(s => ({
          name: s.name,
          description: (s.serverInfo as { title?: string } | undefined)?.title ?? s.serverInfo?.name ?? '',
          status: s.state,
          toolCount: s.tools.length
        }))
      )
  );

  hub.registerTool(
    'list_tools',
    {
      title: 'List tools of a server',
      description: 'List the tools of one MCP server with one-line descriptions. Use get_tool_schema before calling a tool for the first time.',
      inputSchema: { server: z.string().describe('Server name from list_servers') }
    },
    async ({ server }) => {
      const managed = findServer(server);
      if (!managed) return toolError(`Unknown server "${server}". Use list_servers to see available servers.`);
      if (managed.state !== 'up') return toolError(`Server "${server}" is ${managed.state}.`);
      return text(managed.tools.map(t => ({ name: t.name, description: firstLine(t.description) })));
    }
  );

  hub.registerTool(
    'get_tool_schema',
    {
      title: 'Get the full schema of a tool',
      description: 'Get the full description and JSON input schema of one tool, needed to construct arguments for call_tool.',
      inputSchema: {
        server: z.string().describe('Server name from list_servers'),
        tool: z.string().describe('Tool name from list_tools')
      }
    },
    async ({ server, tool }) => {
      const managed = findServer(server);
      if (!managed) return toolError(`Unknown server "${server}". Use list_servers to see available servers.`);
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
      inputSchema: {
        server: z.string().describe('Server name from list_servers'),
        tool: z.string().describe('Tool name from list_tools'),
        arguments: z.record(z.string(), z.unknown()).optional().describe('Tool arguments matching its input schema')
      }
    },
    async ({ server, tool, arguments: args }) => {
      const managed = findServer(server);
      if (!managed) return toolError(`Unknown server "${server}". Use list_servers to see available servers.`);
      if (managed.state !== 'up' || !managed.client) return toolError(`Server "${server}" is ${managed.state}, try again later.`);
      try {
        const result = await managed.client.callTool({ name: tool, arguments: (args ?? {}) as Record<string, unknown> }, undefined, {
          timeout: CALL_TIMEOUT_MS,
          resetTimeoutOnProgress: true
        });
        return result as CallToolResult;
      } catch (error) {
        return toolError(`Tool call failed: ${(error as Error).message}`);
      }
    }
  );

  return hub;
}
