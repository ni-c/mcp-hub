/**
 * One catalogue, registered identically on both protocol eras.
 *
 * The era question the hub has to answer is not "does 2026 work" but "does the
 * same child look the same through both doors". A pair of fixtures written
 * separately could not answer it: the first difference anybody found would be
 * in the fixtures, and proving otherwise would mean reading them side by side
 * forever. So the catalogue lives here, `catalog-2025.mjs` and
 * `catalog-2026.mjs` are entry points that differ only in how they open the
 * connection, and "same names, same content" becomes structural.
 *
 * What it covers is what `server-everything` does not: prompts with and
 * without arguments, a resource template with a completion on its variable, a
 * binary resource, a declared `outputSchema` with matching `structuredContent`,
 * and `_meta` on a result. Every one of those crosses the hub through a
 * different handler in `proxy.ts`, and none had an end-to-end test.
 *
 * Note for anyone using this as a template: stdout belongs to the protocol.
 * Anything you want to print goes to stderr, or the transport breaks.
 */
import { ResourceTemplate } from '@modelcontextprotocol/server';
import { z } from 'zod';

export const CATALOGUE_NAME = 'catalogue-fixture';

/** The three documents the template and the completion agree about. */
const DOCUMENTS = {
  alpha: 'The first document. It says alpha.',
  beta: 'The second document. It says beta.',
  gamma: 'The third document. It says gamma.'
};

/** A one-pixel PNG, so the blob path carries something a client could decode. */
const PIXEL_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

export function registerCatalogue(server) {
  // ---- tools ----------------------------------------------------------------

  server.registerTool(
    'echo',
    {
      title: 'Echo',
      description: 'Returns what it was given.',
      inputSchema: z.object({ message: z.string().describe('Anything at all') })
    },
    ({ message }) => ({ content: [{ type: 'text', text: `echo: ${message}` }] })
  );

  // A declared output schema, which the hub must carry through untouched: a
  // client validates `structuredContent` against it, so a gateway that drops
  // the schema turns valid results into unusable ones.
  server.registerTool(
    'measure',
    {
      title: 'Measure',
      description: 'Reports a fixed measurement, with a schema for its shape.',
      inputSchema: z.object({ what: z.string() }),
      outputSchema: z.object({ what: z.string(), value: z.number(), unit: z.string() })
    },
    ({ what }) => {
      const structuredContent = { what, value: 42, unit: 'furlongs' };
      return { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent };
    }
  );

  // Several content types in one result, because the hub's size accounting
  // walks the whole structure and a text-only fixture never exercises it.
  server.registerTool(
    'mixed_content',
    { title: 'Mixed content', description: 'Text and an image in one result.', inputSchema: z.object({}) },
    () => ({
      content: [
        { type: 'text', text: 'one pixel follows' },
        { type: 'image', data: PIXEL_BASE64, mimeType: 'image/png' }
      ]
    })
  );

  // `_meta` on a result, which is passthrough rather than protocol: the hub
  // neither reads nor invents it, and a client that relies on it would notice.
  server.registerTool(
    'with_meta',
    { title: 'With meta', description: 'Carries _meta on the way back.', inputSchema: z.object({}) },
    () => ({ content: [{ type: 'text', text: 'see _meta' }], _meta: { 'e2e/marker': 'catalogue' } })
  );

  server.registerTool(
    'always_fails',
    { title: 'Always fails', description: 'Returns a tool error, not a protocol error.', inputSchema: z.object({}) },
    () => ({ isError: true, content: [{ type: 'text', text: 'this tool always fails' }] })
  );

  // ---- resources ------------------------------------------------------------

  server.registerResource(
    'readme',
    'catalogue://readme',
    { title: 'Readme', description: 'A fixed text resource.', mimeType: 'text/plain' },
    async uri => ({ contents: [{ uri: uri.href, mimeType: 'text/plain', text: 'This is the catalogue fixture.' }] })
  );

  server.registerResource(
    'pixel',
    'catalogue://pixel.png',
    { title: 'Pixel', description: 'A binary resource, delivered as a blob.', mimeType: 'image/png' },
    async uri => ({ contents: [{ uri: uri.href, mimeType: 'image/png', blob: PIXEL_BASE64 }] })
  );

  // A template with both callbacks: `list` so it appears in resources/list, and
  // `complete` so completion/complete has something to answer. The hub forwards
  // completion only when the child declares it, which it does by having one.
  server.registerResource(
    'document',
    new ResourceTemplate('catalogue://documents/{name}', {
      list: async () => ({
        resources: Object.keys(DOCUMENTS).map(name => ({
          uri: `catalogue://documents/${name}`,
          name,
          mimeType: 'text/plain'
        }))
      }),
      complete: {
        name: async value => Object.keys(DOCUMENTS).filter(name => name.startsWith(value))
      }
    }),
    { title: 'Document', description: 'One of three documents.', mimeType: 'text/plain' },
    async (uri, { name }) => ({
      contents: [{ uri: uri.href, mimeType: 'text/plain', text: DOCUMENTS[name] ?? `no such document: ${name}` }]
    })
  );

  // ---- prompts --------------------------------------------------------------

  server.registerPrompt(
    'greeting',
    { title: 'Greeting', description: 'A prompt that takes no arguments.' },
    () => ({ messages: [{ role: 'user', content: { type: 'text', text: 'Say hello.' } }] })
  );

  server.registerPrompt(
    'summarise',
    {
      title: 'Summarise',
      description: 'A prompt with a required argument and an optional one.',
      argsSchema: z.object({
        subject: z.string().describe('What to summarise'),
        tone: z.string().optional().describe('How to say it')
      })
    },
    ({ subject, tone }) => ({
      messages: [
        {
          role: 'user',
          content: { type: 'text', text: `Summarise ${subject}${tone ? ` in a ${tone} tone` : ''}.` }
        }
      ]
    })
  );
}

/**
 * What a test may assert the catalogue contains, without hardcoding it twice.
 *
 * `resources` includes the three documents as well as the two static entries:
 * a template whose `list` callback enumerates its matches contributes them to
 * `resources/list` too, so a client sees five resources and one template. That
 * is the SDK's behaviour rather than the hub's, and worth writing down here
 * because the first guess is that a template only ever appears in
 * `resources/templates/list`.
 */
export const CATALOGUE = {
  tools: ['always_fails', 'echo', 'measure', 'mixed_content', 'with_meta'],
  resources: [
    ...Object.keys(DOCUMENTS)
      .map(name => `catalogue://documents/${name}`)
      .sort(),
    'catalogue://pixel.png',
    'catalogue://readme'
  ],
  templates: ['catalogue://documents/{name}'],
  prompts: ['greeting', 'summarise'],
  documents: Object.keys(DOCUMENTS)
};
