import net from 'node:net';
import type { SocketServerConfig } from '../config.js';
import { StreamTransport } from './stream.js';

const CONNECT_TIMEOUT_MS = 10_000;

/**
 * Connects to a server that already listens on a Unix socket or a TCP port and
 * speaks stdio-framed JSON-RPC there.
 *
 * This is the sandboxing route that costs the hub no privileges at all: the
 * container is started by whoever owns the Compose file, and a Unix socket in
 * a shared volume reaches it even with `network_mode: none` — something an
 * HTTP upstream can never offer, because HTTP needs an interface to listen on.
 */
export class SocketTransport extends StreamTransport {
  constructor(private readonly config: SocketServerConfig) {
    // The socket is created here but connected in start(); an unconnected
    // net.Socket is a perfectly ordinary Duplex until then.
    super(new net.Socket());
  }

  override async start(): Promise<void> {
    const socket = this.stream as net.Socket;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        socket.destroy();
        reject(new Error(`cannot connect to ${this.describe()}: ${error.message}`));
      };
      const onTimeout = () => {
        socket.destroy();
        reject(new Error(`timed out connecting to ${this.describe()}`));
      };
      socket.once('error', onError);
      socket.once('timeout', onTimeout);
      socket.setTimeout(CONNECT_TIMEOUT_MS);
      socket.once('connect', () => {
        // Hand the socket over cleanly: the connect-phase handlers must not
        // survive, or a later error would destroy the socket behind the
        // transport's back instead of being reported through onerror. And the
        // connect timeout must not linger as an idle timeout — an MCP session
        // is idle most of the time and would be torn down mid-use.
        socket.off('error', onError);
        socket.off('timeout', onTimeout);
        socket.setTimeout(0);
        if (this.config.transport === 'tcp') socket.setNoDelay(true);
        resolve();
      });
      if (this.config.transport === 'unix') socket.connect({ path: this.config.socketPath! });
      else socket.connect({ host: this.config.host!, port: this.config.port! });
    });
    await super.start();
  }

  private describe(): string {
    return this.config.transport === 'unix' ? this.config.socketPath! : `${this.config.host!}:${this.config.port!}`;
  }
}
