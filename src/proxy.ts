import type { Request, Response } from 'express';
import { CallToolResultSchema, CompleteResultSchema, GetPromptResultSchema, ListPromptsResultSchema, ListResourcesResultSchema, ListResourceTemplatesResultSchema, ListToolsResultSchema, ReadResourceResultSchema } from '@modelcontextprotocol/core';
import { NodeStreamableHTTPServerTransport, toNodeHandler, toWebRequest } from '@modelcontextprotocol/node';
import {
  Server,
  ProtocolError,
  ProtocolErrorCode,
  createMcpHandler,
  isLegacyRequest,
  isInputRequiredResult,
  CLIENT_CAPABILITIES_META_KEY
} from '@modelcontextprotocol/server';
import type {
  CallToolResult,
  ClientCapabilities,
  InputRequiredResult,
  ListToolsResult,
  ServerCapabilities,
  ServerContext,
  StandardSchemaV1
} from '@modelcontextprotocol/server';
import { withInputRequired } from '@modelcontextprotocol/client';
import type { ManagedServer } from './supervisor.js';
import { ABSOLUTE_CALL_OPTIONS, assertForwardedResultSize } from './mcp-limits.js';
import { filterTools, loggableToolName, toolAllowed } from './tool-filter.js';
import {
  STATE_TTL_MS,
  openRequestState,
  passthroughAllowed,
  sanitiseInputRequests,
  sealRequestState,
  withinPayloadBudget
} from './elicitation.js';

/** What `Client.request` accepts as its second argument. Named so the two
 *  forwarding helpers below can be generic over it without repeating the
 *  `Parameters<...>` incantation twice. */
type ClientResultSchema = Parameters<NonNullable<ManagedServer['client']>['request']>[1] & StandardSchemaV1;

/** Per-call overrides on top of the absolute deadline every forward carries. */
type ForwardOptions = Partial<Parameters<NonNullable<ManagedServer['client']>['request']>[2]>;

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
  const caps: ServerCapabilities = { ...capabilities };
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
function buildProxyServer(managed: ManagedServer, secret: string): Server {
  const server = new Server(
    { name: managed.serverInfo?.name ?? managed.name, version: managed.serverInfo?.version ?? '0.0.0' },
    { capabilities: advertisedCapabilities(managed.capabilities) }
  );
  /**
   * Forwards one request and hands back exactly what the schema describes.
   *
   * Generic over the schema rather than typed against a union of all of them:
   * v2's request handlers are typed per method, so a `Promise<unknown>` here
   * fails to assign at all eight call sites below. Inferring the result type
   * from the schema is also the honest description — this returns the child's
   * answer, parsed by the schema the caller chose.
   */
  const forwardLive = <S extends ClientResultSchema>(
    request: { method: string; params?: unknown },
    resultSchema: S,
    options: ForwardOptions = {}
  ): Promise<StandardSchemaV1.InferOutput<S>> => {
    const client = managed.client;
    if (!client) throw new Error(`Server "${managed.name}" is not running`);
    return client
      .request(request as Parameters<NonNullable<ManagedServer['client']>['request']>[0], resultSchema, {
        ...ABSOLUTE_CALL_OPTIONS,
        ...options
      })
      .then(assertForwardedResultSize);
  };
  // Real usage: wakes a sleeping on-demand server (blocking until it is up)
  // and resets its idle window. Everything else is answered without a child.
  //
  // Separate from use() because one caller has to ask the child a question
  // BEFORE it forwards: forwardCall reads the negotiated era off the child's
  // client, and a sleeping child has none. Deciding first and waking second
  // made the first call after a nap silently take the weaker path.
  const ready = async (): Promise<void> => {
    if (managed.state !== 'up' || !managed.client) await managed.wake();
    managed.markUsed();
  };
  const use = async <S extends ClientResultSchema>(
    request: { method: string; params?: unknown },
    resultSchema: S,
    options: ForwardOptions = {}
  ): Promise<StandardSchemaV1.InferOutput<S>> => {
    await ready();
    return forwardLive(request, resultSchema, options);
  };
  const caps = managed.capabilities ?? {};
  if (caps.tools) {
    // tools/list is part of every client's session handshake — a client with
    // all hub paths configured enumerates them on connect, so answering from
    // the cached snapshot (instead of waking) is what keeps a fleet of
    // sleeping servers asleep. Neither branch counts as usage.
    server.setRequestHandler('tools/list', async req => {
      // managed.tools is filtered on the way in, but the live branch forwards
      // the upstream's own answer and never consults it — so it has to filter
      // too. Missing this is the obvious bug here: the filter would appear to
      // work on a sleeping server and vanish the moment it woke.
      if (managed.state !== 'up' || !managed.client) return { tools: managed.tools };
      const live = (await forwardLive(req, ListToolsResultSchema)) as ListToolsResult;
      return { ...live, tools: filterTools(managed.config, live.tools) };
    });
    server.setRequestHandler('tools/call', async (req, ctx) => {
      // Hiding is not a boundary on this path: the hub forwards by name, so a
      // client holding a stale schema would still reach it. Refused before
      // use(), so a forbidden name cannot wake a sleeping server either. The
      // message is the neutral one a server gives for a tool it does not have —
      // announcing what was hidden would be a disclosure in itself.
      if (!toolAllowed(managed.config, req.params.name)) {
        const logged = loggableToolName(req.params.name);
        console.warn(`[${managed.name}] refused tools/call "${logged}": not permitted by allowTools/denyTools`);
        throw new ProtocolError(ProtocolErrorCode.MethodNotFound, `Unknown tool: ${req.params.name}`);
      }
      return forwardCall(managed, req, ctx, ready, use, secret);
    });
  }
  if (caps.resources) {
    server.setRequestHandler('resources/list', req => use(req, ListResourcesResultSchema));
    server.setRequestHandler('resources/templates/list', req => use(req, ListResourceTemplatesResultSchema));
    server.setRequestHandler('resources/read', req => use(req, ReadResourceResultSchema));
  }
  if (caps.prompts) {
    server.setRequestHandler('prompts/list', req => use(req, ListPromptsResultSchema));
    server.setRequestHandler('prompts/get', req => use(req, GetPromptResultSchema));
  }
  if (caps.completions) {
    server.setRequestHandler('completion/complete', req => use(req, CompleteResultSchema));
  }
  return server;
}

