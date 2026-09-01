import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

import type { ToolFilterConfig } from './tool-filter.js';
import type { PassthroughConfig } from './elicitation.js';
import type { SubscriptionsConfig } from './subscriptions.js';
import { CONFIG_POLL_INTERVAL_MS } from './timings.js';

/**
 * One entry of the Claude-Code-style `mcpServers` map.
 *
 * Stdio servers (`command`/`args`/`env`) are spawned verbatim (after ${VAR}
 * expansion), so arbitrary `sh -c` bootstrap scripts work. Remote servers
 * (`type: "http"` or `"sse"` with `url`/`headers`) are connected via the SDK's
 * client transports. The mcp-hub extensions are `hub` (`false` removes the
 * server from the /hub aggregate endpoint), `keepAlive` (`true` exempts a
 * local server from on-demand lifecycling) and `idleMinutes` (per-server
 * override of the global idle timeout).
 */
export interface StdioServerConfig extends ToolFilterConfig, PassthroughConfig, SubscriptionsConfig {
  kind: 'stdio';
  command: string;
  args: string[];
  env: Record<string, string>;
  hub: boolean;
  /** Optional in the type so hand-built configs stay terse; the parser always sets it. */
  keepAlive?: boolean;
  idleMinutes?: number;
}

/**
 * How the hub proves itself to an upstream that speaks OAuth.
 *
 * `mode` says where the client identity comes from, `grant` says how the token
 * is obtained. They are independent: a statically issued client_id can drive
 * either grant, and a dynamically registered one usually drives
 * authorization_code.
 */
export interface UpstreamOAuthConfig {
  /** static = pre-registered credentials; dcr = RFC 7591; cimd = the hub's own metadata document URL. */
  mode: 'static' | 'dcr' | 'cimd';
  grant: 'authorization_code' | 'client_credentials';
  /** Required for `static`, assigned by the upstream for the other two. */
  clientId?: string;
  /** Optional even for `static`: a public client has none. */
  clientSecret?: string;
  /**
   * How the hub proves itself at the upstream's token endpoint.
   *
   * Absent means "let the authorization server's metadata decide", which is
   * what nearly every upstream wants. Naming `private_key_jwt` explicitly is
   * the exception: the hub then signs an assertion with its own key instead of
   * presenting a shared secret, and publishes the public half in the client
   * document it registers with.
   */
  clientAuth?: 'client_secret_basic' | 'client_secret_post' | 'private_key_jwt';
  scopes: string[];
}

export const OAUTH_MODES = new Set(['static', 'dcr', 'cimd']);
export const OAUTH_GRANTS = new Set(['authorization_code', 'client_credentials']);
export const OAUTH_CLIENT_AUTH = new Set(['client_secret_basic', 'client_secret_post', 'private_key_jwt']);

export interface RemoteServerConfig extends ToolFilterConfig, PassthroughConfig, SubscriptionsConfig {
  kind: 'remote';
  transport: 'http' | 'sse';
  url: string;
  headers: Record<string, string>;
  hub: boolean;
  /** Absent means the upstream is reached with `headers` alone, as before. */
  oauth?: UpstreamOAuthConfig;
}

/**
 * A server that runs in its own container, spoken to over the Docker API.
 *
 * The hub creates the container, attaches to its stdin/stdout and talks plain
 * MCP stdio across the container boundary — no HTTP listener, no bridge
 * process, no shared secret. Everything the container may do is spelled out
 * here, because this entry is also the policy the docker proxy enforces.
 *
 * Deliberately NOT configurable: capabilities (always dropped), privileged
 * mode, security options (always no-new-privileges) and the restart policy
 * (the hub supervises). A knob that can only weaken the sandbox is a knob the
 * policy would have to defend.
 */
