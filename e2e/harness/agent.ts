import type { CallToolResult, Client, ListToolsResult, Tool } from '@modelcontextprotocol/client';

import { argsFor, type JsonSchema } from './args.js';
import { expectEveryToolExercised, type SkipReasons } from './coverage.js';
import type { Gateway } from './gateway.js';

/**
 * A consumer that behaves like a model without being one.
 *
 * The brief was "a fake model that consumes the hub", and the reason not to use
 * a real one is not cost — it is that a real one cannot fail a test. A model
 * that gets a mangled schema will improvise around it, retry with different
 * arguments, or produce a plausible sentence about why it could not; none of
 * those is an assertion. What is worth borrowing from a model is the *shape* of
 * what it does, which is entirely mechanical:
 *
 *   1. discover what exists (`list_servers`, `list_tools`)
 *   2. read the schema of the thing it wants to call (`get_tool_schema`)
 *   3. construct arguments *from that schema*
 *   4. call, and use the result
 *
 * Step 3 is the whole value. It means the hub's own published schemas are under
 * test rather than a copy of them written by hand — see `args.ts`.
 *
 * What this proves that an ordinary test does not:
 *
 *   - every exposed tool was really reached, with a written reason for each one
 *     that was not (`expectEveryToolExercised`)
 *   - results are shaped the way the protocol says, on every call rather than
 *     on the handful somebody assertion-checked
 *   - `structuredContent` validates against the `outputSchema` the hub handed
 *     out, which is the pair a gateway can silently break
 *   - the same run twice produces the same transcript, so nothing depends on
 *     map iteration order — the thing that makes real clients flap
 *   - discovery is idempotent across calls, unless a change was announced
 *   - no result mentions another server's tools
 */

export interface AgentStep {
  server: string;
  tool: string;
  args: Record<string, unknown>;
  isError: boolean;
  /** Content types in order, not the content: a transcript has to be comparable. */
  shape: string[];
  /** Text content, redacted of anything that legitimately varies. */
  text: string;
}

export interface AgentRun {
  steps: AgentStep[];
  called: Set<string>;
  catalogue: string[];
  durationMs: number;
  requests: number;
}

export interface Scenario {
  name: string;
  /** How the agent reaches the fleet. `/hub` uses the six meta-tools. */
  via: 'hub' | { server: string };
  /**
   * Tools that cannot be exercised, each with a reason a person wrote.
   *
   * Same discipline as the coverage map it feeds: `crash_now: 'skipped'` is not
   * a reason, and the point of the record shape is that nobody can pretend it is.
   */
  outOfReach?: SkipReasons;
  /**
   * Arguments the schema permits but the semantics do not.
   *
   * `get_ticket({ id })` has an honest schema and still needs `DEMO-101`. The
   * override carries a `why` for the same reason `outOfReach` does — without
   * one it becomes the place every inconvenient tool quietly ends up.
   */
  argsOverride?: Record<string, { args: Record<string, unknown>; why: string }>;
  /** Also fill optional properties, for the tools where they are the point. */
  fillOptional?: boolean;
  budget?: { ms: number; requests: number };
}

const MAX_TEXT = 400;

/**
 * Redacts what legitimately differs between two runs of the same scenario.
 *
 * Without this the determinism check would fail on a pid or a duration and say
 * nothing about ordering, which is the property it exists to protect.
 */
function redact(text: string): string {
  return text
    .replace(/\b\d{2,}\b/g, '<n>')
    .replace(/\b[0-9a-f]{8,}\b/gi, '<hex>')
    .slice(0, MAX_TEXT);
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map(part => part.text)
    .join('\n');
}

/**
 * Checks a result against what the protocol says a result is.
 *
 * Run on every call rather than on chosen ones: this is the assertion that
 * scales with the fleet instead of with the test file, and it is how a fixture
 * added next year gets checked without anybody remembering to.
 */
