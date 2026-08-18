import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DockerClient, DockerError, parseDockerHost, parseSandboxDockerHost, splitImageRef } from '../src/sandbox/docker-client.js';
import { DOCKER_POLICY_NAME, DOCKER_POLICY_PATH, DOCKER_POLICY_VERSION } from '../src/sandbox/policy-protocol.js';
import { DockerTransport } from '../src/transports/docker.js';
import type { DockerServerConfig } from '../src/config.js';

const config: DockerServerConfig = {
  kind: 'docker',
  image: 'absent:1.0',
  pull: 'never',
  env: {},
  volumes: [],
  ports: [],
  network: 'none',
  memory: 512 * 1024 * 1024,
  pidsLimit: 256,
  cpus: 1,
  readOnly: true,
  tmpfs: ['/tmp'],
  hub: true
};

describe('parseDockerHost', () => {
  it('accepts the forms an operator writes', () => {
    expect(parseDockerHost(undefined)).toEqual({ socketPath: '/var/run/docker.sock' });
    expect(parseDockerHost('')).toEqual({ socketPath: '/var/run/docker.sock' });
    expect(parseDockerHost('/run/proxy/docker.sock')).toEqual({ socketPath: '/run/proxy/docker.sock' });
    expect(parseDockerHost('unix:///run/proxy/docker.sock')).toEqual({ socketPath: '/run/proxy/docker.sock' });
    expect(parseDockerHost('tcp://dockerd:2375')).toEqual({ host: 'dockerd', port: 2375 });
  });

  it('refuses what it cannot honour instead of guessing', () => {
    expect(() => parseDockerHost('ssh://host')).toThrow(/unix:\/\/ path or a tcp:\/\//);
  });

  it('requires the policy proxy for sandbox use', () => {
    expect(() => parseSandboxDockerHost(undefined)).toThrow(/DOCKER_HOST is required/);
    expect(() => parseSandboxDockerHost('unix:///var/run/docker.sock')).toThrow(/directly/);
    expect(parseSandboxDockerHost('unix:///run/proxy/docker.sock')).toEqual({ socketPath: '/run/proxy/docker.sock' });
  });
});

describe('splitImageRef', () => {
  it('splits the way the API wants it', () => {
    expect(splitImageRef('alpine')).toEqual({ fromImage: 'alpine', tag: 'latest' });
    expect(splitImageRef('alpine:3.20')).toEqual({ fromImage: 'alpine', tag: '3.20' });
    expect(splitImageRef('ghcr.io/ni-c/x:1.2.3')).toEqual({ fromImage: 'ghcr.io/ni-c/x', tag: '1.2.3' });
    // A registry port is not a tag; the last colon before a slash is a port.
    expect(splitImageRef('registry.test:5000/x')).toEqual({ fromImage: 'registry.test:5000/x', tag: 'latest' });
    expect(splitImageRef('x@sha256:abc')).toEqual({ fromImage: 'x', tag: 'sha256:abc' });
  });
});

describe('DockerClient against a scripted daemon', () => {
  let dir: string;
  let socketPath: string;
  let daemon: http.Server;
  let client: DockerClient;
  const seen: string[] = [];
  let apiVersion = '1.55';
  let policyVersion = DOCKER_POLICY_VERSION;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-client-'));
    socketPath = path.join(dir, 'docker.sock');
    daemon = http.createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        const url = request.url ?? '';
        seen.push(`${request.method} ${url}`);
        const send = (status: number, body: string, contentType = 'application/json') => {
          response.writeHead(status, { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(body) });
          response.end(body);
        };
        if (url === DOCKER_POLICY_PATH) {
          return send(200, JSON.stringify({ name: DOCKER_POLICY_NAME, policyVersion, daemon: 'ok' }));
        }
        if (url === '/version') return send(200, JSON.stringify({ ApiVersion: apiVersion }));
        if (url.includes('/images/absent%3A1.0/json')) return send(404, JSON.stringify({ message: 'no such image' }));
        if (url.includes('/images/present/json')) return send(200, '{}');
        if (url.includes('/images/create')) {
          // A pull reports its failures inside a 200 response body.
          return send(200, '{"status":"Pulling"}\n{"errorDetail":{"message":"nope"},"error":"manifest unknown"}\n');
        }
        if (request.method === 'DELETE' && url.includes('conflict')) return send(409, JSON.stringify({ message: 'removal in progress' }));
        if (request.method === 'DELETE') return send(404, JSON.stringify({ message: 'no such container' }));
        if (url.includes('/containers/json')) return send(200, JSON.stringify([{ Id: 'abc', Names: ['/mcp-sandbox-scraper'] }, { Id: 'def', Names: ['/stray'] }]));
        if (url.includes('/containers/create')) return send(400, JSON.stringify({ message: 'invalid reference format' }));
        return send(500, 'not json at all', 'text/plain');
      });
    });
    await new Promise<void>(resolve => daemon.listen(socketPath, resolve));
    client = new DockerClient({ socketPath });
  });

  afterAll(async () => {
    daemon.closeAllConnections();
    await new Promise<void>(resolve => daemon.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('pins the API version to the highest one it was written against', async () => {
    await client.ping();
    expect(await client.imageExists('present')).toBe(true);
    // The daemon offers 1.55; hard-coded field names are only known good up to
    // the version this client was written against.
    expect(seen.some(entry => entry.includes('/v1.44/images/present/json'))).toBe(true);
  });

  it('follows an older daemon down instead of demanding a version it lacks', async () => {
    apiVersion = '1.41';
    const older = new DockerClient({ socketPath });
    await older.imageExists('present');
    expect(seen.some(entry => entry.includes('/v1.41/images/present/json'))).toBe(true);
    apiVersion = '1.55';
  });

  it('fails closed when the proxy policy version differs', async () => {
    policyVersion = DOCKER_POLICY_VERSION + 1;
    await expect(new DockerClient({ socketPath }).ping()).rejects.toThrow(/policy version mismatch/i);
    policyVersion = DOCKER_POLICY_VERSION;
  });

  it('reports a missing image as absent, not as an error', async () => {
    expect(await client.imageExists('absent:1.0')).toBe(false);
  });

  it('treats "already gone" and "already being removed" as success', async () => {
    await expect(client.removeContainer('mcp-sandbox-gone')).resolves.toBeUndefined();
    await expect(client.removeContainer('mcp-sandbox-conflict')).resolves.toBeUndefined();
  });

  it('surfaces an error hidden inside a 200 pull stream', async () => {
    await expect(client.pullImage('absent:1.0')).rejects.toThrow(/manifest unknown/);
  });

  it('surfaces the daemon message on a failed create', async () => {
    await expect(client.createContainer('mcp-sandbox-x', {})).rejects.toThrow(/invalid reference format/);
  });

  it('maps only its own containers back to server names', async () => {
    const owned = await client.listOwnedContainers();
    expect(owned).toEqual([
      { id: 'abc', name: 'mcp-sandbox-scraper', server: 'scraper' },
      { id: 'def', name: 'stray', server: undefined }
    ]);
  });

  it('says so when a response is not JSON', async () => {
    await expect(client.startContainer('whatever')).rejects.toThrow(DockerError);
  });

  it('refuses to start a sandbox whose image is missing under pull: never', async () => {
    const transport = new DockerTransport('scraper', config, client, () => {});

    // The alternative — pulling silently — would run whatever the registry
    // serves at that moment, which is the thing sandboxing is supposed to stop.
    await expect(transport.start()).rejects.toThrow(/is not present and "pull" is "never"/);
  });

  it('pulls when the config allows it, and reports why it failed', async () => {
    const transport = new DockerTransport('scraper', { ...config, pull: 'missing' }, client, () => {});
    await expect(transport.start()).rejects.toThrow(/manifest unknown/);
  });
});
