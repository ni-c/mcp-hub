#!/usr/bin/env node
/**
 * Demo server: a ticket tracker with a fixed backlog.
 *
 * create_ticket accepts input, validates it and answers with a plausible id —
 * and then throws the ticket away. That is not an oversight. This server is
 * meant to survive being pointed at by strangers: shared mutable state would
 * mean the first visitor who renames everything ruins the demo for everyone
 * after them, and a restart would silently "lose" their work either way.
 *
 * Note for anyone using this as a template: stdout belongs to the protocol.
 * Anything you want to print goes to stderr, or the transport breaks.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const TICKETS = [
  {
    id: 'DEMO-101',
    title: 'Espresso machine reports 0 beans with a full hopper',
    status: 'open',
    priority: 'high',
    assignee: 'ada',
    opened: '2026-03-02',
    description: 'The hopper sensor reads empty whenever the machine is plugged into the socket behind the fridge. Works on any other socket.'
  },
  {
    id: 'DEMO-102',
    title: 'Office plants watered twice on Mondays',
    status: 'open',
    priority: 'low',
    assignee: 'grace',
    opened: '2026-03-04',
    description: 'Both the automatic system and the rota water them. Two owners, no coordination — pick one.'
  },
  {
    id: 'DEMO-103',
    title: 'Meeting room display shows last week’s agenda',
    status: 'in progress',
    priority: 'medium',
    assignee: 'alan',
    opened: '2026-02-27',
    description: 'The panel caches the calendar feed and never revalidates. A power cycle fixes it until the next Monday.'
  },
  {
    id: 'DEMO-104',
    title: 'Printer refuses jobs larger than 40 pages',
    status: 'closed',
    priority: 'medium',
    assignee: 'ada',
    opened: '2026-02-11',
    description: 'Spooler ran out of disk. Closed after the queue directory was moved off the system partition.'
  },
  {
    id: 'DEMO-105',
    title: 'Badge reader beeps twice but opens once',
    status: 'open',
    priority: 'medium',
    assignee: 'unassigned',
    opened: '2026-03-06',
    description: 'Two readers share one door controller and both acknowledge the same card. Cosmetic, but everyone asks about it.'
  }
];

const STATUSES = ['open', 'in progress', 'closed'];

const server = new McpServer({ name: 'demo-tickets', title: 'Demo Tickets', version: '1.0.0' });

function text(value) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

function toolError(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

server.registerTool(
  'list_tickets',
  {
    title: 'List tickets',
    description: 'List the tickets in the demo backlog, optionally filtered by status. Returns a summary; use get_ticket for the full text.',
    inputSchema: {
      status: z.enum(['open', 'in progress', 'closed']).optional().describe('Only return tickets in this status')
    }
  },
  async ({ status }) => {
    const matching = status ? TICKETS.filter(ticket => ticket.status === status) : TICKETS;
    return text(matching.map(({ id, title, status: state, priority, assignee }) => ({ id, title, status: state, priority, assignee })));
  }
);

server.registerTool(
  'get_ticket',
  {
    title: 'Get one ticket',
    description: 'Get a single ticket including its description and the date it was opened.',
    inputSchema: { id: z.string().describe('Ticket id from list_tickets, e.g. "DEMO-101"') }
  },
  async ({ id }) => {
    const found = TICKETS.find(ticket => ticket.id.toLowerCase() === id.toLowerCase());
    if (!found) return toolError(`Unknown ticket "${id}". Use list_tickets to see the five available ids.`);
    return text(found);
  }
);

server.registerTool(
  'create_ticket',
  {
    title: 'Create a ticket',
    description:
      'File a new ticket. This demo accepts and acknowledges the ticket but does not store it — the backlog is the same for everyone and resets on every call.',
    inputSchema: {
      title: z.string().min(3).max(200).describe('One-line summary of the problem'),
      priority: z.enum(['low', 'medium', 'high']).optional().describe('Priority, default "medium"'),
      description: z.string().max(2000).optional().describe('Longer description')
    }
  },
  async ({ title, priority = 'medium', description = '' }) => {
    // Derived from the fixed backlog length, so the answer is stable across
    // calls and across restarts.
    const id = `DEMO-${100 + TICKETS.length + 1}`;
    return text({
      id,
      title,
      priority,
      description,
      status: 'open',
      assignee: 'unassigned',
      note: 'Accepted by the demo and discarded — nothing was written. Ask list_tickets and you will not find it.'
    });
  }
);

server.registerTool(
  'list_statuses',
  {
    title: 'List ticket statuses',
    description: 'List the statuses a ticket can have. Useful as the filter value for list_tickets.',
    inputSchema: {}
  },
  async () => text(STATUSES)
);

await server.connect(new StdioServerTransport());
