import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { loadConfig, ConfigWatcher } from './config.js';
import { Supervisor } from './supervisor.js';
import { serverRequestHandler, handleMcpRequest } from './proxy.js';
import { buildHubServer } from './hub.js';
import { AuthStore } from './auth/store.js';
import { HubOAuthProvider } from './auth/provider.js';
import { createAuthRoutes } from './auth/routes.js';
import { healthHandler } from './health.js';

export interface HubOptions {
  externalUrl: string;
  configPath: string;
  dataPath: string;
  passwordHash?: string;
  password?: string;
  trustedProxies?: string[];
}

export async function createHub(options: HubOptions) {
  // Canonical issuer identifier: URL.href form ('https://host/' for a root
  // URL), so JWT iss/aud, AS metadata issuer and PRM authorization_servers all
  // match byte-for-byte — claude.ai compares these strictly.
  const externalUrl = new URL(options.externalUrl).href;
  const origin = new URL(externalUrl).origin;
  const config = loadConfig(options.configPath);
  const supervisor = new Supervisor(config);
  supervisor.start(); // children come up in the background; paths answer 503 until then

  const watcher = new ConfigWatcher(options.configPath, config);
  watcher.on('change', (next, diff) => {
    console.log(`mcp-hub: config changed (added: ${diff.added.join(',') || '-'} removed: ${diff.removed.join(',') || '-'} changed: ${diff.changed.join(',') || '-'})`);
    void supervisor.applyDiff(next, diff);
  });
  watcher.on('error', error => console.error(`mcp-hub: ignoring broken config update: ${(error as Error).message}`));
  watcher.start();

  const store = new AuthStore(options.dataPath);
  const provider = new HubOAuthProvider(store, externalUrl);

  const app = express();
  app.set('trust proxy', options.trustedProxies ?? false);
  app.use(express.json({ limit: '4mb' }));

  app.get('/health', healthHandler(supervisor));
  app.use(createAuthRoutes({ provider, externalUrl, passwordHash: options.passwordHash, password: options.password }));

  // Bearer auth for the MCP endpoints, advertising the path-scoped RFC 9728
  // metadata document in WWW-Authenticate so clients discover the AS.
  const bearer = (req: Request, res: Response, next: NextFunction) =>
    requireBearerAuth({
      verifier: provider,
      resourceMetadataUrl: `${origin}/.well-known/oauth-protected-resource${req.path === '/' ? '' : req.path}`
    })(req, res, next);

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
    app.all(route, bearer, (req: Request, res: Response, next: NextFunction) =>
      void dispatch(String(req.params.name))(req, res, next).catch(next)
    );
  }

  // Express only recognises a four-argument middleware as an error handler.
  // Without it a throw out of the proxy path would escape as an unhandled
  // rejection and take the whole hub — all children included — down with it.
  app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error(`mcp-hub: request failed: ${error.message}`);
    if (res.headersSent) {
      res.end();
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

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!);
if (isMain) {
  const port = Number(process.env.PORT ?? 3000);
  const { app, supervisor, watcher } = await createHub({
    externalUrl: requireEnv('EXTERNAL_URL'),
    configPath: process.env.CONFIG_PATH ?? '/config/mcp.json',
    dataPath: process.env.DATA_PATH ?? '/data',
    passwordHash: process.env.PASSWORD_HASH,
    password: process.env.PASSWORD,
    trustedProxies: process.env.TRUSTED_PROXIES?.split(',').map(s => s.trim()).filter(Boolean)
  });
  const httpServer = app.listen(port, () => console.log(`mcp-hub listening on :${port}`));

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
