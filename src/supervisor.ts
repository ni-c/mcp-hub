import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import { Client, StreamableHTTPClientTransport, SSEClientTransport, UnauthorizedError } from '@modelcontextprotocol/client';
import type { Transport, ServerCapabilities, Implementation, Tool, McpSubscription, SubscriptionFilter } from '@modelcontextprotocol/client';
import type { ServerEvent } from '@modelcontextprotocol/server';
import { ListToolsResultSchema } from '@modelcontextprotocol/core';
import { VERSION } from './version.js';
import { MAX_TOOL_LIST_PAGES, MAX_TOOLS, MAX_TOOL_METADATA_BYTES, jsonSize } from './mcp-limits.js';
import {
  BACKOFF_INITIAL_MS,
  BACKOFF_MAX_MS,
  BACKOFF_RESET_AFTER_MS,
  IDLE_SWEEP_INTERVAL_MS,
  MAX_UNUSED_RESTARTS,
  PING_INTERVAL_MS,
  PING_TIMEOUT_MS,
  WAKE_TIMEOUT_MS
} from './timings.js';
import type { HubConfig, ServerConfig, RemoteServerConfig, ConfigDiff } from './config.js';
import { SocketTransport } from './transports/socket.js';
import { DockerTransport } from './transports/docker.js';
import { DockerClient, parseSandboxDockerHost } from './sandbox/docker-client.js';
import type { AuthStore } from './auth/store.js';
import { UpstreamAuth, UpstreamLoginRequiredError } from './upstream/auth.js';
import { credentialFingerprint } from './upstream/provider.js';
import { ToolCache } from './tool-cache.js';
import type { ToolCacheEntry } from './tool-cache.js';
import { filterTools, hasToolFilter, unmatchedPatterns } from './tool-filter.js';
import type { RouteChannel, SubscriptionRegistry } from './subscriptions.js';
import { subscriptionsAllowed } from './subscriptions.js';

export type ServerState = 'starting' | 'up' | 'down' | 'stopped' | 'sleeping' | 'unauthorized';

/**
 * Whether a failure is one a restart could fix.
 *
 * Only two things mean "a human has to act": our own manager saying there is no
 * usable credential, and the SDK giving up on authorization. Everything else —
 * DNS, a 5xx, a timeout — is transient and must keep its backoff, or an
 * upstream that would have recovered on its own would need manual attention.
 */
function classifyAuthFailure(error: unknown): 'restart' | 'unauthorized' {
  return error instanceof UpstreamLoginRequiredError || error instanceof UnauthorizedError ? 'unauthorized' : 'restart';
}

/**
 * Whether this connection's protocol revision still has `ping`.
 *
 * `2026-07-28` removed it. Asked on that era the SDK refuses rather than
 * sending anything, so a liveness probe there is not a failed ping — it is a
 * question that no longer exists. Everything older has it.
 *
 * Read from the connection rather than from the config, because the era is not
 * a property of the server we configured: it is the outcome of the opening
 * exchange with the server that actually answered.
 */
function eraHasPing(client: Client): boolean {
  const era = client.getNegotiatedProtocolVersion?.();
  // Undefined means the SDK has not recorded one, which is every revision that
  // predates the negotiation API. Those all have ping.
  return era === undefined || era < '2026-07-28';
}

/**
 * Remote upstreams get their configured headers on EVERY request via a fetch
 * wrapper — requestInit alone does not cover the SSE stream GET.
 */
function buildRemoteTransport(config: RemoteServerConfig, auth?: UpstreamAuth): Transport {
  const url = new URL(config.url);
  const headers = config.headers;
  if (auth) {
    // Deliberately no `requestInit`: the transport merges those headers *after*
    // the OAuth Authorization header, so a static one would win — and the SDK
    // would carry them to the authorization server as well, because the fetch
    // it uses for tokens is the same object. The auth manager's own fetch adds
    // the configured headers to upstream requests only.
    const guarded = auth.createFetch();
    return config.transport === 'sse'
      ? new SSEClientTransport(url, { authProvider: auth.provider(), fetch: guarded })
      : new StreamableHTTPClientTransport(url, { authProvider: auth.provider(), fetch: guarded });
  }
  const fetchWithHeaders: typeof fetch = (input, init) => {
    const merged = new Headers(init?.headers);
    for (const [key, value] of Object.entries(headers)) {
      if (!merged.has(key)) merged.set(key, value);
    }
    return fetch(input, { ...init, headers: merged });
  };
  if (config.transport === 'sse') {
    return new SSEClientTransport(url, { requestInit: { headers }, fetch: fetchWithHeaders });
  }
  return new StreamableHTTPClientTransport(url, { requestInit: { headers }, fetch: fetchWithHeaders });
}

let sharedDockerClient: DockerClient | undefined;

/**
 * One Docker connection for the whole hub, pointed at DOCKER_HOST — which in
 * the documented deployment is not the daemon but the policy proxy's socket.
 */
export function dockerClient(): DockerClient {
  return (sharedDockerClient ??= new DockerClient(parseSandboxDockerHost(process.env.DOCKER_HOST)));
}

/** Tests inject a stub here; passing undefined restores the DOCKER_HOST client. */
export function setDockerClient(client: DockerClient | undefined): void {
  sharedDockerClient = client;
}


