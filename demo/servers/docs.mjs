#!/usr/bin/env node
/**
 * Demo server: a tiny documentation index over mcp-hub's own docs.
 *
 * The excerpts are copied into this file rather than read from disk, so the
 * server has no filesystem access at all and answers identically wherever it
 * runs. They are condensed — the canonical text lives at
 * https://mcp-hub.ni-c.de and is what a reader should end up at.
 *
 * This one exists so the demo has something worth *asking* about: pointed at
 * a chat playground, the model can answer questions about mcp-hub using these
 * tools instead of from memory.
 *
 * Note for anyone using this as a template: stdout belongs to the protocol.
 * Anything you want to print goes to stderr, or the transport breaks.
 */
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

const DOCS = [
  {
    id: 'what-is-mcp-hub',
    title: 'What is mcp-hub?',
    url: 'https://mcp-hub.ni-c.de/guide/',
    keywords: ['overview', 'introduction', 'purpose', 'stdio', 'streamable http'],
    body: [
      'mcp-hub serves many Model Context Protocol servers from one container, published over HTTPS for ChatGPT connectors, Claude (Web and Code), Mistral Le Chat, Cursor and any other Streamable-HTTP MCP client.',
      'Most MCP servers are stdio programs: they read JSON-RPC on stdin, write it on stdout and expect a client that starts them as a child process. That works on a laptop and not at all for a hosted client, which speaks HTTP and expects OAuth.',
      'The usual fix is one auth proxy per server — a container, a hostname, a certificate, an authorization server, a firewall rule and a backup path each. Nine servers means nine of everything, and nine places an authorization bug can hide. mcp-hub is one Node process that holds all of it.'
    ].join('\n\n')
  },
  {
    id: 'routing',
    title: 'Path-based routing and the /hub aggregate',
    url: 'https://mcp-hub.ni-c.de/guide/architecture',
    keywords: ['routing', 'paths', 'endpoint', 'aggregate', 'meta-tools', 'hub'],
    body: [
      'Every configured server gets its own endpoint at /<name>/mcp, so a client that wants exactly one server connects to exactly that one.',
      'The /hub endpoint is the alternative: a single connector that exposes every hub-enabled server through six meta-tools — list_servers, list_tools, get_tool_schema, call_tool, wake_server and sleep_server.',
      'The point is context. A client connected to /hub carries six tool schemas instead of the sum of every tool on every server, and discovers the rest on demand.'
    ].join('\n\n')
  },
  {
    id: 'on-demand',
    title: 'On-demand servers and idle sleep',
    url: 'https://mcp-hub.ni-c.de/guide/on-demand',
    keywords: ['on-demand', 'idle', 'sleep', 'wake', 'tool cache', 'memory'],
    body: [
      'Local servers — stdio children and Docker sandboxes — do not run around the clock. The hub starts them when they are used and puts them back to sleep after 60 minutes of inactivity. That is what makes a dozen servers affordable on a Raspberry Pi.',
      'A server whose snapshot is in the tool cache boots straight into "sleeping" and costs nothing; listing its tools is answered from the snapshot. The first tool call wakes it and blocks until it is up, so the client sees a slower first call rather than an error.',
      'Remote and socket servers are unaffected: the hub does not manage the lifetime of a process it did not start.'
    ].join('\n\n')
  },
  {
    id: 'auth',
    title: 'OAuth 2.1, API tokens and resource binding',
    url: 'https://mcp-hub.ni-c.de/guide/security',
    keywords: ['oauth', 'authorization', 'token', 'password', 'resource', 'cimd', 'login'],
    body: [
      'The hub is its own OAuth 2.1 authorization server, protected by a single password. Clients that can do OAuth — ChatGPT, Claude, the inspectors — register themselves and run the normal flow.',
      'Clients that cannot are served by API tokens minted with the admin CLI.',
      'Both kinds of token are bound to one resource: a token for /hub reaches /hub and nothing else, and a token for one server reaches that server only. This is the default, and turning it off exists solely as a migration path.'
    ].join('\n\n')
  },
  {
    id: 'sandboxing',
    title: 'Sandboxing untrusted servers',
    url: 'https://mcp-hub.ni-c.de/guide/sandboxing',
    keywords: ['sandbox', 'docker', 'untrusted', 'isolation', 'policy proxy'],
    body: [
      'mcp-hub is an authorization gateway, not a sandbox. Every stdio server in the hub container runs as the same operating-system user as the hub, and can read what the hub can read.',
      'A server you do not trust that far gets type "docker": its own container, its own image pinned by digest, no network unless you grant one, and a memory limit.',
      'The hub process never sees the Docker socket. A separate policy-proxy container holds it, reads the same mcp.json read-only, and permits exactly the container operations that file describes — nothing privileged, no host mounts, no other images.'
    ].join('\n\n')
  },
  {
    id: 'configuration',
    title: 'Configuring servers in mcp.json',
    url: 'https://mcp-hub.ni-c.de/guide/configuration',
    keywords: ['config', 'mcp.json', 'mcpservers', 'env', 'secrets', 'hot reload'],
    body: [
      'The config file is the same mcpServers object Claude Code uses, so an existing configuration can be moved over unchanged.',
      'Secrets are referenced as ${VAR} and resolved from the environment, which keeps them out of the file you commit.',
      'Per-server switches cover the rest: "hub": false hides a server from the aggregate while keeping its own endpoint, "keepAlive": true exempts it from idle sleep, and "idleMinutes" overrides the timeout for one server.',
      'The config directory is mounted read-only and watched: edits are picked up without a restart. Mount the directory, not the file — editors save by rename, and a single-file bind mount cannot follow the new inode.'
    ].join('\n\n')
  },
  {
    id: 'clients',
    title: 'Connecting clients',
    url: 'https://mcp-hub.ni-c.de/guide/clients',
    keywords: ['claude', 'chatgpt', 'cursor', 'connector', 'client', 'inspector'],
    body: [
      'A hosted client is pointed at https://your-host/hub (or at one server endpoint) and takes itself through the OAuth flow; the password is the only thing you type.',
      'Claude Code and other local clients can use the same HTTPS endpoint, or the bundled stdio entrypoint when a client insists on speaking stdio.',
      'Inspectors are the fastest way to see what a client will see: point one at an endpoint, let it authorize, and every tool, prompt and resource is listed with its schema.'
    ].join('\n\n')
  }
];

