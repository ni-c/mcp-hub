import express, { Router } from 'express';
import type { Request, Response } from 'express';

import type { OperatorFactors } from '../auth/factors.js';
import { authSecurityHeaders } from '../auth/headers.js';
import { earlyRateLimit } from '../auth/rate-limit.js';
import { sign, signatureMatches } from '../auth/signed-token.js';
import type { AuthStore } from '../auth/store.js';
import { logSafe } from '../auth/text.js';
import type { UnlockGate } from './gate.js';
import { renderDashboard, renderGrantList, renderOutcome, renderRequestPage, renderSignIn, durationLabel, untilLabel } from './pages.js';
import { defaultDuration, describeLock, durationChoices } from './policy.js';
import type { UnlockDuration, UnlockPolicy } from './policy.js';
import type { UnlockRequest } from './runtime.js';
import { REQUEST_TTL_MS } from './runtime.js';

export interface UnlockRoutesOptions {
  gate: UnlockGate;
  store: AuthStore;
  factors: OperatorFactors;
  secret: string;
  /** The current policy of a server, if it is still locked. */
  policyFor: (server: string) => UnlockPolicy | undefined;
  /** Every server that has `unlock`, for the dashboard. */
  lockedServers: () => string[];
  /** Told after a grant was made or ended. */
  poke?: () => void;
}

const asyncHandler =
  (handler: (req: Request, res: Response) => Promise<void> | void): express.RequestHandler =>
  (req, res, next) => {
    Promise.resolve(handler(req, res)).catch(next);
  };

const choicesFor = (request: UnlockRequest, policy: UnlockPolicy) => {
  const choices = durationChoices(policy, request.tool !== undefined && request.argsComplete !== false);
  return { choices, selected: defaultDuration(choices) };
};

const parseDuration = (raw: unknown, choices: readonly UnlockDuration[]): UnlockDuration | undefined => {
  const value: UnlockDuration | undefined = raw === 'once' ? 'once' : typeof raw === 'string' && /^\d{1,4}$/.test(raw) ? Number(raw) : undefined;
  return value !== undefined && choices.includes(value) ? value : undefined;
};

const describeGrant = (duration: UnlockDuration, now: number) =>
  duration === 'once' ? 'for this one call' : `for ${durationLabel(duration)}, until ${untilLabel(now + duration * 60_000)}`;

const notFound = (res: Response) =>
  res.status(404).type('html').send(renderOutcome('Link expired', 'This unlock link has expired or does not exist. Ask the model to call the tool again for a new one.'));