/** How an on-demand server behaves; an empty object means "always running" (today's behaviour). */
export interface ManagedServerOptions {
  /** Sleep when idle, wake on use, give up restarting a crashed server nobody asks for. */
  onDemand?: boolean;
  /** Idle window after which an on-demand server is put to sleep. */
  idleMs?: number;
  /** Called with fresh serverInfo/capabilities/tools worth caching. */
  persist?: (server: ManagedServer) => void;
  /** How long wake() blocks a request before giving up. */
  wakeTimeoutMs?: number;
  /** Failed restarts without any use before the hub gives up until the next wake. */
  maxUnusedRestarts?: number;
  /** Test hook: initial restart backoff. */
  backoffInitialMs?: number;
  /** Outbound OAuth for a remote server that needs it. Injected here rather
   *  than built in buildTransport(), which runs on every single start. */
  auth?: UpstreamAuth;
  /** Every change event this child emits, for listeners that are not its own
   *  route — today only the /hub aggregate, whose tool list spans all children. */
  onUpstreamEvent?: (event: ServerEvent) => void;
  /**
   * Whether anyone listening on /hub wants tool-list changes.
   *
   * A child has to be told to watch its tool list when the only interested
   * party is the aggregate, not this child's own route. Without it the hub
   * subscribes to nothing upstream and the /hub listener waits forever for an
   * event the hub was never sent.
   */
  aggregateWantsTools?: () => boolean;
}

/** Whether two upstream listen filters ask for the same thing. */
function sameFilter(a: SubscriptionFilter | undefined, b: SubscriptionFilter): boolean {
  if (!a) return false;
  // JSON rather than a joined string: with a plain separator, ['a b'] and
  // ['a', 'b'] compare equal, and the hub would skip a reconcile it owed.
  const uris = (filter: SubscriptionFilter) => JSON.stringify([...(filter.resourceSubscriptions ?? [])].sort());
  return (
    (a.toolsListChanged ?? false) === (b.toolsListChanged ?? false) &&
    (a.promptsListChanged ?? false) === (b.promptsListChanged ?? false) &&
    (a.resourcesListChanged ?? false) === (b.resourcesListChanged ?? false) &&
    uris(a) === uris(b)
  );
}

/** Whether a filter asks for nothing at all, in which case nothing is held upstream. */
function emptyFilter(filter: SubscriptionFilter): boolean {
  return (
    !filter.toolsListChanged &&
    !filter.promptsListChanged &&
    !filter.resourcesListChanged &&
    (filter.resourceSubscriptions?.length ?? 0) === 0
  );
}

interface WakeWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export async function listAllTools(client: Pick<Client, 'request'>): Promise<Tool[]> {
  const tools: Tool[] = [];
  let cursor: string | undefined;
  let pages = 0;
  let metadataBytes = 0;
  const seenCursors = new Set<string>();
  do {
    if (++pages > MAX_TOOL_LIST_PAGES) throw new Error(`tools/list exceeded ${MAX_TOOL_LIST_PAGES} pages`);
    // `request` rather than `listTools`, deliberately. SDK v2's `listTools()`
    // walks the whole pagination itself whenever no cursor is given -- which is
    // every first call -- and hands back one merged result. That would collapse
    // this loop into a single iteration and take all three budgets below with
    // it, leaving only the SDK's own page cap and no limit on tool count or
    // metadata size at all. The budgets exist because a hostile child's tool
    // list is a way to exhaust the hub's memory, and with it every other
    // server's availability. One page per request is what makes them apply.
    const page = await client.request({ method: 'tools/list', params: { cursor } }, ListToolsResultSchema);
    metadataBytes += jsonSize(page.tools);
    if (metadataBytes > MAX_TOOL_METADATA_BYTES) throw new Error(`tools/list metadata exceeded ${MAX_TOOL_METADATA_BYTES} bytes`);
    tools.push(...page.tools);
    if (tools.length > MAX_TOOLS) throw new Error(`tools/list exceeded ${MAX_TOOLS} tools`);
    cursor = page.nextCursor;
    if (cursor && seenCursors.has(cursor)) throw new Error('tools/list repeated a pagination cursor');
    if (cursor) seenCursors.add(cursor);
  } while (cursor);
  return tools;
}

export class ManagedServer {
  state: ServerState = 'starting';
  client?: Client;
  serverInfo?: Implementation;
  capabilities?: ServerCapabilities;
  tools: Tool[] = [];
  /**
   * How many tools the filter removed, for /health, and which entries matched
   * nothing. Both stay `undefined` until the server has actually listed its
   * tools: a snapshot restored from tool-cache.json is *already* filtered, so
   * neither can be recomputed from it — every denyTools entry would look
   * unmatched. `undefined` means "not measured yet", and /health omits it
   * rather than reporting a zero it did not earn.
   */
  toolsHidden?: number;
  filterUnmatched?: string[];
  restarts = 0;
  lastError?: string;
  /** Last time a request was actually forwarded; the idle sweep measures from here. */
  lastUsedAt = 0;
  /**
   * What the clients on this server's route are listening for. Created by the
   * proxy, which owns the route's handler; the supervisor only publishes into
   * it and reads its merged demand.
   *
   * Deliberately not consulted by the idle sweep: an open subscription is an
   * intent, not a reason to keep a child process running. A sleeping child
   * emits nothing, and the resync on the next wake is what makes that gap
   * recoverable instead of silent.
   */
  channel?: RouteChannel;

