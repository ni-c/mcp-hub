#!/usr/bin/env node
import path from 'node:path';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { loadConfig, ConfigWatcher, warnMutableDockerImages } from './config.js';
import { Supervisor } from './supervisor.js';
import { serverRequestHandler, handleMcpRequest } from './proxy.js';
import { buildHubServer } from './hub.js';
import { AuthStore } from './auth/store.js';
import { HubOAuthProvider } from './auth/provider.js';
import { createAuthRoutes } from './auth/routes.js';
import { healthHandler } from './health.js';
import { installFileLogging } from './logfile.js';
import { canonicalResourceUrl, resourceUrlForRoute } from './auth/resource.js';
import { ClientRequestGate } from './limits.js';
import { runStdio } from './stdio.js';

export interface HubOptions {
  externalUrl: string;
  configPath: string;
  dataPath: string;
  passwordHash?: string;
  password?: string;
  trustedProxies?: string[];
  /** Defaults to true; set false only to keep pre-0.5 global tokens working. */
  requireResourceBoundTokens?: boolean;
  /** Server name (or "hub") to bind tokens to when a client omits the RFC 8707 resource parameter. */
  defaultResource?: string;
  mcpBodyLimit?: string;
  mcpRequestsPerMinute?: number;
  mcpMaxConcurrentRequests?: number;
}

