import type { ServerEvent, ServerNotifier } from '@modelcontextprotocol/server';

import { booleanEnv, nonNegativeIntegerEnv, positiveIntegerEnv } from './mcp-limits.js';

/**
 * Carrying a child's change notifications to the client that asked for them.
 *
 * On the 2026-07-28 revision a client opens a notification stream with
 * `subscriptions/listen` and names the event types it wants. The state that
 * makes this work is the open HTTP response, not a session table — which is the
 * only reason a stateless gateway can carry it at all. It is the same property
 * that made elicitation forwardable: nothing is remembered between requests
 * that is not held by a socket somebody is still holding open.
 *
 * The SDK owns the downstream wire: acknowledgment first, per-stream filtering,
 * `subscriptionId` stamping, teardown, keepalive. What this module owns is the
 * half the SDK cannot know about — that behind one route sits a child process
 * the hub may have put to sleep, and that several clients share it.
 *
 * Two consequences shape everything below:
 *
 * 1. The event bus is publish-only. It never reports which URIs a stream asked
 *    for, so the hub reads the filter off the request itself and keeps its own
 *    book. That book is what tells the upstream side which URIs to subscribe to.
 * 2. One bus serves a whole route. A `publish` reaches every open stream on it,
 *    not just the one that prompted it — so a resync meant for a client that
 *    just connected also nudges the others. Harmless (they re-read a list they
 *    already had) and damped by the debounce, but it is a real property and it
 *    is documented rather than hidden.
 */

/** Global off switch, mirroring `MCP_ELICITATION`. */
export const SUBSCRIPTIONS_ENABLED = booleanEnv('MCP_SUBSCRIPTIONS', true);

/** Open listen streams one route will serve before refusing the next. */
export const MAX_SUBSCRIPTIONS = positiveIntegerEnv('MCP_MAX_SUBSCRIPTIONS', 1024);

/**
 * URIs one `subscriptions/listen` filter may name.
 *
 * Every URI becomes an upstream subscription the hub has to hold and reconcile,
 * so an unbounded list is a way to make the hub do unbounded work on one
 * request. Well above what a resource picker produces, far below what a script
 * could ask for.
 */
export const MAX_SUBSCRIPTION_URIS = positiveIntegerEnv('MCP_SUBSCRIPTION_MAX_URIS', 64);

/** SSE comment-frame keepalive for listen streams; `0` disables it. */
export const KEEPALIVE_MS = nonNegativeIntegerEnv('MCP_SUBSCRIPTION_KEEPALIVE_MS', 15_000);

/**
 * How long change events are collected before they are delivered.
 *
 * A child that rewrites its resource list in a loop would otherwise turn one
 * upstream storm into one downstream storm per connected client. Within the
 * window, repeats of the same event collapse to one — which is exactly what the
 * notification means anyway: "read it again", not "here is what changed".
 * `0` disables the window and delivers each event as it arrives.
 */
export const DEBOUNCE_MS = nonNegativeIntegerEnv('MCP_SUBSCRIPTION_DEBOUNCE_MS', 250);

/**
 * How long one listen stream may stay open; `0` lets it live as long as the
 * socket does.
 *
 * This is a reaper for clients that go away without closing anything, not a
 * protocol feature. The specification's graceful closure — answering the
 * original request with a completion result before closing — is not reachable
 * from here: the SDK owns the stream and exposes no hook for it. So the stream
 * simply ends, which the client sees as the same unexpected disconnect it would
 * see from an HTTP timeout, and reconnects. Spec-legal, and named as what it is
 * rather than dressed up as the graceful variant.
 */
export const MAX_STREAM_MS = nonNegativeIntegerEnv('MCP_SUBSCRIPTION_MAX_MS', 30 * 60_000);

/**
 * Per-server switch, the sibling of `passthrough`.
 *
 * `"off"` withdraws this upstream's right to push. A server can be perfectly
 * trustworthy about tool results and still be one whose notification volume an
 * operator does not want relayed, and that judgement should not require turning
 * the server off.
 */
export interface SubscriptionsConfig {
  subscriptions?: 'auto' | 'off';
}

/** True unless an operator said otherwise, globally or for this server. */
export function subscriptionsAllowed(config: SubscriptionsConfig): boolean {
  return SUBSCRIPTIONS_ENABLED && config.subscriptions !== 'off';
}

/** The `notifications` member of a `subscriptions/listen` request. */
export interface ListenFilter {
  toolsListChanged: boolean;
  promptsListChanged: boolean;
  resourcesListChanged: boolean;
  resourceSubscriptions: string[];
}

/** Whether a parsed request body is a `subscriptions/listen` call. */
export function isListenRequest(body: unknown): boolean {
  if (Array.isArray(body)) return body.some(entry => isListenRequest(entry));
  return typeof body === 'object' && body !== null && (body as { method?: unknown }).method === 'subscriptions/listen';
}

/**
 * Reads the filter off a parsed request body.
 *
 * Deliberately forgiving: this is not the validator. The SDK parses the request
 * properly a moment later and owns every error answer, so anything malformed
 * here just yields an empty demand and is rejected downstream with the SDK's
 * own message. Reading it early buys one thing only — knowing which URIs to
 * hold upstream before the stream opens.
 */