const server = new McpServer({ name: 'demo-docs', title: 'Demo Docs', version: '1.0.0' });

function text(value) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

function toolError(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Term overlap across title, keywords and body — enough to demonstrate, and
 *  stable: equal scores keep the order the documents are declared in. */
function score(doc, terms) {
  const haystack = `${doc.title} ${doc.keywords.join(' ')} ${doc.body}`.toLowerCase();
  return terms.reduce((sum, term) => (haystack.includes(term) ? sum + 1 : sum), 0);
}

server.registerTool(
  'search_docs',
  {
    title: 'Search the documentation',
    description: 'Search the mcp-hub documentation by keyword. Returns matching pages with a short excerpt; use read_doc for the full text.',
    inputSchema: z.object({
      query: z.string().min(2).max(200).describe('Words to search for, e.g. "oauth token" or "idle sleep"'),
      limit: z.number().int().min(1).max(7).optional().describe('How many results to return, 1-7 (default 3)')
    })
  },
  async ({ query, limit = 3 }) => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const hits = DOCS.map(doc => ({ doc, hits: score(doc, terms) }))
      .filter(entry => entry.hits > 0)
      .sort((a, b) => b.hits - a.hits)
      .slice(0, limit);
    if (hits.length === 0) return text(`No page matches "${query}". Try broader words such as "oauth", "routing", "docker" or "config".`);
    return text(
      hits.map(({ doc, hits: matched }) => ({
        id: doc.id,
        title: doc.title,
        url: doc.url,
        matchedTerms: matched,
        excerpt: `${doc.body.slice(0, 180).trimEnd()}...`
      }))
    );
  }
);

server.registerTool(
  'read_doc',
  {
    title: 'Read a documentation page',
    description: 'Read the full excerpt of one documentation page, with the URL of the canonical version.',
    inputSchema: z.object({ id: z.string().describe('Page id from search_docs, e.g. "on-demand"') })
  },
  async ({ id }) => {
    const found = DOCS.find(doc => doc.id === id);
    if (!found) return toolError(`Unknown page "${id}". Known pages: ${DOCS.map(doc => doc.id).join(', ')}.`);
    return text({ id: found.id, title: found.title, url: found.url, body: found.body });
  }
);

server.registerTool(
  'list_docs',
  {
    title: 'List documentation pages',
    description: 'List every page in this index with its id and title.',
    inputSchema: z.object({})
  },
  async () => text(DOCS.map(({ id, title, url }) => ({ id, title, url })))
);

await server.connect(new StdioServerTransport());