  /** The lease book of this server's route, or nothing if no client ever asked. */
  private get subscriptions(): SubscriptionRegistry | undefined {
    return this.channel?.registry;
  }

  private backoffMs: number;
  private startedAt = 0;
  private restartTimer?: NodeJS.Timeout;
  private pingTimer?: NodeJS.Timeout;
  private stopping = false;
  /** Failed restarts since the last real use; wake() and markUsed() reset it. */
  private restartsSinceUse = 0;
  private wakeWaiters: WakeWaiter[] = [];
  /**
   * Invalidates callbacks of an abandoned transport: sleep() and stop() tear a
   * server down and later wake() builds a fresh transport on the *same*
   * instance, so a straggling onclose from the old one must not be able to
   * kill the new child.
   */
  private generation = 0;
  /** The one upstream listen stream carrying this route's whole demand (modern era). */
  private upstream?: McpSubscription;
  private upstreamFilter?: SubscriptionFilter;
  /** URIs the child was told about one at a time (2025 era). */
  private upstreamUris = new Set<string>();
  private reconciling = false;
  private reconcileQueued = false;

  constructor(
    readonly name: string,
    public config: ServerConfig,
    private readonly options: ManagedServerOptions = {}
  ) {
    this.backoffMs = options.backoffInitialMs ?? BACKOFF_INITIAL_MS;
  }

  get onDemand(): boolean {
    return this.options.onDemand === true;
  }

  get idleMs(): number {
    return this.options.idleMs ?? 0;
  }

  /** Whether initialize/tools/list can be answered without a running child. */
  get hasSnapshot(): boolean {
    return this.serverInfo !== undefined || this.tools.length > 0;
  }

  /** Boot a server straight into `sleeping` from a cached snapshot. */
  hydrate(entry: ToolCacheEntry): void {
    this.serverInfo = entry.serverInfo;
    this.capabilities = entry.capabilities;
    // Filtered again although the cache fingerprint covers the whole
    // ServerConfig: "managed.tools only ever holds allowed tools" should hold
    // however the array arrived, including a hand-seeded tool-cache.json.
    this.tools = filterTools(this.config, entry.tools);
    this.state = 'sleeping';
  }

  markUsed(): void {
    this.lastUsedAt = Date.now();
    this.restartsSinceUse = 0;
  }