export interface DockerServerConfig extends ToolFilterConfig, PassthroughConfig, SubscriptionsConfig {
  kind: 'docker';
  image: string;
  /** `never` (default) fails when the image is absent; `missing` lets the hub pull it. */
  pull: 'never' | 'missing';
  command?: string[];
  entrypoint?: string[];
  env: Record<string, string>;
  /** Name of an env file the *proxy* holds; its keys never reach the hub process. */
  secretsFrom?: string;
  /** `source:/target[:ro]`, source is an absolute host path or a named volume. */
  volumes: string[];
  /** `[ip:]hostPort:containerPort[/proto]` */
  ports: string[];
  /** Docker network name; `none` (default) means no network interface at all. */
  network: string;
  /** Bytes. Defaults to 512 MiB. */
  memory: number;
  /** Defaults to 256 processes. */
  pidsLimit: number;
  /** Fractional CPU count accepted; defaults to one CPU. */
  cpus: number;
  readOnly: boolean;
  /** `/path` or `/path:options` */
  tmpfs: string[];
  user?: string;
  hub: boolean;
  /** Optional in the type so hand-built configs stay terse; the parser always sets it. */
  keepAlive?: boolean;
  idleMinutes?: number;
}

/**
 * A server reached over a plain byte stream: a Unix socket or a TCP port
 * carrying newline-delimited JSON-RPC — the same framing stdio uses, which is
 * what the specification asks custom transports to reuse.
 *
 * This is the privilege-free half of the sandboxing story: the container is
 * started by whoever owns the Compose file, and the hub needs no Docker access
 * at all. A Unix socket in a shared volume even works with `network_mode: none`.
 */
export interface SocketServerConfig extends ToolFilterConfig, PassthroughConfig, SubscriptionsConfig {
  kind: 'socket';
  transport: 'unix' | 'tcp';
  socketPath?: string;
  host?: string;
  port?: number;
  hub: boolean;
}

export type ServerConfig = StdioServerConfig | RemoteServerConfig | DockerServerConfig | SocketServerConfig;

export type HubConfig = Map<string, ServerConfig>;

const NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
const RESERVED_NAMES = new Set([
  'mcp',
  'hub',
  'authorize',
  'token',
  'register',
  'login',
  'consent',
  'health',
  'livez',
  'revoke',
  '.well-known',
  // Served by the authorization server. `interaction` is where an
  // unauthenticated authorization request is sent to log in, and `jwks` and
  // `session` are endpoints oidc-provider registers whether or not the hub
  // advertises them. A server of one of these names would shadow the auth flow
  // rather than merely be unreachable.
  'jwks',
  'interaction',
  'session',
  'userinfo',
  // The upstream OAuth callback lives under /upstream/…; a server of that name
  // would be reachable at /upstream and is too close for comfort.
  'upstream'
]);
const REMOTE_TYPES = new Set(['http', 'sse', 'streamable-http', 'streamable_http']);
const SECRETS_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
const VOLUME_SOURCE_PATTERN = /^(?:\/[^:]*|[a-zA-Z0-9][a-zA-Z0-9_.-]*)$/;
const PORT_PATTERN = /^(?:(\d{1,3}(?:\.\d{1,3}){3}):)?(\d{1,5}):(\d{1,5})(?:\/(tcp|udp))?$/;
const MEMORY_PATTERN = /^(\d+)([bkmg])?$/i;
export const DEFAULT_DOCKER_MEMORY = 512 * 1024 * 1024;
export const DEFAULT_DOCKER_PIDS_LIMIT = 256;
export const DEFAULT_DOCKER_CPUS = 1;

export class ConfigError extends Error {}

/** Expand ${VAR} references from the process environment, like Claude Code does. */
export function expandEnvVars(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name: string) => {
    const replacement = env[name];
    if (replacement === undefined) {
      throw new ConfigError(`Undefined environment variable in config: \${${name}}`);
    }
    return replacement;
  });
}

/**
 * How ${VAR} references are resolved while parsing.
 *
 * The docker proxy parses the very same file to derive its policy, but it
 * deliberately does not hold the hub's secrets — with `expand: false` it keeps
 * the references verbatim instead of failing on every variable it lacks. It
 * never compares expanded values, only structure and env *keys*.
 */
export interface ParseOptions {
  expand?: boolean;
}

type ExpandFn = (value: string) => string;

function expanderFor(env: NodeJS.ProcessEnv, options: ParseOptions | undefined): ExpandFn {
  if (options?.expand === false) return value => value;
  return value => expandEnvVars(value, env);
}

function expandRecord(record: Record<string, string>, expand: ExpandFn): Record<string, string> {
  return Object.fromEntries(Object.entries(record).map(([k, v]) => [k, expand(v)]));
}

