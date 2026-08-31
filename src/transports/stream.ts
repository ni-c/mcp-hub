import type { Duplex } from 'node:stream';
import { STDIO_DEFAULT_MAX_BUFFER_SIZE, deserializeMessage, serializeMessage } from '@modelcontextprotocol/server';
import type { Transport, JSONRPCMessage } from '@modelcontextprotocol/server';

/**
 * MCP over any reliable bidirectional byte stream, using the stdio framing.
 *
 * The specification says exactly this about custom transports: they may run
 * over other channels (a Unix socket, a TCP connection, a container's attached
 * stdio) and SHOULD reuse the stdio binding's newline-delimited JSON rather
 * than invent a framing. So this class is only plumbing — ReadBuffer and
 * serializeMessage are the SDK's own stdio codec, byte for byte.
 *
 * Reading is separated from the stream on purpose: an attached container
 * multiplexes stdout and stderr over one connection, so the caller decodes the
 * frames and feeds only the stdout payload in via `receive()`.
 */
export class StreamTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private buffer: Buffer = Buffer.alloc(0);
  private started = false;
  private closed = false;
  private reportedClose = false;

  /**
   * @param stream        the duplex carrying the protocol
   * @param feedFromStream whether stream data is plain protocol bytes. False
   *                       when the caller demultiplexes first (Docker attach).
   */
  constructor(
    protected readonly stream: Duplex,
    private readonly feedFromStream = true
  ) {}

  async start(): Promise<void> {
    if (this.started) throw new Error('StreamTransport already started');
    this.started = true;
    if (this.feedFromStream) this.stream.on('data', chunk => this.receive(chunk as Buffer));
    this.stream.on('error', error => this.onerror?.(error as Error));
    // 'close' rather than 'end': a half-open socket whose peer vanished never
    // emits 'end', and the supervisor must learn about the death either way.
    this.stream.on('close', () => this.reportClosed());
  }

  /**
   * Feed protocol bytes that were read out of band (demultiplexed stdout).
   *
   * The line framing is written out here rather than delegated to the SDK's
   * ReadBuffer, which is what this used to do. ReadBuffer's handling of a line
   * that does not parse is not part of its API and it changed: it used to
   * throw, and now it skips the line and reads on. Silently is the wrong answer
   * for a gateway — a stray line on a child's stdout means the stream is
   * desynchronised or the child is printing where it should not, and that is
   * something an operator wants in the log, not something to absorb. The SDK's
   * own codec still does the parsing; only the policy is local.
   */
  receive(chunk: Buffer): void {
    if (this.buffer.length + chunk.length > STDIO_DEFAULT_MAX_BUFFER_SIZE) {
      // A peer that keeps sending without ever writing a newline. This runs
      // inside a 'data' handler, so a throw here would reach
      // process.on('uncaughtException') and take the entire hub down — every
      // other server with it — because one sandboxed server misbehaved. The
      // stream is desynchronised anyway: report it, end this connection, let
      // the supervisor restart it.
      this.buffer = Buffer.alloc(0);
      this.onerror?.(new Error(`ReadBuffer exceeded maximum size of ${STDIO_DEFAULT_MAX_BUFFER_SIZE} bytes`));
      void this.close();
      return;
    }
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline === -1) return;
      const line = this.buffer.toString('utf8', 0, newline).replace(/\r$/, '');
      this.buffer = this.buffer.subarray(newline + 1);
      let message: JSONRPCMessage;
      try {
        message = deserializeMessage(line);
      } catch (error) {
        // One malformed line must not kill the connection: report it and carry
        // on with the bytes after the newline.
        this.onerror?.(error as Error);
        continue;
      }
      this.onmessage?.(message);
    }
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed) throw new Error('Transport is closed');
    const payload = serializeMessage(message);
    // The write callback fires once the chunk has left the buffer, so awaiting
    // it respects backpressure: a server that stops reading slows us down
    // instead of letting the socket buffer grow without bound.
    await new Promise<void>((resolve, reject) => {
      this.stream.write(payload, error => (error ? reject(error) : resolve()));
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.stream.destroy();
    this.reportClosed();
  }

  private reportClosed(): void {
    if (this.reportedClose) return;
    this.reportedClose = true;
    this.closed = true;
    this.buffer = Buffer.alloc(0);
    this.onclose?.();
  }
}
