import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { createHub, type HubOptions } from '../../src/index.js';
import { assertTierInUse, defaultTier, type Tier } from './tiers.js';
import { decorate, LogTail } from './logs.js';
import { freePort, releasePort } from './ports.js';
import { assertLoopback } from './loopback.js';
import { waitForHttp } from './wait.js';
import { composeStack, composeUp, writeOverride, type ComposeStack } from './compose.js';
import { assertBuildIsFresh, DIST_ADMIN, DIST_ENTRY, makeWorkspace, REPO_ROOT, type Workspace } from './workspace.js';

const execFileAsync = promisify(execFile);

export const E2E_PASSWORD = 'e2e-password';

/**
 * The identity an in-process hub is given.
 *
 * Fixed rather than derived, because `createHub()` needs it before there is a
 * listener to ask for a port — the same ordering problem the spawned tier
 * solves by choosing a port up front. The value is the one the fast suite in
 * `test/` has always used, so a resource string means the same thing in both.
 */
export const IN_PROCESS_EXTERNAL_URL = 'http://localhost:3000';

export interface GatewayOptions {
  /** Names the temp directory, so a leftover says which suite left it. */
  prefix: string;
  /** Defaults to `defaultTier()`. A suite that needs a specific one says so. */
  tier?: Tier;
  servers: Record<string, unknown>;
  /**
   * The hub's ENTIRE environment beyond PATH, at the spawned tiers.
   *
   * Deliberately not merged with `process.env` — the rule ported from
   * `mcp-integration-harness`. An `EXTERNAL_URL` or `PASSWORD` left over in a
   * developer's shell must not be able to steer a run, and a test that only
   * passes because of one is worse than no test.
   */
  env?: Record<string, string>;
  password?: string;
  /** In-process options at the inproc tier; mapped to env at the others. */
  hubOptions?: Partial<HubOptions>;
  readyTimeoutMs?: number;
  /** Skips waiting for children to settle, for the "server never starts" cases. */
  waitUntilSettled?: boolean;
}

export interface AdminResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface Gateway {
  readonly tier: Tier;
  /** Where to connect. */
  readonly baseUrl: string;
  /**
   * Who the hub says it is — its issuer, and the base every resource
   * identifier is canonicalised against.
   *
   * The same as `baseUrl` at the spawned tiers, and deliberately not at the
   * in-process one: there the listener takes an ephemeral port that cannot be
   * known before `createHub()` is called, so the hub is given a fixed identity
   * and reached at whatever port it got. Anything that names a resource —
   * an RFC 8707 `resource` parameter, a PRM document, a token's audience —
   * uses this one. Anything that opens a socket uses `baseUrl`.
   */
  readonly externalUrl: string;
  /**
   * What supertest should be pointed at: the Express app in-process, the base
   * URL otherwise. `test/auth-flow.ts` takes either, which is what lets one
   * browser simulation serve all three tiers.
   */
  readonly target: Express.Application | string;
  /**
   * The operator password this hub was started with.
   *
   * Carried on the gateway rather than assumed by the token helper: the docker
   * tier runs the published demo, whose password is `demo` because the demo's
   * own compose file says so, and a helper that hardcoded one value would fail
   * there for a reason that has nothing to do with what it was testing.
   */
  readonly password: string;
  readonly workspace: Workspace;

  /**
   * The live supervisor, store and watcher. Only in-process.
   *
   * Every use of this is a test that cannot run at the tier this suite exists
   * for, so it throws elsewhere rather than returning something hollow — and it
   * names the alternative, because there almost always is one: `/health`
   * reports states, the log reports restarts, and `mcp-hub-admin` reports
   * tokens.
   */
  internals(): HubInternals;

  admin(argv: string[]): Promise<AdminResult>;
  writeConfig(servers: Record<string, unknown>): Promise<void>;
  signal(signal: NodeJS.Signals): Promise<number | null>;
  restart(): Promise<void>;

  stderr(): string;
  logLines(pattern: RegExp): string[];
  waitForLog(pattern: RegExp, timeoutMs?: number): Promise<string>;
  /** Re-throws with the hub's output attached. Wrap anything the hub can break. */
  explain(error: unknown, what: string): Error;

