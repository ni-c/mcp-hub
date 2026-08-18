import type { DockerServerConfig } from '../config.js';

/**
 * The container a `type: "docker"` entry describes — derived from the config
 * and from nothing else.
 *
 * This module is the reason the docker proxy can enforce a policy without a
 * second policy file: the hub builds its create request here, and the proxy
 * rebuilds the expected request from the same config with the same function
 * and compares. Any field the hub adds, drops or changes on the way is a
 * mismatch by construction, so the policy cannot drift from the code that
 * sends the request.
 *
 * Everything that could only ever weaken the sandbox is fixed here rather than
 * taken from the config: capabilities are always dropped, no-new-privileges is
 * always set, privileged is always false, and there is never a restart policy
 * (the hub supervises, and a Docker-level restart would resurrect a container
 * whose stdio stream nobody is holding).
 */

export const CONTAINER_PREFIX = 'mcp-sandbox-';
export const OWNER_LABEL = 'io.mcp-hub.owner';
export const SERVER_LABEL = 'io.mcp-hub.server';
export const OWNER_VALUE = 'mcp-hub';
/** Watchtower would otherwise try to update images the hub pins deliberately. */
export const WATCHTOWER_LABEL = 'com.centurylinklabs.watchtower.enable';
/**
 * Blanked, not set: an image built with `docker compose build` carries its
 * project label, and a container inherits every label of its image. A sandbox
 * would therefore look like part of that Compose project, and a `docker compose
 * down` in the directory the image was built in would collect a container the
 * hub owns and is holding the stdio of. An empty value matches no project.
 */
export const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project';

const PORT_PATTERN = /^(?:(\d{1,3}(?:\.\d{1,3}){3}):)?(\d{1,5}):(\d{1,5})(?:\/(tcp|udp))?$/;

export interface CreateRequest {
  /** Value for the ?name= query parameter. */
  name: string;
  /** Body of POST /containers/create. */
  body: Record<string, unknown>;
}

export function containerName(server: string): string {
  return `${CONTAINER_PREFIX}${server}`;
}

/** `mcp-sandbox-scraper` -> `scraper`; undefined for anything outside our namespace. */
export function serverNameFromContainer(container: string): string | undefined {
  const name = container.startsWith('/') ? container.slice(1) : container;
  if (!name.startsWith(CONTAINER_PREFIX)) return undefined;
  const server = name.slice(CONTAINER_PREFIX.length);
  return /^[a-zA-Z0-9_-]+$/.test(server) ? server : undefined;
}

function portBindings(ports: string[]): { exposed: Record<string, unknown>; bindings: Record<string, unknown> } {
  const exposed: Record<string, unknown> = {};
  const bindings: Record<string, unknown> = {};
  for (const port of ports) {
    const match = PORT_PATTERN.exec(port);
    if (!match) throw new Error(`invalid port mapping "${port}"`); // parseConfig rejects these first
    const [, hostIp, hostPort, containerPort, proto] = match;
    const key = `${containerPort}/${proto ?? 'tcp'}`;
    exposed[key] = {};
    (bindings[key] ??= [] as unknown[]);
    (bindings[key] as unknown[]).push({ HostIp: hostIp ?? '127.0.0.1', HostPort: hostPort });
  }
  return { exposed, bindings };
}

function tmpfsMounts(tmpfs: string[]): Record<string, string> {
  return Object.fromEntries(
    tmpfs.map(entry => {
      const separator = entry.indexOf(':');
      if (separator === -1) return [entry, 'rw,nosuid,nodev,size=64m'];
      return [entry.slice(0, separator), entry.slice(separator + 1)];
    })
  );
}

export function buildCreateRequest(server: string, config: DockerServerConfig): CreateRequest {
  const { exposed, bindings } = portBindings(config.ports);
  const body: Record<string, unknown> = {
    Image: config.image,
    // stdio is the whole point: keep stdin open for the life of the container
    // and never allocate a TTY, because a TTY merges stdout and stderr into one
    // unframed stream and the protocol would drown in the server's log lines.
    OpenStdin: true,
    StdinOnce: false,
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    Env: Object.entries(config.env).map(([key, value]) => `${key}=${value}`),
    Labels: {
      [OWNER_LABEL]: OWNER_VALUE,
      [SERVER_LABEL]: server,
      [WATCHTOWER_LABEL]: 'false',
      [COMPOSE_PROJECT_LABEL]: ''
    },
    HostConfig: {
      // The hub removes the container itself on close; AutoRemove covers the
      // case where the server exits on its own.
      AutoRemove: true,
      Binds: [...config.volumes],
      PortBindings: bindings,
      NetworkMode: config.network,
      ReadonlyRootfs: config.readOnly,
      Tmpfs: tmpfsMounts(config.tmpfs),
      CapDrop: ['ALL'],
      CapAdd: [],
      Privileged: false,
      SecurityOpt: ['no-new-privileges:true'],
      RestartPolicy: { Name: '' },
      // stdout carries the protocol, so a log driver that keeps every byte of
      // it would fill the disk with a transcript of the session.
      LogConfig: { Type: 'json-file', Config: { 'max-size': '1m', 'max-file': '1' } },
      Memory: config.memory,
      PidsLimit: config.pidsLimit,
      NanoCpus: Math.round(config.cpus * 1_000_000_000)
    },
    ...(Object.keys(exposed).length > 0 ? { ExposedPorts: exposed } : {}),
    ...(config.command !== undefined ? { Cmd: config.command } : {}),
    ...(config.entrypoint !== undefined ? { Entrypoint: config.entrypoint } : {}),
    ...(config.user !== undefined ? { User: config.user } : {})
  };
  return { name: containerName(server), body };
}
