import { ProtocolError, ProtocolErrorCode, isInputRequiredResult, CLIENT_CAPABILITIES_META_KEY } from '@modelcontextprotocol/server';
import type { CallToolResult, ClientCapabilities, InputRequiredResult, ServerContext } from '@modelcontextprotocol/server';
import { CallToolResultSchema } from '@modelcontextprotocol/core';
import { withInputRequired } from '@modelcontextprotocol/client';

import type { ManagedServer } from './supervisor.js';
import { ABSOLUTE_CALL_OPTIONS, assertForwardedResultSize } from './mcp-limits.js';
import { loggableToolName } from './tool-filter.js';
import { locksTool } from './unlock/policy.js';
import {
  REFUSAL_REASON,
  STATE_TTL_MS,
  UNLOCK_INPUT_KEY,
  decidePassthrough,
  openRequestState,
  sanitiseInputRequests,
  sanitiseText,
  sealRequestState,
  withinPayloadBudget,
  type ForwardRoute,
  type PassthroughRefusal
} from './elicitation.js';

/**
 * One forwarded tool call, for both doors that lead to a child.
 *
 * There are two: `/<name>/mcp` forwards `tools/call` verbatim, and the `/hub`
 * aggregate's `call_tool` forwards on the caller's behalf by name. They used to
 * implement the same sequence — wake, mark used, forward, check the size — in
 * two different orders, which was survivable while it was four steps. Carrying
 * a question through adds four more, each of them a refusal that has to be
 * identical on both paths or it is not a rule. So there is one copy.
 */

/**
 * Says once, per client and server and reason, that a question was not carried.
 *
 * Once, because the alternative is a line per tool call: a connector that
 * cannot be asked calls all day and the answer never changes. The interesting
 * event is the first one, and a log that repeats it is a log nobody reads.
 *
 * The set is capped for the reason the 2026-08-11 audit found twice already —
 * an auth-code map and a rate limiter that grew without one. Past the cap it
 * stops remembering rather than stops logging: repeated lines are noise, a
 * container that runs out of memory is an outage.
 */
const REFUSALS_LOGGED = new Set<string>();
const MAX_REFUSALS_REMEMBERED = 500;

/** The answers meant for the child, without the hub's own unlock answer. */
function childResponses(responses: Record<string, unknown> | undefined): { inputResponses: Record<string, unknown> } | undefined {
  if (!responses) return undefined;
  const rest = Object.fromEntries(Object.entries(responses).filter(([key]) => key !== UNLOCK_INPUT_KEY));
  return Object.keys(rest).length > 0 ? { inputResponses: rest } : undefined;
}

export function noteRefusal(server: string, clientId: string, refusal: PassthroughRefusal): void {
  // The client id comes from open dynamic registration, so it is a stranger's
  // text on its way into a file that LOG_FILE mirrors and fail2ban reads. Same
  // treatment as a child's prompt text: strip what could forge a line.
  const safeClient = sanitiseText(clientId) || '(anonymous)';
  const key = `${server}\u0000${safeClient}\u0000${refusal}`;
  if (REFUSALS_LOGGED.has(key)) return;
  if (REFUSALS_LOGGED.size < MAX_REFUSALS_REMEMBERED) REFUSALS_LOGGED.add(key);
  console.warn(`mcp-hub: [${server}] elicitation not forwarded for client "${safeClient}" — ${REFUSAL_REASON[refusal]}`);
}

/** Test seam: the set outlives a single test otherwise, and silence would pass. */
export function forgetRefusalsForTests(): void {
  REFUSALS_LOGGED.clear();
}

export interface ForwardToolCall {
  managed: ManagedServer;
  /** The tool as the child knows it, already checked against the filter. */
  tool: string;
  /**
   * What to send as `params`, `name` included. The per-server path passes the
   * caller's own params through untouched — a gateway that rewrote them would
   * be inventing a contract the child never agreed to.
   */
  params: Record<string, unknown>;
  ctx: ServerContext;
  /** Signs the request state. `AuthStore.cookieSecret` behind HTTP. */
  secret: string;
  via: ForwardRoute;
  /** Set once the unlock gate admitted this call. */
  admitted?: boolean;
}

/**
 * Forwards one call, carrying a question back to the person at the far end when
 * there is one and the whole chain can actually deliver it.
 *
 * Pass-through happens only when four things hold at once, and each is a
 * separate refusal rather than a best effort:
 *
 * 1. the operator has not switched it off, globally or for this server;
 * 2. the **downstream** client declared `elicitation` in this request's
 *    envelope — which only exists on the 2026 era, so this also rules out a
 *    2025 client the hub could never push to;
 * 3. the **upstream** child negotiated the modern era, so its answer can be a
 *    result rather than a request the hub has nowhere to put;
 * 4. the child actually asked something.
 *
 * The capability is mirrored from what the client declared for *this* request
 * and never widened. That is what keeps the announcement honest: it says only
 * "the caller of this one call can answer you", for a call whose answer has
 * somewhere to go.
 */
