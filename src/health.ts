import type { Request, Response } from 'express';
import type { Supervisor } from './supervisor.js';

export function healthHandler(supervisor: Supervisor) {
  return (_req: Request, res: Response): void => {
    const servers = Object.fromEntries(
      [...supervisor.servers.values()].map(s => [
        s.name,
        { state: s.state, restarts: s.restarts, tools: s.tools.length, hub: s.config.hub, ...(s.lastError ? { lastError: s.lastError } : {}) }
      ])
    );
    const allUp = Object.values(servers).every(s => s.state === 'up');
    res.status(allUp ? 200 : 503).json({ status: allUp ? 'ok' : 'degraded', servers });
  };
}