function requireStringArray(name: string, field: string, value: unknown): string[] {
  if (!Array.isArray(value) || !value.every(v => typeof v === 'string')) {
    throw new ConfigError(`Server "${name}": "${field}" must be an array of strings`);
  }
  return value as string[];
}

function requireStringRecord(name: string, field: string, value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || !Object.values(value).every(v => typeof v === 'string')) {
    throw new ConfigError(`Server "${name}": "${field}" must be an object of string values`);
  }
  return value as Record<string, string>;
}

/**
 * The `oauth` block on a remote server.
 *
 * Unknown keys are rejected here even though the rest of the parser ignores
 * them: a typo in an authentication block would otherwise read as "no
 * authentication at all" and only show up as an upstream that will not
 * connect. `${VAR}` stays allowed — putting the client secret in the
 * environment rather than the config file is the intended use, exactly as for
 * `headers`.
 */
function parseUpstreamOAuth(name: string, value: unknown, expand: ExpandFn): UpstreamOAuthConfig | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConfigError(`Server "${name}": "oauth" must be an object`);
  }
  const entry = value as Record<string, unknown>;
  const known = new Set(['mode', 'grant', 'clientId', 'clientSecret', 'clientAuth', 'scopes']);
  const unknown = Object.keys(entry).filter(key => !known.has(key));
  if (unknown.length > 0) {
    throw new ConfigError(`Server "${name}": unknown "oauth" field(s) ${unknown.join(', ')} (supported: ${[...known].join(', ')})`);
  }
  if (typeof entry.mode !== 'string' || !OAUTH_MODES.has(entry.mode)) {
    throw new ConfigError(`Server "${name}": "oauth.mode" must be one of ${[...OAUTH_MODES].join(', ')}`);
  }
  if (typeof entry.grant !== 'string' || !OAUTH_GRANTS.has(entry.grant)) {
    throw new ConfigError(`Server "${name}": "oauth.grant" must be one of ${[...OAUTH_GRANTS].join(', ')}`);
  }
  const mode = entry.mode as UpstreamOAuthConfig['mode'];
  const grant = entry.grant as UpstreamOAuthConfig['grant'];
  for (const field of ['clientId', 'clientSecret'] as const) {
    if (entry[field] !== undefined && (typeof entry[field] !== 'string' || (entry[field] as string).length === 0)) {
      throw new ConfigError(`Server "${name}": "oauth.${field}" must be a non-empty string`);
    }
  }
  if (mode === 'static' && entry.clientId === undefined) {
    throw new ConfigError(`Server "${name}": "oauth.clientId" is required when mode is "static"`);
  }
  if (mode !== 'static' && entry.clientId !== undefined) {
    // The identifier is assigned by the upstream (dcr) or is the hub's own
    // document URL (cimd); a configured one would silently be ignored.
    throw new ConfigError(`Server "${name}": "oauth.clientId" only applies to mode "static"`);
  }
  if (mode !== 'static' && entry.clientSecret !== undefined) {
    throw new ConfigError(`Server "${name}": "oauth.clientSecret" only applies to mode "static"`);
  }
  if (entry.clientAuth !== undefined && (typeof entry.clientAuth !== 'string' || !OAUTH_CLIENT_AUTH.has(entry.clientAuth))) {
    throw new ConfigError(`Server "${name}": "oauth.clientAuth" must be one of ${[...OAUTH_CLIENT_AUTH].join(', ')}`);
  }
  const clientAuth = entry.clientAuth as UpstreamOAuthConfig['clientAuth'] | undefined;
  if (clientAuth === 'private_key_jwt' && entry.clientSecret !== undefined) {
    // One or the other. A key and a shared secret are two different identities
    // as far as the upstream is concerned, and only one of them is presented.
    throw new ConfigError(`Server "${name}": "oauth.clientAuth" of "private_key_jwt" cannot be combined with a clientSecret`);
  }
  if (clientAuth !== undefined && clientAuth !== 'private_key_jwt' && entry.clientSecret === undefined) {
    throw new ConfigError(`Server "${name}": "oauth.clientAuth" of "${clientAuth}" needs a clientSecret`);
  }
  return {
    mode,
    grant,
    ...(clientAuth ? { clientAuth } : {}),
    ...(entry.clientId !== undefined ? { clientId: expand(entry.clientId as string) } : {}),
    ...(entry.clientSecret !== undefined ? { clientSecret: expand(entry.clientSecret as string) } : {}),
    scopes: requireStringArray(name, 'oauth.scopes', entry.scopes ?? [])
  };
}

