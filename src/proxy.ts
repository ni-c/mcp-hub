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
  ListToolsRequestSchema,
  ListToolsResultSchema,
  ReadResourceRequestSchema,
  ReadResourceResultSchema
} from '@modelcontextprotocol/sdk/types.js';
import type { ServerCapabilities } from '@modelcontextprotocol/sdk/types.js';
import type { ManagedServer } from './supervisor.js';

const CALL_TIMEOUT_MS = 5 * 60_000;

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
  const forward = <T extends { method: string; params?: unknown }>(request: T, resultSchema: Parameters<NonNullable<ManagedServer['client']>['request']>[1]) => {
    const client = managed.client;
    if (!client) throw new Error(`Server "${managed.name}" is not running`);
    return client.request(request as Parameters<NonNullable<ManagedServer['client']>['request']>[0], resultSchema, {
      timeout: CALL_TIMEOUT_MS,
      resetTimeoutOnProgress: true
    });
  };
  const caps = managed.capabilities ?? {};
  if (caps.tools) {
    server.setRequestHandler(ListToolsRequestSchema, req => forward(req, ListToolsResultSchema));
    server.setRequestHandler(CallToolRequestSchema, req => forward(req, CallToolResultSchema));
  }
  if (caps.resources) {
    server.setRequestHandler(ListResourcesRequestSchema, req => forward(req, ListResourcesResultSchema));
    server.setRequestHandler(ListResourceTemplatesRequestSchema, req => forward(req, ListResourceTemplatesResultSchema));
    server.setRequestHandler(ReadResourceRequestSchema, req => forward(req, ReadResourceResultSchema));
  }
  if (caps.prompts) {
    server.setRequestHandler(ListPromptsRequestSchema, req => forward(req, ListPromptsResultSchema));
    server.setRequestHandler(GetPromptRequestSchema, req => forward(req, GetPromptResultSchema));
  }
  if (caps.completions) {
    server.setRequestHandler(CompleteRequestSchema, req => forward(req, CompleteResultSchema));
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
      res
        .status(503)
        .json({ jsonrpc: '2.0', error: { code: -32000, message: `Server "${managed.name}" is ${managed.state}` }, id: null });
      return;
    }
    await handleMcpRequest(() => buildProxyServer(managed), req, res);
  };
}
