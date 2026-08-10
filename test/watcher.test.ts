import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigWatcher, loadConfig, type HubConfig, type ConfigDiff } from '../src/config.js';

let tmpDir: string;
let configPath: string;
let watcher: ConfigWatcher;

const write = (servers: Record<string, unknown>) => fs.writeFileSync(configPath, JSON.stringify({ mcpServers: servers }));

const nextChange = () =>
  new Promise<{ config: HubConfig; diff: ConfigDiff }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no change event within 3s')), 3000);
    watcher.once('change', (config: HubConfig, diff: ConfigDiff) => {
      clearTimeout(timer);
      resolve({ config, diff });
    });
  });

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-watch-'));
  configPath = path.join(tmpDir, 'mcp.json');
  write({ a: { command: 'x' } });
  watcher = new ConfigWatcher(configPath, loadConfig(configPath));
  watcher.start();
});

afterEach(() => {
  watcher.stop();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('ConfigWatcher', () => {
  it('emits a diff when the file changes', async () => {
    const pending = nextChange();
    write({ a: { command: 'x' }, b: { command: 'y' } });
    const { config, diff } = await pending;
    expect(diff).toEqual({ added: ['b'], removed: [], changed: [] });
    expect(config.get('b')?.command).toBe('y');
  });

  it('survives a broken edit and applies the next valid one', async () => {
    const errors: Error[] = [];
    watcher.on('error', e => errors.push(e as Error));
    fs.writeFileSync(configPath, '{ not json');
    await new Promise(resolve => setTimeout(resolve, 600));
    expect(errors.length).toBe(1);
    expect(watcher.current.get('a')).toBeDefined(); // old config still active

    const pending = nextChange();
    write({ a: { command: 'changed' } });
    const { diff } = await pending;
    expect(diff.changed).toEqual(['a']);
  });
});
