import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { parseConfig, type DockerServerConfig, type HubConfig } from '../src/config.js';
import { createDockerProxy } from '../src/docker-proxy/server.js';
import { DockerClient } from '../src/sandbox/docker-client.js';
import { DockerTransport } from '../src/transports/docker.js';
import { OWNER_LABEL, OWNER_VALUE, SERVER_LABEL } from '../src/sandbox/container-spec.js';

/**
 * The proxy in front of a stand-in daemon.
 *
 * The daemon is fake, but nothing else is: the client is the hub's own
 * DockerClient, the attach endpoint really upgrades the connection, the frames
 * are really Docker's 8-byte framing, and behind them runs a real MCP server.
 * So this exercises create -> attach -> handshake -> tools/list end to end,
 * and it does so on a machine without Docker.
 */

const EVERYTHING = path.resolve('node_modules/@modelcontextprotocol/server-everything/dist/index.js');

const CONFIG_JSON = JSON.stringify({
  mcpServers: {
    everything: {
      type: 'docker',
      image: 'everything:test',
      env: { EXAMPLE: 'from-hub' },
      secretsFrom: 'everything'
    }
  }
});

interface DaemonRequest {
  method: string;
  url: string;
  body?: Record<string, unknown>;
}

let dir: string;
let daemonSocket: string;
let proxySocket: string;
let daemon: http.Server;
let proxy: http.Server;
let config: HubConfig;
const requests: DaemonRequest[] = [];
const children: ChildProcess[] = [];
let labelsOwned = true;

function frame(stream: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

function startFakeDaemon(): http.Server {
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      requests.push({
        method: request.method ?? '',
        url: request.url ?? '',
        body: raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : undefined
      });
      const send = (status: number, body: unknown) => {
        const payload = JSON.stringify(body);
        response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
        response.end(payload);
      };
      const url = (request.url ?? '').split('?')[0].replace(/^\/v\d+\.\d+/, '');
      if (url === '/_ping') {
        response.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': '2' });
        response.end('OK');
        return;
      }
      if (url === '/version') return send(200, { ApiVersion: '1.44' });
      if (url.endsWith('/json') && url.startsWith('/images/')) return send(200, { Id: 'sha256:1' });
      if (url.startsWith('/containers/') && url.endsWith('/json')) {
        return send(200, {
          Config: { Labels: { [OWNER_LABEL]: labelsOwned ? OWNER_VALUE : 'foreign', [SERVER_LABEL]: 'everything' } }
        });
      }
      if (url === '/containers/create') return send(201, { Id: 'container-1' });
      if (url.endsWith('/start')) return send(204, {});
      if (url === '/containers/json') return send(200, []);
      if (request.method === 'DELETE') return send(404, { message: 'no such container' });
      return send(500, { message: `fake daemon has no route for ${url}` });
    });
  });

  // attach: upgrade, then be a container — a real MCP server whose stdout is
  // framed the way the daemon frames it.
  server.on('upgrade', (request, socket: Duplex, head: Buffer) => {
    requests.push({ method: 'UPGRADE', url: request.url ?? '' });
    socket.write('HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n');
    const child = spawn(process.execPath, [EVERYTHING], { stdio: ['pipe', 'pipe', 'pipe'] });
    children.push(child);
    if (head?.length) child.stdin.write(head);
    socket.on('data', (chunk: Buffer) => child.stdin.write(chunk));
    child.stdout.on('data', (chunk: Buffer) => socket.write(frame(1, chunk)));
    child.stderr.on('data', (chunk: Buffer) => socket.write(frame(2, chunk)));
    // A real daemon ends the stream when the container goes; the fake has to
    // do the same or the connection outlives the test run.
    socket.on('end', () => socket.destroy());
    socket.on('close', () => child.kill());
    child.on('exit', () => socket.destroy());
  });
  return server;
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-proxy-'));
  daemonSocket = path.join(dir, 'docker.sock');
  proxySocket = path.join(dir, 'proxy.sock');
  fs.writeFileSync(path.join(dir, 'everything.env'), 'INJECTED_SECRET=hunter2\n', { mode: 0o600 });
  config = parseConfig(CONFIG_JSON, {} as NodeJS.ProcessEnv, { expand: false });

  daemon = startFakeDaemon();
  await new Promise<void>(resolve => daemon.listen(daemonSocket, resolve));
  proxy = createDockerProxy({ dockerSocket: daemonSocket, config: () => config, secretsDir: dir });
  await new Promise<void>(resolve => proxy.listen(proxySocket, resolve));
});

