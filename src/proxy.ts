import type { Request, Response } from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  CompleteRequestSchema,
  CompleteResultSchema,
  GetPromptRequestSchema,
  GetPromptResultSchema,
  ListPromptsRequestSchema,
  ListPromptsResultSchema,
  ListResourcesRequestSchema,
  ListResourcesResultSchema,
  ListResourceTemplatesRequestSchema,
  ListResourceTemplatesResultSchema,
  ErrorCode,
  ListToolsRequestSchema,
  ListToolsResultSchema,
  McpError,
  ReadResourceRequestSchema,
  ReadResourceResultSchema
} from '@modelcontextprotocol/sdk/types.js';
import type { ListToolsResult, ServerCapabilities } from '@modelcontextprotocol/sdk/types.js';
import type { ManagedServer } from './supervisor.js';
import { ABSOLUTE_CALL_OPTIONS, assertForwardedResultSize } from './mcp-limits.js';
import { filterTools, toolAllowed } from './tool-filter.js';

/**
 * The child's capabilities minus what this proxy does not actually serve.
 *
 * resources.subscribe is dropped: there is no Subscribe handler below, so a
 * client that believed the advertisement got -32601 at call time. Announcing
 * only what we answer is the difference between a missing feature and a lie.
 *
 * listChanged deliberately stays. Forwarding server-initiated messages needs
 * per-client session state, which the stateless transport exists to avoid, so
 * the notification never arrives — but a client waiting for one that never
 * comes is no worse off than a client that was never told. It is listed under
 * the known gaps in the documentation instead.
 */
function advertisedCapabilities(capabilities: ServerCapabilities | undefined): ServerCapabilities {
  const caps: ServerCapabilities = { ...(capabilities ?? {}) };
  if (caps.resources) {
    const { subscribe: _subscribe, ...resources } = caps.resources;
    caps.resources = resources;
  }
  return caps;
}

/**
 * Builds a per-request MCP Server that forwards every request verbatim to the
 * shared child client. A fresh Server per HTTP request plus a stateless
 * transport means no server-side session state at all — claude.ai reconnects
 * every few minutes without ever closing sessions, so anything stateful leaks.
 */
function buildProxyServer(managed: ManagedServer): Server {
  const server = new Server(
    { name: managed.serverInfo?.name ?? managed.name, version: managed.serverInfo?.version ?? '0.0.0' },
    { capabilities: advertisedCapabilities(managed.capabilities) }
  );
  const forwardLive = <T extends { method: string; params?: unknown }>(request: T, resultSchema: Parameters<NonNullable<ManagedServer['client']>['request']>[1]) => {
    const client = managed.client;
    if (!client) throw new Error(`Server "${managed.name}" is not running`);
    return client
      .request(request as Parameters<NonNullable<ManagedServer['client']>['request']>[0], resultSchema, ABSOLUTE_CALL_OPTIONS)
      .then(assertForwardedResultSize);
  };
  // Real usage: wakes a sleeping on-demand server (blocking until it is up)
  // and resets its idle window. Everything else is answered without a child.
  const use = async <T extends { method: string; params?: unknown }>(request: T, resultSchema: Parameters<NonNullable<ManagedServer['client']>['request']>[1]) => {
    if (managed.state !== 'up' || !managed.client) await managed.wake();
    managed.markUsed();
    return forwardLive(request, resultSchema);
  };
  const caps = managed.capabilities ?? {};
  if (caps.tools) {
    // tools/list is part of every client's session handshake — a client with
    // all hub paths configured enumerates them on connect, so answering from
    // the cached snapshot (instead of waking) is what keeps a fleet of
    // sleeping servers asleep. Neither branch counts as usage.
    server.setRequestHandler(ListToolsRequestSchema, async req => {
      // managed.tools is filtered on the way in, but the live branch forwards
      // the upstream's own answer and never consults it — so it has to filter
      // too. Missing this is the obvious bug here: the filter would appear to
      // work on a sleeping server and vanish the moment it woke.
      if (managed.state !== 'up' || !managed.client) return { tools: managed.tools };
      const live = (await forwardLive(req, ListToolsResultSchema)) as ListToolsResult;
      return { ...live, tools: filterTools(managed.config, live.tools) };
    });
    server.setRequestHandler(CallToolRequestSchema, req => {
      // Hiding is not a boundary on this path: the hub forwards by name, so a
      // client holding a stale schema would still reach it. Refused before
      // use(), so a forbidden name cannot wake a sleeping server either. The
      // message is the neutral one a server gives for a tool it does not have —
      // announcing what was hidden would be a disclosure in itself.
      if (!toolAllowed(managed.config, req.params.name)) {
        console.warn(`[${managed.name}] refused tools/call "${req.params.name}": not permitted by allowTools/denyTools`);
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${req.params.name}`);
      }
      return use(req, CallToolResultSchema);
    });
  }
  if (caps.resources) {
    server.setRequestHandler(ListResourcesRequestSchema, req => use(req, ListResourcesResultSchema));
    server.setRequestHandler(ListResourceTemplatesRequestSchema, req => use(req, ListResourceTemplatesResultSchema));
    server.setRequestHandler(ReadResourceRequestSchema, req => use(req, ReadResourceResultSchema));
  }
  if (caps.prompts) {
    server.setRequestHandler(ListPromptsRequestSchema, req => use(req, ListPromptsResultSchema));
    server.setRequestHandler(GetPromptRequestSchema, req => use(req, GetPromptResultSchema));
  }
  if (caps.completions) {
    server.setRequestHandler(CompleteRequestSchema, req => use(req, CompleteResultSchema));
  }
  return server;
}

/** Handle one Streamable-HTTP request against an MCP Server built on the fly. */
export async function handleMcpRequest(buildServer: () => Server, req: Request, res: Response): Promise<void> {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

/** Express handler for /<name> and /<name>/mcp. */
export function serverRequestHandler(managed: ManagedServer) {
  return async (req: Request, res: Response): Promise<void> => {
    if (managed.state !== 'up' || !managed.client) {
      if (!managed.onDemand) {
        res
          .status(503)
          .json({ jsonrpc: '2.0', error: { code: -32000, message: `Server "${managed.name}" is ${managed.state}` }, id: null });
        return;
      }
      if (!managed.hasSnapshot) {
        // First-ever run: nothing cached to answer initialize from, so the
        // whole request blocks on the start instead of just the tool calls.
        try {
          await managed.wake();
        } catch (error) {
          res.status(503).json({ jsonrpc: '2.0', error: { code: -32000, message: (error as Error).message }, id: null });
          return;
        }
      }
      // With a snapshot the proxy server is built from cached identity and
      // capabilities; its handlers wake the child only for real usage.
    }
    await handleMcpRequest(() => buildProxyServer(managed), req, res);
  };
}
