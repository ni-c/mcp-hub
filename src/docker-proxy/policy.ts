import type { DockerServerConfig, HubConfig } from '../config.js';
import { buildCreateRequest, containerName, serverNameFromContainer, OWNER_LABEL, OWNER_VALUE } from '../sandbox/container-spec.js';
import { splitImageRef } from '../sandbox/docker-client.js';
import { SecretError, SecretStore } from './secrets.js';

/**
 * What the hub is allowed to ask the Docker daemon for.
 *
 * The daemon's API is root: a single `POST /containers/create` with
 * `Privileged: true` or a `/:/host` bind mount owns the machine. A proxy that
 * filters by path and method — the usual docker-socket-proxy — cannot see any
 * of that, so this one validates the *body*, and validates it against the
 * hub's own configuration file.
 *
 * The trick that makes this trustworthy rather than a second source of truth:
 * the expected request is rebuilt with `buildCreateRequest`, the very function
 * the hub used to build the one being checked. The policy cannot drift from
 * the code that sends the request, because it is the same code.
 *
 * What survives a fully compromised hub: it can start exactly the containers
 * `mcp.json` describes, with exactly those mounts, ports, limits and images —
 * and mcp.json belongs to the host and is mounted read-only.
 */

export type Decision =
  | {
      allow: true;
      method: string;
      path: string;
      body?: Record<string, unknown>;
      upgrade?: boolean;
      /** Container identity the proxy must verify directly with the daemon. */
      container?: { id: string; server: string };
    }
  | { allow: false; status: number; reason: string };

export interface PolicyContext {
  config: HubConfig;
  secrets: SecretStore;
}

const API_PREFIX = /^\/v\d+\.\d+(?=\/)/;
/** Control characters would let a caller forge lines in a log fail2ban reads. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;
const SANDBOX_ID = /^mcp-sandbox-[a-zA-Z0-9_-]+$/;
const MAX_ENV_ENTRIES = 200;

function deny(reason: string, status = 403): Decision {
  return { allow: false, status, reason: reason.replace(CONTROL_CHARACTERS, '?') };
}

function dockerServers(config: HubConfig): Map<string, DockerServerConfig> {
  const result = new Map<string, DockerServerConfig>();
  for (const [name, entry] of config) if (entry.kind === 'docker') result.set(name, entry);
  return result;
}

/**
 * Structural equality with one exception: `Env` values.
 *
 * The proxy parses mcp.json without expanding `${VAR}` — it holds none of the
 * hub's secrets and must not need them. Every other field is required to be
 * literal in the config (parseConfig enforces that), so everything else is
 * compared byte for byte.
 */
