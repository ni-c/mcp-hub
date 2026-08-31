import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import type { JSONRPCMessage } from '@modelcontextprotocol/client';
import { StreamTransport } from '../src/transports/stream.js';
import { SocketTransport } from '../src/transports/socket.js';
import { DockerFrameDecoder, DockerTransport } from '../src/transports/docker.js';
import type { DockerClient } from '../src/sandbox/docker-client.js';
import { ManagedServer } from '../src/supervisor.js';
import type { DockerServerConfig, SocketServerConfig } from '../src/config.js';

const EVERYTHING = path.resolve('node_modules/@modelcontextprotocol/server-everything/dist/index.js');

const ping: JSONRPCMessage = { jsonrpc: '2.0', id: 1, method: 'ping' };

describe('StreamTransport', () => {
  it('round-trips messages using the stdio framing', async () => {
    // A PassThrough is its own loopback, so whatever send() writes comes back
    // through the read path — exactly the bytes a peer would see.
    const stream = new PassThrough();
    const transport = new StreamTransport(stream);
    const received: JSONRPCMessage[] = [];
    transport.onmessage = message => received.push(message);
    await transport.start();

    await transport.send(ping);
    await new Promise(resolve => setImmediate(resolve));

    expect(received).toEqual([ping]);
  });

  it('reassembles a message split across chunks and reads two from one chunk', () => {
    const transport = new StreamTransport(new PassThrough(), false);
    const received: JSONRPCMessage[] = [];
    transport.onmessage = message => received.push(message);

    const line = `${JSON.stringify(ping)}\n`;
    transport.receive(Buffer.from(line.slice(0, 7)));
    expect(received).toHaveLength(0);
    transport.receive(Buffer.from(line.slice(7)));
    expect(received).toHaveLength(1);

    transport.receive(Buffer.from(line + line));
    expect(received).toHaveLength(3);
  });

  it('reports a malformed line without dropping the connection', () => {
    const transport = new StreamTransport(new PassThrough(), false);
    const errors: Error[] = [];
    const received: JSONRPCMessage[] = [];
    transport.onerror = error => errors.push(error);
    transport.onmessage = message => received.push(message);

    // A server that prints a stray line to stdout must cost one message, not
    // the whole session.
    transport.receive(Buffer.from(`not json\n${JSON.stringify(ping)}\n`));

    expect(errors).toHaveLength(1);
    expect(received).toEqual([ping]);
  });

  it('survives a peer that never sends a newline', async () => {
    const transport = new StreamTransport(new PassThrough(), false);
    const errors: Error[] = [];
    let closed = false;
    transport.onerror = error => errors.push(error);
    transport.onclose = () => (closed = true);
    await transport.start();

    // The SDK's ReadBuffer throws past 10 MB. That throw happens inside a
    // 'data' handler, so if it escaped it would reach uncaughtException and
    // take the whole hub down — one sandboxed server killing every other one.
    expect(() => {
      for (let i = 0; i < 11; i++) transport.receive(Buffer.alloc(1024 * 1024, 0x61));
    }).not.toThrow();

    expect(errors[0]?.message).toMatch(/exceeded maximum size/);
    expect(closed).toBe(true);
  });

  it('reports closure exactly once', async () => {
    const stream = new PassThrough();
    const transport = new StreamTransport(stream);
    let closes = 0;
    transport.onclose = () => closes++;
    await transport.start();

    await transport.close();
    stream.emit('close');

    expect(closes).toBe(1);
  });
});

