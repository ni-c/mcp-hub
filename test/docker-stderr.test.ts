import { describe, expect, it } from 'vitest';
import { DockerTransport } from '../src/transports/docker.js';
import { logSafe } from '../src/auth/text.js';
import type { DockerClient } from '../src/sandbox/docker-client.js';
import type { DockerServerConfig } from '../src/config.js';

/**
 * A docker-sandbox container's stderr must reach the operator's terminal/log
 * stream sanitized, the same as every other child-originated string in this
 * codebase — never raw control characters or a bidi override. These tests
 * exercise DockerTransport's private logStderr() directly — the same way
 * transports.test.ts drives DockerFrameDecoder and DockerTransport without a
 * real daemon — since a container is never actually started here.
 */

const config: DockerServerConfig = {
  kind: 'docker',
  image: 'x@sha256:abc',
  pull: 'never',
  env: {},
  volumes: [],
  ports: [],
  network: 'none',
  memory: 512 * 1024 * 1024,
  pidsLimit: 256,
  cpus: 1,
  readOnly: true,
  tmpfs: ['/tmp'],
  hub: true
};

/** logStderr is private; every other transports test reaches it the same way — through the constructed instance, not through `any`-typed helpers. */
function makeTransport(): { transport: DockerTransport; lines: string[]; feed: (payload: Buffer) => void } {
  const lines: string[] = [];
  const transport = new DockerTransport('sandboxed', config, {} as unknown as DockerClient, line => lines.push(line));
  const feed = (payload: Buffer): void => (transport as unknown as { logStderr: (payload: Buffer) => void }).logStderr(payload);
  return { transport, lines, feed };
}

describe('DockerTransport stderr sanitization', () => {
  it('escapes ESC, BEL, CR, NUL and a bidi override instead of forwarding them raw', () => {
    const { lines, feed } = makeTransport();
    // A representative attack payload: an OSC title-set, a bare CR that
    // would overwrite the previous line, a NUL, and a right-to-left override
    // that would visually reverse the rest of the line.
    const raw = '\x1b]0;PWNED\x07legit status\rFORGED\x00LINE‮reversed';

    feed(Buffer.from(`${raw}\n`, 'utf8'));

    expect(lines).toEqual([`[sandboxed] ${logSafe(raw, Infinity)}\n`]);
    // Belt and braces: none of the five raw control/format bytes survive.
    const [line] = lines;
    // eslint-disable-next-line no-control-regex -- matching them is the point
    expect(line).not.toMatch(/[\x1b\x07\r\x00‮]/u);
  });

  it('handles TAB the same way logSafe() itself does, without a special case in logStderr', () => {
    const { lines, feed } = makeTransport();
    const raw = 'col1\tcol2\tcol3\n';

    feed(Buffer.from(raw, 'utf8'));

    expect(lines).toEqual([`[sandboxed] ${logSafe('col1\tcol2\tcol3', Infinity)}\n`]);
  });

  it('leaves an ordinary ASCII log line byte-for-byte unchanged', () => {
    const { lines, feed } = makeTransport();

    feed(Buffer.from('INFO server listening on :3000\n', 'utf8'));

    expect(lines).toEqual(['[sandboxed] INFO server listening on :3000\n']);
  });

  it('preserves umlauts and emoji, including a multi-byte character split across two docker frames', () => {
    const { lines, feed } = makeTransport();
    const text = 'Grüße von der Sandbox 😀 fertig';
    const whole = Buffer.from(`${text}\n`, 'utf8');
    // Split inside the UTF-8 encoding of "ü" (0xC3 0xBC): the first frame ends
    // one byte into the two-byte sequence, exactly what a Docker frame
    // boundary can do to a container's output.
    const uIndex = whole.indexOf(Buffer.from('ü', 'utf8'));
    const cut = uIndex + 1;

    feed(whole.subarray(0, cut));
    // Nothing should be emitted yet: the line has not seen its '\n', and the
    // dangling UTF-8 byte must not have become a U+FFFD replacement character.
    expect(lines).toHaveLength(0);
    feed(whole.subarray(cut));

    expect(lines).toEqual([`[sandboxed] ${text}\n`]);
  });

  it('reassembles a 4-byte emoji split byte-by-byte across four frames', () => {
    const { lines, feed } = makeTransport();
    const text = 'sandbox says 🚀 go';
    const whole = Buffer.from(`${text}\n`, 'utf8');
    const emojiStart = whole.indexOf(Buffer.from('🚀', 'utf8'));

    feed(whole.subarray(0, emojiStart));
    for (let i = 0; i < 4; i++) feed(whole.subarray(emojiStart + i, emojiStart + i + 1));
    feed(whole.subarray(emojiStart + 4));

    expect(lines).toEqual([`[sandboxed] ${text}\n`]);
  });

  it('does not flush the 64 KiB tail at exactly the limit', () => {
    const { lines, feed } = makeTransport();
    // No newline, so this stays buffered as stderrTail: exactly-at-limit must
    // not trigger the ">" threshold below.
    const atLimit = 'a'.repeat(64 * 1024);

    feed(Buffer.from(atLimit, 'utf8'));

    expect(lines).toHaveLength(0);
  });

  it('flushes the tail, sanitized, at one byte past the 64 KiB limit', () => {
    const { lines, feed } = makeTransport();
    // One byte over the threshold, with a raw ESC at the front so the flush
    // path (a second call site in logStderr) is proven to sanitize too, not
    // just the per-line loop.
    const overLimit = `\x1b${'a'.repeat(64 * 1024)}`;

    feed(Buffer.from(overLimit, 'utf8'));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(`[sandboxed] ${logSafe(overLimit, Infinity)}\n`);
    expect(lines[0]).not.toContain('\x1b');
  });

  it('emits nothing for an empty payload', () => {
    const { lines, feed } = makeTransport();

    feed(Buffer.alloc(0));

    expect(lines).toHaveLength(0);
  });

  it('sanitizes every line of a multi-line payload, not just the first', () => {
    const { lines, feed } = makeTransport();

    feed(Buffer.from('first\x1bline\nsecond\rline\nthird plain line\n', 'utf8'));

    expect(lines).toEqual([
      `[sandboxed] ${logSafe('first\x1bline', Infinity)}\n`,
      `[sandboxed] ${logSafe('second\rline', Infinity)}\n`,
      '[sandboxed] third plain line\n'
    ]);
  });

  it('writes out a last line without a newline, and a character cut off by the exit, when the transport closes', async () => {
    const lines: string[] = [];
    const client = { removeContainer: async () => {} } as unknown as DockerClient;
    const transport = new DockerTransport('sandboxed', config, client, line => lines.push(line));
    const feed = (payload: Buffer): void => (transport as unknown as { logStderr: (payload: Buffer) => void }).logStderr(payload);
    const euro = Buffer.from('€', 'utf8');

    feed(Buffer.concat([Buffer.from('fatal: out of memory \x1b[31m', 'utf8'), euro.subarray(0, 2)]));
    expect(lines).toEqual([]);

    await transport.close();
    expect(lines).toEqual([`[sandboxed] ${logSafe('fatal: out of memory \x1b[31m\uFFFD', Infinity)}\n`]);
  });

  it('writes nothing on close when every line was complete', async () => {
    const lines: string[] = [];
    const client = { removeContainer: async () => {} } as unknown as DockerClient;
    const transport = new DockerTransport('sandboxed', config, client, line => lines.push(line));
    (transport as unknown as { logStderr: (payload: Buffer) => void }).logStderr(Buffer.from('done\n', 'utf8'));

    await transport.close();
    expect(lines).toEqual(['[sandboxed] done\n']);
  });
});
