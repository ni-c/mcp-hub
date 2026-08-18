#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { ConfigWatcher, loadConfig, warnMutableDockerImages, type HubConfig } from '../config.js';
import { installFileLogging } from '../logfile.js';
import { VERSION } from '../version.js';
import { createDockerProxy } from './server.js';
import { SecretStore, validateConfigSecrets } from './secrets.js';

/**
 * mcp-hub-docker-proxy: the only component that touches /var/run/docker.sock.
 *
 * It reads the same mcp.json as the hub — read-only, owned by the host — and
 * lets through exactly the container operations that file describes. The hub
 * itself never gets the daemon socket, so a compromise of the internet-facing
 * component cannot create a privileged container or mount the host filesystem.
 *
 * It parses the config with `expand: false`: it holds none of the hub's
 * secrets and must never need them.
 */

function env(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value.length === 0 ? fallback : value;
}

const configPath = env('CONFIG_PATH', '/config/mcp.json');
const listenSocket = env('LISTEN_SOCKET', '/run/proxy/docker.sock');
const dockerSocket = env('DOCKER_SOCKET', '/var/run/docker.sock');
const secretsDir = env('SANDBOX_SECRETS_DIR', '/run/secrets');
const socketMode = Number.parseInt(env('SOCKET_MODE', '0660'), 8);

if (process.env.LOG_FILE) {
  installFileLogging(process.env.LOG_FILE);
}

let config: HubConfig;
try {
  config = loadConfig(configPath, process.env, { expand: false });
} catch (error) {
  console.error(`mcp-hub-docker-proxy: cannot read ${configPath}: ${(error as Error).message}`);
  process.exit(1);
}

// Fail loudly at startup rather than at the first create: a missing or
// world-readable secret file is an operator mistake, and finding out about it
// when a sandbox refuses to start is finding out too late.
const secrets = new SecretStore(secretsDir);
try {
  validateConfigSecrets(config, secrets);
} catch (error) {
  console.error(`mcp-hub-docker-proxy: invalid sandbox secrets: ${(error as Error).message}`);
  process.exit(1);
}
warnMutableDockerImages(config, 'mcp-hub-docker-proxy');
for (const [name, entry] of config) {
  if (entry.kind !== 'docker' || entry.secretsFrom === undefined) continue;
  const keys = Object.keys(secrets.load(entry.secretsFrom));
  console.log(`mcp-hub-docker-proxy: ${name} gets ${keys.length} variable(s) from ${entry.secretsFrom}.env`);
}

const watcher = new ConfigWatcher(configPath, config, process.env, 3_000, { expand: false }, next => validateConfigSecrets(next, secrets));
watcher.on('change', (_next, diff) => {
  warnMutableDockerImages(_next, 'mcp-hub-docker-proxy');
  console.log(
    `mcp-hub-docker-proxy: policy reloaded (added: ${diff.added.join(',') || '-'} removed: ${diff.removed.join(',') || '-'} changed: ${diff.changed.join(',') || '-'})`
  );
});
watcher.on('error', error => console.error(`mcp-hub-docker-proxy: ignoring broken config update: ${(error as Error).message}`));
watcher.start();

const server = createDockerProxy({ dockerSocket, config: () => watcher.current, secretsDir });

// A leftover socket file from an unclean exit would make listen() fail with
// EADDRINUSE forever; there is no other writer for this path.
try {
  const existing = fs.statSync(listenSocket);
  if (existing.isSocket()) fs.unlinkSync(listenSocket);
} catch {
  // Nothing there, which is the normal case.
}
fs.mkdirSync(path.dirname(listenSocket), { recursive: true });

server.listen(listenSocket, () => {
  // The hub connects as a different user, so the socket needs group access —
  // and must not be world-writable, which would hand the policy to anyone on
  // the host with a shell. (Connecting to a Unix socket requires write
  // permission on it, so the mode is the access control.)
  fs.chmodSync(listenSocket, socketMode);
  if (socketMode & 0o002) {
    console.warn(`mcp-hub-docker-proxy: SOCKET_MODE ${socketMode.toString(8)} is world-writable — anything on this host can drive the sandbox API`);
  }
  const dockerServers = [...watcher.current.values()].filter(entry => entry.kind === 'docker').length;
  console.log(`mcp-hub-docker-proxy ${VERSION} listening on ${listenSocket} -> ${dockerSocket} (${dockerServers} sandbox server(s))`);
});

const shutdown = (signal: string) => {
  console.log(`mcp-hub-docker-proxy: received ${signal}, shutting down`);
  watcher.stop();
  server.close();
  try {
    fs.unlinkSync(listenSocket);
  } catch {
    // Already gone.
  }
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', reason => {
  console.error(`mcp-hub-docker-proxy: unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`);
});