/**
 * Forwards one `tools/call`, carrying a question back to the person at the far
 * end when there is one and the whole chain can actually deliver it.
 *
 * Pass-through happens only when four things hold at once, and each is a
 * separate refusal rather than a best effort:
 *
 * 1. the operator has not switched it off, globally or for this server;
 * 2. the **downstream** client declared `elicitation` in this request's
 *    envelope — which only exists on the 2026 era, so this also rules out a
 *    2025 client the hub could never push to;
 * 3. the **upstream** child negotiated the modern era, so its answer can be a
 *    result rather than a request the hub has nowhere to put;
 * 4. the child actually asked something.
 *
 * The capability is mirrored from what the client declared for *this* request
 * and never widened. That is what keeps the announcement honest: it says only
 * "the caller of this one call can answer you", for a call whose answer has
 * somewhere to go.
 */
async function forwardCall(
  managed: ManagedServer,
  req: { method: string; params: { name: string; [key: string]: unknown } },
  ctx: ServerContext,
  ready: () => Promise<void>,
  use: <S extends ClientResultSchema>(request: { method: string; params?: unknown }, schema: S, options?: ForwardOptions) => Promise<StandardSchemaV1.InferOutput<S>>,
  secret: string
): Promise<CallToolResult | InputRequiredResult> {
  // Before condition 3 is even readable: the era is negotiated by the child's
  // client, and an on-demand child that is asleep has none. Waking after the
  // decision made the first call following a nap take the fallback and the
  // second one succeed — the worst shape a security guarantee can have.
  await ready();

  // `RequestMetaEnvelope` is published as `{}`, so the reserved keys cannot be
  // reached through it by name. The constant is the SDK's own, and the value it
  // holds is whatever the client sent — untrusted either way, and only ever
  // read for the one field below.
  const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
  const declared = envelope?.[CLIENT_CAPABILITIES_META_KEY] as ClientCapabilities | undefined;
  const passthrough =
    passthroughAllowed(managed.config) &&
    declared?.elicitation !== undefined &&
    managed.client?.getProtocolEra() === 'modern';

  if (!passthrough) {
    return (await use(req, CallToolResultSchema)) as CallToolResult;
  }

  const binding = { server: managed.name, tool: req.params.name, clientId: ctx.http?.authInfo?.clientId ?? '' };

  // A resume carries the state the hub sealed on the previous round. Anything
  // that does not open is refused as a whole — expired, out of rounds, forged,
  // or minted for another call all get the same answer, because telling them
  // apart would say more than the caller is owed.
  let round = 0;
  let upstreamState: string | undefined;
  const presented = ctx.mcpReq.requestState<string>();
  if (typeof presented === 'string' && presented.length > 0) {
    const opened = openRequestState(presented, secret, binding);
    if (!opened) {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'This call cannot be resumed. Start it again.');
    }
    round = opened.round + 1;
    upstreamState = opened.upstream;
  }

  const params: Record<string, unknown> = {
    ...req.params,
    _meta: {
      ...(req.params._meta as Record<string, unknown> | undefined),
      // Spread last on the client side, so this wins over the envelope the
      // hub's own connection would otherwise attach.
      [CLIENT_CAPABILITIES_META_KEY]: { elicitation: declared.elicitation }
    },
    ...(ctx.mcpReq.inputResponses ? { inputResponses: ctx.mcpReq.inputResponses } : {}),
    ...(upstreamState !== undefined ? { requestState: upstreamState } : {})
  };

  // Without `allowInputRequired` the hub's own client refuses the answer
  // rather than handing it over — `autoFulfill: false` makes an unhandled
  // `input_required` a typed error, which is exactly the shape a gateway needs
  // to opt out of, per call.
  const result = (await use({ method: req.method, params }, withInputRequired(CallToolResultSchema), {
    allowInputRequired: true
  })) as CallToolResult | InputRequiredResult;

  if (!isInputRequiredResult(result)) return result;

  const { requests, dropped } = sanitiseInputRequests(result.inputRequests, managed.name);
  if (dropped.length > 0) {
    console.warn(`[${managed.name}] dropped ${dropped.length} non-elicitation input request(s) from ${loggableToolName(req.params.name)}`);
  }
  if (Object.keys(requests).length === 0 || !withinPayloadBudget(requests)) {
    // Nothing left to ask, or too much to be a prompt. Either way the call
    // cannot continue, and saying so beats returning a question with no
    // content or one the client would choke on.
    return {
      isError: true,
      content: [{ type: 'text', text: `Server "${managed.name}" asked for input the hub will not forward.` }]
    };
  }

  return {
    resultType: 'input_required',
    inputRequests: requests,
    requestState: sealRequestState(
      { ...binding, round, expiresAt: Date.now() + STATE_TTL_MS, ...(result.requestState !== undefined ? { upstream: result.requestState } : {}) },
      secret
    )
  };
}

