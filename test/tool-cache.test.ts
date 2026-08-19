import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolCache } from '../src/tool-cache.js';
import type { ToolCacheEntry } from '../src/tool-cache.js';
import { parseConfig } from '../src/config.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-cache-'));
});

afterEach(() => {
  fs.chmodSync(tmpDir, 0o700);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function entry(overrides: Partial<ToolCacheEntry> = {}): ToolCacheEntry {
  return {
    fingerprint: 'fp',
    serverInfo: { name: 'everything', version: '1.0.0' },
    capabilities: { tools: {} },
    tools: [{ name: 'echo', inputSchema: { type: 'object' } }],
    updatedAt: new Date().toISOString(),
    ...overrides
  };
}

describe('ToolCache', () => {
  it('round-trips entries through a second instance', () => {
    const file = path.join(tmpDir, 'tool-cache.json');
    const cache = new ToolCache(file);
    cache.put('a', entry());
    const reloaded = new ToolCache(file);
    reloaded.load();
    expect(reloaded.get('a', 'fp')?.tools.map(t => t.name)).toEqual(['echo']);
    expect(reloaded.get('a', 'fp')?.serverInfo?.name).toBe('everything');
  });

  it('misses on a fingerprint mismatch and on an unknown server', () => {
    const cache = new ToolCache(path.join(tmpDir, 'tool-cache.json'));
    cache.put('a', entry());
    expect(cache.get('a', 'other')).toBeUndefined();
    expect(cache.get('b', 'fp')).toBeUndefined();
  });

  it('treats a corrupt or foreign-version file as empty instead of throwing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const content of ['not json', JSON.stringify({ version: 99, servers: {} }), JSON.stringify({ servers: null })]) {
      const file = path.join(tmpDir, 'tool-cache.json');
      fs.writeFileSync(file, content);
      const cache = new ToolCache(file);
      cache.load();
      expect(cache.get('a', 'fp')).toBeUndefined();
    }
    expect(warn).toHaveBeenCalled();
  });

  it('load() of a missing file is a silent no-op', () => {
    const cache = new ToolCache(path.join(tmpDir, 'nope', 'tool-cache.json'));
    expect(() => cache.load()).not.toThrow();
  });

  it('delete() persists the removal', () => {
    const file = path.join(tmpDir, 'tool-cache.json');
    const cache = new ToolCache(file);
    cache.put('a', entry());
    cache.delete('a');
    const reloaded = new ToolCache(file);
    reloaded.load();
    expect(reloaded.get('a', 'fp')).toBeUndefined();
  });

  it('flushes atomically: the cache file is always valid JSON and no .tmp is left behind', () => {
    const file = path.join(tmpDir, 'tool-cache.json');
    const cache = new ToolCache(file);
    cache.put('a', entry());
    cache.put('b', entry({ fingerprint: 'fp2' }));
    expect(() => JSON.parse(fs.readFileSync(file, 'utf8'))).not.toThrow();
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
  });

  it('probeWritable() reflects directory permissions and creates missing parents', () => {
    expect(new ToolCache(path.join(tmpDir, 'sub', 'dir', 'tool-cache.json')).probeWritable()).toBe(true);
    fs.chmodSync(tmpDir, 0o500);
    expect(new ToolCache(path.join(tmpDir, 'tool-cache.json')).probeWritable()).toBe(false);
  });

  it('warns instead of throwing when the flush fails', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fs.chmodSync(tmpDir, 0o500);
    const cache = new ToolCache(path.join(tmpDir, 'tool-cache.json'));
    expect(() => cache.put('a', entry())).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not write tool cache'));
  });

  it('fingerprints change when an expanded env value rotates', () => {
    const raw = JSON.stringify({ mcpServers: { a: { command: 'x', env: { TOKEN: '${SECRET}' } } } });
    const before = ToolCache.fingerprint(parseConfig(raw, { SECRET: 'one' }).get('a')!);
    const after = ToolCache.fingerprint(parseConfig(raw, { SECRET: 'two' }).get('a')!);
    const same = ToolCache.fingerprint(parseConfig(raw, { SECRET: 'one' }).get('a')!);
    expect(before).not.toBe(after);
    expect(before).toBe(same);
    expect(before).not.toContain('one'); // a hash, never the secret itself
  });
});
