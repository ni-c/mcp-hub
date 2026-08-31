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

const LOGIN_MAX_ATTEMPTS = 10;
const LOGIN_WINDOW_MS = 15 * 60_000;
/** A global ceiling as well, so a distributed guess cannot spend the per-address
 *  budget many times over. */
const LOGIN_MAX_ATTEMPTS_TOTAL = 100;

/**
 * Per-address lockout for the password form.
 *
 * Separate from `earlyRateLimit` because it counts FAILURES, not requests: a
 * correct login resets the counter, so someone who knows the password is never
 * locked out by someone else guessing from the same address.
 */
export class LoginRateLimiter {
  private readonly attempts = new Map<string, { count: number; resetAt: number }>();
  private total = { count: 0, resetAt: 0 };

  isBlocked(ip: string): boolean {
    if (this.total.resetAt > Date.now() && this.total.count >= LOGIN_MAX_ATTEMPTS_TOTAL) return true;
    const entry = this.attempts.get(ip);
    if (!entry || entry.resetAt < Date.now()) return false;
    return entry.count >= LOGIN_MAX_ATTEMPTS;
  }

  recordFailure(ip: string): void {
    this.sweepExpired(); // entries are otherwise only dropped on a successful login from that exact IP
    const now = Date.now();
    // Behind a reverse proxy req.ip is the proxy for every request, and a
    // spoofable X-Forwarded-For makes the per-IP counter meaningless — this
    // caps the total either way.
    if (this.total.resetAt < now) this.total = { count: 1, resetAt: now + LOGIN_WINDOW_MS };
    else this.total.count++;
    const entry = this.attempts.get(ip);
    if (!entry || entry.resetAt < now) {
      this.attempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    } else {
      entry.count++;
    }
  }

  private sweepExpired(): void {
    const now = Date.now();
    for (const [ip, entry] of this.attempts) {
      if (entry.resetAt < now) this.attempts.delete(ip);
    }
  }

  reset(ip: string): void {
    this.attempts.delete(ip);
    this.total = { count: 0, resetAt: 0 };
  }
}
