import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { VERSION } from './version.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ServerCapabilities, Implementation, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { HubConfig, ServerConfig, RemoteServerConfig, ConfigDiff } from './config.js';

export type ServerState = 'starting' | 'up' | 'down' | 'stopped';

/**
 * Remote upstreams get their configured headers on EVERY request via a fetch
 * wrapper — requestInit alone does not cover the SSE stream GET.
 */
function buildRemoteTransport(config: RemoteServerConfig): Transport {
  const url = new URL(config.url);
  const headers = config.headers;
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

const BACKOFF_INITIAL_MS = 1_000;
const BACKOFF_MAX_MS = 5 * 60_000;
const BACKOFF_RESET_AFTER_MS = 5 * 60_000;
const PING_INTERVAL_MS = 60_000;
const PING_TIMEOUT_MS = 30_000;

export class ManagedServer {
  state: ServerState = 'starting';
  client?: Client;
  serverInfo?: Implementation;
  capabilities?: ServerCapabilities;
  tools: Tool[] = [];
  restarts = 0;
  lastError?: string;

  private backoffMs = BACKOFF_INITIAL_MS;
  private startedAt = 0;
  private restartTimer?: NodeJS.Timeout;
  private pingTimer?: NodeJS.Timeout;
  private stopping = false;

  constructor(
    readonly name: string,
    public config: ServerConfig
  ) {}

  private buildTransport(): Transport {
    if (this.config.kind === 'remote') {
      return buildRemoteTransport(this.config);
    }
    return new StdioClientTransport({
      command: this.config.command,
      args: this.config.args,
      env: { ...getDefaultEnvironment(), ...this.config.env },
      stderr: 'inherit'
    });
  }

  async start(): Promise<void> {
    this.stopping = false;
    this.state = 'starting';
    const transport = this.buildTransport();
    const client = new Client({ name: 'mcp-hub', version: VERSION }, { capabilities: {} });
    transport.onclose = () => this.onExit(this.config.kind === 'remote' ? 'connection closed' : 'child process exited');
    try {
      await client.connect(transport);
    } catch (error) {
      this.onExit(`failed to start: ${(error as Error).message}`);
      return;
    }
    this.client = client;
    this.serverInfo = client.getServerVersion();
    this.capabilities = client.getServerCapabilities();
    this.state = 'up';
    this.startedAt = Date.now();
    console.log(`[${this.name}] up (${this.serverInfo?.name ?? 'unknown'} ${this.serverInfo?.version ?? ''})`.trim());
    if (this.capabilities?.tools) {
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => void this.refreshTools());
      await this.refreshTools();
    }
    this.pingTimer = setInterval(() => void this.checkAlive(), PING_INTERVAL_MS);
    this.pingTimer.unref();
  }

  private async refreshTools(): Promise<void> {
    // Hold the client locally: onExit() clears this.client, and a paged list
    // spans awaits, so re-reading it per page could hit undefined mid-loop.
    const client = this.client;
    if (!client) return;
    try {
      const tools: Tool[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools({ cursor });
        tools.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor);
      this.tools = tools;
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
    try {
      await client.ping({ timeout: PING_TIMEOUT_MS });
    } catch (error) {
      console.error(`[${this.name}] ping failed, restarting: ${(error as Error).message}`);
      // close() triggers transport.onclose -> onExit -> restart with backoff.
      // Already-closed transports reject here; onExit has then run regardless.
      await client.close().catch(() => {});
    }
  }

  private onExit(reason: string): void {
    // A failed start reports twice: transport.onclose fires and start()'s catch
    // calls us as well. Without this guard the second call would overwrite
    // restartTimer without clearing it, so two children would be spawned and
    // one of them left unreferenced — never pinged, never stopped.
    if (this.state === 'down' || this.state === 'stopped') return;
    clearInterval(this.pingTimer);
    this.client = undefined;
    if (this.stopping) {
      this.state = 'stopped';
      return;
    }
    this.state = 'down';
    this.lastError = reason;
    if (this.startedAt > 0 && Date.now() - this.startedAt > BACKOFF_RESET_AFTER_MS) {
      this.backoffMs = BACKOFF_INITIAL_MS;
    }
    console.error(`[${this.name}] down (${reason}), restarting in ${Math.round(this.backoffMs / 1000)}s`);
    this.restartTimer = setTimeout(() => {
      this.restarts++;
      void this.start();
    }, this.backoffMs);
    this.restartTimer.unref();
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.restartTimer);
    clearInterval(this.pingTimer);
    // Same local-client rule as checkAlive(). This path happens to be safe
    // today because the member access precedes the await, but Supervisor.stop()
    // and applyDiff() await it, so an escaping rejection would land in the
    // shutdown and config-reload paths. Structural, not incidental.
    const client = this.client;
    if (client) {
      await client.close().catch(() => {});
      this.client = undefined;
    }
    this.state = 'stopped';
  }
}

export class Supervisor {
  readonly servers = new Map<string, ManagedServer>();
  private initialStarts: Promise<void>[] = [];

  constructor(private config: HubConfig) {}

  /**
   * Kicks off all children without blocking: a slow child (npx/uvx downloads
   * can take minutes on a Pi) must not delay the HTTP endpoint or the other
   * servers. Await waitUntilSettled() to know every child has finished its
   * first start attempt (up or down).
   */
  start(): void {
    this.initialStarts = [...this.config.entries()].map(([name, cfg]) => {
      const server = new ManagedServer(name, cfg);
      this.servers.set(name, server);
      return server.start();
    });
  }

  async waitUntilSettled(): Promise<void> {
    await Promise.all(this.initialStarts);
  }

  get(name: string): ManagedServer | undefined {
    return this.servers.get(name);
  }

  /** Servers visible on the /hub aggregate endpoint. */
  hubServers(): ManagedServer[] {
    return [...this.servers.values()].filter(s => s.config.hub);
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
    }
    await Promise.all(
      [...diff.added, ...diff.changed].map(name => {
        const cfg = config.get(name);
        if (!cfg) return Promise.resolve();
        console.log(`[${name}] starting (config ${diff.added.includes(name) ? 'added' : 'changed'})`);
        const server = new ManagedServer(name, cfg);
        this.servers.set(name, server);
        return server.start();
      })
    );
  }

  async stop(): Promise<void> {
    await Promise.all([...this.servers.values()].map(s => s.stop()));
  }
}
