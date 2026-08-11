import type { Request, Response } from 'express';
import type { Supervisor } from './supervisor.js';

/**
 * Unauthenticated on purpose (Docker's HEALTHCHECK needs it), so it reports
 * state only: lastError carries upstream URLs and spawn paths and stays in the
 * container log instead.
 */
export function healthHandler(supervisor: Supervisor) {
  return (_req: Request, res: Response): void => {
    const servers = Object.fromEntries(
      [...supervisor.servers.values()].map(s => [
        s.name,
        { state: s.state, restarts: s.restarts, tools: s.tools.length, hub: s.config.hub }
      ])
    );
    const allUp = Object.values(servers).every(s => s.state === 'up');
    res.status(allUp ? 200 : 503).json({ status: allUp ? 'ok' : 'degraded', servers });
  };
}
