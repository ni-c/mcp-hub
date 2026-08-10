import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

/**
 * One entry of the Claude-Code-style `mcpServers` map. `command`/`args`/`env`
 * are passed to the child process verbatim (after ${VAR} expansion), so
 * arbitrary `sh -c` bootstrap scripts work. `hub` is the only mcp-hub
 * extension: `false` removes the server from the /hub aggregate endpoint.
 */
export interface ServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
  hub: boolean;
}

export type HubConfig = Map<string, ServerConfig>;

const NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
const RESERVED_NAMES = new Set(['mcp', 'hub', 'authorize', 'token', 'register', 'login', 'health', 'revoke', '.well-known']);

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
    if (entry.url !== undefined || (typeof entry.type === 'string' && entry.type !== 'stdio')) {
      throw new ConfigError(`Server "${name}": only stdio servers are supported (found ${entry.url !== undefined ? '"url"' : `type "${entry.type}"`})`);
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
    if (entry.hub !== undefined && typeof entry.hub !== 'boolean') {
      throw new ConfigError(`Server "${name}": "hub" must be a boolean`);
    }
    result.set(name, {
      command: expandEnvVars(entry.command, env),
      args: (args as string[]).map(a => expandEnvVars(a, env)),
      env: Object.fromEntries(Object.entries(envEntry as Record<string, string>).map(([k, v]) => [k, expandEnvVars(v, env)])),
      hub: entry.hub !== false
    });
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
    private readonly env: NodeJS.ProcessEnv = process.env
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
  }
}
