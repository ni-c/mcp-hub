#!/usr/bin/env node
/**
 * The shared catalogue, served on the 2025-11-25 revision.
 *
 * `new StdioServerTransport()` wired by hand, which pins the connection to the
 * legacy era whatever the client asks for — the same reason
 * `test/fixtures/annotated-server.mjs` uses it. That is the point here: the era
 * has to be a property of the fixture, not of the negotiation, or the pair
 * cannot be compared.
 *
 * Everything it offers comes from `_catalogue.mjs`, byte for byte the same as
 * its 2026 twin. See that file for why.
 */
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

import { CATALOGUE_NAME, registerCatalogue } from './_catalogue.mjs';

// `logging` is declared and not implemented on purpose; see the note in the
// 2026 twin. The hub must not repeat the claim to a client on either era.
const server = new McpServer({ name: `${CATALOGUE_NAME}-2025`, version: '1.0.0' }, { capabilities: { logging: {} } });
registerCatalogue(server);

await server.connect(new StdioServerTransport());
