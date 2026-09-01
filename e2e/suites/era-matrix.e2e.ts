import type { CallToolResult, CompleteResult, GetPromptResult, ListPromptsResult, ListResourcesResult, ListResourceTemplatesResult, ListToolsResult, ReadResourceResult } from '@modelcontextprotocol/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { CATALOGUE } from '../fixtures/servers/_catalogue.mjs';
import { bothCataloguesFleet } from '../fixtures/fleets.js';
import { ClientPool, type Era } from '../harness/client.js';
import { describeEachEraPair } from '../harness/era.js';
import { startGateway, type Gateway } from '../harness/gateway.js';
import { obtainToken } from '../harness/token.js';

/**
 * The same child, seen through both doors, by clients of both eras.
 *
 * Two catalogues are mounted — one served on 2025-11-25, one on 2026-07-28 —
 * and they are the *same* catalogue: both entry points register it from
 * `_catalogue.mjs`, so any difference a test finds is the hub's, never the
 * fixture's. That is what makes "same names, same content" a usable assertion
 * instead of a comparison of two files somebody has to keep in step by hand.
 *
 * The interesting cells are the mixed ones. A 2025 child reaching a 2026 client
 * is the bridging the hub exists to do; the same-era cells are mostly there so
 * a regression in one has something to be compared against.
 */

let gateway: Gateway;
let clients: ClientPool;
let hubToken: string;
let legacyToken: string;
let modernToken: string;

beforeAll(async () => {
  gateway = await startGateway({
    prefix: 'era-matrix',
    servers: bothCataloguesFleet(),
    // Both children stay up: this suite is about what crosses the hub, and a
    // sleeping child answering from cache would be a different question.
    env: { IDLE_TIMEOUT_MINUTES: '0' }
  });
  clients = new ClientPool(gateway);
  hubToken = (await obtainToken(gateway, { resource: 'hub' })).access;
  legacyToken = (await obtainToken(gateway, { resource: 'legacy' })).access;
  modernToken = (await obtainToken(gateway, { resource: 'modern' })).access;
}, 120_000);

afterEach(() => clients.closeAll());
afterAll(() => gateway?.stop());

const tokenFor = (child: Era): string => (child === 'legacy' ? legacyToken : modernToken);
const routeFor = (child: Era): string => `/${child}/mcp`;

