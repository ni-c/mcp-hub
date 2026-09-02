import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { CallToolResult, ClientOptions } from '@modelcontextprotocol/client';
import { withInputRequired } from '@modelcontextprotocol/client';
import { CallToolResultSchema } from '@modelcontextprotocol/core';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createStdioHub, redirectStdoutLogging } from '../src/stdio.js';
import { loadConfig } from '../src/config.js';
import { ToolCache } from '../src/tool-cache.js';

const EVERYTHING = path.resolve('node_modules/@modelcontextprotocol/server-everything/dist/index.js');
const ELICIT_FIXTURE = path.resolve('test/fixtures/modern-elicit-server.mjs');

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not reached in time');
    await sleep(20);
  }
}

function writeConfig(servers: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-stdio-'));
  const file = path.join(dir, 'mcp.json');
  fs.writeFileSync(file, JSON.stringify({ mcpServers: servers }));
  return file;
}

const started: Array<Awaited<ReturnType<typeof createStdioHub>>> = [];

// idleTimeoutMinutes: 0 unless a test is about the lifecycle — every other
// assertion here is about the transport, and on-demand would make "is the
// child up" a moving target.
function startHub(configPath: string, options: { idleTimeoutMinutes?: number; toolCachePath?: string; dataPath?: string } = {}) {
  const hub = createStdioHub({ configPath, idleTimeoutMinutes: 0, ...options });
  started.push(hub);
  return hub;
}

async function connect(hub: ReturnType<typeof startHub>): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  // build() rather than a ready-made instance: runStdio hands the factory to
  // serveStdio, which pins one instance per connection once the opening
  // exchange has settled the era. Calling it here is what that entry point does.
  await hub.build().connect(serverTransport);
  const client = new Client({ name: 'vitest', version: '1.0.0' });
  await client.connect(clientTransport);
  return client;
}

/**
 * The same hub through the entry point that owns the era decision.
 *
 * `connect()` above wires a server to a transport by hand, which pins the
 * connection to 2025 whatever the client asks for. This one goes through
 * serveStdio, so a modern client actually gets the modern era — and a legacy
 * one still gets what it always got.
 */
async function connectVia(hub: ReturnType<typeof startHub>, options: ClientOptions = {}): Promise<{ client: Client; close: () => Promise<void> }> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(() => hub.build(), { transport: serverTransport });
  const client = new Client({ name: 'vitest', version: '1.0.0' }, options);
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await handle.close();
    }
  };
}

afterEach(async () => {
  for (const hub of started.splice(0)) {
    hub.watcher.stop();
    await hub.supervisor.stop();
  }
});

