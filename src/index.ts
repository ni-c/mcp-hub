#!/usr/bin/env node
import path from 'node:path';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { requireBearerAuth } from '@modelcontextprotocol/express';
import { loadConfig, ConfigWatcher, warnMutableDockerImages } from './config.js';
import { Supervisor, UpstreamAuthRegistry } from './supervisor.js';
import { ToolCache } from './tool-cache.js';
import { warnSingleFileMount } from './mount-check.js';
import { serverRequestHandler, handleMcpRequest } from './proxy.js';
import { buildHubServer } from './hub.js';
import { AuthStore, DEFAULT_CLIENT_LIMITS } from './auth/store.js';
import { CimdResolver } from './auth/cimd.js';
import { createOidcInteractionRoutes } from './auth/oidc/interactions.js';
import { mountOidcProvider } from './auth/oidc/mount.js';
import { buildOidcProvider } from './auth/oidc/provider.js';
import { OidcTokenVerifier } from './auth/oidc/verifier.js';
import { authSecurityHeaders } from './auth/headers.js';
import { createProtectedResourceRoutes } from './auth/protected-resource.js';
import { createRegistrationManagementRoutes } from './auth/registration.js';
import { createUpstreamRoutes } from './upstream/routes.js';
import { healthHandler } from './health.js';
import { installFileLogging } from './logfile.js';
import { canonicalResourceUrl, resourceUrlForRoute } from './auth/resource.js';
import { ClientRequestGate } from './limits.js';
import { runStdio } from './stdio.js';
import { isMainModule } from './main-module.js';

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
  /** Open SSE listening streams per OAuth client — one per connected session. Defaults to 32. */
  mcpMaxConcurrentStreams?: number;
  /** Idle minutes before an on-demand server sleeps; 0 disables on-demand lifecycling. Defaults to 60. */
  idleTimeoutMinutes?: number;
  /** Where tool snapshots of sleeping servers live. Defaults to <dataPath>/tool-cache.json. */
  toolCachePath?: string;
  /** Accepted client registration mechanisms. Defaults to both. */
  clientRegistration?: ClientRegistrationMechanism[];
  /** Origins whose Client ID Metadata Documents are accepted; empty means all. */
  cimdAllowedOrigins?: string[];
  /** Lets metadata documents be fetched from private addresses — development only. */
  cimdAllowPrivateAddresses?: boolean;
  /** Ceiling on stored dynamic registrations. Defaults to 500. */
  dcrMaxClients?: number;
  /** How long a registration may sit without ever being approved. Defaults to 24. */
  dcrPendingTtlHours?: number;
  /** How long a registration may sit unused before it is dropped. Defaults to 90. */
  dcrInactiveDays?: number;
}

/** How often the hub looks for registrations that have aged out. The windows
 *  are a day and three months, so this only has to be far below those. */
const CLIENT_PRUNE_INTERVAL_MS = 15 * 60_000;

export type ClientRegistrationMechanism = 'cimd' | 'dcr';
export const CLIENT_REGISTRATION_MECHANISMS: ClientRegistrationMechanism[] = ['cimd', 'dcr'];