  stop(): Promise<void>;
}

export type HubInternals = Awaited<ReturnType<typeof createHub>>;

/**
 * Starts a hub and hands back one interface for all three tiers.
 *
 * The differences that survive the abstraction are named on the members above:
 * `internals()` exists only in-process, and `stderr()` is intercepted console
 * output there rather than a real pipe. Everything else — the URL, the config
 * file, the admin CLI, the log — behaves the same, which is what makes a suite
 * runnable at more than one tier without branching.
 */
export async function startGateway(options: GatewayOptions): Promise<Gateway> {
  const tier = options.tier ?? defaultTier();
  const workspace = makeWorkspace(options.prefix);
  workspace.writeConfigInPlace(options.servers);
  try {
    const gateway =
      tier === 'inproc'
        ? await startInProcess(options, workspace)
        : tier === 'docker'
          ? await startContainerised(options, workspace)
          : await startSpawned(options, workspace);
    assertTierInUse(tier, gateway.tier);
    return gateway;
  } catch (error) {
    workspace.remove();
    throw error;
  }
}

/** The environment a spawned hub gets, and the in-process equivalent. */
function hubEnvironment(options: GatewayOptions, workspace: Workspace, externalUrl: string, port: number): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '',
    EXTERNAL_URL: externalUrl,
    PASSWORD: options.password ?? E2E_PASSWORD,
    CONFIG_PATH: workspace.configPath,
    DATA_PATH: workspace.data,
    PORT: String(port),
    // Bound tokens are the hub's default and therefore the suite's default; a
    // test that wants the migration mode asks for it by name.
    RESOURCE_BOUND_TOKENS: 'true',
    ...options.env
  };
}

/**
 * The environment a spawned hub would read, as `createHub` options.
 *
 * Without this, `env` was silently ignored in-process: a suite asking for
 * `MCP_REQUESTS_PER_MINUTE: 10000` got the default 120 and started failing with
 * a 429 several tests later, at whichever call happened to cross the line. It
 * passed locally only because `defaultTier()` prefers `process`, so nothing ran
 * the affected suites in-process until CI did — which is the whole argument for
 * the tier being a matrix dimension rather than a default.
 *
 * Anything not listed here is read at module scope by `mcp-limits.ts`,
 * `timings.ts` or `subscriptions.ts`, and cannot be changed after import. Those
 * throw rather than being dropped: a knob that quietly does nothing is how this
 * bug happened once already.
 */
function hubOptionsFromEnv(env: Record<string, string> | undefined): Partial<HubOptions> {
  if (!env) return {};
  const options: Partial<HubOptions> = {};
  const leftover: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    switch (key) {
      case 'PASSWORD': options.password = value; break;
      case 'PASSWORD_HASH': options.passwordHash = value; break;
      case 'RESOURCE_BOUND_TOKENS': options.requireResourceBoundTokens = value !== 'false' && value !== '0'; break;
      case 'DEFAULT_RESOURCE': options.defaultResource = value; break;
      case 'MCP_BODY_LIMIT': options.mcpBodyLimit = value; break;
      case 'MCP_REQUESTS_PER_MINUTE': options.mcpRequestsPerMinute = Number(value); break;
      case 'MCP_MAX_CONCURRENT_REQUESTS': options.mcpMaxConcurrentRequests = Number(value); break;
      case 'MCP_MAX_CONCURRENT_STREAMS': options.mcpMaxConcurrentStreams = Number(value); break;
      case 'IDLE_TIMEOUT_MINUTES': options.idleTimeoutMinutes = Number(value); break;
      case 'TOOL_CACHE_PATH': options.toolCachePath = value; break;
      case 'CLIENT_REGISTRATION':
        options.clientRegistration = value.split(',').map(part => part.trim()) as HubOptions['clientRegistration'];
        break;
      case 'CIMD_ALLOWED_ORIGINS': options.cimdAllowedOrigins = value.split(',').map(part => part.trim()).filter(Boolean); break;
      case 'CIMD_ALLOW_PRIVATE_ADDRESSES': options.cimdAllowPrivateAddresses = value === 'true' || value === '1'; break;
      case 'DCR_MAX_CLIENTS': options.dcrMaxClients = Number(value); break;
      case 'DCR_PENDING_TTL_HOURS': options.dcrPendingTtlHours = Number(value); break;
      case 'DCR_INACTIVE_DAYS': options.dcrInactiveDays = Number(value); break;
      // Set by the harness itself for the spawned tiers; meaningless here,
      // where the workspace and the listener are wired up directly.
      case 'EXTERNAL_URL': case 'CONFIG_PATH': case 'DATA_PATH': case 'PORT': break;
      default: leftover.push(key);
    }
  }
  if (leftover.length > 0) {
    throw new Error(
      `mcp-hub e2e: ${leftover.join(', ')} cannot take effect in-process — it is read once at import by ` +
        'mcp-limits.ts, timings.ts or subscriptions.ts. Give this suite `tier: \'process\'`, which is where ' +
        'those knobs are real. Refused rather than ignored: a knob that quietly does nothing is how a suite ' +
        'comes to pass for the wrong reason.'
    );
  }
  return options;
}