  /**
   * Resolves once the server is up. Concurrent callers all attach to the one
   * in-flight start — there is never a second child. A crash inside the wake
   * window is retried by the normal backoff; only the timeout rejects.
   */
  wake(): Promise<void> {
    if (this.state === 'up' && this.client) return Promise.resolve();
    if (this.state === 'stopped') return Promise.reject(new Error(`Server "${this.name}" is stopped`));
    // Without this the request would sit in a waiter nothing can resolve until
    // the wake timeout, two minutes later.
    if (this.state === 'unauthorized') {
      return Promise.reject(new Error(`Server "${this.name}" needs an upstream login`));
    }
    const timeoutMs = this.options.wakeTimeoutMs ?? WAKE_TIMEOUT_MS;
    const promise = new Promise<void>((resolve, reject) => {
      const waiter: WakeWaiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.wakeWaiters = this.wakeWaiters.filter(w => w !== waiter);
          const detail = this.lastError ? `: ${this.lastError}` : '';
          reject(new Error(`Server "${this.name}" did not start within ${Math.round(timeoutMs / 1000)}s${detail}`));
        }, timeoutMs)
      };
      waiter.timer.unref();
      this.wakeWaiters.push(waiter);
    });
    if (this.state === 'sleeping') {
      this.restartsSinceUse = 0;
      this.backoffMs = this.options.backoffInitialMs ?? BACKOFF_INITIAL_MS;
      void this.start();
    } else if (this.state === 'down') {
      // Someone is asking — no point in sitting out the rest of the backoff.
      clearTimeout(this.restartTimer);
      void this.start();
    }
    // 'starting': the in-flight start resolves the waiter.
    return promise;
  }

  private resolveWakeWaiters(): void {
    const waiters = this.wakeWaiters;
    this.wakeWaiters = [];
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
  }

  private rejectWakeWaiters(error: Error): void {
    const waiters = this.wakeWaiters;
    this.wakeWaiters = [];
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  private buildTransport(): Transport {
    switch (this.config.kind) {
      case 'remote':
        return buildRemoteTransport(this.config, this.options.auth);
      case 'socket':
        return new SocketTransport(this.config);
      case 'docker':
        return new DockerTransport(this.name, this.config, dockerClient());
      case 'stdio':
        return new StdioClientTransport({
          command: this.config.command,
          args: this.config.args,
          env: { ...getDefaultEnvironment(), ...this.config.env },
          stderr: 'inherit'
        });
    }
  }

  /** What "it went away" means for this kind of server, in the operator's words. */
  private exitReason(): string {
    switch (this.config.kind) {
      case 'remote':
        return 'connection closed';
      case 'socket':
        return 'socket closed';
      case 'docker':
        return 'container exited';
      case 'stdio':
        return 'child process exited';
    }
  }

  async start(): Promise<void> {
    this.stopping = false;
    this.state = 'starting';
    const generation = ++this.generation;
    if (this.options.auth) {
      // Getting a token is the one part of connecting that a restart cannot
      // fix, so it happens first and its failure is classified separately.
      try {
        await this.options.auth.prepare();
      } catch (error) {
        if (generation !== this.generation) return;
        this.onExit(`upstream authorization: ${(error as Error).message}`, generation, classifyAuthFailure(error));
        return;
      }
    }
    const transport = this.buildTransport();
    const client = new Client(
      { name: 'mcp-hub', version: VERSION },
      {
        // Still nothing. The hub is not the one who can answer an elicitation —
        // the person at the far end is — so declaring the capability on this
        // shared connection would be a promise the hub cannot keep. What it
        // declares per forwarded request is a different matter.
        capabilities: {},
        // 'auto' probes with server/discover and falls back to the 2025
        // sequence when the child does not answer it, so a legacy child
        // connects exactly as before. What it buys is the modern era where the
        // child supports it: there, input_required comes back as a *result*
        // the hub can forward, instead of a server→client request it would
        // have nowhere to put.
        versionNegotiation: { mode: 'auto' },
        // The client would otherwise answer an input_required itself — from
        // handlers the hub never registered, so every elicitation would be
        // silently declined on the caller's behalf. A gateway has to hand the
        // question on, not answer it.
        inputRequired: { autoFulfill: false }
      }
    );
    transport.onclose = () => this.onExit(this.exitReason(), generation);
    try {
      await client.connect(transport);
    } catch (error) {
      this.onExit(`failed to start: ${(error as Error).message}`, generation, classifyAuthFailure(error));
      return;
    }
    if (generation !== this.generation) {
      // sleep()/stop() ran while we were connecting; it already set the final
      // state, so this child is surplus and only needs to go away again.
      await client.close().catch(() => {});
      return;
    }
    this.client = client;
    this.serverInfo = client.getServerVersion();
    this.capabilities = client.getServerCapabilities();
    this.state = 'up';
    this.startedAt = Date.now();
    // The start itself opens a full idle window, so a pre-warmed server is not
    // swept away just before the tool call it was warmed for.
    this.lastUsedAt = this.startedAt;
    console.log(`[${this.name}] up (${this.serverInfo?.name ?? 'unknown'} ${this.serverInfo?.version ?? ''})`.trim());
    this.resolveWakeWaiters();
    if (this.capabilities?.tools) {
      client.setNotificationHandler('notifications/tools/list_changed', () => {
        void this.refreshTools();
        this.publishUpstream({ kind: 'tools_list_changed' });
      });
      await this.refreshTools();
    } else {
      this.options.persist?.(this);
    }
    this.watchUpstream(client);
    // A subscription taken while this child was asleep is an intent, not a
    // connection: nothing was held upstream, so it has to be re-established
    // here rather than at the moment the client asked. The same is true after
    // a crash — shutdown() throws the client away and every subscription with
    // it. Without this a subscription is silently dead from the first nap on.
    this.reconcileSubscriptions();
    // And because nothing was held, the hub cannot know what changed while the
    // child was gone. Telling the listeners to read everything again is the
    // only honest answer.
    this.subscriptions?.resync();
    // The aggregate's tool list spans this child, so its listeners have the
    // same gap: whatever changed while the child was away is invisible to them
    // too. One re-read tells them so.
    if (this.options.aggregateWantsTools?.() === true) this.options.onUpstreamEvent?.({ kind: 'tools_list_changed' });
    this.pingTimer = setInterval(() => void this.checkAlive(), PING_INTERVAL_MS);
    this.pingTimer.unref();
  }

  /** One change event to this route's listeners and to the /hub aggregate. */
  private publishUpstream(event: ServerEvent): void {
    this.subscriptions?.publish(event);
    this.options.onUpstreamEvent?.(event);
  }

  /**
   * Route the child's change notifications to the clients waiting for them.
   *
   * The same four handlers serve both eras. On a 2025 connection the child
   * sends these unsolicited; on 2026-07-28 they arrive on the listen stream
   * that `reconcileSubscriptions` opens, and the SDK dispatches them to these
   * very registrations. So the era difference is confined to *asking*, not to
   * receiving — which is the whole reason this is one code path.
   *
   * Gated on the declared capability for the same reason the handlers below
   * are only registered for what the child said it has: a handler for a
   * notification the child cannot send is a claim nobody checked.
   */
  private watchUpstream(client: Client): void {
    if (this.capabilities?.prompts) {
      client.setNotificationHandler('notifications/prompts/list_changed', () => this.publishUpstream({ kind: 'prompts_list_changed' }));
    }
    if (this.capabilities?.resources) {
      client.setNotificationHandler('notifications/resources/list_changed', () => this.publishUpstream({ kind: 'resources_list_changed' }));
      client.setNotificationHandler('notifications/resources/updated', notification =>
        this.publishUpstream({ kind: 'resource_updated', uri: notification.params.uri })
      );
    }
  }

  /**
   * Bring what the child is told to watch in line with what the clients want.
   *
   * Fire-and-forget with a single-flight guard: it is called from lease
   * acquire/release, which happen on the request path and must not wait for an
   * upstream round trip. A change arriving mid-reconcile queues exactly one
   * more pass, so the last caller's demand always wins without a backlog.
   */
  reconcileSubscriptions(): void {
    if (this.reconciling) {
      this.reconcileQueued = true;
      return;
    }
    this.reconciling = true;
    void this.runReconcile()
      .catch(error => console.error(`[${this.name}] could not update subscriptions: ${(error as Error).message}`))
      .finally(() => {
        this.reconciling = false;
        if (!this.reconcileQueued) return;
        this.reconcileQueued = false;
        this.reconcileSubscriptions();
      });
  }

  private async runReconcile(): Promise<void> {
    const client = this.client;
    const registry = this.subscriptions;
    // Asleep, down, or nobody listening: there is nothing to hold. State is not
    // dropped — it lives in the leases, and start() replays it.
    if (!client || this.state !== 'up') return;
    if (!subscriptionsAllowed(this.config)) return;
    const demand = registry?.demand() ?? { toolsListChanged: false, promptsListChanged: false, resourcesListChanged: false, uris: [] };
    // The union spans both books: this route's leases and the aggregate's.
    const wantsTools = demand.toolsListChanged || this.options.aggregateWantsTools?.() === true;
    // A child that never advertised `subscribe` cannot be asked for resource
    // updates; asking anyway earns a -32601 per URI and nothing else.
    const canSubscribe = this.capabilities?.resources?.subscribe === true;
    const uris = canSubscribe ? demand.uris : [];
    if (client.getProtocolEra() === 'modern') {
      await this.reconcileModern(client, {
        toolsListChanged: wantsTools && this.capabilities?.tools?.listChanged === true,
        promptsListChanged: demand.promptsListChanged && this.capabilities?.prompts?.listChanged === true,
        resourcesListChanged: demand.resourcesListChanged && this.capabilities?.resources?.listChanged === true,
        resourceSubscriptions: uris
      });
      return;
    }
    await this.reconcileLegacy(client, uris);
  }

  /**
   * One listen stream carries the whole route's demand.
   *
   * A filter cannot be widened in place, so any change to the union means
   * closing the stream and opening a new one. That is a real gap — a
   * notification landing between the two is lost — which is why the reopen is
   * followed by nothing: the client that just subscribed gets its resync from
   * the acquire path, and the ones already listening were not affected by
   * whatever the new lease added.
   */
  private async reconcileModern(client: Client, filter: SubscriptionFilter): Promise<void> {
    if (sameFilter(this.upstreamFilter, filter)) return;
    const previous = this.upstream;
    this.upstream = undefined;
    this.upstreamFilter = undefined;
    if (previous) await previous.close().catch(() => {});
    if (emptyFilter(filter)) return;
    const subscription = await client.listen(filter);
    // A close() racing the await above already cleared the field; honour that
    // rather than installing a stream nobody wants.
    if (this.client !== client) {
      await subscription.close().catch(() => {});
      return;
    }
    this.upstream = subscription;
    this.upstreamFilter = filter;
  }

  /**
   * The 2025 era asks per URI and gets list_changed unsolicited, so only the
   * resource set is negotiated — as a diff, because re-subscribing a URI the
   * child already holds is a round trip that buys nothing.
   */
  private async reconcileLegacy(client: Client, uris: string[]): Promise<void> {
    const wanted = new Set(uris);
    for (const uri of wanted) {
      if (this.upstreamUris.has(uri)) continue;
      await client.subscribeResource({ uri });
      this.upstreamUris.add(uri);
    }
    // Snapshotted before the loop, which removes from the very set it reads.
    const stale = [...this.upstreamUris].filter(uri => !wanted.has(uri));
    for (const uri of stale) {
      await client.unsubscribeResource({ uri }).catch(() => {});
      this.upstreamUris.delete(uri);
    }
  }

  /**
   * Says what the filter did, at the one moment the operator is looking: a
   * filter edit bounces this server, so this prints seconds later. That is why
   * an unmatched entry need not be fatal here, unlike in the ni-c servers where
   * the tool names are known before anything starts.
   */
  private reportToolFilter(upstream: Tool[]): void {
    if (!hasToolFilter(this.config)) return;
    this.toolsHidden = upstream.length - this.tools.length;
    this.filterUnmatched = unmatchedPatterns(this.config, upstream);
    console.log(`[${this.name}] tool filter: ${this.tools.length} of ${upstream.length} tools exposed`);
    for (const pattern of this.filterUnmatched) {
      console.warn(`[${this.name}] tool filter: no tool matches "${pattern}"`);
    }
  }

  private async refreshTools(): Promise<void> {
    // Hold the client locally: onExit() clears this.client, and a paged list
    // spans awaits, so re-reading it per page could hit undefined mid-loop.
    const client = this.client;
    if (!client) return;
    try {
      // Filtered AFTER listAllTools, never inside it: that function enforces the
      // MAX_TOOLS and metadata-byte budgets against the raw upstream, and
      // filtering earlier would let an upstream bury payload in tools it knows
      // are filtered.
      const upstream = await listAllTools(client);
      this.tools = filterTools(this.config, upstream);
      this.reportToolFilter(upstream);
      this.options.persist?.(this);
    } catch (error) {
      console.error(`[${this.name}] failed to list tools: ${(error as Error).message}`);
    }
  }

  private async checkAlive(): Promise<void> {
    // The ping usually fails *because* the connection went away, in which case
    // transport.onclose -> onExit has already set this.client to undefined by
    // the time the catch block runs. Reading this.client.close() there throws
    // synchronously, so the attached .catch() never applies and the rejection
    // escapes this method — setInterval() discards the promise, so it surfaced
    // as an unhandled rejection with a misleading stack. Holding the client in
    // a local makes the whole method immune to that reassignment.
    const client = this.client;
    if (this.state !== 'up' || !client) return;
    // `ping` does not exist on 2026-07-28: the revision removed it, and the SDK
    // refuses to send one rather than inventing an RPC the far end never had.
    // Without this check the refusal reads as a dead child and the supervisor
    // restarts a server that is perfectly healthy — forever, with the backoff
    // climbing. Seen in production the morning after 0.11.0 went out: two
    // remote children that happened to speak the modern era flapped every
    // interval while the rest of the hub was fine.
    //
    // Nothing replaces it. On that era liveness is the transport's business,
    // which is where it always was for a stdio child: the process exits, the
    // transport closes, onExit restarts it. What an HTTP child on the modern
    // era loses is the *active* probe — a server that stops answering without
    // closing is noticed at the next real call rather than within a minute.
    // Sending some other request as a substitute heartbeat would be worse: it
    // would be a call the operator never asked for, against a server that
    // charges for it or logs it, every interval, forever.
    if (!eraHasPing(client)) return;
    try {
      await client.ping({ timeout: PING_TIMEOUT_MS });
    } catch (error) {
      console.error(`[${this.name}] ping failed, restarting: ${(error as Error).message}`);
      // close() triggers transport.onclose -> onExit -> restart with backoff.
      // Already-closed transports reject here; onExit has then run regardless.
      await client.close().catch(() => {});
    }
  }

  private onExit(reason: string, generation = this.generation, outcome: 'restart' | 'unauthorized' = 'restart'): void {
    // A callback from a transport that sleep()/stop()/a newer start() already
    // left behind must not touch the current child.
    if (generation !== this.generation) return;
    // A failed start reports twice: transport.onclose fires and start()'s catch
    // calls us as well. Without this guard the second call would overwrite
    // restartTimer without clearing it, so two children would be spawned and
    // one of them left unreferenced — never pinged, never stopped.
    if (this.state === 'down' || this.state === 'stopped' || this.state === 'sleeping' || this.state === 'unauthorized') return;
    clearInterval(this.pingTimer);
    this.client = undefined;
    if (this.stopping) {
      this.state = 'stopped';
      return;
    }
    if (outcome === 'unauthorized') {
      // Restarting cannot help: the upstream wants a human. Sitting in a
      // five-minute retry loop forever would only hammer it and hide the reason
      // behind a state that looks like an ordinary outage.
      this.state = 'unauthorized';
      this.lastError = reason;
      this.rejectWakeWaiters(new Error(`Server "${this.name}" needs an upstream login`));
      console.error(`[${this.name}] unauthorized (${reason}); run: mcp-hub-admin upstream login ${this.name}`);
      return;
    }
    this.state = 'down';
    this.lastError = reason;
    if (this.startedAt > 0 && Date.now() - this.startedAt > BACKOFF_RESET_AFTER_MS) {
      this.backoffMs = this.options.backoffInitialMs ?? BACKOFF_INITIAL_MS;
    }
    this.restartsSinceUse++;
    if (this.onDemand && this.restartsSinceUse > (this.options.maxUnusedRestarts ?? MAX_UNUSED_RESTARTS)) {
      // A crash-looping server nobody asks for would occupy the machine
      // forever. Give up until the next wake, which starts fresh.
      console.error(`[${this.name}] down (${reason}), giving up until next use after ${this.restartsSinceUse - 1} failed restarts`);
      this.state = 'sleeping';
      this.rejectWakeWaiters(new Error(`Server "${this.name}" failed to start: ${reason}`));
      return;
    }
    console.error(`[${this.name}] down (${reason}), restarting in ${Math.round(this.backoffMs / 1000)}s`);
    this.restartTimer = setTimeout(() => {
      this.restarts++;
      void this.start();
    }, this.backoffMs);
    this.restartTimer.unref();
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
  }

  /**
   * Try again now that a credential may exist — called after the callback route
   * completed a login, or by the admin CLI's refresh. Does nothing unless the
   * server is actually waiting for one.
   */
  reauthorize(): void {
    if (this.state !== 'unauthorized') return;
    this.backoffMs = this.options.backoffInitialMs ?? BACKOFF_INITIAL_MS;
    // onExit() ignores a report while the state is already terminal, so it has
    // to be left before the next attempt can report anything.
    this.state = 'down';
    void this.start();
  }

  private async shutdown(): Promise<void> {
    this.stopping = true;
    // Bump the generation first: the onclose this close() is about to trigger
    // must be a no-op, because the caller sets the final state itself.
    this.generation++;
    clearTimeout(this.restartTimer);
    clearInterval(this.pingTimer);
    // The upstream subscription belongs to the connection that is going away.
    // Forgetting it here is what makes the next start() reconcile from scratch
    // instead of believing a stream it no longer holds is still open. The
    // leases themselves are untouched — they are the clients' intent, and they
    // outlive any one child process.
    this.upstream = undefined;
    this.upstreamFilter = undefined;
    this.upstreamUris.clear();
    this.rejectWakeWaiters(new Error(`Server "${this.name}" is shutting down`));
    // Same local-client rule as checkAlive(). This path happens to be safe
    // today because the member access precedes the await, but Supervisor.stop()
    // and applyDiff() await it, so an escaping rejection would land in the
    // shutdown and config-reload paths. Structural, not incidental.
    const client = this.client;
    if (client) {
      await client.close().catch(() => {});
      this.client = undefined;
    }
  }

  async stop(): Promise<void> {
    await this.shutdown();
    this.state = 'stopped';
    // Unlike sleep(), this server is not coming back: the route's handler holds
    // open listen streams and would otherwise outlive everything it serves.
    const channel = this.channel;
    this.channel = undefined;
    await channel?.close().catch(() => {});
  }

  /** Same teardown as stop(), but the server stays wakeable. */
  async sleep(): Promise<void> {
    if (this.state === 'sleeping' || this.state === 'stopped') return;
    await this.shutdown();
    this.state = 'sleeping';
    this.stopping = false;
  }
}