describe('stdio mode', () => {
  it('serves the same meta-tools the /hub endpoint serves', async () => {
    const hub = startHub(writeConfig({}));
    const client = await connect(hub);
    const { tools } = await client.listTools();
    expect(tools.map(t => t.name).sort()).toEqual([
      'call_tool',
      'get_tool_schema',
      'list_servers',
      'list_tools',
      'sleep_server',
      'wake_server'
    ]);
    await client.close();
  });

  it('proxies a tool call to a configured child server', async () => {
    const hub = startHub(writeConfig({ everything: { command: process.execPath, args: [EVERYTHING] } }));
    const client = await connect(hub);
    await waitFor(() => hub.supervisor.get('everything')?.state === 'up');

    const listed = (await client.callTool({ name: 'list_servers', arguments: {} })) as CallToolResult;
    expect(listed.content[0].text).toContain('everything');

    const echoed = (await client.callTool({
      name: 'call_tool',
      arguments: { server: 'everything', tool: 'echo', arguments: { message: 'over stdio' } }
    })) as CallToolResult;
    expect(echoed.content[0].text).toContain('over stdio');
    await client.close();
  });

  it('applies the tool filter in stdio mode too', async () => {
    // buildHubServer is shared between the HTTP and stdio entry points, so this
    // needs no stdio-specific code — which is exactly what it checks.
    const hub = startHub(
      writeConfig({ everything: { command: process.execPath, args: [EVERYTHING], denyTools: ['get-*'] } })
    );
    const client = await connect(hub);
    // Not just `state === 'up'`: refreshTools() fills managed.tools afterwards,
    // asynchronously, so waiting on the state alone races the list this test
    // reads. It passed locally and failed on CI, which is the usual shape.
    await waitFor(() => (hub.supervisor.get('everything')?.tools.length ?? 0) > 0);

    const listed = (await client.callTool({ name: 'list_tools', arguments: { server: 'everything' } })) as CallToolResult;
    expect(listed.content[0].text).toContain('echo');
    expect(listed.content[0].text).not.toContain('get-env');

    const refused = (await client.callTool({
      name: 'call_tool',
      arguments: { server: 'everything', tool: 'get-env', arguments: {} }
    })) as CallToolResult;
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain('Unknown tool');
    await client.close();
  });

  it('starts with an empty hub when the config file does not exist', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-stdio-'));
    const hub = startHub(path.join(dir, 'mcp.json'));
    const client = await connect(hub);
    const listed = (await client.callTool({ name: 'list_servers', arguments: {} })) as CallToolResult;
    expect(listed.structuredContent).toEqual({ servers: [] });
    await client.close();
  });

  it('picks up servers added to the config while running', async () => {
    const configPath = writeConfig({});
    const hub = startHub(configPath);
    fs.writeFileSync(configPath, JSON.stringify({ mcpServers: { everything: { command: process.execPath, args: [EVERYTHING] } } }));
    await waitFor(() => hub.supervisor.get('everything') !== undefined);
  });

  it('survives a config path whose directory does not exist', async () => {
    const hub = startHub(path.join(os.tmpdir(), 'mcp-hub-stdio-absent', 'mcp.json'));
    const client = await connect(hub);
    const listed = (await client.callTool({ name: 'list_servers', arguments: {} })) as CallToolResult;
    expect(listed.structuredContent).toEqual({ servers: [] });
    await client.close();
  });

  it('boots a cached server into sleeping and wakes it on a call', async () => {
    const configPath = writeConfig({ everything: { command: process.execPath, args: [EVERYTHING] } });
    const toolCachePath = path.join(path.dirname(configPath), '.mcp-hub', 'tool-cache.json');
    const seeded = new ToolCache(toolCachePath);
    seeded.put('everything', {
      fingerprint: ToolCache.fingerprint(loadConfig(configPath).get('everything')!),
      serverInfo: { name: 'everything-cached', version: '0.0.1' },
      capabilities: { tools: {} },
      tools: [{ name: 'echo', description: 'from the cache', inputSchema: { type: 'object' } }],
      updatedAt: new Date().toISOString()
    });

    // No toolCachePath: this asserts the default lands beside the config, so a
    // hub spawned per client session does not warm-start every server.
    const hub = startHub(configPath, { idleTimeoutMinutes: 60 });
    await hub.supervisor.waitUntilSettled();
    expect(hub.supervisor.get('everything')!.state).toBe('sleeping');

    const client = await connect(hub);
    const echoed = (await client.callTool({
      name: 'call_tool',
      arguments: { server: 'everything', tool: 'echo', arguments: { message: 'wake up' } }
    })) as CallToolResult;
    expect(echoed.content[0].text).toContain('wake up');
    expect(hub.supervisor.get('everything')!.state).toBe('up');
    await client.close();
  }, 30_000);

  it('moves console.log and console.info to stderr and restores them', () => {
    const seen: unknown[][] = [];
    const originalError = console.error;
    const originalLog = console.log;
    console.error = (...args: unknown[]) => seen.push(args);
    const restore = redirectStdoutLogging();
    console.log('to stderr');
    console.info('also to stderr');
    restore();
    console.error = originalError;
    expect(seen).toEqual([['to stderr'], ['also to stderr']]);
    expect(console.log).toBe(originalLog);
  });
});

