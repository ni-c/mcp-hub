import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createStdioHub } from '../src/stdio.js';

/**
 * The schemas the hub advertises for its own tools have to survive clients that
 * are stricter than the specification.
 *
 * The construct this file exists for is the empty schema — `{}` where a client
 * expects a constraint. It is legal JSON Schema and means "anything", exactly
 * like `true`, but several MCP clients refuse or mishandle the object spelling.
 * A tool written that way works against one client and fails against the next,
 * and nothing in the type system or the test suite notices.
 *
 * The assertion is deliberately about the property, not about the two lines in
 * `hub.ts` that currently satisfy it: zod decides this spelling, so a zod
 * upgrade can reintroduce it without anybody touching hub code.
 */

/** Keywords whose value is itself a schema. */
const SCHEMA_VALUED = ['additionalProperties', 'unevaluatedProperties', 'items', 'additionalItems', 'contains', 'propertyNames', 'not', 'if', 'then', 'else'];

/** Keywords whose value is a map of name to schema. */
const SCHEMA_MAPS = ['properties', 'patternProperties', 'dependentSchemas', '$defs', 'definitions'];

/** Keywords whose value is a list of schemas. */
const SCHEMA_LISTS = ['allOf', 'anyOf', 'oneOf', 'prefixItems'];

/**
 * Every keyword that says something about an instance.
 *
 * Anything outside this list is annotation — `description`, `title`, `default`,
 * `examples`, `$schema`, `deprecated` — and a node carrying only those accepts
 * every value there is.
 */
const VALIDATION_KEYWORDS = new Set([
  ...SCHEMA_VALUED,
  ...SCHEMA_MAPS,
  ...SCHEMA_LISTS,
  '$ref',
  '$dynamicRef',
  'type',
  'enum',
  'const',
  'format',
  'required',
  'dependentRequired',
  'minProperties',
  'maxProperties',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minContains',
  'maxContains',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern'
]);

type Node = Record<string, unknown>;

function isSchemaObject(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Walk a JSON Schema and report every schema-position node that constrains
 * nothing, by the path a reader can follow back into the document.
 *
 * A boolean in a schema position is fine and is not walked: `true` and `false`
 * are the two spellings this test is asking for.
 */
function unconstrainedPositions(schema: unknown, prefix: string): string[] {
  if (!isSchemaObject(schema)) return [];
  const found: string[] = [];

  const visit = (node: unknown, at: string, isSchemaPosition: boolean): void => {
    if (!isSchemaObject(node)) return;
    if (isSchemaPosition && !Object.keys(node).some(key => VALIDATION_KEYWORDS.has(key))) found.push(at);

    for (const [key, value] of Object.entries(node)) {
      if (SCHEMA_VALUED.includes(key)) {
        visit(value, `${at}.${key}`, true);
      } else if (SCHEMA_MAPS.includes(key) && isSchemaObject(value)) {
        for (const [name, child] of Object.entries(value)) visit(child, `${at}.${key}.${name}`, true);
      } else if (SCHEMA_LISTS.includes(key) && Array.isArray(value)) {
        value.forEach((child, index) => visit(child, `${at}.${key}[${index}]`, true));
      }
    }
  };

  visit(schema, prefix, true);
  return found;
}

const started: Array<ReturnType<typeof createStdioHub>> = [];

afterEach(async () => {
  for (const hub of started.splice(0)) {
    hub.watcher.stop();
    await hub.supervisor.stop();
  }
});

/**
 * The meta-tools with no children configured.
 *
 * An empty `mcpServers` is the point: the hub is answerable for the schemas it
 * writes, not for what a child advertises, and a child in the list would put
 * somebody else's document under this assertion.
 */
async function listMetaTools() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-schema-'));
  const configPath = path.join(dir, 'mcp.json');
  fs.writeFileSync(configPath, JSON.stringify({ mcpServers: {} }));

  const hub = createStdioHub({ configPath, idleTimeoutMinutes: 0 });
  started.push(hub);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await hub.build().connect(serverTransport);
  const client = new Client({ name: 'vitest', version: '1.0.0' });
  await client.connect(clientTransport);

  const { tools } = await client.listTools();
  await client.close();
  fs.rmSync(dir, { recursive: true, force: true });
  return tools;
}

describe('schema portability', () => {
  it('advertises no schema that constrains nothing', async () => {
    const tools = await listMetaTools();
    expect(tools.length).toBeGreaterThan(0);

    const offenders = tools.flatMap(tool => [
      ...unconstrainedPositions(tool.inputSchema, `${tool.name}.inputSchema`),
      ...unconstrainedPositions(tool.outputSchema, `${tool.name}.outputSchema`)
    ]);

    // Named rather than counted: a failure should say which field to look at.
    expect(offenders).toEqual([]);
  });

  it('spells "anything goes" as true on the four fields that mean it', async () => {
    const tools = await listMetaTools();
    const byName = new Map(tools.map(tool => [tool.name, tool]));

    // The fields carrying somebody else's document. Written out because the
    // general assertion above would also be satisfied by tightening them, and
    // tightening them is the thing this hub must not do — a child's annotations
    // are validated at runtime against the zod schema, and a refused answer
    // becomes an error result.
    const input = byName.get('call_tool')?.inputSchema as Node;
    expect((input.properties as Node).arguments).toMatchObject({ type: 'object', additionalProperties: true });

    const listed = byName.get('list_tools')?.outputSchema as Node;
    const listedTool = ((((listed.properties as Node).tools as Node).items as Node).properties as Node);
    expect(listedTool.annotations).toMatchObject({ type: 'object', additionalProperties: true });

    const schema = byName.get('get_tool_schema')?.outputSchema as Node;
    for (const field of ['inputSchema', 'outputSchema', 'annotations']) {
      expect((schema.properties as Node)[field], field).toMatchObject({ type: 'object', additionalProperties: true });
    }
  });
});
