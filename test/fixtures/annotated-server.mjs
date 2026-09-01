#!/usr/bin/env node
/**
 * A child server whose tools carry annotations the hub has to hand on.
 *
 * `server-everything` is no use for this: its tools declare nothing, so a hub
 * that dropped every annotation would pass every test written against it. The
 * whole question here is whether what a child says survives the trip, so the
 * child has to say something distinctive.
 *
 * The two tools differ in all four hints on purpose. A hub that returned a
 * fixed block, or one derived from the tool's name, would match one of them and
 * fail the other.
 *
 * Plain JavaScript so the test can spawn it with `node` and no build step — the
 * same reason `modern-elicit-server.mjs` and `demo/servers/*.mjs` are.
 */
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

const server = new McpServer({ name: 'annotated', version: '0.0.0' });

server.registerTool(
  'read_thing',
  {
    title: 'Read a thing',
    description: 'Reads a thing.\nA second line, so the one-line summary has something to cut.',
    inputSchema: z.object({ id: z.string().describe('Which thing') }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  ({ id }) => ({ content: [{ type: 'text', text: `read ${id}` }] })
);

server.registerTool(
  'delete_thing',
  {
    title: 'Delete a thing',
    description: 'Deletes a thing, and it does not come back.',
    inputSchema: z.object({ id: z.string() }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }
  },
  ({ id }) => ({ content: [{ type: 'text', text: `deleted ${id}` }] })
);

// Deliberately none: a child may say nothing, and "nothing" has to arrive as
// nothing rather than as an empty object, which would read as all four defaults.
server.registerTool(
  'silent_thing',
  { title: 'A tool with no annotations', description: 'Says nothing about itself.', inputSchema: z.object({}) },
  () => ({ content: [{ type: 'text', text: 'quiet' }] })
);

await server.connect(new StdioServerTransport());
