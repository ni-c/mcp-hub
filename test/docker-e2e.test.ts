import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { JSONRPCMessage } from '@modelcontextprotocol/server';
import { parseConfig, type DockerServerConfig, type HubConfig } from '../src/config.js';
import { DockerClient } from '../src/sandbox/docker-client.js';
import { DockerTransport } from '../src/transports/docker.js';
import { createDockerProxy } from '../src/docker-proxy/server.js';
import { buildCreateRequest } from '../src/sandbox/container-spec.js';

/**
 * Against a real Docker daemon, skipped where there is none.
 *
 * The container is `alpine cat`: it echoes every line it is given, which is
 * enough to prove the part that cannot be faked — that a container created
 * through this code really hands back a bidirectional stdio stream, correctly
 * framed, and that the policy proxy is transparent to it while still refusing
 * a privileged create against the actual daemon.
 */

const DOCKER_SOCKET = '/var/run/docker.sock';
const hasDocker = (() => {
  try {
    return fs.statSync(DOCKER_SOCKET).isSocket() && fs.accessSync(DOCKER_SOCKET, fs.constants.R_OK | fs.constants.W_OK) === undefined;
  } catch {
    return false;
  }
})();

const CONFIG_JSON = JSON.stringify({
  mcpServers: {
    dockertest: {
      type: 'docker',
      image: 'alpine:latest',
      pull: 'missing',
      command: ['cat'],
      env: { EXAMPLE: 'from-hub' },
      memory: '64m',
      pidsLimit: 32
    }
  }
});

const ping: JSONRPCMessage = { jsonrpc: '2.0', id: 1, method: 'ping' };

let config: HubConfig;
let dir: string;
let proxySocket: string;
let proxy: http.Server;

describe.skipIf(!hasDocker)('a real container over the Docker API', () => {
  beforeAll(async () => {
    config = parseConfig(CONFIG_JSON, {} as NodeJS.ProcessEnv, { expand: false });
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-docker-e2e-'));
    proxySocket = path.join(dir, 'proxy.sock');
    proxy = createDockerProxy({ dockerSocket: DOCKER_SOCKET, config: () => config, secretsDir: dir });
    await new Promise<void>(resolve => proxy.listen(proxySocket, resolve));
  });

  afterAll(async () => {
    await new DockerClient({ socketPath: proxySocket }).removeContainer('mcp-sandbox-dockertest').catch(() => {});
    proxy.closeAllConnections();
    await new Promise<void>(resolve => proxy.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const echoOnce = async (client: DockerClient) => {
    const transport = new DockerTransport('dockertest', config.get('dockertest') as DockerServerConfig, client, () => {});
    const messages: JSONRPCMessage[] = [];
    transport.onmessage = message => messages.push(message);
    await transport.start();
    await transport.send(ping);
    for (let i = 0; i < 100 && messages.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 50));
    return { transport, messages };
  };

  it(
    'refuses a direct Docker daemon that has no policy handshake',
    async () => {
      const client = new DockerClient({ socketPath: DOCKER_SOCKET });
      await expect(client.ping()).rejects.toThrow(/not a reachable mcp-hub policy proxy/);
    },
    120_000
  );

  it(
    'works exactly the same through the policy proxy',
    async () => {
      const client = new DockerClient({ socketPath: proxySocket });
      const { transport, messages } = await echoOnce(client);

      expect(messages).toEqual([ping]);

      await transport.close();
    },
    120_000
  );

  it(
    'refuses a privileged create against the real daemon',
    async () => {
      const { name, body } = buildCreateRequest('dockertest', config.get('dockertest') as DockerServerConfig);
      (body.HostConfig as Record<string, unknown>).Privileged = true;
      (body.HostConfig as Record<string, unknown>).Binds = ['/:/host'];

      const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const payload = Buffer.from(JSON.stringify(body));
        const request = http.request(
          {
            socketPath: proxySocket,
            method: 'POST',
            path: `/v1.44/containers/create?name=${name}`,
            headers: { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) }
          },
          result => {
            const chunks: Buffer[] = [];
            result.on('data', (chunk: Buffer) => chunks.push(chunk));
            result.on('end', () => resolve({ status: result.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
          }
        );
        request.on('error', reject);
        request.end(payload);
      });

      expect(response.status).toBe(403);
      expect(response.body).toMatch(/Privileged/);
      // And the daemon never saw it: no such container exists.
      const containers = await new DockerClient({ socketPath: proxySocket }).listOwnedContainers();
      expect(containers.map(entry => entry.server)).not.toContain('dockertest');
    },
    60_000
  );
});
