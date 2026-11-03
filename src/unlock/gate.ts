import { CLIENT_CAPABILITIES_META_KEY, ProtocolError, ProtocolErrorCode, inputRequired } from '@modelcontextprotocol/server';
import type { AuthInfo, CallToolResult, ClientCapabilities, InputRequiredResult, ServerContext } from '@modelcontextprotocol/server';

import { AuthStore } from '../auth/store.js';
import type { UnlockGrant } from '../auth/store.js';
import { openRequestState, UNLOCK_INPUT_KEY, type ForwardRoute } from '../elicitation.js';
import type { ManagedServer } from '../supervisor.js';
import { ARGS_DISPLAY_LIMIT, argsHash, canonicalArgs, fitsOnPage } from './args.js';
import { describeLock, locksTool, locksWholeServer } from './policy.js';
import type { UnlockRequest } from './runtime.js';
import { UnlockRuntime } from './runtime.js';

export { UNLOCK_INPUT_KEY } from '../elicitation.js';

export interface Caller {
  clientId: string;
  /** The authorization the token belongs to; absent for admin API tokens. */
  grantId?: string;
}

export function callerFromAuth(auth: AuthInfo | undefined): Caller {
  const grantId = auth?.extra?.grantId;
  return { clientId: auth?.clientId ?? '', ...(typeof grantId === 'string' ? { grantId } : {}) };
}

export function callerOf(ctx: ServerContext): Caller {
  return callerFromAuth(ctx.http?.authInfo);
}

export type GateVerdict = { admit: true } | { admit: false; answer: CallToolResult | InputRequiredResult };

export interface UnlockGateOptions {
  store: AuthStore;
  runtime: UnlockRuntime;
  externalUrl: string;
  /** False when no page can unlock anything: the operator factors are unusable. */
  canUnlock: () => boolean;
  /** Seals the hub's resume state. */
  secret: string;
  clientName?: (clientId: string) => string | undefined;
  /** Told when a grant was spent or ended, so expiry handling can look again. */
  poke?: () => void;
}

const locked = (text: string): CallToolResult => ({ isError: true, content: [{ type: 'text', text }] });

/** Whether this request declared URL-mode elicitation. */
export function declaresUrlElicitation(ctx: ServerContext): boolean {
  const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
  const elicitation = (envelope?.[CLIENT_CAPABILITIES_META_KEY] as ClientCapabilities | undefined)?.elicitation as Record<string, unknown> | undefined;
  return typeof elicitation === 'object' && elicitation !== null && elicitation.url !== undefined;
}

/** Decides per call whether a locked tool may run; failures count as locked. */
export class UnlockGate {
  constructor(private readonly options: UnlockGateOptions) {}

  get runtime(): UnlockRuntime {
    return this.options.runtime;
  }

  link(request: UnlockRequest): string {
    return new URL(`/unlock/r/${request.id}`, this.options.externalUrl).href;
  }

  overviewLink(): string {
    return new URL('/unlock', this.options.externalUrl).href;
  }

  /** The live window this caller holds on this server, or undefined. */
  windowFor(server: string, caller: Caller, now = Date.now()): UnlockGrant | undefined {
    if (!caller.clientId) return undefined;
    return this.options.store
      .unlockGrants(now)
      .filter(grant => grant.kind === 'window' && AuthStore.grantMatches(grant, { server, ...caller }))
      .toSorted((a, b) => b.expiresAt - a.expiresAt)[0];
  }

  /** Whether everything this server serves is open to the caller. */
  openForEverything(managed: ManagedServer, caller: Caller): boolean {
    try {
      return !locksWholeServer(managed.config.unlock) || this.windowFor(managed.name, caller) !== undefined;
    } catch {
      return false;
    }
  }

  /** Refuses resources and prompts of a whole-locked server. */
  assertOpen(managed: ManagedServer, ctx: ServerContext): void {
    if (this.openForEverything(managed, callerOf(ctx))) return;
    throw new ProtocolError(
      ProtocolErrorCode.InvalidRequest,
      `Server "${managed.name}" is locked. Call one of its tools to get an unlock link, or open ${this.overviewLink()}.`
    );
  }

  /** Ends the caller's own unlocks of a server. */
  endUnlocks(server: string, caller: Caller): number {
    const ended = this.options.store.revokeUnlockGrants({ server, clientId: caller.clientId, ...(caller.grantId !== undefined ? { grantId: caller.grantId } : {}) });
    if (ended > 0) {
      console.log(`mcp-hub: [${server}] ${ended} unlock(s) ended by the client that held them`);
      this.options.poke?.();
    }
    return ended;
  }

