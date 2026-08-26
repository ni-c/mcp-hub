import type { Request, Response } from 'express';
import type { Supervisor } from './supervisor.js';
import { containerName } from './sandbox/container-spec.js';
import { hasToolFilter } from './tool-filter.js';

/**
 * The detailed fleet view, and therefore an authenticated one: it names every
 * configured server, its state and its sandbox image, which together describe
 * the deployment. It is mounted behind bearer auth and bound to the `hub`
 * resource, so a token issued for one server cannot enumerate the others.
 * Docker's HEALTHCHECK uses `/livez` instead, which carries no topology at all.
 *
 * `lastError` is deliberately left out even here: it carries upstream URLs and
 * spawn paths, and stays in the container log.
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
          // Only present when a filter is configured, so every other server's
          // entry keeps its shape. `tools` keeps its meaning: what a client sees.
          // `hidden` and `unmatched` join it only once the server has really
          // listed its tools — a snapshot from tool-cache.json is already
          // filtered, so there is nothing honest to say about them yet.
          ...(hasToolFilter(s.config)
            ? {
                toolFilter: {
                  exposed: s.tools.length,
                  ...(s.toolsHidden !== undefined ? { hidden: s.toolsHidden, unmatched: s.filterUnmatched } : {})
                }
              }
            : {}),
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
