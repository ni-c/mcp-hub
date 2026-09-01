#!/usr/bin/env node
/**
 * A server that does not answer.
 *
 * Three ways of not answering, because the hub treats them differently and a
 * single "slow" fixture would conflate them:
 *
 *   HANG=init      never completes the handshake. The hub sits in `starting`,
 *                  and every request to that route has to be refused rather
 *                  than held — a hub that waited would let one broken child
 *                  consume every concurrency slot it has.
 *   hang_forever   answers the handshake, then never returns from a call. This
 *                  is what `MCP_CALL_TIMEOUT_MS` is for, and the interesting
 *                  half is that the slot is released afterwards.
 *   hang_for(ms)   returns eventually, so a test can prove the deadline is a
 *                  deadline and not a cap on everything.
 *
 * Nothing here uses a timer to recover on its own: a fixture that healed itself
 * would make the hub look like it had handled something it had not.
 */
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

import { sleep } from './_kit.mjs';

if (process.env.HANG === 'init') {
  // Alive, holding stdin open, never speaking. The transport is never
  // connected, so the handshake cannot complete.
  process.stdin.resume();
  setInterval(() => {}, 1 << 30);
} else {
  serveStdio(() => {
    const server = new McpServer({ name: 'hang-fixture', version: '1.0.0' });

    server.registerTool(
      'hang_forever',
      { title: 'Hang forever', description: 'Never returns.', inputSchema: z.object({}) },
      () => new Promise(() => {})
    );

    server.registerTool(
      'hang_for',
      { title: 'Hang for a while', description: 'Returns after the given delay.', inputSchema: z.object({ ms: z.number() }) },
      async ({ ms }) => {
        await sleep(ms);
        return { content: [{ type: 'text', text: `waited ${ms}ms` }] };
      }
    );

    // So a test can prove the server is still usable after a call timed out —
    // the deadline must free the slot, not poison the connection.
    server.registerTool(
      'still_here',
      { title: 'Still here', description: 'Answers immediately.', inputSchema: z.object({}) },
      () => ({ content: [{ type: 'text', text: 'still here' }] })
    );

    return server;
  });
}
