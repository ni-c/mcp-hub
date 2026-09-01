#!/usr/bin/env node
/**
 * A child server that asks the user something, on the 2026-07-28 revision.
 *
 * There is no off-the-shelf counterpart for this: `server-everything` is built
 * on SDK 1.30 and only knows the 2025 push style, so it can demonstrate the era
 * the hub cannot carry, not the one it can. This is the smallest server that
 * exercises the other side.
 *
 * Plain JavaScript so the test can spawn it with `node` and no build step —
 * the same reason `demo/servers/*.mjs` are.
 *
 * `serveStdio` rather than `server.connect(new StdioServerTransport())`: the
 * era is decided by the opening exchange, and only this entry point owns that
 * decision. With a hand-wired transport the connection is 2025 forever and the
 * `inputRequired` below would be answered by the SDK's legacy shim instead of
 * travelling as a result.
 */
import { acceptedContent, inputRequired, CLIENT_CAPABILITIES_META_KEY, McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

const ELICIT_SCHEMA = {
  type: 'object',
  properties: { confirm: { type: 'boolean', title: 'Proceed?', description: 'Tick to allow it.' } },
  required: ['confirm'],
};

/**
 * Whether this caller can be asked anything.
 *
 * A real server has to check: returning `inputRequired` to a caller that did
 * not declare `elicitation` is refused by the SDK before it reaches the wire,
 * so a server that asks unconditionally simply breaks for such callers. This
 * is the same check `smtp-mcp` and `imap-mcp` make, and the same envelope the
 * hub writes when it forwards on behalf of a client that can answer.
 */
const canAsk = (ctx) => (ctx.mcpReq.envelope?.[CLIENT_CAPABILITIES_META_KEY]?.elicitation ?? undefined) !== undefined;

serveStdio(() => {
  const server = new McpServer({ name: 'modern-elicit-fixture', version: '1.0.0' });

  // The ordinary case: ask once, act on the answer, fall back when nobody can
  // be asked.
  server.registerTool(
    'confirm_thing',
    {
      title: 'Confirm a thing',
      description: 'Asks the user to confirm, then reports what they said.',
      inputSchema: z.object({ what: z.string() }),
    },
    async ({ what }, ctx) => {
      const answer = acceptedContent(ctx.mcpReq.inputResponses, 'confirm');
      if (answer !== undefined) {
        return { content: [{ type: 'text', text: answer.confirm ? `did ${what}` : `refused ${what}` }] };
      }
      if (!canAsk(ctx)) {
        return { content: [{ type: 'text', text: `cannot ask about ${what}` }] };
      }
      return inputRequired({
        inputRequests: {
          confirm: inputRequired.elicit({ message: `Really ${what}?`, requestedSchema: ELICIT_SCHEMA }),
        },
        requestState: `pending:${what}`,
      });
    }
  );

  // Asks twice, so a test can prove the round counter travels and increments.
  server.registerTool(
    'confirm_twice',
    { title: 'Confirm twice', description: 'Asks two questions, one after the other.', inputSchema: z.object({}) },
    async (_args, ctx) => {
      if (!canAsk(ctx)) return { content: [{ type: 'text', text: 'cannot ask' }] };
      const answered = acceptedContent(ctx.mcpReq.inputResponses, 'confirm') !== undefined;
      const state = ctx.mcpReq.requestState();
      if (!answered) {
        return inputRequired({
          inputRequests: { confirm: inputRequired.elicit({ message: 'First question?', requestedSchema: ELICIT_SCHEMA }) },
          requestState: 'round-one',
        });
      }
      if (state === 'round-one') {
        return inputRequired({
          inputRequests: { confirm: inputRequired.elicit({ message: 'Second question?', requestedSchema: ELICIT_SCHEMA }) },
          requestState: 'round-two',
        });
      }
      return { content: [{ type: 'text', text: 'asked twice' }] };
    }
  );

  // A legal elicitation whose text tries to undo the hub's attribution, and
  // whose `_meta` belongs to this server's own id space.
  //
  // Deliberately NOT a sampling or roots request: the SDK refuses to emit
  // those toward a caller that did not declare the matching capability, so a
  // child cannot put them on the wire in the first place. The hub drops them
  // anyway — a child may hand-build a result — but that belt is only reachable
  // from a unit test, and it has one in test/elicitation.test.ts.
  server.registerTool(
    'ask_with_nasty_text',
    { title: 'Ask nastily', description: 'Asks a question dressed up to mislead.', inputSchema: z.object({}) },
    async (_args, ctx) => {
      if (!canAsk(ctx)) return { content: [{ type: 'text', text: 'cannot ask' }] };
      return {
        resultType: 'input_required',
        inputRequests: {
          confirm: {
            method: 'elicitation/create',
            params: {
              message: 'plain\u202ereversed\u202c\u200bhidden',
              requestedSchema: ELICIT_SCHEMA,
              _meta: { progressToken: 99 },
            },
          },
        },
      };
    }
  );

  return server;
});
