#!/usr/bin/env node
/**
 * A server that answers with more than the hub will carry.
 *
 * Four ceilings live in `src/mcp-limits.ts`, all of them there because a child
 * is untrusted code whose reply the hub holds in memory on behalf of every
 * other server. None of the four had an end-to-end test — they were reachable
 * only by calling the assertion directly, which proves the arithmetic and not
 * that the ceiling is on the path.
 *
 *   big_result(bytes)      → MAX_FORWARDED_RESULT_BYTES (8 MiB)
 *   TOOL_COUNT=10001       → MAX_TOOLS (10 000)
 *   FAT_METADATA=1         → MAX_TOOL_METADATA_BYTES (16 MiB)
 *   ENDLESS_PAGES=1        → MAX_TOOL_LIST_PAGES (100), via a cursor that never
 *                            ends. The repeated-cursor guard is separate: this
 *                            one advances, so only the page count can stop it.
 *
 * The large shapes are built on demand, never at import: a fixture that
 * allocated 16 MiB to start up would be measuring the machine rather than the
 * hub, and the crash-loop tests spawn it repeatedly.
 */
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

import { envFlag, envInt } from './_kit.mjs';

const TOOL_COUNT = envInt('TOOL_COUNT', 0);
const FAT_METADATA = envFlag('FAT_METADATA');
const ENDLESS_PAGES = envFlag('ENDLESS_PAGES');

serveStdio(() => {
  const server = new McpServer({ name: 'oversize-fixture', version: '1.0.0' });

  server.registerTool(
    'big_result',
    {
      title: 'Big result',
      description: 'Returns a result of the requested size.',
      inputSchema: z.object({ bytes: z.number().describe('How much text to return') })
    },
    ({ bytes }) => ({ content: [{ type: 'text', text: 'x'.repeat(bytes) }] })
  );

  server.registerTool(
    'small_result',
    { title: 'Small result', description: 'Proves the server still works after a refusal.', inputSchema: z.object({}) },
    () => ({ content: [{ type: 'text', text: 'small' }] })
  );

  if (FAT_METADATA) {
    server.registerTool(
      'fat_metadata',
      {
        title: 'Fat metadata',
        // The description is metadata, so it counts against the tool-list budget
        // rather than the result budget — a distinct ceiling, and one a child
        // can blow without ever being called.
        description: 'y'.repeat(17 * 1024 * 1024),
        inputSchema: z.object({})
      },
      () => ({ content: [{ type: 'text', text: 'never reached' }] })
    );
  }

  for (let index = 0; index < TOOL_COUNT; index += 1) {
    server.registerTool(
      `tool_${index}`,
      { title: `Tool ${index}`, description: 'One of very many.', inputSchema: z.object({}) },
      () => ({ content: [{ type: 'text', text: `tool ${index}` }] })
    );
  }

  if (ENDLESS_PAGES) {
    // Registered handlers win over the McpServer's own, so this replaces
    // tools/list entirely: one tool per page, a fresh cursor every time. A hub
    // that paginated to exhaustion would never return.
    server.server.setRequestHandler(
      { method: 'tools/list' },
      async request => {
        const page = Number(request.params?.cursor ?? 0);
        return {
          tools: [{ name: `page_${page}_tool`, description: 'One tool on an endless shelf.', inputSchema: { type: 'object' } }],
          nextCursor: String(page + 1)
        };
      }
    );
  }

  return server;
});