export interface SupervisorOptions {
  /** Global idle timeout for on-demand servers; 0 (the default) disables on-demand lifecycling entirely. */
  idleTimeoutMinutes?: number;
  /**
   * The same timeout in milliseconds, for callers who need it finer than a
   * minute. Wins over `idleTimeoutMinutes` when set; `0`/absent leaves the
   * minute value in charge, so it cannot also express "never sleep" — that is
   * `idleTimeoutMinutes: 0`, which already means it.
   */
  idleTimeoutMs?: number;
  cache?: ToolCache;
  sweepIntervalMs?: number;
  wakeTimeoutMs?: number;
  /** Backs outbound OAuth for remote servers. Absent in stdio mode without a
   *  DATA_PATH, where there is nowhere to keep a token. */
  upstreamAuth?: UpstreamAuthRegistry;
}

/**
 * One credential manager per server name, outliving the ManagedServer.
 *
 * applyDiff() throws the ManagedServer away and builds a new one for any config
 * change at all — a header edit included — so a manager held there would lose
 * its in-flight refresh and its single-flight guarantee whenever the config file
 * was touched. Keyed by name and rebuilt only when the credential fingerprint
 * actually changes.
 */
export class UpstreamAuthRegistry {
  private readonly managers = new Map<string, { fingerprint: string; auth: UpstreamAuth }>();

