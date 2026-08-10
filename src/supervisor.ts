import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ServerCapabilities, Implementation, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { HubConfig, ServerConfig, ConfigDiff } from './config.js';

export type ServerState = 'starting' | 'up' | 'down' | 'stopped';

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

  async start(): Promise<void> {
    this.stopping = false;
    this.state = 'starting';
    const transport = new StdioClientTransport({
      command: this.config.command,
      args: this.config.args,
      env: { ...getDefaultEnvironment(), ...this.config.env },
      stderr: 'inherit'
    });
    const client = new Client({ name: 'mcp-hub', version: '0.1.0' }, { capabilities: {} });
    transport.onclose = () => this.onExit('child process exited');
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
    if (!this.client) return;
    try {
      const tools: Tool[] = [];
      let cursor: string | undefined;
      do {
        const page = await this.client.listTools({ cursor });
        tools.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor);
      this.tools = tools;
    } catch (error) {
      console.error(`[${this.name}] failed to list tools: ${(error as Error).message}`);
    }
  }

  private async checkAlive(): Promise<void> {
    if (this.state !== 'up' || !this.client) return;
    try {
      await this.client.ping({ timeout: PING_TIMEOUT_MS });
    } catch (error) {
      console.error(`[${this.name}] ping failed, restarting: ${(error as Error).message}`);
      // close() triggers transport.onclose -> onExit -> restart with backoff
      await this.client.close().catch(() => {});
    }
  }

  private onExit(reason: string): void {
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
    if (this.client) {
      await this.client.close().catch(() => {});
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
