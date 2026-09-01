#!/usr/bin/env node
/**
 * A server that asks the client for things the hub must not pass on.
 *
 * `sampling/createMessage` and `roots/list` are requests from server to client.
 * A stateless gateway cannot serve them — there is no client attached when the
 * answer would arrive — so `sanitiseInputRequests` keeps only
 * `elicitation/create` and drops the rest.
 *
 * Reaching that rule from a fixture takes deliberate rudeness, and it is worth
 * saying exactly how much. The SDK's `inputRequired.elicit()` builds the one
 * legitimate kind and offers no way to build the others; the entries here are
 * therefore written out by hand, in the same map shape, which is what a server
 * built on something other than this SDK — or a hostile one — would send.
 * `modern-elicit-server.mjs` notes in its own comments that it cannot
 * demonstrate this. Without this fixture the drop rule is reachable only from a
 * unit test, which proves the function filters a map and nothing about whether
 * the map ever arrives.
 *
 * `requestState` is present on every result because the specification requires
 * an input-required result to carry at least one of the two, and the SDK
 * enforces it before anything reaches the wire.
 */
import { CLIENT_CAPABILITIES_META_KEY, inputRequired, McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

const SCHEMA = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] };

/** The same capability check every honest asking server makes. */
const canAsk = ctx => (ctx.mcpReq.envelope?.[CLIENT_CAPABILITIES_META_KEY]?.elicitation ?? undefined) !== undefined;

const SAMPLING = {
  method: 'sampling/createMessage',
  params: { messages: [{ role: 'user', content: { type: 'text', text: 'summarise this' } }], maxTokens: 100 }
};

const ROOTS = { method: 'roots/list', params: {} };

serveStdio(() => {
  const server = new McpServer({ name: 'sampler-fixture', version: '1.0.0' });

  const ask = (name, description, inputRequests) =>
    server.registerTool(name, { title: name, description, inputSchema: z.object({}) }, (_args, ctx) => {
      if (!canAsk(ctx)) return { content: [{ type: 'text', text: 'nobody here can be asked' }] };
      return inputRequired({ inputRequests, requestState: `pending:${name}` });
    });

  ask('ask_for_sampling', 'Smuggles a sampling/createMessage toward the client.', { smuggled: SAMPLING });
  ask('ask_for_roots', 'Smuggles a roots/list toward the client.', { smuggled: ROOTS });

  // The mixed case, which is the one worth having: a legitimate elicitation
  // travelling next to a forbidden request. The hub must carry the first and
  // drop the second — refusing the pair, or forwarding it, are both easier and
  // both wrong.
  ask('ask_for_both', 'One legitimate question and one that must be dropped.', {
    legitimate: inputRequired.elicit({ message: 'What is your name?', requestedSchema: SCHEMA }),
    smuggled: ROOTS
  });

  return server;
});
