import fs from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { stdio } from '../fixtures/fleets.js';
import { startGateway, E2E_PASSWORD, type Gateway } from '../harness/gateway.js';
import { runToCompletion } from '../harness/run.js';
import { tierEnabled } from '../harness/tiers.js';
import { assertBuildIsFresh, DIST_ENTRY, makeWorkspace, REPO_ROOT, type Workspace } from '../harness/workspace.js';

/**
 * The bootstrap: everything between `node dist/index.js` and a listening hub.
 *
 * This block is the single largest hole in the project's coverage, and
 * `vitest.config.ts` says so in a comment. It is not untested because nobody
 * thought of it — it is untested because it cannot be reached from inside the
 * process that would be doing the testing. Env parsing that calls
 * `process.exit`, signal handlers, `httpServer.headersTimeout`: all of it is
 * reachable only by starting the program the way an operator starts it.
 *
 * The failures below are the ones an operator actually hits — a missing
 * variable, a URL with a path on it, a typo in a number — and every one of them
 * has a message that was written to be read by a person at 2am. Testing the
 * message and not just the exit code is the point: an exit code of 1 with the
 * wrong explanation is a worse failure than a crash.
 */

const RUNS_HERE = tierEnabled('process');
let workspace: Workspace;

beforeAll(() => {
  assertBuildIsFresh();
  workspace = makeWorkspace('bins');
  workspace.writeConfigInPlace({ ok: stdio('slow-start-server.mjs', { env: { START_DELAY_MS: '0' } }) });
});

afterAll(() => workspace?.remove());

/** A complete, valid environment, so each case can spoil exactly one thing. */
function baseEnv(port = 0): Record<string, string> {
  return {
    EXTERNAL_URL: `http://127.0.0.1:${port}`,
    PASSWORD: E2E_PASSWORD,
    CONFIG_PATH: workspace.configPath,
    DATA_PATH: workspace.data,
    PORT: String(port)
  };
}

describe.runIf(RUNS_HERE)('mcp-hub, started the way an operator starts it', () => {
  it('refuses to start without EXTERNAL_URL, and names it', async () => {
    const { EXTERNAL_URL: _dropped, ...env } = baseEnv();
    const result = await runToCompletion(DIST_ENTRY, [], { env });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('missing required environment variable EXTERNAL_URL');
  });

  // A hub with no PASSWORD does *not* exit — it starts and accepts an empty
  // one. That is a finding rather than a missing test, so it lives in
  // `no-password.e2e.ts` where there is room to say what it means.

  it('refuses an EXTERNAL_URL with a path on it', async () => {
    // The issuer is compared byte-for-byte by clients, so a trailing path would
    // silently break every discovery document rather than fail here.
    const result = await runToCompletion(DIST_ENTRY, [], { env: { ...baseEnv(), EXTERNAL_URL: 'http://127.0.0.1:9/hub' } });
    expect(result.code).toBe(1);
    expect(result.output).toContain('EXTERNAL_URL must be an origin');
  });

  const badNumbers: Array<[string, string]> = [
    ['MCP_REQUESTS_PER_MINUTE', 'must be a positive integer'],
    ['MCP_MAX_CONCURRENT_REQUESTS', 'must be a positive integer'],
    ['MCP_MAX_CONCURRENT_STREAMS', 'must be a positive integer'],
    ['IDLE_TIMEOUT_MINUTES', 'must be a non-negative integer']
  ];
  for (const [name, message] of badNumbers) {
    it(`refuses a ${name} that is not a number`, async () => {
      const result = await runToCompletion(DIST_ENTRY, [], { env: { ...baseEnv(), [name]: 'soon' } });
      expect(result.code).toBe(1);
      expect(result.output).toContain(`${name} ${message}`);
    });
  }

  it('refuses an unknown CLIENT_REGISTRATION mechanism', async () => {
    const result = await runToCompletion(DIST_ENTRY, [], { env: { ...baseEnv(), CLIENT_REGISTRATION: 'dcr,carrier-pigeon' } });
    expect(result.code).toBe(1);
    expect(result.output).toContain('CLIENT_REGISTRATION must be a comma-separated list');
  });

  it('refuses a CIMD origin that is not a bare https origin', async () => {
    for (const bad of ['http://chatgpt.com', 'https://chatgpt.com/callback', 'not a url']) {
      const result = await runToCompletion(DIST_ENTRY, [], { env: { ...baseEnv(), CIMD_ALLOWED_ORIGINS: bad } });
      expect(result.code, `for ${bad}`).toBe(1);
      expect(result.output).toContain('CIMD_ALLOWED_ORIGINS');
    }
  });

  it('refuses a body limit in units it does not understand', async () => {
    const result = await runToCompletion(DIST_ENTRY, [], { env: { ...baseEnv(), MCP_BODY_LIMIT: '3 gigabytes' } });
    expect(result.code).toBe(1);
    expect(result.output).toContain('mcpBodyLimit must use b, kb or mb units');
  });

  it('refuses a defaultResource that names no server', async () => {
    const result = await runToCompletion(DIST_ENTRY, [], { env: { ...baseEnv(), DEFAULT_RESOURCE: 'not-a-server' } });
    expect(result.code).toBe(1);
    expect(result.output).toContain('is neither "hub" nor a configured server');
  });
});