async function startInProcess(options: GatewayOptions, workspace: Workspace): Promise<Gateway> {
  const log = new LogTail();
  const restoreConsole = interceptConsole(log);
  let hub: HubInternals | undefined;
  let server: Server | undefined;
  try {
    hub = await createHub({
      externalUrl: IN_PROCESS_EXTERNAL_URL,
      configPath: workspace.configPath,
      dataPath: workspace.data,
      password: options.password ?? E2E_PASSWORD,
      ...hubOptionsFromEnv(options.env),
      ...options.hubOptions
    });
    if (options.waitUntilSettled !== false) await hub.supervisor.waitUntilSettled();
    server = hub.app.listen(0);
    const port = (server.address() as AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${port}`;
    assertLoopback(baseUrl);

    const live = hub;
    const liveServer = server;
    return {
      tier: 'inproc',
      baseUrl,
      externalUrl: IN_PROCESS_EXTERNAL_URL,
      password: options.password ?? E2E_PASSWORD,
      // The app, not the URL: in-process there is no reason to go out to the
      // socket, and supertest against the app is both faster and immune to the
      // port races the other tiers have to live with.
      target: hub.app,
      workspace,
      internals: () => live,
      admin: argv => runAdmin(argv, { DATA_PATH: workspace.data, CONFIG_PATH: workspace.configPath, EXTERNAL_URL: IN_PROCESS_EXTERNAL_URL }),
      writeConfig: servers => applyConfig(workspace, servers, live),
      signal: () => {
        throw new Error('mcp-hub e2e: signal() needs a real process — run this suite at the "process" or "docker" tier.');
      },
      restart: () => {
        throw new Error('mcp-hub e2e: restart() needs a real process — run this suite at the "process" or "docker" tier.');
      },
      stderr: () => log.text(),
      logLines: pattern => log.matching(pattern),
      waitForLog: (pattern, timeoutMs) => log.waitForLine(pattern, timeoutMs),
      explain: (error, what) => decorate(error, what, log.text()),
      stop: async () => {
        liveServer.close();
        live.watcher.stop();
        live.stopMaintenance();
        await live.supervisor.stop();
        restoreConsole();
        workspace.remove();
      }
    };
  } catch (error) {
    server?.close();
    hub?.watcher.stop();
    await hub?.supervisor.stop();
    restoreConsole();
    throw decorate(error, 'starting the hub in this process', log.text());
  }
}

/**
 * `node dist/index.js`, the tier this suite exists for.
 *
 * Three things here are not incidental:
 *
 *  - The port is chosen before the spawn, because `EXTERNAL_URL` is the hub's
 *    issuer identifier and goes into the child's environment. `listen(0)` — what
 *    every test in `test/` uses — is not available, so `ports.ts` bands by
 *    worker and this function retries on the residual race.
 *  - The stderr listener is attached before anything waits, so a hub that
 *    refuses to start reports its reason instead of a timeout.
 *  - Readiness races the child's `exit`. Without that, a hub that died in a
 *    second still costs the full ready timeout and reports "did not answer"
 *    for a process that said exactly what was wrong.
 */
async function startSpawned(options: GatewayOptions, workspace: Workspace): Promise<Gateway> {
  assertBuildIsFresh();
  const attempts = 3;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const port = await freePort();
    try {
      return await spawnOnce(options, workspace, port);
    } catch (error) {
      releasePort(port);
      lastError = error;
      if (!String(error).includes('EADDRINUSE')) throw error;
    }
  }
  throw lastError;
}

async function spawnOnce(options: GatewayOptions, workspace: Workspace, port: number): Promise<Gateway> {
  const baseUrl = `http://127.0.0.1:${port}`;
  assertLoopback(baseUrl);
  const env = hubEnvironment(options, workspace, baseUrl, port);
  const log = new LogTail();

  const child = spawn(process.execPath, [DIST_ENTRY], { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  log.attach(child.stdout);
  log.attach(child.stderr);

  let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  child.on('exit', (code, signal) => {
    exited = { code, signal };
  });

  try {
    await waitForHttp(`${baseUrl}/livez`, {
      timeoutMs: options.readyTimeoutMs ?? 30_000,
      ready: response => response.status === 200,
      abandonIf: () => (exited ? `it exited with code ${exited.code}, signal ${exited.signal}` : undefined)
    });
  } catch (error) {
    child.kill('SIGKILL');
    throw decorate(error, `starting ${DIST_ENTRY} on port ${port}`, log.text());
  }

  if (options.waitUntilSettled !== false) {
    // The listener is up before the children are; `/health` is the only view of
    // them from out here, and it needs the very token this gateway does not
    // have yet. `waitUntilSettled()` is in-process only, so the equivalent is
    // the line the supervisor logs when it has finished its first pass.
    await settleFromLog(log, Object.keys(options.servers).length).catch(() => undefined);
  }

  const stop = async (): Promise<void> => {
    if (!exited) {
      child.kill('SIGTERM');
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 10_000);
        timer.unref();
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    releasePort(port);
    workspace.remove();
  };

  return {
    tier: 'process',
    baseUrl,
    externalUrl: baseUrl,
    password: env.PASSWORD,
    target: baseUrl,
    workspace,
    internals: () => {
      throw new Error(
        'mcp-hub e2e: internals() is in-process only. Out here the same questions ' +
          'are answered by /health (server states, restart counts), the log ' +
          '(restarts, reloads, backoff) and mcp-hub-admin (clients, tokens).'
      );
    },
    admin: argv => runAdmin(argv, { DATA_PATH: workspace.data, CONFIG_PATH: workspace.configPath, EXTERNAL_URL: baseUrl }),
    writeConfig: servers => applyConfig(workspace, servers),
    signal: async signal => {
      child.kill(signal);
      return new Promise(resolve => {
        if (exited) return resolve(exited.code);
        child.once('exit', code => resolve(code));
      });
    },
    restart: async () => {
      throw new Error('mcp-hub e2e: restart() lands with the docker tier, where a supervisor owns the process.');
    },
    stderr: () => log.text(),
    logLines: pattern => log.matching(pattern),
    waitForLog: (pattern, timeoutMs) => log.waitForLine(pattern, timeoutMs),
    explain: (error, what) => decorate(error, what, log.text()),
    stop
  };
}

/**
 * Waits for the supervisor's first pass, from outside the process.
 *
 * Every child reports itself exactly once at boot — `[name] up (…)` when it
 * connected, or a failure line when it did not. Counting those is the only
 * signal available out here, and it is a best-effort one: a caller that needs
 * certainty asks `/health`, which is authoritative but needs a token.
 */
function settleFromLog(log: LogTail, expected: number): Promise<void> {
  if (expected === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('children did not settle')), 30_000);
    deadline.unref();
    const poll = setInterval(() => {
      // The four lines supervisor.ts writes exactly once per child at boot.
      const reported = log.matching(/^\[[^\]]+\] (up|down|sleeping|unauthorized) /).length;
      if (reported >= expected) {
        clearInterval(poll);
        clearTimeout(deadline);
        resolve();
      }
    }, 25);
    poll.unref();
  });
}

