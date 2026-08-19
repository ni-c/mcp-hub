import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { warnSingleFileMount } from '../src/mount-check.js';

let tmpDir: string;
let warn: ReturnType<typeof vi.spyOn>;

// Realistic mountinfo shape: field 5 is the mount point.
const line = (mountPoint: string) => `543 528 254:1 /volumes/x ${mountPoint} ro,relatime master:1 - ext4 /dev/vda1 rw`;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-mountinfo-'));
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function mountinfo(...lines: string[]): string {
  const file = path.join(tmpDir, 'mountinfo');
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

describe('warnSingleFileMount', () => {
  it('warns when the config file is itself a mount point', () => {
    const info = mountinfo(line('/'), line('/data'), line('/config/mcp.json'));
    warnSingleFileMount('/config/mcp.json', 'mcp-hub', info);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain('mcp-hub: /config/mcp.json is a single-file bind mount');
    expect(warn.mock.calls[0][0]).toContain('./config:/config:ro');
  });

  it('stays silent for a directory mount', () => {
    const info = mountinfo(line('/'), line('/config'), line('/data'));
    warnSingleFileMount('/config/mcp.json', 'mcp-hub', info);
    expect(warn).not.toHaveBeenCalled();
  });

  it('decodes octal escapes in mount points', () => {
    const info = mountinfo(line('/config\\040dir/mcp.json'));
    warnSingleFileMount('/config dir/mcp.json', 'mcp-hub', info);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('is a silent no-op without mountinfo (non-Linux, restricted container)', () => {
    expect(() => warnSingleFileMount('/config/mcp.json', 'mcp-hub', path.join(tmpDir, 'missing'))).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });

  it('ignores malformed lines instead of throwing', () => {
    const info = mountinfo('garbage', '', 'a b', line('/config/mcp.json'));
    warnSingleFileMount('/config/mcp.json', 'mcp-hub', info);
    expect(warn).toHaveBeenCalledOnce();
  });
});