/** "512m" / "1g" / "1048576" -> bytes. */
export function parseMemory(name: string, value: unknown): number {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value <= 0) throw new ConfigError(`Server "${name}": "memory" must be a positive integer`);
    return value;
  }
  if (typeof value !== 'string') throw new ConfigError(`Server "${name}": "memory" must be a string like "512m" or a byte count`);
  const match = MEMORY_PATTERN.exec(value.trim());
  if (!match) throw new ConfigError(`Server "${name}": "memory" must look like "512m", "1g" or a byte count`);
  const factor = { b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[(match[2] ?? 'b').toLowerCase()]!;
  const bytes = Number(match[1]) * factor;
  if (bytes <= 0 || !Number.isSafeInteger(bytes)) throw new ConfigError(`Server "${name}": "memory" is out of range`);
  return bytes;
}

/**
 * Everything the docker proxy validates has to be spelled out literally.
 *
 * The proxy derives the container it will allow from this very config, but it
 * deliberately does not hold the hub's environment — a `${VAR}` in the image
 * name or a bind mount would be a field it could not check, which is exactly
 * the field an attacker would choose. Only `env` values, which the proxy
 * compares by key and never by value, may be substituted.
 */
function requireLiteral(name: string, field: string, value: string): string {
  if (value.includes('${')) {
    throw new ConfigError(`Server "${name}": "${field}" must not use \${VAR} — only "env" values are substituted for docker servers`);
  }
  return value;
}

/** The on-demand lifecycle fields shared by stdio and docker servers. */
interface LifecycleConfig {
  keepAlive: boolean;
  idleMinutes?: number;
}

function parseLifecycle(name: string, entry: Record<string, unknown>): LifecycleConfig {
  if (entry.keepAlive !== undefined && typeof entry.keepAlive !== 'boolean') {
    throw new ConfigError(`Server "${name}": "keepAlive" must be a boolean`);
  }
  const idleMinutes = entry.idleMinutes;
  if (idleMinutes !== undefined && (!Number.isSafeInteger(idleMinutes) || (idleMinutes as number) < 1)) {
    throw new ConfigError(`Server "${name}": "idleMinutes" must be a positive integer`);
  }
  if (entry.keepAlive === true && idleMinutes !== undefined) {
    throw new ConfigError(`Server "${name}": "keepAlive" and "idleMinutes" are mutually exclusive`);
  }
  return { keepAlive: entry.keepAlive === true, ...(idleMinutes !== undefined ? { idleMinutes: idleMinutes as number } : {}) };
}

/**
 * Parses `allowTools` / `denyTools`.
 *
 * Returns a *partial* rather than always emitting the keys, unlike
 * `parseLifecycle`: an entry without a filter must produce exactly the object it
 * produced before, or every whole-object assertion in test/config.test.ts breaks.
 *
 * What can be checked here is checked here — the shape, an empty string, and a
 * `*` anywhere but last. Whether a name matches a real tool cannot be: the
 * upstream has not started yet. That half is reported at runtime, in supervisor.ts.
 */
function parseToolFilter(name: string, entry: Record<string, unknown>): ToolFilterConfig {
  const result: ToolFilterConfig = {};
  for (const field of ['allowTools', 'denyTools'] as const) {
    if (entry[field] === undefined) continue;
    const patterns = requireStringArray(name, field, entry[field]);
    for (const pattern of patterns) {
      if (pattern.length === 0) {
        throw new ConfigError(`Server "${name}": "${field}" must not contain an empty string`);
      }
      const star = pattern.indexOf('*');
      if (star !== -1 && star !== pattern.length - 1) {
        throw new ConfigError(
          `Server "${name}": "${field}" entry "${pattern}" — only a trailing "*" is supported (e.g. "list_*"); other entries are exact tool names`
        );
      }
    }
    result[field] = patterns;
  }
  return result;
}