/**
 * Replaces the config and waits for the hub to have read it.
 *
 * In-process the watcher is right there and its event is the truth. Out of
 * process the truth is the log line the hub writes when it reloads — and the
 * poll fallback means that can take a moment, which is exactly why the E2E
 * suite sets `MCP_CONFIG_POLL_INTERVAL_MS` low rather than sleeping.
 */
async function applyConfig(workspace: Workspace, servers: Record<string, unknown>, hub?: HubInternals): Promise<void> {
  const applied = hub
    ? new Promise<void>(resolve => hub.watcher.once('change', () => resolve()))
    : Promise.resolve(); // the caller waits on a log line or on /health
  workspace.writeConfig(servers);
  await applied;
}

/**
 * The admin CLI as a real second process against the same state file.
 *
 * `CONFIG_PATH` travels with `DATA_PATH`, because the `upstream` commands read
 * the same `mcp.json` the hub does — its own usage text says to run them inside
 * the container for exactly that reason. Without it they fall back to
 * `/config/mcp.json`, find nothing, and exit 1 for a reason that has nothing to
 * do with what was asked.
 *
 * Always spawned, even in-process: what `mcp-hub-admin` actually does is talk
 * to a store that another process also holds open, and a test that called the
 * same `AuthStore` instance would prove the opposite of what it claims. That
 * exact mistake shipped once — a revocation that reported success, did nothing,
 * and was resurrected by the hub's next write.
 */
