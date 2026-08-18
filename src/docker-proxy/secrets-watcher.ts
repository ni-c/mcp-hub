import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import type { HubConfig } from '../config.js';
import { SecretError, SecretStore } from './secrets.js';

/**
 * Watches the sandbox secrets directory and reports when the *content* of a
 * referenced set changes.
 *
 * Why this lives in the proxy and not the hub: the hub never sees the secret
 * values (that is the point of `secretsFrom`), so it cannot know when they
 * change. The proxy can — and it is also the only component allowed to act on
 * it, by recreating the affected sandbox container so the next create picks up
 * the new values. The values themselves are never cached here; `policy.ts`
 * reads them fresh from disk on every create. This watcher only supplies the
 * missing trigger.
 *
 * Watching strategy mirrors ConfigWatcher: fs.watch on the directory for the
 * common case, plus stat polling per referenced file as the fallback for
 * bind mounts where host-side inotify events do not cross the mount boundary.
 */

const DEBOUNCE_MS = 1_000;

/** Content identity of a secret set: key order and formatting do not matter. */
function fingerprint(secrets: Record<string, string>): string {
  return JSON.stringify(Object.entries(secrets).sort(([a], [b]) => a.localeCompare(b)));
}

/** All docker servers that reference a given secret set. */
function referencingServers(config: HubConfig, set: string): string[] {
  const servers: string[] = [];
  for (const [name, entry] of config) {
    if (entry.kind === 'docker' && entry.secretsFrom === set) servers.push(name);
  }
  return servers;
}

function referencedSets(config: HubConfig): Set<string> {
  const sets = new Set<string>();
  for (const entry of config.values()) {
    if (entry.kind === 'docker' && entry.secretsFrom !== undefined) sets.add(entry.secretsFrom);
  }
  return sets;
}

export class SecretsWatcher extends EventEmitter {
  private watcher?: fs.FSWatcher;
  private readonly debounce = new Map<string, NodeJS.Timeout>();
  private readonly polled = new Map<string, string>(); // set name -> watched file path
  private readonly fingerprints = new Map<string, string>();

  constructor(
    private readonly store: SecretStore,
    private readonly dir: string,
    private readonly config: () => HubConfig,
    private readonly pollIntervalMs = 3_000,
    private readonly debounceMs = DEBOUNCE_MS
  ) {
    super();
  }

  start(): void {
    // Baseline first: what is on disk right now is the state the running
    // containers were created from (index.ts validated it at startup), so it
    // must not count as a change.
    this.refresh();
    try {
      this.watcher = fs.watch(this.dir, (_event, filename) => {
        if (filename === null || !filename.endsWith('.env')) return;
        this.schedule(filename.slice(0, -'.env'.length));
      });
    } catch (error) {
      // Polling still covers every referenced file; say so rather than dying.
      this.emit('error', new Error(`cannot watch ${this.dir}, falling back to polling only: ${(error as Error).message}`));
    }
  }

  /**
   * Aligns the polled-file list and baselines with the current config. Called
   * at start and whenever the config reloads — a set that gained its first
   * reference starts being watched, one that lost its last stops.
   */
  refresh(): void {
    const wanted = referencedSets(this.config());
    for (const [set, file] of this.polled) {
      if (wanted.has(set)) continue;
      fs.unwatchFile(file);
      this.polled.delete(set);
      this.fingerprints.delete(set);
    }
    for (const set of wanted) {
      if (this.polled.has(set)) continue;
      let file: string;
      try {
        file = this.store.pathFor(set);
      } catch (error) {
        this.emit('error', error as Error);
        continue;
      }
      fs.watchFile(file, { interval: this.pollIntervalMs }, (curr, prev) => {
        if (curr.mtimeMs === prev.mtimeMs && curr.size === prev.size) return;
        this.schedule(set);
      });
      this.polled.set(set, file);
      // A set that appears without a baseline (new reference after a config
      // reload) gets one silently: its container, if any, is created after
      // this point and reads the file fresh anyway.
      try {
        this.fingerprints.set(set, fingerprint(this.store.load(set)));
      } catch {
        // Leave it without a baseline; the first *valid* read becomes one.
      }
    }
  }

  private schedule(set: string): void {
    const timer = this.debounce.get(set);
    if (timer) clearTimeout(timer);
    // A secrets file is usually edited by hand; a generous debounce keeps a
    // half-finished save from triggering a container restart per keystroke.
    this.debounce.set(
      set,
      setTimeout(() => {
        this.debounce.delete(set);
        this.check(set);
      }, this.debounceMs)
    );
  }

  private check(set: string): void {
    const config = this.config();
    const servers = referencingServers(config, set);
    if (servers.length === 0) return; // unreferenced (or no longer referenced): none of our business

    let secrets: Record<string, string>;
    try {
      secrets = this.store.load(set);
      // Same collision rule as validateConfigSecrets: a secret must not shadow
      // a configured env key, whose value the hub already fixed.
      for (const server of servers) {
        const entry = config.get(server);
        if (entry?.kind !== 'docker') continue;
        const collision = Object.keys(secrets).find(key => Object.hasOwn(entry.env, key));
        if (collision) throw new SecretError(`secret "${collision}" collides with a configured env key of server "${server}"`);
      }
    } catch (error) {
      // Fail safe: a broken edit must not take the running container down —
      // restarting it now would only produce a create that fails on the same
      // file. Keep the old baseline so the next valid content still fires.
      this.emit('error', new Error(`${path.basename(this.polled.get(set) ?? set)}: ${(error as Error).message}`));
      return;
    }

    const next = fingerprint(secrets);
    const previous = this.fingerprints.get(set);
    this.fingerprints.set(set, next);
    if (previous === undefined || previous === next) return; // baseline, touch, or comment-only edit
    this.emit('change', set, servers);
  }

  stop(): void {
    for (const timer of this.debounce.values()) clearTimeout(timer);
    this.debounce.clear();
    this.watcher?.close();
    for (const file of this.polled.values()) fs.unwatchFile(file);
    this.polled.clear();
  }
}
