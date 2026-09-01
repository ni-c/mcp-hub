import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { ClientCapabilities } from '@modelcontextprotocol/client';

import type { Gateway } from './gateway.js';

/**
 * MCP clients against a running hub, tracked so nothing leaks between tests.
 *
 * An unclosed client holds an HTTP connection and, at the 2025 era, an open SSE
 * stream — which counts against `MCP_MAX_CONCURRENT_STREAMS`. A suite that
 * leaks a few of those starts failing several tests later with a 429, and the
 * test that fails is not the test that leaked. So connections go through here
 * and `closeAll()` runs in `afterEach`.
 */

export type Era = 'legacy' | 'modern';
export const ERAS: readonly Era[] = ['legacy', 'modern'];

/** The protocol revision each era puts on the wire, for messages and headers. */
export const REVISION: Record<Era, string> = { legacy: '2025-11-25', modern: '2026-07-28' };

export interface ConnectOptions {
  /**
   * Which protocol revision to open with.
   *
   * The era is decided by the opening exchange and by nothing else, so this is
   * the only place it can be chosen. `connect()` asserts the hub agreed —
   * `mode: 'auto'` falls back to the legacy era whenever the modern probe
   * fails, so without the check every era test would pass just as happily
   * against a hub that does not speak 2026 at all.
   */
  era?: Era;
  capabilities?: ClientCapabilities;
  /** For the cases where the client must be able to answer an elicitation. */
  autoFulfillInput?: boolean;
  name?: string;
}

export class ClientPool {
  private readonly open = new Set<Client>();

  constructor(private readonly gateway: Gateway) {}

  /**
   * Connects to a path on this gateway with a bearer token.
   *
   * `pathname` is `/hub` or `/<name>/mcp`. The token has to match: since 0.5.0
   * a token is bound to one resource, and a `/hub` token on `/weather/mcp` is a
   * 401 — the feature working, not a mistake in the test.
   */
  async connect(pathname: string, token: string, options: ConnectOptions = {}): Promise<Client> {
    const client = new Client(
      { name: options.name ?? 'mcp-hub-e2e', version: '0.0.0' },
      {
        ...(options.capabilities ? { capabilities: options.capabilities } : {}),
        versionNegotiation: { mode: options.era === 'legacy' ? 'legacy' : 'auto' },
        ...(options.autoFulfillInput === false ? { inputRequired: { autoFulfill: false } } : {})
      }
    );
    const transport = new StreamableHTTPClientTransport(new URL(`${this.gateway.baseUrl}${pathname}`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } }
    });
    try {
      await client.connect(transport);
    } catch (error) {
      throw this.gateway.explain(error, `connecting an MCP client to ${pathname}`);
    }
    this.open.add(client);

    if (options.era) {
      const agreed = client.getProtocolEra();
      if (agreed !== options.era) {
        await client.close();
        this.open.delete(client);
        throw new Error(
          `Asked ${pathname} for the ${options.era} era and negotiated "${agreed}". ` +
            'Without this check an era suite passes just as happily against a hub ' +
            'that speaks one revision and silently falls back for the other.'
        );
      }
    }
    return client;
  }

  async closeAll(): Promise<void> {
    const clients = [...this.open];
    this.open.clear();
    await Promise.allSettled(clients.map(client => client.close()));
  }
}

