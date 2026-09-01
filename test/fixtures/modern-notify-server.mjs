#!/usr/bin/env node
/**
 * A child server that pushes change notifications, on the 2026-07-28 revision.
 *
 * The same gap `modern-elicit-server.mjs` fills, for the other direction:
 * `server-everything` is built on SDK 1.30 and only knows the 2025 push style,
 * so it can demonstrate the era the hub does not carry rather than the one it
 * does. This is the smallest server that emits all four event types on demand.
 *
 * Every notification here is triggered by a tool call rather than a timer, so a
 * test can say exactly when one is expected instead of waiting to see whether
 * one turns up.
 *
 * `serveStdio` rather than a hand-wired transport, for the reason spelled out
 * in the elicitation fixture: only this entry point owns the era decision, and
 * a hand-wired connection is 2025 forever — where `subscriptions/listen` does
 * not exist at all.
 */
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

const WATCHED = 'test://watched';

serveStdio(() => {
  // Declared explicitly rather than left to be derived: `subscribe` is the
  // capability the hub reads before it will ask this server for anything, and
  // the whole point of the fixture is to be a child that says yes.
  const server = new McpServer(
    { name: 'modern-notify-fixture', version: '1.0.0' },
    { capabilities: { tools: { listChanged: true }, resources: { listChanged: true, subscribe: true }, prompts: { listChanged: true } } }
  );

  let revision = 0;

  server.registerResource(
    'watched',
    WATCHED,
    { title: 'A resource that changes', description: 'Its body is the number of times it was touched.', mimeType: 'text/plain' },
    async uri => ({ contents: [{ uri: uri.href, mimeType: 'text/plain', text: `revision ${revision}` }] })
  );

  server.registerTool(
    'touch_resource',
    {
      title: 'Touch the watched resource',
      description: 'Bumps the resource and announces it changed.',
      inputSchema: z.object({ uri: z.string().optional() })
    },
    async ({ uri }) => {
      revision += 1;
      await server.server.sendResourceUpdated({ uri: uri ?? WATCHED });
      return { content: [{ type: 'text', text: `revision ${revision}` }] };
    }
  );

  server.registerTool(
    'announce_tools_changed',
    { title: 'Announce a tool-list change', description: 'Emits notifications/tools/list_changed.', inputSchema: z.object({}) },
    async () => {
      server.sendToolListChanged();
      return { content: [{ type: 'text', text: 'announced' }] };
    }
  );

  server.registerTool(
    'announce_resources_changed',
    { title: 'Announce a resource-list change', description: 'Emits notifications/resources/list_changed.', inputSchema: z.object({}) },
    async () => {
      server.sendResourceListChanged();
      return { content: [{ type: 'text', text: 'announced' }] };
    }
  );

  server.registerTool(
    'announce_prompts_changed',
    { title: 'Announce a prompt-list change', description: 'Emits notifications/prompts/list_changed.', inputSchema: z.object({}) },
    async () => {
      server.sendPromptListChanged();
      return { content: [{ type: 'text', text: 'announced' }] };
    }
  );

  return server;
});
