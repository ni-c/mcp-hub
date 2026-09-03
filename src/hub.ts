import { McpServer, CLIENT_CAPABILITIES_META_KEY } from '@modelcontextprotocol/server';
import type { CallToolResult, ClientCapabilities, InputRequiredResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ManagedServer, ServerState, Supervisor } from './supervisor.js';
import { VERSION } from './version.js';
import { forwardToolCall } from './forward.js';
import { loggableToolName, toolAllowed } from './tool-filter.js';
import { booleanEnv } from './mcp-limits.js';
import { REFUSAL_REASON, decidePassthrough } from './elicitation.js';
import { REVISION, type Era } from './proxy.js';

/**
 * A meta-tool answer, in both channels at once.
 *
 * `structuredContent` is the machine-readable half and the reason the tools
 * declare an `outputSchema` at all; the text block stays because the SDK does
 * NOT synthesize one for an object-shaped value, and a client that only reads
 * `content` would otherwise get an empty answer. Both carry the same object —
 * the specification's rule is that the two are the same information in two
 * presentations, and the cheapest way to keep that true is to serialise the one
 * value twice rather than to build two.
 */
function structured(value: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value
  };
}

/**
 * Every value `ServerState` has, as a schema.
 *
 * Written as a `Record` keyed by the type rather than as a bare list on
 * purpose: a state added to the supervisor and forgotten here would make this
 * schema refuse a perfectly correct answer, and the SDK turns a refused answer
 * into an error result. Keyed this way the omission is a compile error instead.
 */
const SERVER_STATES: Record<ServerState, true> = {
  starting: true,
  up: true,
  down: true,
  stopped: true,
  sleeping: true,
  unauthorized: true
};

const serverStatus = z
  .enum(Object.keys(SERVER_STATES) as [ServerState, ...ServerState[]])
  .describe('What the hub is currently doing with this server.');

/**
 * A JSON Schema, or a child's annotations: an object whose contents are not
 * ours to describe.
 *
 * `looseObject` and not a stricter shape, because both are somebody else's
 * document. Note that this stays right even under SEP-2106, which lets an
 * `outputSchema` describe a non-object *instance*: the schema itself is still
 * a JSON object — `{"type": "array", …}` — so it is the instance root that got
 * freer, not the document.
 *
 * The `meta` is not decoration. Left to itself zod writes "accepts anything" as
 * `"additionalProperties": {}` — an empty schema, which is legal and means
 * exactly the same as `true`, but is the spelling some MCP clients refuse or
 * mishandle. `meta` is merged into the emitted JSON Schema and nothing else, so
 * the wire says `true` while the runtime stays as permissive as it has to be.
 */
const foreignDocument = z.looseObject({}).meta({ additionalProperties: true });

const listServersOutput = z.object({
  servers: z.array(
    z.object({
      name: z.string().describe('Name to pass to the other tools.'),
      description: z.string().describe("The child's own title, empty if it has never connected."),
      status: serverStatus,
      toolCount: z.number().int().describe('Tools this server offers through the hub, after its filter.'),
      hidden: z
        .literal(true)
        .optional()
        .describe('Present only for a server whose tools are served by its own endpoint alone.')
    })
  )
});

const listToolsOutput = z.object({
  server: z.string(),
  tools: z.array(
    z.object({
      name: z.string(),
      description: z.string().describe('First line only, capped at 120 characters.'),
      annotations: foreignDocument.optional().describe("The child's own annotations, verbatim; absent if it declared none."),
      hasOutputSchema: z
        .literal(true)
        .optional()
        .describe('Present when the tool declares an output schema, which get_tool_schema returns.')
    })
  )
});

const getToolSchemaOutput = z.object({
  server: z.string(),
  name: z.string(),
  description: z.string().describe('The full description, untruncated.'),
  inputSchema: foreignDocument.describe('JSON Schema for the arguments of call_tool.'),
  outputSchema: foreignDocument
    .optional()
    .describe('JSON Schema the structuredContent of a call conforms to; absent if the tool declares none.'),
  annotations: foreignDocument.optional()
});