export function diffCreateBody(expected: unknown, actual: unknown, path = ''): string | undefined {
  if (expected === null || typeof expected !== 'object') {
    return Object.is(expected, actual) ? undefined : `${path || 'body'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return `${path}: expected an array`;
    if (expected.length !== actual.length) return `${path}: expected ${expected.length} entries, got ${actual.length}`;
    for (const [index, value] of expected.entries()) {
      const mismatch = diffCreateBody(value, actual[index], `${path}[${index}]`);
      if (mismatch) return mismatch;
    }
    return undefined;
  }
  if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) return `${path || 'body'}: expected an object`;
  const expectedRecord = expected as Record<string, unknown>;
  const actualRecord = actual as Record<string, unknown>;
  // hasOwn, not `in`: `in` walks the prototype chain, so a body carrying
  // "toString" or "constructor" would not register as an extra field. It would
  // still be caught when its value is compared, but "not allowed" is the right
  // answer and default-deny should not depend on a second line of defence.
  const extra = Object.keys(actualRecord).find(key => !Object.hasOwn(expectedRecord, key));
  if (extra !== undefined) return `${path}.${extra}: not allowed`;
  for (const [key, value] of Object.entries(expectedRecord)) {
    const mismatch = diffCreateBody(value, actualRecord[key], `${path}.${key}`);
    if (mismatch) return mismatch;
  }
  return undefined;
}

function envKeys(entries: unknown, label: string): { keys: string[] } | { error: string } {
  if (!Array.isArray(entries) || !entries.every(entry => typeof entry === 'string')) return { error: `${label} must be an array of strings` };
  if (entries.length > MAX_ENV_ENTRIES) return { error: `${label} has more than ${MAX_ENV_ENTRIES} entries` };
  const keys: string[] = [];
  for (const entry of entries as string[]) {
    const separator = entry.indexOf('=');
    if (separator <= 0) return { error: `${label} entry is not KEY=VALUE` };
    keys.push(entry.slice(0, separator));
  }
  if (new Set(keys).size !== keys.length) return { error: `${label} contains duplicate keys` };
  return { keys };
}

/**
 * Denials that hold no matter what the configuration says.
 *
 * The structural comparison above already rejects all of these — every one of
 * them is either an extra field or a changed value. They are checked again
 * anyway, and first: a bug in the derivation must not silently turn into a
 * host takeover, and a proxy that says "Privileged is never allowed" is a
 * clearer promise than one that says "your body did not match".
 */
export function hardDenials(body: Record<string, unknown>): string | undefined {
  const host = (body.HostConfig ?? {}) as Record<string, unknown>;
  if (host.Privileged === true) return 'Privileged containers are never allowed';
  if (Array.isArray(host.CapAdd) && host.CapAdd.length > 0) return 'CapAdd is never allowed';
  if (Array.isArray(host.Devices) && host.Devices.length > 0) return 'Devices are never allowed';
  if (host.Mounts !== undefined) return 'Mounts are never allowed (use "volumes" in the config, which becomes Binds)';
  if (host.UsernsMode === 'host') return 'UsernsMode=host is never allowed';
  for (const field of ['PidMode', 'IpcMode', 'UTSMode', 'CgroupnsMode', 'NetworkMode']) {
    if (host[field] === 'host') return `${field}=host is never allowed`;
  }
  if (typeof host.NetworkMode === 'string' && host.NetworkMode.startsWith('container:')) {
    return 'joining another container\'s network namespace is never allowed';
  }
  const binds = Array.isArray(host.Binds) ? (host.Binds as unknown[]) : [];
  for (const bind of binds) {
    if (typeof bind !== 'string') return 'Binds must be strings';
    const source = bind.split(':')[0];
    if (source.includes('..')) return `bind source "${source}" contains ".."`;
    if (!source.startsWith('/')) continue; // named volume
    const normalized = source.replace(/\/+$/, '') || '/';
    for (const forbidden of ['/', '/proc', '/sys', '/dev', '/etc', '/boot', '/root', '/var/run', '/run', '/var/lib/docker']) {
      if (normalized === forbidden || normalized.startsWith(`${forbidden}/`)) return `bind source "${source}" is inside ${forbidden}`;
    }
  }
  if (host.Privileged !== false) return 'HostConfig.Privileged must be present and false';
  return undefined;
}

function authorizeCreate(url: URL, body: unknown, context: PolicyContext, version: string): Decision {
  const requested = url.searchParams.get('name');
  if (requested === null) return deny('containers must be created with an explicit ?name=');
  if ([...url.searchParams.keys()].some(key => key !== 'name')) return deny('only ?name= is allowed on create');
  const server = serverNameFromContainer(requested);
  if (server === undefined) return deny(`container name "${requested}" is outside the mcp-sandbox- namespace`);
  const config = dockerServers(context.config).get(server);
  if (!config) return deny(`"${server}" is not a docker server in the configuration`);
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return deny('create needs a JSON object body', 400);

  const actual = body as Record<string, unknown>;
  const forbidden = hardDenials(actual);
  if (forbidden) return deny(forbidden);

  const expected = buildCreateRequest(server, config).body;
  const actualEnv = envKeys(actual.Env, 'Env');
  if ('error' in actualEnv) return deny(actualEnv.error, 400);
  const expectedKeys = Object.keys(config.env);
  if (actualEnv.keys.length !== expectedKeys.length || actualEnv.keys.some(key => !expectedKeys.includes(key))) {
    return deny(`Env keys do not match the configuration (allowed: ${expectedKeys.join(', ') || 'none'})`);
  }
  const mismatch = diffCreateBody({ ...expected, Env: null }, { ...actual, Env: null });
  if (mismatch) return deny(`create request does not match the configuration — ${mismatch}`);

  // Only now, on a request that is already known-good, are the secrets added.
  const injected: string[] = [];
  if (config.secretsFrom !== undefined) {
    let secrets: Record<string, string>;
    try {
      secrets = context.secrets.load(config.secretsFrom);
    } catch (error) {
      return deny(`cannot inject secrets for "${server}": ${(error as SecretError).message}`, 500);
    }
    for (const [key, value] of Object.entries(secrets)) {
      if (expectedKeys.includes(key)) return deny(`secret "${key}" collides with an env key of server "${server}"`, 500);
      injected.push(`${key}=${value}`);
    }
  }
  return {
    allow: true,
    method: 'POST',
    path: `${version}/containers/create?name=${encodeURIComponent(containerName(server))}`,
    // Env values come from the hub — it holds the ${VAR} expansions and this
    // proxy deliberately does not — but only under keys the config names, and
    // followed by the secrets only this proxy can read. Every other field is
    // taken from `expected`, so what reaches the daemon is this proxy's own
    // serialization of the configuration, not the bytes the hub sent.
    body: { ...expected, Env: [...(actual.Env as string[]), ...injected] }
  };
}

/**
 * Decide one request.
 *
 * The returned path is rebuilt from scratch, never forwarded verbatim: a
 * canonical request is immune to anything hidden in duplicate query
 * parameters, odd encodings or extra JSON keys.
 */
export function authorize(method: string, rawUrl: string, body: unknown, context: PolicyContext): Decision {
  let url: URL;
  try {
    url = new URL(rawUrl, 'http://docker');
  } catch {
    return deny('unparseable request URL', 400);
  }
  // The caller pins an API version it was written against; keep it on the way
  // out so the daemon does not silently answer a newer dialect than the client
  // expects. The pattern itself is the only thing trusted from it.
  const version = API_PREFIX.exec(url.pathname)?.[0] ?? '';
  const path = url.pathname.slice(version.length);
  const servers = dockerServers(context.config);

  if (method === 'GET' && (path === '/_ping' || path === '/version')) {
    return { allow: true, method, path: `${version}${path}` };
  }
  if (method === 'HEAD' && path === '/_ping') {
    return { allow: true, method, path: `${version}${path}` };
  }

  if (method === 'POST' && path === '/containers/create') {
    return authorizeCreate(url, body, context, version);
  }

  const containerAction = /^\/containers\/([^/]+)\/(start|stop|wait|attach)$/.exec(path);
  if (containerAction) {
    const id = decodeURIComponent(containerAction[1]);
    const action = containerAction[2];
    if (method !== 'POST') return deny(`${method} is not allowed on ${path}`);
    if (!SANDBOX_ID.test(id)) return deny(`container "${id}" is outside the mcp-sandbox- namespace`);
    const server = serverNameFromContainer(id)!;
    // Stopping and waiting must keep working for a server that was just
    // removed from the config — that is how the hub cleans up after itself.
    if ((action === 'start' || action === 'attach') && !servers.has(server)) {
      return deny(`"${server}" is not a docker server in the configuration`);
    }
    if (action === 'attach') {
      return {
        allow: true,
        method,
        path: `${version}/containers/${encodeURIComponent(id)}/attach?stream=1&stdin=1&stdout=1&stderr=1`,
        upgrade: true,
        container: { id, server }
      };
    }
    return { allow: true, method, path: `${version}/containers/${encodeURIComponent(id)}/${action}`, container: { id, server } };
  }

  const containerDelete = /^\/containers\/([^/]+)$/.exec(path);
  if (containerDelete && method === 'DELETE') {
    const id = decodeURIComponent(containerDelete[1]);
    if (!SANDBOX_ID.test(id)) return deny(`container "${id}" is outside the mcp-sandbox- namespace`);
    return {
      allow: true,
      method,
      path: `${version}/containers/${encodeURIComponent(id)}?force=1&v=0`,
      container: { id, server: serverNameFromContainer(id)! }
    };
  }

  if (method === 'GET' && path === '/containers/json') {
    // Rebuilt with our own filter: listing every container on the host would
    // be an information leak, and the hub only ever wants its own.
    const filters = JSON.stringify({ label: [`${OWNER_LABEL}=${OWNER_VALUE}`] });
    return { allow: true, method, path: `${version}/containers/json?all=1&filters=${encodeURIComponent(filters)}` };
  }

  const imageInspect = /^\/images\/(.+)\/json$/.exec(path);
  if (imageInspect && method === 'GET') {
    const ref = decodeURIComponent(imageInspect[1]);
    if (![...servers.values()].some(server => server.image === ref)) return deny(`image "${ref}" is not used by any configured server`);
    return { allow: true, method, path: `${version}/images/${encodeURIComponent(ref)}/json` };
  }

  if (method === 'POST' && path === '/images/create') {
    const fromImage = url.searchParams.get('fromImage') ?? '';
    const tag = url.searchParams.get('tag') ?? '';
    const pullable = [...servers.values()].filter(server => server.pull === 'missing');
    const match = pullable.find(server => {
      const split = splitImageRef(server.image);
      return split.fromImage === fromImage && split.tag === tag;
    });
    if (!match) return deny(`pulling "${fromImage}:${tag}" is not allowed (no configured server has it with "pull": "missing")`);
    return {
      allow: true,
      method,
      path: `${version}/images/create?fromImage=${encodeURIComponent(fromImage)}&tag=${encodeURIComponent(tag)}`
    };
  }

  return deny(`${method} ${path} is not allowed`);
}
