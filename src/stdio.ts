#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { loadConfig, parseConfig, ConfigWatcher, warnMutableDockerImages, type HubConfig } from './config.js';
import { Supervisor, UpstreamAuthRegistry } from './supervisor.js';
import { AuthStore } from './auth/store.js';
import { ToolCache } from './tool-cache.js';
import { buildHubServer } from './hub.js';
import { isMainModule } from './main-module.js';

export interface StdioHubOptions {
  /** Path to the mcp.json. A missing file starts an empty hub instead of failing. */
  configPath: string;
  /** Idle minutes before an on-demand server sleeps; 0 disables on-demand lifecycling. Defaults to 60. */
  idleTimeoutMinutes?: number;
  /** Where tool snapshots of sleeping servers live. Defaults to .mcp-hub/tool-cache.json beside the config. */
  toolCachePath?: string;
  /**
   * The hub's state directory, when there is one.
   *
   * Optional because this mode normally has none. Pointing it at the same
   * `/data` an HTTP hub uses is what lets an upstream that was authorized there
   * be used — and refreshed — from here too. Refreshing needs no browser; only
   * the first login does, and that one has to happen against the HTTP hub.
   */
  dataPath?: string;
}

/**
 * Everything the hub writes with console.log/info would land in the middle of
 * the JSON-RPC stream and desynchronise the client, so both are moved to
 * stderr for the life of the process. warn/error already go to stderr.
 *
 * The wrapper keeps the original references (not bound copies) so restore()
 * puts back the exact same functions and repeated install/restore cycles in a
 * test run cannot stack wrappers — same reasoning as installFileLogging().
 */
export function redirectStdoutLogging(): () => void {
  const original = { log: console.log, info: console.info };
  const toStderr = (...args: unknown[]) => console.error(...args);
  console.log = toStderr;
  console.info = toStderr;
  return () => {
    console.log = original.log;
    console.info = original.info;
  };
}

/**
 * A stdio client has no config volume to mount and no way to see a startup
 * error, so an absent file is a warning and an empty hub — `list_servers`
 * answers with nothing instead of the process dying at boot. The watcher
 * follows the directory, so the servers appear as soon as the file is written.
 * The HTTP entrypoint keeps its hard failure: there the file is a deployment
 * artefact, and starting empty would silently serve 404s for every path.
 */
function loadOrEmpty(configPath: string): HubConfig {
  try {
    return loadConfig(configPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    console.warn(`mcp-hub: no config at ${configPath} — starting with no servers`);
    return parseConfig('{"mcpServers":{}}');
  }
}

/**
 * The /hub aggregate over stdio: the same meta-tools the HTTP endpoint serves
 * at /hub, for clients that can only spawn a local process (Claude Desktop,
 * Codex, …). Everything HTTP-only — OAuth, tokens, rate limiting, /health —
 * has no counterpart here; the trust boundary is the local user account.
 */
/**
 * Outbound OAuth only works here when a state directory was given: there is
 * nowhere else to read a token from, and no HTTP listener for a browser to
 * come back to. Without one, such a server simply cannot connect, so say why
 * once rather than leaving an unexplained failure in the log.
 */
function buildUpstreamAuth(config: HubConfig, dataPath: string | undefined): UpstreamAuthRegistry | undefined {
  const oauthServers = [...config].filter(([, server]) => server.kind === 'remote' && server.oauth !== undefined);
  if (oauthServers.length === 0) return undefined;
  if (!dataPath) {
    console.warn(
      `mcp-hub: ${oauthServers.map(([name]) => name).join(', ')} need an upstream OAuth token, but this mode has no state directory. ` +
        'Set DATA_PATH to the hub\'s /data to reuse a token authorized there.'
    );
    return undefined;
  }
  const store = new AuthStore(dataPath);
  const externalUrl = store.getExternalUrl();
  if (!externalUrl) {
    console.warn(`mcp-hub: ${dataPath} holds no upstream credentials yet; authorize them against the HTTP hub first`);
    return undefined;
  }
  return new UpstreamAuthRegistry(store, externalUrl);
}

export function createStdioHub(options: StdioHubOptions) {
  const config = loadOrEmpty(options.configPath);
  warnMutableDockerImages(config);

  const idleTimeoutMinutes = options.idleTimeoutMinutes ?? 60;
  if (!Number.isSafeInteger(idleTimeoutMinutes) || idleTimeoutMinutes < 0) throw new Error('idleTimeoutMinutes must be a non-negative integer');
  // On-demand matters more here than behind HTTP: a workstation hub is spawned
  // per client session, so starting every configured server at every launch is
  // exactly the cost this feature exists to avoid. The snapshot lives next to
  // the config rather than in a DATA_PATH — there is no state directory in
  // this mode, and no other state to put in one.
  const cache = new ToolCache(options.toolCachePath ?? path.join(path.dirname(options.configPath), '.mcp-hub', 'tool-cache.json'));
  if (idleTimeoutMinutes > 0) {
    cache.load();
    if (!cache.probeWritable()) {
      console.warn(`mcp-hub: tool cache ${cache.filePath} is not writable — on-demand servers warm-start at every launch instead of sleeping through it`);
    }
  }

  const upstreamAuth = buildUpstreamAuth(config, options.dataPath);
  const supervisor = new Supervisor(config, { idleTimeoutMinutes, cache, upstreamAuth });
  supervisor.start(); // children come up (or hydrate into `sleeping`) in the background
  void supervisor
    .reapOrphans()
    .catch(error => console.error(`mcp-hub: could not reap sandbox containers: ${(error as Error).message}`));

  const watcher = new ConfigWatcher(options.configPath, config);
  watcher.on('change', (next, diff) => {
    warnMutableDockerImages(next);
    console.log(`mcp-hub: config changed (added: ${diff.added.join(',') || '-'} removed: ${diff.removed.join(',') || '-'} changed: ${diff.changed.join(',') || '-'})`);
    void supervisor.applyDiff(next, diff);
  });
  watcher.on('error', error => console.error(`mcp-hub: ignoring broken config update: ${(error as Error).message}`));
  // fs.watch() throws when the directory does not exist. That is not worth
  // dying for in a client-spawned process — run without hot reload instead.
  if (fs.existsSync(path.dirname(options.configPath))) {
    watcher.start();
  } else {
    console.warn(`mcp-hub: ${path.dirname(options.configPath)} does not exist — config hot reload is off`);
  }

  return { server: buildHubServer(supervisor), supervisor, watcher };
}

export async function runStdio(options: StdioHubOptions): Promise<void> {
  redirectStdoutLogging();
  const { server, supervisor, watcher } = createStdioHub(options);
  await server.connect(new StdioServerTransport());
  console.error(`mcp-hub: serving the hub aggregate over stdio (config ${options.configPath})`);

  const shutdown = async (signal: string) => {
    console.error(`mcp-hub: received ${signal}, shutting down`);
    watcher.stop();
    await supervisor.stop();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  // The client closing our stdin is the normal way this process ends.
  process.stdin.on('close', () => void shutdown('stdin close'));
}

if (isMainModule(import.meta.url)) {
  const idle = Number(process.env.IDLE_TIMEOUT_MINUTES ?? 60);
  if (!Number.isSafeInteger(idle) || idle < 0) {
    console.error('mcp-hub: IDLE_TIMEOUT_MINUTES must be a non-negative integer');
    process.exit(1);
  }
  await runStdio({
    configPath: process.env.CONFIG_PATH ?? path.resolve('mcp.json'),
    idleTimeoutMinutes: idle,
    toolCachePath: process.env.TOOL_CACHE_PATH || undefined
  });
}
