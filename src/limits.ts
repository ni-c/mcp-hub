import type { NextFunction, Request, Response } from 'express';

interface ClientWindow {
  startedAt: number;
  requests: number;
  inFlight: number;
}

/**
 * Bounds authenticated MCP traffic by OAuth client. This protects child
 * servers from one connector monopolising every proxy slot while avoiding an
 * IP-based key that would collapse all clients behind the same reverse proxy.
 */
export class ClientRequestGate {
  private readonly clients = new Map<string, ClientWindow>();
  private lastSweep = 0;

  constructor(
    private readonly requestsPerMinute: number,
    private readonly maxConcurrent: number
  ) {}

  middleware = (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    this.sweep(now);
    const clientId = req.auth?.clientId ?? 'unknown';
    let window = this.clients.get(clientId);
    if (!window) {
      window = { startedAt: now, requests: 0, inFlight: 0 };
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
    if (window.inFlight >= this.maxConcurrent) {
      res.set('Retry-After', '1');
      res.status(429).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Too many concurrent MCP requests' }, id: null });
      return;
    }

    window.requests++;
    window.inFlight++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      window!.inFlight = Math.max(0, window!.inFlight - 1);
    };
    res.once('finish', release);
    res.once('close', release);
    next();
  };

  private sweep(now: number): void {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [clientId, window] of this.clients) {
      if (window.inFlight === 0 && now - window.startedAt >= 60_000) this.clients.delete(clientId);
    }
  }
}
