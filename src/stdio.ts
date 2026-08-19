#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig, parseConfig, ConfigWatcher, warnMutableDockerImages, type HubConfig } from './config.js';
import { Supervisor } from './supervisor.js';
import { buildHubServer } from './hub.js';

export interface StdioHubOptions {
  /** Path to the mcp.json. A missing file starts an empty hub instead of failing. */
  configPath: string;
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
export function createStdioHub(options: StdioHubOptions) {
  const config = loadOrEmpty(options.configPath);
  warnMutableDockerImages(config);

  const supervisor = new Supervisor(config);
  void supervisor
    .reapOrphans()
    .catch(error => console.error(`mcp-hub: could not reap sandbox containers: ${(error as Error).message}`));
  supervisor.start(); // children come up in the background; the hub reports them as starting until then

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

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!);
if (isMain) {
  await runStdio({ configPath: process.env.CONFIG_PATH ?? path.resolve('mcp.json') });
}