/**
 * Parses `passthrough`, which today governs one thing: whether this server may
 * ask the person at the far end a question.
 *
 * A *partial* for the same reason `parseToolFilter` is one — an entry without
 * the field has to produce exactly the object it produced before.
 *
 * `"off"` exists separately from the global `MCP_ELICITATION` switch because
 * the two answer different questions. The global one is "is this hub doing
 * elicitation at all"; this one is "do I trust *this* upstream to put words in
 * front of my user". A server can be perfectly reliable and still be one whose
 * prompts an operator does not want shown — that is a phishing judgement, not
 * an availability one, and it should not require turning the server off.
 */
function parsePassthrough(name: string, entry: Record<string, unknown>): PassthroughConfig {
  if (entry.passthrough === undefined) return {};
  if (entry.passthrough !== 'auto' && entry.passthrough !== 'off') {
    throw new ConfigError(`Server "${name}": "passthrough" must be "auto" or "off"`);
  }
  return { passthrough: entry.passthrough };
}

/**
 * Parses `subscriptions`, the sibling of `passthrough`: whether this server may
 * push change notifications to the clients that ask for them.
 *
 * A *partial* for the same reason the two above are — an entry without the
 * field has to produce exactly the object it produced before.
 *
 * Separate from `passthrough` because the two are different judgements about
 * different traffic. `passthrough` is about words shown to a person, and the
 * risk is phishing. This one is about volume and timing on a stream nobody is
 * reading synchronously, and the risk is noise. A server can easily warrant one
 * answer and not the other.
 */
function parseSubscriptions(name: string, entry: Record<string, unknown>): SubscriptionsConfig {
  if (entry.subscriptions === undefined) return {};
  if (entry.subscriptions !== 'auto' && entry.subscriptions !== 'off') {
    throw new ConfigError(`Server "${name}": "subscriptions" must be "auto" or "off"`);
  }
  return { subscriptions: entry.subscriptions };
}

function rejectLifecycle(name: string, entry: Record<string, unknown>, kind: string): void {
  for (const field of ['keepAlive', 'idleMinutes']) {
    if (entry[field] !== undefined) {
      throw new ConfigError(`Server "${name}": "${field}" is only supported on stdio and docker servers — the hub does not manage the lifetime of ${kind} servers`);
    }
  }
}

