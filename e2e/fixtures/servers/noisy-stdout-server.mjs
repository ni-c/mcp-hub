#!/usr/bin/env node
/**
 * A server that writes things that are not the protocol onto the protocol.
 *
 * This is the commonest real-world defect in third-party MCP servers, and the
 * one every fixture in this repository is careful *not* to have: a banner, a
 * progress bar, a stray `console.log` in a dependency. The hub reads
 * newline-delimited JSON from a pipe it does not control, so what it does with
 * a line that is not JSON is a real question with two defensible answers — skip
 * the line, or treat the stream as lost — and an untested answer is how a
 * hub ends up with both.
 *
 * The 200 kB line is the interesting one. `ReadBuffer` refuses a line past its
 * limit, and that refusal used to arrive as a throw inside a `'data'` handler:
 * unreachable by any catch, straight to `uncaughtException`, and the hub shuts
 * down every other server on its way out. One bad child, twelve dead servers.
 *
 * Noise is emitted before the handshake and again between frames, because those
 * are different code paths: the first happens while the transport is still
 * being established, the second while it is carrying requests.
 */
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

import { envInt } from './_kit.mjs';

const GARBAGE_BYTES = envInt('GARBAGE_BYTES', 0);

// Before anything else, the way a CLI framework prints its banner.
process.stdout.write('noisy-fixture v1.0.0 — starting up\n');
process.stdout.write('[32m✔[0m ready\n');
// A line that looks like the start of JSON and is not: the case a parser that
// sniffs the first character gets wrong.
process.stdout.write('{\n');
if (GARBAGE_BYTES > 0) process.stdout.write(`${'z'.repeat(GARBAGE_BYTES)}\n`);

// stderr is where output belongs, and plenty of it: the hub inherits this
// stream, so a chatty child must not be able to fill anything up.
const chatter = setInterval(() => process.stderr.write('noisy-fixture: still chattering\n'), 50);
chatter.unref();

const server = new McpServer({ name: 'noisy-fixture', version: '1.0.0' });

server.registerTool(
  'quiet_call',
  { title: 'A normal call', description: 'Answers normally despite the noise.', inputSchema: z.object({}) },
  () => ({ content: [{ type: 'text', text: 'answered anyway' }] })
);

server.registerTool(
  'emit_noise',
  {
    title: 'Emit noise',
    description: 'Writes a non-protocol line between frames.',
    inputSchema: z.object({ bytes: z.number().optional() })
  },
  ({ bytes }) => {
    process.stdout.write(`not json at all${bytes ? ` ${'q'.repeat(bytes)}` : ''}\n`);
    return { content: [{ type: 'text', text: 'noise emitted' }] };
  }
);

await server.connect(new StdioServerTransport());