  constructor(
    private readonly store: AuthStore,
    private readonly externalUrl: string
  ) {}

  for(name: string, config: RemoteServerConfig): UpstreamAuth | undefined {
    if (!config.oauth) return undefined;
    const auth = new UpstreamAuth(name, config, this.store, this.externalUrl);
    const fingerprint = credentialFingerprint(auth.identity);
    const existing = this.managers.get(name);
    if (existing?.fingerprint === fingerprint) return existing.auth;
    this.managers.set(name, { fingerprint, auth });
    return auth;
  }

  get(name: string): UpstreamAuth | undefined {
    return this.managers.get(name)?.auth;
  }

  forget(name: string): void {
    this.managers.delete(name);
  }
}

export class Supervisor {
  readonly servers = new Map<string, ManagedServer>();
  private initialStarts: Promise<void>[] = [];
  private sweepTimer?: NodeJS.Timeout;

  constructor(
    private config: HubConfig,
    private readonly options: SupervisorOptions = {}
  ) {}

  private get idleTimeoutMinutes(): number {
    return this.options.idleTimeoutMinutes ?? 0;
  }

  /** The global idle timeout as one number, whichever unit the caller gave it in. */
  private get idleTimeoutMs(): number {
    return this.options.idleTimeoutMs || this.idleTimeoutMinutes * 60_000;
  }