export async function createHub(options: HubOptions) {
  // Canonical issuer identifier: URL.href form ('https://host/' for a root
  // URL), so JWT iss/aud, AS metadata issuer and PRM authorization_servers all
  // match byte-for-byte — claude.ai compares these strictly.
  const externalUrl = new URL(options.externalUrl).href;
  const origin = new URL(externalUrl).origin;
  if (externalUrl !== `${origin}/`) throw new Error('EXTERNAL_URL must be an origin without a path, query or fragment');
  const requestsPerMinute = options.mcpRequestsPerMinute ?? 120;
  const maxConcurrentRequests = options.mcpMaxConcurrentRequests ?? 4;
  // One per connected session, not per unit of work, so the budget is much
  // larger than the in-flight one: a client with several open sessions (an
  // editor, a CLI and a web connector) must not lock itself out.
  const maxConcurrentStreams = options.mcpMaxConcurrentStreams ?? 32;
  if (!Number.isSafeInteger(requestsPerMinute) || requestsPerMinute < 1) throw new Error('mcpRequestsPerMinute must be a positive integer');
  if (!Number.isSafeInteger(maxConcurrentRequests) || maxConcurrentRequests < 1) throw new Error('mcpMaxConcurrentRequests must be a positive integer');
  if (!Number.isSafeInteger(maxConcurrentStreams) || maxConcurrentStreams < 1) throw new Error('mcpMaxConcurrentStreams must be a positive integer');
  if (!/^\d+(?:b|kb|mb)$/i.test(options.mcpBodyLimit ?? '1mb')) throw new Error('mcpBodyLimit must use b, kb or mb units');
  // Bound tokens are the default: an unbound token reaches every MCP path, so
  // the safe behaviour must be the one you get without asking for it.
  const requireResource = options.requireResourceBoundTokens ?? true;
  const config = loadConfig(options.configPath);
  warnMutableDockerImages(config);
  warnSingleFileMount(options.configPath, 'mcp-hub');
  if (options.defaultResource !== undefined) {
    const name = options.defaultResource;
    if (name !== 'hub' && !config.has(name)) {
      throw new Error(`defaultResource "${name}" is neither "hub" nor a configured server`);
    }
  }
  const idleTimeoutMinutes = options.idleTimeoutMinutes ?? 60;
  if (!Number.isSafeInteger(idleTimeoutMinutes) || idleTimeoutMinutes < 0) throw new Error('idleTimeoutMinutes must be a non-negative integer');
  const cache = new ToolCache(options.toolCachePath ?? path.join(options.dataPath, 'tool-cache.json'));
  if (idleTimeoutMinutes > 0) {
    cache.load();
    if (!cache.probeWritable()) {
      console.warn(`mcp-hub: tool cache ${cache.filePath} is not writable — on-demand servers warm-start at every boot instead of sleeping through it`);
    }
  }
  const clientLimits = {
    maxClients: options.dcrMaxClients ?? DEFAULT_CLIENT_LIMITS.maxClients,
    pendingTtlSeconds: (options.dcrPendingTtlHours ?? 24) * 3600,
    inactiveSeconds: (options.dcrInactiveDays ?? 90) * 86_400
  };
  const store = new AuthStore(options.dataPath, clientLimits);
  // Recorded so `mcp-hub-admin upstream login` can build a redirect URI: the
  // image sets CONFIG_PATH and DATA_PATH, but never EXTERNAL_URL.
  store.rememberExternalUrl(externalUrl);
  // A metadata document has to be fetchable over https by a third party, so
  // this mode cannot work behind a plain-http issuer. Say so at boot rather
  // than at the first login attempt.
  for (const [name, server] of config) {
    if (server.kind === 'remote' && server.oauth?.mode === 'cimd' && new URL(externalUrl).protocol !== 'https:') {
      throw new Error(`Server "${name}": oauth mode "cimd" needs an https EXTERNAL_URL, because the upstream fetches the document`);
    }
  }
  const upstreamAuth = new UpstreamAuthRegistry(store, externalUrl);
  const supervisor = new Supervisor(config, { idleTimeoutMinutes, cache, upstreamAuth });
  // start() before reapOrphans(): reaping spares the container of any server
  // that is not asleep, so it must see the boot states. Deliberately not
  // awaited: an unreachable Docker endpoint must not hold up the HTTP listener
  // or the stdio children. Children come up (or hydrate into `sleeping`) in
  // the background; paths answer 503 until then.
  supervisor.start();
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
  watcher.start();

  // Both mechanisms are on by default: CIMD is what the MCP specification now
  // prefers, and dynamic registration is what every client written against the
  // earlier revisions still uses.
  const mechanisms = options.clientRegistration ?? CLIENT_REGISTRATION_MECHANISMS;
  if (mechanisms.length === 0) throw new Error('clientRegistration must name at least one mechanism');
  const cimd = mechanisms.includes('cimd')
    ? new CimdResolver({ allowedOrigins: options.cimdAllowedOrigins, allowPrivateAddresses: options.cimdAllowPrivateAddresses })
    : undefined;

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

  // The resource server's own discovery document, independent of whichever
  // authorization server is mounted below.
  app.use(createProtectedResourceRoutes({ externalUrl }));

  const oidc = buildOidcProvider(store, {
    externalUrl,
    requireResource,
    resolveResource: resource => canonicalResourceUrl(resource, origin, watcher.current),
    defaultResource: options.defaultResource !== undefined ? resourceUrlForRoute(origin, options.defaultResource) : undefined,
    allowDynamicRegistration: mechanisms.includes('dcr'),
    cimd
  });

  app.use(
    createOidcInteractionRoutes({
      provider: oidc,
      store,
      externalUrl,
      password: options.password,
      passwordHash: options.passwordHash,
      cimd
    })
  );
  // Ahead of the mount, so the hub's stricter RFC 7592 handlers win the
  // /register/:id route over oidc-provider's.
  if (mechanisms.includes('dcr')) app.use(createRegistrationManagementRoutes({ store, externalUrl }));
  mountOidcProvider(app, oidc, store, { externalUrl, common: [authSecurityHeaders] });
  // The upstream callback and the hub's own client metadata document. Mounted
  // after the auth routes so it inherits nothing from them but sits ahead of
  // the /:name catch-all.
  app.use(createUpstreamRoutes({ store, registry: upstreamAuth, supervisor, watcher, externalUrl }));

  // Registrations age out on a clock, not on traffic, so this cannot wait for
  // the next write to state.json — an idle hub would never clean up at all.
  // The first pass runs at boot, which is also what gives clients from a state
  // file written before activity was tracked their starting timestamp.
  const sweepClients = () => {
    try {
      const { pending, inactive } = store.pruneClients();
      if (pending.length > 0 || inactive.length > 0) {
        console.log(`mcp-hub: dropped ${pending.length} unconfirmed and ${inactive.length} unused client registration(s)`);
      }
    } catch (error) {
      console.warn(`mcp-hub: could not prune client registrations: ${(error as Error).message}`);
    }
  };
  sweepClients();
  const pruneTimer = setInterval(sweepClients, CLIENT_PRUNE_INTERVAL_MS);
  pruneTimer.unref(); // never a reason to keep the process alive
  const stopMaintenance = () => clearInterval(pruneTimer);

  // Bearer auth for the MCP endpoints, advertising the path-scoped RFC 9728
  // metadata document in WWW-Authenticate so clients discover the AS.
  const verifier = new OidcTokenVerifier(store, {
    externalUrl,
    requireResource,
    resolveResource: resource => canonicalResourceUrl(resource, origin, watcher.current)
  });

  // From @modelcontextprotocol/express, not the frozen server-legacy copy the
  // codemod reaches for by default. That copy exists for projects still running
  // the SDK's own authorization server; the hub replaced its own with
  // oidc-provider first, precisely so this dependency never had to be taken on.
  // The one thing the maintained middleware needs in return is that the
  // verifier throws v2's OAuthError -- see OidcTokenVerifier.
  const bearer = (req: Request, res: Response, next: NextFunction) =>
    requireBearerAuth({
      verifier,
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
  const gate = new ClientRequestGate(requestsPerMinute, maxConcurrentRequests, maxConcurrentStreams);

  // /health reports the same fleet-wide view as the /hub aggregate — every
  // server's name, state and tool count — so it takes the same resource. A
  // token for one server must not be able to enumerate the others.
  const hubResource = resourceUrlForRoute(origin, 'hub');
  app.get('/health', bearer, gate.requestMiddleware, requireResourceFor(() => hubResource), healthHandler(supervisor));

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
    await serverRequestHandler(managed, store.cookieSecret)(req, res);
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

  return { app, supervisor, watcher, verifier, store, upstreamAuth, stopMaintenance };
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

/**
 * CLIENT_REGISTRATION names the mechanisms a client may use to obtain a
 * client_id, as a comma-separated list. It is deliberately a positive list
 * rather than a "disable" switch: an operator reading their compose file
 * should see what is allowed, not what is not.
 */
function clientRegistrationEnv(): ClientRegistrationMechanism[] {
  const raw = process.env.CLIENT_REGISTRATION;
  if (raw === undefined) return CLIENT_REGISTRATION_MECHANISMS;
  const values = raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const unknown = values.filter(value => !(CLIENT_REGISTRATION_MECHANISMS as string[]).includes(value));
  if (values.length === 0 || unknown.length > 0) {
    console.error(`mcp-hub: CLIENT_REGISTRATION must be a comma-separated list of ${CLIENT_REGISTRATION_MECHANISMS.join(', ')}`);
    process.exit(1);
  }
  return [...new Set(values)] as ClientRegistrationMechanism[];
}

/** Origins are compared verbatim against a client_id's origin, so anything
 *  with a path, a query or a non-https scheme is a configuration mistake. */
function cimdAllowedOriginsEnv(): string[] {
  const entries = process.env.CIMD_ALLOWED_ORIGINS?.split(',').map(s => s.trim()).filter(Boolean) ?? [];
  for (const entry of entries) {
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      console.error(`mcp-hub: CIMD_ALLOWED_ORIGINS entry "${entry}" is not a URL`);
      process.exit(1);
    }
    if (url.protocol !== 'https:' || url.origin !== entry.replace(/\/$/, '')) {
      console.error(`mcp-hub: CIMD_ALLOWED_ORIGINS entry "${entry}" must be a bare https origin, e.g. https://chatgpt.com`);
      process.exit(1);
    }
  }
  return entries.map(entry => new URL(entry).origin);
}

function nonNegativeIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    console.error(`mcp-hub: ${name} must be a non-negative integer`);
    process.exit(1);
  }
  return value;
}