/** The unlock pages; no state changes on GET. */
export function createUnlockRoutes(options: UnlockRoutesOptions): Router {
  const { gate, store, factors, secret } = options;
  const runtime = gate.runtime;
  const router = Router();
  router.use(authSecurityHeaders);
  router.use(earlyRateLimit(15 * 60_000, 100, 500));
  const form = express.urlencoded({ extended: false, limit: '4kb' });
  const askForCode = { askForCode: factors.requiresCode };
  const csrfFor = (id: string) => sign(`unlock-request:${id}`, secret);
  const names = (clientId: string) => store.getApproval(clientId)?.clientName;



  const grantFor = (request: UnlockRequest, duration: UnlockDuration, now: number): string => {
    const base = { server: request.server, clientId: request.clientId, grantedAt: now, by: 'page' as const, ...(request.grantId !== undefined ? { grantId: request.grantId } : {}) };
    return duration === 'once'
      ? store.addUnlockGrant({ ...base, kind: 'once', tool: request.tool, argsHash: request.argsHash, expiresAt: now + REQUEST_TTL_MS })
      : store.addUnlockGrant({ ...base, kind: 'window', expiresAt: now + duration * 60_000 });
  };


  /** Sends the right answer for a verdict that was not ok; true when it answered. */
  const refused = (res: Response, verdict: ReturnType<OperatorFactors['verify']>, render: (error: string) => string): boolean => {
    if (verdict.outcome === 'ok') return false;
    if (verdict.outcome === 'paused') res.set('Retry-After', String(verdict.retryAfterSeconds));
    const [status, message] =
      verdict.outcome === 'disabled'
        ? [503, 'Unlocking is disabled: this hub has no usable operator sign-in.']
        : verdict.outcome === 'rate_limited'
          ? [429, 'Too many attempts. Try again later.']
          : verdict.outcome === 'paused'
            ? [429, `Too many attempts. Try again in ${verdict.retryAfterSeconds} seconds.`]
            : verdict.outcome === 'replayed_code'
              ? [401, 'This code was already used. Wait for the next one.']
              : [401, factors.requiresCode ? 'Wrong password or code' : 'Wrong password'];
    res.status(status).type('html').send(render(message));
    return true;
  };


  router.get(
    '/r/:id',
    asyncHandler((req, res) => {
      const request = runtime.get(String(req.params.id));
      if (!request) return void notFound(res);
      if (request.status !== 'pending') {
        return void res.type('html').send(renderOutcome(request.status === 'approved' ? 'Already unlocked' : 'Denied', `This request for "${request.server}" was already decided.`));
      }
      const policy = options.policyFor(request.server);
      if (!policy) return void res.status(410).type('html').send(renderOutcome('Not locked any more', `Server "${request.server}" is no longer locked.`));
      res
        .status(factors.enabled ? 200 : 503)
        .type('html')
        .send(
          renderRequestPage({
            request,
            lockDescription: describeLock(policy),
            ...choicesFor(request, policy),
            csrf: csrfFor(request.id),
            factors: askForCode,
            ...(factors.enabled ? {} : { error: 'Unlocking is disabled: this hub has no usable operator sign-in.' })
          })
        );
    })
  );

  router.post(
    '/r/:id',
    form,
    asyncHandler((req, res) => {
      const id = String(req.params.id);
      const request = runtime.get(id);
      if (!request) return void notFound(res);
      const body = req.body as Record<string, unknown>;
      if (typeof body.csrf !== 'string' || !signatureMatches(`unlock-request:${id}`, body.csrf, secret)) {
        return void res.status(403).type('html').send(renderOutcome('Form expired', 'This form is no longer valid. Open the link again.'));
      }
      if (request.status !== 'pending') return void res.type('html').send(renderOutcome('Already decided', `This request for "${request.server}" was already decided.`));
      if (body.action === 'deny') {
        runtime.decide(id, 'denied');
        console.log(`mcp-hub: [${request.server}] unlock request denied, code ${request.code}`);
        return void res.type('html').send(renderOutcome('Denied', `"${request.server}" stays locked. The model is told when it asks again.`));
      }
      const policy = options.policyFor(request.server);
      if (!policy) return void res.status(410).type('html').send(renderOutcome('Not locked any more', `Server "${request.server}" is no longer locked.`));
      const { choices, selected } = choicesFor(request, policy);
      const page = (error: string) =>
        renderRequestPage({ request, lockDescription: describeLock(policy), choices, selected, csrf: csrfFor(id), factors: askForCode, error });
      const duration = parseDuration(body.duration, choices);
      if (duration === undefined) return void res.status(400).type('html').send(page('Choose how long to unlock for.'));
      const verdict = factors.verify(req.ip ?? 'unknown', { password: body.password, code: body.code });
      if (refused(res, verdict, page)) return;
      if (!runtime.decide(id, 'approved')) return void res.type('html').send(renderOutcome('Already decided', 'This request was decided meanwhile.'));
      const now = Date.now();
      grantFor(request, duration, now);
      options.poke?.();
      console.log(`mcp-hub: [${request.server}] unlocked ${duration === 'once' ? 'for one call' : `for ${duration} minutes`}, code ${request.code}`);
      const ticket = runtime.issueTicket();
      res
        .type('html')
        .send(
          renderOutcome(
            'Unlocked',
            `"${request.server}" is unlocked ${describeGrant(duration, now)}. Go back to your chat and ask the model to try again.`,
            renderGrantList(store.unlockGrants(), ticket, names)
          )
        );
    })
  );

  const dashboard = (res: Response, ticket: string, notice?: string) => {
    const pending = runtime.pending().flatMap(request => {
      const policy = options.policyFor(request.server);
      return policy ? [{ request, ...choicesFor(request, policy) }] : [];
    });
    const lockable = options.lockedServers().flatMap(server => {
      const policy = options.policyFor(server);
      return policy ? [{ server, choices: durationChoices(policy, false) }] : [];
    });
    const clients = Object.entries(store.listApprovals()).map(([clientId, approval]) => ({ clientId, ...(approval.clientName ? { name: approval.clientName } : {}) }));
    res.type('html').send(renderDashboard({ ticket, pending, grants: store.unlockGrants(), names, lockable, clients, ...(notice ? { notice } : {}) }));
  };

  router.get('/', (_req, res) => {
    res.status(factors.enabled ? 200 : 503).type('html').send(renderSignIn(askForCode, factors.enabled ? undefined : 'Unlocking is disabled: this hub has no usable operator sign-in.'));
  });

  router.post(
    '/',
    form,
    asyncHandler((req, res) => {
      const body = req.body as Record<string, unknown>;
      const verdict = factors.verify(req.ip ?? 'unknown', { password: body.password, code: body.code });
      if (refused(res, verdict, error => renderSignIn(askForCode, error))) return;
      dashboard(res, runtime.issueTicket());
    })
  );

  /** Every dashboard action needs the ticket the sign-in issued. */
  const withTicket =
    (handler: (req: Request, res: Response, ticket: string) => void): express.RequestHandler =>
    (req, res) => {
      const ticket = (req.body as Record<string, unknown>).ticket;
      if (!runtime.ticketValid(ticket)) {
        res.status(401).type('html').send(renderSignIn(askForCode, 'Signed out after five minutes. Sign in again.'));
        return;
      }
      handler(req, res, ticket as string);
    };

  router.post(
    '/decide',
    form,
    withTicket((req, res, ticket) => {
      const body = req.body as Record<string, unknown>;
      const request = runtime.get(String(body.request ?? ''));
      const policy = request && options.policyFor(request.server);
      if (!request || !policy || request.status !== 'pending') return dashboard(res, ticket, 'That request is gone or was already decided.');
      if (body.action === 'deny') {
        runtime.decide(request.id, 'denied');
        console.log(`mcp-hub: [${request.server}] unlock request denied, code ${request.code}`);
        return dashboard(res, ticket, `Denied the request for "${request.server}".`);
      }
      const duration = parseDuration(body.duration, choicesFor(request, policy).choices);
      if (duration === undefined || !runtime.decide(request.id, 'approved')) return dashboard(res, ticket, 'Choose how long to unlock for.');
      const now = Date.now();
      grantFor(request, duration, now);
      options.poke?.();
      console.log(`mcp-hub: [${request.server}] unlocked ${duration === 'once' ? 'for one call' : `for ${duration} minutes`}, code ${request.code}`);
      dashboard(res, ticket, `"${request.server}" is unlocked ${describeGrant(duration, now)}.`);
    })
  );

  router.post(
    '/grant',
    form,
    withTicket((req, res, ticket) => {
      const body = req.body as Record<string, unknown>;
      const server = String(body.server ?? '');
      const clientId = String(body.client ?? '');
      const policy = options.policyFor(server);
      if (!policy || !store.getApproval(clientId)) return dashboard(res, ticket, 'Choose a locked server and an approved client.');
      const duration = parseDuration(body.duration, durationChoices(policy, false));
      if (duration === undefined || duration === 'once') return dashboard(res, ticket, `Choose a duration ${server} allows.`);
      const now = Date.now();
      store.addUnlockGrant({ server, clientId, kind: 'window', grantedAt: now, expiresAt: now + duration * 60_000, by: 'page' });
      options.poke?.();
      console.log(`mcp-hub: [${server}] unlocked ahead of a call for ${duration} minutes, for client ${logSafe(JSON.stringify(clientId))} and all its authorizations`);
      dashboard(res, ticket, `"${server}" is unlocked for every authorization of that client ${describeGrant(duration, now)}.`);
    })
  );

  router.post(
    '/lock',
    form,
    withTicket((req, res, ticket) => {
      const id = String((req.body as Record<string, unknown>).grant ?? '');
      const ended = id ? store.revokeUnlockGrants({ id }) : 0;
      if (ended > 0) {
        options.poke?.();
        console.log('mcp-hub: an unlock was ended early from the unlock page');
      }
      dashboard(res, ticket, ended > 0 ? 'Locked again.' : 'That unlock had already ended.');
    })
  );

  return router;
}