function assertResultShape(tool: Tool, result: CallToolResult, where: string): void {
  if (!Array.isArray(result.content)) throw new Error(`${where}: content is not an array`);
  for (const [index, part] of result.content.entries()) {
    const type = (part as { type?: unknown }).type;
    if (typeof type !== 'string') throw new Error(`${where}: content[${index}] has no type`);
    if (!['text', 'image', 'audio', 'resource', 'resource_link'].includes(type)) {
      throw new Error(`${where}: content[${index}] has unknown type "${type}"`);
    }
    if (type === 'text' && typeof (part as { text?: unknown }).text !== 'string') {
      throw new Error(`${where}: content[${index}] is text with no string in it`);
    }
  }
  if (result.isError !== undefined && typeof result.isError !== 'boolean') {
    throw new Error(`${where}: isError is ${typeof result.isError}, not a boolean`);
  }
  // The pair a gateway can break without either half looking wrong: a schema
  // that arrived and content that no longer matches it, or the reverse.
  if (tool.outputSchema && result.structuredContent !== undefined && !result.isError) {
    const missing = (tool.outputSchema as JsonSchema).required?.filter(
      key => !Object.hasOwn(result.structuredContent as Record<string, unknown>, key)
    );
    if (missing && missing.length > 0) {
      throw new Error(`${where}: structuredContent is missing ${missing.join(', ')}, which its outputSchema requires`);
    }
  }
}

/** What the agent can see, and how it calls it — the two doors, one interface. */
interface Door {
  catalogue(): Promise<Array<{ server: string; tool: Tool }>>;
  call(server: string, tool: string, args: Record<string, unknown>): Promise<CallToolResult>;
}

function directDoor(client: Client, server: string): Door {
  return {
    catalogue: async () => {
      const listed = (await client.listTools()) as ListToolsResult;
      return listed.tools.map(tool => ({ server, tool }));
    },
    call: async (_server, tool, args) => (await client.callTool({ name: tool, arguments: args })) as CallToolResult
  };
}

/**
 * The aggregate door: discovery through three meta-tools, calls through a
 * fourth.
 *
 * Written to mirror `directDoor` exactly, because the point of running a
 * scenario through both is that the answers must match. Anything this one did
 * differently would make that comparison meaningless.
 */
function hubDoor(client: Client): Door {
  /**
   * Reads the machine-readable half, and checks the other one agrees.
   *
   * A meta-tool carries the same object twice — `structuredContent` for
   * programs, the text block for people and models — and the specification's
   * rule is that they say the same thing. Taking one and asserting the other
   * matches is how that stays true: a gateway could drift the two apart and
   * every test that read only one of them would stay green.
   */
  const json = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
    if (result.isError) throw new Error(`${name} failed: ${textOf(result)}`);
    if (result.structuredContent === undefined) throw new Error(`${name} returned no structuredContent`);
    const asText: unknown = JSON.parse(textOf(result));
    if (JSON.stringify(asText) !== JSON.stringify(result.structuredContent)) {
      throw new Error(`${name}: the text block and structuredContent disagree`);
    }
    return result.structuredContent;
  };
  return {
    catalogue: async () => {
      const { servers } = (await json('list_servers', {})) as { servers: Array<{ name: string; status: string }> };
      const entries: Array<{ server: string; tool: Tool }> = [];
      for (const server of servers) {
        const { tools: summaries } = (await json('list_tools', { server: server.name })) as { tools: Array<{ name: string }> };
        for (const summary of summaries) {
          // The schema is fetched per tool, exactly as a client with a tool
          // budget would: `list_tools` gives one-line descriptions, and the
          // full schema is a second request. An agent that used the summary
          // would never notice a broken `get_tool_schema`.
          entries.push({ server: server.name, tool: (await json('get_tool_schema', { server: server.name, tool: summary.name })) as Tool });
        }
      }
      return entries;
    },
    call: async (server, tool, args) =>
      (await client.callTool({ name: 'call_tool', arguments: { server, tool, arguments: args } })) as CallToolResult
  };
}

export interface RunOptions {
  /** Seeds the derived arguments. The scenario name, so two differ. */
  seed?: string;
}