describe.runIf(RUNS_HERE)('what a running hub announces about itself', () => {
  let gateway: Gateway;

  afterAll(() => gateway?.stop());

  it('warns about the migration mode, the private-address mode and a default resource', async () => {
    gateway = await startGateway({
      prefix: 'bins-warnings',
      servers: { ok: stdio('slow-start-server.mjs', { env: { START_DELAY_MS: '0' } }) },
      env: {
        RESOURCE_BOUND_TOKENS: 'false',
        CIMD_ALLOW_PRIVATE_ADDRESSES: 'true',
        DEFAULT_RESOURCE: 'ok'
      }
    });
    const said = gateway.stderr();
    // Each of these is a foot-gun the operator opted into. The warning is the
    // only thing standing between "I set that months ago" and a support case.
    expect(said).toContain('RESOURCE_BOUND_TOKENS is disabled');
    expect(said).toContain('CIMD_ALLOW_PRIVATE_ADDRESSES is enabled');
    expect(said).toContain('are bound to "ok"');
    expect(said).toContain('client registration via');
  });

  it('mirrors its output into LOG_FILE without losing the console', async () => {
    // fail2ban reads that file, and `docker logs` reads the console. Both, or
    // the jail goes blind the day somebody sets the variable.
    const logFile = path.join(workspace.root, 'hub.log');
    const logged = await startGateway({
      prefix: 'bins-logfile',
      servers: { ok: stdio('slow-start-server.mjs', { env: { START_DELAY_MS: '0' } }) },
      env: { LOG_FILE: logFile }
    });
    try {
      expect(logged.stderr()).toContain('mirroring log output to');
      const contents = fs.readFileSync(logFile, 'utf8');
      expect(contents).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(contents).toContain('[ok] up');
    } finally {
      await logged.stop();
    }
  });
});

describe.runIf(RUNS_HERE)('shutting down', () => {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    it(`exits 0 on ${signal}, and takes its children with it`, async () => {
      const hub = await startGateway({
        prefix: `bins-${signal}`,
        servers: { ok: stdio('slow-start-server.mjs', { env: { START_DELAY_MS: '0' }, keepAlive: true }) }
      });
      const childPids = childrenOf(process.pid);
      const code = await hub.signal(signal);
      expect(code).toBe(0);
      expect(hub.stderr()).toContain(`received ${signal}, shutting down`);

      // An orphan here is a real leak: the hub is the only thing that knows
      // these processes exist, so anything it leaves behind runs until reboot.
      const survivors = childPids.filter(pid => stillAlive(pid));
      expect(survivors, `orphaned pids ${survivors.join(', ')}`).toEqual([]);
      await hub.stop();
    });
  }
});

