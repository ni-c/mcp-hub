import type { Duplex } from 'node:stream';
import type { Transport, JSONRPCMessage } from '@modelcontextprotocol/server';
import type { DockerServerConfig } from '../config.js';
import { buildCreateRequest, containerName } from '../sandbox/container-spec.js';
import { DockerClient } from '../sandbox/docker-client.js';
import { StreamTransport, setTransportHandlers } from './stream.js';

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
  /**
   * The bytes of the frame in progress, as the chunks they arrived in, joined
   * once the whole frame is here. One growing buffer would copy itself on every
   * chunk — quadratic in the frame size, on the hub's event loop, for a size
   * the peer chooses.
   */
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  /** The header of the frame in progress, once eight bytes have arrived. */
  private header?: { stream: number; size: number };
  private failed = false;

  constructor(
    private readonly onFrame: (stream: number, payload: Buffer) => void,
    private readonly onError: (error: Error) => void
  ) {}

  push(chunk: Buffer): void {
    if (this.failed) return;
    if (chunk.length === 0) return;
    this.pending.push(chunk);
    this.pendingBytes += chunk.length;
    for (;;) {
      if (this.header === undefined) {
        if (this.pendingBytes < 8) return;
        // Joining here is cheap: the pending pieces hold at most a header's
        // worth of bytes plus whatever one chunk brought with it.
        const joined = this.join();
        const size = joined.readUInt32BE(4);
        if (size > MAX_FRAME_BYTES) {
          this.failed = true;
          this.onError(new Error(`docker frame of ${size} bytes exceeds the ${MAX_FRAME_BYTES} byte limit`));
          this.pending = [];
          this.pendingBytes = 0;
          return;
        }
        this.header = { stream: joined[0], size };
        this.replace(joined.subarray(8));
      }
      if (this.pendingBytes < this.header.size) return;
      const joined = this.join();
      const { stream, size } = this.header;
      this.header = undefined;
      this.replace(joined.subarray(size));
      this.onFrame(stream, joined.subarray(0, size));
    }
  }

  private join(): Buffer {
    return this.pending.length === 1 ? this.pending[0] : Buffer.concat(this.pending);
  }

  private replace(rest: Buffer): void {
    this.pending = rest.length > 0 ? [rest] : [];
    this.pendingBytes = rest.length;
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
    setTransportHandlers(inner, {
      onmessage: message => this.onmessage?.(message),
      onerror: error => this.onerror?.(error),
      onclose: () => {
        this.onclose?.();
        // Best effort: with AutoRemove the daemon usually got there first.
        if (!this.closing) void this.client.removeContainer(name).catch(() => {});
      }
    });
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
