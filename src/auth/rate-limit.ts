import net from 'node:net';

import type express from 'express';

/**
 * The unit a budget is counted against.
 *
 * Not the address. One IPv6 address is not one caller: the smallest block
 * handed to a single subscriber is a /64, and a residential line usually gets a
 * /56 or /48 on top of that. A limiter keyed on the full address therefore
 * counts a single host as billions of distinct callers, and every per-address
 * budget in this file becomes decorative — a /64 walks around all of them
 * without any infrastructure at all.
 *
 * IPv4 keeps its own address, where one address really is roughly one caller,
 * and an IPv4-mapped form (`::ffff:1.2.3.4`, what a dual-stack listener reports
 * for an IPv4 peer) is folded back onto it so the same client is not counted in
 * two places depending on how the socket was opened.
 *
 * Only the KEY is bucketed. Log lines keep the full address — fail2ban bans
 * what it is given, and it should be given the host that actually connected.
 */
export function rateLimitKey(ip: string): string {
  const bare = ip.replace(/^\[|\]$/g, '').split('%')[0];
  if (net.isIPv4(bare)) return bare;
  if (!net.isIPv6(bare)) return ip; // 'unknown', or something we cannot parse
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(bare);
  if (mapped) return mapped[1];
  return `${expandIPv6(bare).slice(0, 4).join(':')}::/64`;
}

/** The eight hextets of an IPv6 address, with `::` filled back in. */
function expandIPv6(address: string): string[] {
  const [head, tail] = address.toLowerCase().split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const missing = 8 - left.length - right.length;
  const groups = [...left, ...Array.from({ length: Math.max(0, missing) }, () => '0'), ...right];
  // Leading zeros are not part of the value; without this `2001:0db8:…` and
  // `2001:db8:…` would be two different keys for one network.
  return groups.map(group => (Number.parseInt(group, 16) || 0).toString(16));
}

/**
 * A per-caller request budget that rejects before any body is read.
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
    const ip = rateLimitKey(req.ip ?? 'unknown');
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
 * Per-caller lockout for the password form.
 *
 * Separate from `earlyRateLimit` because it counts FAILURES, not requests: a
 * correct login resets the counter, so someone who knows the password is never
 * locked out by someone else guessing from the same address.
 */
export class LoginRateLimiter {
  private readonly attempts = new Map<string, { count: number; resetAt: number }>();
  private total = { count: 0, resetAt: 0 };

  /**
   * Whether this caller has spent its budget.
   *
   * The global ceiling refuses the callers that are doing the guessing, and
   * only those. It used to refuse everyone, which turned an attacker's cheapest
   * possible traffic into a lockout of the only administrative way in: a
   * hundred wrong passwords — under a second of work, and renewable every
   * fifteen minutes — left the operator holding the correct password and
   * getting 429 from an address that had never been near the form.
   *
   * What the ceiling is for survives the change. A caller that guesses is
   * counted, and once the hub as a whole is under a distributed attempt that
   * caller is refused on its FIRST failure instead of its tenth — so the total
   * number of guesses still collapses, and it collapses hardest for exactly the
   * addresses doing the guessing. What no longer happens is that they can spend
   * somebody else's budget. Repeated failures remain a fail2ban matter; that is
   * what the log line exists for.
   */
  isBlocked(ip: string): boolean {
    const key = rateLimitKey(ip);
    const entry = this.attempts.get(key);
    const live = entry && entry.resetAt >= Date.now() ? entry : undefined;
    if (this.total.resetAt > Date.now() && this.total.count >= LOGIN_MAX_ATTEMPTS_TOTAL && live !== undefined) return true;
    return (live?.count ?? 0) >= LOGIN_MAX_ATTEMPTS;
  }

  recordFailure(ip: string): void {
    this.sweepExpired(); // entries are otherwise only dropped on a successful login from that exact caller
    const now = Date.now();
    // Behind a reverse proxy req.ip is the proxy for every request, and a
    // spoofable X-Forwarded-For makes the per-caller counter meaningless — this
    // caps the total either way.
    if (this.total.resetAt < now) this.total = { count: 1, resetAt: now + LOGIN_WINDOW_MS };
    else this.total.count++;
    const key = rateLimitKey(ip);
    const entry = this.attempts.get(key);
    if (!entry || entry.resetAt < now) {
      this.attempts.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
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
    this.attempts.delete(rateLimitKey(ip));
    this.total = { count: 0, resetAt: 0 };
  }
}