export async function runAgent(gateway: Gateway, client: Client, scenario: Scenario, options: RunOptions = {}): Promise<AgentRun> {
  const seed = options.seed ?? scenario.name;
  const door = scenario.via === 'hub' ? hubDoor(client) : directDoor(client, scenario.via.server);
  const startedAt = Date.now();
  let requests = 0;

  const entries = await door.catalogue();
  requests += 1;
  const catalogue = entries.map(entry => entry.tool.name).sort();
  const called = new Set<string>();
  const steps: AgentStep[] = [];

  // Sorted, so the transcript does not depend on the order discovery happened
  // to return things in. That ordering is itself asserted separately — here it
  // must not be allowed to leak into everything else.
  const ordered = [...entries].sort((a, b) => `${a.server}/${a.tool.name}`.localeCompare(`${b.server}/${b.tool.name}`));

  for (const { server, tool } of ordered) {
    if (scenario.outOfReach && tool.name in scenario.outOfReach) continue;
    const override = scenario.argsOverride?.[tool.name];
    const args = override
      ? override.args
      : argsFor(tool.inputSchema as JsonSchema | undefined, seed, `$.${tool.name}`, { fillOptional: scenario.fillOptional });

    const where = `${scenario.name}: ${server}/${tool.name}`;
    let result: CallToolResult;
    try {
      result = await door.call(server, tool.name, args);
      requests += 1;
    } catch (error) {
      throw gateway.explain(error, `calling ${where} with ${JSON.stringify(args)}`);
    }
    assertResultShape(tool, result, where);
    called.add(tool.name);
    steps.push({
      server,
      tool: tool.name,
      args,
      isError: result.isError === true,
      shape: result.content.map(part => (part as { type: string }).type),
      text: redact(textOf(result))
    });

    // Nothing a child says may mention another child's tools. Cheap, and the
    // only guard against an aggregate that mixes routes under load.
    for (const other of entries) {
      if (other.server === server || other.tool.name === tool.name) continue;
      if (steps[steps.length - 1].text.includes(`${other.server}/${other.tool.name}`)) {
        throw new Error(`${where}: its result mentions ${other.server}/${other.tool.name}, which it cannot know about`);
      }
    }
  }

  // The catalogue must not have moved underneath the run. It may only change
  // when a child announces one, and no scenario here announces anything.
  const after = (await door.catalogue()).map(entry => entry.tool.name).sort();
  requests += 1;
  if (JSON.stringify(after) !== JSON.stringify(catalogue)) {
    throw new Error(`${scenario.name}: discovery is not idempotent.\nbefore: ${catalogue.join(', ')}\nafter:  ${after.join(', ')}`);
  }

  const run: AgentRun = { steps, called, catalogue, durationMs: Date.now() - startedAt, requests };
  expectEveryToolExercised(called, catalogue, scenario.outOfReach ?? {});

  if (scenario.budget) {
    if (run.durationMs > scenario.budget.ms) {
      throw new Error(`${scenario.name}: took ${run.durationMs}ms, over its ${scenario.budget.ms}ms budget`);
    }
    if (run.requests > scenario.budget.requests) {
      throw new Error(
        `${scenario.name}: made ${run.requests} requests, over its ${scenario.budget.requests} budget. ` +
          'A regression that turns one call into a retry storm is otherwise only slower, never red.'
      );
    }
  }

  // stderr is checked at the end rather than per call: an unhandled rejection
  // reported while a call was in flight would otherwise be attributed to
  // whichever call happened to be next.
  const noise = gateway.stderr();
  for (const forbidden of [/unhandled rejection/i, /uncaught exception/i]) {
    if (forbidden.test(noise)) throw new Error(`${scenario.name}: the hub logged something it must never log:\n${noise}`);
  }

  return run;
}

/** The comparable part of a run, for the twice-and-identical check. */
export function transcript(run: AgentRun): string {
  return JSON.stringify(
    run.steps.map(step => ({ server: step.server, tool: step.tool, args: step.args, isError: step.isError, shape: step.shape, text: step.text })),
    null,
    2
  );
}
