#!/usr/bin/env node
/**
 * The shared catalogue, served on the 2026-07-28 revision.
 *
 * `serveStdio` rather than a hand-wired transport: the era is decided by the
 * opening exchange, and only this entry point owns that decision. A
 * hand-wired connection is 2025 forever, which would make this file a copy of
 * its twin rather than its counterpart.
 *
 * Capabilities are declared explicitly rather than derived. The hub reads them
 * to decide what to advertise downstream, and the honesty rule it enforces —
 * only promise `subscribe` and `listChanged` on the era that carries them —
 * needs a child that promises them in the first place.
 */
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { CATALOGUE_NAME, registerCatalogue } from './_catalogue.mjs';

serveStdio(() => {
  const server = new McpServer(
    { name: `${CATALOGUE_NAME}-2026`, version: '1.0.0' },
    {
      capabilities: {
        tools: { listChanged: true },
        resources: { listChanged: true, subscribe: true },
        prompts: { listChanged: true },
        // Declared although nothing here implements `logging/setLevel`, and
        // that is the point: the hub has to refuse to pass it on. A fixture
        // that stayed quiet would make the honesty test unfailable — which is
        // how it was written first, and a deliberate regression proved it.
        logging: {}
      }
    }
  );
  registerCatalogue(server);
  return server;
});