/**
 * The 2025-era path, unchanged: one `Server` and one stateless transport per
 * HTTP request, both closed when the response closes.
 *
 * Kept as its own function rather than folded into the modern handler's
 * `legacy: 'stateless'` fallback, because the two are not the same on the wire.
 * That fallback answers GET and DELETE with `405`; this transport answers a GET
 * with an open `text/event-stream` and a DELETE with `200`. claude.ai opens such
 * a stream on every reconnect — which is why `ClientRequestGate` counts GETs
 * separately in the first place — so switching it to `405` would be a visible
 * change to the one client the stateless design was built around. The stream
 * carries nothing today, but "carries nothing" and "is refused" are different
 * answers, and this is not the change in which to find out how clients tell them
 * apart.
 */
async function handleLegacyRequest(buildServer: () => Server, req: Request, res: Response): Promise<void> {
  const server = buildServer();
  const transport = new NodeStreamableHTTPServerTransport({
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

/**
 * Handle one MCP request in whichever protocol era it arrives in.
 *
 * `isLegacyRequest` decides, and its contract is one-way: everything it calls
 * false — including a malformed envelope or a header/body mismatch — belongs to
 * the modern handler, which owns those error answers. Only what it calls true
 * may reach the legacy path.
 *
 * The modern handler is built per request. It is documented as long-lived and
 * has `close()`, which matters once `subscriptions/listen` is forwarded to
 * children; until then it holds nothing between requests, and a fresh one per
 * request is the same lifecycle the legacy path has always had.
 */
export async function handleMcpRequest(buildServer: () => Server, req: Request, res: Response): Promise<void> {
  const probe = await toWebRequest(req, req.body);
  if (await isLegacyRequest(probe)) {
    await handleLegacyRequest(buildServer, req, res);
    return;
  }

  const handler = createMcpHandler(() => buildServer(), {
    // Strict: the legacy era is served above, by the transport that has always
    // served it. A second, differently-behaving legacy path underneath this one
    // would be unreachable and misleading.
    legacy: 'reject',
    onerror: error => console.error(`mcp-hub: modern-era request failed: ${error.message}`)
  });
  res.on('close', () => void handler.close());
  await toNodeHandler(handler)(req, res, req.body);
}

/** Express handler for /<name> and /<name>/mcp. */
export function serverRequestHandler(managed: ManagedServer, secret: string) {
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
    await handleMcpRequest(() => buildProxyServer(managed, secret), req, res);
  };
}
