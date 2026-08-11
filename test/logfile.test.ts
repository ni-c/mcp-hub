import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { installFileLogging, type FileLogger } from '../src/logfile.js';

let logger: FileLogger | undefined;
let dir: string | undefined;

afterEach(() => {
  logger?.stop();
  logger = undefined;
  vi.restoreAllMocks();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function tempFile(name = 'mcp-hub.log'): string {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-log-'));
  return path.join(dir, name);
}

/** The stream writes asynchronously, so give the event loop a turn. */
async function readLog(file: string): Promise<string> {
  await new Promise(resolve => setTimeout(resolve, 20));
  return fs.readFileSync(file, 'utf8');
}

describe('installFileLogging', () => {
  it('mirrors every console level into the file with an ISO timestamp', async () => {
    const file = tempFile();
    logger = installFileLogging(file);
    console.log('plain');
    console.info('informational');
    console.warn('mcp-hub: authentication failure from 203.0.113.5');
    console.error('boom');

    const lines = (await readLog(file)).trimEnd().split('\n');
    expect(lines).toHaveLength(4);
    for (const line of lines) {
      expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /);
    }
    expect(lines[2]).toContain('mcp-hub: authentication failure from 203.0.113.5');
  });

  it('still forwards to the original console method', () => {
    const file = tempFile();
    // Spying before installing makes the spy the "previous" implementation the
    // wrapper has to call — vitest intercepts console itself, so asserting on
    // process.stdout would test vitest rather than us.
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    logger = installFileLogging(file);
    console.log('still on the console');
    expect(spy).toHaveBeenCalledWith('still on the console');
  });

  it('formats like console does', async () => {
    const file = tempFile();
    logger = installFileLogging(file);
    console.log('count %d for %s', 7, 'alice', { extra: true });
    expect(await readLog(file)).toContain("count 7 for alice { extra: true }");
  });

  it('prefixes every line of a multi-line entry', async () => {
    const file = tempFile();
    logger = installFileLogging(file);
    console.error('first\nsecond');
    const lines = (await readLog(file)).trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/^\d{4}-\d{2}-\d{2}T.*second$/);
  });

  it('appends instead of truncating', async () => {
    const file = tempFile();
    fs.writeFileSync(file, 'existing line\n');
    logger = installFileLogging(file);
    console.log('appended');
    const content = await readLog(file);
    expect(content).toContain('existing line');
    expect(content).toContain('appended');
  });

  it('creates the directory if it does not exist', async () => {
    const file = path.join(path.dirname(tempFile()), 'nested', 'deep', 'mcp-hub.log');
    logger = installFileLogging(file);
    console.log('nested');
    expect(await readLog(file)).toContain('nested');
  });

  it('reports an unwritable path once and keeps the hub logging', () => {
    const base = tempFile();
    // A path whose parent is a file, so mkdir/open must fail.
    fs.writeFileSync(base, '');
    const impossible = path.join(base, 'nope.log');
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(String(args[0]));
    });

    logger = installFileLogging(impossible);
    expect(() => console.log('must not throw')).not.toThrow();
    expect(() => console.error('nor here')).not.toThrow();
    expect(errors.filter(line => line.includes('file logging')).length).toBe(1);
  });

  it('restores the original console methods on stop', () => {
    const file = tempFile();
    const before = console.log;
    logger = installFileLogging(file);
    expect(console.log).not.toBe(before);
    logger.stop();
    logger = undefined;
    expect(console.log).toBe(before);
  });
});
