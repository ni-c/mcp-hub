import type { Request, Response } from 'express';
import { CompleteResultSchema, GetPromptResultSchema, ListPromptsResultSchema, ListResourcesResultSchema, ListResourceTemplatesResultSchema, ListToolsResultSchema, ReadResourceResultSchema } from '@modelcontextprotocol/core';
import { NodeStreamableHTTPServerTransport, toNodeHandler, toWebRequest } from '@modelcontextprotocol/node';
import { Server, ProtocolError, ProtocolErrorCode, createMcpHandler, isInputRequiredResult, isLegacyRequest } from '@modelcontextprotocol/server';
import type { ListToolsResult, McpHttpHandler, ServerCapabilities, StandardSchemaV1 } from '@modelcontextprotocol/server';
import type { ManagedServer } from './supervisor.js';
import { ABSOLUTE_CALL_OPTIONS, assertForwardedResultSize } from './mcp-limits.js';
import { filterTools, loggableToolName, toolAllowed } from './tool-filter.js';
import { forwardToolCall } from './forward.js';
import type { RouteChannel } from './subscriptions.js';
import {
  KEEPALIVE_MS,
  MAX_STREAM_MS,
  MAX_SUBSCRIPTIONS,
  MAX_SUBSCRIPTION_URIS,
  SubscriptionRegistry,
  isListenRequest,
  parseListenFilter,
  subscriptionsAllowed
} from './subscriptions.js';

/**
 * Which protocol revision a request arrived on.
 *
 * Not threaded through from `isLegacyRequest`: the two eras are served by two
 * different objects — the long-lived modern handler and the per-request legacy
 * transport — so each construction site already knows its own answer.
 */
export type Era = 'modern' | 'legacy';

/**
 * The revision each era puts on the wire.
 *
 * Only ever read to *tell* somebody which one they are on; nothing branches on
 * the string. `Era` stays the type everything else is written against, because
 * a revision date is a fact about the wire and an era is a fact about
 * behaviour, and the code cares about the second one.
 */
export const REVISION: Record<Era, string> = { modern: '2026-07-28', legacy: '2025-11-25' };

/** What `Client.request` accepts as its second argument. Named so the two
 *  forwarding helpers below can be generic over it without repeating the
 *  `Parameters<...>` incantation twice. */
type ClientResultSchema = Parameters<NonNullable<ManagedServer['client']>['request']>[1] & StandardSchemaV1;

/** Per-call overrides on top of the absolute deadline every forward carries. */
type ForwardOptions = Partial<Parameters<NonNullable<ManagedServer['client']>['request']>[2]>;

/**
 * The child's capabilities minus what this proxy does not actually serve.
 *
 * The rule is one sentence: announce only what we answer. Three claims are
 * decided here, and each used to be decided the other way.
 *
 * `listChanged` and `resources.subscribe` now survive — but only on the era
 * that carries them. A 2026-07-28 client opens a `subscriptions/listen` stream
 * and the hub delivers on it; a 2025 client would need `resources/subscribe`
 * and an unsolicited server-to-client channel, and gets neither, so it is told
 * neither. The 2025 side is the behaviour that shipped before, now stated
 * rather than assumed.
 *
 * `logging` goes on both eras. `logging/setLevel` has no handler and never
 * had one, so a client that believed the advertisement got a -32601 at call
 * time — the exact shape of the bug `resources.subscribe` used to have. On
 * 2026-07-28 the level is per-request `_meta` and there is no RPC to implement;
 * carrying `notifications/message` is a separate piece of work, and until it
 * exists the honest answer is silence.
 *
 * A server whose operator set `subscriptions: "off"` is treated exactly like a
 * 2025 connection here. Withdrawing the delivery without withdrawing the claim
 * would just recreate the lie one config key lower down.
 */
function advertisedCapabilities(capabilities: ServerCapabilities | undefined, era: Era, allowed: boolean): ServerCapabilities {
  const caps: ServerCapabilities = { ...capabilities };
  delete caps.logging;
  const pushes = era === 'modern' && allowed;
  // `listChanged: false` and an absent key mean the same thing to a client, and
  // the absent one is what the specification shows, so drop rather than negate.
  if (caps.tools) {
    const { listChanged, ...rest } = caps.tools;
    caps.tools = pushes && listChanged ? { ...rest, listChanged } : rest;
  }
  if (caps.prompts) {
    const { listChanged, ...rest } = caps.prompts;
    caps.prompts = pushes && listChanged ? { ...rest, listChanged } : rest;
  }
  if (caps.resources) {
    const { listChanged, subscribe, ...rest } = caps.resources;
    caps.resources = {
      ...rest,
      ...(pushes && listChanged ? { listChanged } : {}),
      ...(pushes && subscribe ? { subscribe } : {})
    };
  }
  return caps;
}

