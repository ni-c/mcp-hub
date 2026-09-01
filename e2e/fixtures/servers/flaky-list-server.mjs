#!/usr/bin/env node
/**
 * A server whose tool list moves, and sometimes fails.
 *
 * Two behaviours the hub's tool cache depends on and nothing exercised end to
 * end:
 *
 *   FAIL_LIST_TIMES=n  the first n `tools/list` calls fail. The hub caches a
 *                      snapshot per child and re-reads it on a change
 *                      notification; a failed re-read must leave the previous
 *                      snapshot in place rather than emptying it, or a
 *                      transient error looks to every client like a server that
 *                      lost all its tools.
 *   add_tool           registers a tool and announces the change. The
 *                      notification is coalesced by a 250 ms window, so calling
 *                      it twice quickly must produce one downstream event —
 *                      which is exactly what the window is for and exactly what
 *                      a test has to wait past to observe.
 *
 * Every change is triggered by a call, never by a timer, so a test can say when
 * one is expected instead of waiting to see whether one turns up.
 */
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

import { envInt } from './_kit.mjs';

let listFailuresLeft = envInt('FAIL_LIST_TIMES', 0);

serveStdio(() => {
  const server = new McpServer(
    { name: 'flaky-list-fixture', version: '1.0.0' },
    { capabilities: { tools: { listChanged: true } } }
  );

  let added = 0;

  server.registerTool(
    'baseline',
    { title: 'Baseline', description: 'Always present.', inputSchema: z.object({}) },
    () => ({ content: [{ type: 'text', text: 'baseline' }] })
  );

  server.registerTool(
    'add_tool',
    { title: 'Add a tool', description: 'Registers another tool and announces it.', inputSchema: z.object({}) },
    () => {
      added += 1;
      const name = `added_${added}`;
      server.registerTool(
        name,
        { title: name, description: 'Appeared at runtime.', inputSchema: z.object({}) },
        () => ({ content: [{ type: 'text', text: name }] })
      );
      return { content: [{ type: 'text', text: name }] };
    }
  );

  if (listFailuresLeft > 0) {
    const inner = server.server;
    const original = inner._requestHandlers?.get('tools/list');
    inner.setRequestHandler({ method: 'tools/list' }, async (request, extra) => {
      if (listFailuresLeft > 0) {
        listFailuresLeft -= 1;
        throw new Error(`tools/list is unavailable (${listFailuresLeft} failures left)`);
      }
      return original(request, extra);
    });
  }

  return server;
});