export async function createHub(options: HubOptions) {
  // Canonical issuer identifier: URL.href form ('https://host/' for a root
  // URL), so JWT iss/aud, AS metadata issuer and PRM authorization_servers all
  // match byte-for-byte — claude.ai compares these strictly.
  const externalUrl = new URL(options.externalUrl).href;
  const origin = new URL(externalUrl).origin;
  if (externalUrl !== `${origin}/`) throw new Error('EXTERNAL_URL must be an origin without a path, query or fragment');
  const requestsPerMinute = options.mcpRequestsPerMinute ?? 120;
  const maxConcurrentRequests = options.mcpMaxConcurrentRequests ?? 4;
  if (!Number.isSafeInteger(requestsPerMinute) || requestsPerMinute < 1) throw new Error('mcpRequestsPerMinute must be a positive integer');
  if (!Number.isSafeInteger(maxConcurrentRequests) || maxConcurrentRequests < 1) throw new Error('mcpMaxConcurrentRequests must be a positive integer');
  if (!/^\d+(?:b|kb|mb)$/i.test(options.mcpBodyLimit ?? '1mb')) throw new Error('mcpBodyLimit must use b, kb or mb units');
  // Bound tokens are the default: an unbound token reaches every MCP path, so
  // the safe behaviour must be the one you get without asking for it.
  const requireResource = options.requireResourceBoundTokens ?? true;
  const config = loadConfig(options.configPath);
  warnMutableDockerImages(config);
  if (options.defaultResource !== undefined) {
    const name = options.defaultResource;
    if (name !== 'hub' && !config.has(name)) {
      throw new Error(`defaultResource "${name}" is neither "hub" nor a configured server`);
    }
  }
  const supervisor = new Supervisor(config);
  // Deliberately not awaited: an unreachable Docker endpoint must not hold up
  // the HTTP listener or the stdio children, and reaping only ever touches
  // containers whose server is no longer configured.
  void supervisor
    .reapOrphans()
    .catch(error => console.error(`mcp-hub: could not reap sandbox containers: ${(error as Error).message}`));
  supervisor.start(); // children come up in the background; paths answer 503 until then

  const watcher = new ConfigWatcher(options.configPath, config);
  watcher.on('change', (next, diff) => {
    warnMutableDockerImages(next);
    console.log(`mcp-hub: config changed (added: ${diff.added.join(',') || '-'} removed: ${diff.removed.join(',') || '-'} changed: ${diff.changed.join(',') || '-'})`);
    void supervisor.applyDiff(next, diff);
  });
  watcher.on('error', error => console.error(`mcp-hub: ignoring broken config update: ${(error as Error).message}`));
  watcher.start();

  const store = new AuthStore(options.dataPath);
  const provider = new HubOAuthProvider(store, externalUrl, {
    requireResource,
    resolveResource: resource => canonicalResourceUrl(resource, origin, watcher.current),
    defaultResource: options.defaultResource !== undefined ? resourceUrlForRoute(origin, options.defaultResource) : undefined
  });

  const app = express();
  if (!options.trustedProxies?.length) {
    // Without this every request behind a proxy reports the proxy's address,
    // so per-IP login limiting and the fail2ban log lines are meaningless.
    console.warn('mcp-hub: TRUSTED_PROXIES is not set — login rate limiting falls back to a single global counter');
  }
  app.set('trust proxy', options.trustedProxies ?? false);
  app.disable('x-powered-by');

  // A liveness check intentionally carries no topology. Detailed child state
  // lives behind OAuth at /health.
  app.get('/livez', (_req, res) => res.status(200).json({ status: 'ok' }));
  app.use(createAuthRoutes({ provider, externalUrl, passwordHash: options.passwordHash, password: options.password }));

  // Bearer auth for the MCP endpoints, advertising the path-scoped RFC 9728
  // metadata document in WWW-Authenticate so clients discover the AS.
  const bearer = (req: Request, res: Response, next: NextFunction) =>
    requireBearerAuth({
      verifier: provider,
      resourceMetadataUrl: `${origin}/.well-known/oauth-protected-resource${req.path === '/' ? '' : req.path}`
    })(req, res, next);

  // A bound token may only reach the resource it was issued for. An unbound one
  // passes only while binding is not enforced, which is what keeps pre-0.5
  // deployments working until they have re-authorized their connectors.
  const requireResourceFor = (expected: (req: Request) => URL) => (req: Request, res: Response, next: NextFunction): void => {
    const target = expected(req);
    const actual = req.auth?.resource;
    if ((actual && actual.href !== target.href) || (requireResource && !actual)) {
      res.set('WWW-Authenticate', 'Bearer error="invalid_token", error_description="Access token is not valid for this resource"');
      res.status(401).json({ error: 'invalid_token', error_description: 'Access token is not valid for this resource' });
      return;
    }
    next();
  };

  // The per-client gate sits between bearer auth and the resource check on
  // every authenticated route: bearer first so only authenticated clients
  // create gate state, gate before the resource check so rejected-resource
  // requests count as load too — they cost the same work.
  const gate = new ClientRequestGate(requestsPerMinute, maxConcurrentRequests);

  // /health reports the same fleet-wide view as the /hub aggregate — every
  // server's name, state and tool count — so it takes the same resource. A
  // token for one server must not be able to enumerate the others.
  const hubResource = resourceUrlForRoute(origin, 'hub');
  app.get('/health', bearer, gate.middleware, requireResourceFor(() => hubResource), healthHandler(supervisor));

  const requireRouteResource = requireResourceFor(req => resourceUrlForRoute(origin, String(req.params.name)));
  const parseMcpJson = express.json({ limit: options.mcpBodyLimit ?? '1mb' });

  const dispatch = (name: string) => async (req: Request, res: Response, next: NextFunction) => {
    if (name === 'hub') {
      await handleMcpRequest(() => buildHubServer(supervisor).server, req, res);
      return;
    }
    const managed = supervisor.get(name);
    if (!managed) {
      next(); // fall through to 404
      return;
    }
    await serverRequestHandler(managed)(req, res);
  };

  for (const route of ['/:name', '/:name/mcp']) {
    app.all(route, bearer, gate.middleware, requireRouteResource, parseMcpJson, (req: Request, res: Response, next: NextFunction) =>
      void dispatch(String(req.params.name))(req, res, next).catch(next)
    );
  }

  // Express only recognises a four-argument middleware as an error handler.
  // Without it a throw out of the proxy path would escape as an unhandled
  // rejection and take the whole hub — all children included — down with it.
  app.use((error: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
    console.error(`mcp-hub: request failed: ${error.message}`);
    if (res.headersSent) {
      res.end();
      return;
    }
    if (error.status === 413) {
      res.status(413).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Request body too large' }, id: null });
      return;
    }
    res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
  });

  return { app, supervisor, watcher, provider, store };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`mcp-hub: missing required environment variable ${name}`);
    process.exit(1);
  }
  return value;
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    console.error(`mcp-hub: ${name} must be a positive integer`);
    process.exit(1);
  }
  return value;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!);