const isMain = isMainModule(import.meta.url);
// `--stdio` serves the /hub aggregate on stdin/stdout instead of over HTTP, for
// clients that can only spawn a local process. None of the HTTP surface —
// listener, OAuth, tokens, rate limiting — is created in that mode.
if (isMain && process.argv.includes('--stdio')) {
  if (process.env.LOG_FILE) installFileLogging(process.env.LOG_FILE);
  await runStdio({
    configPath: process.env.CONFIG_PATH ?? path.resolve('mcp.json'),
    idleTimeoutMinutes: nonNegativeIntegerEnv('IDLE_TIMEOUT_MINUTES', 60),
    toolCachePath: process.env.TOOL_CACHE_PATH || undefined,
    // Optional here, unlike over HTTP: only a server with an `oauth` block
    // needs it, to reuse a token authorized against the HTTP hub.
    dataPath: process.env.DATA_PATH || undefined
  });
} else if (isMain) {
  const port = Number(process.env.PORT ?? 3000);
  // Before anything else, so the startup lines land in the file too.
  if (process.env.LOG_FILE) {
    installFileLogging(process.env.LOG_FILE);
    console.log(`mcp-hub: mirroring log output to ${process.env.LOG_FILE}`);
  }
  const clientRegistration = clientRegistrationEnv();
  const { app, supervisor, watcher, stopMaintenance } = await createHub({
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
    mcpMaxConcurrentRequests: positiveIntegerEnv('MCP_MAX_CONCURRENT_REQUESTS', 4),
    mcpMaxConcurrentStreams: positiveIntegerEnv('MCP_MAX_CONCURRENT_STREAMS', 32),
    idleTimeoutMinutes: nonNegativeIntegerEnv('IDLE_TIMEOUT_MINUTES', 60),
    toolCachePath: process.env.TOOL_CACHE_PATH || undefined,
    clientRegistration,
    dcrMaxClients: positiveIntegerEnv('DCR_MAX_CLIENTS', 500),
    dcrPendingTtlHours: positiveIntegerEnv('DCR_PENDING_TTL_HOURS', 24),
    dcrInactiveDays: positiveIntegerEnv('DCR_INACTIVE_DAYS', 90),
    cimdAllowedOrigins: cimdAllowedOriginsEnv(),
    cimdAllowPrivateAddresses: process.env.CIMD_ALLOW_PRIVATE_ADDRESSES === 'true' || process.env.CIMD_ALLOW_PRIVATE_ADDRESSES === '1'
  });
  console.log(`mcp-hub: client registration via ${clientRegistration.join(' and ')}`);
  if (!clientRegistration.includes('dcr')) {
    console.warn('mcp-hub: dynamic client registration is off — clients without Client ID Metadata Document support cannot connect');
  }
  if (process.env.CIMD_ALLOW_PRIVATE_ADDRESSES === 'true' || process.env.CIMD_ALLOW_PRIVATE_ADDRESSES === '1') {
    console.warn('mcp-hub: CIMD_ALLOW_PRIVATE_ADDRESSES is enabled — client metadata documents may be fetched from private addresses. Do not use in production.');
  }
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
    stopMaintenance();
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
