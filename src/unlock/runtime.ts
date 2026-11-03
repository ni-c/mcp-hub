import crypto from 'node:crypto';

// Open unlock requests and dashboard tickets, held in memory only.

export const REQUEST_TTL_MS = 10 * 60_000;
export const DENY_COOLDOWN_MS = 2 * 60_000;
export const TICKET_TTL_MS = 5 * 60_000;
const MAX_PENDING_PER_CLIENT = 5;
const MAX_PENDING_TOTAL = 50;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export interface UnlockRequestInput {
  server: string;
  clientId: string;
  grantId?: string;
  clientName?: string;
  /** `/hub` or the server's own path. */
  door: string;
  tool?: string;
  /** The canonical arguments, cut at the page's limit. */
  args?: string;
  /** False when `args` was cut. */
  argsComplete?: boolean;
  argsHash?: string;
}

export interface UnlockRequest extends UnlockRequestInput {
  id: string;
  code: string;
  createdAt: number;
  expiresAt: number;
  status: 'pending' | 'approved' | 'denied';
}

export type OpenRequestResult = { request: UnlockRequest; fresh: boolean } | { refused: 'denied'; request: UnlockRequest } | { refused: 'full' };

/** "ABC-DEF": six characters without the ones people mix up. */
export function matchingCode(): string {
  const chars = Array.from(crypto.randomBytes(6), byte => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('');
  return `${chars.slice(0, 3)}-${chars.slice(3)}`;
}

function sameAsk(request: UnlockRequest, input: UnlockRequestInput): boolean {
  return (
    request.server === input.server &&
    request.clientId === input.clientId &&
    request.grantId === input.grantId &&
    request.door === input.door &&
    request.tool === input.tool &&
    request.argsHash === input.argsHash
  );
}

export class UnlockRuntime {
  private readonly requests = new Map<string, UnlockRequest>();
  private readonly tickets = new Map<string, number>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Reuses an open ask; a fresh denial holds the same ask off. */
  open(input: UnlockRequestInput): OpenRequestResult {
    this.sweep();
    const now = this.now();
    for (const request of this.requests.values()) {
      if (!sameAsk(request, input)) continue;
      if (request.status === 'pending' && now < request.expiresAt) return { request, fresh: false };
      if (request.status === 'denied' && now < request.createdAt + REQUEST_TTL_MS + DENY_COOLDOWN_MS) return { refused: 'denied', request };
    }
    const pending = this.pending();
    if (pending.length >= MAX_PENDING_TOTAL || pending.filter(request => request.clientId === input.clientId).length >= MAX_PENDING_PER_CLIENT) {
      return { refused: 'full' };
    }
    const request: UnlockRequest = {
      ...input,
      id: crypto.randomBytes(32).toString('base64url'),
      code: matchingCode(),
      createdAt: now,
      expiresAt: now + REQUEST_TTL_MS,
      status: 'pending'
    };
    this.requests.set(request.id, request);
    return { request, fresh: true };
  }

  get(id: string): UnlockRequest | undefined {
    this.sweep();
    const request = this.requests.get(id);
    return request && this.now() < request.expiresAt ? request : undefined;
  }

  pending(): UnlockRequest[] {
    this.sweep();
    return [...this.requests.values()].filter(request => request.status === 'pending' && this.now() < request.expiresAt);
  }

  /** Only a pending request can be decided, and only once. */
  decide(id: string, status: 'approved' | 'denied'): UnlockRequest | undefined {
    const request = this.get(id);
    if (!request || request.status !== 'pending') return undefined;
    request.status = status;
    return request;
  }

  issueTicket(): string {
    this.sweep();
    const ticket = crypto.randomBytes(32).toString('base64url');
    this.tickets.set(ticketKey(ticket), this.now() + TICKET_TTL_MS);
    return ticket;
  }

  ticketValid(ticket: unknown): boolean {
    if (typeof ticket !== 'string' || ticket.length === 0) return false;
    const expiresAt = this.tickets.get(ticketKey(ticket));
    return expiresAt !== undefined && this.now() < expiresAt;
  }

  private sweep(): void {
    const now = this.now();
    for (const [id, request] of this.requests) {
      if (now >= request.expiresAt + DENY_COOLDOWN_MS) this.requests.delete(id);
    }
    for (const [key, expiresAt] of this.tickets) {
      if (now >= expiresAt) this.tickets.delete(key);
    }
  }
}

function ticketKey(ticket: string): string {
  return crypto.createHash('sha256').update(ticket).digest('base64url');
}