describeEachEraPair('the catalogue', (clientEra, childEra) => {
  it('offers the same tools whichever era asks', async () => {
    const client = await clients.connect(routeFor(childEra), tokenFor(childEra), { era: clientEra });
    const listed = (await client.listTools()) as ListToolsResult;
    expect(listed.tools.map(tool => tool.name).sort()).toEqual(CATALOGUE.tools);
  });

  it('carries a declared outputSchema through to the client', async () => {
    // A gateway that dropped this would hand back results a client cannot
    // validate — valid data that looks invalid, which is worse than an error.
    const client = await clients.connect(routeFor(childEra), tokenFor(childEra), { era: clientEra });
    const listed = (await client.listTools()) as ListToolsResult;
    const measure = listed.tools.find(tool => tool.name === 'measure');
    expect(measure?.outputSchema).toMatchObject({ type: 'object' });

    const result = (await client.callTool({ name: 'measure', arguments: { what: 'a field' } })) as CallToolResult;
    expect(result.structuredContent).toEqual({ what: 'a field', value: 42, unit: 'furlongs' });
  });

  it('carries _meta on a result without inventing or dropping it', async () => {
    const client = await clients.connect(routeFor(childEra), tokenFor(childEra), { era: clientEra });
    const result = (await client.callTool({ name: 'with_meta', arguments: {} })) as CallToolResult;
    expect(result._meta).toMatchObject({ 'e2e/marker': 'catalogue' });
  });

  it('keeps a tool error a tool error, not a protocol error', async () => {
    const client = await clients.connect(routeFor(childEra), tokenFor(childEra), { era: clientEra });
    const result = (await client.callTool({ name: 'always_fails', arguments: {} })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('always fails');
  });

  it('serves resources, templates and a blob', async () => {
    const client = await clients.connect(routeFor(childEra), tokenFor(childEra), { era: clientEra });

    const resources = (await client.listResources()) as ListResourcesResult;
    expect(resources.resources.map(resource => resource.uri).sort()).toEqual(CATALOGUE.resources);

    const templates = (await client.listResourceTemplates()) as ListResourceTemplatesResult;
    expect(templates.resourceTemplates.map(template => template.uriTemplate)).toEqual(CATALOGUE.templates);

    const text = (await client.readResource({ uri: 'catalogue://readme' })) as ReadResourceResult;
    expect((text.contents[0] as { text: string }).text).toContain('catalogue fixture');

    // The blob path is separate plumbing from the text one, and base64 that
    // survives a round trip is the only proof it was not re-encoded.
    const blob = (await client.readResource({ uri: 'catalogue://pixel.png' })) as ReadResourceResult;
    expect((blob.contents[0] as { blob?: string }).blob).toMatch(/^iVBORw0KGgo/);
  });

  it('serves prompts with and without arguments', async () => {
    const client = await clients.connect(routeFor(childEra), tokenFor(childEra), { era: clientEra });

    const prompts = (await client.listPrompts()) as ListPromptsResult;
    expect(prompts.prompts.map(prompt => prompt.name).sort()).toEqual(CATALOGUE.prompts);

    const bare = (await client.getPrompt({ name: 'greeting' })) as GetPromptResult;
    expect((bare.messages[0].content as { text: string }).text).toBe('Say hello.');

    const withArgs = (await client.getPrompt({ name: 'summarise', arguments: { subject: 'the hub', tone: 'dry' } })) as GetPromptResult;
    expect((withArgs.messages[0].content as { text: string }).text).toBe('Summarise the hub in a dry tone.');
  });

  it('completes a template variable', async () => {
    const client = await clients.connect(routeFor(childEra), tokenFor(childEra), { era: clientEra });
    const completion = (await client.complete({
      ref: { type: 'ref/resource', uri: 'catalogue://documents/{name}' },
      argument: { name: 'name', value: 'a' }
    })) as CompleteResult;
    expect(completion.completion.values).toEqual(['alpha']);
  });
});

describe('what the two eras must NOT share', () => {
  it('promises subscribe and listChanged only where they are carried', async () => {
    // Three capability lies were fixed by promising these only on the era that
    // implements them. Both children declare all of it; the hub is the one that
    // has to tell the truth about what it can carry.
    const modern = await clients.connect('/modern/mcp', modernToken, { era: 'modern' });
    const modernCaps = modern.getServerCapabilities();
    expect(modernCaps?.resources?.subscribe).toBe(true);

    const legacyClient = await clients.connect('/modern/mcp', modernToken, { era: 'legacy' });
    const legacyCaps = legacyClient.getServerCapabilities();
    expect(legacyCaps?.resources?.subscribe).toBeFalsy();
    expect(legacyCaps?.tools?.listChanged).toBeFalsy();
  });

  it('never advertises logging, on either era', async () => {
    // `logging/setLevel` has never had a handler. Advertising it is a promise
    // the hub cannot keep, and the honest answer is to stop making it.
    for (const era of ['legacy', 'modern'] as const) {
      const client = await clients.connect('/modern/mcp', modernToken, { era });
      expect(client.getServerCapabilities()?.logging).toBeUndefined();
    }
  });
});

describe('the aggregate', () => {
  it('reaches a child of either era through the same six tools', async () => {
    const client = await clients.connect('/hub', hubToken);
    for (const server of ['legacy', 'modern']) {
      const result = (await client.callTool({
        name: 'call_tool',
        arguments: { server, tool: 'echo', arguments: { message: server } }
      })) as CallToolResult;
      expect((result.content[0] as { text: string }).text).toBe(`echo: ${server}`);
    }
  });

  it('carries tools and nothing else, on purpose', async () => {
    // /hub aggregates tools only. A client connected there has no prompts and
    // no resources, and that is a decision rather than an omission: a
    // `resources/list_changed` from one child describes nothing a /hub client
    // could read. Pinned because it is exactly the kind of thing a refactor
    // "fixes".
    const client = await clients.connect('/hub', hubToken);
    const capabilities = client.getServerCapabilities();
    expect(capabilities?.tools).toBeDefined();
    expect(capabilities?.resources).toBeUndefined();
    expect(capabilities?.prompts).toBeUndefined();
  });

  it('does not prefix a child tool with its server name', async () => {
    // The aggregate routes by an explicit `server` argument, not by mangling
    // names. A prefix would be a reasonable design and is not this one; a test
    // says so, because the alternative is finding out from a client that broke.
    const client = await clients.connect('/hub', hubToken);
    const listed = (await client.callTool({ name: 'list_tools', arguments: { server: 'modern' } })) as CallToolResult;
    const names = (JSON.parse((listed.content[0] as { text: string }).text) as Array<{ name: string }>).map(tool => tool.name);
    expect(names).toContain('echo');
    expect(names.some(name => name.includes('modern'))).toBe(false);
  });
});
