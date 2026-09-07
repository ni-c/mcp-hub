import type { InputRequests } from '@modelcontextprotocol/server';

import { booleanEnv, jsonSize, positiveIntegerEnv } from './mcp-limits.js';
import { readSignedPayload, signPayload } from './auth/signed-token.js';

/**
 * Passing a child's question on to the person at the far end.
 *
 * On the 2026-07-28 revision an elicitation is a *result*, not a request: the
 * child answers `input_required`, the call ends, the person decides, and the
 * client retries carrying the answers. Nothing is held open and nothing is
 * remembered between the two legs — which is the only reason a stateless
 * gateway can carry this at all.
 *
 * What the hub has to add is everything that follows from the message crossing
 * a trust boundary. The text was written by a child server and is shown to a
 * human as if the hub were asking; the `requestState` goes out to a client and
 * comes back; and the number of rounds is a loop the hub cannot see the end of.
 */

/** Global off switch. Not per-server: an operator wants one thing to set. */
export const ELICITATION_ENABLED = booleanEnv('MCP_ELICITATION', true);

/**
 * How many times one call may come back for more input.
 *
 * The hub is stateless and cannot count rounds, so the count travels in the
 * sealed state below. Without a cap a child could ask forever, and each round
 * is a fresh tool call the caller pays for.
 */
export const MAX_ROUNDS = positiveIntegerEnv('MCP_ELICITATION_MAX_ROUNDS', 8);

/** How long a half-finished call may stay resumable. */
export const STATE_TTL_MS = positiveIntegerEnv('MCP_ELICITATION_STATE_TTL_MS', 15 * 60_000);

/** A prompt is read by a person. Anything longer is not a prompt. */
export const MAX_MESSAGE_BYTES = positiveIntegerEnv('MCP_ELICITATION_MAX_MESSAGE_BYTES', 4096);

/** The whole `inputRequests` map, schemas included. */
export const MAX_PAYLOAD_BYTES = positiveIntegerEnv('MCP_ELICITATION_MAX_PAYLOAD_BYTES', 128 * 1024);

/** The only embedded request kind the hub carries. See `sanitiseInputRequests`. */
const ELICIT_METHOD = 'elicitation/create';

/** Which endpoint a forwarded call arrived on. */
export type ForwardRoute = 'hub' | 'server';

/**
 * What the hub seals into `requestState` and expects back unchanged.
 *
 * The child's own state is carried inside rather than exposed: it is the
 * child's business, and handing it to the client unwrapped would let a client
 * resume a call against a different server by pasting it elsewhere.
 */
export interface ElicitationState {
  /** Which server asked. A state minted for one may not resume another. */
  server: string;
  /** Which tool asked, for the same reason. */
  tool: string;
  /** Which OAuth client the call belongs to. */
  clientId: string;
  /**
   * Which door the call came through — the `/hub` aggregate or the server's
   * own path. The same tool is reachable through both, and the two are
   * different calls to everyone involved: different downstream tool name,
   * different resource on the token. Binding it costs one field and makes the
   * seal exact instead of nearly exact.
   */
  via: ForwardRoute;
  /** Rounds already spent, so the cap survives statelessness. */
  round: number;
  /** Absolute expiry in epoch milliseconds. */
  expiresAt: number;
  /** The child's own `requestState`, opaque to the hub. */
  upstream?: string;
}

/**
 * Per-server switch. `"off"` withdraws this upstream's right to put words in
 * front of the user — a phishing judgement, separate from whether the server
 * works at all.
 */
export interface PassthroughConfig {
  passthrough?: 'auto' | 'off';
}

/** True unless an operator said otherwise, globally or for this server. */
export function passthroughAllowed(config: PassthroughConfig): boolean {
  return ELICITATION_ENABLED && config.passthrough !== 'off';
}

/** Which of the four conditions said no. In the order they are checked. */
export type PassthroughRefusal =
  /** An operator switched it off, globally or for this server. */
  | 'operator'
  /** The caller did not declare `elicitation` for this request. */
  | 'caller'
  /** The child is asleep, so it has negotiated no era to judge. */
  | 'child-asleep'
  /** The child speaks 2025, where an elicitation is a request and not a result. */
  | 'child-era';

export interface PassthroughInputs {
  /** Absent when the question is asked without naming a server. */
  config?: PassthroughConfig;
  /** `declared?.elicitation` from the request envelope; `undefined` means not declared. */
  declaredElicitation?: unknown;
  /** The era the child negotiated, or `undefined` while it sleeps. */
  childEra?: 'legacy' | 'modern';
}

export interface PassthroughDecision {
  forward: boolean;
  refusal?: PassthroughRefusal;
}

/**
 * The one place that decides whether a child's question may be carried out.
 *
 * `forwardToolCall` asks it to act on the answer; `describe_connection` asks it
 * to explain the answer. Two copies of this would drift, and the copy that
 * drifted would be the one telling a person why nothing was asked.
 *
 * Anything the caller leaves out is a refusal rather than an assumption: a
 * question asked without naming a server cannot know the server's switch, and
 * saying so is the only honest answer.
 */
export function decidePassthrough(inputs: PassthroughInputs): PassthroughDecision {
  if (!ELICITATION_ENABLED || inputs.config?.passthrough === 'off') return { forward: false, refusal: 'operator' };
  if (inputs.declaredElicitation === undefined) return { forward: false, refusal: 'caller' };
  if (inputs.childEra === undefined) return { forward: false, refusal: 'child-asleep' };
  if (inputs.childEra !== 'modern') return { forward: false, refusal: 'child-era' };
  return { forward: true };
}

