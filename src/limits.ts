import type { NextFunction, Request, Response } from 'express';

interface ClientWindow {
  startedAt: number;
  requests: number;
  inFlight: number;
  streams: number;
}

/**
 * Bounds authenticated MCP traffic by OAuth client. This protects child
 * servers from one connector monopolising every proxy slot while avoiding an
 * IP-based key that would collapse all clients behind the same reverse proxy.
 *
 * Streamable HTTP has two shapes of request and they need separate budgets. A
 * POST carries JSON-RPC and ends when the answer does — that is the work a
 * child server performs, and `maxConcurrent` bounds it. A GET opens the
 * server-to-client SSE channel and stays open for the whole session; it costs
 * a socket and nothing else. Counting those as in-flight work meant every
 * connected session permanently held a slot, so the fifth session against a
 * default of four got `429` on connect while the hub was otherwise idle.
 */
export class ClientRequestGate {
  private readonly clients = new Map<string, ClientWindow>();
  private lastSweep = 0;

  constructor(
    private readonly requestsPerMinute: number,
    private readonly maxConcurrent: number,
    private readonly maxStreams: number
  ) {}

  /**
   * For MCP routes, where a GET is the standing SSE listening channel by
   * definition — the spec has no other use for it.
   */
  middleware = this.gate(req => req.method === 'GET');

  /** For routes that only ever answer one request, such as `/health`. */
  requestMiddleware = this.gate(() => false);

  private gate(isListeningStream: (req: Request) => boolean) {
    return (req: Request, res: Response, next: NextFunction): void => this.admit(req, res, next, isListeningStream(req));
  }

  private admit(req: Request, res: Response, next: NextFunction, listening: boolean): void {
    const now = Date.now();
    this.sweep(now);
    const clientId = req.auth?.clientId ?? 'unknown';
    let window = this.clients.get(clientId);
    if (!window) {
      window = { startedAt: now, requests: 0, inFlight: 0, streams: 0 };
      this.clients.set(clientId, window);
    } else if (now - window.startedAt >= 60_000) {
      window.startedAt = now;
      window.requests = 0;
    }

    const retryAfter = Math.max(1, Math.ceil((window.startedAt + 60_000 - now) / 1000));
    if (window.requests >= this.requestsPerMinute) {
      res.set('Retry-After', String(retryAfter));
      res.status(429).json({ jsonrpc: '2.0', error: { code: -32000, message: 'MCP request rate limit exceeded' }, id: null });
      return;
    }
    if (listening ? window.streams >= this.maxStreams : window.inFlight >= this.maxConcurrent) {
      res.set('Retry-After', '1');
      const message = listening ? 'Too many concurrent MCP streams' : 'Too many concurrent MCP requests';
      res.status(429).json({ jsonrpc: '2.0', error: { code: -32000, message }, id: null });
      return;
    }

    window.requests++;
    if (listening) window.streams++;
    else window.inFlight++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (listening) window!.streams = Math.max(0, window!.streams - 1);
      else window!.inFlight = Math.max(0, window!.inFlight - 1);
    };
    res.once('finish', release);
    res.once('close', release);
    next();
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [clientId, window] of this.clients) {
      if (window.inFlight === 0 && window.streams === 0 && now - window.startedAt >= 60_000) this.clients.delete(clientId);
    }
  }
}
