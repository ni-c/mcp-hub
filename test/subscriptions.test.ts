import { describe, expect, it, vi } from 'vitest';
import type { ServerNotifier } from '@modelcontextprotocol/server';

import { SubscriptionRegistry, isListenRequest, parseListenFilter, subscriptionsAllowed } from '../src/subscriptions.js';

/**
 * The bookkeeping behind `subscriptions/listen`, on its own.
 *
 * Everything here is reachable end to end in subscriptions-e2e.test.ts, but the
 * cases that matter most are the ones about *several* clients on one route, and
 * those are far cheaper to state directly than to stage over HTTP.
 */

/** Records what would have gone out, in order. */
function recorder(): { notifier: ServerNotifier; sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    notifier: {
      toolsChanged: () => void sent.push('tools'),
      promptsChanged: () => void sent.push('prompts'),
      resourcesChanged: () => void sent.push('resources'),
      resourceUpdated: (uri: string) => void sent.push(`updated:${uri}`)
    }
  };
}

const filter = (overrides: Partial<ReturnType<typeof parseListenFilter>> = {}) => ({
  toolsListChanged: false,
  promptsListChanged: false,
  resourcesListChanged: false,
  resourceSubscriptions: [],
  ...overrides
});

describe('isListenRequest', () => {
  it('recognises a listen call, alone or inside a batch', () => {
    expect(isListenRequest({ method: 'subscriptions/listen' })).toBe(true);
    expect(isListenRequest([{ method: 'tools/list' }, { method: 'subscriptions/listen' }])).toBe(true);
  });

  it('says no to everything else, including nothing at all', () => {
    expect(isListenRequest({ method: 'tools/call' })).toBe(false);
    expect(isListenRequest([{ method: 'tools/list' }])).toBe(false);
    expect(isListenRequest(undefined)).toBe(false);
    expect(isListenRequest(null)).toBe(false);
    expect(isListenRequest('subscriptions/listen')).toBe(false);
  });
});

describe('parseListenFilter', () => {
  it('reads all four notification types', () => {
    const parsed = parseListenFilter({
      method: 'subscriptions/listen',
      params: {
        notifications: {
          toolsListChanged: true,
          promptsListChanged: true,
          resourcesListChanged: true,
          resourceSubscriptions: ['file:///a']
        }
      }
    });
    expect(parsed).toEqual(filter({
      toolsListChanged: true,
      promptsListChanged: true,
      resourcesListChanged: true,
      resourceSubscriptions: ['file:///a']
    }));
  });

  it('deduplicates URIs, so the cap counts resources and not repetitions', () => {
    const parsed = parseListenFilter({
      method: 'subscriptions/listen',
      params: { notifications: { resourceSubscriptions: ['file:///a', 'file:///a', 'file:///b'] } }
    });
    expect(parsed.resourceSubscriptions).toEqual(['file:///a', 'file:///b']);
  });

  it('yields an empty demand for anything malformed, leaving the error to the SDK', () => {
    // This is not the validator: it runs before the SDK parses the request
    // properly, and its only job is to learn what to hold upstream.
    for (const body of [undefined, null, 42, {}, { params: null }, { params: { notifications: 'yes' } }]) {
      expect(parseListenFilter(body)).toEqual(filter());
    }
    expect(
      parseListenFilter({ params: { notifications: { toolsListChanged: 'yes', resourceSubscriptions: [1, 'file:///a'] } } })
    ).toEqual(filter({ resourceSubscriptions: ['file:///a'] }));
  });
});

describe('subscriptionsAllowed', () => {
  it('is on unless this server was switched off', () => {
    expect(subscriptionsAllowed({})).toBe(true);
    expect(subscriptionsAllowed({ subscriptions: 'auto' })).toBe(true);
    expect(subscriptionsAllowed({ subscriptions: 'off' })).toBe(false);
  });
});