function parseDockerServer(name: string, entry: Record<string, unknown>, expand: ExpandFn, hub: boolean): DockerServerConfig {
  if (entry.command !== undefined && !Array.isArray(entry.command)) {
    throw new ConfigError(`Server "${name}": for docker servers "command" is an array of strings (the container's Cmd)`);
  }
  if (typeof entry.image !== 'string' || entry.image.length === 0) {
    throw new ConfigError(`Server "${name}": docker servers need an "image" string`);
  }
  const pull = entry.pull ?? 'never';
  if (pull !== 'never' && pull !== 'missing') {
    throw new ConfigError(`Server "${name}": "pull" must be "never" or "missing"`);
  }
  const secretsFrom = entry.secretsFrom;
  if (secretsFrom !== undefined && (typeof secretsFrom !== 'string' || !SECRETS_NAME_PATTERN.test(secretsFrom))) {
    throw new ConfigError(`Server "${name}": "secretsFrom" must be a name matching ${SECRETS_NAME_PATTERN}`);
  }
  const volumes = requireStringArray(name, 'volumes', entry.volumes ?? []).map(v => requireLiteral(name, 'volumes', v));
  for (const volume of volumes) {
    const parts = volume.split(':');
    if (parts.length < 2 || parts.length > 3) {
      throw new ConfigError(`Server "${name}": volume "${volume}" must look like "source:/target" or "source:/target:ro"`);
    }
    if (!VOLUME_SOURCE_PATTERN.test(parts[0]) || parts[0].includes('..')) {
      throw new ConfigError(`Server "${name}": volume source "${parts[0]}" must be an absolute path without ".." or a named volume`);
    }
    if (!parts[1].startsWith('/')) throw new ConfigError(`Server "${name}": volume target "${parts[1]}" must be an absolute path`);
    if (parts[2] !== undefined && parts[2] !== 'ro' && parts[2] !== 'rw') {
      throw new ConfigError(`Server "${name}": volume mode "${parts[2]}" must be "ro" or "rw"`);
    }
  }
  const ports = requireStringArray(name, 'ports', entry.ports ?? []).map(v => requireLiteral(name, 'ports', v));
  for (const port of ports) {
    const match = PORT_PATTERN.exec(port);
    if (!match) throw new ConfigError(`Server "${name}": port "${port}" must look like "127.0.0.1:8686:8000" or "8686:8000"`);
    for (const value of [match[2], match[3]]) {
      const number = Number(value);
      if (number < 1 || number > 65535) throw new ConfigError(`Server "${name}": port "${port}" is out of range`);
    }
  }
  const network = entry.network === undefined ? 'none' : entry.network;
  if (typeof network !== 'string' || network.length === 0) throw new ConfigError(`Server "${name}": "network" must be a string`);
  if (ports.length > 0 && network === 'none') {
    // Published ports on a container without a network silently do nothing;
    // saying so here beats a sandbox that looks reachable and is not.
    throw new ConfigError(`Server "${name}": "ports" need a network, but "network" is "none"`);
  }
  const tmpfs = requireStringArray(name, 'tmpfs', entry.tmpfs ?? ['/tmp']).map(v => requireLiteral(name, 'tmpfs', v));
  for (const mount of tmpfs) {
    if (!mount.startsWith('/')) throw new ConfigError(`Server "${name}": tmpfs "${mount}" must be an absolute path`);
  }
  if (entry.readOnly !== undefined && typeof entry.readOnly !== 'boolean') {
    throw new ConfigError(`Server "${name}": "readOnly" must be a boolean`);
  }
  if (entry.user !== undefined && typeof entry.user !== 'string') {
    throw new ConfigError(`Server "${name}": "user" must be a string`);
  }
  if (entry.pidsLimit !== undefined && (!Number.isSafeInteger(entry.pidsLimit) || (entry.pidsLimit as number) < 1)) {
    throw new ConfigError(`Server "${name}": "pidsLimit" must be a positive integer`);
  }
  if (
    entry.cpus !== undefined &&
    (typeof entry.cpus !== 'number' ||
      !Number.isFinite(entry.cpus) ||
      entry.cpus <= 0 ||
      !Number.isSafeInteger(Math.round(entry.cpus * 1_000_000_000)))
  ) {
    throw new ConfigError(`Server "${name}": "cpus" must be a positive number`);
  }
  for (const forbidden of ['privileged', 'capAdd', 'securityOpt', 'devices', 'restart']) {
    if (entry[forbidden] !== undefined) {
      throw new ConfigError(
        `Server "${name}": "${forbidden}" is not supported — sandboxes always run with all capabilities dropped, no-new-privileges and no restart policy`
      );
    }
  }
  return {
    kind: 'docker',
    image: requireLiteral(name, 'image', entry.image),
    pull,
    ...(entry.command !== undefined ? { command: requireStringArray(name, 'command', entry.command).map(v => requireLiteral(name, 'command', v)) } : {}),
    ...(entry.entrypoint !== undefined
      ? { entrypoint: requireStringArray(name, 'entrypoint', entry.entrypoint).map(v => requireLiteral(name, 'entrypoint', v)) }
      : {}),
    env: expandRecord(requireStringRecord(name, 'env', entry.env ?? {}), expand),
    ...(secretsFrom !== undefined ? { secretsFrom } : {}),
    volumes,
    ports,
    network: requireLiteral(name, 'network', network),
    memory: entry.memory !== undefined ? parseMemory(name, entry.memory) : DEFAULT_DOCKER_MEMORY,
    pidsLimit: entry.pidsLimit !== undefined ? (entry.pidsLimit as number) : DEFAULT_DOCKER_PIDS_LIMIT,
    cpus: entry.cpus !== undefined ? entry.cpus : DEFAULT_DOCKER_CPUS,
    readOnly: entry.readOnly !== false,
    tmpfs,
    ...(entry.user !== undefined ? { user: requireLiteral(name, 'user', entry.user) } : {}),
    hub,
    ...parseLifecycle(name, entry)
  };
}