async function runAdmin(argv: string[], env: Record<string, string>): Promise<AdminResult> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [DIST_ADMIN, ...argv], {
      cwd: REPO_ROOT,
      env: { PATH: process.env.PATH ?? '', ...env },
      timeout: 60_000
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? String(error) };
  }
}

/**
 * Mirrors console output into a tail, in-process.
 *
 * The one place the tiers genuinely differ. A spawned hub has a real stderr
 * pipe; in-process its output goes through `console`, so the tail has to be
 * spliced in. Output still reaches the terminal — swallowing it would make a
 * failing in-process test harder to read than a spawned one, which is backwards.
 */
function interceptConsole(log: LogTail): () => void {
  const methods = ['log', 'warn', 'error'] as const;
  const originals = methods.map(name => [name, console[name]] as const);
  for (const [name, original] of originals) {
    console[name] = (...args: unknown[]) => {
      log.push(`${args.map(String).join(' ')}\n`);
      original(...args);
    };
  }
  return () => {
    for (const [name, original] of originals) console[name] = original;
  };
}

/**
 * The image, through the demo stack.
 *
 * Slow, and the only tier that answers the questions a process cannot: does it
 * run as uid 1000, does the healthcheck command actually pass, does a read-only
 * root filesystem break the tool cache, is tini reaping, does the admin CLI
 * work through `docker compose exec` the way `demo/token.sh` invokes it.
 *
 * Fixture paths have to be rewritten: the config the test wrote names host
 * paths, and inside the container the fixtures live under `/app/e2e-servers`.
 * Done here rather than asked of every caller, so a suite can be pointed at
 * this tier without knowing it is there.
 */