afterAll(async () => {
  for (const child of children) child.kill();
  // Upgraded connections never go idle, so close() alone would wait forever.
  proxy.closeAllConnections();
  daemon.closeAllConnections();
  await new Promise<void>(resolve => proxy.close(() => resolve()));
  await new Promise<void>(resolve => daemon.close(() => resolve()));
  fs.rmSync(dir, { recursive: true, force: true });
});

function rawRequest(method: string, url: string, body?: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const request = http.request(
      {
        socketPath: proxySocket,
        method,
        path: url,
        headers: { 'Content-Type': 'application/json', ...(payload ? { 'Content-Length': String(payload.length) } : {}) }
      },
      response => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      }
    );
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

describe('a sandboxed server through the proxy', () => {
  it('creates, attaches and speaks MCP across the boundary', async () => {
    const client = new Client({ name: 'vitest', version: '1.0.0' }, { capabilities: {} });
    const docker = new DockerClient({ socketPath: proxySocket });
    const transport = new DockerTransport('everything', config.get('everything') as DockerServerConfig, docker, () => {});

    await client.connect(transport);
    const tools = await client.listTools();

    expect(tools.tools.length).toBeGreaterThan(0);

    const create = requests.find(entry => entry.url.includes('/containers/create'));
    expect(create?.url).toContain('name=mcp-sandbox-everything');
    // The daemon sees the proxy's serialization: the hub's env key, plus the
    // secret only the proxy can read.
    expect(create?.body?.Env).toEqual(['EXAMPLE=from-hub', 'INJECTED_SECRET=hunter2']);
    expect((create!.body!.HostConfig as Record<string, unknown>).CapDrop).toEqual(['ALL']);
    expect(requests.some(entry => entry.method === 'UPGRADE' && entry.url.includes('stdin=1'))).toBe(true);
    expect(requests.some(entry => entry.url.includes('/start'))).toBe(true);

    await client.close();
  });

  it('refuses what the policy does not allow, before the daemon sees it', async () => {
    const before = requests.length;

    const build = await rawRequest('POST', '/v1.44/build');
    const escalate = await rawRequest('POST', '/v1.44/containers/create?name=mcp-sandbox-everything', {
      Image: 'everything:test',
      HostConfig: { Privileged: true }
    });

    expect(build.status).toBe(403);
    expect(escalate.status).toBe(403);
    expect(escalate.body).toContain('Privileged');
    expect(requests.length).toBe(before); // nothing reached the daemon
  });

  it('refuses an attach to a container it does not manage', async () => {
    const response = await new Promise<string>(resolve => {
      const request = http.request({
        socketPath: proxySocket,
        method: 'POST',
        path: '/v1.44/containers/mcp-hub/attach?stream=1',
        headers: { Connection: 'Upgrade', Upgrade: 'tcp' }
      });
      request.on('upgrade', () => resolve('upgraded'));
      request.on('response', res => {
        res.resume();
        resolve(`status ${res.statusCode}`);
      });
      // A refused upgrade is answered on the raw socket, so Node reports it as
      // a socket error rather than a response.
      request.on('error', () => resolve('refused'));
      request.end();
    });

    expect(response).not.toBe('upgraded');
  });

  it('refuses an action when daemon-side ownership labels do not match', async () => {
    labelsOwned = false;
    const response = await rawRequest('POST', '/v1.44/containers/mcp-sandbox-everything/start');
    labelsOwned = true;
    expect(response.status).toBe(403);
    expect(response.body).toContain('exact mcp-hub owner and server labels');
  });

  it('rejects an oversized body instead of buffering it', async () => {
    const huge = `{"Image":"${'x'.repeat(2 * 1024 * 1024)}"}`;
    const response = await rawRequest('POST', '/v1.44/containers/create?name=mcp-sandbox-everything', huge);
    expect(response.status).toBe(413);
  });

  it('rejects a body that is not JSON', async () => {
    const response = await rawRequest('POST', '/v1.44/containers/create?name=mcp-sandbox-everything', 'not json');
    expect(response.status).toBe(400);
  });
});