function parseSocketServer(name: string, entry: Record<string, unknown>, type: 'unix' | 'tcp', expand: ExpandFn, hub: boolean): SocketServerConfig {
  if (entry.command !== undefined || entry.url !== undefined) {
    throw new ConfigError(`Server "${name}": "${type}" servers take a socket address, not "command" or "url"`);
  }
  if (type === 'unix') {
    if (typeof entry.socket !== 'string' || !entry.socket.startsWith('/')) {
      throw new ConfigError(`Server "${name}": unix servers need a "socket" path starting with "/"`);
    }
    return { kind: 'socket', transport: 'unix', socketPath: expand(entry.socket), hub };
  }
  if (typeof entry.host !== 'string' || entry.host.length === 0) {
    throw new ConfigError(`Server "${name}": tcp servers need a "host" string`);
  }
  const port = entry.port;
  if (!Number.isSafeInteger(port) || (port as number) < 1 || (port as number) > 65535) {
    throw new ConfigError(`Server "${name}": tcp servers need a "port" between 1 and 65535`);
  }
  return { kind: 'socket', transport: 'tcp', host: expand(entry.host), port: port as number, hub };
}

function parseServer(name: string, entry: Record<string, unknown>, env: NodeJS.ProcessEnv, options?: ParseOptions): ServerConfig {
  const expand = expanderFor(env, options);
  const hub = entry.hub !== false;
  const toolFilter = { ...parseToolFilter(name, entry), ...parsePassthrough(name, entry), ...parseSubscriptions(name, entry) };
  if (entry.hub !== undefined && typeof entry.hub !== 'boolean') {
    throw new ConfigError(`Server "${name}": "hub" must be a boolean`);
  }

  const type = entry.type;
  if (type !== undefined && typeof type !== 'string') {
    throw new ConfigError(`Server "${name}": "type" must be a string`);
  }
  if (type === 'docker') return { ...parseDockerServer(name, entry, expand, hub), ...toolFilter };
  if (type === 'unix' || type === 'tcp') {
    rejectLifecycle(name, entry, type);
    return { ...parseSocketServer(name, entry, type, expand, hub), ...toolFilter };
  }

  const isRemote = (typeof type === 'string' && type !== 'stdio') || entry.url !== undefined;

  if (isRemote) {
    rejectLifecycle(name, entry, 'remote');
    if (typeof type === 'string' && type !== 'stdio' && !REMOTE_TYPES.has(type)) {
      throw new ConfigError(`Server "${name}": unknown type "${type}" (supported: stdio, http, sse, docker, unix, tcp)`);
    }
    if (typeof entry.url !== 'string' || entry.url.length === 0) {
      throw new ConfigError(`Server "${name}": remote servers need a "url" string`);
    }
    if (entry.command !== undefined) {
      throw new ConfigError(`Server "${name}": "command" and "url" are mutually exclusive`);
    }
    const headers = requireStringRecord(name, 'headers', entry.headers ?? {});
    const url = expand(entry.url);
    try {
      new URL(url);
    } catch {
      throw new ConfigError(`Server "${name}": "url" is not a valid URL`);
    }
    const oauth = parseUpstreamOAuth(name, entry.oauth, expand);
    if (oauth && Object.keys(headers).some(key => key.toLowerCase() === 'authorization')) {
      // The transport merges requestInit headers last, so the static one would
      // win and OAuth would silently do nothing — and the header would also be
      // carried to the authorization server, leaking whatever it holds.
      throw new ConfigError(`Server "${name}": "oauth" and an "Authorization" header cannot both be set`);
    }
    return {
      kind: 'remote',
      transport: type === 'sse' ? 'sse' : 'http',
      url,
      headers: expandRecord(headers, expand),
      hub,
      ...toolFilter,
      ...(oauth ? { oauth } : {})
    };
  }

  if (typeof entry.command !== 'string' || entry.command.length === 0) {
    throw new ConfigError(`Server "${name}" is missing a "command" string`);
  }
  const args = requireStringArray(name, 'args', entry.args ?? []);
  const envEntry = requireStringRecord(name, 'env', entry.env ?? {});
  return {
    kind: 'stdio',
    command: expand(entry.command),
    args: args.map(expand),
    env: expandRecord(envEntry, expand),
    hub,
    ...toolFilter,
    ...parseLifecycle(name, entry)
  };
}