describe('DockerFrameDecoder', () => {
  const frame = (stream: number, payload: string) => {
    const body = Buffer.from(payload, 'utf8');
    const header = Buffer.alloc(8);
    header[0] = stream;
    header.writeUInt32BE(body.length, 4);
    return Buffer.concat([header, body]);
  };

  it('splits stdout from stderr', () => {
    const frames: [number, string][] = [];
    const decoder = new DockerFrameDecoder((stream, payload) => frames.push([stream, payload.toString()]), () => {});

    decoder.push(Buffer.concat([frame(1, '{"jsonrpc":"2.0"}\n'), frame(2, 'INFO starting\n')]));

    expect(frames).toEqual([
      [1, '{"jsonrpc":"2.0"}\n'],
      [2, 'INFO starting\n']
    ]);
  });

  it('waits for the rest of a frame that arrived cut in half', () => {
    const frames: string[] = [];
    const decoder = new DockerFrameDecoder((_stream, payload) => frames.push(payload.toString()), () => {});
    const complete = frame(1, 'hello world');

    // Cut inside the header, then inside the payload: both are what a real
    // socket does under load.
    decoder.push(complete.subarray(0, 3));
    expect(frames).toHaveLength(0);
    decoder.push(complete.subarray(3, 12));
    expect(frames).toHaveLength(0);
    decoder.push(complete.subarray(12));
    expect(frames).toEqual(['hello world']);
  });

  it('refuses an implausible frame length instead of allocating it', () => {
    const errors: Error[] = [];
    const decoder = new DockerFrameDecoder(() => {}, error => errors.push(error));
    const header = Buffer.alloc(8);
    header[0] = 1;
    header.writeUInt32BE(0xffffffff, 4);

    decoder.push(header);

    expect(errors[0]?.message).toMatch(/exceeds/);
  });

  it('closes a corrupted attach stream so cleanup and restart can run', async () => {
    const stream = new PassThrough();
    let removals = 0;
    const client = {
      imageExists: async () => true,
      removeContainer: async () => { removals++; },
      createContainer: async () => 'id',
      attach: async () => stream,
      startContainer: async () => undefined
    } as unknown as DockerClient;
    const config: DockerServerConfig = {
      kind: 'docker', image: 'x@sha256:abc', pull: 'never', env: {}, volumes: [], ports: [], network: 'none',
      memory: 512 * 1024 * 1024, pidsLimit: 256, cpus: 1, readOnly: true, tmpfs: ['/tmp'], hub: true
    };
    const transport = new DockerTransport('broken', config, client, () => {});
    let closes = 0;
    transport.onclose = () => closes++;
    await transport.start();
    const header = Buffer.alloc(8);
    header[0] = 1;
    header.writeUInt32BE(0xffffffff, 4);

    stream.write(header);
    await new Promise(resolve => setImmediate(resolve));

    expect(stream.destroyed).toBe(true);
    expect(closes).toBe(1);
    expect(removals).toBeGreaterThanOrEqual(2); // stale cleanup plus corrupt-stream cleanup
  });
});

/**
 * The socket transport against a real MCP server.
 *
 * The listener here is the whole "shim" a sandbox image needs: accept a
 * connection, spawn the stdio server, pipe both ways. It is what
 * `socat UNIX-LISTEN:/run/mcp/x.sock,fork EXEC:"server"` does, in ten lines,
 * so the test exercises the documented deployment rather than a mock.
 */
describe('SocketTransport against a real MCP server', () => {
  let dir: string;
  let socketPath: string;
  let listener: net.Server;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-socket-'));
    socketPath = path.join(dir, 'everything.sock');
    listener = net.createServer(connection => {
      const child = spawn(process.execPath, [EVERYTHING], { stdio: ['pipe', 'pipe', 'ignore'] });
      connection.pipe(child.stdin);
      child.stdout.pipe(connection);
      // A client that hangs up mid-write leaves the pipe writing into a dead
      // socket; a real shim has to swallow that too.
      connection.on('error', () => child.kill());
      child.stdin.on('error', () => {});
      connection.on('close', () => child.kill());
    });
    await new Promise<void>(resolve => listener.listen(socketPath, resolve));
  });

  afterAll(async () => {
    await new Promise<void>(resolve => listener.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('completes a handshake and lists tools over a unix socket', async () => {
    const config: SocketServerConfig = { kind: 'socket', transport: 'unix', socketPath, hub: true };
    const client = new Client({ name: 'vitest', version: '1.0.0' }, { capabilities: {} });

    await client.connect(new SocketTransport(config));
    const tools = await client.listTools();

    expect(tools.tools.length).toBeGreaterThan(0);
    expect(client.getServerVersion()?.name).toBeTruthy();
    await client.close();
  });

  it('fails to start with a useful message when nothing listens', async () => {
    const config: SocketServerConfig = { kind: 'socket', transport: 'unix', socketPath: path.join(dir, 'nobody.sock'), hub: true };

    // The supervisor turns a rejected start() into a backoff retry, so the
    // message is what an operator reads in the log.
    await expect(new SocketTransport(config).start()).rejects.toThrow(/cannot connect to .*nobody\.sock/);
  });

  it('reports a tcp connection refused rather than hanging', async () => {
    const config: SocketServerConfig = { kind: 'socket', transport: 'tcp', host: '127.0.0.1', port: 1, hub: true };

    await expect(new SocketTransport(config).start()).rejects.toThrow(/cannot connect to 127\.0\.0\.1:1/);
  });

  it('is supervised like any other server', async () => {
    const server = new ManagedServer('sandboxed', { kind: 'socket', transport: 'unix', socketPath, hub: true });

    await server.start();

    // Everything downstream of the transport — tool listing, health, /hub —
    // only ever sees a ManagedServer, so this is the whole integration.
    expect(server.state).toBe('up');
    expect(server.tools.length).toBeGreaterThan(0);

    await server.stop();
    expect(server.state).toBe('stopped');
  });

  it('goes down with a reason that names the kind, and comes back', async () => {
    const server = new ManagedServer('sandboxed', { kind: 'socket', transport: 'unix', socketPath, hub: true });
    await server.start();

    // Killing the connection is what a crashing sandbox looks like from here.
    await server.client!.close();
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(server.state).toBe('down');
    expect(server.lastError).toBe('socket closed');
    await server.stop();
  });
});