describe('the --stdio entrypoint', () => {
  // The protocol owns stdout: one stray log line desynchronises every client,
  // and the hub logs plenty (child state changes, config reloads). Assert it
  // on the real process rather than trusting the wrapper in isolation.
  it('keeps stdout free of everything but JSON-RPC', async () => {
    const configPath = writeConfig({ everything: { command: process.execPath, args: [EVERYTHING] } });
    const child = spawn(process.execPath, ['--import', 'tsx', path.resolve('src/index.ts'), '--stdio'], {
      cwd: path.resolve('.'),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CONFIG_PATH: configPath }
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => (stdout += chunk));
    child.stderr.on('data', chunk => (stderr += chunk));

    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'vitest', version: '1.0.0' } }
    });
    await waitFor(() => stdout.includes('"id":1'));
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    // Wait for the child server to come up: its "[everything] up" line is the
    // console.log that would land on stdout without the redirect.
    await waitFor(() => stderr.includes('[everything] up'));
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_servers', arguments: {} } });
    await waitFor(() => stdout.includes('"id":2'));

    try {
      const lines = stdout.split('\n').filter(Boolean);
      for (const line of lines) expect(() => JSON.parse(line) as unknown).not.toThrow();
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[1]).result.content[0].text).toContain('everything');
      expect(stderr).toContain('serving the hub aggregate over stdio');
    } finally {
      child.kill();
    }
  }, 30_000);

  // npm links a bin entry as node_modules/.bin/<name> — a symlink whose
  // basename is the command, not the file. Started that way, the entry point
  it('accepts a modern opening on the real process', async () => {
    // The two tests around this one prove the 2025 opening still works. This is
    // the other half: runStdio hands the factory to serveStdio, so a client that
    // offers the 2026 revision is answered in it rather than talked back down.
    // Against the hand-wired transport this was structurally impossible.
    const configPath = writeConfig({});
    const client = new Client(
      { name: 'vitest', version: '1.0.0' },
      { capabilities: { elicitation: { form: {} } }, versionNegotiation: { mode: 'auto' } }
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', path.resolve('src/index.ts'), '--stdio'],
      cwd: path.resolve('.'),
      env: { ...process.env, CONFIG_PATH: configPath } as Record<string, string>
    });
    await client.connect(transport);
    try {
      expect(client.getProtocolEra()).toBe('modern');
      const { tools } = await client.listTools();
      expect(tools.map(t => t.name)).toContain('call_tool');
    } finally {
      await client.close();
    }
  }, 30_000);

  // has to recognise itself; the first version compared basenames, so
  // `npx @ni-c/mcp-hub` exited 0 without doing anything.
  it('starts when it is invoked through a bin symlink', async () => {
    const configPath = writeConfig({});
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-bin-'));
    const link = path.join(binDir, 'mcp-hub');
    fs.symlinkSync(path.resolve('src/index.ts'), link);

    const child = spawn(process.execPath, ['--import', 'tsx', link, '--stdio'], {
      cwd: path.resolve('.'),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CONFIG_PATH: configPath }
    });
    let stdout = '';
    child.stdout.on('data', chunk => (stdout += chunk));

    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'vitest', version: '1.0.0' } }
      })}\n`
    );
    try {
      await waitFor(() => stdout.includes('"id":1'));
      expect(JSON.parse(stdout.split('\n')[0]).result.serverInfo.name).toBe('mcp-hub');
    } finally {
      child.kill();
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('upstream OAuth in stdio mode', () => {
  /** A config with one remote server that needs an upstream token. */
  function oauthConfig(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-stdio-oauth-'));
    const configPath = path.join(dir, 'mcp.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          saas: { type: 'http', url: 'https://saas.example/mcp', oauth: { mode: 'dcr', grant: 'authorization_code' } }
        }
      })
    );
    return configPath;
  }

  it('says why an OAuth upstream cannot work without a state directory', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // There is nowhere to read a token from here, and no listener for a
      // browser to come back to — so say so once instead of failing silently.
      startHub(oauthConfig());
      const said = warn.mock.calls.map(call => String(call[0])).join('\n');
      expect(said).toContain('saas');
      expect(said).toContain('DATA_PATH');
    } finally {
      warn.mockRestore();
    }
  });

  it('says the credentials have to be authorized against the HTTP hub first', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // A state directory that no hub has ever run against holds no issuer, so
      // there is nothing to reuse yet.
      const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-stdio-data-'));
      startHub(oauthConfig(), { dataPath });
      expect(warn.mock.calls.map(call => String(call[0])).join('\n')).toContain('authorize them against the HTTP hub');
    } finally {
      warn.mockRestore();
    }
  });

  it('stays quiet when no server needs one', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-stdio-plain-'));
      const configPath = path.join(dir, 'mcp.json');
      fs.writeFileSync(configPath, JSON.stringify({ mcpServers: { plain: { type: 'http', url: 'https://plain.example/mcp' } } }));
      startHub(configPath);
      expect(warn.mock.calls.map(call => String(call[0])).join('\n')).not.toContain('DATA_PATH');
    } finally {
      warn.mockRestore();
    }
  });
});

describe('stdio speaks both eras', () => {
  // Over HTTP the hub is stateless and shared, so a 2025 client has nowhere to
  // receive a question. Here the process belongs to one client — which is the
  // one place where asking a person is worth the most, and the one place it
  // used to be impossible because the transport was wired by hand.

  it('still serves a 2025 client exactly as before', async () => {
    const hub = startHub(writeConfig({}));
    const { client, close } = await connectVia(hub, { versionNegotiation: { mode: 'legacy' } });
    expect(client.getProtocolEra()).toBe('legacy');
    const { tools } = await client.listTools();
    expect(tools.map(t => t.name)).toContain('call_tool');
    await close();
  });

  it('carries a child question to the person at the keyboard', async () => {
    const hub = startHub(writeConfig({ elicit: { command: process.execPath, args: [ELICIT_FIXTURE] } }));
    await waitFor(() => hub.supervisor.get('elicit')?.state === 'up');

    const { client, close } = await connectVia(hub, {
      capabilities: { elicitation: { form: {} } },
      versionNegotiation: { mode: 'auto' },
      // The point is to see the question, not to have the client answer it.
      inputRequired: { autoFulfill: false }
    });
    expect(client.getProtocolEra()).toBe('modern');

    const args = { server: 'elicit', tool: 'confirm_thing', arguments: { what: 'delete it' } };
    const asked = (await client.request(
      { method: 'tools/call', params: { name: 'call_tool', arguments: args } },
      withInputRequired(CallToolResultSchema),
      { allowInputRequired: true }
    )) as { resultType?: string; requestState?: string; inputRequests?: Record<string, { params: { message: string } }> };

    expect(asked.resultType).toBe('input_required');
    expect(asked.inputRequests?.confirm?.params.message).toContain('Really delete it?');
    expect(asked.inputRequests?.confirm?.params.message.startsWith('Server "elicit" asks:')).toBe(true);

    const answered = await client.request(
      {
        method: 'tools/call',
        params: {
          name: 'call_tool',
          arguments: args,
          inputResponses: { confirm: { action: 'accept', content: { confirm: true } } },
          requestState: asked.requestState
        }
      },
      withInputRequired(CallToolResultSchema),
      { allowInputRequired: true }
    );
    expect(JSON.stringify(answered)).toContain('did delete it');

    await close();
  }, 30_000);
});