export function parseConfig(json: string, env: NodeJS.ProcessEnv = process.env, options?: ParseOptions): HubConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (error) {
    throw new ConfigError(`Config is not valid JSON: ${(error as Error).message}`);
  }
  if (typeof raw !== 'object' || raw === null || typeof (raw as Record<string, unknown>).mcpServers !== 'object') {
    throw new ConfigError('Config must be an object with a top-level "mcpServers" object');
  }
  const servers = (raw as { mcpServers: Record<string, Record<string, unknown>> }).mcpServers;
  const result: HubConfig = new Map();
  for (const [name, entry] of Object.entries(servers)) {
    if (!NAME_PATTERN.test(name)) {
      throw new ConfigError(`Server name "${name}" is invalid (allowed: ${NAME_PATTERN})`);
    }
    if (RESERVED_NAMES.has(name.toLowerCase())) {
      throw new ConfigError(`Server name "${name}" is reserved`);
    }
    if (typeof entry !== 'object' || entry === null) {
      throw new ConfigError(`Server "${name}" must be an object`);
    }
    result.set(name, parseServer(name, entry, env, options));
  }
  return result;
}

export function loadConfig(filePath: string, env: NodeJS.ProcessEnv = process.env, options?: ParseOptions): HubConfig {
  return parseConfig(fs.readFileSync(filePath, 'utf8'), env, options);
}

export function warnMutableDockerImages(config: HubConfig, component = 'mcp-hub'): void {
  for (const [name, entry] of config) {
    if (entry.kind !== 'docker' || entry.image.includes('@sha256:')) continue;
    console.warn(
      `${component}: docker server "${name}" uses mutable image reference "${entry.image}"; ` +
        'this is supported for compatibility, but a sha256 digest is strongly recommended'
    );
  }
}

export interface ConfigDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

export function diffConfigs(before: HubConfig, after: HubConfig): ConfigDiff {
  const added = [...after.keys()].filter(name => !before.has(name));
  const removed = [...before.keys()].filter(name => !after.has(name));
  const changed = [...after.keys()].filter(name => {
    const a = before.get(name);
    return a !== undefined && JSON.stringify(a) !== JSON.stringify(after.get(name));
  });
  return { added, removed, changed };
}

/**
 * Watches the config file and emits a `change` event with (config, diff)
 * whenever its parsed content differs. Watches the parent directory so
 * editors/bind-mounts that replace the file (rename+create) keep working.
 */
export class ConfigWatcher extends EventEmitter {
  private watcher?: fs.FSWatcher;
  private debounce?: NodeJS.Timeout;

  constructor(
    private readonly filePath: string,
    public current: HubConfig,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly pollIntervalMs = CONFIG_POLL_INTERVAL_MS,
    private readonly parseOptions?: ParseOptions,
    private readonly validate?: (config: HubConfig) => void
  ) {
    super();
  }

  start(): void {
    const dir = path.dirname(this.filePath);
    const base = path.basename(this.filePath);
    this.watcher = fs.watch(dir, (_event, filename) => {
      if (filename !== null && filename !== base) return;
      clearTimeout(this.debounce);
      this.debounce = setTimeout(() => this.reload(), 300);
    });
    // Fallback for single-file bind mounts (Docker): inotify events from
    // host-side edits do not cross the mount boundary, so directory watching
    // never fires there. Stat polling catches in-place content changes.
    // (Host edits must rewrite the file in place — a rename/replace creates a
    // new inode the mount cannot follow. warnSingleFileMount() flags that
    // setup at startup; the recommended directory mount has neither problem.)
    fs.watchFile(this.filePath, { interval: this.pollIntervalMs }, (curr, prev) => {
      if (curr.mtimeMs === prev.mtimeMs && curr.size === prev.size) return;
      clearTimeout(this.debounce);
      this.debounce = setTimeout(() => this.reload(), 300);
    });
  }

  private reload(): void {
    let next: HubConfig;
    try {
      next = loadConfig(this.filePath, this.env, this.parseOptions);
      this.validate?.(next);
    } catch (error) {
      // Keep running with the previous config; a broken edit must not take the hub down.
      this.emit('error', error);
      return;
    }
    const diff = diffConfigs(this.current, next);
    if (diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0) return;
    this.current = next;
    this.emit('change', next, diff);
  }

  stop(): void {
    clearTimeout(this.debounce);
    this.watcher?.close();
    fs.unwatchFile(this.filePath);
  }
}