const describeConnectionOutput = z.object({
  era: z.enum(['modern', 'legacy']).describe('Which protocol era this very call arrived on.'),
  revision: z.string().describe('The revision string that era puts on the wire.'),
  hubVersion: z.string(),
  caller: z.object({
    declaresElicitation: z
      .boolean()
      .describe('Whether this request carried an elicitation capability. Only the 2026 era can carry one at all.')
  }),
  elicitation: z.object({
    wouldForward: z
      .boolean()
      .optional()
      .describe('Whether a question from the named server would reach you. Absent when no server was named and the answer depends on one.'),
    reason: z.string().optional().describe('Why not, or what the answer still depends on. Absent when a question would be carried.'),
    server: z.string().optional().describe('The server this answer was computed for, if one was named.')
  })
});

const wakeServerOutput = z.object({ name: z.string(), status: serverStatus, toolCount: z.number().int() });

const sleepServerOutput = z.object({ name: z.string(), status: serverStatus });

function toolError(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function firstLine(description: string | undefined): string {
  if (!description) return '';
  const line = description.split('\n', 1)[0].trim();
  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}

/**
 * The four hints the three reading meta-tools carry.
 *
 * Written out rather than left to the defaults, because the defaults are not
 * neutral: the specification gives `destructiveHint` and `openWorldHint` a
 * default of **true**, so a tool that says nothing announces itself as a
 * destructive tool in an open world. `list_servers`, `list_tools` and
 * `get_tool_schema` only read the hub's own snapshot, and they said nothing.
 *
 * `openWorldHint: false` is right even though the *children* reach all sorts of
 * places: these three do not call them. `call_tool` does, and says so.
 */
const READS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

/**
 * A lifecycle switch: it changes nothing a person put there, and doing it twice
 * leaves the same world.
 */
const LIFECYCLE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

/**
 * The child's own annotations, passed on verbatim.
 *
 * Verbatim, and not condensed into a kind/asks pair, because a summary would be
 * a statement *by the hub* about the child's claim. The specification is blunt
 * about what these are worth — "clients MUST consider tool annotations to be
 * untrusted unless they come from trusted servers" — and the hub is in no
 * position to vouch for a child it merely forwards to. It says what it was
 * told, and hub-tools.md says whose word it is.
 *
 * Omitted entirely when the child declared none. An empty object here would
 * read as "all four defaults", which is a claim the child did not make.
 */
const passThrough = (tool: { annotations?: unknown }): { annotations?: unknown } =>
  tool.annotations === undefined ? {} : { annotations: tool.annotations };

/**
 * The /hub aggregate: one connector exposing every hub-enabled server through
 * six meta-tools, so a client's context holds 6 tool schemas instead of 9×N.
 */

/**
 * Refuses a tool the server's allowTools/denyTools filter removed.
 *
 * The message is verbatim what get_tool_schema already answers for a tool that
 * genuinely does not exist, so a filtered tool is indistinguishable from an
 * absent one — /hub tokens go to third-party connectors, and a refusal that
 * enumerated what was hidden would be a disclosure. The operator's signal goes
 * to the hub log instead.
 */
const requireAllowedTool = (managed: ManagedServer, tool: string, server: string): CallToolResult | undefined => {
  if (toolAllowed(managed.config, tool)) return undefined;
  console.warn(`[${managed.name}] refused "${loggableToolName(tool)}": not permitted by allowTools/denyTools`);
  return toolError(`Unknown tool "${tool}" on server "${server}". Use list_tools to see available tools.`);
};

/**
 * The aggregate, built for the era it will serve.
 *
 * `era` is not decoration: both entry points already construct one instance per
 * era — `createMcpHandler` per request, `serveStdio` per connection — and the
 * SDK hands the era to the factory precisely so a server can vary by it. The
 * only thing that varies here is `describe_connection`, which would otherwise
 * have to guess the one fact it exists to report.
 */
export function buildHubServer(supervisor: Supervisor, secret: string, era: Era): McpServer {
  const hub = new McpServer({ name: 'mcp-hub', version: VERSION });

  const findServer = (name: string) => supervisor.get(name);

  /**
   * `hub: false` hides a server's TOOLS from the aggregate — those are meant
   * to be used through the server's own endpoint. Its lifecycle is a different
   * matter: wake_server/sleep_server manage hidden servers too, so the error
   * points at the right door instead of pretending the server does not exist
   * (/health names every server to the same token anyway).
   */
  const requireExposed = (managed: ManagedServer): CallToolResult | undefined => {
    if (managed.config.hub) return undefined;
    return toolError(`Server "${managed.name}" is not exposed through /hub — connect to its own endpoint /${managed.name}/mcp instead.`);
  };

  /**
   * Asking about an on-demand server's tools is the strongest hint that a
   * call follows, so a sleeping server is pre-warmed in the background while
   * the cached snapshot answers. Only a server with nothing cached yet (first
   * ever run) blocks on the start — there is nothing truthful to answer from.
   * Always-running servers pass through untouched.
   */
  const prepare = async (managed: ManagedServer): Promise<CallToolResult | undefined> => {
    if (!managed.onDemand) return undefined;
    if (!managed.hasSnapshot) {
      try {
        await managed.wake();
      } catch (error) {
        return toolError(`Server "${managed.name}" failed to start: ${(error as Error).message}`);
      }
    } else if (managed.state === 'sleeping') {
      void managed.wake().catch(() => {});
    }
    return undefined;
  };

  hub.registerTool(
    'list_servers',
    {
      title: 'List MCP servers',
      description:
        'List all MCP servers available through this hub, with their status. Call this first to see what is available. ' +
        'Servers marked "hidden" serve their tools only via their own endpoint, but wake_server/sleep_server still manage them.',
      inputSchema: z.object({}),
      outputSchema: listServersOutput,
      annotations: READS
    },
    async () =>
      structured({
        servers: [...supervisor.servers.values()].map(s => ({
          name: s.name,
          description: (s.serverInfo as { title?: string } | undefined)?.title ?? s.serverInfo?.name ?? '',
          status: s.state,
          toolCount: s.tools.length,
          ...(s.config.hub ? {} : { hidden: true as const })
        }))
      })
  );

  hub.registerTool(
    'list_tools',
    {
      title: 'List tools of a server',
      description: 'List the tools of one MCP server with one-line descriptions. Use get_tool_schema before calling a tool for the first time.',
      inputSchema: z.object({ server: z.string().describe('Server name from list_servers') }),
      outputSchema: listToolsOutput,
      annotations: READS
    },
    async ({ server }) => {
      const managed = findServer(server);
      if (!managed) return toolError(`Unknown server "${server}". Use list_servers to see available servers.`);
      const hidden = requireExposed(managed);
      if (hidden) return hidden;
      if (!managed.onDemand && managed.state !== 'up') return toolError(`Server "${server}" is ${managed.state}.`);
      const failed = await prepare(managed);
      if (failed) return failed;
      return structured({
        server: managed.name,
        tools: managed.tools.map(t => ({
          name: t.name,
          description: firstLine(t.description),
          ...passThrough(t),
          // A marker, not the schema itself: this list exists to stay small,
          // and a page of JSON Schema per tool is what get_tool_schema is for.
          // Omitted rather than false, for passThrough's reason.
          //
          // It stays a marker now that every server this family ships declares
          // one. A hub runs whatever its config names, and a child written by
          // somebody else is the ordinary case here, not the odd one.
          ...(t.outputSchema === undefined ? {} : { hasOutputSchema: true as const })
        }))
      });
    }
  );

  hub.registerTool(
    'get_tool_schema',
    {
      title: 'Get the full schema of a tool',
      description: 'Get the full description and JSON input schema of one tool, needed to construct arguments for call_tool.',
      inputSchema: z.object({
        server: z.string().describe('Server name from list_servers'),
        tool: z.string().describe('Tool name from list_tools')
      }),
      outputSchema: getToolSchemaOutput,
      annotations: READS
    },
    async ({ server, tool }) => {
      const managed = findServer(server);
      if (!managed) return toolError(`Unknown server "${server}". Use list_servers to see available servers.`);
      const hidden = requireExposed(managed);
      if (hidden) return hidden;
      // Before prepare(): that background-pre-warms a sleeping server, so a
      // forbidden name would still cost a start even though the lookup below
      // would fail anyway.
      const filtered = requireAllowedTool(managed, tool, server);
      if (filtered) return filtered;
      const failed = await prepare(managed);
      if (failed) return failed;
      const found = managed.tools.find(t => t.name === tool);
      if (!found) return toolError(`Unknown tool "${tool}" on server "${server}". Use list_tools to see available tools.`);
      return structured({
        server: managed.name,
        name: found.name,
        description: found.description ?? '',
        inputSchema: found.inputSchema,
        // The reason this tool exists twice over: call_tool hands back the
        // child's structuredContent, and until this line the caller had no way
        // to learn what shape it was promised. Verbatim and omitted-when-absent,
        // exactly as annotations are.
        ...(found.outputSchema === undefined ? {} : { outputSchema: found.outputSchema }),
        ...passThrough(found)
      });
    }
  );

  hub.registerTool(
    'call_tool',
    {
      title: 'Call a tool on a server',
      description: 'Call a tool on one of the MCP servers. Arguments must match the schema from get_tool_schema.',
      inputSchema: z.object({
        server: z.string().describe('Server name from list_servers'),
        tool: z.string().describe('Tool name from list_tools'),
        // `meta` for the same reason as `foreignDocument`: say `true` on the
        // wire rather than the empty schema zod would write by itself.
        arguments: z
          .record(z.string(), z.unknown())
          .meta({ additionalProperties: true })
          .optional()
          .describe('Tool arguments matching its input schema')
      }),
      // No outputSchema, and the only tool here without one. That is a
      // construction rather than an omission: this tool answers with a child's
      // result, so the shape is the child's own and changes with the `tool`
      // argument. A schema here could say no more than "an object", which is
      // less than the caller can already have — get_tool_schema returns the
      // child's own outputSchema, and call_tool hands the matching
      // structuredContent back verbatim.
      //
      // The one place the hub cannot know the answer, so it gives the strongest
      // one. Whatever the named tool does, call_tool does — it may delete, it
      // may reach the whole internet, and forwarding is not the same as
      // vouching. Read the child's own annotations from list_tools for what a
      // particular call would do.
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    },
    async ({ server, tool, arguments: args }, ctx): Promise<CallToolResult | InputRequiredResult> => {
      const managed = findServer(server);
      if (!managed) return toolError(`Unknown server "${server}". Use list_servers to see available servers.`);
      const hidden = requireExposed(managed);
      if (hidden) return hidden;
      // Before the wake: hiding is not a boundary here, because the hub
      // forwards by name. Refusing first also means a forbidden name cannot
      // start a sleeping server.
      const filtered = requireAllowedTool(managed, tool, server);
      if (filtered) return filtered;
      // The wake stays here rather than being left to the forward, which would
      // do it too: this endpoint answers with tool results, and "failed to
      // start" is a different thing for a caller to read than "tool call
      // failed". Once it is up the forward's own wake is a no-op.
      if (managed.onDemand && (managed.state !== 'up' || !managed.client)) {
        try {
          await managed.wake();
        } catch (error) {
          return toolError(`Server "${server}" failed to start: ${(error as Error).message}`);
        }
      }
      if (managed.state !== 'up' || !managed.client) return toolError(`Server "${server}" is ${managed.state}, try again later.`);
      try {
        // Same forwarding rules as the per-server path, from the same code: a
        // child that asks something reaches the person through this door too.
        // `via: 'hub'` binds the sealed request state to this endpoint — the
        // same tool is reachable both ways, and resuming one call through the
        // other door is not something a caller should be able to do.
        return await forwardToolCall({
          managed,
          tool,
          params: { name: tool, arguments: (args ?? {}) as Record<string, unknown> },
          ctx,
          secret,
          via: 'hub'
        });
      } catch (error) {
        // Aggregate semantics: every failure here is a tool result, never a
        // protocol error, because six meta-tools stand in for every server and
        // one unreachable child must not look like a broken hub.
        return toolError(`Tool call failed: ${(error as Error).message}`);
      }
    }
  );

  hub.registerTool(
    'wake_server',
    {
      title: 'Wake a sleeping server',
      description: 'Start an on-demand server now so its first tool call is fast. No-op if it is already running.',
      inputSchema: z.object({ server: z.string().describe('Server name from list_servers') }),
      outputSchema: wakeServerOutput,
      annotations: LIFECYCLE
    },
    async ({ server }) => {
      const managed = findServer(server);
      if (!managed) return toolError(`Unknown server "${server}". Use list_servers to see available servers.`);
      if (!managed.onDemand) return toolError(`Server "${server}" is always running.`);
      try {
        await managed.wake();
      } catch (error) {
        return toolError(`Server "${server}" failed to start: ${(error as Error).message}`);
      }
      managed.markUsed();
      return structured({ name: managed.name, status: managed.state, toolCount: managed.tools.length });
    }
  );

  hub.registerTool(
    'sleep_server',
    {
      title: 'Put a server to sleep',
      description: 'Stop an on-demand server immediately instead of waiting for its idle timeout. It restarts automatically on the next tool call.',
      inputSchema: z.object({ server: z.string().describe('Server name from list_servers') }),
      outputSchema: sleepServerOutput,
      annotations: LIFECYCLE
    },
    async ({ server }) => {
      const managed = findServer(server);
      if (!managed) return toolError(`Unknown server "${server}". Use list_servers to see available servers.`);
      if (!managed.onDemand) return toolError(`Server "${server}" is always running.`);
      await managed.sleep();
      return structured({ name: managed.name, status: managed.state });
    }
  );

  /**
   * The seventh tool, off unless an operator asks for it.
   *
   * Off by default because every tool a client can see costs context in every
   * conversation that client has, and "six meta-tools instead of N×tools" is
   * the whole argument for the aggregate. This one answers a question most
   * deployments never ask. It is not off for safety: it reports only what the
   * caller's own request already contains, and says nothing about any other
   * client — which is exactly why it exists instead of a tool that hands out
   * the hub's log.
   *
   * Read here rather than at module load so a test can set it per case, and
   * because this function runs once per request anyway.
   */
  if (booleanEnv('MCP_DIAGNOSTICS', false)) {
    hub.registerTool(
      'describe_connection',
      {
        title: 'Describe this connection',
        description:
          'Report how you are connected to this hub right now: the protocol era, and whether a server could ask you a question mid-call. ' +
          'Name a server to include its own switch and era in the answer.',
        inputSchema: z.object({
          server: z.string().optional().describe('Server name from list_servers. Omit to ask about the connection alone.')
        }),
        outputSchema: describeConnectionOutput,
        annotations: READS
      },
      async ({ server }, ctx) => {
        const managed = server === undefined ? undefined : findServer(server);
        if (server !== undefined && !managed) {
          return toolError(`Unknown server "${server}". Use list_servers to see available servers.`);
        }

        // Exactly what forwardToolCall reads, from exactly the same place.
        const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
        const declared = (envelope?.[CLIENT_CAPABILITIES_META_KEY] as ClientCapabilities | undefined)?.elicitation;

        // A sleeping child has negotiated no era, and asking here must not wake
        // one: this tool reports, it does not act.
        const childEra = managed?.state === 'up' ? managed.client?.getProtocolEra() : undefined;
        const decision = decidePassthrough({ config: managed?.config, declaredElicitation: declared, childEra });

        // Without a named server the first two conditions still hold for every
        // server there is — an operator's global switch and the caller's own
        // capability do not vary by child. The last two do, so an answer that
        // stopped there is reported as "depends", not as a refusal the caller
        // could act on.
        const dependsOnAServer =
          managed === undefined && (decision.refusal === 'child-asleep' || decision.refusal === 'child-era');

        return structured({
          era,
          revision: REVISION[era],
          hubVersion: VERSION,
          caller: { declaresElicitation: declared !== undefined },
          elicitation: dependsOnAServer
            ? { reason: 'you could be asked; whether a given server may ask depends on that server — name one to find out' }
            : {
                wouldForward: decision.forward,
                ...(decision.refusal ? { reason: REFUSAL_REASON[decision.refusal] } : {}),
                ...(managed ? { server: managed.name } : {})
              }
        });
      }
    );
  }

  return hub;
}
