import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

/**
 * One entry of the Claude-Code-style `mcpServers` map.
 *
 * Stdio servers (`command`/`args`/`env`) are spawned verbatim (after ${VAR}
 * expansion), so arbitrary `sh -c` bootstrap scripts work. Remote servers
 * (`type: "http"` or `"sse"` with `url`/`headers`) are connected via the SDK's
 * client transports. `hub` is the only mcp-hub extension: `false` removes the
 * server from the /hub aggregate endpoint.
 */
export interface StdioServerConfig {
  kind: 'stdio';
  command: string;
  args: string[];
  env: Record<string, string>;
  hub: boolean;
}

export interface RemoteServerConfig {
  kind: 'remote';
  transport: 'http' | 'sse';
  url: string;
  headers: Record<string, string>;
  hub: boolean;
}

export type ServerConfig = StdioServerConfig | RemoteServerConfig;

export type HubConfig = Map<string, ServerConfig>;

const NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
const RESERVED_NAMES = new Set(['mcp', 'hub', 'authorize', 'token', 'register', 'login', 'health', 'revoke', '.well-known']);
const REMOTE_TYPES = new Set(['http', 'sse', 'streamable-http', 'streamable_http']);

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

function expandRecord(record: Record<string, string>, env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(record).map(([k, v]) => [k, expandEnvVars(v, env)]));
}

function parseServer(name: string, entry: Record<string, unknown>, env: NodeJS.ProcessEnv): ServerConfig {
  const hub = entry.hub !== false;
  if (entry.hub !== undefined && typeof entry.hub !== 'boolean') {
    throw new ConfigError(`Server "${name}": "hub" must be a boolean`);
  }

  const type = entry.type;
  if (type !== undefined && typeof type !== 'string') {
    throw new ConfigError(`Server "${name}": "type" must be a string`);
  }
  const isRemote = (typeof type === 'string' && type !== 'stdio') || entry.url !== undefined;

  if (isRemote) {
    if (typeof type === 'string' && type !== 'stdio' && !REMOTE_TYPES.has(type)) {
      throw new ConfigError(`Server "${name}": unknown type "${type}" (supported: stdio, http, sse)`);
    }
    if (typeof entry.url !== 'string' || entry.url.length === 0) {
      throw new ConfigError(`Server "${name}": remote servers need a "url" string`);
    }
    if (entry.command !== undefined) {
      throw new ConfigError(`Server "${name}": "command" and "url" are mutually exclusive`);
    }
    const headers = entry.headers ?? {};
    if (typeof headers !== 'object' || headers === null || Array.isArray(headers) || !Object.values(headers).every(v => typeof v === 'string')) {
      throw new ConfigError(`Server "${name}": "headers" must be an object of string values`);
    }
    const url = expandEnvVars(entry.url, env);
    try {
      new URL(url);
    } catch {
      throw new ConfigError(`Server "${name}": "url" is not a valid URL`);
    }
    return {
      kind: 'remote',
      transport: type === 'sse' ? 'sse' : 'http',
      url,
      headers: expandRecord(headers as Record<string, string>, env),
      hub
    };
  }

  if (typeof entry.command !== 'string' || entry.command.length === 0) {
    throw new ConfigError(`Server "${name}" is missing a "command" string`);
  }
  const args = entry.args ?? [];
  if (!Array.isArray(args) || !args.every(a => typeof a === 'string')) {
    throw new ConfigError(`Server "${name}": "args" must be an array of strings`);
  }
  const envEntry = entry.env ?? {};
  if (typeof envEntry !== 'object' || envEntry === null || Array.isArray(envEntry) || !Object.values(envEntry).every(v => typeof v === 'string')) {
    throw new ConfigError(`Server "${name}": "env" must be an object of string values`);
  }
  return {
    kind: 'stdio',
    command: expandEnvVars(entry.command, env),
    args: (args as string[]).map(a => expandEnvVars(a, env)),
    env: expandRecord(envEntry as Record<string, string>, env),
    hub
  };
}

export function parseConfig(json: string, env: NodeJS.ProcessEnv = process.env): HubConfig {
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
    result.set(name, parseServer(name, entry, env));
  }
  return result;
}

export function loadConfig(filePath: string, env: NodeJS.ProcessEnv = process.env): HubConfig {
  return parseConfig(fs.readFileSync(filePath, 'utf8'), env);
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
    private readonly pollIntervalMs = 3_000
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
    // new inode the mount cannot follow.)
    fs.watchFile(this.filePath, { interval: this.pollIntervalMs }, (curr, prev) => {
      if (curr.mtimeMs === prev.mtimeMs && curr.size === prev.size) return;
      clearTimeout(this.debounce);
      this.debounce = setTimeout(() => this.reload(), 300);
    });
  }

  private reload(): void {
    let next: HubConfig;
    try {
      next = loadConfig(this.filePath, this.env);
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