describe('SubscriptionRegistry demand', () => {
  it('merges every live lease', () => {
    const { notifier } = recorder();
    const registry = new SubscriptionRegistry(notifier);
    registry.acquire(filter({ toolsListChanged: true, resourceSubscriptions: ['file:///a'] }));
    registry.acquire(filter({ resourcesListChanged: true, resourceSubscriptions: ['file:///b'] }));
    const demand = registry.demand();
    expect(demand.toolsListChanged).toBe(true);
    expect(demand.resourcesListChanged).toBe(true);
    expect(demand.promptsListChanged).toBe(false);
    expect([...demand.uris].sort()).toEqual(['file:///a', 'file:///b']);
  });

  it('keeps a URI another lease still wants when one releases', () => {
    // The whole reason this is a lease book and not a reference count: a count
    // cannot tell "nobody wants this" from "the one leaving wanted it too", and
    // gets it wrong in the direction that silently breaks the client that stayed.
    const { notifier } = recorder();
    const registry = new SubscriptionRegistry(notifier);
    const staying = registry.acquire(filter({ resourceSubscriptions: ['file:///shared'] }));
    const leaving = registry.acquire(filter({ resourceSubscriptions: ['file:///shared', 'file:///mine'] }));

    leaving.release();
    expect(registry.demand().uris).toEqual(['file:///shared']);

    staying.release();
    expect(registry.demand().uris).toEqual([]);
    expect(registry.size).toBe(0);
  });

  it('ignores a second release of the same lease', () => {
    const { notifier } = recorder();
    const onDemandChange = vi.fn();
    const registry = new SubscriptionRegistry(notifier, { onDemandChange });
    const lease = registry.acquire(filter({ toolsListChanged: true }));
    lease.release();
    lease.release();
    // Once for the acquire, once for the first release, and no more: the
    // release is wired to both `finish` and `close`, which both fire.
    expect(onDemandChange).toHaveBeenCalledTimes(2);
  });
});

describe('SubscriptionRegistry delivery', () => {
  it('coalesces a storm into one notification per kind', () => {
    vi.useFakeTimers();
    try {
      const { notifier, sent } = recorder();
      const registry = new SubscriptionRegistry(notifier, { debounceMs: 250 });
      for (let i = 0; i < 50; i++) registry.publish({ kind: 'tools_list_changed' });
      registry.publish({ kind: 'resource_updated', uri: 'file:///a' });
      registry.publish({ kind: 'resource_updated', uri: 'file:///a' });
      registry.publish({ kind: 'resource_updated', uri: 'file:///b' });
      expect(sent).toEqual([]);
      vi.advanceTimersByTime(250);
      // Distinct URIs stay distinct; repeats of one collapse. "Read it again"
      // said fifty times is still "read it again".
      expect(sent).toEqual(['tools', 'updated:file:///a', 'updated:file:///b']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('delivers immediately when the window is switched off', () => {
    const { notifier, sent } = recorder();
    const registry = new SubscriptionRegistry(notifier, { debounceMs: 0 });
    registry.publish({ kind: 'prompts_list_changed' });
    registry.publish({ kind: 'prompts_list_changed' });
    expect(sent).toEqual(['prompts', 'prompts']);
  });

  it('resyncs exactly what the leases asked for, and nothing else', () => {
    vi.useFakeTimers();
    try {
      const { notifier, sent } = recorder();
      const registry = new SubscriptionRegistry(notifier, { debounceMs: 1 });
      registry.acquire(filter({ toolsListChanged: true, resourceSubscriptions: ['file:///a'] }));
      registry.resync();
      vi.advanceTimersByTime(1);
      // No prompts and no resources list: nobody asked for those, and a resync
      // is a re-read of what is watched, not an announcement about everything.
      expect(sent).toEqual(['tools', 'updated:file:///a']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends nothing at all once closed', () => {
    vi.useFakeTimers();
    try {
      const { notifier, sent } = recorder();
      const registry = new SubscriptionRegistry(notifier, { debounceMs: 250 });
      registry.acquire(filter({ toolsListChanged: true }));
      registry.publish({ kind: 'tools_list_changed' });
      registry.close();
      vi.advanceTimersByTime(1000);
      registry.publish({ kind: 'tools_list_changed' });
      expect(sent).toEqual([]);
      expect(registry.demand().uris).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
