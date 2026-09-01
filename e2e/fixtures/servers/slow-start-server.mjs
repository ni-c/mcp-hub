#!/usr/bin/env node
/**
 * A server that takes its time coming up.
 *
 * On-demand servers make startup part of the request path: a call to a sleeping
 * server waits for `wake()`, which is single-flight so that ten simultaneous
 * callers produce one child rather than ten. Proving that needs a child slow
 * enough for the second caller to arrive while the first is still waiting —
 * a fast one makes every ordering look correct.
 *
 * The delay is before `serveStdio`, so the process exists and stdin is open
 * while the handshake has not happened. That is the state the hub calls
 * `starting`, and it is the one a route has to answer 503 from rather than
 * hold the request in.
 */
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

import { envInt, sleep } from './_kit.mjs';

await sleep(envInt('START_DELAY_MS', 500));

serveStdio(() => {
  const server = new McpServer({ name: 'slow-start-fixture', version: '1.0.0' });
  const startedAt = Date.now();

  server.registerTool(
    'when_did_you_start',
    { title: 'Start time', description: 'Milliseconds since this process finished starting.', inputSchema: z.object({}) },
    () => ({ content: [{ type: 'text', text: String(Date.now() - startedAt) }] })
  );

  // The pid changes across a wake, which is how a test tells "woke the same
  // child" from "started a new one" without reaching into the supervisor.
  server.registerTool(
    'who_are_you',
    { title: 'Identity', description: 'The pid of this process.', inputSchema: z.object({}) },
    () => ({ content: [{ type: 'text', text: String(process.pid) }] })
  );

  return server;
});