async function startContainerised(options: GatewayOptions, workspace: Workspace): Promise<Gateway> {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  assertLoopback(baseUrl);
  // `-p` needs a name that is unique per stack and stable across the calls that
  // address it; the port already is both.
  const project = `mcphub-e2e-${port}`;
  const log = new LogTail();

  copyFixturesInto(workspace, options.servers);
  const overrideFile = writeOverride(workspace, project, port, {
    PASSWORD: options.password ?? E2E_PASSWORD,
    RESOURCE_BOUND_TOKENS: 'true',
    ...options.env
  });

  let stack: ComposeStack | undefined;
  try {
    await composeUp(project, overrideFile);
    stack = composeStack(project, overrideFile, port);
    await waitForHttp(`${baseUrl}/livez`, { timeoutMs: options.readyTimeoutMs ?? 180_000, ready: response => response.status === 200 });
  } catch (error) {
    const output = stack ? await stack.logs() : '';
    await composeStack(project, overrideFile, port).down();
    releasePort(port);
    throw decorate(error, `bringing up the demo stack on port ${port}`, output);
  }

  const live = stack;
  // The container's log is the hub's stderr here. Polled rather than streamed:
  // `compose logs -f` would need a child process to own for the whole run, and
  // everything this tier asserts about the log is after the fact.
  const refresh = async (): Promise<string> => {
    const text = await live.logs(500);
    log.push('');
    return text;
  };

  return {
    tier: 'docker',
    baseUrl,
    externalUrl: baseUrl,
    password: options.password ?? options.env?.PASSWORD ?? E2E_PASSWORD,
    target: baseUrl,
    workspace,
    internals: () => {
      throw new Error('mcp-hub e2e: internals() is in-process only; at the docker tier use /health, the container log and mcp-hub-admin.');
    },
    // Through `docker compose exec`, which is exactly how `demo/token.sh` does
    // it — so the path the demo documents is the path under test.
    admin: async argv => live.exec(['node', 'dist/admin.js', ...argv]),
    writeConfig: async servers => {
      copyFixturesInto(workspace, servers);
      workspace.writeConfig(rewriteForContainer(servers));
    },
    signal: async () => {
      throw new Error('mcp-hub e2e: signal() is not meaningful here — the container supervisor owns the process. Use restart().');
    },
    restart: async () => {
      await live.exec(['true']);
      await composeUp(project, overrideFile);
      await waitForHttp(`${baseUrl}/livez`, { timeoutMs: 120_000, ready: response => response.status === 200 });
    },
    stderr: () => log.text(),
    logLines: pattern => log.matching(pattern),
    waitForLog: async (pattern, timeoutMs = 30_000) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const text = await refresh();
        const line = text.split('\n').find(candidate => pattern.test(candidate));
        if (line !== undefined) return line;
        if (Date.now() >= deadline) throw new Error(`mcp-hub e2e: no container log line matched ${pattern} within ${timeoutMs}ms.\n\n${text}`);
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    },
    explain: (error, what) => decorate(error, what, log.text()),
    stop: async () => {
      await live.down();
      releasePort(port);
      workspace.remove();
    }
  };
}

/**
 * Puts the fixture files where the container can see them, and rewrites the
 * config to name them there.
 *
 * The host paths a suite writes are absolute and meaningless inside the
 * container; copying rather than mounting the whole repository keeps the
 * container's view to exactly the fixtures a test asked for.
 */
function copyFixturesInto(workspace: Workspace, servers: Record<string, unknown>): void {
  for (const config of Object.values(servers)) {
    for (const arg of ((config as { args?: unknown[] }).args ?? []) as unknown[]) {
      if (typeof arg !== 'string' || !arg.endsWith('.mjs') || !fs.existsSync(arg)) continue;
      const dir = path.dirname(arg);
      // A fixture may import a sibling (`_catalogue.mjs`, `_kit.mjs`), so the
      // whole directory travels rather than the one file named in the config.
      for (const entry of fs.readdirSync(dir)) {
        if (entry.endsWith('.mjs')) fs.copyFileSync(path.join(dir, entry), path.join(workspace.servers, entry));
      }
    }
  }
  workspace.writeConfigInPlace(rewriteForContainer(servers));
}

function rewriteForContainer(servers: Record<string, unknown>): Record<string, unknown> {
  const rewritten: Record<string, unknown> = {};
  for (const [name, config] of Object.entries(servers)) {
    const entry = { ...(config as Record<string, unknown>) };
    if (Array.isArray(entry.args)) {
      entry.args = (entry.args as unknown[]).map(arg =>
        typeof arg === 'string' && arg.endsWith('.mjs') ? `/app/e2e-servers/${path.basename(arg)}` : arg
      );
    }
    // The container has its own node on PATH; an absolute host path to a
    // developer's node binary is meaningless inside it.
    if (entry.command === process.execPath) entry.command = 'node';
    rewritten[name] = entry;
  }
  return rewritten;
}