  /**
   * What the clients on the /hub route are listening for.
   *
   * /hub exposes tools and nothing else, so the only change worth relaying is
   * "some child's tool list moved, re-read mine". Set by the proxy, which owns
   * that route's handler.
   */
  hubSubscriptions?: SubscriptionRegistry;

  /**
   * Relay a child's change event to the /hub aggregate.
   *
   * Only the tool list crosses: /hub does not aggregate resources or prompts,
   * so a resources/list_changed from one child describes nothing a /hub client
   * can read. Sending it anyway would be the same kind of empty promise the
   * capability table exists to prevent.
   */
  private onChildEvent(cfg: ServerConfig, event: ServerEvent): void {
    if (event.kind !== 'tools_list_changed') return;
    if (cfg.hub === false || !subscriptionsAllowed(cfg)) return;
    this.hubSubscriptions?.publish(event);
  }

  /**
   * Bring every child's upstream subscription in line.
   *
   * Called when the /hub aggregate's demand moves, because that one book is
   * shared by all of them — unlike a per-server route, where only its own
   * child is affected.
   */
  reconcileAll(): void {
    for (const server of this.servers.values()) server.reconcileSubscriptions();
  }

  private aggregateWantsTools(cfg: ServerConfig): boolean {
    if (cfg.hub === false || !subscriptionsAllowed(cfg)) return false;
    return this.hubSubscriptions?.demand().toolsListChanged === true;
  }

