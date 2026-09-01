/**
 * Types for the shared catalogue fixture.
 *
 * The fixture itself is plain `.mjs` and must stay that way — it is spawned
 * with `node` and no build step, which is what makes it debuggable by running
 * it. This file is the seam that lets the TypeScript suites name what it
 * contains without either side compiling the other.
 */
import type { McpServer } from '@modelcontextprotocol/server';

export declare const CATALOGUE_NAME: string;

export declare function registerCatalogue(server: McpServer): void;

/** What the catalogue contains, for suites that assert against it. */
export declare const CATALOGUE: {
  readonly tools: readonly string[];
  readonly resources: readonly string[];
  readonly templates: readonly string[];
  readonly prompts: readonly string[];
  readonly documents: readonly string[];
};