// `--stdio` serves the /hub aggregate on stdin/stdout instead of over HTTP, for
// clients that can only spawn a local process. None of the HTTP surface —
// listener, OAuth, tokens, rate limiting — is created in that mode.
if (isMain && process.argv.includes('--stdio')) {
  if (process.env.LOG_FILE) installFileLogging(process.env.LOG_FILE);
  await runStdio({ configPath: process.env.CONFIG_PATH ?? path.resolve('mcp.json') });
} else if (isMain) {
  const port = Number(process.env.PORT ?? 3000);
  // Before anything else, so the startup lines land in the file too.
  if (process.env.LOG_FILE) {
    installFileLogging(process.env.LOG_FILE);
    console.log(`mcp-hub: mirroring log output to ${process.env.LOG_FILE}`);
  }
  const { app, supervisor, watcher } = await createHub({
    externalUrl: requireEnv('EXTERNAL_URL'),
    configPath: process.env.CONFIG_PATH ?? '/config/mcp.json',
    dataPath: process.env.DATA_PATH ?? '/data',
    passwordHash: process.env.PASSWORD_HASH,
    password: process.env.PASSWORD,
    trustedProxies: process.env.TRUSTED_PROXIES?.split(',').map(s => s.trim()).filter(Boolean),
    requireResourceBoundTokens: process.env.RESOURCE_BOUND_TOKENS !== 'false' && process.env.RESOURCE_BOUND_TOKENS !== '0',
    defaultResource: process.env.DEFAULT_RESOURCE || undefined,
    mcpBodyLimit: process.env.MCP_BODY_LIMIT ?? '1mb',
    mcpRequestsPerMinute: positiveIntegerEnv('MCP_REQUESTS_PER_MINUTE', 120),
    mcpMaxConcurrentRequests: positiveIntegerEnv('MCP_MAX_CONCURRENT_REQUESTS', 4)
  });
  if (process.env.RESOURCE_BOUND_TOKENS === 'false' || process.env.RESOURCE_BOUND_TOKENS === '0') {
    console.warn(
      'mcp-hub: RESOURCE_BOUND_TOKENS is disabled — unbound access tokens may call every MCP path. ' +
        'This is a migration mode for deployments from 0.4 and earlier; remove the setting once every connector has re-authorized.'
    );
  }
  if (process.env.DEFAULT_RESOURCE) {
    console.log(`mcp-hub: clients that send no resource parameter are bound to "${process.env.DEFAULT_RESOURCE}"`);
  }
  const httpServer = app.listen(port, () => console.log(`mcp-hub listening on :${port}`));
  httpServer.headersTimeout = positiveIntegerEnv('HTTP_HEADERS_TIMEOUT_MS', 10_000);
  httpServer.requestTimeout = positiveIntegerEnv('HTTP_REQUEST_TIMEOUT_MS', 310_000);

  const shutdown = async (signal: string, code = 0) => {
    console.log(`mcp-hub: received ${signal}, shutting down`);
    watcher.stop();
    httpServer.close();
    await supervisor.stop();
    process.exit(code);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // A stray rejection is almost always one failed request and must not take
  // the children with it; an uncaught exception leaves the process in an
  // undefined state, so shut down cleanly and let Docker restart us instead.
  process.on('unhandledRejection', reason => {
    console.error(`mcp-hub: unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`);
  });
  process.on('uncaughtException', error => {
    console.error(`mcp-hub: uncaught exception: ${error.stack ?? error.message}`);
    void shutdown('uncaughtException', 1);
  });
}