export function parseListenFilter(body: unknown): ListenFilter {
  const empty: ListenFilter = {
    toolsListChanged: false,
    promptsListChanged: false,
    resourcesListChanged: false,
    resourceSubscriptions: []
  };
  if (Array.isArray(body)) {
    // A batch may not contain a listen at all; if it does, take the first.
    const listen = body.find(entry => isListenRequest(entry));
    return listen ? parseListenFilter(listen) : empty;
  }
  if (typeof body !== 'object' || body === null) return empty;
  const params = (body as { params?: unknown }).params;
  if (typeof params !== 'object' || params === null) return empty;
  const notifications = (params as { notifications?: unknown }).notifications;
  if (typeof notifications !== 'object' || notifications === null) return empty;
  const filter = notifications as Record<string, unknown>;
  const uris = Array.isArray(filter.resourceSubscriptions)
    ? filter.resourceSubscriptions.filter((uri): uri is string => typeof uri === 'string')
    : [];
  return {
    toolsListChanged: filter.toolsListChanged === true,
    promptsListChanged: filter.promptsListChanged === true,
    resourcesListChanged: filter.resourcesListChanged === true,
    // Deduplicated here so the cap counts distinct resources, not repetitions
    // of one, and so the upstream union below never holds the same URI twice.
    resourceSubscriptions: [...new Set(uris)]
  };
}

/**
 * The long-lived half of one route, reduced to what the supervisor needs.
 *
 * The handler behind this owns the open `subscriptions/listen` streams, so it
 * outlives any single HTTP request — the one structural change this feature
 * required. Kept as an interface here, rather than importing the proxy's type,
 * so the supervisor can close a route without the two modules importing each
 * other.
 */
export interface RouteChannel {
  readonly registry: SubscriptionRegistry;
  close(): Promise<void>;
}

/** What every live lease on a route wants, merged. */
export interface SubscriptionDemand {
  toolsListChanged: boolean;
  promptsListChanged: boolean;
  resourcesListChanged: boolean;
  uris: string[];
}

/**
 * One client's claim on a route's notifications, held for as long as its stream
 * is open.
 *
 * A lease rather than a reference count, because the two behave differently at
 * exactly the moment that matters: when one client stops listening to a URI
 * another still wants. A count cannot tell "nobody wants this any more" from
 * "the one who is leaving wanted it too", and gets it wrong in the direction
 * that silently breaks the remaining client.
 */
export interface SubscriptionLease {
  release(): void;
}

export interface SubscriptionRegistryOptions {
  /** Called whenever the merged demand may have changed, so the upstream side can reconcile. */
  onDemandChange?: () => void;
  debounceMs?: number;
}

export class SubscriptionRegistry {
  private readonly leases = new Map<number, ListenFilter>();
  private readonly pending = new Map<string, ServerEvent>();
  private nextId = 1;
  private timer?: NodeJS.Timeout;
  private closed = false;

  constructor(
    private readonly notifier: ServerNotifier,
    private readonly options: SubscriptionRegistryOptions = {}
  ) {}

  /** Open listen streams on this route, for the `maxSubscriptions` ceiling. */
  get size(): number {
    return this.leases.size;
  }

  /** The union of every live lease. Empty when nobody is listening. */
  demand(): SubscriptionDemand {
    const uris = new Set<string>();
    let tools = false;
    let prompts = false;
    let resources = false;
    for (const filter of this.leases.values()) {
      tools ||= filter.toolsListChanged;
      prompts ||= filter.promptsListChanged;
      resources ||= filter.resourcesListChanged;
      for (const uri of filter.resourceSubscriptions) uris.add(uri);
    }
    return { toolsListChanged: tools, promptsListChanged: prompts, resourcesListChanged: resources, uris: [...uris] };
  }

  acquire(filter: ListenFilter): SubscriptionLease {
    const id = this.nextId++;
    this.leases.set(id, filter);
    this.options.onDemandChange?.();
    return {
      release: () => {
        // Idempotent: the release is wired to both `finish` and `close` on the
        // response, and a stream that ends normally fires both.
        if (!this.leases.delete(id)) return;
        this.options.onDemandChange?.();
      }
    };
  }

  /** Hand one upstream change event to every stream that opted in. */
  publish(event: ServerEvent): void {
    if (this.closed) return;
    const debounceMs = this.options.debounceMs ?? DEBOUNCE_MS;
    if (debounceMs <= 0) {
      this.deliver(event);
      return;
    }
    this.pending.set(event.kind === 'resource_updated' ? `${event.kind}:${event.uri}` : event.kind, event);
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), debounceMs);
    // Never a reason to hold the process open for a coalescing window.
    this.timer.unref();
  }

  /**
   * Tell every listener to read everything it is watching again.
   *
   * Sent after a child wakes or restarts, because the hub held no upstream
   * subscription while it was gone and cannot know what happened in the
   * meantime. A `resources/updated` here does not claim the resource changed —
   * it says "read it again", which is all the notification ever meant, and it
   * is the only way to make the gap at the end of a nap recoverable rather than
   * silent.
   */
  resync(): void {
    const demand = this.demand();
    if (demand.toolsListChanged) this.publish({ kind: 'tools_list_changed' });
    if (demand.promptsListChanged) this.publish({ kind: 'prompts_list_changed' });
    if (demand.resourcesListChanged) this.publish({ kind: 'resources_list_changed' });
    for (const uri of demand.uris) this.publish({ kind: 'resource_updated', uri });
  }

  private flush(): void {
    this.timer = undefined;
    const events = [...this.pending.values()];
    this.pending.clear();
    for (const event of events) this.deliver(event);
  }

  private deliver(event: ServerEvent): void {
    if (this.closed) return;
    // No filtering here on purpose: the SDK delivers each event only to the
    // streams whose filter asked for it. Publishing one nobody wants costs a
    // function call and reaches no client.
    switch (event.kind) {
      case 'tools_list_changed':
        this.notifier.toolsChanged();
        return;
      case 'prompts_list_changed':
        this.notifier.promptsChanged();
        return;
      case 'resources_list_changed':
        this.notifier.resourcesChanged();
        return;
      case 'resource_updated':
        this.notifier.resourceUpdated(event.uri);
        return;
    }
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.pending.clear();
    this.leases.clear();
  }
}
