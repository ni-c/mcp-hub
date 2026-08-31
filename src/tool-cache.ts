import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Implementation, ServerCapabilities, Tool } from '@modelcontextprotocol/server';
import type { ServerConfig } from './config.js';

const CACHE_VERSION = 1;

/**
 * What a sleeping server can still answer: its identity for `initialize`, its
 * capabilities for the proxy's handler registration, and its tool list.
 */
export interface ToolCacheEntry {
  /** sha256 of the expanded server config; a mismatch means the entry is stale. */
  fingerprint: string;
  serverInfo?: Implementation;
  capabilities?: ServerCapabilities;
  tools: Tool[];
  updatedAt: string;
}

interface CacheFile {
  version: number;
  servers: Record<string, ToolCacheEntry>;
}

/**
 * Persistent per-server snapshots, so on-demand servers can boot straight into
 * `sleeping` and still answer `initialize` and `tools/list` from cache.
 *
 * The entry is keyed to a *hash* of the expanded config rather than the config
 * itself: the expanded form contains secrets (env values, headers), and a hash
 * both keeps them out of the data volume and still invalidates the entry when
 * a referenced ${VAR} rotates.
 */
export class ToolCache {
  private servers = new Map<string, ToolCacheEntry>();

  constructor(readonly filePath: string) {}

  static fingerprint(config: ServerConfig): string {
    return createHash('sha256').update(JSON.stringify(config)).digest('hex');
  }

  /** A corrupt or foreign-version file must never take the hub down — it only costs a warm start. */
  load(): void {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch {
      return; // no cache yet
    }
    try {
      const parsed = JSON.parse(raw) as CacheFile;
      if (parsed.version !== CACHE_VERSION || typeof parsed.servers !== 'object' || parsed.servers === null) {
        throw new Error(`unsupported cache format (version ${parsed.version})`);
      }
      this.servers = new Map(Object.entries(parsed.servers));
    } catch (error) {
      console.warn(`mcp-hub: ignoring unreadable tool cache ${this.filePath}: ${(error as Error).message}`);
      this.servers = new Map();
    }
  }

  probeWritable(): boolean {
    const probe = `${this.filePath}.probe`;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(probe, '');
      fs.unlinkSync(probe);
      return true;
    } catch {
      return false;
    }
  }

  get(name: string, fingerprint: string): ToolCacheEntry | undefined {
    const entry = this.servers.get(name);
    if (!entry || entry.fingerprint !== fingerprint) return undefined;
    return entry;
  }

  put(name: string, entry: ToolCacheEntry): void {
    this.servers.set(name, entry);
    this.flush();
  }

  delete(name: string): void {
    if (!this.servers.delete(name)) return;
    this.flush();
  }

  private flush(): void {
    const file: CacheFile = { version: CACHE_VERSION, servers: Object.fromEntries(this.servers) };
    const tmp = `${this.filePath}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      // Write-then-rename: a crash mid-write leaves the previous cache intact
      // instead of a truncated file the next boot would have to throw away.
      fs.writeFileSync(tmp, JSON.stringify(file));
      fs.renameSync(tmp, this.filePath);
    } catch (error) {
      console.warn(`mcp-hub: could not write tool cache ${this.filePath}: ${(error as Error).message}`);
    }
  }
}
