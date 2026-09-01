#!/usr/bin/env node
/**
 * A server that dies, in each of the ways a real one dies.
 *
 * The distinction that matters to the hub is *when*:
 *
 *   CRASH_AT_START=1  exits before the handshake. The supervisor has nothing to
 *                     tear down and everything to back off from; this is the
 *                     crash-loop fixture.
 *   crash_now         exits while a call is in flight. The client is owed an
 *                     answer, and what it must get is a JSON-RPC error rather
 *                     than a hung request or a dead hub.
 *   abort_stream      writes half a JSON-RPC frame and exits. The framing layer
 *                     sees a partial line, which is the case that once could
 *                     take the whole hub down: a throw inside a 'data' handler
 *                     reaches `uncaughtException`, and the hub shuts down every
 *                     other server with it.
 *   CRASH_AFTER_MS    exits on a timer, for the idle and ping paths where
 *                     nothing is in flight to notice.
 *
 * `process.exit` rather than `throw`: a thrown error would be reported by the
 * SDK and answered politely, which is the opposite of the point.
 */
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

import { envFlag, envInt } from './_kit.mjs';

if (envFlag('CRASH_AT_START')) {
  process.stderr.write('crash-fixture: refusing to start, as instructed\n');
  process.exit(3);
}

const crashAfterMs = envInt('CRASH_AFTER_MS', 0);
if (crashAfterMs > 0) setTimeout(() => process.exit(4), crashAfterMs).unref();

serveStdio(() => {
  const server = new McpServer({ name: 'crash-fixture', version: '1.0.0' });

  server.registerTool(
    'still_here',
    { title: 'Still here', description: 'Answers immediately, so a restart can be observed.', inputSchema: z.object({}) },
    () => ({ content: [{ type: 'text', text: `alive as pid ${process.pid}` }] })
  );

  server.registerTool(
    'crash_now',
    { title: 'Crash now', description: 'Exits without answering.', inputSchema: z.object({}) },
    () => {
      process.exit(5);
    }
  );

  server.registerTool(
    'abort_stream',
    {
      title: 'Abort mid-frame',
      description: 'Writes half a JSON-RPC message and exits.',
      inputSchema: z.object({})
    },
    () => {
      // Deliberately no trailing newline: the framing is newline-delimited, so
      // this is a message the reader can never complete.
      process.stdout.write('{"jsonrpc":"2.0","id":999,"result":{"content":[{"type":"tex');
      process.exit(6);
    }
  );

  return server;
});
