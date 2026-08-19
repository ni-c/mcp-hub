import type { Request, Response } from 'express';
import type { Supervisor } from './supervisor.js';
import { containerName } from './sandbox/container-spec.js';

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
        {
          state: s.state,
          kind: s.config.kind,
          restarts: s.restarts,
          tools: s.tools.length,
          hub: s.config.hub,
          // The image is the one detail that turns "scraper is down" into something
          // actionable for a sandbox; it is a local tag, not a credential.
          ...(s.config.kind === 'docker' ? { image: s.config.image, container: containerName(s.name) } : {})
        }
      ])
    );
    // Sleeping is the intended resting state of an on-demand server, not a
    // failure — reporting it as degraded would page the operator forever.
    const healthy = Object.values(servers).every(s => s.state === 'up' || s.state === 'sleeping');
    res.status(healthy ? 200 : 503).json({ status: healthy ? 'ok' : 'degraded', servers });
  };
}
