import { describe, expect, it } from 'vitest';
import { parseConfig, ConfigError, type DockerServerConfig, type SocketServerConfig } from '../src/config.js';
import { buildCreateRequest, containerName, serverNameFromContainer } from '../src/sandbox/container-spec.js';

const env = { EVE_TOKEN: 'secret-value' } as NodeJS.ProcessEnv;

function parseOne(entry: Record<string, unknown>, name = 'eve') {
  return parseConfig(JSON.stringify({ mcpServers: { [name]: entry } }), env).get(name)!;
}

function expectError(entry: Record<string, unknown>, fragment: string) {
  expect(() => parseOne(entry)).toThrowError(new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
}

describe('docker servers', () => {
  it('fills in a sandbox by default', () => {
    const config = parseOne({ type: 'docker', image: 'eve-mcp:local' }) as DockerServerConfig;

    expect(config.kind).toBe('docker');
    // The defaults are the security promise: no network, read-only root, no
    // pulling. Anything weaker has to be asked for in writing.
    expect(config.network).toBe('none');
    expect(config.readOnly).toBe(true);
    expect(config.pull).toBe('never');
    expect(config.tmpfs).toEqual(['/tmp']);
    expect(config.hub).toBe(true);
  });

  it('accepts the full sandbox description', () => {
    const config = parseOne({
      type: 'docker',
      image: 'eve-mcp:local',
      pull: 'missing',
      command: ['python3', 'esi.py'],
      env: { HOME: '/data', EVE_TOKEN: '${EVE_TOKEN}' },
      secretsFrom: 'eve',
      volumes: ['/srv/scraper/data:/data', 'cache:/cache:ro'],
      ports: ['127.0.0.1:8686:8000'],
      network: 'eve-net',
      memory: '384m',
      pidsLimit: 128,
      readOnly: false,
      user: '1000:1000',
      hub: false
    }) as DockerServerConfig;

    expect(config.memory).toBe(384 * 1024 * 1024);
    expect(config.env.EVE_TOKEN).toBe('secret-value'); // env values do expand
    expect(config.secretsFrom).toBe('eve');
    expect(config.hub).toBe(false);
  });

  it('keeps ${VAR} unexpanded when the proxy parses the same file', () => {
    const json = JSON.stringify({ mcpServers: { eve: { type: 'docker', image: 'eve:1', env: { T: '${EVE_TOKEN}' } } } });

    // The proxy holds none of the hub's secrets, so it must be able to read
    // the config without them — and it compares env keys, never values.
    const asProxy = parseConfig(json, {} as NodeJS.ProcessEnv, { expand: false }).get('eve') as DockerServerConfig;

    expect(asProxy.env.T).toBe('${EVE_TOKEN}');
    expect(() => parseConfig(json, {} as NodeJS.ProcessEnv)).toThrowError(ConfigError);
  });

  it('rejects ${VAR} in every field the proxy has to verify', () => {
    for (const entry of [
      { image: '${IMAGE}' },
      { image: 'x:1', volumes: ['${DATA}:/data'] },
      { image: 'x:1', network: 'n', ports: ['${PORT}:8000'] },
      { image: 'x:1', user: '${UID}' },
      { image: 'x:1', command: ['${CMD}'] }
    ]) {
      expectError({ type: 'docker', ...entry }, 'must not use ${VAR}');
    }
  });

  it('refuses the knobs that could only weaken the sandbox', () => {
    for (const field of ['privileged', 'capAdd', 'securityOpt', 'devices', 'restart']) {
      expectError({ type: 'docker', image: 'x:1', [field]: field === 'privileged' ? true : ['x'] }, 'is not supported');
    }
  });

  it('rejects malformed mounts, ports and limits', () => {
    expectError({ type: 'docker', image: 'x:1', volumes: ['/data'] }, 'must look like');
    expectError({ type: 'docker', image: 'x:1', volumes: ['/a/../b:/data'] }, 'without ".."');
    expectError({ type: 'docker', image: 'x:1', volumes: ['/a:relative'] }, 'must be an absolute path');
    expectError({ type: 'docker', image: 'x:1', volumes: ['/a:/b:rwx'] }, 'must be "ro" or "rw"');
    expectError({ type: 'docker', image: 'x:1', network: 'n', ports: ['8000'] }, 'must look like');
    expectError({ type: 'docker', image: 'x:1', network: 'n', ports: ['99999:8000'] }, 'out of range');
    expectError({ type: 'docker', image: 'x:1', memory: 'lots' }, 'must look like');
    expectError({ type: 'docker', image: 'x:1', pidsLimit: 0 }, 'positive integer');
    expectError({ type: 'docker', image: 'x:1', secretsFrom: '../../etc/shadow' }, 'secretsFrom');
    expectError({ type: 'docker' }, 'need an "image" string');
  });

  it('refuses published ports on a container without a network', () => {
    // Docker accepts this silently and publishes nothing; a sandbox that looks
    // reachable and is not costs an hour of debugging.
    expectError({ type: 'docker', image: 'x:1', ports: ['127.0.0.1:8686:8000'] }, '"ports" need a network');
  });
});

describe('socket servers', () => {
  it('parses unix and tcp entries', () => {
    const unix = parseOne({ type: 'unix', socket: '/run/mcp/foo.sock' }) as SocketServerConfig;
    expect(unix).toMatchObject({ kind: 'socket', transport: 'unix', socketPath: '/run/mcp/foo.sock' });

    const tcp = parseOne({ type: 'tcp', host: 'sandbox', port: 9000 }) as SocketServerConfig;
    expect(tcp).toMatchObject({ kind: 'socket', transport: 'tcp', host: 'sandbox', port: 9000 });
  });

  it('rejects incomplete or mixed-up entries', () => {
    expectError({ type: 'unix', socket: 'relative.sock' }, 'starting with "/"');
    expectError({ type: 'tcp', host: 'x' }, 'need a "port"');
    expectError({ type: 'tcp', host: 'x', port: 70000 }, 'need a "port"');
    expectError({ type: 'unix', socket: '/x.sock', command: 'foo' }, 'not "command" or "url"');
  });

  it('still reports the supported types when one is misspelled', () => {
    expectError({ type: 'dokcer', url: 'http://x' }, 'unknown type');
  });
});

describe('container spec', () => {
  const config = parseOne({
    type: 'docker',
    image: 'eve-mcp:local',
    env: { HOME: '/data' },
    volumes: ['/srv/eve:/data'],
    ports: ['127.0.0.1:8686:8000'],
    network: 'eve-net',
    memory: '384m',
    pidsLimit: 128
  }) as DockerServerConfig;

  it('names containers in one namespace, both ways', () => {
    expect(containerName('eve')).toBe('mcp-sandbox-eve');
    expect(serverNameFromContainer('/mcp-sandbox-eve')).toBe('eve');
    expect(serverNameFromContainer('paperless')).toBeUndefined();
    expect(serverNameFromContainer('mcp-sandbox-')).toBeUndefined();
    expect(serverNameFromContainer('mcp-sandbox-a/b')).toBeUndefined();
  });

  it('describes a locked-down container', () => {
    const { name, body } = buildCreateRequest('eve', config);
    const host = body.HostConfig as Record<string, unknown>;

    expect(name).toBe('mcp-sandbox-eve');
    // stdio across the container boundary needs exactly this shape.
    expect(body).toMatchObject({ OpenStdin: true, AttachStdin: true, AttachStdout: true, Tty: false });
    expect(host).toMatchObject({
      CapDrop: ['ALL'],
      CapAdd: [],
      Privileged: false,
      SecurityOpt: ['no-new-privileges:true'],
      ReadonlyRootfs: true,
      AutoRemove: true,
      NetworkMode: 'eve-net',
      Memory: 384 * 1024 * 1024,
      PidsLimit: 128,
      Binds: ['/srv/eve:/data'],
      RestartPolicy: { Name: '' }
    });
    expect(host.PortBindings).toEqual({ '8000/tcp': [{ HostIp: '127.0.0.1', HostPort: '8686' }] });
    expect(body.ExposedPorts).toEqual({ '8000/tcp': {} });
    expect(body.Env).toEqual(['HOME=/data']);
  });

  it('defaults a port without an address to loopback', () => {
    const loopback = parseOne({ type: 'docker', image: 'x:1', network: 'n', ports: ['8686:8000'] }) as DockerServerConfig;
    const host = buildCreateRequest('x', loopback).body.HostConfig as Record<string, unknown>;

    // "8686:8000" on the docker CLI means every interface. Publishing a
    // sandbox to the whole LAN by omission is not a default worth having.
    expect(host.PortBindings).toEqual({ '8000/tcp': [{ HostIp: '127.0.0.1', HostPort: '8686' }] });
  });
});