  private buildManaged(name: string, cfg: ServerConfig): ManagedServer {
    const onUpstreamEvent = (event: ServerEvent) => this.onChildEvent(cfg, event);
    const aggregateWantsTools = () => this.aggregateWantsTools(cfg);
    if ((cfg.kind !== 'stdio' && cfg.kind !== 'docker') || cfg.keepAlive || this.idleTimeoutMs <= 0) {
      const auth = cfg.kind === 'remote' ? this.options.upstreamAuth?.for(name, cfg) : undefined;
      return new ManagedServer(name, cfg, { onUpstreamEvent, aggregateWantsTools, ...(auth ? { auth } : {}) });
    }
    return new ManagedServer(name, cfg, {
      onDemand: true,
      idleMs: cfg.idleMinutes !== undefined ? cfg.idleMinutes * 60_000 : this.idleTimeoutMs,
      wakeTimeoutMs: this.options.wakeTimeoutMs,
      persist: server => this.persist(server),
      onUpstreamEvent,
      aggregateWantsTools
    });
  }

  private persist(server: ManagedServer): void {
    this.options.cache?.put(server.name, {
      fingerprint: ToolCache.fingerprint(server.config),
      serverInfo: server.serverInfo,
      capabilities: server.capabilities,
      tools: server.tools,
      updatedAt: new Date().toISOString()
    });
  }

  /**
   * Kicks off all children without blocking: a slow child (npx/uvx downloads
   * can take minutes on a Pi) must not delay the HTTP endpoint or the other
   * servers. Await waitUntilSettled() to know every child has finished its
   * first start attempt (up, down or sleeping).
   *
   * On-demand servers with a matching cache snapshot boot straight into
   * `sleeping` and cost nothing; without one they warm-start once to fill the
   * cache and idle out afterwards.
   */
  start(): void {
    this.initialStarts = [...this.config.entries()].map(([name, cfg]) => {
      const server = this.buildManaged(name, cfg);
      this.servers.set(name, server);
      if (server.onDemand) {
        const entry = this.options.cache?.get(name, ToolCache.fingerprint(cfg));
        if (entry) {
          server.hydrate(entry);
          console.log(`[${name}] sleeping (on demand, ${entry.tools.length} tools cached)`);
          return Promise.resolve();
        }
      }
      return server.start();
    });
    this.startIdleSweep();
  }

  private startIdleSweep(): void {
    if (this.idleTimeoutMs <= 0 || this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweepIdle(), this.options.sweepIntervalMs ?? IDLE_SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  private sweepIdle(): void {
    const now = Date.now();
    for (const server of this.servers.values()) {
      if (!server.onDemand || server.state !== 'up' || server.idleMs <= 0) continue;
      if (now - server.lastUsedAt < server.idleMs) continue;
      console.log(`[${server.name}] idle for ${Math.round((now - server.lastUsedAt) / 60_000)}m, going to sleep`);
      void server.sleep();
    }
  }

  async waitUntilSettled(): Promise<void> {
    await Promise.all(this.initialStarts);
  }

  /**
   * Remove sandbox containers this hub owns that no longer have a config entry.
   *
   * AutoRemove only fires when a container stops, so an unclean hub exit — or
   * a server deleted from the config while the hub was down — leaves a
   * container running with nobody holding its stdio. Containers of *active*
   * servers are left alone here; DockerTransport.start() replaces those by
   * name anyway.
   */
  async reapOrphans(): Promise<void> {
    const active = new Set([...this.config.entries()].filter(([, cfg]) => cfg.kind === 'docker').map(([name]) => name));
    if (active.size === 0) return; // never touch Docker for a hub that does not use it
    const owned = await dockerClient().listOwnedContainers();
    for (const container of owned) {
      if (container.server !== undefined && active.has(container.server)) {
        // A server that booted into `sleeping` holds no container by
        // definition, so one bearing its name is a leftover from an unclean
        // exit — remove it now instead of letting it run until the next wake
        // replaces it. But only while it is still asleep: a wake racing this
        // sweep owns the name again.
        const managed = this.servers.get(container.server);
        if (!managed || managed.state !== 'sleeping') continue;
      }
      console.log(`mcp-hub: removing orphaned sandbox container ${container.name}`);
      await dockerClient().removeContainer(container.name);
    }
  }

  get(name: string): ManagedServer | undefined {
    return this.servers.get(name);
  }

  async applyDiff(config: HubConfig, diff: ConfigDiff): Promise<void> {
    this.config = config;
    for (const name of [...diff.removed, ...diff.changed]) {
      const server = this.servers.get(name);
      if (server) {
        console.log(`[${name}] stopping (config ${diff.removed.includes(name) ? 'removed' : 'changed'})`);
        await server.stop();
        this.servers.delete(name);
      }
      this.options.cache?.delete(name);
      // Only for servers that are gone. A `changed` one keeps its manager
      // unless the credential fingerprint moved, so editing a header does not
      // discard a perfectly good refresh token.
      if (diff.removed.includes(name)) this.options.upstreamAuth?.forget(name);
    }
    await Promise.all(
      [...diff.added, ...diff.changed].map(name => {
        const cfg = config.get(name);
        if (!cfg) return Promise.resolve();
        console.log(`[${name}] starting (config ${diff.added.includes(name) ? 'added' : 'changed'})`);
        // Added/changed on-demand servers warm-start deliberately: their cache
        // entry was just invalidated, and without one they could not answer
        // tools/list while asleep. They idle out again on their own.
        const server = this.buildManaged(name, cfg);
        this.servers.set(name, server);
        return server.start();
      })
    );
  }

  async stop(): Promise<void> {
    clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
    await Promise.all([...this.servers.values()].map(s => s.stop()));
  }
}