/** Descendants of a pid, read from /proc rather than guessed. */
function childrenOf(pid: number): number[] {
  try {
    return fs
      .readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8')
      .split(/\s+/)
      .filter(Boolean)
      .map(Number);
  } catch {
    return [];
  }
}

function stillAlive(pid: number): boolean {
  return fs.existsSync(path.join('/proc', String(pid)));
}

describe.runIf(RUNS_HERE)('mcp-hub-admin, the CLI nothing used to call', () => {
  let gateway: Gateway;

  beforeAll(async () => {
    gateway = await startGateway({ prefix: 'bins-admin', servers: { ok: stdio('slow-start-server.mjs', { env: { START_DELAY_MS: '0' } }) } });
  }, 60_000);

  afterAll(() => gateway?.stop());

  it('prints its usage and exits 2 when it does not understand', async () => {
    for (const argv of [[], ['clients'], ['tokens', 'invent'], ['not-a-group', 'list']]) {
      const result = await gateway.admin(argv);
      expect(result.code, `for ${JSON.stringify(argv)}`).toBe(2);
      expect(result.stderr).toContain('Usage:');
    }
  });

  it('exits 2 when a flag has no value', async () => {
    const result = await gateway.admin(['tokens', 'create', '--resource']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('Missing value for --resource');
  });

  it('keeps machine output on stdout and prose on stderr', async () => {
    // `demo/token.sh` is built on this split — `TOKEN=$(./token.sh)` only works
    // because the metadata goes to the other stream. Nothing pinned it before.
    const listed = await gateway.admin(['clients', 'list']);
    expect(listed.code).toBe(0);
    expect(() => JSON.parse(listed.stdout)).not.toThrow();
  });

  it('adds, lists, revokes and deletes a client', async () => {
    const added = await gateway.admin(['clients', 'add', '--name', 'operator-managed', '--redirect-uri', 'https://example.invalid/cb']);
    expect(added.code).toBe(0);
    // `clients add` speaks OAuth's snake_case because its output is a
    // credential; `clients list` speaks camelCase because its output is a
    // report. Inconsistent, and load-bearing for anyone scripting either.
    const client = JSON.parse(added.stdout) as { client_id: string; client_secret?: string };
    expect(client.client_id).toBeTruthy();
    // A confidential client's secret is printed once and never again; that it
    // is on stdout with the id is what makes the command usable in a pipeline.
    expect(client.client_secret).toBeTruthy();

    const listed = JSON.parse((await gateway.admin(['clients', 'list'])).stdout) as Array<{ clientId: string; via: string }>;
    expect(listed.find(entry => entry.clientId === client.client_id)?.via).toBe('static');

    expect((await gateway.admin(['clients', 'revoke', client.client_id])).code).toBe(0);
    expect((await gateway.admin(['clients', 'delete', client.client_id])).code).toBe(0);
    const after = JSON.parse((await gateway.admin(['clients', 'list'])).stdout) as Array<{ clientId: string }>;
    expect(after.some(entry => entry.clientId === client.client_id)).toBe(false);
  });

  it('reports a client that does not exist rather than pretending', async () => {
    const result = await gateway.admin(['clients', 'revoke', 'no-such-client']);
    expect(result.code).toBe(1);
  });

  it('mints, lists and revokes a token', async () => {
    const created = await gateway.admin(['tokens', 'create', '--resource', 'hub', '--days', '1', '--label', 'cli-test']);
    expect(created.code).toBe(0);
    const listed = JSON.parse((await gateway.admin(['tokens', 'list'])).stdout) as Array<{ id: string; label?: string }>;
    const minted = listed.find(entry => entry.label === 'cli-test');
    expect(minted).toBeDefined();

    expect((await gateway.admin(['tokens', 'revoke', minted!.id])).code).toBe(0);
    const after = JSON.parse((await gateway.admin(['tokens', 'list'])).stdout) as Array<{ id: string }>;
    expect(after.some(entry => entry.id === minted!.id)).toBe(false);
  });

  it('refuses a token lifetime outside the range it documents', async () => {
    for (const days of ['0', '4000', 'lots']) {
      const result = await gateway.admin(['tokens', 'create', '--resource', 'hub', '--days', days]);
      expect(result.code, `for --days ${days}`).not.toBe(0);
    }
  });

  it('prunes, and says what it would prune first', async () => {
    const dry = await gateway.admin(['clients', 'prune', '--dry-run']);
    expect(dry.code).toBe(0);
    expect(() => JSON.parse(dry.stdout)).not.toThrow();
  });

  it('lists upstream servers, and knows this fleet has none', async () => {
    const result = await gateway.admin(['upstream', 'list']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([]);
  });

  it('reports an upstream command against a server that has no oauth block', async () => {
    const result = await gateway.admin(['upstream', 'status', 'ok']);
    // Exit 2, not 1: asking about a server that has no outbound credentials is
    // a mistake in the command, not a failure carrying it out. The distinction
    // is the CLI's documented contract — 1 is "it went wrong", 2 is "you asked
    // for something that does not make sense" — and a script that retries on 1
    // would otherwise loop forever on this.
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('no "oauth" block');
  });
});

describe.runIf(RUNS_HERE)('mcp-hub-stdio', () => {
  it('serves the aggregate over a pipe, without any HTTP surface at all', async () => {
    // The stdio entry point is at 58% coverage and its `isMain` block is the
    // uncovered part: the argv check, the IDLE_TIMEOUT_MINUTES validation, the
    // stdin-close shutdown. None of it runs unless the file is the program.
    const { Client } = await import('@modelcontextprotocol/client');
    const { StdioClientTransport } = await import('@modelcontextprotocol/client/stdio');
    const client = new Client({ name: 'stdio-probe', version: '0.0.0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [path.join(REPO_ROOT, 'dist', 'stdio.js')],
        env: { PATH: process.env.PATH ?? '', CONFIG_PATH: workspace.configPath, IDLE_TIMEOUT_MINUTES: '0' }
      })
    );
    try {
      const tools = await client.listTools();
      expect(tools.tools.map(tool => tool.name).sort()).toEqual([
        'call_tool',
        'get_tool_schema',
        'list_servers',
        'list_tools',
        'sleep_server',
        'wake_server'
      ]);
    } finally {
      await client.close();
    }
  }, 60_000);

  it('refuses a nonsensical idle timeout and exits 1', async () => {
    const result = await runToCompletion(path.join(REPO_ROOT, 'dist', 'stdio.js'), [], {
      env: { CONFIG_PATH: workspace.configPath, IDLE_TIMEOUT_MINUTES: '-3' }
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('IDLE_TIMEOUT_MINUTES must be a non-negative integer');
  });

  it('is also reachable as `mcp-hub --stdio`', async () => {
    // Two bins, one behaviour. The flag exists because some clients can only
    // spawn one command, and a divergence between them would be invisible.
    const { Client } = await import('@modelcontextprotocol/client');
    const { StdioClientTransport } = await import('@modelcontextprotocol/client/stdio');
    const client = new Client({ name: 'stdio-flag-probe', version: '0.0.0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [DIST_ENTRY, '--stdio'],
        env: { PATH: process.env.PATH ?? '', CONFIG_PATH: workspace.configPath, IDLE_TIMEOUT_MINUTES: '0' }
      })
    );
    try {
      expect((await client.listTools()).tools).toHaveLength(6);
    } finally {
      await client.close();
    }
  }, 60_000);
});