  /** An ask without a call, for request_unlock. */
  requestAhead(managed: ManagedServer, ctx: ServerContext): { status: 'pending' | 'denied'; request?: UnlockRequest; message: string } {
    const caller = callerOf(ctx);
    if (!caller.clientId) return { status: 'denied', message: 'This connection cannot unlock anything.' };
    if (!this.options.canUnlock()) return { status: 'denied', message: 'This hub has no usable operator sign-in, so nothing can be unlocked from a page.' };
    const opened = this.options.runtime.open({
      server: managed.name,
      clientId: caller.clientId,
      ...(caller.grantId !== undefined ? { grantId: caller.grantId } : {}),
      ...(this.options.clientName?.(caller.clientId) !== undefined ? { clientName: this.options.clientName(caller.clientId) } : {}),
      door: '/hub'
    });
    if ('refused' in opened) {
      return opened.refused === 'denied'
        ? { status: 'denied', request: opened.request, message: 'The user denied this a moment ago. Do not ask again yet.' }
        : { status: 'denied', message: `Too many unlock requests are open. Ask the user to unlock it at ${this.overviewLink()}.` };
    }
    if (opened.fresh) console.log(`mcp-hub: [${managed.name}] unlock requested ahead of a call by client ${JSON.stringify(caller.clientId)}, code ${opened.request.code}`);
    return {
      status: 'pending',
      request: opened.request,
      message: `Ask the user to open the link and unlock "${managed.name}", then call its tools. The page shows the code ${opened.request.code}.`
    };
  }

  checkToolCall(input: { managed: ManagedServer; ctx: ServerContext; via: ForwardRoute; door: string; tool: string; args: unknown }): GateVerdict {
    try {
      return this.decide(input);
    } catch (error) {
      console.error(`mcp-hub: [${input.managed.name}] unlock check failed, refusing the call: ${(error as Error).message}`);
      return { admit: false, answer: locked(`Server "${input.managed.name}" is locked, and the hub could not check its unlocks. Try again later.`) };
    }
  }

  private decide({ managed, ctx, via, door, tool, args }: { managed: ManagedServer; ctx: ServerContext; via: ForwardRoute; door: string; tool: string; args: unknown }): GateVerdict {
    const policy = managed.config.unlock;
    if (!locksTool(policy, tool)) return { admit: true };
    const server = managed.name;
    const caller = callerOf(ctx);
    if (!caller.clientId) return { admit: false, answer: locked(`Server "${server}" is locked, and this connection cannot unlock it.`) };
    if (this.windowFor(server, caller)) return { admit: true };

    const presented = ctx.mcpReq.requestState<string>();
    if (typeof presented === 'string' && presented.length > 0 && openRequestState(presented, this.options.secret, { server, tool, clientId: caller.clientId, via })) {
      return { admit: true };
    }

    const canonical = canonicalArgs(args);
    const hash = argsHash(canonical);
    if (this.options.store.takeOnceGrant({ server, ...caller, tool, argsHash: hash })) {
      console.log(`mcp-hub: [${server}] single-call unlock spent for client ${JSON.stringify(caller.clientId)}`);
      this.options.poke?.();
      return { admit: true };
    }

    const response = (ctx.mcpReq.inputResponses as Record<string, { action?: string } | undefined> | undefined)?.[UNLOCK_INPUT_KEY];
    if (response?.action === 'decline' || response?.action === 'cancel') {
      return { admit: false, answer: locked(`The user declined to unlock server "${server}". Do not ask again right away.`) };
    }

    if (!this.options.canUnlock()) {
      return {
        admit: false,
        answer: locked(
          `Server "${server}" is locked, and this hub has no usable operator sign-in to unlock it from a page. ` +
            `The operator can grant access on the host with: mcp-hub-admin unlock grant ${server} <minutes> --client ${caller.clientId}`
        )
      };
    }

    const opened = this.options.runtime.open({
      server,
      clientId: caller.clientId,
      ...(caller.grantId !== undefined ? { grantId: caller.grantId } : {}),
      ...(this.options.clientName?.(caller.clientId) !== undefined ? { clientName: this.options.clientName(caller.clientId) } : {}),
      door,
      tool,
      args: fitsOnPage(canonical) ? canonical : canonical.slice(0, ARGS_DISPLAY_LIMIT),
      argsComplete: fitsOnPage(canonical),
      argsHash: hash
    });
    if ('refused' in opened) {
      return {
        admit: false,
        answer: locked(
          opened.refused === 'denied'
            ? `The user denied unlocking server "${server}" for this call. Do not ask again for the next two minutes.`
            : `Server "${server}" is locked, and too many unlock requests are open already. Ask the user to unlock it at ${this.overviewLink()}.`
        )
      };
    }
    const { request, fresh } = opened;
    if (fresh) console.log(`mcp-hub: [${server}] unlock requested for ${describeLock(policy!)} by client ${JSON.stringify(caller.clientId)}, code ${request.code}`);
    const text =
      `Server "${server}" is locked: "${tool}" needs a person to unlock it first. ` +
      `Ask the user to open this link and unlock it, then call the tool again:\n${this.link(request)}\n` +
      `The page shows the matching code ${request.code}.`;
    if (!fresh || !declaresUrlElicitation(ctx)) return { admit: false, answer: locked(text) };
    const host = new URL(this.options.externalUrl).host;
    return {
      admit: false,
      answer: inputRequired({
        inputRequests: {
          [UNLOCK_INPUT_KEY]: inputRequired.elicitUrl({
            url: this.link(request),
            message: `mcp-hub at ${host} asks you to unlock server "${server}" before "${tool}" runs. The page shows the code ${request.code}.`
          })
        }
      })
    };
  }
}
