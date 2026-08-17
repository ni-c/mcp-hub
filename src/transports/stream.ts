import type { Duplex } from 'node:stream';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

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

  private readonly readBuffer = new ReadBuffer();
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

  /** Feed protocol bytes that were read out of band (demultiplexed stdout). */
  receive(chunk: Buffer): void {
    try {
      this.readBuffer.append(chunk);
    } catch (error) {
      // The SDK caps the buffer at 10 MB and throws when a peer keeps sending
      // without ever writing a newline. This runs inside a 'data' handler, so
      // an escaping throw would reach process.on('uncaughtException') and take
      // the entire hub down — every other server with it — because one
      // sandboxed server misbehaved. The stream is desynchronised anyway:
      // report it, end this connection, let the supervisor restart it.
      this.onerror?.(error as Error);
      void this.close();
      return;
    }
    for (;;) {
      let message: JSONRPCMessage | null;
      try {
        message = this.readBuffer.readMessage();
      } catch (error) {
        // One malformed line must not kill the connection: report it and let
        // the buffer continue with the bytes after the newline.
        this.onerror?.(error as Error);
        continue;
      }
      if (message === null) return;
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
    this.readBuffer.clear();
    this.onclose?.();
  }
}