/** One sentence per refusal, written for the person reading it, not for a log parser. */
export const REFUSAL_REASON: Record<PassthroughRefusal, string> = {
  operator: 'an operator switched pass-through off, globally or for this server',
  caller: 'the caller declared no elicitation capability for this request, so a question would have nowhere to go',
  'child-asleep': 'the server is asleep and has negotiated no protocol era yet',
  'child-era': 'the server speaks the 2025 revision, where an elicitation is a request the hub cannot hold open'
};

/** The binding a resumed call has to match, all of it, to be accepted. */
export interface StateBinding {
  server: string;
  tool: string;
  clientId: string;
  via: ForwardRoute;
}

export function sealRequestState(state: ElicitationState, secret: string): string {
  return signPayload(state, secret);
}

/**
 * Undefined for anything that was not sealed by this hub, has expired, is out
 * of rounds, or belongs to a different server, tool, client or route.
 *
 * All of them are the same kind of failure and get the same answer: the caller
 * learns the resume did not work, not which of its parts was wrong.
 */
export function openRequestState(token: string, secret: string, expected: StateBinding, now = Date.now()): ElicitationState | undefined {
  const state = readSignedPayload<ElicitationState>(token, secret);
  if (!state || typeof state !== 'object') return undefined;
  if (typeof state.round !== 'number' || typeof state.expiresAt !== 'number') return undefined;
  if (state.expiresAt <= now) return undefined;
  if (state.round >= MAX_ROUNDS) return undefined;
  if (
    state.server !== expected.server ||
    state.tool !== expected.tool ||
    state.clientId !== expected.clientId ||
    state.via !== expected.via
  ) {
    return undefined;
  }
  return state;
}

/**
 * Characters that let text lie about its own shape.
 *
 * Bidi overrides can visually reverse the attribution line, so `Server "x"
 * asks:` renders as something else entirely; zero-width characters hide
 * content from a reader that a model still sees; control characters forge
 * lines in anything that logs this. None of them belong in a sentence shown to
 * a person. Newline and tab survive — a prompt may legitimately have them.
 */
// eslint-disable-next-line no-control-regex -- matching them is the point
const UNSAFE_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​-‏‪-‮⁠⁦-⁩﻿]/g;

export function sanitiseText(text: string): string {
  return text.replace(UNSAFE_TEXT, '');
}

/** The marker costs three bytes, not one — reserving one was an off-by-two the
 *  byte-budget test caught. */
const ELLIPSIS = '…';
const ELLIPSIS_BYTES = Buffer.byteLength(ELLIPSIS, 'utf8');

/** Truncates on a byte budget, not a character count — the cap is about size. */
function clampBytes(text: string, max: number): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= max) return text;
  const cut = bytes.subarray(0, Math.max(0, max - ELLIPSIS_BYTES)).toString('utf8');
  // Cutting between the bytes of one character yields U+FFFD; drop it rather
  // than show a replacement glyph in a sentence meant for a person.
  return `${cut.endsWith('�') ? cut.slice(0, -1) : cut}${ELLIPSIS}`;
}

export interface SanitisedRequests {
  requests: InputRequests;
  /** Keys removed, so the caller can say so rather than silently shrinking. */
  dropped: string[];
}

/**
 * What the hub is willing to forward from a child's `inputRequests`.
 *
 * Three things happen here, and each is a refusal rather than a repair:
 *
 * - **Only elicitations.** An embedded `sampling/createMessage` would spend the
 *   caller's model budget on a child's prompt, and `roots/list` would hand a
 *   child the client's workspace layout. Neither is something the hub should
 *   relay on a child's say-so; both are dropped and named.
 * - **No `_meta`.** A progress token or a related-task id belongs to the
 *   child's own id space. Forwarded downstream it would collide with the
 *   client's, and the client would be right to be confused.
 * - **Attribution the child cannot forge.** The message is prefixed by the hub
 *   with the server's name, after the text has been stripped of anything that
 *   could visually undo that prefix.
 */
export function sanitiseInputRequests(requests: InputRequests | undefined, serverName: string): SanitisedRequests {
  // Null prototype: the keys are the child's, and `out['__proto__'] = …` on an
  // ordinary object would swap the prototype for the child's request instead
  // of forwarding it — silently, with `Object.keys` none the wiser.
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const dropped: string[] = [];
  const safeName = sanitiseText(serverName);

  for (const [key, request] of Object.entries(requests ?? {})) {
    const method = (request as { method?: unknown }).method;
    if (method !== ELICIT_METHOD) {
      dropped.push(key);
      continue;
    }
    const params = { ...(request as { params?: Record<string, unknown> }).params };
    delete params._meta;

    // A URL-mode elicitation asks the client to open a page. The hub vouches
    // for the attribution line above it, so the page it points at has to be
    // one a browser reaches over TLS — not `javascript:`, not a plain-http
    // host on the way, and not a scheme the client's platform hands to some
    // other program. Refused as a whole rather than repaired: a question
    // without its page is not the question that was asked.
    if (params.mode === 'url' && !isHttpsUrl(params.url)) {
      dropped.push(key);
      continue;
    }

    const message = typeof params.message === 'string' ? params.message : '';
    params.message = clampBytes(`Server "${safeName}" asks:\n\n${sanitiseText(message)}`, MAX_MESSAGE_BYTES);

    out[key] = { method: ELICIT_METHOD, params };
  }

  // Handed on as an ordinary object: the SDK serialises it, and nothing beyond
  // this function should have to know about the prototype.
  return { requests: { ...out } as InputRequests, dropped };
}

function isHttpsUrl(value: unknown): boolean {
  if (typeof value !== 'string' || value.length > 8192) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** True when the whole map is small enough to be worth forwarding at all. */
export function withinPayloadBudget(requests: InputRequests): boolean {
  return jsonSize(requests) <= MAX_PAYLOAD_BYTES;
}