export async function forwardToolCall({
  managed,
  tool,
  params,
  ctx,
  secret,
  via,
  admitted
}: ForwardToolCall): Promise<CallToolResult | InputRequiredResult> {
  if (!admitted && locksTool(managed.config.unlock, tool)) throw new Error(`Server "${managed.name}" is locked`);
  // Before condition 3 is even readable: the era is negotiated by the child's
  // client, and an on-demand child that is asleep has none. Waking after the
  // decision made the first call following a nap take the fallback and the
  // second one succeed — the worst shape a security guarantee can have.
  if (managed.state !== 'up' || !managed.client) await managed.wake();
  managed.markUsed();

  const client = managed.client;
  if (!client) throw new Error(`Server "${managed.name}" is not running`);

  const send = async <S extends Parameters<typeof client.request>[1]>(
    body: Record<string, unknown>,
    resultSchema: S,
    options: Partial<Parameters<typeof client.request>[2]> = {}
  ): Promise<unknown> =>
    managed.track(
      client
        .request({ method: 'tools/call', params: body } as Parameters<typeof client.request>[0], resultSchema, {
          ...ABSOLUTE_CALL_OPTIONS,
          ...options
        })
        .then(assertForwardedResultSize)
    );

  // `RequestMetaEnvelope` is published as `{}`, so the reserved keys cannot be
  // reached through it by name. The constant is the SDK's own, and the value it
  // holds is whatever the client sent — untrusted either way, and only ever
  // read for the one field below.
  const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
  const declared = envelope?.[CLIENT_CAPABILITIES_META_KEY] as ClientCapabilities | undefined;
  const declaredElicitation = declared?.elicitation;
  const decision = decidePassthrough({
    config: managed.config,
    declaredElicitation,
    childEra: client.getProtocolEra()
  });

  // The second half says what `decidePassthrough` has already refused, and is
  // here so the compiler can see it too: the capability is mirrored to the
  // child below, and a rule that lives behind a function call narrows nothing.
  if (!decision.forward || declaredElicitation === undefined) {
    // Said once per client, server and reason. Without it the only trace of a
    // connector that can never be asked is the fallback text inside a tool
    // result — visible to whoever made that one call, and to nobody else.
    if (decision.refusal) noteRefusal(managed.name, ctx.http?.authInfo?.clientId ?? '', decision.refusal);
    return (await send(params, CallToolResultSchema)) as CallToolResult;
  }

  const binding = { server: managed.name, tool, clientId: ctx.http?.authInfo?.clientId ?? '', via };

  // A resume carries the state the hub sealed on the previous round. Anything
  // that does not open is refused as a whole — expired, out of rounds, forged,
  // or minted for another call all get the same answer, because telling them
  // apart would say more than the caller is owed.
  let round = 0;
  let upstreamState: string | undefined;
  const presented = ctx.mcpReq.requestState<string>();
  if (typeof presented === 'string' && presented.length > 0) {
    const opened = openRequestState(presented, secret, binding);
    if (!opened) {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'This call cannot be resumed. Start it again.');
    }
    round = opened.round + 1;
    upstreamState = opened.upstream;
  }

  const body: Record<string, unknown> = {
    ...params,
    _meta: {
      ...(params._meta as Record<string, unknown> | undefined),
      // Spread last on the client side, so this wins over the envelope the
      // hub's own connection would otherwise attach.
      [CLIENT_CAPABILITIES_META_KEY]: { elicitation: declaredElicitation }
    },
    ...childResponses(ctx.mcpReq.inputResponses),
    ...(upstreamState !== undefined ? { requestState: upstreamState } : {})
  };

  // Without `allowInputRequired` the hub's own client refuses the answer
  // rather than handing it over — `autoFulfill: false` makes an unhandled
  // `input_required` a typed error, which is exactly the shape a gateway needs
  // to opt out of, per call.
  const result = (await send(body, withInputRequired(CallToolResultSchema), { allowInputRequired: true })) as
    | CallToolResult
    | InputRequiredResult;

  if (!isInputRequiredResult(result)) return result;

  const { requests, dropped } = sanitiseInputRequests(result.inputRequests, managed.name);
  if (dropped.length > 0) {
    console.warn(`[${managed.name}] dropped ${dropped.length} non-elicitation input request(s) from ${loggableToolName(tool)}`);
  }
  if (Object.keys(requests).length === 0 || !withinPayloadBudget(requests)) {
    // Nothing left to ask, or too much to be a prompt. Either way the call
    // cannot continue, and saying so beats returning a question with no
    // content or one the client would choke on.
    return {
      isError: true,
      content: [{ type: 'text', text: `Server "${managed.name}" asked for input the hub will not forward.` }]
    };
  }

  return {
    resultType: 'input_required',
    inputRequests: requests,
    requestState: sealRequestState(
      {
        ...binding,
        round,
        expiresAt: Date.now() + STATE_TTL_MS,
        ...(result.requestState !== undefined ? { upstream: result.requestState } : {})
      },
      secret
    )
  };
}
