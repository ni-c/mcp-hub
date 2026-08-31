#!/usr/bin/env node
/**
 * Demo server: a weather service that never talks to a weather service.
 *
 * Every answer comes from the table below. That is deliberate — this server
 * backs a screen recording and a public demo instance, so the same call must
 * produce the same bytes today and in a year, and the process must have
 * nothing to reach for: no network, no filesystem, no child processes.
 *
 * Note for anyone using this as a template: stdout belongs to the protocol.
 * Anything you want to print goes to stderr, or the transport breaks.
 */
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

const STATIONS = {
  'lux-city': { name: 'Luxembourg City', country: 'LU', elevation: 305 },
  reykjavik: { name: 'Reykjavík', country: 'IS', elevation: 61 },
  'cape-town': { name: 'Cape Town', country: 'ZA', elevation: 42 },
  ushuaia: { name: 'Ushuaia', country: 'AR', elevation: 23 }
};

/** Seven canned days per station, indexed by offset from "today". */
const FORECASTS = {
  'lux-city': [
    { condition: 'overcast', highC: 14, lowC: 8, precipitationMm: 2.1, windKph: 18 },
    { condition: 'light rain', highC: 12, lowC: 7, precipitationMm: 6.4, windKph: 24 },
    { condition: 'light rain', highC: 11, lowC: 6, precipitationMm: 4.8, windKph: 21 },
    { condition: 'cloudy', highC: 15, lowC: 7, precipitationMm: 0.3, windKph: 12 },
    { condition: 'sunny', highC: 19, lowC: 9, precipitationMm: 0, windKph: 9 },
    { condition: 'sunny', highC: 21, lowC: 11, precipitationMm: 0, windKph: 7 },
    { condition: 'cloudy', highC: 18, lowC: 12, precipitationMm: 1.2, windKph: 14 }
  ],
  reykjavik: [
    { condition: 'sleet', highC: 3, lowC: -2, precipitationMm: 8.9, windKph: 46 },
    { condition: 'snow', highC: 1, lowC: -5, precipitationMm: 11.2, windKph: 52 },
    { condition: 'overcast', highC: 2, lowC: -4, precipitationMm: 1.1, windKph: 33 },
    { condition: 'overcast', highC: 4, lowC: -1, precipitationMm: 0.6, windKph: 28 },
    { condition: 'light rain', highC: 6, lowC: 1, precipitationMm: 5.5, windKph: 37 },
    { condition: 'cloudy', highC: 5, lowC: 0, precipitationMm: 0.9, windKph: 25 },
    { condition: 'cloudy', highC: 5, lowC: 1, precipitationMm: 0.4, windKph: 22 }
  ],
  'cape-town': [
    { condition: 'sunny', highC: 26, lowC: 17, precipitationMm: 0, windKph: 31 },
    { condition: 'sunny', highC: 28, lowC: 18, precipitationMm: 0, windKph: 35 },
    { condition: 'windy', highC: 24, lowC: 17, precipitationMm: 0, windKph: 58 },
    { condition: 'cloudy', highC: 22, lowC: 16, precipitationMm: 1.8, windKph: 29 },
    { condition: 'sunny', highC: 25, lowC: 16, precipitationMm: 0, windKph: 24 },
    { condition: 'sunny', highC: 27, lowC: 18, precipitationMm: 0, windKph: 26 },
    { condition: 'sunny', highC: 29, lowC: 19, precipitationMm: 0, windKph: 30 }
  ],
  ushuaia: [
    { condition: 'snow showers', highC: 2, lowC: -3, precipitationMm: 4.2, windKph: 41 },
    { condition: 'cloudy', highC: 4, lowC: -1, precipitationMm: 0.7, windKph: 36 },
    { condition: 'overcast', highC: 5, lowC: 0, precipitationMm: 1.4, windKph: 44 },
    { condition: 'light rain', highC: 6, lowC: 2, precipitationMm: 3.3, windKph: 39 },
    { condition: 'cloudy', highC: 7, lowC: 2, precipitationMm: 0.5, windKph: 32 },
    { condition: 'sunny', highC: 8, lowC: 3, precipitationMm: 0, windKph: 27 },
    { condition: 'cloudy', highC: 6, lowC: 1, precipitationMm: 1.1, windKph: 34 }
  ]
};

const server = new McpServer({ name: 'demo-weather', title: 'Demo Weather', version: '1.0.0' });

function text(value) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

function toolError(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

server.registerTool(
  'list_stations',
  {
    title: 'List weather stations',
    description: 'List the weather stations this service can report on. Call this first to get a valid station id.',
    inputSchema: z.object({})
  },
  async () => text(Object.entries(STATIONS).map(([id, station]) => ({ id, ...station })))
);

server.registerTool(
  'get_forecast',
  {
    title: 'Get a forecast',
    description: 'Get the daily forecast for one station: condition, high and low in °C, precipitation in mm and wind in km/h.',
    inputSchema: z.object({
      station: z.string().describe('Station id from list_stations, e.g. "lux-city"'),
      days: z.number().int().min(1).max(7).optional().describe('How many days to return, 1-7 (default 3)')
    })
  },
  async ({ station, days = 3 }) => {
    const found = FORECASTS[station];
    if (!found) return toolError(`Unknown station "${station}". Use list_stations to see the four available ids.`);
    // "day+N" instead of a date: a real date would make every recording of
    // this demo differ from the last one.
    return text({
      station: { id: station, ...STATIONS[station] },
      forecast: found.slice(0, days).map((day, offset) => ({ day: offset === 0 ? 'today' : `day+${offset}`, ...day }))
    });
  }
);

await server.connect(new StdioServerTransport());