/**
 * Builds a per-request MCP Server that forwards every request verbatim to the
 * shared child client. A fresh Server per HTTP request plus a stateless
 * transport means no server-side session state at all — claude.ai reconnects
 * every few minutes without ever closing sessions, so anything stateful leaks.
 */
function buildProxyServer(managed: ManagedServer, secret: string, era: Era): Server {
  const server = new Server(
    { name: managed.serverInfo?.name ?? managed.name, version: managed.serverInfo?.version ?? '0.0.0' },
    { capabilities: advertisedCapabilities(managed.capabilities, era, subscriptionsAllowed(managed.config)) }
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
  const use = async <S extends ClientResultSchema>(
    request: { method: string; params?: unknown },
    resultSchema: S,
    options: ForwardOptions = {}
  ): Promise<StandardSchemaV1.InferOutput<S>> => {
    if (managed.state !== 'up' || !managed.client) await managed.wake();
    managed.markUsed();
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
      // client holding a stale schema would still reach it. Refused before the
      // forward, which is what wakes a sleeping server — so a forbidden name
      // cannot start one. The message is the neutral one a server gives for a
      // tool it does not have; announcing what was hidden would be a
      // disclosure in itself.
      if (!toolAllowed(managed.config, req.params.name)) {
        const logged = loggableToolName(req.params.name);
        console.warn(`[${managed.name}] refused tools/call "${logged}": not permitted by allowTools/denyTools`);
        throw new ProtocolError(ProtocolErrorCode.MethodNotFound, `Unknown tool: ${req.params.name}`);
      }
      // The caller's params go on unchanged: a gateway that rewrote them would
      // be inventing a contract the child never agreed to.
      const result = await forwardToolCall({ managed, tool: req.params.name, params: req.params, ctx, secret, via: 'server' });
      // A question for the person is not a tool result and has no schema to be
      // projected against.
      if (isInputRequiredResult(result)) return result;
      /**
       * The projection `McpServer` does for its own tools, which a hand-written
       * handler has to do for itself.
       *
       * It matters for one case, and only because this is a gateway: a child
       * whose `outputSchema` describes a non-object — an array, a number — is
       * advertised to a 2025-era client with that schema rewritten to
       * `{result: …}`, because that revision has nowhere else to put it. The
       * hub was already doing that half, for free, in `encodeResult`. Without
       * this line the *value* went out unwrapped, so the client validated an
       * array against a schema saying "object with a result key" and rejected
       * data that was never wrong.
       *
       * The advertised schema is the child's own, before the rewrite: the
       * codec decides from its root shape whether the wrap applies at all.
       */
      const advertised = managed.tools.find(t => t.name === req.params.name)?.outputSchema;
      return server.projectCallToolResult(result, advertised);
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
 * One route's long-lived half.
 *
 * The modern handler used to be built per request and closed when the response
 * closed. That is exactly the lifetime a `subscriptions/listen` stream cannot
 * have: it outlives the exchange that opened it, and the handler owns it. So
 * the handler is hoisted here, one per route, and the `res.on('close')` that
 * used to close it is gone — with a shared handler that line would have let the
 * first finished tool call tear down every other client's subscriptions.
 *
 * The legacy leg is untouched and stays per request, because a stateless
 * transport holds nothing worth keeping.
 */
export interface McpRoute extends RouteChannel {
  handler: McpHttpHandler;
  allowSubscriptions: () => boolean;
  buildLegacyServer: () => Server;
}

export interface RouteOptions {
  /** Called when the merged demand of this route's leases may have changed. */
  onDemandChange?: () => void;
  /**
   * Whether this route may take subscription leases at all. A thunk rather than
   * a boolean because a config reload can flip it under a live route.
   */
  allowSubscriptions?: () => boolean;
  /** Names this route in the log line for a failed modern-era request. */
  label: string;
}

export function createRoute(buildServer: (era: Era) => Server, options: RouteOptions): McpRoute {
  const allowSubscriptions = options.allowSubscriptions ?? (() => true);
  const handler = createMcpHandler(() => buildServer('modern'), {
    // Strict: the legacy era is served below, by the transport that has always
    // served it. A second, differently-behaving legacy path underneath this one
    // would be unreachable and misleading.
    legacy: 'reject',
    // Set rather than inherited. These bound what one route may hold open on
    // the hub's behalf, and a limit nobody wrote down is a limit nobody can
    // raise when a deployment needs it.
    maxSubscriptions: MAX_SUBSCRIPTIONS,
    keepAliveMs: KEEPALIVE_MS,
    onerror: error => console.error(`mcp-hub: modern-era request failed on ${options.label}: ${error.message}`)
  });
  const registry = new SubscriptionRegistry(handler.notify, { onDemandChange: options.onDemandChange });
  return {
    handler,
    registry,
    allowSubscriptions,
    buildLegacyServer: () => buildServer('legacy'),
    close: async () => {
      registry.close();
      await handler.close();
    }
  };
}

/**
 * Take a lease for a `subscriptions/listen` stream, or answer it outright.
 *
 * The filter has to be read here rather than left to the SDK: the event bus is
 * publish-only and never reports which URIs a stream asked for, so this is the
 * hub's only chance to learn what to hold upstream. The SDK still parses the
 * request properly a moment later and owns every error answer — the one refusal
 * made here is the URI cap, which is the hub's limit and nobody else's.
 *
 * Returns false when the request has already been answered.
 */
function beginListen(route: McpRoute, req: Request, res: Response): boolean {
  const filter = parseListenFilter(req.body);
  if (filter.resourceSubscriptions.length > MAX_SUBSCRIPTION_URIS) {
    res.status(400).json({
      jsonrpc: '2.0',
      error: { code: -32602, message: `A subscription may name at most ${MAX_SUBSCRIPTION_URIS} resource URIs` },
      id: null
    });
    return false;
  }
  // Node's server-wide requestTimeout (310s by default) would otherwise cut
  // every listen stream a few minutes in, which looks exactly like a flaky
  // upstream and is not. A listening stream is idle by design; its lifetime is
  // bounded by MAX_STREAM_MS below instead.
  req.setTimeout(0);
  const reaper =
    MAX_STREAM_MS > 0
      ? setTimeout(() => {
          // Ends the stream without the specification's graceful completion
          // result — the SDK owns the stream and offers no hook for one. The
          // client sees the same unexpected disconnect an HTTP timeout would
          // produce, which the specification names as a way a subscription
          // ends, and re-listens.
          res.end();
        }, MAX_STREAM_MS)
      : undefined;
  reaper?.unref();
  // A server whose operator switched subscriptions off advertises nothing and
  // is asked for nothing, so the stream stays open and silent rather than
  // taking a lease that would make the hub subscribe upstream on its behalf.
  const lease = route.allowSubscriptions() ? route.registry.acquire(filter) : undefined;
  let done = false;
  const release = () => {
    if (done) return;
    done = true;
    clearTimeout(reaper);
    lease?.release();
  };
  res.once('close', release);
  res.once('finish', release);
  return true;
}

/**
 * Handle one MCP request in whichever protocol era it arrives in.
 *
 * `isLegacyRequest` decides, and its contract is one-way: everything it calls
 * false — including a malformed envelope or a header/body mismatch — belongs to
 * the modern handler, which owns those error answers. Only what it calls true
 * may reach the legacy path.
 */
export async function handleMcpRequest(route: McpRoute, req: Request, res: Response): Promise<void> {
  const probe = await toWebRequest(req, req.body);
  if (await isLegacyRequest(probe)) {
    await handleLegacyRequest(route.buildLegacyServer, req, res);
    return;
  }
  if (isListenRequest(req.body) && !beginListen(route, req, res)) return;
  await toNodeHandler(route.handler)(req, res, req.body);
}

/**
 * The route behind each server path, created on first use and closed with the
 * server. Held here rather than constructed per request because the handler
 * inside owns open subscription streams.
 */
function routeFor(managed: ManagedServer, secret: string): McpRoute {
  if (!managed.channel) {
    managed.channel = createRoute(era => buildProxyServer(managed, secret, era), {
      label: `/${managed.name}`,
      onDemandChange: () => managed.reconcileSubscriptions(),
      allowSubscriptions: () => subscriptionsAllowed(managed.config)
    });
  }
  return managed.channel as McpRoute;
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
    // Deliberately not `use()`: opening a listen stream is not usage. A client
    // that subscribes to a sleeping child gets an honest acknowledgment built
    // from the cached capabilities — they survive the nap — and delivery
    // resumes when something actually wakes it. Waking on subscribe would undo
    // on-demand for every server anyone ever watched.
    await handleMcpRequest(routeFor(managed, secret), req, res);
  };
}
