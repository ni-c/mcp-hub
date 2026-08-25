import type express from 'express';

/**
 * A per-IP request budget that rejects before any body is read.
 *
 * The SDK applies its own limits to the OAuth endpoints, but only after body
 * parsing — which is the expensive part. This runs first, and refuses without
 * inserting the offending address into its own table, so a flood of distinct
 * source addresses cannot grow the map that is supposed to be bounding it.
 */
export function earlyRateLimit(windowMs: number, maxPerIp: number, maxTotal: number) {
  const byIp = new Map<string, { count: number; resetAt: number }>();
  let total = { count: 0, resetAt: 0 };
  return (req: express.Request, res: express.Response, next: express.NextFunction): void => {
    const now = Date.now();
    if (total.resetAt <= now) total = { count: 0, resetAt: now + windowMs };
    const ip = req.ip ?? 'unknown';
    let entry = byIp.get(ip);
    if (entry && entry.resetAt <= now) {
      byIp.delete(ip);
      entry = undefined;
    }
    // Reject before inserting anything: a flood of distinct rejected IPs must
    // not grow the map. Accepted requests bound it at maxTotal per window.
    if ((entry?.count ?? 0) >= maxPerIp || total.count >= maxTotal) {
      res.set('Retry-After', String(Math.max(1, Math.ceil((Math.min(entry?.resetAt ?? Infinity, total.resetAt) - now) / 1000))));
      res.status(429).json({ error: 'too_many_requests', error_description: 'Request rate limit exceeded' });
      return;
    }
    if (!entry) {
      if (byIp.size >= maxTotal) {
        for (const [candidateIp, candidate] of byIp) if (candidate.resetAt <= now) byIp.delete(candidateIp);
      }
      entry = { count: 0, resetAt: now + windowMs };
      byIp.set(ip, entry);
    }
    entry.count++;
    total.count++;
    next();
  };
}
