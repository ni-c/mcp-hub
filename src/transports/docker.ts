import type { Duplex } from 'node:stream';
import type { Transport, JSONRPCMessage } from '@modelcontextprotocol/server';
import type { DockerServerConfig } from '../config.js';
import { buildCreateRequest, containerName } from '../sandbox/container-spec.js';
import { DockerClient } from '../sandbox/docker-client.js';
import { StreamTransport } from './stream.js';

/** Guards against a corrupt header turning into a multi-gigabyte allocation. */
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const STDOUT = 1;
const STDERR = 2;

/**
 * Demultiplexes Docker's attach stream.
 *
 * Without a TTY the daemon frames every chunk with an 8-byte header —
 * `[stream, 0, 0, 0, size:uint32be]` — so one connection can carry stdout and
 * stderr. That is exactly what a sandboxed MCP server needs: stdout stays a
 * clean protocol channel while the server's log lines still reach the operator.
 */
export class DockerFrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);
  private failed = false;

  constructor(
    private readonly onFrame: (stream: number, payload: Buffer) => void,
    private readonly onError: (error: Error) => void
  ) {}

  push(chunk: Buffer): void {
    if (this.failed) return;
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.buffer.length < 8) return;
      const size = this.buffer.readUInt32BE(4);
      if (size > MAX_FRAME_BYTES) {
        this.failed = true;
        this.onError(new Error(`docker frame of ${size} bytes exceeds the ${MAX_FRAME_BYTES} byte limit`));
        this.buffer = Buffer.alloc(0);
        return;
      }
      if (this.buffer.length < 8 + size) return;
      const stream = this.buffer[0];
      const payload = this.buffer.subarray(8, 8 + size);
      this.buffer = this.buffer.subarray(8 + size);
      this.onFrame(stream, payload);
    }
  }
}

/**
 * An MCP server running in its own container, spoken to over the Docker API.
 *
 * The isolation is the container's (own filesystem, own credentials, own
 * network policy, own memory limit); the protocol is plain stdio across the
 * container boundary. No HTTP listener, no bridge process inside the image, no
 * shared secret — the things an HTTP upstream forces on a server that only
 * speaks stdio.
 *
 * Order matters: create, then attach, then start. Starting before the attach
 * is in place loses whatever the server writes in its first milliseconds.
 */
export class DockerTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private inner?: StreamTransport;
  private stream?: Duplex;
  private closing = false;
  private stderrTail = '';

  constructor(
    private readonly server: string,
    private readonly config: DockerServerConfig,
    private readonly client: DockerClient,
    private readonly writeStderr: (line: string) => void = line => process.stderr.write(line)
  ) {}

  async start(): Promise<void> {
    const { name, body } = buildCreateRequest(this.server, this.config);
    await this.ensureImage();
    // A container of that name can survive an unclean hub exit (AutoRemove
    // only fires when the container itself stops), and create would then fail
    // with a name conflict forever.
    await this.client.removeContainer(name);
    await this.client.createContainer(name, body);

    let stream: Duplex;
    try {
      stream = await this.client.attach(name);
    } catch (error) {
      await this.client.removeContainer(name).catch(() => {});
      throw error;
    }
    this.stream = stream;

    const inner = new StreamTransport(stream, false);
    inner.onmessage = message => this.onmessage?.(message);
    inner.onerror = error => this.onerror?.(error);
    inner.onclose = () => {
      this.onclose?.();
      // Best effort: with AutoRemove the daemon usually got there first.
      if (!this.closing) void this.client.removeContainer(name).catch(() => {});
    };
    await inner.start();
    this.inner = inner;

    const decoder = new DockerFrameDecoder(
      (streamType, payload) => {
        if (streamType === STDOUT) inner.receive(payload);
        else if (streamType === STDERR) this.logStderr(payload);
      },
      error => {
        this.onerror?.(error);
        // A corrupt length makes frame boundaries unknowable. Closing the
        // attach stream triggers container cleanup and the supervisor's normal
        // restart backoff instead of leaving a poisoned stream alive.
        void inner.close();
      }
    );
    stream.on('data', chunk => decoder.push(chunk as Buffer));

    try {
      await this.client.startContainer(name);
    } catch (error) {
      await this.client.removeContainer(name).catch(() => {});
      throw error;
    }
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.inner) throw new Error(`Server "${this.server}" is not attached`);
    await this.inner.send(message);
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.inner?.close();
    this.stream?.destroy();
    await this.client.removeContainer(containerName(this.server)).catch(() => {});
  }

  private async ensureImage(): Promise<void> {
    if (await this.client.imageExists(this.config.image)) return;
    if (this.config.pull !== 'missing') {
      throw new Error(`image "${this.config.image}" is not present and "pull" is "never" — build or pull it first`);
    }
    await this.client.pullImage(this.config.image);
  }

  /**
   * Prefix the container's stderr like a stdio child's, and write it straight
   * to the process's stderr rather than through console: stdio children use
   * `stderr: 'inherit'` and bypass console too, which is what keeps LOG_FILE
   * (read by fail2ban) free of server chatter.
   */
  private logStderr(payload: Buffer): void {
    this.stderrTail += payload.toString('utf8');
    const lines = this.stderrTail.split('\n');
    this.stderrTail = lines.pop() ?? '';
    for (const line of lines) this.writeStderr(`[${this.server}] ${line}\n`);
    if (this.stderrTail.length > 64 * 1024) {
      this.writeStderr(`[${this.server}] ${this.stderrTail}\n`);
      this.stderrTail = '';
    }
  }
}
